import * as https from "https";
import * as crypto from "crypto";
import { Readable } from "stream";

export interface UploadConfig {
  apiUrl: string;
  apiKey: string;
}

export interface SourceMetadata {
  driveId: string;
  itemId: string;
  fileName: string;
  eTag?: string;
}

export interface UploadResult {
  status: number;
  responseBody: string;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 255);
}

export function uploadFileToRootkey(
  config: UploadConfig,
  meta: SourceMetadata,
  bodyStream: Readable,
  contentLength: number,
): Promise<UploadResult> {
  const filename = sanitizeFilename(meta.fileName);
  const boundary = `----ROOTKey${crypto.randomBytes(16).toString("hex")}`;

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
  const totalLength = headerPart.length + contentLength + footerPart.length;

  const url = new URL(`${config.apiUrl}/api-v1/files/`);

  return new Promise<UploadResult>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": totalLength,
          "x-rootkey-source-drive-id": meta.driveId,
          "x-rootkey-source-item-id": meta.itemId,
          ...(meta.eTag ? { "x-rootkey-source-etag": meta.eTag } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );

    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("Request timeout")));

    req.write(headerPart);
    bodyStream.on("error", (err) => req.destroy(err));
    bodyStream.on("end", () => {
      req.write(footerPart);
      req.end();
    });
    bodyStream.pipe(req, { end: false });
  });
}
