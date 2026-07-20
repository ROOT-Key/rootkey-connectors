import { BlobServiceClient, BlobLeaseClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";

export interface StateConfig {
  storageAccount: string;
  containerName: string;
  uamiClientId?: string;
}

export interface DlqConfig {
  storageAccount: string;
  queueName: string;
  uamiClientId?: string;
}

export interface StoredSubscription {
  driveId: string;
  driveName: string;
  subscriptionId: string;
  expirationDateTime: string;
}

export interface SubscriptionsBlob {
  siteId: string;
  clientState: string;
  subscriptions: StoredSubscription[];
}

export interface DlqMessage {
  type: "file-upload-failure";
  itemId: string;
  driveId: string;
  fileName: string;
  size: number;
  eTag?: string;
  error: string;
  timestamp: string;
}

export interface LeaseHandle {
  release(): Promise<void>;
}

const SUBSCRIPTIONS_BLOB = "subscriptions.json";
const SUBSCRIPTIONS_LOCK_BLOB = "subscriptions-reconciliation.lock";

function deltaBlobName(driveId: string): string {
  // Graph drive IDs are base64url-ish (e.g. "b!xxx-yyy_zzz"); safe as blob name.
  return `delta-${driveId}.txt`;
}

function syncLockBlobName(driveId: string): string {
  return `delta-sync-${driveId}.lock`;
}

function uploadedItemBlobName(driveId: string, itemId: string): string {
  // Grouped under `uploaded-items/<driveId>/` so a customer with many drives can
  // list per-drive state cheaply (single prefix listing). Graph itemIds are
  // URL-safe (base64-like) and go into the blob name as-is.
  return `uploaded-items/${driveId}/${itemId}.json`;
}

export interface UploadedItemRecord {
  // Graph itemId — also the ROOTKey fileId (used as the parent for /versions).
  fileId: string;
  // ISO 8601 timestamp of the first successful POST /connectors/files/ for this item.
  firstUploadedAt: string;
  // ISO 8601 timestamp of the most recent successful upload (new or version).
  lastUploadedAt: string;
  // cTag from Graph as of the last successful upload. Compared against the
  // current Graph cTag on each delta pass to decide whether the file's content
  // changed (→ POST /versions) or not (→ skip). cTag is content-only, so
  // renames and metadata edits don't trigger phantom versions.
  lastCTag?: string;
}

function credential(uamiClientId?: string): DefaultAzureCredential {
  return new DefaultAzureCredential(
    uamiClientId ? { managedIdentityClientId: uamiClientId } : undefined,
  );
}

function container(cfg: StateConfig) {
  const url = `https://${cfg.storageAccount}.blob.core.windows.net`;
  return new BlobServiceClient(url, credential(cfg.uamiClientId)).getContainerClient(
    cfg.containerName,
  );
}

function queue(cfg: DlqConfig) {
  const url = `https://${cfg.storageAccount}.queue.core.windows.net`;
  return new QueueServiceClient(url, credential(cfg.uamiClientId)).getQueueClient(cfg.queueName);
}

async function readBlobAsString(cfg: StateConfig, name: string): Promise<string | undefined> {
  const blob = container(cfg).getBlockBlobClient(name);
  try {
    const buf = await blob.downloadToBuffer();
    return buf.toString("utf-8");
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode === 404 || e.code === "BlobNotFound") return undefined;
    throw err;
  }
}

async function writeBlobString(
  cfg: StateConfig,
  name: string,
  value: string,
  contentType: string,
): Promise<void> {
  const blob = container(cfg).getBlockBlobClient(name);
  await blob.upload(value, Buffer.byteLength(value, "utf-8"), {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

export async function readDeltaLink(
  cfg: StateConfig,
  driveId: string,
): Promise<string | undefined> {
  const raw = await readBlobAsString(cfg, deltaBlobName(driveId));
  return raw?.trim() || undefined;
}

export async function writeDeltaLink(
  cfg: StateConfig,
  driveId: string,
  value: string,
): Promise<void> {
  await writeBlobString(cfg, deltaBlobName(driveId), value, "text/plain");
}

export async function deleteDeltaLink(cfg: StateConfig, driveId: string): Promise<void> {
  const blob = container(cfg).getBlockBlobClient(deltaBlobName(driveId));
  try {
    await blob.delete();
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) throw err;
  }
}

export async function readSubscriptions(cfg: StateConfig): Promise<SubscriptionsBlob | undefined> {
  const raw = await readBlobAsString(cfg, SUBSCRIPTIONS_BLOB);
  if (!raw) return undefined;
  return JSON.parse(raw) as SubscriptionsBlob;
}

export async function writeSubscriptions(
  cfg: StateConfig,
  data: SubscriptionsBlob,
): Promise<void> {
  await writeBlobString(cfg, SUBSCRIPTIONS_BLOB, JSON.stringify(data), "application/json");
}

// ─── Uploaded-items registry ───────────────────────────────────────────────────
// The registry decides whether a given Graph item is a NEW file (never seen)
// or an EDIT of a previously-uploaded file. It is the routing input for
// `POST /connectors/files/` vs `POST /connectors/files/{parentId}/versions`.
//
// One blob per item — see uploadedItemBlobName. Cost at scale is discussed in
// the plan file (`~$33/month for 10M events/month at Hot LRS`); acceptable for
// current volumes without in-memory caching.

export async function readUploadedItem(
  cfg: StateConfig,
  driveId: string,
  itemId: string,
): Promise<UploadedItemRecord | undefined> {
  const raw = await readBlobAsString(cfg, uploadedItemBlobName(driveId, itemId));
  if (!raw) return undefined;
  return JSON.parse(raw) as UploadedItemRecord;
}

export async function writeUploadedItem(
  cfg: StateConfig,
  driveId: string,
  itemId: string,
  record: UploadedItemRecord,
): Promise<void> {
  await writeBlobString(
    cfg,
    uploadedItemBlobName(driveId, itemId),
    JSON.stringify(record),
    "application/json",
  );
}

export async function sendToDlq(cfg: DlqConfig, message: DlqMessage): Promise<void> {
  // Storage Queue messages are base64-encoded for cross-tooling compatibility.
  const body = Buffer.from(JSON.stringify(message), "utf-8").toString("base64");
  await queue(cfg).sendMessage(body);
}

// ─── Blob lease helpers ────────────────────────────────────────────────────────
// Each lock blob is independent so different concerns (per-drive sync, global
// subscription reconciliation) can hold leases concurrently without blocking
// each other. Within a single concern the lease serializes all in-flight work.

async function tryAcquireBlobLease(
  cfg: StateConfig,
  blobName: string,
  durationSeconds: number,
): Promise<LeaseHandle | undefined> {
  const blob = container(cfg).getBlockBlobClient(blobName);

  // Ensure the lock blob exists. ifNoneMatch:"*" makes upload a no-op if it does.
  try {
    await blob.upload(Buffer.alloc(0), 0, {
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 409 && e.statusCode !== 412) throw err;
  }

  const lease: BlobLeaseClient = blob.getBlobLeaseClient();
  try {
    await lease.acquireLease(durationSeconds);
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode === 409) return undefined; // Another instance holds the lease.
    throw err;
  }

  // Renew every duration/3 seconds — leaves room for a single transient
  // renewal failure (2 attempts before the lease would expire). The previous
  // `duration - 15` formula gave only one attempt and a failed renewal could
  // silently drop the lease while work was still in flight.
  const renewMs = Math.max(5_000, Math.floor((durationSeconds * 1000) / 3));
  const timer = setInterval(() => {
    lease.renewLease().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`Lease renewal failed for ${blobName} (will retry on next tick): ${reason}`);
    });
  }, renewMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    async release() {
      clearInterval(timer);
      try {
        await lease.releaseLease();
      } catch {
        // Best-effort release; lease will auto-expire after `durationSeconds`.
      }
    },
  };
}

// Per-drive singleton lease. Used by the notification handler and the safety-net
// sync to serialize delta sync work within a drive. Independent drives can sync
// in parallel (each drive has its own lock blob).
export async function tryAcquireSyncLease(
  cfg: StateConfig,
  driveId: string,
  durationSeconds: number = 60,
): Promise<LeaseHandle | undefined> {
  return tryAcquireBlobLease(cfg, syncLockBlobName(driveId), durationSeconds);
}

// Global singleton lease around subscription reconciliation. Without this, two
// concurrent timer invocations (Consumption can scale during overlapping warm
// + cold starts) would both read `subscriptions.json`, both call createSubscription
// for the same drives, and both write back — Graph does not dedupe subscriptions
// by resource, so the race produces duplicate subscriptions per drive. Each
// duplicate generates an extra notification per change → wasted work.
export async function tryAcquireSubscriptionsLease(
  cfg: StateConfig,
  // Azure Blob lease duration is capped at 60s for finite leases (or -1 for
  // infinite). 120s made the storage service reject the request with
  // "The value for one of the HTTP headers is not in the correct format".
  // The auto-renew loop in tryAcquireBlobLease keeps the lease alive across
  // long reconciliation runs regardless.
  durationSeconds: number = 60,
): Promise<LeaseHandle | undefined> {
  return tryAcquireBlobLease(cfg, SUBSCRIPTIONS_LOCK_BLOB, durationSeconds);
}
