import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from "@azure/functions";
import { loadConfig, Config } from "./config";
import {
  deltaQuery,
  downloadFile,
  getItem,
  createSubscription,
  renewSubscription,
  SubscriptionGoneError,
  DriveItem,
} from "./graph";
import { uploadFileToRootkey } from "./rootkey";
import {
  readDeltaLink,
  writeDeltaLink,
  readSubscription,
  writeSubscription,
  sendToDlq,
  tryAcquireSyncLease,
  tryAcquireSubscriptionsLease,
  StateConfig,
  DlqConfig,
  DlqMessage,
  LeaseHandle,
} from "./state";
import { retryWithBackoff, PermanentError } from "./retry";

// Cap on delta-query pages per invocation. Graph defaults to ~200 items per page,
// so 50 pages = ~10 000 items, which is well within the Consumption-plan 10-minute
// timeout (~6 minutes of headroom) even with retries and uploads. If the cursor
// hasn't reached a terminal `@odata.deltaLink` by then, we persist the latest
// `@odata.nextLink` and the next invocation (webhook or timer) resumes from it.
const MAX_DELTA_PAGES = 50;
const DLQ_QUEUE_NAME = process.env.DLQ_QUEUE_NAME ?? "rootkey-dlq";

// Stable log markers so operators can KQL on them in Application Insights.
// See README → "Observability" for example queries.
const METRIC_LEASE_CONTENTION = "rootkey.metric.sync_lease_contention";
const METRIC_RECONCILIATION_CONTENTION = "rootkey.metric.reconciliation_lease_contention";
const EVENT_DLQ_REPLAY_TERMINAL = "rootkey.event.dlq_replay_terminal_failure";

function stateCfg(cfg: Config): StateConfig {
  return {
    storageAccount: cfg.stateStorageAccount,
    containerName: cfg.stateContainerName,
    uamiClientId: cfg.uamiClientId,
  };
}

function dlqCfg(cfg: Config): DlqConfig {
  return {
    storageAccount: cfg.stateStorageAccount,
    queueName: cfg.dlqQueueName,
    uamiClientId: cfg.uamiClientId,
  };
}

function normalizeETag(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Microsoft Graph wraps the eTag in literal quotes like `"{guid},1"` — strip them.
  return raw.replace(/^"|"$/g, "");
}

// ─── HTTP webhook handler ──────────────────────────────────────────────────────

export async function notificationHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  // Validation handshake: Graph sends POST with ?validationToken=... and empty body.
  // We must echo the token in plain text within 10 seconds.
  const validationToken = req.query.get("validationToken");
  if (validationToken !== null && validationToken !== "") {
    ctx.log("Responding to Graph subscription validation handshake");
    return {
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: validationToken ?? "",
    };
  }

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    ctx.error("Failed to load config:", err);
    return { status: 500 };
  }

  let payload: { value?: unknown[] };
  try {
    const text = await req.text();
    if (!text) return { status: 202 };
    payload = JSON.parse(text);
  } catch (err) {
    ctx.error("Failed to parse notification JSON:", err);
    return { status: 400 };
  }

  const notifications = Array.isArray(payload.value)
    ? (payload.value as Array<{ clientState?: string }>)
    : [];

  // Reject if ANY notification has a mismatched clientState.
  for (const n of notifications) {
    if (n.clientState !== cfg.webhookClientState) {
      ctx.warn("Rejecting notification with mismatched clientState");
      return { status: 401 };
    }
  }

  if (notifications.length === 0) {
    return { status: 202 };
  }

  // Serialize delta sync across Function App instances. Graph batches notifications,
  // so if a concurrent invocation is already syncing, this one can safely no-op —
  // the running sync will pick up the same changes from the cursor anyway.
  let lease: LeaseHandle | undefined;
  try {
    lease = await tryAcquireSyncLease(stateCfg(cfg));
    if (!lease) {
      // Structured marker so operators can compute contention rate in App Insights.
      ctx.log(
        `${METRIC_LEASE_CONTENTION}: another instance is running the delta sync; skipping`,
      );
      return { status: 202 };
    }
    await runDeltaSync(cfg, ctx);
  } catch (err) {
    ctx.error("Delta sync failed:", err);
    // 5xx makes Graph retry the notification (4-hour exponential backoff window).
    return { status: 500 };
  } finally {
    if (lease) {
      try {
        await lease.release();
      } catch (err) {
        ctx.warn("Failed to release sync lease (will auto-expire):", err);
      }
    }
  }

  return { status: 202 };
}

// ─── Delta sync ────────────────────────────────────────────────────────────────

interface SyncResult {
  pages: number;
  filesProcessed: number;
  filesDlqd: number;
}

async function runDeltaSync(cfg: Config, ctx: InvocationContext): Promise<SyncResult> {
  const state = stateCfg(cfg);
  const dlq = dlqCfg(cfg);

  let cursor: string | undefined = await readDeltaLink(state);
  let nextDelta: string | undefined;
  let pages = 0;
  let filesProcessed = 0;
  let filesDlqd = 0;

  while (true) {
    const result = await deltaQuery(cfg.graph, cursor);
    pages++;

    for (const item of result.items) {
      if (item.folder || item.deleted || !item.file) continue;
      try {
        await processFile(cfg, item, ctx);
        filesProcessed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.error(`DLQ'ing item ${item.id} (${item.name}) after retries: ${message}`);
        await sendToDlq(dlq, {
          type: "file-upload-failure",
          itemId: item.id,
          driveId: cfg.graph.driveId,
          fileName: item.name,
          size: item.size,
          eTag: normalizeETag(item.eTag),
          error: message,
          timestamp: new Date().toISOString(),
        });
        filesDlqd++;
      }
    }

    if (result.deltaLink) {
      nextDelta = result.deltaLink;
      break;
    }
    if (!result.nextLink) break;
    if (pages >= MAX_DELTA_PAGES) {
      ctx.warn(
        `Delta sync hit MAX_DELTA_PAGES=${MAX_DELTA_PAGES}; will resume from the last nextLink on the next invocation`,
      );
      nextDelta = result.nextLink;
      break;
    }
    cursor = result.nextLink;
  }

  if (nextDelta) {
    await writeDeltaLink(state, nextDelta);
  }

  if (pages > 0) {
    ctx.log(
      `Delta sync complete: pages=${pages} files=${filesProcessed} dlqd=${filesDlqd}`,
    );
  }
  return { pages, filesProcessed, filesDlqd };
}

async function processFile(
  cfg: Config,
  item: DriveItem,
  ctx: InvocationContext,
): Promise<void> {
  if (item.size > cfg.maxFileSizeBytes) {
    throw new PermanentError(
      `Item ${item.id} size ${item.size} exceeds MAX_FILE_SIZE_BYTES=${cfg.maxFileSizeBytes}`,
    );
  }

  await retryWithBackoff(
    async () => {
      const { stream, size: downloadedSize } = await downloadFile(cfg.graph, item.id);
      const contentLength = downloadedSize > 0 ? downloadedSize : item.size;

      if (contentLength > cfg.maxFileSizeBytes) {
        throw new PermanentError(
          `Item ${item.id} download size ${contentLength} exceeds MAX_FILE_SIZE_BYTES=${cfg.maxFileSizeBytes}`,
        );
      }

      const { status, responseBody } = await uploadFileToRootkey(
        { apiUrl: cfg.rootkeyApiUrl, apiKey: cfg.rootkeyApiKey },
        {
          driveId: cfg.graph.driveId,
          itemId: item.id,
          fileName: item.name,
          eTag: normalizeETag(item.eTag),
        },
        stream,
        contentLength,
      );

      if (status >= 200 && status < 300) {
        ctx.log(`Uploaded item ${item.id} (${item.name}) → ${status}`);
        return;
      }
      if (status === 429 || status >= 500) {
        throw new Error(
          `Transient upload failure ${status} for item ${item.id}: ${responseBody}`,
        );
      }
      throw new PermanentError(
        `Upload rejected with ${status} for item ${item.id}: ${responseBody}`,
      );
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      isRetriable: (err) => !(err instanceof PermanentError),
      onRetry: (err, attempt, nextDelay) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.warn(`Retrying item ${item.id} (attempt ${attempt + 1}, in ${nextDelay}ms): ${msg}`);
      },
    },
  );
}

// ─── Timer handler: subscription renewal + safety-net delta sync ───────────────

export async function renewSubscriptionHandler(
  _timer: Timer,
  ctx: InvocationContext,
): Promise<void> {
  const cfg = loadConfig();
  const hostname = process.env.WEBSITE_HOSTNAME;
  if (!hostname) {
    throw new Error("WEBSITE_HOSTNAME env var is not set — cannot derive notification URL");
  }
  const state = stateCfg(cfg);

  // Serialize subscription bookkeeping across Function App instances. Without
  // this, two concurrent timer runs on first deploy would both call
  // createSubscription and write back to subscription.json — Graph does not
  // dedupe subscriptions by resource, so the race produces a duplicate Graph
  // subscription (each duplicate generates an extra notification per change).
  const reconciliationLease = await tryAcquireSubscriptionsLease(state);
  if (!reconciliationLease) {
    ctx.log(
      `${METRIC_RECONCILIATION_CONTENTION}: another instance is already reconciling subscriptions; skipping`,
    );
    return;
  }

  try {
    await reconcileAndSync(cfg, hostname, ctx);
  } finally {
    try {
      await reconciliationLease.release();
    } catch (err) {
      ctx.warn(
        `Failed to release reconciliation lease (will auto-expire): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function reconcileAndSync(
  cfg: Config,
  hostname: string,
  ctx: InvocationContext,
): Promise<void> {
  const notificationUrl = `https://${hostname}/api/notification`;
  const state = stateCfg(cfg);

  // 1) Ensure the Graph webhook subscription is up-to-date.
  const stored = await readSubscription(state);
  if (stored) {
    try {
      const renewed = await renewSubscription(cfg.graph, stored.id);
      await writeSubscription(state, {
        id: renewed.id,
        expirationDateTime: renewed.expirationDateTime,
        clientState: stored.clientState,
      });
      ctx.log(`Renewed subscription ${renewed.id}, expires ${renewed.expirationDateTime}`);
    } catch (err) {
      if (!(err instanceof SubscriptionGoneError)) throw err;
      ctx.warn(`Stored subscription ${stored.id} is gone — recreating`);
      const created = await createSubscription(cfg.graph, {
        notificationUrl,
        clientState: cfg.webhookClientState,
      });
      await writeSubscription(state, {
        id: created.id,
        expirationDateTime: created.expirationDateTime,
        clientState: cfg.webhookClientState,
      });
      ctx.log(`Recreated subscription ${created.id}, expires ${created.expirationDateTime}`);
    }
  } else {
    const created = await createSubscription(cfg.graph, {
      notificationUrl,
      clientState: cfg.webhookClientState,
    });
    await writeSubscription(state, {
      id: created.id,
      expirationDateTime: created.expirationDateTime,
      clientState: cfg.webhookClientState,
    });
    ctx.log(`Created subscription ${created.id}, expires ${created.expirationDateTime}`);
  }

  // 2) Safety-net delta sync. Closes the gap between deploy and first notification,
  //    and recovers from missed webhooks. Per-drive lease serializes with any
  //    active sync; failure here doesn't unwind the subscription bookkeeping above.
  let syncLease: LeaseHandle | undefined;
  try {
    syncLease = await tryAcquireSyncLease(state);
    if (!syncLease) {
      ctx.log(
        `${METRIC_LEASE_CONTENTION}: skipping safety-net delta sync — another instance is already running`,
      );
      return;
    }
    await runDeltaSync(cfg, ctx);
  } catch (err) {
    ctx.warn(
      `Safety-net delta sync failed (will retry on next timer/notification): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (syncLease) {
      try {
        await syncLease.release();
      } catch {
        // best-effort
      }
    }
  }
}

// ─── DLQ replay (queue trigger) ────────────────────────────────────────────────

export async function dlqReplayHandler(
  message: unknown,
  ctx: InvocationContext,
): Promise<void> {
  const cfg = loadConfig();
  const dlqMsg = message as Partial<DlqMessage>;

  if (!dlqMsg || !dlqMsg.itemId || !dlqMsg.driveId) {
    ctx.error(`Invalid DLQ message (missing itemId or driveId): ${JSON.stringify(message)}`);
    // Returning without throwing acks the message — we never want to infinitely
    // re-queue a payload we cannot even parse.
    return;
  }

  if (dlqMsg.driveId !== cfg.graph.driveId) {
    ctx.warn(
      `DLQ message references driveId=${dlqMsg.driveId} but this connector is bound to driveId=${cfg.graph.driveId} — dropping`,
    );
    return;
  }

  const item = await getItem(cfg.graph, dlqMsg.itemId);
  if (!item) {
    ctx.warn(`DLQ replay: item ${dlqMsg.itemId} no longer exists in Graph — dropping`);
    return;
  }
  if (item.folder || item.deleted || !item.file) {
    ctx.warn(
      `DLQ replay: item ${dlqMsg.itemId} is no longer a file (folder/deleted) — dropping`,
    );
    return;
  }

  // The replay always uses the CURRENT version of the item from Graph — not the
  // version that originally failed. If the user has overwritten the file between
  // the original failure and this replay, we anchor the new version. This is the
  // correct behaviour for a recovery product: we want the most up-to-date state
  // in the vault. The `dlqMsg.eTag` from the original failure is therefore not
  // propagated; only used for human triage of the poison queue.
  try {
    await processFile(cfg, item, ctx);
  } catch (err) {
    if (err instanceof PermanentError) {
      // Permanent failures (4xx from ROOTKey, oversize, etc.) cannot be fixed by
      // retrying. Short-circuit the queue's 5-attempt retry cycle by acking the
      // message and emitting an alertable marker. Operators alert on the marker
      // in App Insights — the poison queue stays reserved for "we don't know why
      // this keeps failing", not "we know exactly why and it won't change".
      ctx.error(
        `${EVENT_DLQ_REPLAY_TERMINAL}: item=${item.id} name="${item.name}" reason="${err.message}"`,
      );
      return;
    }
    throw err;
  }
  ctx.log(`DLQ replay succeeded for item ${item.id} (${item.name})`);
}

// ─── Function registrations ────────────────────────────────────────────────────

app.http("notification", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "notification",
  handler: notificationHandler,
});

app.timer("renewSubscription", {
  schedule: "0 0 */12 * * *",
  runOnStartup: true,
  handler: renewSubscriptionHandler,
});

app.storageQueue("dlqReplay", {
  queueName: DLQ_QUEUE_NAME,
  connection: "AzureWebJobsStorage",
  handler: dlqReplayHandler,
});
