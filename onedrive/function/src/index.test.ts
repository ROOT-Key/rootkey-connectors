import { Readable } from "stream";

// ─── Set required env vars before importing the module ────────────────────────
process.env.ROOTKEY_API_URL = "https://api.test.rootkey.ai";
process.env.ROOTKEY_API_KEY = "rk-key";
process.env.GRAPH_TENANT_ID = "11111111-1111-1111-1111-111111111111";
process.env.GRAPH_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
process.env.GRAPH_CLIENT_SECRET = "secret";
process.env.GRAPH_DRIVE_ID = "drive-abc";
process.env.WEBHOOK_CLIENT_STATE = "secret-state";
process.env.STATE_STORAGE_ACCOUNT = "acct";
process.env.STATE_CONTAINER_NAME = "state";
process.env.DLQ_QUEUE_NAME = "dlq";
process.env.MAX_FILE_SIZE_BYTES = "1048576";
process.env.WEBSITE_HOSTNAME = "myfunc.azurewebsites.net";

// ─── Mock @azure/functions registrations so we just capture handlers ──────────
const httpRegistrations: Array<{ name: string; options: any }> = [];
const timerRegistrations: Array<{ name: string; options: any }> = [];
const queueRegistrations: Array<{ name: string; options: any }> = [];

jest.mock("@azure/functions", () => ({
  app: {
    http: jest.fn((name: string, options: any) => httpRegistrations.push({ name, options })),
    timer: jest.fn((name: string, options: any) => timerRegistrations.push({ name, options })),
    storageQueue: jest.fn((name: string, options: any) =>
      queueRegistrations.push({ name, options }),
    ),
  },
}));

jest.mock("./graph", () => {
  const actual = jest.requireActual("./graph");
  return {
    SubscriptionGoneError: actual.SubscriptionGoneError,
    deltaQuery: jest.fn(),
    downloadFile: jest.fn(),
    getItem: jest.fn(),
    createSubscription: jest.fn(),
    renewSubscription: jest.fn(),
    __resetTokenCacheForTesting: jest.fn(),
  };
});
jest.mock("./rootkey");
jest.mock("./state");

import * as graph from "./graph";
import * as rootkey from "./rootkey";
import * as state from "./state";
import {
  notificationHandler,
  renewSubscriptionHandler,
  dlqReplayHandler,
} from "./index";

const SubscriptionGoneError = graph.SubscriptionGoneError;

// Speed up retry backoff so retry-heavy tests still finish in a few ms.
beforeAll(() => {
  jest
    .spyOn(global, "setTimeout")
    .mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
});

afterAll(() => {
  jest.restoreAllMocks();
});

function mockRequest(opts: {
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}) {
  const params = new URLSearchParams(opts.query ?? {});
  return {
    query: {
      get: (k: string) => (params.has(k) ? params.get(k) : null),
    },
    text: async () => {
      if (typeof opts.rawBody === "string") return opts.rawBody;
      if (opts.body === undefined) return "";
      return JSON.stringify(opts.body);
    },
  } as any;
}

function mockContext() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

const acquiredLease = { release: jest.fn().mockResolvedValue(undefined) };
const reconciliationLease = { release: jest.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  jest.clearAllMocks();
  acquiredLease.release.mockResolvedValue(undefined);
  reconciliationLease.release.mockResolvedValue(undefined);
  (state.tryAcquireSyncLease as jest.Mock).mockResolvedValue(acquiredLease);
  (state.tryAcquireSubscriptionsLease as jest.Mock).mockResolvedValue(reconciliationLease);
  // Default: uploaded-items registry has no entry → items are treated as new
  // (POST /connectors/files/). Tests that exercise the version or skip paths
  // override this via mockResolvedValueOnce with a record.
  (state.readUploadedItem as jest.Mock).mockResolvedValue(undefined);
  (state.writeUploadedItem as jest.Mock).mockResolvedValue(undefined);
});

// ─── Validation handshake ─────────────────────────────────────────────────────

describe("notificationHandler — validation handshake", () => {
  it("echoes the validationToken from the query string", async () => {
    const res = await notificationHandler(
      mockRequest({ query: { validationToken: "abc-123" } }),
      mockContext(),
    );
    expect(res.status).toBe(200);
    expect((res.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
    expect(res.body).toBe("abc-123");
  });
});

// ─── Notification handling ────────────────────────────────────────────────────

describe("notificationHandler — notifications", () => {
  it("rejects with 401 when any notification has a mismatched clientState", async () => {
    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "WRONG" }] } }),
      mockContext(),
    );
    expect(res.status).toBe(401);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("accepts an empty body with 202", async () => {
    const res = await notificationHandler(mockRequest({ rawBody: "" }), mockContext());
    expect(res.status).toBe(202);
  });

  it("returns 400 on unparseable JSON", async () => {
    const res = await notificationHandler(
      mockRequest({ rawBody: "{not-json" }),
      mockContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 202 when notifications are empty", async () => {
    const res = await notificationHandler(
      mockRequest({ body: { value: [] } }),
      mockContext(),
    );
    expect(res.status).toBe(202);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns 202 and skips delta sync when another instance holds the lease (emits contention marker)", async () => {
    (state.tryAcquireSyncLease as jest.Mock).mockResolvedValueOnce(undefined);

    const ctx = mockContext();
    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      ctx,
    );

    expect(res.status).toBe(202);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.metric.sync_lease_contention"),
    );
  });

  it("runs delta sync, processes files, saves the new delta link, and releases the lease", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce("PREV_TOKEN");
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [
        { id: "f1", name: "a.txt", size: 5, file: {}, eTag: '"etag-a,1"' },
        { id: "folder1", name: "folder", size: 0, folder: {} },
        { id: "del1", name: "gone", size: 0, deleted: {} },
      ],
      deltaLink: "NEW_DELTA",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("hello")]),
      size: 5,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 201,
      responseBody: "ok",
    });

    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(res.status).toBe(202);
    expect(graph.deltaQuery as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "PREV_TOKEN");
    expect(graph.downloadFile as jest.Mock).toHaveBeenCalledTimes(1);
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    // eTag in the upload metadata should be normalized (quotes stripped)
    const uploadMeta = (rootkey.uploadNewFileToRootkey as jest.Mock).mock.calls[0][1];
    expect(uploadMeta.eTag).toBe("etag-a,1");
    expect(state.writeDeltaLink as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      "NEW_DELTA",
    );
    expect(acquiredLease.release).toHaveBeenCalledTimes(1);
  });

  it("paginates through nextLink before persisting deltaLink", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock)
      .mockResolvedValueOnce({
        items: [{ id: "f1", name: "a.txt", size: 1, file: {} }],
        nextLink: "https://graph/page2",
      })
      .mockResolvedValueOnce({
        items: [{ id: "f2", name: "b.txt", size: 1, file: {} }],
        deltaLink: "FINAL",
      });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 200,
      responseBody: "ok",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(graph.deltaQuery as jest.Mock).toHaveBeenCalledTimes(2);
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(2);
    expect(state.writeDeltaLink as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "FINAL");
  });
});

// ─── Retry behaviour ──────────────────────────────────────────────────────────

describe("notificationHandler — retry behaviour", () => {
  it("retries transient ROOTKey API failures and ultimately succeeds (no DLQ)", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "f1", name: "a.txt", size: 1, file: {} }],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock)
      .mockResolvedValueOnce({ status: 503, responseBody: "boom" })
      .mockResolvedValueOnce({ status: 200, responseBody: "ok" });

    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(res.status).toBe(202);
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(2);
    expect(state.sendToDlq as jest.Mock).not.toHaveBeenCalled();
  });

  it("DLQs after the retry budget is exhausted on persistent 5xx", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "f1", name: "a.txt", size: 1, file: {}, eTag: '"etag-x,3"' }],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 503,
      responseBody: "still broken",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(3);
    expect(state.sendToDlq as jest.Mock).toHaveBeenCalledTimes(1);
    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.itemId).toBe("f1");
    expect(msg.size).toBe(1);
    expect(msg.eTag).toBe("etag-x,3");
    expect(msg.error).toMatch(/503/);
  });

  it("does NOT retry permanent client errors (4xx) — goes straight to DLQ", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "f1", name: "a.txt", size: 1, file: {} }],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 400,
      responseBody: "Bad Request",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(state.sendToDlq as jest.Mock).toHaveBeenCalledTimes(1);
    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.error).toMatch(/400/);
  });

  it("retries 429 throttling like a 5xx", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "f1", name: "a.txt", size: 1, file: {} }],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock)
      .mockResolvedValueOnce({ status: 429, responseBody: "too many" })
      .mockResolvedValueOnce({ status: 200, responseBody: "ok" });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(2);
    expect(state.sendToDlq as jest.Mock).not.toHaveBeenCalled();
  });
});

// ─── Size limit & misc edge cases ─────────────────────────────────────────────

describe("notificationHandler — edge cases", () => {
  it("DLQs items larger than MAX_FILE_SIZE_BYTES before downloading", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "huge", name: "h.bin", size: 5_000_000, file: {} }],
      deltaLink: "D",
    });

    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(res.status).toBe(202);
    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(state.sendToDlq as jest.Mock).toHaveBeenCalled();
    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.error).toMatch(/exceeds MAX_FILE_SIZE_BYTES/);
    expect(msg.size).toBe(5_000_000);
  });

  it("throws into 500 when delta query itself fails (Graph retries)", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockRejectedValueOnce(new Error("Graph 503"));

    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );
    expect(res.status).toBe(500);
    expect(acquiredLease.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease even when delta sync throws", async () => {
    (state.readDeltaLink as jest.Mock).mockRejectedValueOnce(new Error("storage outage"));

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(acquiredLease.release).toHaveBeenCalledTimes(1);
  });

  it("caps delta loop at MAX_DELTA_PAGES and persists the next cursor", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValue({
      items: [],
      nextLink: "https://graph/keep-going",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    // 50 pages cap (matches MAX_DELTA_PAGES in index.ts)
    expect((graph.deltaQuery as jest.Mock).mock.calls.length).toBe(50);
    expect(state.writeDeltaLink as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      "https://graph/keep-going",
    );
  });

  // ─── Registry-based routing (new vs version vs skip) ─────────────────────

  it("routes brand-new items to POST /connectors/files/ and records them", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "new-file", name: "n.txt", size: 1, file: {}, cTag: "c-1" }],
      deltaLink: "D",
    });
    (state.readUploadedItem as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 201,
      responseBody: "created",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(rootkey.uploadVersionToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeUploadedItem as jest.Mock).toHaveBeenCalledTimes(1);
    const write = (state.writeUploadedItem as jest.Mock).mock.calls[0];
    expect(write[2]).toBe("new-file");
    expect(write[3]).toMatchObject({ fileId: "new-file", lastCTag: "c-1" });
  });

  it("routes previously-uploaded items with a new cTag to POST /connectors/files/{id}/versions", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "known-file", name: "k.txt", size: 1, file: {}, cTag: "c-2" }],
      deltaLink: "D",
    });
    (state.readUploadedItem as jest.Mock).mockResolvedValueOnce({
      fileId: "known-file",
      firstUploadedAt: "2026-06-01T00:00:00Z",
      lastUploadedAt: "2026-06-01T00:00:00Z",
      lastCTag: "c-1",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("v2")]),
      size: 2,
    });
    (rootkey.uploadVersionToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 200,
      responseBody: "versioned",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadVersionToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    const [, parentId] = (rootkey.uploadVersionToRootkey as jest.Mock).mock.calls[0];
    expect(parentId).toBe("known-file");
    const write = (state.writeUploadedItem as jest.Mock).mock.calls[0];
    expect(write[3]).toMatchObject({
      fileId: "known-file",
      firstUploadedAt: "2026-06-01T00:00:00Z",
      lastCTag: "c-2",
    });
  });

  it("skips items whose cTag has not changed since the last upload (no download, no upload)", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "unchanged", name: "u.txt", size: 1, file: {}, cTag: "same-ctag" }],
      deltaLink: "D",
    });
    (state.readUploadedItem as jest.Mock).mockResolvedValueOnce({
      fileId: "unchanged",
      firstUploadedAt: "2026-06-01T00:00:00Z",
      lastUploadedAt: "2026-06-01T00:00:00Z",
      lastCTag: "same-ctag",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadVersionToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeUploadedItem as jest.Mock).not.toHaveBeenCalled();
    expect(state.sendToDlq as jest.Mock).not.toHaveBeenCalled();
  });

  it("sends the enriched metadata (createdBy, webUrl, path, timestamps) to uploadNewFileToRootkey", async () => {
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [
        {
          id: "meta-file",
          name: "report.pdf",
          size: 1024,
          file: { mimeType: "application/pdf", hashes: { sha256Hash: "hash-abc" } },
          cTag: "c-1",
          webUrl: "https://tenant-my.sharepoint.com/personal/x/report.pdf",
          createdDateTime: "2026-07-01T09:00:00Z",
          lastModifiedDateTime: "2026-07-03T15:30:00Z",
          createdBy: { user: { id: "u1", displayName: "Alice", email: "alice@ex.com" } },
          lastModifiedBy: { user: { id: "u2", displayName: "Bob", email: "bob@ex.com" } },
          parentReference: { path: "/drive/root:/reports" },
        },
      ],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 201,
      responseBody: "ok",
    });

    await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "secret-state" }] } }),
      mockContext(),
    );

    const [, , metadata] = (rootkey.uploadNewFileToRootkey as jest.Mock).mock.calls[0];
    expect(metadata).toMatchObject({
      cTag: "c-1",
      name: "report.pdf",
      size: 1024,
      mimeType: "application/pdf",
      sha256Hash: "hash-abc",
      webUrl: "https://tenant-my.sharepoint.com/personal/x/report.pdf",
      path: "/drive/root:/reports",
      createdAt: "2026-07-01T09:00:00Z",
      lastModifiedAt: "2026-07-03T15:30:00Z",
      createdBy: { id: "u1", displayName: "Alice", email: "alice@ex.com" },
      lastModifiedBy: { id: "u2", displayName: "Bob", email: "bob@ex.com" },
    });
  });
});

// ─── renewSubscriptionHandler ─────────────────────────────────────────────────

describe("renewSubscriptionHandler", () => {
  it("creates a subscription on first run when no stored sub exists, then runs delta sync", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-01T00:00:00Z",
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({ items: [], deltaLink: "D" });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.createSubscription as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        notificationUrl: "https://myfunc.azurewebsites.net/api/notification",
        clientState: "secret-state",
      }),
    );
    expect(state.writeSubscription as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: "sub-1", clientState: "secret-state" }),
    );
    // Safety-net delta sync runs
    expect(graph.deltaQuery as jest.Mock).toHaveBeenCalled();
    expect(acquiredLease.release).toHaveBeenCalledTimes(1);
  });

  it("renews an existing subscription via PATCH", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-9",
      expirationDateTime: "2026-06-28T00:00:00Z",
      clientState: "secret-state",
    });
    (graph.renewSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-9",
      expirationDateTime: "2026-06-30T00:00:00Z",
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({ items: [], deltaLink: "D" });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.renewSubscription as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "sub-9");
    expect(graph.createSubscription as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeSubscription as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: "sub-9", expirationDateTime: "2026-06-30T00:00:00Z" }),
    );
  });

  it("recreates the subscription when renewal returns SubscriptionGoneError", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-old",
      expirationDateTime: "2026-06-20T00:00:00Z",
      clientState: "secret-state",
    });
    (graph.renewSubscription as jest.Mock).mockRejectedValueOnce(
      new SubscriptionGoneError("sub-old is gone"),
    );
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-new",
      expirationDateTime: "2026-06-30T00:00:00Z",
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({ items: [], deltaLink: "D" });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.createSubscription as jest.Mock).toHaveBeenCalled();
    expect(state.writeSubscription as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: "sub-new" }),
    );
  });

  it("propagates non-Gone errors from renewal", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-06-28T00:00:00Z",
      clientState: "secret-state",
    });
    (graph.renewSubscription as jest.Mock).mockRejectedValueOnce(new Error("500 server error"));

    await expect(renewSubscriptionHandler({} as any, mockContext())).rejects.toThrow(
      /500 server error/,
    );
    expect(graph.createSubscription as jest.Mock).not.toHaveBeenCalled();
  });

  it("throws when WEBSITE_HOSTNAME is unset", async () => {
    const saved = process.env.WEBSITE_HOSTNAME;
    delete process.env.WEBSITE_HOSTNAME;
    try {
      await expect(renewSubscriptionHandler({} as any, mockContext())).rejects.toThrow(
        /WEBSITE_HOSTNAME/,
      );
    } finally {
      process.env.WEBSITE_HOSTNAME = saved;
    }
  });

  it("skips safety-net delta sync when another instance holds the lease", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-01T00:00:00Z",
    });
    (state.tryAcquireSyncLease as jest.Mock).mockResolvedValueOnce(undefined);

    await renewSubscriptionHandler({} as any, mockContext());

    // Subscription create still happened; delta sync did not.
    expect(graph.createSubscription as jest.Mock).toHaveBeenCalled();
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("does not throw when safety-net delta sync fails", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-01T00:00:00Z",
    });
    (state.readDeltaLink as jest.Mock).mockRejectedValueOnce(new Error("storage outage"));

    await expect(renewSubscriptionHandler({} as any, mockContext())).resolves.toBeUndefined();
    expect(acquiredLease.release).toHaveBeenCalledTimes(1);
  });

  it("acquires the reconciliation lease before touching subscription.json", async () => {
    (state.readSubscription as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-01T00:00:00Z",
    });
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({ items: [], deltaLink: "D" });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(state.tryAcquireSubscriptionsLease as jest.Mock).toHaveBeenCalledTimes(1);
    expect(reconciliationLease.release).toHaveBeenCalledTimes(1);
  });

  it("skips the entire timer body when another instance holds the reconciliation lease", async () => {
    (state.tryAcquireSubscriptionsLease as jest.Mock).mockResolvedValueOnce(undefined);

    const ctx = mockContext();
    await renewSubscriptionHandler({} as any, ctx);

    // No subscription work at all if we lost the reconciliation race.
    expect(state.readSubscription as jest.Mock).not.toHaveBeenCalled();
    expect(graph.createSubscription as jest.Mock).not.toHaveBeenCalled();
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.metric.reconciliation_lease_contention"),
    );
  });

  it("releases the reconciliation lease even when subscription bookkeeping throws", async () => {
    (state.readSubscription as jest.Mock).mockRejectedValueOnce(new Error("storage 500"));

    await expect(renewSubscriptionHandler({} as any, mockContext())).rejects.toThrow(
      /storage 500/,
    );
    expect(reconciliationLease.release).toHaveBeenCalledTimes(1);
  });
});

// ─── dlqReplayHandler ─────────────────────────────────────────────────────────

describe("dlqReplayHandler", () => {
  const validMessage = {
    type: "file-upload-failure" as const,
    itemId: "i1",
    driveId: "drive-abc",
    fileName: "doc.pdf",
    size: 100,
    eTag: "etag-1",
    error: "previous failure",
    timestamp: "2026-06-27T00:00:00Z",
  };

  it("re-fetches the item and reprocesses it (happy path)", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "doc.pdf",
      size: 100,
      file: {},
      eTag: '"etag-2,1"',
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("body")]),
      size: 100,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 200,
      responseBody: "ok",
    });

    await dlqReplayHandler(validMessage, mockContext());

    expect(graph.getItem as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "i1");
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("drops the message if itemId is missing (does not throw — avoids infinite re-queue)", async () => {
    await expect(
      dlqReplayHandler({ driveId: "drive-abc" }, mockContext()),
    ).resolves.toBeUndefined();
    expect(graph.getItem as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops the message if driveId does not match the connector's drive", async () => {
    await expect(
      dlqReplayHandler({ ...validMessage, driveId: "different-drive" }, mockContext()),
    ).resolves.toBeUndefined();
    expect(graph.getItem as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops the message when the item no longer exists in Graph", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce(undefined);
    await expect(dlqReplayHandler(validMessage, mockContext())).resolves.toBeUndefined();
    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops the message when the item has become a folder", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "doc",
      size: 0,
      folder: {},
    });
    await expect(dlqReplayHandler(validMessage, mockContext())).resolves.toBeUndefined();
    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
  });

  it("propagates errors when processing still fails on transient (queue will retry, then poison)", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "doc.pdf",
      size: 100,
      file: {},
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("body")]),
      size: 100,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 503,
      responseBody: "still down",
    });

    await expect(dlqReplayHandler(validMessage, mockContext())).rejects.toThrow(/503/);
    // 3 attempts via the in-function retry budget
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(3);
  });

  it("short-circuits on PermanentError (does NOT re-throw — avoids 5x queue retry cycle)", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "huge.bin",
      size: 5_000_000, // exceeds MAX_FILE_SIZE_BYTES=1_048_576 from env
      file: {},
    });

    const ctx = mockContext();
    await expect(dlqReplayHandler(validMessage, ctx)).resolves.toBeUndefined();

    // No download/upload attempted; permanent error caught and logged with marker.
    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(ctx.error).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_replay_terminal_failure"),
    );
  });

  it("short-circuits on PermanentError from a 4xx upload (no queue retry cycle)", async () => {
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "bad.pdf",
      size: 100,
      file: {},
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("body")]),
      size: 100,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 400,
      responseBody: "validation failed",
    });

    const ctx = mockContext();
    await expect(dlqReplayHandler(validMessage, ctx)).resolves.toBeUndefined();

    // 4xx is permanent — only one upload attempt, no retries, no re-throw.
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(ctx.error).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_replay_terminal_failure"),
    );
  });
});

// ─── Function registrations ───────────────────────────────────────────────────

describe("function registrations", () => {
  it("registers the HTTP notification endpoint", () => {
    expect(httpRegistrations.find((r) => r.name === "notification")).toBeDefined();
  });

  it("registers the timer with runOnStartup:true", () => {
    const reg = timerRegistrations.find((r) => r.name === "renewSubscription");
    expect(reg).toBeDefined();
    expect(reg?.options.schedule).toBe("0 0 */1 * * *");
    expect(reg?.options.runOnStartup).toBe(true);
  });

  it("registers the storage queue trigger for DLQ replay", () => {
    const reg = queueRegistrations.find((r) => r.name === "dlqReplay");
    expect(reg).toBeDefined();
    expect(reg?.options.queueName).toBe("dlq");
    expect(reg?.options.connection).toBe("DlqStorage");
  });
});
