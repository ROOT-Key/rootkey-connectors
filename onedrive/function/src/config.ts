import type { GraphConfig } from "./graph";

export interface Config {
  graph: GraphConfig;
  rootkeyApiUrl: string;
  rootkeyApiKey: string;
  webhookClientState: string;
  stateStorageAccount: string;
  stateContainerName: string;
  dlqQueueName: string;
  uamiClientId?: string;
  maxFileSizeBytes: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const apiUrl = requireEnv("ROOTKEY_API_URL").replace(/\/$/, "");
  if (!apiUrl.startsWith("https://")) {
    throw new Error("ROOTKEY_API_URL must use https://");
  }
  return {
    graph: {
      tenantId: requireEnv("GRAPH_TENANT_ID"),
      clientId: requireEnv("GRAPH_CLIENT_ID"),
      clientSecret: requireEnv("GRAPH_CLIENT_SECRET"),
      driveId: requireEnv("GRAPH_DRIVE_ID"),
    },
    rootkeyApiUrl: apiUrl,
    rootkeyApiKey: requireEnv("ROOTKEY_API_KEY"),
    webhookClientState: requireEnv("WEBHOOK_CLIENT_STATE"),
    stateStorageAccount: requireEnv("STATE_STORAGE_ACCOUNT"),
    stateContainerName: requireEnv("STATE_CONTAINER_NAME"),
    dlqQueueName: requireEnv("DLQ_QUEUE_NAME"),
    uamiClientId: process.env.UAMI_CLIENT_ID,
    maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 524288000),
  };
}
