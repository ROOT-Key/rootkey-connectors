import * as https from "https";
import { EventEmitter } from "events";
import { Readable } from "stream";

jest.mock("https");

import { uploadFileToRootkey, sanitizeFilename } from "./rootkey";

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
    writable: true,
    writableEnded: false,
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sends multipart body with correct headers", async () => {
    const req = setupHttpMock(201, '{"id":"abc"}');
    const result = await uploadFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "test-key" },
      { driveId: "drive-1", itemId: "item-9", fileName: "doc.pdf", eTag: "etag-9" },
      Readable.from([Buffer.from("hello")]),
      5,
    );

    expect(result.status).toBe(201);
    expect(result.responseBody).toBe('{"id":"abc"}');

    const combined = Buffer.concat(req.writes).toString();
    expect(combined).toContain('filename="doc.pdf"');
    expect(combined).toContain("hello");

    const headers = req.options.headers as Record<string, string | number>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-rootkey-source-drive-id"]).toBe("drive-1");
    expect(headers["x-rootkey-source-item-id"]).toBe("item-9");
    expect(headers["x-rootkey-source-etag"]).toBe("etag-9");
    expect(String(headers["Content-Type"])).toMatch(/^multipart\/form-data; boundary=----ROOTKey/);
  });

  it("omits etag header when not provided", async () => {
    const req = setupHttpMock(200, "ok");
    await uploadFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      { driveId: "d", itemId: "i", fileName: "f.txt" },
      Readable.from([Buffer.from("x")]),
      1,
    );
    const headers = req.options.headers as Record<string, string | number>;
    expect(headers["x-rootkey-source-etag"]).toBeUndefined();
  });

  it("rejects on request error", async () => {
    const request = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      end: jest.fn(() => setImmediate(() => request.emit("error", new Error("ECONNREFUSED")))),
      writable: true,
      writableEnded: false,
    });
    (https.request as jest.Mock).mockImplementationOnce(() => request);

    await expect(
      uploadFileToRootkey(
        { apiUrl: "https://api.test", apiKey: "k" },
        { driveId: "d", itemId: "i", fileName: "f.txt" },
        Readable.from([Buffer.from("x")]),
        1,
      ),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("destroys the request and rejects on timeout", async () => {
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
      uploadFileToRootkey(
        { apiUrl: "https://api.test", apiKey: "k" },
        { driveId: "d", itemId: "i", fileName: "f.txt" },
        Readable.from([Buffer.from("x")]),
        1,
      ),
    ).rejects.toThrow(/timeout/i);

    expect(request.destroy).toHaveBeenCalled();
  });

  it("treats missing status code as 0", async () => {
    const response = Object.assign(new EventEmitter(), { statusCode: undefined });
    const request = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      end: jest.fn(() => {
        setImmediate(() => {
          response.emit("data", Buffer.from("x"));
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

    const result = await uploadFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      { driveId: "d", itemId: "i", fileName: "f.txt" },
      Readable.from([Buffer.from("x")]),
      1,
    );
    expect(result.status).toBe(0);
  });
});
