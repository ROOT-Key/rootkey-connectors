import type { MessageBatch, Message } from "@cloudflare/workers-types";
import { PermanentError } from "./errors";
import { Env, loadConfig, ResolvedConfig } from "./config";
import { uploadFileToRootkey } from "./rootkey";

// R2 emits an event message for every mutation. We only care about the actions
// that produce a fresh object body to anchor.
const ANCHOR_ACTIONS = new Set(["PutObject", "CompleteMultipartUpload", "CopyObject"]);

// Stable log markers so operators can KQL / Logpush these in Workers Analytics.
// See README → "Observability" for example queries.
const EVENT_DLQ_TERMINAL = "rootkey.event.dlq_terminal_failure";

export interface R2EventObject {
  key: string;
  size?: number;
  eTag?: string;
}

export interface R2EventMessage {
  account?: string;
  action: string;
  bucket: string;
  object: R2EventObject;
  eventTime?: string;
}

export default {
  async queue(batch: MessageBatch<R2EventMessage>, env: Env): Promise<void> {
    let cfg: ResolvedConfig;
    try {
      cfg = loadConfig(env);
    } catch (err) {
      // A misconfigured Worker cannot recover by retrying — fail the whole batch
      // loudly so the customer notices, but ack all messages so they don't pile
      // up indefinitely in the queue. The terminal-failure marker is the alert
      // signal: operators see config drift in Workers logs immediately.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${EVENT_DLQ_TERMINAL}: reason="config:${reason}"`);
      for (const message of batch.messages) message.ack();
      return;
    }

    for (const message of batch.messages) {
      await handleMessage(message, cfg, env);
    }
  },
};

export async function handleMessage(
  message: Message<R2EventMessage>,
  cfg: ResolvedConfig,
  env: Env,
): Promise<void> {
  const event = message.body;
  if (!event || !event.action || !event.object?.key) {
    console.warn(`Dropping malformed R2 event: ${JSON.stringify(event)}`);
    message.ack();
    return;
  }

  if (!ANCHOR_ACTIONS.has(event.action)) {
    // Deletions, aborts, lifecycle events — nothing to anchor. Ack quietly.
    message.ack();
    return;
  }

  try {
    await processObject(event, cfg, env);
    message.ack();
  } catch (err) {
    if (err instanceof PermanentError) {
      // Short-circuit the queue's retry budget. The poison queue stays reserved
      // for "we don't know why this keeps failing"; permanent errors get an
      // alertable structured marker instead.
      console.error(
        `${EVENT_DLQ_TERMINAL}: bucket=${event.bucket} key="${event.object.key}" reason="${err.message}"`,
      );
      message.ack();
      return;
    }

    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `Transient failure for bucket=${event.bucket} key="${event.object.key}" (attempt ${message.attempts}): ${reason}`,
    );
    // Let the Queue retry. After max_retries (set in Terraform) the message
    // goes to the configured dead-letter queue automatically.
    message.retry();
  }
}

async function processObject(
  event: R2EventMessage,
  cfg: ResolvedConfig,
  env: Env,
): Promise<void> {
  const reportedSize = typeof event.object.size === "number" ? event.object.size : 0;
  if (reportedSize > cfg.maxFileSizeBytes) {
    throw new PermanentError(
      `Object size ${reportedSize} exceeds MAX_FILE_SIZE_BYTES=${cfg.maxFileSizeBytes} (bucket=${event.bucket} key="${event.object.key}")`,
    );
  }

  const object = await env.BUCKET.get(event.object.key);
  if (!object) {
    // The object disappeared between the event and now (deleted, lifecycle
    // expiry, etc). Nothing to upload.
    throw new PermanentError(
      `Object no longer exists in R2 (bucket=${event.bucket} key="${event.object.key}")`,
    );
  }

  const contentLength = object.size ?? reportedSize;
  if (contentLength > cfg.maxFileSizeBytes) {
    throw new PermanentError(
      `Object stream size ${contentLength} exceeds MAX_FILE_SIZE_BYTES=${cfg.maxFileSizeBytes} (bucket=${event.bucket} key="${event.object.key}")`,
    );
  }

  const { status, responseBody } = await uploadFileToRootkey(
    { apiUrl: cfg.rootkeyApiUrl, apiKey: cfg.rootkeyApiKey },
    { bucket: event.bucket, key: event.object.key, eTag: object.etag ?? event.object.eTag },
    object.body,
    contentLength,
  );

  if (status >= 200 && status < 300) {
    console.log(`Uploaded r2://${event.bucket}/${event.object.key} → ${status}`);
    return;
  }
  if (status === 429 || status >= 500) {
    throw new Error(
      `Transient upload failure ${status} for r2://${event.bucket}/${event.object.key}: ${responseBody}`,
    );
  }
  throw new PermanentError(
    `Upload rejected with ${status} for r2://${event.bucket}/${event.object.key}: ${responseBody}`,
  );
}
