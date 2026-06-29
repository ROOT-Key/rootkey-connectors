import { Readable } from "stream";
import {
  deltaQuery,
  downloadFile,
  getItem,
  createSubscription,
  renewSubscription,
  deleteSubscription,
  resolveSite,
  listDrives,
  parseSiteUrl,
  SubscriptionGoneError,
  __resetTokenCacheForTesting,
  GraphCredentials,
} from "./graph";

const mockFetch = jest.fn();
(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const cfg: GraphCredentials = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: "tk-1", expires_in: 3600 });
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetTokenCacheForTesting();
});

describe("parseSiteUrl", () => {
  it("extracts hostname and server-relative path", () => {
    expect(parseSiteUrl("https://contoso.sharepoint.com/sites/legal")).toEqual({
      hostname: "contoso.sharepoint.com",
      serverRelativePath: "/sites/legal",
    });
  });

  it("strips trailing slashes", () => {
    expect(parseSiteUrl("https://contoso.sharepoint.com/sites/marketing/")).toEqual({
      hostname: "contoso.sharepoint.com",
      serverRelativePath: "/sites/marketing",
    });
  });

  it("handles the root site (no path)", () => {
    expect(parseSiteUrl("https://contoso.sharepoint.com")).toEqual({
      hostname: "contoso.sharepoint.com",
      serverRelativePath: "/",
    });
  });

  it("throws on malformed URL", () => {
    expect(() => parseSiteUrl("not-a-url")).toThrow(/Invalid site_url/);
  });

  it("throws when hostname is not *.sharepoint.com", () => {
    expect(() => parseSiteUrl("https://malicious.example.com/sites/legal")).toThrow(
      /sharepoint\.com/,
    );
  });
});

describe("access token", () => {
  it("caches the token across calls", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "x" }))
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "y" }));

    await deltaQuery(cfg, "drive-1");
    await deltaQuery(cfg, "drive-1");

    const tokenCalls = mockFetch.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/oauth2/v2.0/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("throws when token endpoint returns non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(new Response("invalid_client", { status: 401 }));
    await expect(deltaQuery(cfg, "drive-1")).rejects.toThrow(/OAuth token request failed: 401/);
  });
});

describe("resolveSite", () => {
  it("resolves a site with a server-relative path", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: "contoso.sharepoint.com,abc,def" }));

    const result = await resolveSite(cfg, "https://contoso.sharepoint.com/sites/legal");
    expect(result.id).toBe("contoso.sharepoint.com,abc,def");
    expect(result.hostname).toBe("contoso.sharepoint.com");
    expect(result.serverRelativePath).toBe("/sites/legal");
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/legal",
    );
  });

  it("resolves the root site without colon path", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: "site-root" }));

    await resolveSite(cfg, "https://contoso.sharepoint.com");
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com",
    );
  });

  it("throws on non-2xx response", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(
      resolveSite(cfg, "https://contoso.sharepoint.com/sites/missing"),
    ).rejects.toThrow(/Site lookup failed.*404/);
  });
});

describe("listDrives", () => {
  it("returns drives from a single page", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: "d1", name: "Documents" },
          { id: "d2", name: "Legal" },
        ],
      }),
    );
    const result = await listDrives(cfg, "site-1");
    expect(result).toEqual([
      { id: "d1", name: "Documents" },
      { id: "d2", name: "Legal" },
    ]);
  });

  it("paginates via @odata.nextLink", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: "d1", name: "A" }],
          "@odata.nextLink": "https://graph.microsoft.com/page2",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "d2", name: "B" }] }));

    const result = await listDrives(cfg, "site-1");
    expect(result).toEqual([
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ]);
  });

  it("throws on non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(listDrives(cfg, "site-1")).rejects.toThrow(/List drives failed.*403/);
  });
});

describe("deltaQuery", () => {
  it("includes driveId in the URL when no cursor is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "x" }));

    await deltaQuery(cfg, "drive-abc");
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://graph.microsoft.com/v1.0/drives/drive-abc/root/delta",
    );
  });

  it("uses a fully qualified deltaLink URL directly", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "done" }));
    await deltaQuery(
      cfg,
      "drive-abc",
      "https://graph.microsoft.com/v1.0/drives/drive-abc/root/delta?token=ABC",
    );
    expect(mockFetch.mock.calls[1][0]).toContain("token=ABC");
  });

  it("appends a bare token as a query param", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "done" }));
    await deltaQuery(cfg, "drive-abc", "RAW_TOKEN");
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://graph.microsoft.com/v1.0/drives/drive-abc/root/delta?token=RAW_TOKEN",
    );
  });

  it("throws on non-2xx response", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(deltaQuery(cfg, "drive-abc")).rejects.toThrow(/Delta query failed.*403/);
  });

  it("returns empty items array when value is missing", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ "@odata.deltaLink": "x" }));
    const res = await deltaQuery(cfg, "drive-abc");
    expect(res.items).toEqual([]);
  });
});

describe("downloadFile", () => {
  it("returns a stream + size for the requested drive item", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "5" },
    });
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(response);

    const { stream, size } = await downloadFile(cfg, "drive-1", "item-1");
    expect(size).toBe(5);
    expect(stream).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("throws when download responds non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(downloadFile(cfg, "drive-1", "missing")).rejects.toThrow(
      /File download failed.*404/,
    );
  });

  it("throws when response body is null", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(downloadFile(cfg, "drive-1", "x")).rejects.toThrow(/Empty response body/);
  });
});

describe("getItem", () => {
  it("returns the parsed DriveItem when found", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        id: "i1",
        name: "doc.pdf",
        size: 42,
        file: { mimeType: "application/pdf" },
        eTag: "etag-1",
      }),
    );
    const item = await getItem(cfg, "drive-1", "i1");
    expect(item?.id).toBe("i1");
    expect(item?.size).toBe(42);
    expect(item?.eTag).toBe("etag-1");
    const url = mockFetch.mock.calls[1][0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/drives/drive-1/items/i1");
  });

  it("returns undefined on 404", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await getItem(cfg, "drive-1", "missing")).toBeUndefined();
  });

  it("throws on other non-2xx responses", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(getItem(cfg, "drive-1", "i1")).rejects.toThrow(/Get item failed.*403/);
  });
});

describe("createSubscription", () => {
  it("posts the correct resource and returns the subscription", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        id: "sub-1",
        expirationDateTime: "2026-07-01T00:00:00Z",
      }),
    );

    const result = await createSubscription(cfg, {
      driveId: "drive-abc",
      notificationUrl: "https://x/api/notification",
      clientState: "cs",
    });

    expect(result.id).toBe("sub-1");
    const [_url, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.resource).toBe("/drives/drive-abc/root");
  });

  it("throws on non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("bad", { status: 400 }));
    await expect(
      createSubscription(cfg, {
        driveId: "d",
        notificationUrl: "https://x",
        clientState: "y",
      }),
    ).rejects.toThrow(/Create subscription failed.*400/);
  });
});

describe("renewSubscription", () => {
  it("patches the expiration", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ id: "sub-1", expirationDateTime: "2026-07-02T00:00:00Z" }),
      );
    const result = await renewSubscription(cfg, "sub-1");
    expect(result.expirationDateTime).toBe("2026-07-02T00:00:00Z");
    expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("PATCH");
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

describe("deleteSubscription", () => {
  it("issues DELETE and resolves on 2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteSubscription(cfg, "sub-1")).resolves.toBeUndefined();
    expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("treats 404 as success (already gone)", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(deleteSubscription(cfg, "sub-x")).resolves.toBeUndefined();
  });

  it("throws on other non-2xx", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(deleteSubscription(cfg, "sub-x")).rejects.toThrow(/Delete subscription failed.*403/);
  });
});
