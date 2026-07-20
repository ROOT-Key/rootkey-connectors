const blobDownloadToBuffer = jest.fn();
const blobUpload = jest.fn();
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
  readSubscription,
  writeSubscription,
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

describe("readDeltaLink", () => {
  it("returns the trimmed blob contents", async () => {
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from("https://graph/x?token=ABC  \n"));
    const result = await readDeltaLink(stateCfg);
    expect(result).toBe("https://graph/x?token=ABC");
  });

  it("returns undefined when the blob is missing (404)", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readDeltaLink(stateCfg)).toBeUndefined();
  });

  it("returns undefined when the blob code is BlobNotFound", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ code: "BlobNotFound" });
    expect(await readDeltaLink(stateCfg)).toBeUndefined();
  });

  it("returns undefined when the blob is empty / whitespace", async () => {
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from("   "));
    expect(await readDeltaLink(stateCfg)).toBeUndefined();
  });

  it("propagates non-404 errors", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 500, message: "boom" });
    await expect(readDeltaLink(stateCfg)).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("writeDeltaLink", () => {
  it("uploads the value with text/plain content type", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    await writeDeltaLink(stateCfg, "https://graph/x?token=NEW");
    expect(blobUpload).toHaveBeenCalledWith(
      "https://graph/x?token=NEW",
      Buffer.byteLength("https://graph/x?token=NEW", "utf-8"),
      { blobHTTPHeaders: { blobContentType: "text/plain" } },
    );
  });
});

describe("readSubscription / writeSubscription", () => {
  it("round-trips JSON content", async () => {
    const stored = { id: "sub-1", expirationDateTime: "2026-07-01", clientState: "cs" };
    blobDownloadToBuffer.mockResolvedValueOnce(Buffer.from(JSON.stringify(stored)));
    const result = await readSubscription(stateCfg);
    expect(result).toEqual(stored);
  });

  it("returns undefined when the blob is missing", async () => {
    blobDownloadToBuffer.mockRejectedValueOnce({ statusCode: 404 });
    expect(await readSubscription(stateCfg)).toBeUndefined();
  });

  it("writes JSON with application/json content type", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    await writeSubscription(stateCfg, {
      id: "sub-9",
      expirationDateTime: "2026-07-02",
      clientState: "cs",
    });
    const callArgs = blobUpload.mock.calls[0];
    expect(callArgs[2]).toEqual({ blobHTTPHeaders: { blobContentType: "application/json" } });
    expect(JSON.parse(callArgs[0])).toEqual({
      id: "sub-9",
      expirationDateTime: "2026-07-02",
      clientState: "cs",
    });
  });
});

describe("sendToDlq", () => {
  it("base64-encodes the JSON message", async () => {
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

describe("tryAcquireSyncLease", () => {
  it("creates the lock blob if missing and returns a handle on acquire", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockResolvedValueOnce(undefined);

    const lease = await tryAcquireSyncLease(stateCfg, 60);
    expect(lease).toBeDefined();
    expect(blobUpload).toHaveBeenCalled();
    expect(leaseAcquire).toHaveBeenCalledWith(60);

    // Release returns a promise; underlying release attempted.
    leaseRelease.mockResolvedValueOnce(undefined);
    await lease!.release();
    expect(leaseRelease).toHaveBeenCalled();
  });

  it("ignores 409/412 from create-if-not-exists (lock blob already exists)", async () => {
    blobUpload.mockRejectedValueOnce({ statusCode: 409 });
    leaseAcquire.mockResolvedValueOnce(undefined);

    const lease = await tryAcquireSyncLease(stateCfg, 30);
    expect(lease).toBeDefined();

    // Cleanup
    leaseRelease.mockResolvedValueOnce(undefined);
    await lease!.release();
  });

  it("returns undefined when another instance holds the lease (409)", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockRejectedValueOnce({ statusCode: 409 });

    const lease = await tryAcquireSyncLease(stateCfg, 60);
    expect(lease).toBeUndefined();
  });

  it("propagates unexpected upload errors", async () => {
    blobUpload.mockRejectedValueOnce({ statusCode: 500 });
    await expect(tryAcquireSyncLease(stateCfg, 60)).rejects.toMatchObject({ statusCode: 500 });
    expect(leaseAcquire).not.toHaveBeenCalled();
  });

  it("propagates unexpected acquireLease errors", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockRejectedValueOnce(new Error("boom"));
    await expect(tryAcquireSyncLease(stateCfg, 60)).rejects.toThrow("boom");
  });

  it("release tolerates underlying releaseLease errors", async () => {
    blobUpload.mockResolvedValueOnce(undefined);
    leaseAcquire.mockResolvedValueOnce(undefined);
    leaseRelease.mockRejectedValueOnce(new Error("already gone"));

    const lease = await tryAcquireSyncLease(stateCfg, 60);
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

  it("uses a different blob from the per-drive sync lock (so they don't block each other)", async () => {
    blobUpload.mockResolvedValue(undefined);
    leaseAcquire.mockResolvedValue(undefined);

    await tryAcquireSubscriptionsLease(stateCfg);
    await tryAcquireSyncLease(stateCfg);

    const blobNames = getBlockBlobClient.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(blobNames).toContain("subscriptions-reconciliation.lock");
    expect(blobNames).toContain("delta-sync.lock");
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
