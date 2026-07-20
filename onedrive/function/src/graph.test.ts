import { Readable } from "stream";
import {
  deltaQuery,
  downloadFile,
  getItem,
  createSubscription,
  renewSubscription,
  SubscriptionGoneError,
  __resetTokenCacheForTesting,
  GraphConfig,
} from "./graph";

const mockFetch = jest.fn();
(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const cfg: GraphConfig = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "secret",
  driveId: "drive-abc",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: "tk-1", expires_in: 3600 });
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetTokenCacheForTesting();
});

describe("access token", () => {
  it("requests a new token on first call and caches it", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "next" }))
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "next2" }));

    await deltaQuery(cfg);
    await deltaQuery(cfg);

    // 1 token call + 2 delta calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const tokenCalls = mockFetch.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/oauth2/v2.0/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("throws when token endpoint returns non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(new Response("invalid_client", { status: 401 }));
    await expect(deltaQuery(cfg)).rejects.toThrow(/OAuth token request failed: 401/);
  });
});

describe("deltaQuery", () => {
  it("calls the initial delta endpoint when no cursor is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: "x", name: "x.txt", size: 5, file: {} }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-abc/root/delta?token=NEW",
        }),
      );

    const res = await deltaQuery(cfg);
    expect(res.items).toHaveLength(1);
    expect(res.deltaLink).toContain("token=NEW");

    // $select is applied so Graph returns the enriched DriveItem fields (cTag,
    // createdBy, webUrl, etc.) needed for the metadata pack sent to ROOTKey.
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/drive-abc\/root\/delta\?\$select=/,
    );
    expect(url).toContain("cTag");
    expect(url).toContain("createdBy");
  });

  it("uses a fully qualified deltaLink URL directly when passed", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "done" }));

    await deltaQuery(cfg, "https://graph.microsoft.com/v1.0/drives/drive-abc/root/delta?token=ABC");
    expect(mockFetch.mock.calls[1][0]).toContain("token=ABC");
  });

  it("appends a bare token string as a query param", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "done" }));

    await deltaQuery(cfg, "RAW_TOKEN_VALUE");
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain("token=RAW_TOKEN_VALUE");
    expect(url).toContain("$select=");
  });

  it("forwards nextLink and deltaLink fields", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: "a", name: "a", size: 1 }],
          "@odata.nextLink": "https://graph.microsoft.com/next",
        }),
      );
    const res = await deltaQuery(cfg);
    expect(res.nextLink).toBe("https://graph.microsoft.com/next");
    expect(res.deltaLink).toBeUndefined();
  });

  it("throws on non-2xx delta response", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    await expect(deltaQuery(cfg)).rejects.toThrow(/Delta query failed: 403/);
  });

  it("returns an empty items array when value is missing", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ "@odata.deltaLink": "x" }));
    const res = await deltaQuery(cfg);
    expect(res.items).toEqual([]);
  });
});

describe("downloadFile", () => {
  it("returns a stream + size", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("file-contents"));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "13" },
    });
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(response);

    const { stream, size } = await downloadFile(cfg, "item-1");
    expect(size).toBe(13);
    expect(stream).toBeInstanceOf(Readable);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("file-contents");
  });

  it("throws when download responds non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    await expect(downloadFile(cfg, "missing")).rejects.toThrow(/File download failed.*404/);
  });

  it("throws when response body is null", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(downloadFile(cfg, "x")).rejects.toThrow(/Empty response body/);
  });
});

describe("getItem", () => {
  it("returns the parsed DriveItem when found", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ id: "i1", name: "doc.pdf", size: 42, file: { mimeType: "application/pdf" }, eTag: "etag-1" }),
      );
    const item = await getItem(cfg, "i1");
    expect(item?.id).toBe("i1");
    expect(item?.size).toBe(42);
    expect(item?.eTag).toBe("etag-1");
  });

  it("returns undefined on 404", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await getItem(cfg, "missing")).toBeUndefined();
  });

  it("throws on other non-2xx responses", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(getItem(cfg, "i1")).rejects.toThrow(/Get item failed.*403/);
  });
});

describe("createSubscription", () => {
  it("posts the correct body and returns the subscription", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        id: "sub-1",
        expirationDateTime: "2026-07-01T00:00:00Z",
        clientState: "cs",
      }),
    );

    const result = await createSubscription(cfg, {
      notificationUrl: "https://myfunc.azurewebsites.net/api/notification",
      clientState: "cs",
    });

    expect(result.id).toBe("sub-1");

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.resource).toBe("/drives/drive-abc/root");
    expect(body.changeType).toBe("updated");
    expect(body.notificationUrl).toBe("https://myfunc.azurewebsites.net/api/notification");
    expect(body.clientState).toBe("cs");
    expect(body.expirationDateTime).toMatch(/^\d{4}-/);
  });

  it("throws on non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("err", { status: 400 }));
    await expect(
      createSubscription(cfg, { notificationUrl: "https://x", clientState: "y" }),
    ).rejects.toThrow(/Create subscription failed: 400/);
  });
});

describe("renewSubscription", () => {
  it("patches the subscription expiration", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        id: "sub-1",
        expirationDateTime: "2026-07-02T00:00:00Z",
      }),
    );
    const result = await renewSubscription(cfg, "sub-1");
    expect(result.expirationDateTime).toBe("2026-07-02T00:00:00Z");

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("throws SubscriptionGoneError on 404", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(renewSubscription(cfg, "sub-x")).rejects.toBeInstanceOf(SubscriptionGoneError);
  });

  it("throws regular error on 500", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(renewSubscription(cfg, "sub-x")).rejects.toThrow(/Renew subscription failed: 500/);
  });
});
