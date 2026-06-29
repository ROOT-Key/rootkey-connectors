// The Env interface mirrors the bindings declared in main.tf / wrangler.toml.
// The R2Bucket binding type comes from @cloudflare/workers-types and is the
// canonical way to read R2 objects from inside a Worker (no HTTP egress involved).
export interface Env {
  ROOTKEY_API_URL: string;
  ROOTKEY_API_KEY: string;
  MAX_FILE_SIZE_BYTES?: string;
  BUCKET: R2Bucket;
}

export interface ResolvedConfig {
  rootkeyApiUrl: string;
  rootkeyApiKey: string;
  maxFileSizeBytes: number;
}

const DEFAULT_MAX_FILE_SIZE = 524_288_000; // 500 MiB

export function loadConfig(env: Env): ResolvedConfig {
  const apiUrl = (env.ROOTKEY_API_URL ?? "").trim().replace(/\/$/, "");
  if (!apiUrl) {
    throw new Error("ROOTKEY_API_URL env var is required");
  }
  if (!apiUrl.startsWith("https://")) {
    throw new Error("ROOTKEY_API_URL must use https://");
  }
  const apiKey = (env.ROOTKEY_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("ROOTKEY_API_KEY env var is required");
  }

  let maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE;
  if (env.MAX_FILE_SIZE_BYTES !== undefined && env.MAX_FILE_SIZE_BYTES !== "") {
    const parsed = Number(env.MAX_FILE_SIZE_BYTES);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`MAX_FILE_SIZE_BYTES must be a positive number, got ${env.MAX_FILE_SIZE_BYTES}`);
    }
    maxFileSizeBytes = Math.floor(parsed);
  }

  return { rootkeyApiUrl: apiUrl, rootkeyApiKey: apiKey, maxFileSizeBytes };
}
