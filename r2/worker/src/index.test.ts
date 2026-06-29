import handler, { handleMessage, R2EventMessage } from "./index";
import type { Env } from "./config";

// ─── Test doubles ─────────────────────────────────────────────────────────────

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface MockObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
}

function mockBucket(returns: Record<string, MockObject | null>) {
  return {
    get: jest.fn(async (key: string) => returns[key] ?? null),
  } as any;
}

interface MockMessage {
  body: R2EventMessage;
  attempts: number;
  ack: jest.Mock;
  retry: jest.Mock;
  id: string;
  timestamp: Date;
}

function mockMessage(body: R2EventMessage, attempts = 1): MockMessage {
  return {
    body,
    attempts,
    ack: jest.fn(),
    retry: jest.fn(),
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date(),
  };
}

function mockBatch(messages: MockMessage[]) {
  return {
    messages,
    queue: "rootkey-r2-events",
    ackAll: jest.fn(),
    retryAll: jest.fn(),
  } as any;
}

function baseEnv(bucket: any = mockBucket({})): Env {
  return {
    ROOTKEY_API_URL: "https://api.test.rootkey.ai",
    ROOTKEY_API_KEY: "rk-key",
    MAX_FILE_SIZE_BYTES: "1048576",
    BUCKET: bucket,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  responses: Array<Response | (() => Response)>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  (globalThis as { fetch: typeof fetch }).fetch = ((input: any, init: RequestInit = {}) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    // Drain the body so the test doesn't hang on an open ReadableStream.
    return drainBody(init.body).then(() => {
      const next = responses[index++];
      if (!next) throw new Error("No fetch response queued");
      return typeof next === "function" ? next() : next;
    });
  }) as typeof fetch;
  return { calls };
}

async function drainBody(body: BodyInit | null | undefined): Promise<void> {
  if (!body) return;
  const stream = body as ReadableStream;
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// Silence expected console output to keep test runs readable.
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─── handleMessage: happy path ────────────────────────────────────────────────

describe("handleMessage — happy path", () => {
  it("uploads a PutObject event and acks", async () => {
    const bucket = mockBucket({
      "docs/a.pdf": { body: streamFromString("hello"), size: 5, etag: '"etag-1"' },
    });
    const env = baseEnv(bucket);
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    const fetchMock = installFetchMock([new Response("ok", { status: 201 })]);

    const msg = mockMessage({
      action: "PutObject",
      bucket: "my-bucket",
      object: { key: "docs/a.pdf", size: 5, eTag: "etag-from-event" },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(bucket.get).toHaveBeenCalledWith("docs/a.pdf");
    expect(fetchMock.calls).toHaveLength(1);

    const headers = fetchMock.calls[0].init.headers as Record<string, string>;
    expect(headers["x-rootkey-source-bucket"]).toBe("my-bucket");
    expect(headers["x-rootkey-source-key"]).toBe("docs/a.pdf");
    // Prefer the live eTag from the R2 binding (more accurate than event payload).
    expect(headers["x-rootkey-source-etag"]).toBe("etag-1");
  });

  it("handles CompleteMultipartUpload and CopyObject actions", async () => {
    const env = baseEnv(
      mockBucket({
        "a.bin": { body: streamFromString("a"), size: 1, etag: "e1" },
        "b.bin": { body: streamFromString("b"), size: 1, etag: "e2" },
      }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    installFetchMock([new Response("ok", { status: 200 }), new Response("ok", { status: 200 })]);

    const m1 = mockMessage({
      action: "CompleteMultipartUpload",
      bucket: "b",
      object: { key: "a.bin", size: 1 },
    });
    const m2 = mockMessage({
      action: "CopyObject",
      bucket: "b",
      object: { key: "b.bin", size: 1 },
    });

    await handleMessage(m1 as any, cfg, env);
    await handleMessage(m2 as any, cfg, env);

    expect(m1.ack).toHaveBeenCalledTimes(1);
    expect(m2.ack).toHaveBeenCalledTimes(1);
  });
});

// ─── handleMessage: action filtering ──────────────────────────────────────────

describe("handleMessage — action filtering", () => {
  it("acks and skips DeleteObject events", async () => {
    const env = baseEnv();
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "DeleteObject",
      bucket: "b",
      object: { key: "gone.txt" },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect((env.BUCKET as any).get).not.toHaveBeenCalled();
  });

  it("acks and skips LifecycleDeletion events", async () => {
    const env = baseEnv();
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "LifecycleDeletion",
      bucket: "b",
      object: { key: "expired.txt" },
    });

    await handleMessage(msg as any, cfg, env);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect((env.BUCKET as any).get).not.toHaveBeenCalled();
  });

  it("acks and skips malformed events", async () => {
    const env = baseEnv();
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({ action: "PutObject", bucket: "b", object: { key: "" } });
    await handleMessage(msg as any, cfg, env);
    expect(msg.ack).toHaveBeenCalled();
    expect((env.BUCKET as any).get).not.toHaveBeenCalled();
  });
});

// ─── handleMessage: short-circuit on PermanentError ───────────────────────────

describe("handleMessage — PermanentError short-circuit", () => {
  it("acks and logs marker when reported size exceeds MAX_FILE_SIZE_BYTES (no R2 read)", async () => {
    const env = baseEnv();
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "huge.bin", size: 5_000_000 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect((env.BUCKET as any).get).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_terminal_failure"),
    );
  });

  it("acks and logs marker when the object no longer exists in R2", async () => {
    const env = baseEnv(mockBucket({})); // BUCKET.get returns null
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "gone.txt", size: 10 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_terminal_failure"),
    );
  });

  it("acks and logs marker on a 4xx upload (PermanentError)", async () => {
    const env = baseEnv(
      mockBucket({ "bad.pdf": { body: streamFromString("x"), size: 1, etag: "e" } }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    installFetchMock([new Response("validation failed", { status: 400 })]);

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "bad.pdf", size: 1 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_terminal_failure"),
    );
  });

  it("rejects when the live R2 object size exceeds the limit even if event size was small", async () => {
    const env = baseEnv(
      mockBucket({ "x.bin": { body: streamFromString("x"), size: 5_000_000, etag: "e" } }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "x.bin", size: 100 }, // event under-reports size
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rootkey.event.dlq_terminal_failure"),
    );
  });
});

// ─── handleMessage: transient failures retry ──────────────────────────────────

describe("handleMessage — transient failures", () => {
  it("retries on 5xx (Queue will retry up to max_retries then DLQ)", async () => {
    const env = baseEnv(
      mockBucket({ "f.txt": { body: streamFromString("x"), size: 1, etag: "e" } }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    installFetchMock([new Response("upstream", { status: 503 })]);

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "f.txt", size: 1 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Transient failure"));
  });

  it("retries on 429 (treated like 5xx)", async () => {
    const env = baseEnv(
      mockBucket({ "f.txt": { body: streamFromString("x"), size: 1, etag: "e" } }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    installFetchMock([new Response("rate limit", { status: 429 })]);

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "f.txt", size: 1 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries when fetch itself throws", async () => {
    const env = baseEnv(
      mockBucket({ "f.txt": { body: streamFromString("x"), size: 1, etag: "e" } }),
    );
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };
    (globalThis as { fetch: typeof fetch }).fetch = (() =>
      Promise.reject(new Error("ECONNRESET"))) as typeof fetch;

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "f.txt", size: 1 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries when R2 binding itself throws", async () => {
    const bucket = { get: jest.fn().mockRejectedValue(new Error("R2 transient")) };
    const env = baseEnv(bucket as any);
    const cfg = { rootkeyApiUrl: env.ROOTKEY_API_URL, rootkeyApiKey: env.ROOTKEY_API_KEY, maxFileSizeBytes: 1_048_576 };

    const msg = mockMessage({
      action: "PutObject",
      bucket: "b",
      object: { key: "f.txt", size: 1 },
    });

    await handleMessage(msg as any, cfg, env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

// ─── Queue handler (default export) ──────────────────────────────────────────

describe("queue handler", () => {
  it("processes every message in the batch independently", async () => {
    const env = baseEnv(
      mockBucket({
        "a.txt": { body: streamFromString("a"), size: 1, etag: "ea" },
        "b.txt": { body: streamFromString("b"), size: 1, etag: "eb" },
        "c.txt": { body: streamFromString("c"), size: 1, etag: "ec" },
      }),
    );
    installFetchMock([
      new Response("ok", { status: 200 }),
      new Response("ok", { status: 200 }),
      new Response("ok", { status: 200 }),
    ]);

    const messages = [
      mockMessage({ action: "PutObject", bucket: "b", object: { key: "a.txt", size: 1 } }),
      mockMessage({ action: "PutObject", bucket: "b", object: { key: "b.txt", size: 1 } }),
      mockMessage({ action: "PutObject", bucket: "b", object: { key: "c.txt", size: 1 } }),
    ];

    await handler.queue(mockBatch(messages) as any, env);

    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it("isolates failures: one message can retry while others ack successfully", async () => {
    const env = baseEnv(
      mockBucket({
        "good.txt": { body: streamFromString("g"), size: 1, etag: "eg" },
        "bad.txt": { body: streamFromString("b"), size: 1, etag: "eb" },
      }),
    );
    installFetchMock([
      new Response("ok", { status: 200 }),
      new Response("transient", { status: 503 }),
    ]);

    const m1 = mockMessage({ action: "PutObject", bucket: "b", object: { key: "good.txt", size: 1 } });
    const m2 = mockMessage({ action: "PutObject", bucket: "b", object: { key: "bad.txt", size: 1 } });

    await handler.queue(mockBatch([m1, m2]) as any, env);

    expect(m1.ack).toHaveBeenCalledTimes(1);
    expect(m2.retry).toHaveBeenCalledTimes(1);
  });

  it("acks every message and logs marker if config loading fails", async () => {
    const env: Env = {
      ROOTKEY_API_URL: "", // forces loadConfig to throw
      ROOTKEY_API_KEY: "",
      BUCKET: mockBucket({}) as any,
    };

    const messages = [
      mockMessage({ action: "PutObject", bucket: "b", object: { key: "a.txt", size: 1 } }),
      mockMessage({ action: "PutObject", bucket: "b", object: { key: "b.txt", size: 1 } }),
    ];

    await handler.queue(mockBatch(messages) as any, env);

    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/rootkey\.event\.dlq_terminal_failure.*config:/),
    );
  });
});
