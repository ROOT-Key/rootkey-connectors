import { Readable } from "stream";

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
}

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  file?: { mimeType?: string };
  folder?: object;
  deleted?: object;
  eTag?: string;
  parentReference?: { id?: string; path?: string };
}

export interface DeltaResult {
  items: DriveItem[];
  nextLink?: string;
  deltaLink?: string;
}

export interface SubscriptionMetadata {
  id: string;
  expirationDateTime: string;
  clientState?: string;
}

export class SubscriptionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionGoneError";
  }
}

// Microsoft Graph limit for driveItem subscriptions: ~4230 minutes (< 3 days).
// We renew 30 minutes before that, every 12 hours, to stay well within bounds.
const MAX_SUBSCRIPTION_MINUTES = 4230;
const RENEWAL_SAFETY_MARGIN_MINUTES = 30;

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

export function __resetTokenCacheForTesting(): void {
  cachedToken = undefined;
}

async function getAccessToken(cfg: GraphConfig): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const url = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

export async function deltaQuery(cfg: GraphConfig, urlOrToken?: string): Promise<DeltaResult> {
  const token = await getAccessToken(cfg);
  let url: string;
  if (!urlOrToken) {
    url = `https://graph.microsoft.com/v1.0/drives/${cfg.driveId}/root/delta`;
  } else if (urlOrToken.startsWith("https://")) {
    url = urlOrToken;
  } else {
    url = `https://graph.microsoft.com/v1.0/drives/${cfg.driveId}/root/delta?token=${encodeURIComponent(urlOrToken)}`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Delta query failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    value: DriveItem[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };
  return {
    items: data.value ?? [],
    nextLink: data["@odata.nextLink"],
    deltaLink: data["@odata.deltaLink"],
  };
}

export async function getItem(cfg: GraphConfig, itemId: string): Promise<DriveItem | undefined> {
  const token = await getAccessToken(cfg);
  const url = `https://graph.microsoft.com/v1.0/drives/${cfg.driveId}/items/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Get item failed for ${itemId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DriveItem;
}

export async function downloadFile(
  cfg: GraphConfig,
  itemId: string,
): Promise<{ stream: Readable; size: number }> {
  const token = await getAccessToken(cfg);
  const url = `https://graph.microsoft.com/v1.0/drives/${cfg.driveId}/items/${itemId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`File download failed for ${itemId}: ${res.status} ${await res.text()}`);
  }
  if (!res.body) {
    throw new Error(`Empty response body downloading ${itemId}`);
  }
  const lengthHeader = res.headers.get("content-length");
  const size = lengthHeader ? Number(lengthHeader) : 0;
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  return { stream, size };
}

export async function createSubscription(
  cfg: GraphConfig,
  params: { notificationUrl: string; clientState: string },
): Promise<SubscriptionMetadata> {
  const token = await getAccessToken(cfg);
  const expiration = new Date(
    Date.now() + (MAX_SUBSCRIPTION_MINUTES - RENEWAL_SAFETY_MARGIN_MINUTES) * 60_000,
  ).toISOString();
  const body = {
    changeType: "updated",
    notificationUrl: params.notificationUrl,
    resource: `/drives/${cfg.driveId}/root`,
    expirationDateTime: expiration,
    clientState: params.clientState,
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Create subscription failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as SubscriptionMetadata;
}

export async function renewSubscription(
  cfg: GraphConfig,
  subscriptionId: string,
): Promise<SubscriptionMetadata> {
  const token = await getAccessToken(cfg);
  const expiration = new Date(
    Date.now() + (MAX_SUBSCRIPTION_MINUTES - RENEWAL_SAFETY_MARGIN_MINUTES) * 60_000,
  ).toISOString();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expirationDateTime: expiration }),
    },
  );
  if (res.status === 404) {
    throw new SubscriptionGoneError(`Subscription ${subscriptionId} no longer exists`);
  }
  if (!res.ok) {
    throw new Error(`Renew subscription failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as SubscriptionMetadata;
}
