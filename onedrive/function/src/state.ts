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
  id: string;
  expirationDateTime: string;
  clientState: string;
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

const DELTA_BLOB = "delta-link.txt";
const SUBSCRIPTION_BLOB = "subscription.json";
const SYNC_LOCK_BLOB = "delta-sync.lock";
const SUBSCRIPTIONS_LOCK_BLOB = "subscriptions-reconciliation.lock";

function uploadedItemBlobName(driveId: string, itemId: string): string {
  // OneDrive currently connects to a single drive, but we keep the driveId in
  // the blob path for symmetry with SharePoint (multi-drive) and for future-
  // proofing if the module ever supports multiple drives. Graph itemIds are
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

export async function readDeltaLink(cfg: StateConfig): Promise<string | undefined> {
  const raw = await readBlobAsString(cfg, DELTA_BLOB);
  return raw?.trim() || undefined;
}

export async function writeDeltaLink(cfg: StateConfig, value: string): Promise<void> {
  await writeBlobString(cfg, DELTA_BLOB, value, "text/plain");
}

export async function readSubscription(cfg: StateConfig): Promise<StoredSubscription | undefined> {
  const raw = await readBlobAsString(cfg, SUBSCRIPTION_BLOB);
  if (!raw) return undefined;
  return JSON.parse(raw) as StoredSubscription;
}

export async function writeSubscription(
  cfg: StateConfig,
  subscription: StoredSubscription,
): Promise<void> {
  await writeBlobString(cfg, SUBSCRIPTION_BLOB, JSON.stringify(subscription), "application/json");
}

// ─── Uploaded-items registry ───────────────────────────────────────────────────
// One blob per Graph item — the routing input for `POST /connectors/files/`
// (brand new) vs `POST /connectors/files/{parentId}/versions` (edit of a
// previously uploaded item). Missing blob → new. Existing blob with matching
// cTag → skip. Existing blob with different cTag → new version.

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
    const e = err as { statusCode?: number; details?: { errorCode?: string } };
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
// sync to serialize delta sync work for this drive.
export async function tryAcquireSyncLease(
  cfg: StateConfig,
  durationSeconds: number = 60,
): Promise<LeaseHandle | undefined> {
  return tryAcquireBlobLease(cfg, SYNC_LOCK_BLOB, durationSeconds);
}

// Global singleton lease around subscription bookkeeping in the timer handler.
// Without this, two concurrent timer invocations (Consumption can scale during
// overlapping warm + cold starts) on first deploy would both call createSubscription
// and write back to subscription.json — Graph does not dedupe subscriptions by
// resource, so the race produces a duplicate subscription per drive.
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
