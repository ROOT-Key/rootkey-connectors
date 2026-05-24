import * as https from "https";
import { EventEmitter } from "events";
import type { S3Event } from "aws-lambda";

// Must be set before the module is imported (module-level code reads env vars at import time)
process.env.ROOTKEY_API_KEY = "test-api-key";
process.env.ROOTKEY_API_URL = "https://api.test.rootkey.ai";
process.env.AWS_REGION = "eu-west-1";

// Variables prefixed with "mock" are accessible inside jest.mock factories (Jest hoisting rule)
const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((input: unknown) => input),
}));

jest.mock("https");

import { handler } from "./index";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeS3Body(content: string) {
  return {
    transformToByteArray: () => Promise.resolve(new Uint8Array(Buffer.from(content))),
  };
}

function setupHttpMock(statusCode: number, body: string) {
  const response = Object.assign(new EventEmitter(), { statusCode });
  const request = Object.assign(new EventEmitter(), {
    write: jest.fn(),
    setTimeout: jest.fn(),
    destroy: jest.fn(),
    end: jest.fn(),
  });
  (request.end as jest.Mock).mockImplementation(() => {
    setImmediate(() => {
      response.emit("data", Buffer.from(body));
      response.emit("end");
    });
  });
  (https.request as jest.Mock).mockImplementationOnce(
    (_opts: unknown, cb: (res: unknown) => void) => {
      cb(response);
      return request;
    },
  );
  return request;
}

function makeEvent(records: Array<{ bucket: string; key: string }>): S3Event {
  return {
    Records: records.map((r) => ({
      s3: { bucket: { name: r.bucket }, object: { key: r.key } },
    })),
  } as S3Event;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("happy path", () => {
    it("uploads a file and sends the correct multipart body", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("hello world") });
      const req = setupHttpMock(201, '{"id":"abc123"}');

      await handler(makeEvent([{ bucket: "my-bucket", key: "docs/report.pdf" }]), {} as any);

      expect(mockS3Send).toHaveBeenCalledTimes(1);

      const written: string = (req.write as jest.Mock).mock.calls[0][0].toString();
      expect(written).toContain('filename="report.pdf"');
      expect(written).toContain("hello world");
      expect(written).toContain("Content-Type: application/octet-stream");
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("201"));
    });

    it("processes multiple records in a single event", async () => {
      mockS3Send.mockResolvedValue({ Body: makeS3Body("content") });
      setupHttpMock(200, "ok");
      setupHttpMock(200, "ok");
      setupHttpMock(200, "ok");

      await handler(
        makeEvent([
          { bucket: "b", key: "a.txt" },
          { bucket: "b", key: "b.txt" },
          { bucket: "b", key: "c.txt" },
        ]),
        {} as any,
      );

      expect(mockS3Send).toHaveBeenCalledTimes(3);
      expect(console.log).toHaveBeenCalledTimes(3);
    });
  });

  describe("edge cases", () => {
    it("decodes percent-encoded characters in S3 keys", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });
      const req = setupHttpMock(200, "ok");

      await handler(makeEvent([{ bucket: "b", key: "uploads/my%20file%20name.txt" }]), {} as any);

      const written: string = (req.write as jest.Mock).mock.calls[0][0].toString();
      expect(written).toContain('filename="my file name.txt"');
    });

    it("decodes + signs as spaces in S3 keys", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });
      const req = setupHttpMock(200, "ok");

      await handler(makeEvent([{ bucket: "b", key: "uploads/my+file+name.txt" }]), {} as any);

      const written: string = (req.write as jest.Mock).mock.calls[0][0].toString();
      expect(written).toContain('filename="my file name.txt"');
    });

    it("extracts the filename from a deeply nested S3 key", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });
      const req = setupHttpMock(200, "ok");

      await handler(
        makeEvent([{ bucket: "b", key: "a/b/c/d/deep-file.csv" }]),
        {} as any,
      );

      const written: string = (req.write as jest.Mock).mock.calls[0][0].toString();
      expect(written).toContain('filename="deep-file.csv"');
    });
  });

  describe("error cases", () => {
    it("logs error on non-2xx response and does not throw", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });
      setupHttpMock(403, "Forbidden");

      await expect(
        handler(makeEvent([{ bucket: "b", key: "file.txt" }]), {} as any),
      ).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("403"));
    });

    it("logs S3 error and continues processing remaining records", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("AccessDenied"));
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("second file") });
      const req = setupHttpMock(200, "ok");

      await handler(
        makeEvent([
          { bucket: "b", key: "denied.txt" },
          { bucket: "b", key: "allowed.txt" },
        ]),
        {} as any,
      );

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("denied.txt"),
        expect.any(Error),
      );
      expect(req.write as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it("logs network error and does not throw", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });

      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        end: jest.fn(),
      });
      (request.end as jest.Mock).mockImplementation(() => {
        setImmediate(() => request.emit("error", new Error("ECONNREFUSED")));
      });
      (https.request as jest.Mock).mockImplementationOnce(() => request);

      await expect(
        handler(makeEvent([{ bucket: "b", key: "file.txt" }]), {} as any),
      ).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("file.txt"),
        expect.any(Error),
      );
    });

    it("destroys the request and rejects on timeout", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });

      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        destroy: jest.fn(),
        end: jest.fn(),
        // Immediately invoke the timeout callback so the path is exercised
        setTimeout: jest.fn((_ms: number, cb: () => void) => cb()),
      });
      (request.destroy as jest.Mock).mockImplementation((err: Error) => {
        setImmediate(() => request.emit("error", err));
      });
      (https.request as jest.Mock).mockImplementationOnce(() => request);

      await expect(
        handler(makeEvent([{ bucket: "b", key: "file.txt" }]), {} as any),
      ).resolves.toBeUndefined();

      expect(request.destroy).toHaveBeenCalledWith(expect.any(Error));
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("file.txt"),
        expect.any(Error),
      );
    });

    it("treats a missing HTTP status code as 0", async () => {
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("x") });

      const response = Object.assign(new EventEmitter(), { statusCode: undefined });
      const request = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        end: jest.fn(),
      });
      (request.end as jest.Mock).mockImplementation(() => {
        setImmediate(() => {
          response.emit("data", Buffer.from(""));
          response.emit("end");
        });
      });
      (https.request as jest.Mock).mockImplementationOnce(
        (_opts: unknown, cb: (res: unknown) => void) => {
          cb(response);
          return request;
        },
      );

      await expect(
        handler(makeEvent([{ bucket: "b", key: "file.txt" }]), {} as any),
      ).resolves.toBeUndefined();

      // status 0 is not >= 200, so it logs as an error
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("0"));
    });

    it("processes all records even when multiple fail in sequence", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("fail"));
      mockS3Send.mockRejectedValueOnce(new Error("fail"));
      mockS3Send.mockResolvedValueOnce({ Body: makeS3Body("ok") });
      setupHttpMock(200, "ok");

      await handler(
        makeEvent([
          { bucket: "b", key: "a.txt" },
          { bucket: "b", key: "b.txt" },
          { bucket: "b", key: "c.txt" },
        ]),
        {} as any,
      );

      expect(mockS3Send).toHaveBeenCalledTimes(3);
      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledTimes(1);
    });
  });
});
