import * as https from "https";
import * as crypto from "crypto";
import { Readable } from "stream";

export interface UploadConfig {
  apiUrl: string;
  apiKey: string;
}

// Fields that identify the file in Graph — sent as headers so the backend can
// route/dedupe without parsing the multipart body. Preserved from the earlier
// contract so existing backend logic keeps working.
export interface SourceIdentifiers {
  driveId: string;
  itemId: string;
  fileName: string;
  eTag?: string;
}

// Everything else the connector can extract from Graph — sent as a JSON part
// (`metadata`) alongside the file. Fields are optional; the connector omits
// keys when Graph doesn't return them (e.g. sha256Hash on large files, email
// on app-created content).
export interface EnrichedMetadata {
  cTag?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  sha256Hash?: string;
  webUrl?: string;
  path?: string;
  createdAt?: string;
  lastModifiedAt?: string;
  createdBy?: { id?: string; displayName?: string; email?: string };
  lastModifiedBy?: { id?: string; displayName?: string; email?: string };
}

export interface UploadResult {
  status: number;
  responseBody: string;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 255);
}

// Strip undefined values before JSON.stringify so the wire payload contains
// only fields Graph actually gave us. `JSON.stringify` already drops
// `undefined`, but doing it explicitly makes empty-object handling simpler
// (we don't want to send `metadata: { createdBy: {} }` if all three subfields
// were absent).
function compactMetadata(meta: EnrichedMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const compacted = compactMetadata(value as EnrichedMetadata);
      if (Object.keys(compacted).length > 0) out[key] = compacted;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Upload the file stream + a JSON `metadata` part to the given ROOTKey URL.
 * Wire format is standard multipart/form-data with two parts:
 *   1. `file`  — binary content of the file (streamed from Graph)
 *   2. `metadata` — JSON body with all enriched fields
 *
 * Headers preserved from the pre-v2 contract for backwards compatibility with
 * the backend's routing/dedup logic.
 */
function postMultipart(
  targetUrl: string,
  config: UploadConfig,
  ident: SourceIdentifiers,
  metadata: EnrichedMetadata,
  bodyStream: Readable,
  contentLength: number,
): Promise<UploadResult> {
  const filename = sanitizeFilename(ident.fileName);
  const boundary = `----ROOTKey${crypto.randomBytes(16).toString("hex")}`;

  const metadataJson = JSON.stringify(compactMetadata(metadata));

  const filePartHeader = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const metadataPart = Buffer.from(
    `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      metadataJson,
  );
  const closingBoundary = Buffer.from(`\r\n--${boundary}--\r\n`);

  const totalLength =
    filePartHeader.length + contentLength + metadataPart.length + closingBoundary.length;

  const url = new URL(targetUrl);

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
          "x-rootkey-source-drive-id": ident.driveId,
          "x-rootkey-source-item-id": ident.itemId,
          ...(ident.eTag ? { "x-rootkey-source-etag": ident.eTag } : {}),
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

    req.write(filePartHeader);
    bodyStream.on("error", (err) => req.destroy(err));
    bodyStream.on("end", () => {
      req.write(metadataPart);
      req.write(closingBoundary);
      req.end();
    });
    bodyStream.pipe(req, { end: false });
  });
}

/**
 * Register a brand-new file with ROOTKey. Called when the connector has never
 * uploaded this Graph item before (no entry in the uploaded-items registry).
 * The backend uses `x-rootkey-source-item-id` as the file's persistent PK
 * (`fileId`) and stores this as the first version.
 */
export function uploadNewFileToRootkey(
  config: UploadConfig,
  ident: SourceIdentifiers,
  metadata: EnrichedMetadata,
  bodyStream: Readable,
  contentLength: number,
): Promise<UploadResult> {
  const target = `${config.apiUrl}/api-v1/connectors/files/`;
  return postMultipart(target, config, ident, metadata, bodyStream, contentLength);
}

/**
 * Append a new version to an existing ROOTKey file. Called when the connector
 * has previously uploaded this Graph item AND its cTag has since changed
 * (content mutated). The parentId in the URL is the Graph itemId — same value
 * carried in the `x-rootkey-source-item-id` header, exposed twice by
 * necessity (URL vs header) but semantically identical.
 */
export function uploadVersionToRootkey(
  config: UploadConfig,
  parentId: string,
  ident: SourceIdentifiers,
  metadata: EnrichedMetadata,
  bodyStream: Readable,
  contentLength: number,
): Promise<UploadResult> {
  const target = `${config.apiUrl}/api-v1/connectors/files/${encodeURIComponent(parentId)}/versions`;
  return postMultipart(target, config, ident, metadata, bodyStream, contentLength);
}
