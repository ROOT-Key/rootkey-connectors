// Streaming multipart upload to the ROOTKey API.
//
// The Worker reads the R2 object as a ReadableStream (via the R2 binding — no
// HTTP egress from R2 since it's in-cluster) and pipes it through a multipart
// envelope without buffering the file content in Worker memory. This is what
// lets us safely handle the configured 500 MiB ceiling on the Workers paid plan.

export interface UploadConfig {
  apiUrl: string;
  apiKey: string;
}

export interface SourceMetadata {
  bucket: string;
  key: string;
  eTag?: string;
}

export interface UploadResult {
  status: number;
  responseBody: string;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 255);
}

function normalizeEtag(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/^"|"$/g, "");
}

export async function uploadFileToRootkey(
  config: UploadConfig,
  meta: SourceMetadata,
  body: ReadableStream<Uint8Array>,
  contentLength: number,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const filename = sanitizeFilename(meta.key.split("/").pop() || "file");
  const boundary = `----ROOTKey${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();

  const headerPart = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footerPart = encoder.encode(`\r\n--${boundary}--\r\n`);
  const totalLength = headerPart.byteLength + contentLength + footerPart.byteLength;

  // Wrap the R2 body in a TransformStream that prepends the multipart header
  // and appends the boundary footer. pipeTo automatically propagates cancellation
  // back to the R2 body if fetch cancels the upload — no manual leak handling.
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(headerPart);
    },
    flush(controller) {
      controller.enqueue(footerPart);
    },
  });
  body.pipeTo(transformer.writable).catch(() => {
    // pipeTo rejects when the destination is cancelled — that path already
    // cancels the source as a side-effect, so there's nothing to clean up.
  });
  const combinedStream = transformer.readable;

  const eTag = normalizeEtag(meta.eTag);
  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(totalLength),
    "x-rootkey-source-bucket": meta.bucket,
    "x-rootkey-source-key": meta.key,
  };
  if (eTag) headers["x-rootkey-source-etag"] = eTag;

  const url = `${config.apiUrl}/api-v1/files/`;
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body: combinedStream,
    // `duplex: "half"` is required for fetch() with a ReadableStream body in
    // Workers / undici-based runtimes. Without it the runtime throws.
    duplex: "half",
  };
  if (signal) init.signal = signal;

  const res = await fetch(url, init);
  const responseBody = await res.text();
  return { status: res.status, responseBody };
}
