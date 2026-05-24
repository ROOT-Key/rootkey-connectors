import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Event, Context } from "aws-lambda";
import * as https from "https";
import * as http from "http";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const ROOTKEY_API_KEY = process.env.ROOTKEY_API_KEY!;
const ROOTKEY_API_URL = process.env.ROOTKEY_API_URL!.replace(/\/$/, "");

export async function handler(event: S3Event, _context: Context): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    try {
      await processObject(bucket, key);
    } catch (err) {
      console.error(`ERROR processing s3://${bucket}/${key}:`, err);
    }
  }
}

async function processObject(bucket: string, key: string): Promise<void> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const fileBytes = await response.Body!.transformToByteArray();
  const fileBody = Buffer.from(fileBytes);
  const filename = key.split("/").pop()!;

  const boundary = "----ROOTKeyBoundary";
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, fileBody, epilogue]);

  const url = new URL(`${ROOTKEY_API_URL}/api-v1/files/`);
  const { status, responseBody } = await upload(url, body, boundary);

  if (status >= 200 && status < 300) {
    console.log(`Uploaded s3://${bucket}/${key} → ${status}: ${responseBody}`);
  } else {
    console.error(`Upload failed s3://${bucket}/${key} → ${status}: ${responseBody}`);
  }
}

function upload(
  url: URL,
  body: Buffer,
  boundary: string,
): Promise<{ status: number; responseBody: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "x-api-key": ROOTKEY_API_KEY,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
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
    req.setTimeout(30_000, () => req.destroy(new Error("Request timeout")));
    req.write(body);
    req.end();
  });
}
