import { uploadFileToRootkey, sanitizeFilename } from "./rootkey";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface CapturedFetch {
  url: string;
  init: RequestInit;
  body?: string;
}

function installFetchMock(response: Response): CapturedFetch {
  const captured: CapturedFetch = { url: "", init: {} };
  (globalThis as { fetch: typeof fetch }).fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.init = init ?? {};
    return readBody(captured.init.body)
      .then((body) => {
        captured.body = body;
        return response;
      });
  };
  return captured;
}

async function readBody(body: BodyInit | null | undefined): Promise<string> {
  if (!body) return "";
  // The Worker passes a ReadableStream as body — drain it to a string for assertions.
  const stream = body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

describe("sanitizeFilename", () => {
  it("strips quotes, backslashes and newlines", () => {
    expect(sanitizeFilename('a"b\\c\r\nd')).toBe("a_b_c__d");
  });

  it("truncates at 255 chars", () => {
    expect(sanitizeFilename("x".repeat(300))).toHaveLength(255);
  });

  it("passes safe names through", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
  });
});

describe("uploadFileToRootkey", () => {
  it("sends multipart body with correct headers and streams content", async () => {
    const captured = installFetchMock(new Response('{"id":"abc"}', { status: 201 }));

    const result = await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "rk-key" },
      { bucket: "my-bucket", key: "docs/report.pdf", eTag: '"etag-abc"' },
      streamFromString("hello world"),
      11,
    );

    expect(result.status).toBe(201);
    expect(result.responseBody).toBe('{"id":"abc"}');

    expect(captured.url).toBe("https://api.test.rootkey.ai/api-v1/connectors/files/");
    const headers = captured.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("rk-key");
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=----ROOTKey/);
    expect(headers["x-rootkey-source-bucket"]).toBe("my-bucket");
    expect(headers["x-rootkey-source-key"]).toBe("docs/report.pdf");
    expect(headers["x-rootkey-source-etag"]).toBe("etag-abc"); // quotes stripped

    expect(captured.body).toContain('filename="report.pdf"');
    expect(captured.body).toContain("hello world");
    expect(captured.body).toContain("Content-Type: application/octet-stream");
  });

  it("omits the etag header when no eTag is provided", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt" },
      streamFromString("x"),
      1,
    );

    const headers = captured.init.headers as Record<string, string>;
    expect(headers["x-rootkey-source-etag"]).toBeUndefined();
  });

  it("extracts the filename from a deeply nested key", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "a/b/c/d/deep-file.csv" },
      streamFromString("x"),
      1,
    );

    expect(captured.body).toContain('filename="deep-file.csv"');
  });

  it("falls back to 'file' when key ends with a slash", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "folder/" },
      streamFromString("x"),
      1,
    );

    expect(captured.body).toContain('filename="file"');
  });

  it("computes Content-Length as header + body + footer", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "x.txt" },
      streamFromString("hello"),
      5,
    );

    const headers = captured.init.headers as Record<string, string>;
    const contentLength = Number(headers["Content-Length"]);
    expect(contentLength).toBe(captured.body!.length);
  });

  it("propagates non-2xx responses (caller decides retry vs permanent)", async () => {
    installFetchMock(new Response("upstream broken", { status: 503 }));

    const result = await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt" },
      streamFromString("x"),
      1,
    );

    expect(result.status).toBe(503);
    expect(result.responseBody).toBe("upstream broken");
  });

  it("uses duplex: 'half' so streamed bodies work in undici/Workers runtimes", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt" },
      streamFromString("x"),
      1,
    );

    expect((captured.init as RequestInit & { duplex?: string }).duplex).toBe("half");
  });

  it("forwards stream cancellation to the R2 body (no leaked readers)", async () => {
    // When fetch cancels the upstream body — e.g. due to an HTTP abort — the
    // combined stream's cancel() callback must cancel the underlying R2 stream.
    const r2BodyCancel = jest.fn().mockResolvedValue(undefined);
    const r2Body: ReadableStream<Uint8Array> = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("never-fully-read"));
      },
      cancel: r2BodyCancel,
    });

    (globalThis as { fetch: typeof fetch }).fetch = ((_input: any, init?: RequestInit) => {
      // Cancel the body stream immediately instead of draining it.
      const stream = init!.body as ReadableStream;
      return stream.cancel("aborted by test").then(() => new Response("aborted", { status: 200 }));
    }) as typeof fetch;

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt" },
      r2Body,
      16,
    );

    expect(r2BodyCancel).toHaveBeenCalled();
  });

  it("passes through an etag that has no surrounding quotes", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt", eTag: "plain-etag" },
      streamFromString("x"),
      1,
    );

    const headers = captured.init.headers as Record<string, string>;
    expect(headers["x-rootkey-source-etag"]).toBe("plain-etag");
  });

  it("forwards an AbortSignal to fetch when provided", async () => {
    const captured = installFetchMock(new Response("ok", { status: 200 }));

    const controller = new AbortController();
    await uploadFileToRootkey(
      { apiUrl: "https://api.test.rootkey.ai", apiKey: "k" },
      { bucket: "b", key: "f.txt" },
      streamFromString("x"),
      1,
      controller.signal,
    );

    expect(captured.init.signal).toBe(controller.signal);
  });
});
