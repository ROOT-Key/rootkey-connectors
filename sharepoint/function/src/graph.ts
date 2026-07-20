import { Readable } from "stream";

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface SiteRef {
  id: string;
  hostname: string;
  serverRelativePath: string;
}

export interface DriveRef {
  id: string;
  name: string;
}

export interface IdentitySet {
  user?: { id?: string; displayName?: string; email?: string };
}

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  file?: {
    mimeType?: string;
    // hashes is included by default when Graph returns `file`; the fields
    // populated depend on the drive type (sha256Hash on SharePoint/OneDrive
    // for Business; quickXorHash on personal OneDrive).
    hashes?: { quickXorHash?: string; sha256Hash?: string; crc32Hash?: string };
  };
  folder?: object;
  deleted?: object;
  eTag?: string;
  // cTag mutates only on content changes (not renames or metadata edits) — used
  // as the version discriminator when deciding whether to POST a new version to
  // ROOTKey. See index.ts:processFile for the routing decision.
  cTag?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  createdBy?: IdentitySet;
  lastModifiedBy?: IdentitySet;
  parentReference?: { id?: string; path?: string; driveId?: string };
}

// Fields the connector wants Graph to return on delta and get-item calls. Kept
// as a single constant so delta and getItem stay in sync — adding a field here
// exposes it everywhere. The default Graph projection also includes these, but
// making $select explicit is (a) forward-compatible if Graph ever trims defaults
// and (b) self-documenting for readers.
const DRIVE_ITEM_SELECT = [
  "id",
  "name",
  "size",
  "file",
  "folder",
  "deleted",
  "eTag",
  "cTag",
  "webUrl",
  "createdDateTime",
  "lastModifiedDateTime",
  "createdBy",
  "lastModifiedBy",
  "parentReference",
].join(",");

export interface DeltaResult {
  items: DriveItem[];
  nextLink?: string;
  deltaLink?: string;
}

export interface SubscriptionMetadata {
  id: string;
  expirationDateTime: string;
  clientState?: string;
  resource?: string;
}

export class SubscriptionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionGoneError";
  }
}

// Microsoft Graph limit for driveItem subscriptions: ~4230 minutes (< 3 days).
// We renew 30 minutes before that; the renewal timer runs hourly so the actual
// gap is at most 1 hour, well within the safety margin.
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

async function getAccessToken(cfg: GraphCredentials): Promise<string> {
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

export function parseSiteUrl(siteUrl: string): { hostname: string; serverRelativePath: string } {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error(`Invalid site_url: ${siteUrl}`);
  }
  if (!parsed.hostname.endsWith(".sharepoint.com")) {
    throw new Error(`Expected a *.sharepoint.com hostname, got ${parsed.hostname}`);
  }
  const path = parsed.pathname.replace(/\/$/, "");
  return {
    hostname: parsed.hostname,
    serverRelativePath: path === "" ? "/" : path,
  };
}

export async function resolveSite(cfg: GraphCredentials, siteUrl: string): Promise<SiteRef> {
  const { hostname, serverRelativePath } = parseSiteUrl(siteUrl);
  const token = await getAccessToken(cfg);
  // Graph syntax: /sites/{hostname}:/{server-relative-path} (or :/ for root).
  const graphPath =
    serverRelativePath === "/" ? `/sites/${hostname}` : `/sites/${hostname}:${serverRelativePath}`;
  const url = `https://graph.microsoft.com/v1.0${graphPath}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Site lookup failed for ${siteUrl}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return { id: data.id, hostname, serverRelativePath };
}

export async function listDrives(cfg: GraphCredentials, siteId: string): Promise<DriveRef[]> {
  const token = await getAccessToken(cfg);
  const drives: DriveRef[] = [];
  let url: string | undefined = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drives`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`List drives failed for site ${siteId}: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      value: Array<{ id: string; name: string }>;
      "@odata.nextLink"?: string;
    };
    for (const d of data.value) drives.push({ id: d.id, name: d.name });
    url = data["@odata.nextLink"];
  }
  return drives;
}

export async function deltaQuery(
  cfg: GraphCredentials,
  driveId: string,
  urlOrToken?: string,
): Promise<DeltaResult> {
  const token = await getAccessToken(cfg);
  let url: string;
  if (!urlOrToken) {
    url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/delta?$select=${DRIVE_ITEM_SELECT}`;
  } else if (urlOrToken.startsWith("https://")) {
    // Continuation link (nextLink/deltaLink) already carries the $select from
    // the initial request — Graph preserves query params across delta paging.
    url = urlOrToken;
  } else {
    url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/delta?token=${encodeURIComponent(urlOrToken)}&$select=${DRIVE_ITEM_SELECT}`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Delta query failed for drive ${driveId}: ${res.status} ${await res.text()}`);
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

export async function getItem(
  cfg: GraphCredentials,
  driveId: string,
  itemId: string,
): Promise<DriveItem | undefined> {
  const token = await getAccessToken(cfg);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${encodeURIComponent(itemId)}?$select=${DRIVE_ITEM_SELECT}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Get item failed for ${itemId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DriveItem;
}

export async function downloadFile(
  cfg: GraphCredentials,
  driveId: string,
  itemId: string,
): Promise<{ stream: Readable; size: number }> {
  const token = await getAccessToken(cfg);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
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
  cfg: GraphCredentials,
  params: { driveId: string; notificationUrl: string; clientState: string },
): Promise<SubscriptionMetadata> {
  const token = await getAccessToken(cfg);
  const expiration = new Date(
    Date.now() + (MAX_SUBSCRIPTION_MINUTES - RENEWAL_SAFETY_MARGIN_MINUTES) * 60_000,
  ).toISOString();
  const body = {
    changeType: "updated",
    notificationUrl: params.notificationUrl,
    resource: `/drives/${params.driveId}/root`,
    expirationDateTime: expiration,
    clientState: params.clientState,
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Create subscription failed for drive ${params.driveId}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as SubscriptionMetadata;
}

export async function renewSubscription(
  cfg: GraphCredentials,
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

export async function deleteSubscription(
  cfg: GraphCredentials,
  subscriptionId: string,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  // 404 is fine — already gone.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete subscription failed: ${res.status} ${await res.text()}`);
  }
}
