# SharePoint Connector

Deploys a serverless integration into your Azure subscription. An Azure Function App (TypeScript, Node.js 22, **Flex Consumption** plan) discovers **every document library (drive) on a SharePoint site**, subscribes to Microsoft Graph change notifications for each, and streams new or updated files to the ROOTKey API using your Connector API Key.

**Multi-drive by design:** a single connector instance covers every document library on the site. When you add a new library to the site, the connector picks it up automatically on its next 12-hour reconciliation cycle — no extra installation, no extra Terraform.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## What this module creates

| Resource | Purpose |
|---|---|
| `azurerm_function_app_flex_consumption` | The connector itself (Node.js 22, Flex Consumption plan, HTTPS-only, 512 MB instances by default). |
| `azurerm_service_plan` (FC1) | Flex Consumption plan; pay per execution + GB-second. Replaces Linux Consumption (Y1), which is in the **Retiring** state in several regions. |
| `azurerm_storage_container` (`deploymentpackage`) | Holds the Function App's deployment zip. Flex Consumption pulls the bundle from here at boot. |
| `azurerm_storage_account` | Function backing + per-drive delta state + DLQ + lock blobs. |
| `azurerm_storage_container` (`connector-state`) | Holds per-drive `delta-{driveId}.txt`, the `subscriptions.json` registry, and lock blobs (`delta-sync-{driveId}.lock`, `subscriptions-reconciliation.lock`). |
| `azurerm_storage_queue` (`rootkey-dlq`) | Dead-letter queue for per-file failures, auto-replayed by a queue-triggered function. |
| `azurerm_key_vault` (+ 3 secrets) | Stores the Graph client secret, ROOTKey API key, and webhook clientState. Purge protection enabled by default. |
| `azurerm_user_assigned_identity` | The Function App's identity; granted least-privilege access to Key Vault, blob, and queue via RBAC. |
| `azurerm_log_analytics_workspace` + `azurerm_application_insights` | Logs and telemetry with configurable retention (30–730 days). |
| Role assignments | `Key Vault Secrets User`, `Storage Blob Data Contributor`, `Storage Queue Data Contributor` for the function's identity. |

The module **does not** create or modify the Azure Entra ID App Registration — you create that yourself and pass the credentials in (see Prerequisites). The Resource Group must also pre-exist.

## How the Function App works

The Function App runs **three** registered functions:

1. **`notification`** (HTTP POST `/api/notification`) — receives Graph webhook notifications for any of the site's drives. Validates the `clientState`, maps each notification's `subscriptionId` to the originating drive via the stored `subscriptions.json`, acquires a per-drive sync lease (so concurrent invocations for the same drive serialize), and runs the delta query loop.
2. **`renewSubscription`** (Timer every **1 hour** **with `runOnStartup: true`**) — acquires a **global reconciliation lease**, re-resolves the site, lists all current drives, renews existing subscriptions, creates subscriptions for newly-added drives, deletes subscriptions for removed drives, and runs a safety-net delta sync for each drive. The 1-hour cadence caps the worst-case latency between an edit in SharePoint and ingestion into ROOTKey to (Graph webhook delay) OR (time to next hour), whichever comes first. The `runOnStartup` flag makes the connector reconcile as soon as the timer's instance group starts. On Flex Consumption that group is not provisioned the instant the app is created — allow 20–30 minutes after `terraform apply` before the first reconciliation; see step 5 of Setup.
3. **`dlqReplay`** (Storage Queue trigger on `rootkey-dlq`) — automatically reprocesses every DLQ message: re-fetches the item from Graph (it may have changed or been deleted), and runs the same upload pipeline. Permanent errors (oversize, 4xx) are caught and short-circuited with a stable log marker; transient errors propagate so the queue retries with backoff up to 5 times before moving the message to the `rootkey-dlq-poison` queue.

## What the connector sends to ROOTKey

Every upload is a `POST` to either `/api-v1/connectors/files/` (new file) or `/api-v1/connectors/files/{parentId}/versions` (new version of a known file). The routing is decided per item using the local upload registry — see the "Reliability model" section below.

Each request is a `multipart/form-data` body with two parts:

- **`file`** — the raw file bytes streamed from Graph.
- **`metadata`** — a JSON document containing everything Graph exposes about the file. Absent fields are omitted (Graph doesn't always populate `sha256Hash` on very large files, `email` on app-created items, etc.):

```json
{
  "cTag": "\"c:{...}\"",
  "name": "Q3 board deck.pptx",
  "size": 8342112,
  "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "sha256Hash": "6f4b...",
  "webUrl": "https://contoso.sharepoint.com/sites/board/Shared%20Documents/Q3%20board%20deck.pptx",
  "path": "/drives/{driveId}/root:/board-packs",
  "createdAt": "2026-07-01T09:12:04Z",
  "lastModifiedAt": "2026-07-03T15:44:22Z",
  "createdBy": { "id": "<entra-guid>", "displayName": "Alice Doe", "email": "alice@contoso.com" },
  "lastModifiedBy": { "id": "<entra-guid>", "displayName": "Bob Roe", "email": "bob@contoso.com" }
}
```

Plus the same headers the pre-v2 contract already carried (`x-api-key`, `x-rootkey-source-drive-id`, `x-rootkey-source-item-id`, `x-rootkey-source-etag`) so the backend can route/dedupe without parsing the multipart body. The `x-rootkey-source-item-id` doubles as the ROOTKey `fileId` on new-file uploads and matches the `{parentId}` in the versions URL.

The pack was designed to sustain **NIS2 / DORA-style audit trails** out of the box: for every change to a document you can answer *who* (Entra identity), *when* (timestamps in UTC), *where* (path + `webUrl`), and *what* (name, size, MIME, content hash). Fields flow through unchanged to the ROOTKey dashboard where they surface in the file's history view.

## Reliability model

- **Per-file retry budget.** Every upload to the ROOTKey API gets **3 attempts** total (initial + 2 retries) with exponential backoff (1s → 2s, capped at 30s) and jitter. Retries trigger on 429, 5xx, and network/timeout errors. 4xx (other than 429) is a `PermanentError` — it goes straight to the DLQ.
- **Per-drive sync lease.** Each drive has its own lock blob `delta-sync-{driveId}.lock`. Concurrent webhook invocations for the same drive serialize; independent drives sync in parallel. Leases auto-expire after 60s if the holder crashes and are renewed every 45s while a sync is active.
- **Global subscriptions reconciliation lease.** `subscriptions-reconciliation.lock` serializes the timer's reconciliation across Function App instances. Without it, two concurrent timer runs would race on `subscriptions.json` and create duplicate Graph subscriptions per drive (Graph allows duplicates per resource — each duplicate generates an extra notification per change).
- **Self-registering subscriptions.** On boot (`runOnStartup`) and every hour, the timer ensures every current drive has exactly one subscription. If an upstream subscription was deleted (404 on PATCH), the timer recreates it. If a drive was removed from the site, its subscription and delta cursor are deleted.
- **Safety-net delta sync.** The same timer runs a delta query per drive after reconciliation — so even if a webhook notification is dropped, the missed changes are picked up within an hour.
- **Version-aware uploads.** For each file the connector has ever anchored, a small state blob is kept in `connector-state/uploaded-items/{driveId}/{itemId}.json` recording the Graph `cTag` at the time of last upload. On subsequent delta passes: a new item is POSTed to `/api-v1/connectors/files/` (root file creation); an item whose `cTag` has changed is POSTed to `/api-v1/connectors/files/{parentId}/versions` (new version); an item whose `cTag` is unchanged is skipped without downloading. This preserves the full history of every file (audit trail) and avoids re-uploading content that hasn't actually mutated (rename or metadata-only edits are ignored).
- **DLQ replay.** Messages on the DLQ are automatically reprocessed by the `dlqReplay` queue trigger. No manual intervention is required for transient failures.
- **clientState validation.** Every notification carries a 32-char random `clientState` (generated at apply time and stored in Key Vault). Notifications with a missing or mismatched clientState are rejected with `401`.
- **Page cap.** The delta loop caps at 50 pages (~10 000 items at default Graph page size) per invocation per drive; if a drive is generating more changes than that, the cursor is persisted and the next invocation picks up where it left off.
- **Graph-side retry.** On a `5xx` response from the HTTP trigger (which we return only when the delta query itself fails), Microsoft Graph retries the notification with exponential backoff for up to ~4 hours.

## Security considerations

The module ships with a defensive default posture; a few choices have intentional trade-offs that are worth understanding upfront:

- **Secrets in Key Vault, not Function App settings.** Graph client secret, ROOTKey API key, and webhook `clientState` are all stored in Key Vault with the Function App's managed identity granted `Key Vault Secrets User` (read-only) RBAC.
- **Key Vault purge protection is enabled by default.** Set `enable_key_vault_purge_protection = false` only for short pilots — once enabled it CANNOT be disabled and the vault cannot be fully purged for 7 days after `terraform destroy`.
- **CORS is closed.** The webhook is server-to-server (Graph); browser access is explicitly disallowed.
- **HTTPS-only, TLS 1.2 minimum, FTPS disabled, HTTP/2 enabled** on the Function App.
- **Storage Account shared access keys are disabled** (`shared_access_key_enabled = false`). All access — the Function App's deployment bundle, its own state blobs, and the DLQ queue — flows through the user-assigned managed identity with RBAC (Storage Blob Data Owner + Storage Queue Data Contributor). Identity-based `AzureWebJobsStorage` is wired via `AzureWebJobsStorage__accountName`. This is one of the reasons the module runs on Flex Consumption; the older Linux Consumption (Y1) plan required the legacy connection string and could not turn keys off.

## Secrets and Terraform state

Terraform records the attributes of everything it manages in a state file. By default that includes the *value* of any secret you pass in — marking a variable `sensitive` only masks it in CLI output, it does not keep it off disk. For a regulated environment that is usually the first question asked about an IaC module, so it is worth being precise about what this one does.

**The secrets you supply are never written to state.** Both `graph_client_secret` and `rootkey_api_key` are written with `value_wo` — a write-only argument. The provider receives the value, sends it to Key Vault, and Terraform persists nothing. The same value is also absent from a saved plan file (`terraform plan -out=…`), because the corresponding input variables are declared `ephemeral`.

You can verify this yourself after an apply — the following returns nothing:

```bash
grep -i -c "<the secret value>" terraform.tfstate
```

**The cost of this: Terraform cannot detect that a secret changed.** It never sees the value, so it has nothing to compare against. That is what the `*_version` counters are for. Change a secret *and* increment its counter, and the new value is written. Change a secret and leave the counter alone, and **the apply succeeds while silently doing nothing** — this is the one sharp edge of the design, and it is why the rotation procedures below always name both steps.

**What does still live in the state file.** Being complete about this matters more than the headline:

This list was produced by walking the Terraform provider schema for every resource the module creates, taking each attribute marked `sensitive`, and checking it against a real applied state. It is not written from memory, and you can reproduce it yourself — see the command below.

| What | Usable? | Why it is there |
|---|---|---|
| `azurerm_storage_account` — `primary_access_key`, `secondary_access_key`, and the three connection strings that embed them | **No** | Azure generates account keys whether or not you use them. The module sets `shared_access_key_enabled = false`, which stops them authenticating: an attempt returns `Key based authentication is not permitted on this storage account`. They are recorded in state regardless, so an auditor will find them — they are inert, not absent. |
| `azurerm_function_app_flex_consumption` — `site_credential[0].password` | **Yes** | The SCM/Kudu publishing password. Basic publishing authentication is enabled by default, so this credential grants deployment access to the Function App. This is the most significant item in the list; see the note below it. |
| `azurerm_log_analytics_workspace` — `primary_shared_key`, `secondary_shared_key` | **Yes** | Allow writing data into the Log Analytics workspace. Ingestion only — they grant no read access and reach nothing else. |
| `azurerm_application_insights` — `instrumentation_key`, `connection_string` | **Yes** | Telemetry ingestion into this connector's Application Insights, and nothing else. |
| `random_string.client_state.result` | n/a | The webhook `clientState` — a validation token the module generates so the Function App can reject forged Graph notifications. Not a credential to your tenant. It stays in state because it has to be stable across applies; regenerating it every apply would invalidate notifications already in flight. |
| `azurerm_function_app_flex_consumption` — `custom_domain_verification_id` | n/a | Used to prove domain ownership when binding a custom domain. Not a credential. |
| Resource IDs, names, RBAC assignments, app settings | n/a | Infrastructure metadata. `app_settings` holds Key Vault *references* (`@Microsoft.KeyVault(SecretUri=…)`), never resolved secret values. |

None of these grants access to your Microsoft 365 tenant, to SharePoint, or to ROOTKey. They are scoped to the resources this module created. The SCM publishing password is the one worth treating as a real credential: whoever holds it can deploy code to the Function App. If your policy does not allow that in a state file, set `webdeploy_publish_basic_authentication_enabled = false` on the Function App, which makes it inert in the same way the storage keys already are.

**Reproduce this list against your own deployment**, rather than trusting this page. Terraform marks every sensitive attribute itself, under `sensitive_values`:

```bash
terraform show -json > state.json
```

Open `state.json` and look at each resource's `sensitive_values` block: every attribute set to `true` there is one Terraform considers sensitive, and the matching entry under `values` is what was actually recorded. On a real deployment of this module that yields 19 entries, and the two that matter read like this:

```
azurerm_key_vault_secret.graph_client_secret   value   ""
azurerm_key_vault_secret.rootkey_api_key       value   ""
```

Empty, because the module writes them with a write-only argument. Every other entry in the list is one of the items in the table above.

**Where to keep the state file.** Even with no secrets in it, the state is an accurate map of your deployment and should not sit on an operator's laptop. Use a remote backend in your own cloud account — it also gives you state locking, so two people cannot apply at once:

```hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "my-tfstate-rg"
    storage_account_name = "mytfstate"
    container_name       = "tfstate"
    key                  = "rootkey-connector.tfstate"
    use_azuread_auth     = true # no storage account keys
  }
}
```

The trust boundary here is the same one you already accepted by letting the module create a Key Vault in your own subscription. If that is acceptable, the state is acceptable in the same place.

## Prerequisites

### 1. An Azure Entra ID App Registration

This is the only manual identity setup. In your Azure Entra ID tenant:

1. **Azure Portal → Azure Entra ID → App registrations → New registration.**
   - Name: `ROOTKey SharePoint Connector` (or similar).
   - Supported account types: *Accounts in this organizational directory only*.
   - Redirect URI: leave blank.

2. **API permissions → Add a permission → Microsoft Graph → Application permissions:**
   - `Sites.Read.All` — enumerate the site and its drives.
   - `Files.ReadWrite.All` — required by Graph specifically for **creating change-notification subscriptions** on drive resources. The connector never writes to files; the permission naming is a Microsoft-Graph quirk. Read the `permissions` column in [the subscription resource docs](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions) — for `/drives/{id}/root` the required application permission is `Files.ReadWrite.All`.

   Then **Grant admin consent for [your tenant]**.

3. **Certificates & secrets → New client secret.** Note the *Value* — it is shown only once. Set a calendar reminder for rotation; when the secret expires, the connector starts failing with `401` from Graph.

4. From the **Overview** page, note the **Application (client) ID** and **Directory (tenant) ID**.

### 2. A pre-existing Resource Group

Create a Resource Group in your Azure subscription where the connector will live. The Terraform principal needs `Contributor` (or equivalent) on the RG and `User Access Administrator` to create role assignments inside it.

### 3. The SharePoint site URL

You only need the URL — the connector resolves it to a site ID at runtime, then enumerates all document libraries (drives) under it and subscribes to each.

Examples of acceptable values:
- `https://contoso.sharepoint.com/sites/legal`
- `https://contoso.sharepoint.com/sites/marketing/`
- `https://contoso.sharepoint.com` (root site)

The hostname must end with `.sharepoint.com`.

### 4. Tooling

- [Terraform](https://developer.hashicorp.com/terraform/install) **v1.11 or later**. This is a hard floor, not a recommendation: the module uses write-only arguments to keep your secrets out of the Terraform state file, and those require 1.11. Older versions fail at `terraform init` with an explicit version error rather than silently writing the secret to disk.
- [Node.js](https://nodejs.org) 22+ on the machine running Terraform (used to compile the function at `terraform apply` time).
- Azure CLI authenticated (`az login`) or service principal credentials in the environment.

## Setup

1. Create the App Registration and the Resource Group as above.
2. Note the SharePoint site URL.
3. Create a connector in the ROOTKey dashboard. The Tenant ID, Client ID, and Site URL are required during the wizard. At the end, the dashboard generates a pre-filled Terraform block — copy it.
4. Apply the module:

```bash
terraform init
terraform apply
```

5. **Give the connector 20–30 minutes before your first test.** The timer carries `runOnStartup: true`, but on the Flex Consumption plan Azure runs each trigger type on its own instance group, and the group that owns the timer is not provisioned the moment the app is created. In a measured deployment the gap between `terraform apply` finishing and the first reconciliation was **19 minutes**. During that window the Function App is healthy and answering HTTP, and no subscription exists yet — a file uploaded then is picked up by the next delta sync, not lost. Once the first run happens the hourly timer fires on schedule. You can confirm by inspecting the `connector-state` blob container:

```bash
az storage blob list \
  --container-name connector-state \
  --account-name $(terraform output -raw storage_account_name) \
  --query "[].name"
```

You should see `subscriptions.json` and one `delta-{driveId}.txt` per drive after the first sync.

6. The connector is now live. Any file uploaded or modified in any document library on the site will be anchored in ROOTKey within seconds.

## Usage

```hcl
module "rootkey_sharepoint_connector" {
  # Pin to a release tag. Without a ?ref= the source resolves to whatever is on
  # the default branch at the moment you run terraform init, which means two
  # people deploying a week apart can get different code — not acceptable
  # under most change-control regimes.
  source = "github.com/ROOT-Key/rootkey-connectors//sharepoint?ref=v1.0.0"

  resource_group_name = "rootkey-connectors"
  azure_location      = "westeurope"
  name_suffix         = "acme"             # 3–12 lowercase alphanumeric chars

  graph_tenant_id     = "11111111-1111-1111-1111-111111111111"
  graph_client_id     = "22222222-2222-2222-2222-222222222222"
  graph_client_secret = "Xyz~RandomSecretFromAppRegistration"

  # Rotation counters. Increment the matching counter whenever you change a
  # secret above — see "Secrets and Terraform state" below for why.
  graph_client_secret_version = 1
  rootkey_api_key_version     = 1
  site_url            = "https://contoso.sharepoint.com/sites/legal"

  rootkey_api_key = "rk_conn_xxxxxxxxxxxxxxxxxxxx"

  # Optional
  rootkey_api_url                   = "https://api.rootkey.ai"
  max_file_size_bytes               = 524288000                # default: 500 MiB
  log_retention_days                = 30                       # default
  enable_key_vault_purge_protection = true                     # default; set to false only for short pilots
  tags = {
    "cost-center" = "security"
    "owner"       = "platform-team"
  }
}
```

## Inputs

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `resource_group_name` | string | yes | — | Pre-existing Azure Resource Group. |
| `azure_location` | string | yes | — | Azure region, e.g. `westeurope`. |
| `name_suffix` | string | yes | — | 3–12 lowercase alphanumeric chars used to make resource names unique. |
| `graph_tenant_id` | string | yes | — | Tenant ID (UUID) of the Microsoft 365 tenant. |
| `graph_client_id` | string | yes | — | App Registration Application (client) ID (UUID). |
| `graph_client_secret` | string | yes | — | App Registration client secret. Written to Key Vault as a write-only argument — never persisted to Terraform state or to a saved plan. |
| `graph_client_secret_version` | number | no | `1` | Rotation counter. **Must be incremented whenever `graph_client_secret` changes**, or the new value is silently ignored. |
| `site_url` | string | yes | — | Full URL of the SharePoint site (must end with `.sharepoint.com`). |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Written to Key Vault as a write-only argument — never persisted to Terraform state or to a saved plan. |
| `rootkey_api_key_version` | number | no | `1` | Rotation counter. **Must be incremented whenever `rootkey_api_key` changes**, or the new value is silently ignored. |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL. Must use `https://`. |
| `max_file_size_bytes` | number | no | `524288000` (500 MiB) | Files larger than this are skipped and sent to the DLQ. |
| `log_retention_days` | number | no | `30` | Application Insights / Log Analytics retention (30–730). |
| `enable_key_vault_purge_protection` | bool | no | `true` | Keep purge protection enabled for production. Set to `false` only during short pilots. |
| `tags` | map(string) | no | `{}` | Extra tags applied to every module-managed resource. |

## Outputs

| Name | Description |
|---|---|
| `function_app_name` | Name of the deployed Function App. |
| `function_app_hostname` | Default hostname (used as the Graph webhook target). |
| `notification_url` | The full webhook URL for diagnostics. |
| `key_vault_name` | Key Vault holding the connector secrets. |
| `storage_account_name` | Storage Account used for function backing, per-drive state, and DLQ. |
| `dlq_queue_name` | Storage Queue receiving per-file failures — monitor this. |
| `application_insights_name` | App Insights resource where the Function App writes telemetry. |
| `managed_identity_id` | Resource ID of the user-assigned managed identity. |

## Observability

After deployment, what to monitor:

| Signal | What it means | How to alert |
|---|---|---|
| `rootkey-dlq` queue length > 0 for more than ~10 min | DLQ replay is failing repeatedly (transient errors). | Azure Monitor metric alert on the queue length. |
| `rootkey-dlq-poison` queue receives a message | A file failed all DLQ replay attempts for a transient-looking reason — human attention needed. | Azure Monitor metric alert on `ApproximateMessageCount`. |
| App Insights trace contains `rootkey.event.dlq_replay_terminal_failure` | A file hit a permanent error during DLQ replay (e.g., oversize, 4xx) and was acked without retrying. The poison queue is bypassed deliberately to avoid wasting attempts. | App Insights alert on the message marker. |
| App Insights trace contains `rootkey.metric.sync_lease_contention` (steady-state) | Concurrent notifications for the same drive serialize — small numbers are healthy. Sustained high rate means a drive is being hammered. | App Insights chart on bin(timestamp, 5m). |
| App Insights trace contains `rootkey.metric.reconciliation_lease_contention` | Two timer instances raced on subscription reconciliation; the loser skipped. Expected at most once per timer cycle. | App Insights alert if it appears more than ~3×/day. |
| Function App `Http5xx` > 0 | The webhook is failing (Graph will retry). | Azure Monitor metric alert. |
| App Insights traces with `severityLevel >= 3` | Recurring runtime errors. | App Insights alert. |
| `renewSubscription` hasn't run in > 13h | Timer is unhealthy or the Function App is stopped. | App Insights availability or platform health metric. |

Useful Kusto queries:

```kusto
// All recent errors
traces
| where cloud_RoleName == "<function_app_name>"
| where severityLevel >= 3
| order by timestamp desc
| take 100

// Terminal DLQ failures (PermanentError caught during replay — won't auto-recover)
// Alert on count() > 0 over 15-minute window.
traces
| where cloud_RoleName == "<function_app_name>"
| where message has "rootkey.event.dlq_replay_terminal_failure"
| order by timestamp desc

// Sync lease contention rate (concurrent notification handlers skipped because
// another instance was already running the delta sync for the same drive).
traces
| where cloud_RoleName == "<function_app_name>"
| where message has "rootkey.metric.sync_lease_contention"
| summarize contentions = count() by bin(timestamp, 5m)
| render timechart

// Reconciliation lease contention (concurrent timer instances). Should be near zero.
traces
| where cloud_RoleName == "<function_app_name>"
| where message has "rootkey.metric.reconciliation_lease_contention"
| order by timestamp desc
```

To peek at DLQ contents:

```bash
az storage message peek \
  --queue-name rootkey-dlq \
  --account-name $(terraform output -raw storage_account_name) \
  --num-messages 10
```

## Verification

1. After `terraform apply` completes, give the Function App ~30s for `runOnStartup` to fire and register the Graph subscriptions.
2. Upload a test file to any document library on the monitored site.
3. Within a few seconds the file should appear in your ROOTKey vault.
4. Confirm in App Insights traces:

```kusto
traces
| where cloud_RoleName == "<function_app_name>"
| where message startswith "Uploaded item"
| order by timestamp desc
```

If nothing arrives:

1. **Check the timer ran.** The first run should log `Site ... resolved to ...; N drive(s) found` followed by `Created subscription ... for drive '<name>'` per library.
2. **Check `subscriptions.json` exists** in the `connector-state` blob container (see verification command in Setup step 5).
3. **Check the DLQ and the poison queue** (`az storage message peek ...`).
4. **Check App Insights traces** for errors from `notification`, `renewSubscription`, or `dlqReplay`.
5. **Confirm Graph permissions.** In Azure Entra ID → App registrations → API permissions, both `Sites.Read.All` and `Files.Read.All` must be granted with admin consent.
6. **Confirm the App Registration has access to the site.** Tenant-wide Graph permissions usually suffice, but custom site permission policies in your tenant can block access.

## Operational notes

- **Rotating the Graph client secret.** Generate the new secret in the App Registration, then update **both** `graph_client_secret` **and** `graph_client_secret_version` (increment it), then `terraform apply`. Updating the secret without incrementing the counter produces a successful apply that changes nothing — Terraform cannot see a write-only value, so the counter is its only signal. Apply first and revoke the old secret in Entra afterwards, once the connector is confirmed healthy; the Function App may hold a cached OAuth token for up to 1h, so allow for that overlap.

  Do **not** rotate by writing a new version straight into Key Vault with `az keyvault secret set`. The Function App resolves a *versioned* Key Vault reference, so it would keep reading the old version — which you just revoked — and start failing with `401 invalid_client` (AADSTS7000215). Rotation has to go through `terraform apply`, which is what moves the app setting to the new version URI.
- **Rotating the ROOTKey API key.** Delete the connector in the dashboard and create a new one (reuse the App Registration and Site URL), then update **both** `rootkey_api_key` **and** `rootkey_api_key_version` (increment it), then `terraform apply`. The same caveats apply.
- **Adding a drive to the site:** automatic — the next 12h timer cycle (or the next deploy) picks it up and creates a subscription.
- **Removing a drive from the site:** automatic — the timer detects the missing drive, deletes its subscription via Graph, and removes its delta cursor blob.
- **Multiple sites:** deploy the module once per site. Each instance is fully isolated, namespaced by `name_suffix` and a hash of the site URL.

## Cost

For the resources this module creates, the customer pays:

- **Function App (Flex Consumption FC1):** essentially $0 within free grants for typical connector load. Pay-per-execution + GB-s; with 512 MB instances and ~seconds of duration per file, even at thousands of uploads/month the cost stays in cents.
- **Storage Account:** ~$0.05–1/month (function backing + per-drive state blobs + queue + lock blobs).
- **Key Vault Standard:** ~$0.01/month (per-op pricing only).
- **App Insights + Log Analytics:** $0 within free tier (5 GB/month).
- **Egress to ROOTKey API:** $0 for the first 100 GB/month; ~$0.087/GB after that.

The cost does **not** scale with the number of drives — one Function App handles them all. Realistic monthly cost for small/mid-market deployments: **< $5/month**, dominated by egress when bulk-uploading files. See `aws-s3/README.md` for a parallel cost comparison.

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
