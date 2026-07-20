const blobDownloadToBuffer = jest.fn();
const blobUpload = jest.fn();
const blobDelete = jest.fn();
const queueSendMessage = jest.fn();
const leaseAcquire = jest.fn();
const leaseRenew = jest.fn();
const leaseRelease = jest.fn();

const getBlobLeaseClient = jest.fn(() => ({
  acquireLease: leaseAcquire,
  renewLease: leaseRenew,
  releaseLease: leaseRelease,
}));

const getBlockBlobClient = jest.fn(() => ({
  downloadToBuffer: blobDownloadToBuffer,
  upload: blobUpload,
  delete: blobDelete,
  getBlobLeaseClient,
}));

const getContainerClient = jest.fn(() => ({ getBlockBlobClient }));
const getQueueClient = jest.fn(() => ({ sendMessage: queueSendMessage }));

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: jest.fn(() => ({ getContainerClient })),
  BlobLeaseClient: jest.fn(),
}));

jest.mock("@azure/storage-queue", () => ({
  QueueServiceClient: jest.fn(() => ({ getQueueClient })),
}));

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn(),
}));

import {
  readDeltaLink,
  writeDeltaLink,
  deleteDeltaLink,
  readSubscriptions,
  writeSubscriptions,
  readUploadedItem,
  writeUploadedItem,
  sendToDlq,
  tryAcquireSyncLease,
  tryAcquireSubscriptionsLease,
} from "./state";

const stateCfg = { storageAccount: "acct", containerName: "state" };
const dlqCfg = { storageAccount: "acct", queueName: "dlq" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("delta link per drive", () => {
  it("reads delta for a specific drive", async () => {
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from("https://graph/x?token=ABC\n"));
    const result = await readDeltaLink(stateCfg, "drive-1");
    expect(result).toBe("https://graph/x?token=ABC");
    expect(getBlockBlobClient).toHaveBeenCalledWith("delta-drive-1.txt");
  });

  it("returns undefined when missing", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readDeltaLink(stateCfg, "drive-9")).toBeUndefined();
  });

  it("returns undefined for whitespace blob", async () => {
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from("   "));
    expect(await readDeltaLink(stateCfg, "drive-1")).toBeUndefined();
  });

  it("treats BlobNotFound code as missing", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ code: "BlobNotFound" });
    expect(await readDeltaLink(stateCfg, "drive-1")).toBeUndefined();
  });

  it("propagates non-404 errors", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 500 });
    await expect(readDeltaLink(stateCfg, "drive-1")).rejects.toMatchObject({ statusCode: 500 });
  });

  it("writes delta with text/plain content type", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    await writeDeltaLink(stateCfg, "drive-7", "https://graph/x?token=NEW");
    expect(getBlockBlobClient).toHaveBeenCalledWith("delta-drive-7.txt");
    expect(blobUpload).toHaveBeenCalledWith(
      "https://graph/x?token=NEW",
      Buffer.byteLength("https://graph/x?token=NEW", "utf-8"),
      { blobHTTPHeaders: { blobContentType: "text/plain" } },
    );
  });

  it("deleteDeltaLink swallows 404", async () => {
    blobDelete.mockRejectedValueOnce({ statusCode: 404 });
    await expect(deleteDeltaLink(stateCfg, "drive-1")).resolves.toBeUndefined();
  });

  it("deleteDeltaLink propagates non-404 errors", async () => {
    blobDelete.mockRejectedValueOnce({ statusCode: 403 });
    await expect(deleteDeltaLink(stateCfg, "drive-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("deleteDeltaLink succeeds on 200", async () => {
    blobDelete.mockResolvedValueOnce(undefined);
    await expect(deleteDeltaLink(stateCfg, "drive-1")).resolves.toBeUndefined();
  });
});

describe("subscriptions blob", () => {
  it("reads and parses the subscriptions blob", async () => {
    const data = {
      siteId: "site-1",
      clientState: "cs",
      subscriptions: [
        { driveId: "d1", driveName: "Documents", subscriptionId: "s1", expirationDateTime: "2026-07-01" },
        { driveId: "d2", driveName: "Legal", subscriptionId: "s2", expirationDateTime: "2026-07-01" },
      ],
    };
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from(JSON.stringify(data)));
    const result = await readSubscriptions(stateCfg);
    expect(result).toEqual(data);
  });

  it("returns undefined when subscriptions blob is missing", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readSubscriptions(stateCfg)).toBeUndefined();
  });

  it("writes subscriptions blob with JSON content type", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    await writeSubscriptions(stateCfg, {
      siteId: "site-1",
      clientState: "cs",
      subscriptions: [],
    });
    const args = blobUpload.mock.calls[0];
    expect(args[2]).toEqual({ blobHTTPHeaders: { blobContentType: "application/json" } });
    expect(JSON.parse(args[0])).toEqual({
      siteId: "site-1",
      clientState: "cs",
      subscriptions: [],
    });
  });
});

describe("uploaded-items registry", () => {
  it("readUploadedItem returns undefined for a missing blob (never uploaded)", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readUploadedItem(stateCfg, "d1", "item-x")).toBeUndefined();
  });

  it("readUploadedItem parses the JSON record when the blob exists", async () => {
    const record = {
      fileId: "item-x",
      firstUploadedAt: "2026-07-01T00:00:00Z",
      lastUploadedAt: "2026-07-03T12:00:00Z",
      lastCTag: "c-2",
    };
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from(JSON.stringify(record)));
    expect(await readUploadedItem(stateCfg, "d1", "item-x")).toEqual(record);
  });

  it("readUploadedItem uses the uploaded-items/{driveId}/{itemId}.json path", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    await readUploadedItem(stateCfg, "drive-abc", "01ABCDEF");
    expect(getBlockBlobClient).toHaveBeenCalledWith("uploaded-items/drive-abc/01ABCDEF.json");
  });

  it("writeUploadedItem writes the record as JSON at the correct path", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    const record = {
      fileId: "item-x",
      firstUploadedAt: "2026-07-01T00:00:00Z",
      lastUploadedAt: "2026-07-01T00:00:00Z",
      lastCTag: "c-1",
    };
    await writeUploadedItem(stateCfg, "drive-abc", "item-x", record);
    expect(getBlockBlobClient).toHaveBeenCalledWith("uploaded-items/drive-abc/item-x.json");
    const args = blobUpload.mock.calls[0];
    expect(JSON.parse(args[0])).toEqual(record);
    expect(args[2]).toEqual({ blobHTTPHeaders: { blobContentType: "application/json" } });
  });

  it("readUploadedItem propagates non-404 storage errors", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 500, code: "InternalError" });
    await expect(readUploadedItem(stateCfg, "d1", "item-x")).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe("sendToDlq", () => {
  it("base64-encodes the JSON message (with size + eTag)", async () => {
    queueSendMessage.mockResolvedValueOnce(undefined);
    const msg = {
      type: "file-upload-failure" as const,
      itemId: "i",
      driveId: "d",
      fileName: "f.txt",
      size: 1234,
      eTag: "etag-1",
      error: "boom",
      timestamp: "2026-06-27T00:00:00Z",
    };
    await sendToDlq(dlqCfg, msg);
    const sent = queueSendMessage.mock.calls[0][0];
    const decoded = Buffer.from(sent, "base64").toString("utf-8");
    expect(JSON.parse(decoded)).toEqual(msg);
  });
});

describe("tryAcquireSyncLease (per-drive)", () => {
  it("creates the lock blob if missing and returns a handle on acquire", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockResolvedValueOnce(undefined);

    const lease = await tryAcquireSyncLease(stateCfg, "drive-1", 60);
    expect(lease).toBeDefined();
    expect(getBlockBlobClient).toHaveBeenCalledWith("delta-sync-drive-1.lock");
    expect(blobUpload).toHaveBeenCalled();
    expect(leaseAcquire).toHaveBeenCalledWith(60);

    leaseRelease.mockResolvedValueOnce(undefined);
    await lease!.release();
    expect(leaseRelease).toHaveBeenCalled();
  });

  it("uses a different lock blob per drive (allows parallel sync)", async () => {
    blobUpload.mockResolvedValue(undefined);
    leaseAcquire.mockResolvedValue(undefined);

    await tryAcquireSyncLease(stateCfg, "drive-A", 30);
    await tryAcquireSyncLease(stateCfg, "drive-B", 30);

    const blobNames = getBlockBlobClient.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(blobNames).toContain("delta-sync-drive-A.lock");
    expect(blobNames).toContain("delta-sync-drive-B.lock");
  });

  it("ignores 409/412 from create-if-not-exists (lock blob already exists)", async () => {
    blobUpload.mockRejectedValueOnce({ statusCode: 409 });
    leaseAcquire.mockResolvedValueOnce(undefined);

    const lease = await tryAcquireSyncLease(stateCfg, "drive-1", 30);
    expect(lease).toBeDefined();

    leaseRelease.mockResolvedValueOnce(undefined);
    await lease!.release();
  });

  it("returns undefined when another instance holds the lease (409)", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockRejectedValueOnce({ statusCode: 409 });

    const lease = await tryAcquireSyncLease(stateCfg, "drive-1", 60);
    expect(lease).toBeUndefined();
  });

  it("propagates unexpected upload errors", async () => {
    blobUpload.mockRejectedValueOnce({ statusCode: 500 });
    await expect(tryAcquireSyncLease(stateCfg, "drive-1", 60)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(leaseAcquire).not.toHaveBeenCalled();
  });

  it("propagates unexpected acquireLease errors", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockRejectedValueOnce(new Error("boom"));
    await expect(tryAcquireSyncLease(stateCfg, "drive-1", 60)).rejects.toThrow("boom");
  });

  it("release tolerates underlying releaseLease errors", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockResolvedValueOnce(undefined);
    leaseRelease.mockRejectedValueOnce(new Error("already gone"));

    const lease = await tryAcquireSyncLease(stateCfg, "drive-1", 60);
    await expect(lease!.release()).resolves.toBeUndefined();
  });
});

describe("tryAcquireSubscriptionsLease (global reconciliation lock)", () => {
  it("acquires the global reconciliation lock blob and returns a handle", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockResolvedValueOnce(undefined);

    const lease = await tryAcquireSubscriptionsLease(stateCfg, 60);
    expect(lease).toBeDefined();
    expect(getBlockBlobClient).toHaveBeenCalledWith("subscriptions-reconciliation.lock");
    expect(leaseAcquire).toHaveBeenCalledWith(60);

    leaseRelease.mockResolvedValueOnce(undefined);
    await lease!.release();
    expect(leaseRelease).toHaveBeenCalled();
  });

  it("returns undefined when another instance holds the lease (409)", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockRejectedValueOnce({ statusCode: 409 });

    const lease = await tryAcquireSubscriptionsLease(stateCfg);
    expect(lease).toBeUndefined();
  });

  it("uses a different blob from the per-drive sync locks (so they don't block each other)", async () => {
    blobUpload.mockResolvedValue(undefined);
    leaseAcquire.mockResolvedValue(undefined);

    await tryAcquireSubscriptionsLease(stateCfg);
    await tryAcquireSyncLease(stateCfg, "drive-1");

    const blobNames = getBlockBlobClient.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(blobNames).toContain("subscriptions-reconciliation.lock");
    expect(blobNames).toContain("delta-sync-drive-1.lock");
  });
});
