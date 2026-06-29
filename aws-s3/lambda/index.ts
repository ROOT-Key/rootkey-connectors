import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { Context } from "aws-lambda";
import { Readable } from "stream";
import * as https from "https";
import * as crypto from "crypto";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION });

const ROOTKEY_API_URL = process.env.ROOTKEY_API_URL!.replace(/\/$/, "");
const ROOTKEY_API_KEY_SECRET_ARN = process.env.ROOTKEY_API_KEY_SECRET_ARN!;
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES ?? 524288000);

if (!ROOTKEY_API_URL.startsWith("https://")) {
  throw new Error("ROOTKEY_API_URL must use https://");
}

let cachedApiKey: string | undefined;

export function __resetCacheForTesting(): void {
  cachedApiKey = undefined;
}

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: ROOTKEY_API_KEY_SECRET_ARN }),
  );
  const value = res.SecretString;
  if (!value) throw new Error("Secret value is empty");
  cachedApiKey = value;
  return value;
}

interface S3ObjectCreatedEvent {
  source: string;
  "detail-type": string;
  detail: {
    bucket: { name: string };
    object: {
      key: string;
      size: number;
      etag: string;
      "version-id"?: string;
      sequencer?: string;
    };
  };
}

export async function handler(event: S3ObjectCreatedEvent, _context: Context): Promise<void> {
  if (event.source !== "aws.s3" || event["detail-type"] !== "Object Created") {
    console.warn(`Ignoring event: source=${event.source} detail-type=${event["detail-type"]}`);
    return;
  }

  const bucket = event.detail.bucket.name;
  const key = event.detail.object.key;
  const size = event.detail.object.size;
  const etag = event.detail.object.etag;
  const versionId = event.detail.object["version-id"];

  try {
    await processObject(bucket, key, size, etag, versionId);
  } catch (err) {
    console.error(`ERROR processing s3://${bucket}/${key}:`, err);
    throw err;
  }
}

async function processObject(
  bucket: string,
  key: string,
  size: number,
  etag: string,
  versionId: string | undefined,
): Promise<void> {
  if (size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Object size ${size} exceeds MAX_FILE_SIZE_BYTES=${MAX_FILE_SIZE_BYTES}. Skipping s3://${bucket}/${key}.`,
    );
  }

  let resolvedSize = size;
  if (resolvedSize === 0) {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    );
    resolvedSize = head.ContentLength ?? 0;
    if (resolvedSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Object size ${resolvedSize} exceeds MAX_FILE_SIZE_BYTES=${MAX_FILE_SIZE_BYTES}. Skipping s3://${bucket}/${key}.`,
      );
    }
  }

  const getResponse = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
  );
  const bodyStream = getResponse.Body as Readable | undefined;
  if (!bodyStream) throw new Error("S3 GetObject returned empty body");

  const apiKey = await getApiKey();
  const filename = sanitizeFilename(key.split("/").pop() || "file");
  const boundary = `----ROOTKey${crypto.randomBytes(16).toString("hex")}`;

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = headerPart.length + resolvedSize + footerPart.length;

  const url = new URL(`${ROOTKEY_API_URL}/api-v1/files/`);
  const { status, responseBody } = await streamUpload({
    url,
    apiKey,
    boundary,
    headerPart,
    footerPart,
    bodyStream,
    contentLength,
    metadata: {
      "x-rootkey-source-bucket": bucket,
      "x-rootkey-source-key": key,
      "x-rootkey-source-etag": etag,
      ...(versionId ? { "x-rootkey-source-version-id": versionId } : {}),
    },
  });

  if (status >= 200 && status < 300) {
    console.log(`Uploaded s3://${bucket}/${key} → ${status}: ${responseBody}`);
  } else {
    throw new Error(`Upload failed s3://${bucket}/${key} → ${status}: ${responseBody}`);
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 255);
}

interface StreamUploadInput {
  url: URL;
  apiKey: string;
  boundary: string;
  headerPart: Buffer;
  footerPart: Buffer;
  bodyStream: Readable;
  contentLength: number;
  metadata: Record<string, string>;
}

function streamUpload(
  input: StreamUploadInput,
): Promise<{ status: number; responseBody: string }> {
  const { url, apiKey, boundary, headerPart, footerPart, bodyStream, contentLength, metadata } =
    input;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": contentLength,
          ...metadata,
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
