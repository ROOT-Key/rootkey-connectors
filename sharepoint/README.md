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
2. **`renewSubscription`** (Timer every 12h **with `runOnStartup: true`**) — acquires a **global reconciliation lease**, re-resolves the site, lists all current drives, renews existing subscriptions, creates subscriptions for newly-added drives, deletes subscriptions for removed drives, and runs a safety-net delta sync for each drive. The `runOnStartup` flag guarantees that the connector starts working within seconds of `terraform apply` finishing.
3. **`dlqReplay`** (Storage Queue trigger on `rootkey-dlq`) — automatically reprocesses every DLQ message: re-fetches the item from Graph (it may have changed or been deleted), and runs the same upload pipeline. Permanent errors (oversize, 4xx) are caught and short-circuited with a stable log marker; transient errors propagate so the queue retries with backoff up to 5 times before moving the message to the `rootkey-dlq-poison` queue.

## Reliability model

- **Per-file retry budget.** Every upload to the ROOTKey API gets **3 attempts** total (initial + 2 retries) with exponential backoff (1s → 2s, capped at 30s) and jitter. Retries trigger on 429, 5xx, and network/timeout errors. 4xx (other than 429) is a `PermanentError` — it goes straight to the DLQ.
- **Per-drive sync lease.** Each drive has its own lock blob `delta-sync-{driveId}.lock`. Concurrent webhook invocations for the same drive serialize; independent drives sync in parallel. Leases auto-expire after 60s if the holder crashes and are renewed every 45s while a sync is active.
- **Global subscriptions reconciliation lease.** `subscriptions-reconciliation.lock` serializes the timer's reconciliation across Function App instances. Without it, two concurrent timer runs would race on `subscriptions.json` and create duplicate Graph subscriptions per drive (Graph allows duplicates per resource — each duplicate generates an extra notification per change).
- **Self-registering subscriptions.** On boot (`runOnStartup`) and every 12h, the timer ensures every current drive has exactly one subscription. If an upstream subscription was deleted (404 on PATCH), the timer recreates it. If a drive was removed from the site, its subscription and delta cursor are deleted.
- **Safety-net delta sync.** The same timer runs a delta query per drive after reconciliation — so even if a webhook notification is dropped, the missed changes are picked up within 12h.
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

## Prerequisites

### 1. An Azure Entra ID App Registration

This is the only manual identity setup. In your Azure Entra ID tenant:

1. **Azure Portal → Azure Entra ID → App registrations → New registration.**
   - Name: `ROOTKey SharePoint Connector` (or similar).
   - Supported account types: *Accounts in this organizational directory only*.
   - Redirect URI: leave blank.

2. **API permissions → Add a permission → Microsoft Graph → Application permissions:**
   - `Sites.Read.All`
   - `Files.Read.All`

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

- [Terraform](https://developer.hashicorp.com/terraform/install) v1.3 or later.
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

5. Because `runOnStartup: true` is set on the timer, the Function App reconciles subscriptions within seconds of finishing the deploy. You can confirm by inspecting the `connector-state` blob container:

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
  source = "github.com/rootkey-ai/rootkey-connectors//sharepoint"

  resource_group_name = "rootkey-connectors"
  azure_location      = "westeurope"
  name_suffix         = "acme"             # 3–12 lowercase alphanumeric chars

  graph_tenant_id     = "11111111-1111-1111-1111-111111111111"
  graph_client_id     = "22222222-2222-2222-2222-222222222222"
  graph_client_secret = "Xyz~RandomSecretFromAppRegistration"
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
| `graph_client_secret` | string | yes | — | App Registration client secret. Stored in Key Vault. |
| `site_url` | string | yes | — | Full URL of the SharePoint site (must end with `.sharepoint.com`). |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Stored in Key Vault. |
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

- **Rotating the Graph client secret:** generate a new secret in the App Registration, update `graph_client_secret`, `terraform apply`. The new value goes into Key Vault; restart the Function App to force pickup (otherwise the cached OAuth token is used for up to 1h).
- **Rotating the ROOTKey API key:** delete the connector in the dashboard and create a new one (reuse the App Registration and Site URL), update `rootkey_api_key`, `terraform apply`.
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
