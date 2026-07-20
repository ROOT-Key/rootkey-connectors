import * as https from "https";
import { EventEmitter } from "events";
import { Readable } from "stream";

jest.mock("https");

import {
  uploadNewFileToRootkey,
  uploadVersionToRootkey,
  sanitizeFilename,
} from "./rootkey";

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

describe("uploadNewFileToRootkey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("POSTs to /api-v1/connectors/files/ with headers, file part and metadata JSON part", async () => {
    const req = setupHttpMock(201, '{"id":"abc"}');
    const result = await uploadNewFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "test-key" },
      { driveId: "drive-1", itemId: "item-9", fileName: "doc.pdf", eTag: "etag-9" },
      {
        cTag: "cta g-1",
        webUrl: "https://sp.example/doc.pdf",
        createdBy: { id: "u1", displayName: "Alice", email: "alice@ex.com" },
        lastModifiedBy: { id: "u2", displayName: "Bob", email: "bob@ex.com" },
        createdAt: "2026-07-01T10:00:00Z",
        lastModifiedAt: "2026-07-03T15:30:00Z",
        sha256Hash: "abc123",
        path: "/drives/drive-1/root:/reports",
      },
      Readable.from([Buffer.from("hello")]),
      5,
    );

    expect(result.status).toBe(201);
    expect(result.responseBody).toBe('{"id":"abc"}');

    // URL: new file endpoint
    expect(req.options.path).toBe("/api-v1/connectors/files/");

    // Headers preserved from the pre-v2 contract
    const headers = req.options.headers as Record<string, string | number>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-rootkey-source-drive-id"]).toBe("drive-1");
    expect(headers["x-rootkey-source-item-id"]).toBe("item-9");
    expect(headers["x-rootkey-source-etag"]).toBe("etag-9");
    expect(String(headers["Content-Type"])).toMatch(/^multipart\/form-data; boundary=----ROOTKey/);

    // Body has both parts
    const combined = Buffer.concat(req.writes).toString();
    expect(combined).toContain('filename="doc.pdf"');
    expect(combined).toContain("hello");
    expect(combined).toContain('name="metadata"');
    expect(combined).toContain("Content-Type: application/json");

    // Metadata JSON has the enriched fields
    const metadataMatch = combined.match(/Content-Type: application\/json\r\n\r\n(\{[^]*?\})\r\n--/);
    expect(metadataMatch).not.toBeNull();
    const parsed = JSON.parse(metadataMatch![1]);
    expect(parsed.cTag).toBe("cta g-1");
    expect(parsed.webUrl).toBe("https://sp.example/doc.pdf");
    expect(parsed.createdBy).toEqual({ id: "u1", displayName: "Alice", email: "alice@ex.com" });
    expect(parsed.lastModifiedBy).toEqual({ id: "u2", displayName: "Bob", email: "bob@ex.com" });
    expect(parsed.sha256Hash).toBe("abc123");
    expect(parsed.path).toBe("/drives/drive-1/root:/reports");
  });

  it("omits absent metadata fields (does not send nulls)", async () => {
    const req = setupHttpMock(200, "ok");
    await uploadNewFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      { driveId: "d", itemId: "i", fileName: "f.txt" },
      // Only cTag present; createdBy, hashes, etc. missing entirely.
      { cTag: "c1" },
      Readable.from([Buffer.from("x")]),
      1,
    );
    const combined = Buffer.concat(req.writes).toString();
    const metadataMatch = combined.match(/Content-Type: application\/json\r\n\r\n(\{[^]*?\})\r\n--/);
    const parsed = JSON.parse(metadataMatch![1]);
    expect(parsed).toEqual({ cTag: "c1" });
    expect(parsed.createdBy).toBeUndefined();
    expect(parsed.sha256Hash).toBeUndefined();
  });

  it("omits etag header when not provided", async () => {
    const req = setupHttpMock(200, "ok");
    await uploadNewFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      { driveId: "d", itemId: "i", fileName: "f.txt" },
      {},
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
      uploadNewFileToRootkey(
        { apiUrl: "https://api.test", apiKey: "k" },
        { driveId: "d", itemId: "i", fileName: "f.txt" },
        {},
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
      uploadNewFileToRootkey(
        { apiUrl: "https://api.test", apiKey: "k" },
        { driveId: "d", itemId: "i", fileName: "f.txt" },
        {},
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

    const result = await uploadNewFileToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      { driveId: "d", itemId: "i", fileName: "f.txt" },
      {},
      Readable.from([Buffer.from("x")]),
      1,
    );
    expect(result.status).toBe(0);
  });
});

describe("uploadVersionToRootkey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("POSTs to /api-v1/connectors/files/{parentId}/versions with the enriched metadata JSON part", async () => {
    const req = setupHttpMock(200, '{"versionId":"v2"}');
    const result = await uploadVersionToRootkey(
      { apiUrl: "https://api.test", apiKey: "test-key" },
      "item-9", // parentId = Graph itemId
      { driveId: "drive-1", itemId: "item-9", fileName: "doc.pdf", eTag: "etag-42" },
      { cTag: "cta g-2", lastModifiedAt: "2026-07-03T18:00:00Z" },
      Readable.from([Buffer.from("world")]),
      5,
    );

    expect(result.status).toBe(200);
    // parentId in URL — encoded because Graph itemIds contain characters
    // that require URL escaping (`!`, `:`, etc.) even though we assert with a
    // plain alphanumeric ID here.
    expect(req.options.path).toBe("/api-v1/connectors/files/item-9/versions");

    // Same header contract as the /files/ endpoint
    const headers = req.options.headers as Record<string, string | number>;
    expect(headers["x-rootkey-source-item-id"]).toBe("item-9");
    expect(headers["x-rootkey-source-etag"]).toBe("etag-42");

    const combined = Buffer.concat(req.writes).toString();
    expect(combined).toContain('name="file"');
    expect(combined).toContain('name="metadata"');
    const metadataMatch = combined.match(/Content-Type: application\/json\r\n\r\n(\{[^]*?\})\r\n--/);
    const parsed = JSON.parse(metadataMatch![1]);
    expect(parsed.cTag).toBe("cta g-2");
    expect(parsed.lastModifiedAt).toBe("2026-07-03T18:00:00Z");
  });

  it("URL-encodes parentId with special characters", async () => {
    const req = setupHttpMock(200, "ok");
    await uploadVersionToRootkey(
      { apiUrl: "https://api.test", apiKey: "k" },
      "01ABC!:XYZ", // characters requiring URL escaping
      { driveId: "d", itemId: "01ABC!:XYZ", fileName: "f.txt" },
      {},
      Readable.from([Buffer.from("x")]),
      1,
    );
    expect(req.options.path).toBe("/api-v1/connectors/files/01ABC!%3AXYZ/versions");
  });
});
