import { Readable } from "stream";

// ─── Set required env vars before importing the module ────────────────────────
process.env.ROOTKEY_API_URL = "https://api.test.rootkey.ai";
process.env.ROOTKEY_API_KEY = "rk-key";
process.env.GRAPH_TENANT_ID = "11111111-1111-1111-1111-111111111111";
process.env.GRAPH_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
process.env.GRAPH_CLIENT_SECRET = "secret";
process.env.GRAPH_SITE_URL = "https://contoso.sharepoint.com/sites/legal";
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
    parseSiteUrl: actual.parseSiteUrl,
    resolveSite: jest.fn(),
    listDrives: jest.fn(),
    deltaQuery: jest.fn(),
    downloadFile: jest.fn(),
    getItem: jest.fn(),
    createSubscription: jest.fn(),
    renewSubscription: jest.fn(),
    deleteSubscription: jest.fn(),
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
    query: { get: (k: string) => (params.has(k) ? params.get(k) : null) },
    text: async () => {
      if (typeof opts.rawBody === "string") return opts.rawBody;
      if (opts.body === undefined) return "";
      return JSON.stringify(opts.body);
    },
  } as any;
}

function mockContext() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
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

// ─── Auth / parsing ───────────────────────────────────────────────────────────

describe("notificationHandler — auth / parsing", () => {
  it("rejects with 401 when any notification has a mismatched clientState", async () => {
    const res = await notificationHandler(
      mockRequest({ body: { value: [{ clientState: "WRONG", subscriptionId: "sub-1" }] } }),
      mockContext(),
    );
    expect(res.status).toBe(401);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns 202 on empty body", async () => {
    const res = await notificationHandler(mockRequest({ rawBody: "" }), mockContext());
    expect(res.status).toBe(202);
  });

  it("returns 400 on unparseable JSON", async () => {
    const res = await notificationHandler(mockRequest({ rawBody: "{not-json" }), mockContext());
    expect(res.status).toBe(400);
  });

  it("returns 202 when notifications array is empty", async () => {
    const res = await notificationHandler(mockRequest({ body: { value: [] } }), mockContext());
    expect(res.status).toBe(202);
  });

  it("returns 202 (warning) when no subscriptions are registered yet", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce(undefined);
    const res = await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-x" }] },
      }),
      mockContext(),
    );
    expect(res.status).toBe(202);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns 202 when subscriptionIds do not match any stored subscription", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    const res = await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-UNKNOWN" }] },
      }),
      mockContext(),
    );
    expect(res.status).toBe(202);
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });
});

// ─── Multi-drive routing + sync ───────────────────────────────────────────────

describe("notificationHandler — multi-drive routing", () => {
  it("runs delta sync only for drives referenced by the notifications", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
        { driveId: "d2", driveName: "B", subscriptionId: "sub-B", expirationDateTime: "x" },
        { driveId: "d3", driveName: "C", subscriptionId: "sub-C", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValue(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValue({ items: [], deltaLink: "D" });

    await notificationHandler(
      mockRequest({
        body: {
          value: [
            { clientState: "secret-state", subscriptionId: "sub-A" },
            { clientState: "secret-state", subscriptionId: "sub-C" },
          ],
        },
      }),
      mockContext(),
    );

    expect(graph.deltaQuery as jest.Mock).toHaveBeenCalledTimes(2);
    const drivesQueried = (graph.deltaQuery as jest.Mock).mock.calls.map((c) => c[1]);
    expect(drivesQueried.sort()).toEqual(["d1", "d3"]);
  });

  it("acquires a per-drive lease (separate calls per drive)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
        { driveId: "d2", driveName: "B", subscriptionId: "sub-B", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValue(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValue({ items: [], deltaLink: "D" });

    await notificationHandler(
      mockRequest({
        body: {
          value: [
            { clientState: "secret-state", subscriptionId: "sub-A" },
            { clientState: "secret-state", subscriptionId: "sub-B" },
          ],
        },
      }),
      mockContext(),
    );

    const leaseCalls = (state.tryAcquireSyncLease as jest.Mock).mock.calls;
    expect(leaseCalls).toHaveLength(2);
    expect(leaseCalls.map((c) => c[1]).sort()).toEqual(["d1", "d2"]);
  });

  it("emits the lease-contention marker when a drive's lease is held by another instance", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.tryAcquireSyncLease as jest.Mock).mockResolvedValueOnce(undefined);

    const ctx = mockContext();
    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      ctx,
    );

    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.metric.sync_lease_contention"),
    );
    expect(graph.deltaQuery as jest.Mock).not.toHaveBeenCalled();
  });

  it("skips a drive when its lease is held by another instance, processes the rest", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
        { driveId: "d2", driveName: "B", subscriptionId: "sub-B", expirationDateTime: "x" },
      ],
    });
    (state.tryAcquireSyncLease as jest.Mock)
      .mockResolvedValueOnce(undefined) // d1: lease held by another instance
      .mockResolvedValueOnce(acquiredLease); // d2: acquired
    (state.readDeltaLink as jest.Mock).mockResolvedValue(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValue({ items: [], deltaLink: "D" });

    await notificationHandler(
      mockRequest({
        body: {
          value: [
            { clientState: "secret-state", subscriptionId: "sub-A" },
            { clientState: "secret-state", subscriptionId: "sub-B" },
          ],
        },
      }),
      mockContext(),
    );

    // Only d2 was actually synced
    expect((graph.deltaQuery as jest.Mock).mock.calls).toHaveLength(1);
    expect((graph.deltaQuery as jest.Mock).mock.calls[0][1]).toBe("d2");
  });

  it("deduplicates multiple notifications for the same drive into one sync", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValue(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValue({ items: [], deltaLink: "D" });

    await notificationHandler(
      mockRequest({
        body: {
          value: [
            { clientState: "secret-state", subscriptionId: "sub-A" },
            { clientState: "secret-state", subscriptionId: "sub-A" },
            { clientState: "secret-state", subscriptionId: "sub-A" },
          ],
        },
      }),
      mockContext(),
    );

    expect(graph.deltaQuery as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("processes files, paginates, saves per-drive delta link, normalizes eTag", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce("PREV");
    (graph.deltaQuery as jest.Mock)
      .mockResolvedValueOnce({
        items: [{ id: "f1", name: "a.txt", size: 1, file: {}, eTag: '"etag-a,1"' }],
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

    const res = await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(res.status).toBe(202);
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(2);
    // First file's eTag was wrapped in quotes — should be normalized.
    const firstMeta = (rootkey.uploadNewFileToRootkey as jest.Mock).mock.calls[0][1];
    expect(firstMeta.eTag).toBe("etag-a,1");
    expect(state.writeDeltaLink as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      "d1",
      "FINAL",
    );
    expect(acquiredLease.release).toHaveBeenCalled();
  });

  it("skips folders and deleted items", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [
        { id: "f1", name: "a.txt", size: 1, file: {} },
        { id: "folder1", name: "folder", size: 0, folder: {} },
        { id: "del1", name: "gone", size: 0, deleted: {} },
      ],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 200,
      responseBody: "ok",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).toHaveBeenCalledTimes(1);
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx ROOTKey responses before DLQing", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
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
      .mockResolvedValueOnce({ status: 503, responseBody: "unavailable" })
      .mockResolvedValueOnce({ status: 503, responseBody: "unavailable" })
      .mockResolvedValueOnce({ status: 200, responseBody: "ok" });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(3);
    expect(state.sendToDlq as jest.Mock).not.toHaveBeenCalled();
  });

  it("DLQs 4xx ROOTKey responses immediately (PermanentError, no retry)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
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
      responseBody: "bad request",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    // PermanentError → no retry
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(state.sendToDlq as jest.Mock).toHaveBeenCalledTimes(1);
    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.driveId).toBe("d1");
    expect(msg.error).toMatch(/400/);
  });

  it("DLQ payload includes size and eTag", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "f1", name: "a.txt", size: 42, file: {}, eTag: '"etag-7"' }],
      deltaLink: "D",
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 400,
      responseBody: "bad",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.size).toBe(42);
    expect(msg.eTag).toBe("etag-7");
  });

  // ─── Registry-based routing (new vs version vs skip) ─────────────────────

  it("routes brand-new items to POST /connectors/files/ and records them", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "new-file", name: "n.txt", size: 1, file: {}, cTag: "c-1" }],
      deltaLink: "D",
    });
    (state.readUploadedItem as jest.Mock).mockResolvedValueOnce(undefined); // never seen
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 201,
      responseBody: "created",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(rootkey.uploadVersionToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeUploadedItem as jest.Mock).toHaveBeenCalledTimes(1);
    const write = (state.writeUploadedItem as jest.Mock).mock.calls[0];
    expect(write[1]).toBe("d1"); // driveId
    expect(write[2]).toBe("new-file"); // itemId
    expect(write[3]).toMatchObject({ fileId: "new-file", lastCTag: "c-1" });
  });

  it("routes previously-uploaded items with a new cTag to POST /connectors/files/{id}/versions", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "known-file", name: "k.txt", size: 1, file: {}, cTag: "c-2" }],
      deltaLink: "D",
    });
    // Registry says we uploaded this before at cTag c-1; now Graph gives c-2 → new version.
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
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadVersionToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    const [, parentId] = (rootkey.uploadVersionToRootkey as jest.Mock).mock.calls[0];
    expect(parentId).toBe("known-file");
    // Registry updated with the new cTag; firstUploadedAt preserved.
    const write = (state.writeUploadedItem as jest.Mock).mock.calls[0];
    expect(write[3]).toMatchObject({
      fileId: "known-file",
      firstUploadedAt: "2026-06-01T00:00:00Z",
      lastCTag: "c-2",
    });
  });

  it("skips items whose cTag has not changed since the last upload (no download, no upload)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "unchanged", name: "u.txt", size: 1, file: {}, cTag: "same-ctag" }],
      deltaLink: "D",
    });
    (state.readUploadedItem as jest.Mock).mockResolvedValueOnce({
      fileId: "unchanged",
      firstUploadedAt: "2026-06-01T00:00:00Z",
      lastUploadedAt: "2026-06-01T00:00:00Z",
      lastCTag: "same-ctag", // identical
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadVersionToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeUploadedItem as jest.Mock).not.toHaveBeenCalled();
    expect(state.sendToDlq as jest.Mock).not.toHaveBeenCalled();
  });

  it("sends the enriched metadata (createdBy, webUrl, path, timestamps) to uploadNewFileToRootkey", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [
        {
          id: "meta-file",
          name: "report.pdf",
          size: 1024,
          file: { mimeType: "application/pdf", hashes: { sha256Hash: "hash-abc" } },
          cTag: "c-1",
          webUrl: "https://tenant.sharepoint.com/sites/x/reports/report.pdf",
          createdDateTime: "2026-07-01T09:00:00Z",
          lastModifiedDateTime: "2026-07-03T15:30:00Z",
          createdBy: { user: { id: "u1", displayName: "Alice", email: "alice@ex.com" } },
          lastModifiedBy: { user: { id: "u2", displayName: "Bob", email: "bob@ex.com" } },
          parentReference: { path: "/drives/d1/root:/reports" },
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
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    const [, , metadata] = (rootkey.uploadNewFileToRootkey as jest.Mock).mock.calls[0];
    expect(metadata).toMatchObject({
      cTag: "c-1",
      name: "report.pdf",
      size: 1024,
      mimeType: "application/pdf",
      sha256Hash: "hash-abc",
      webUrl: "https://tenant.sharepoint.com/sites/x/reports/report.pdf",
      path: "/drives/d1/root:/reports",
      createdAt: "2026-07-01T09:00:00Z",
      lastModifiedAt: "2026-07-03T15:30:00Z",
      createdBy: { id: "u1", displayName: "Alice", email: "alice@ex.com" },
      lastModifiedBy: { id: "u2", displayName: "Bob", email: "bob@ex.com" },
    });
  });

  it("returns 500 when delta query itself fails", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockRejectedValueOnce(new Error("Graph 503"));

    const res = await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );
    expect(res.status).toBe(500);
  });

  it("DLQs items exceeding MAX_FILE_SIZE_BYTES before download (PermanentError)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.deltaQuery as jest.Mock).mockResolvedValueOnce({
      items: [{ id: "huge", name: "h.bin", size: 5_000_000, file: {} }],
      deltaLink: "D",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(state.sendToDlq as jest.Mock).toHaveBeenCalled();
    const msg = (state.sendToDlq as jest.Mock).mock.calls[0][1];
    expect(msg.error).toMatch(/exceeds MAX_FILE_SIZE_BYTES/);
  });

  it("persists nextLink (not deltaLink) when MAX_DELTA_PAGES is hit", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (state.readDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);
    // Return a nextLink for 50 consecutive pages — we should stop and persist the nextLink.
    (graph.deltaQuery as jest.Mock).mockResolvedValue({
      items: [],
      nextLink: "https://graph/next",
    });

    await notificationHandler(
      mockRequest({
        body: { value: [{ clientState: "secret-state", subscriptionId: "sub-A" }] },
      }),
      mockContext(),
    );

    expect(state.writeDeltaLink as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      "d1",
      "https://graph/next",
    );
  });
});

// ─── Timer handler ────────────────────────────────────────────────────────────

describe("renewSubscriptionHandler", () => {
  const drive1 = { id: "d1", name: "Documents" };
  const drive2 = { id: "d2", name: "Legal" };
  const siteRef = { id: "site-1", hostname: "contoso.sharepoint.com", serverRelativePath: "/sites/legal" };

  beforeEach(() => {
    (graph.deltaQuery as jest.Mock).mockResolvedValue({ items: [], deltaLink: "D" });
  });

  it("on first run: resolves site, lists drives, creates subscriptions for each", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1, drive2]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock)
      .mockResolvedValueOnce({ id: "sub-1", expirationDateTime: "2026-07-01" })
      .mockResolvedValueOnce({ id: "sub-2", expirationDateTime: "2026-07-01" });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.createSubscription as jest.Mock).toHaveBeenCalledTimes(2);
    const persisted = (state.writeSubscriptions as jest.Mock).mock.calls[0][1];
    expect(persisted.subscriptions.map((s: any) => s.driveId).sort()).toEqual(["d1", "d2"]);
  });

  it("renews existing subscriptions on subsequent runs", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1, drive2]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "site-1",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "Documents", subscriptionId: "sub-1", expirationDateTime: "OLD" },
        { driveId: "d2", driveName: "Legal", subscriptionId: "sub-2", expirationDateTime: "OLD" },
      ],
    });
    (graph.renewSubscription as jest.Mock).mockImplementation((_cfg, id) =>
      Promise.resolve({ id, expirationDateTime: "2026-07-02" }),
    );

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.renewSubscription as jest.Mock).toHaveBeenCalledTimes(2);
    expect(graph.createSubscription as jest.Mock).not.toHaveBeenCalled();
  });

  it("creates subscriptions for newly-added drives", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1, drive2]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "site-1",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "Documents", subscriptionId: "sub-1", expirationDateTime: "OLD" },
      ],
    });
    (graph.renewSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-02",
    });
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-2",
      expirationDateTime: "2026-07-02",
    });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.createSubscription as jest.Mock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ driveId: "d2", clientState: "secret-state" }),
    );
    const persisted = (state.writeSubscriptions as jest.Mock).mock.calls[0][1];
    expect(persisted.subscriptions.map((s: any) => s.driveId).sort()).toEqual(["d1", "d2"]);
  });

  it("deletes subscriptions for removed drives and their delta blob", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "site-1",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "Documents", subscriptionId: "sub-1", expirationDateTime: "OLD" },
        { driveId: "d2", driveName: "Legal", subscriptionId: "sub-2", expirationDateTime: "OLD" },
      ],
    });
    (graph.renewSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "2026-07-02",
    });
    (graph.deleteSubscription as jest.Mock).mockResolvedValueOnce(undefined);
    (state.deleteDeltaLink as jest.Mock).mockResolvedValueOnce(undefined);

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.deleteSubscription as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "sub-2");
    expect(state.deleteDeltaLink as jest.Mock).toHaveBeenCalledWith(expect.any(Object), "d2");
    const persisted = (state.writeSubscriptions as jest.Mock).mock.calls[0][1];
    expect(persisted.subscriptions).toHaveLength(1);
    expect(persisted.subscriptions[0].driveId).toBe("d1");
  });

  it("recreates the subscription when renewal returns SubscriptionGoneError", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "site-1",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "Documents", subscriptionId: "sub-old", expirationDateTime: "OLD" },
      ],
    });
    (graph.renewSubscription as jest.Mock).mockRejectedValueOnce(
      new SubscriptionGoneError("gone"),
    );
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-new",
      expirationDateTime: "2026-07-02",
    });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(graph.createSubscription as jest.Mock).toHaveBeenCalled();
    const persisted = (state.writeSubscriptions as jest.Mock).mock.calls[0][1];
    expect(persisted.subscriptions[0].subscriptionId).toBe("sub-new");
  });

  it("runs safety-net delta sync for every active drive after reconciliation", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1, drive2]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce(undefined); // first run
    (graph.createSubscription as jest.Mock)
      .mockResolvedValueOnce({ id: "sub-1", expirationDateTime: "x" })
      .mockResolvedValueOnce({ id: "sub-2", expirationDateTime: "x" });

    await renewSubscriptionHandler({} as any, mockContext());

    // Safety-net delta sync ran for each drive (2 lease acquisitions, 2 delta queries)
    const leaseCalls = (state.tryAcquireSyncLease as jest.Mock).mock.calls;
    expect(leaseCalls.map((c) => c[1]).sort()).toEqual(["d1", "d2"]);
    expect((graph.deltaQuery as jest.Mock).mock.calls.map((c) => c[1]).sort()).toEqual(["d1", "d2"]);
  });

  it("survives a safety-net sync failure for one drive and continues with the rest", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1, drive2]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock)
      .mockResolvedValueOnce({ id: "sub-1", expirationDateTime: "x" })
      .mockResolvedValueOnce({ id: "sub-2", expirationDateTime: "x" });
    (graph.deltaQuery as jest.Mock)
      .mockRejectedValueOnce(new Error("Graph 503 for d1"))
      .mockResolvedValueOnce({ items: [], deltaLink: "D" });

    await expect(renewSubscriptionHandler({} as any, mockContext())).resolves.toBeUndefined();
    expect((graph.deltaQuery as jest.Mock).mock.calls).toHaveLength(2);
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

  it("acquires the reconciliation lease before touching subscriptions.json", async () => {
    (graph.resolveSite as jest.Mock).mockResolvedValueOnce(siteRef);
    (graph.listDrives as jest.Mock).mockResolvedValueOnce([drive1]);
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce(undefined);
    (graph.createSubscription as jest.Mock).mockResolvedValueOnce({
      id: "sub-1",
      expirationDateTime: "x",
    });

    await renewSubscriptionHandler({} as any, mockContext());

    expect(state.tryAcquireSubscriptionsLease as jest.Mock).toHaveBeenCalledTimes(1);
    expect(reconciliationLease.release).toHaveBeenCalledTimes(1);
  });

  it("skips reconciliation entirely when another instance holds the reconciliation lease", async () => {
    (state.tryAcquireSubscriptionsLease as jest.Mock).mockResolvedValueOnce(undefined);

    const ctx = mockContext();
    await renewSubscriptionHandler({} as any, ctx);

    // No site resolution, no list, no subscription mutations.
    expect(graph.resolveSite as jest.Mock).not.toHaveBeenCalled();
    expect(graph.listDrives as jest.Mock).not.toHaveBeenCalled();
    expect(state.writeSubscriptions as jest.Mock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.metric.reconciliation_lease_contention"),
    );
  });

  it("releases the reconciliation lease even when reconciliation throws", async () => {
    (graph.resolveSite as jest.Mock).mockRejectedValueOnce(new Error("Graph 500"));

    await expect(renewSubscriptionHandler({} as any, mockContext())).rejects.toThrow(/Graph 500/);
    expect(reconciliationLease.release).toHaveBeenCalledTimes(1);
  });
});

// ─── DLQ replay ───────────────────────────────────────────────────────────────

describe("dlqReplayHandler", () => {
  it("drops invalid messages without throwing", async () => {
    await expect(dlqReplayHandler({}, mockContext())).resolves.toBeUndefined();
    expect(graph.getItem as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops messages for drives no longer registered", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });

    await dlqReplayHandler(
      {
        type: "file-upload-failure",
        itemId: "i1",
        driveId: "DRIVE-REMOVED",
        fileName: "f.txt",
        size: 1,
        error: "boom",
        timestamp: "x",
      },
      mockContext(),
    );

    expect(graph.getItem as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops messages when the item no longer exists in Graph", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (graph.getItem as jest.Mock).mockResolvedValueOnce(undefined);

    await dlqReplayHandler(
      {
        type: "file-upload-failure",
        itemId: "i1",
        driveId: "d1",
        fileName: "f.txt",
        size: 1,
        error: "boom",
        timestamp: "x",
      },
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
  });

  it("drops messages when the item is now a folder/deleted", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "Folder",
      size: 0,
      folder: {},
    });

    await dlqReplayHandler(
      {
        type: "file-upload-failure",
        itemId: "i1",
        driveId: "d1",
        fileName: "Folder",
        size: 0,
        error: "boom",
        timestamp: "x",
      },
      mockContext(),
    );

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
  });

  it("short-circuits on PermanentError (does NOT re-throw — avoids 5x queue retry cycle)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "huge.bin",
      size: 5_000_000, // exceeds MAX_FILE_SIZE_BYTES=1_048_576 from env
      file: {},
    });

    const ctx = mockContext();
    await expect(
      dlqReplayHandler(
        {
          type: "file-upload-failure",
          itemId: "i1",
          driveId: "d1",
          fileName: "huge.bin",
          size: 5_000_000,
          error: "previous failure",
          timestamp: "x",
        },
        ctx,
      ),
    ).resolves.toBeUndefined();

    expect(graph.downloadFile as jest.Mock).not.toHaveBeenCalled();
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).not.toHaveBeenCalled();
    expect(ctx.error).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_replay_terminal_failure"),
    );
  });

  it("short-circuits on PermanentError from a 4xx upload (no queue retry cycle)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
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
    await expect(
      dlqReplayHandler(
        {
          type: "file-upload-failure",
          itemId: "i1",
          driveId: "d1",
          fileName: "bad.pdf",
          size: 100,
          error: "previous 400",
          timestamp: "x",
        },
        ctx,
      ),
    ).resolves.toBeUndefined();

    // 4xx is permanent — only one upload attempt, no retries, no re-throw.
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(1);
    expect(ctx.error).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_replay_terminal_failure"),
    );
  });

  it("propagates transient errors so the queue can retry (then poison)", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "a.txt",
      size: 1,
      file: {},
    });
    (graph.downloadFile as jest.Mock).mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValue({
      status: 503,
      responseBody: "still down",
    });

    await expect(
      dlqReplayHandler(
        {
          type: "file-upload-failure",
          itemId: "i1",
          driveId: "d1",
          fileName: "a.txt",
          size: 1,
          error: "transient",
          timestamp: "x",
        },
        mockContext(),
      ),
    ).rejects.toThrow(/503/);
    // 3 attempts via the in-function retry budget before propagating
    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalledTimes(3);
  });

  it("reprocesses a valid item successfully", async () => {
    (state.readSubscriptions as jest.Mock).mockResolvedValueOnce({
      siteId: "s",
      clientState: "secret-state",
      subscriptions: [
        { driveId: "d1", driveName: "A", subscriptionId: "sub-A", expirationDateTime: "x" },
      ],
    });
    (graph.getItem as jest.Mock).mockResolvedValueOnce({
      id: "i1",
      name: "a.txt",
      size: 1,
      file: {},
    });
    (graph.downloadFile as jest.Mock).mockResolvedValueOnce({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    (rootkey.uploadNewFileToRootkey as jest.Mock).mockResolvedValueOnce({
      status: 200,
      responseBody: "ok",
    });

    await dlqReplayHandler(
      {
        type: "file-upload-failure",
        itemId: "i1",
        driveId: "d1",
        fileName: "a.txt",
        size: 1,
        error: "transient",
        timestamp: "x",
      },
      mockContext(),
    );

    expect(rootkey.uploadNewFileToRootkey as jest.Mock).toHaveBeenCalled();
  });
});

// ─── Registrations ────────────────────────────────────────────────────────────

describe("function registrations", () => {
  it("registers the HTTP notification endpoint", () => {
    expect(httpRegistrations.find((r) => r.name === "notification")).toBeDefined();
  });

  it("registers the timer for subscription renewal with runOnStartup", () => {
    const reg = timerRegistrations.find((r) => r.name === "renewSubscription");
    expect(reg).toBeDefined();
    expect(reg?.options.schedule).toBe("0 0 */1 * * *");
    expect(reg?.options.runOnStartup).toBe(true);
  });

  it("registers the DLQ replay storage queue trigger", () => {
    const reg = queueRegistrations.find((r) => r.name === "dlqReplay");
    expect(reg).toBeDefined();
    expect(reg?.options.connection).toBe("DlqStorage");
  });
});
