import * as https from "https";
import { EventEmitter } from "events";
import { Readable } from "stream";

process.env.ROOTKEY_API_URL = "https://api.test.rootkey.ai";
process.env.ROOTKEY_API_KEY_SECRET_ARN = "arn:aws:secretsmanager:eu-west-1:123:secret:rk-abc";
process.env.AWS_REGION = "eu-west-1";
process.env.MAX_FILE_SIZE_BYTES = "1048576";

const mockS3Send = jest.fn();
const mockSecretsSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((input: unknown) => ({ __type: "GetObject", input })),
  HeadObjectCommand: jest.fn((input: unknown) => ({ __type: "HeadObject", input })),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ __type: "GetSecret", input })),
}));

jest.mock("https");

import { handler, __resetCacheForTesting } from "./index";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function s3GetResponse(content: string) {
  return { Body: Readable.from([Buffer.from(content)]) };
}

interface CapturedRequest {
  options: https.RequestOptions;
  writes: Buffer[];
  setTimeout: jest.Mock;
  destroy: jest.Mock;
  end: jest.Mock;
}

function setupHttpMock(statusCode: number, body: string): CapturedRequest {
  const response = Object.assign(new EventEmitter(), { statusCode });
  const writes: Buffer[] = [];

  const request = Object.assign(new EventEmitter(), {
    write: jest.fn((chunk: Buffer | string) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }),
    setTimeout: jest.fn(),
    destroy: jest.fn(),
    end: jest.fn(() => {
      setImmediate(() => {
        response.emit("data", Buffer.from(body));
        response.emit("end");
      });
    }),
  });

  // Required by Readable.pipe(req) — pipe inspects these properties on the writable
  Object.assign(request, {
    writable: true,
    writableEnded: false,
    on: request.on.bind(request),
    once: request.once.bind(request),
    emit: request.emit.bind(request),
  });

  const captured: CapturedRequest = {
    options: {} as https.RequestOptions,
    writes,
    setTimeout: request.setTimeout as jest.Mock,
    destroy: request.destroy as jest.Mock,
    end: request.end as jest.Mock,
  };

  (https.request as jest.Mock).mockImplementationOnce(
    (opts: https.RequestOptions, cb: (res: unknown) => void) => {
      captured.options = opts;
      cb(response);
      return request;
    },
  );

  return captured;
}

function makeEvent(opts: {
  bucket: string;
  key: string;
  size?: number;
  etag?: string;
  versionId?: string;
  source?: string;
  detailType?: string;
}) {
  return {
    source: opts.source ?? "aws.s3",
    "detail-type": opts.detailType ?? "Object Created",
    detail: {
      bucket: { name: opts.bucket },
      object: {
        key: opts.key,
        size: opts.size ?? 11,
        etag: opts.etag ?? "etag-abc",
        ...(opts.versionId ? { "version-id": opts.versionId } : {}),
      },
    },
  };
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetCacheForTesting();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockSecretsSend.mockResolvedValue({ SecretString: "test-api-key" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("happy path", () => {
    it("uploads a file, sends multipart body with correct headers and metadata", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("hello world"));
      const req = setupHttpMock(201, '{"id":"abc123"}');

      await handler(
        makeEvent({
          bucket: "my-bucket",
          key: "docs/report.pdf",
          size: 11,
          etag: "etag-pdf",
          versionId: "v1",
        }),
        {} as any,
      );

      const combined = Buffer.concat(req.writes).toString();
      expect(combined).toContain('filename="report.pdf"');
      expect(combined).toContain("hello world");
      expect(combined).toContain("Content-Type: application/octet-stream");

      const headers = req.options.headers as Record<string, string | number>;
      expect(headers["x-api-key"]).toBe("test-api-key");
      expect(headers["x-rootkey-source-bucket"]).toBe("my-bucket");
      expect(headers["x-rootkey-source-key"]).toBe("docs/report.pdf");
      expect(headers["x-rootkey-source-etag"]).toBe("etag-pdf");
      expect(headers["x-rootkey-source-version-id"]).toBe("v1");
      expect(String(headers["Content-Type"])).toMatch(/^multipart\/form-data; boundary=----ROOTKey/);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("201"));
    });

    it("caches the API key across invocations (Secrets Manager called once)", async () => {
      mockS3Send.mockImplementation(() => Promise.resolve(s3GetResponse("x")));
      setupHttpMock(200, "ok");
      setupHttpMock(200, "ok");

      await handler(makeEvent({ bucket: "b", key: "a.txt", size: 1 }), {} as any);
      await handler(makeEvent({ bucket: "b", key: "b.txt", size: 1 }), {} as any);

      expect(mockSecretsSend).toHaveBeenCalledTimes(1);
    });

    it("passes versionId to GetObject when present", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      setupHttpMock(200, "ok");

      await handler(
        makeEvent({ bucket: "b", key: "f.txt", size: 1, versionId: "v42" }),
        {} as any,
      );

      const call = mockS3Send.mock.calls[0][0];
      expect(call.input.VersionId).toBe("v42");
    });

    it("omits version-id header when event has none", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      const req = setupHttpMock(200, "ok");

      await handler(makeEvent({ bucket: "b", key: "f.txt", size: 1 }), {} as any);

      const headers = req.options.headers as Record<string, string | number>;
      expect(headers["x-rootkey-source-version-id"]).toBeUndefined();
    });
  });

  describe("filename handling", () => {
    it("extracts the filename from a deeply nested S3 key", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      const req = setupHttpMock(200, "ok");

      await handler(makeEvent({ bucket: "b", key: "a/b/c/d/deep-file.csv", size: 1 }), {} as any);

      const combined = Buffer.concat(req.writes).toString();
      expect(combined).toContain('filename="deep-file.csv"');
    });

    it("escapes quotes, backslashes and newlines in filenames", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      const req = setupHttpMock(200, "ok");

      await handler(
        makeEvent({ bucket: "b", key: 'evil"name\r\nwith\\stuff.txt', size: 1 }),
        {} as any,
      );

      const combined = Buffer.concat(req.writes).toString();
      expect(combined).toContain('filename="evil_name__with_stuff.txt"');
      expect(combined).not.toContain('"name');
    });

    it("falls back to 'file' when key ends with a slash", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      const req = setupHttpMock(200, "ok");

      await handler(makeEvent({ bucket: "b", key: "folder/", size: 1 }), {} as any);

      const combined = Buffer.concat(req.writes).toString();
      expect(combined).toContain('filename="file"');
    });
  });

  describe("file size limit", () => {
    it("throws when reported size exceeds MAX_FILE_SIZE_BYTES", async () => {
      await expect(
        handler(makeEvent({ bucket: "b", key: "huge.bin", size: 2_000_000 }), {} as any),
      ).rejects.toThrow(/exceeds MAX_FILE_SIZE_BYTES/);

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it("calls HeadObject and re-checks size when event reports 0", async () => {
      mockS3Send.mockResolvedValueOnce({ ContentLength: 2_000_000 });

      await expect(
        handler(makeEvent({ bucket: "b", key: "huge.bin", size: 0 }), {} as any),
      ).rejects.toThrow(/exceeds MAX_FILE_SIZE_BYTES/);

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      expect(mockS3Send.mock.calls[0][0].__type).toBe("HeadObject");
    });
  });

  describe("event filtering", () => {
    it("ignores events that are not aws.s3 Object Created", async () => {
      await handler(
        makeEvent({ bucket: "b", key: "f.txt", source: "aws.ec2" }),
        {} as any,
      );

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe("error cases", () => {
    it("throws (so Lambda retry/DLQ kicks in) on non-2xx response", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));
      setupHttpMock(503, "Service Unavailable");

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow(/503/);
    });

    it("throws on S3 GetObject failure", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("AccessDenied"));

      await expect(
        handler(makeEvent({ bucket: "b", key: "denied.txt", size: 1 }), {} as any),
      ).rejects.toThrow("AccessDenied");
    });

    it("throws on Secrets Manager failure", async () => {
      mockSecretsSend.mockReset();
      mockSecretsSend.mockRejectedValueOnce(new Error("AccessDeniedException"));
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow("AccessDeniedException");
    });

    it("throws when Secrets Manager returns empty SecretString", async () => {
      mockSecretsSend.mockReset();
      mockSecretsSend.mockResolvedValueOnce({ SecretString: undefined });
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow(/Secret value is empty/);
    });

    it("rejects when the HTTP request emits an error", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));

      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        end: jest.fn(),
        writable: true,
        writableEnded: false,
      });
      (request.end as jest.Mock).mockImplementation(() => {
        setImmediate(() => request.emit("error", new Error("ECONNREFUSED")));
      });
      (https.request as jest.Mock).mockImplementationOnce(() => request);

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow("ECONNREFUSED");
    });

    it("destroys the request and rejects on timeout", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));

      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        destroy: jest.fn((err: Error) => setImmediate(() => request.emit("error", err))),
        end: jest.fn(),
        setTimeout: jest.fn((_ms: number, cb: () => void) => cb()),
        writable: true,
        writableEnded: false,
      });
      (https.request as jest.Mock).mockImplementationOnce(() => request);

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow(/timeout/i);

      expect(request.destroy).toHaveBeenCalledWith(expect.any(Error));
    });

    it("treats a missing HTTP status code as 0 and throws", async () => {
      mockS3Send.mockResolvedValueOnce(s3GetResponse("x"));

      const response = Object.assign(new EventEmitter(), { statusCode: undefined });
      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        end: jest.fn(() => {
          setImmediate(() => {
            response.emit("data", Buffer.from(""));
            response.emit("end");
          });
        }),
        writable: true,
        writableEnded: false,
      });
      (https.request as jest.Mock).mockImplementationOnce(
        (_opts: unknown, cb: (res: unknown) => void) => {
          cb(response);
          return request;
        },
      );

      await expect(
        handler(makeEvent({ bucket: "b", key: "file.txt", size: 1 }), {} as any),
      ).rejects.toThrow(/→ 0:/);
    });
  });

  afterAll(async () => {
    await flush();
  });
});
