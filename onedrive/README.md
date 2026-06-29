# OneDrive Connector

Deploys a serverless integration into your Azure subscription. An Azure Function App (TypeScript, Node.js 22, Consumption plan) receives Microsoft Graph change notifications for a OneDrive drive, runs a delta query to identify new/updated files, and streams each file to the ROOTKey API using your Connector API Key.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## What this module creates

| Resource | Purpose |
|---|---|
| `azurerm_linux_function_app` | The connector itself (Node.js 22, Consumption plan, HTTPS only, TLS 1.2 min, CORS closed). |
| `azurerm_service_plan` (Y1) | Consumption plan; you pay only per execution. |
| `azurerm_storage_account` | Function backing + delta cursor state + DLQ. |
| `azurerm_storage_container` (`connector-state`) | Holds `delta-link.txt`, `subscription.json`, and `delta-sync.lock`. |
| `azurerm_storage_queue` (`rootkey-dlq`) | Dead-letter queue for per-file failures after retries. |
| `azurerm_key_vault` (+ 3 secrets) | Stores the Graph client secret, ROOTKey API key, and the webhook clientState. Purge protection enabled by default. |
| `azurerm_user_assigned_identity` | The Function App's identity; granted least-privilege access to Key Vault, blob, and queue via RBAC. |
| `azurerm_log_analytics_workspace` + `azurerm_application_insights` | Logs and telemetry with configurable retention (30–730 days). |
| Role assignments | `Key Vault Secrets User`, `Storage Blob Data Contributor`, `Storage Queue Data Contributor` for the function's identity. |

The module **does not** create or modify the Azure Entra ID App Registration — you create that yourself and pass the credentials in (see Prerequisites). The Resource Group must also pre-exist.

## How the Function App works

The Function App runs **three** registered functions:

1. **`notification`** (HTTP POST `/api/notification`) — receives Graph webhook notifications. Validates the `clientState`, acquires a singleton blob lease (so only one instance syncs at a time), and runs the delta query loop, sending failed items to the DLQ.
2. **`renewSubscription`** (Timer every 12h **with `runOnStartup: true`**) — creates the Graph subscription on first run, renews it before each expiry, and runs a safety-net delta sync to catch up on any missed notifications. The `runOnStartup` flag guarantees that the subscription is created within seconds of `terraform apply` finishing.
3. **`dlqReplay`** (Storage Queue trigger on `rootkey-dlq`) — automatically reprocesses every DLQ message: re-fetches the item from Graph (it may have changed or been deleted), and runs the same upload pipeline. If processing still fails, the queue retries with exponential backoff up to 5 times before moving the message to the `rootkey-dlq-poison` queue for human attention.

## Reliability model

- **Per-file retry budget.** Every upload to the ROOTKey API gets **3 attempts** total (initial + 2 retries) with exponential backoff (1s → 2s, capped at 30s) and jitter. Retries trigger on 429, 5xx, and network/timeout errors. 4xx (other than 429) is permanent — it goes straight to the DLQ.
- **Singleton sync via blob lease.** A sentinel blob `delta-sync.lock` is leased for the duration of each delta sync. Concurrent webhook invocations on the same drive return `202 Accepted` and let the holding instance complete. The lease auto-expires after 60s if the holder crashes, and is renewed every 45s while a sync is active.
- **Self-registering subscription.** On boot (`runOnStartup`) and every 12h, the timer ensures the Graph subscription exists and is renewed. If the upstream subscription has been deleted (404 on PATCH), the timer recreates it.
- **Safety-net delta sync.** The same timer runs a delta query after subscription bookkeeping — so even if a webhook notification is dropped, the missed changes are picked up within 12h.
- **DLQ replay.** Messages on the DLQ are automatically reprocessed by the `dlqReplay` queue trigger. No manual intervention is required for transient failures.
- **clientState validation.** Every notification carries a 32-char random `clientState` (generated at apply time and stored in Key Vault). Notifications with a missing or mismatched clientState are rejected with `401`.
- **Page cap.** The delta loop caps at 50 pages per invocation; if a drive is generating more changes than that, the cursor is persisted and the next invocation picks up where it left off.
- **Graph-side retry.** On a `5xx` response from the HTTP trigger (which we return only when the delta query itself fails), Microsoft Graph retries the notification with exponential backoff for up to ~4 hours.

## Security considerations

This connector is designed to fit a defensive posture out of the box; some choices have intentional trade-offs:

- **Secrets in Key Vault, not env vars.** The Graph client secret, ROOTKey API key, and webhook clientState are all stored in Key Vault. The Function App resolves them at boot via `@Microsoft.KeyVault(SecretUri=…)` references; they never appear in plain text in the `app_settings`.
- **User-assigned managed identity** with explicit RBAC (`Key Vault Secrets User`, `Storage Blob Data Contributor`, `Storage Queue Data Contributor`) — least privilege.
- **Key Vault purge protection** is **enabled by default** (`enable_key_vault_purge_protection = true`). This prevents accidental permanent deletion of the connector secrets. Once enabled it CANNOT be disabled, and a destroyed Key Vault cannot be fully purged until the 7-day soft-delete window elapses. Set the variable to `false` only during short pilots.
- **CORS closed.** The webhook endpoint is called server-to-server by Microsoft Graph; CORS is locked to `[]` so it cannot be invoked from a browser session.
- **HTTPS-only, TLS 1.2 minimum, FTPS disabled** on the Function App. HTTP/2 enabled.
- **`shared_access_key_enabled = true` on the Storage Account** is a known limitation: the Azure Functions **Consumption** runtime requires the legacy `AzureWebJobsStorage` connection string to bootstrap. The connector's own state operations use RBAC via the managed identity, not the keys. To remove the keys entirely you must move to a Premium / Flex Consumption / App Service plan that supports identity-based connections; this is on the roadmap.

## Prerequisites

### 1. An Azure Entra ID App Registration

In your Azure Entra ID tenant:

1. **Azure Portal → Azure Entra ID → App registrations → New registration.**
   - Name: `ROOTKey OneDrive Connector` (or similar).
   - Supported account types: *Accounts in this organizational directory only*.
   - Redirect URI: leave blank.

2. **API permissions → Add a permission → Microsoft Graph → Application permissions:**
   - `Files.Read.All`

   Then **Grant admin consent for [your tenant]**.

3. **Certificates & secrets → New client secret.** Note the *Value* — it is shown only once.

4. From the **Overview** page, note the **Application (client) ID** and **Directory (tenant) ID**.

### 2. A pre-existing Resource Group

Create a Resource Group in your Azure subscription where the connector will live. The Terraform principal needs `Contributor` (or equivalent) on the RG and `User Access Administrator` on the same RG to create the role assignments inside it.

### 3. The OneDrive Drive ID

Retrieve it via Microsoft Graph Explorer or the Graph API:

```http
GET https://graph.microsoft.com/v1.0/users/{user-id-or-upn}/drives
```

Copy the `id` of the drive you want to monitor.

### 4. Tooling

- [Terraform](https://developer.hashicorp.com/terraform/install) v1.3 or later.
- [Node.js](https://nodejs.org) 22+ on the machine running Terraform (used to compile the function at `terraform apply` time).
- Azure CLI authenticated (`az login`) or service principal credentials in the environment.

## Setup

1. Create the App Registration and the Resource Group as above.
2. Find the Drive ID.
3. Create a connector in the ROOTKey dashboard. The Tenant ID, Client ID, and Drive ID are required during the wizard. At the end, the dashboard generates a pre-filled Terraform block — copy it.
4. Apply the module:

```bash
terraform init
terraform apply
```

5. Because `runOnStartup: true` is set on the timer, the Function App registers the Graph subscription within seconds of finishing the deploy. You can confirm with:

```bash
az functionapp function show \
  --resource-group <rg> \
  --name $(terraform output -raw function_app_name) \
  --function-name renewSubscription
```

…and then inspect the `connector-state` blob container for the `subscription.json` blob.

## Usage

```hcl
module "rootkey_onedrive_connector" {
  source = "github.com/rootkey-ai/rootkey-connectors//onedrive"

  resource_group_name = "rootkey-connectors"
  azure_location      = "westeurope"
  name_suffix         = "acme"             # 3–12 lowercase alphanumeric chars

  graph_tenant_id     = "11111111-1111-1111-1111-111111111111"
  graph_client_id     = "22222222-2222-2222-2222-222222222222"
  graph_client_secret = "Xyz~RandomSecretFromAppRegistration"
  drive_id            = "b!abcd...verylong-graph-drive-id"

  rootkey_api_key = "rk_conn_xxxxxxxxxxxxxxxxxxxx"

  # Optional
  rootkey_api_url                   = "https://api.rootkey.ai" # default; only change if instructed
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
| `drive_id` | string | yes | — | Graph drive ID to monitor. |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Stored in Key Vault. |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL. Must use `https://`. |
| `max_file_size_bytes` | number | no | `524288000` (500 MiB) | Files larger than this are skipped and sent to the DLQ. |
| `log_retention_days` | number | no | `30` | Application Insights / Log Analytics retention. Must be between 30 and 730. |
| `enable_key_vault_purge_protection` | bool | no | `true` | Whether to enable purge protection on the Key Vault. Production default; set to `false` only for short-lived pilots. |
| `tags` | map(string) | no | `{}` | Extra tags applied to every module-managed resource. |

## Outputs

| Name | Description |
|---|---|
| `function_app_name` | Name of the deployed Function App. |
| `function_app_hostname` | Default hostname (used as the Graph webhook target). |
| `notification_url` | The full webhook URL for diagnostics. |
| `key_vault_name` | Key Vault holding the connector secrets. |
| `storage_account_name` | Storage Account used for function backing, state, and DLQ. |
| `dlq_queue_name` | Storage Queue receiving per-file failures — monitor this. |
| `application_insights_name` | App Insights resource where the Function App writes telemetry. |
| `managed_identity_id` | Resource ID of the user-assigned managed identity. |

## Observability

After deployment, what to monitor:

| Signal | What it means | How to alert |
|---|---|---|
| `rootkey-dlq` queue length > 0 for more than ~10 min | DLQ replay is failing repeatedly (queue retries pending). | Azure Monitor metric alert on the queue length. |
| `rootkey-dlq-poison` queue receives a message | A file failed all DLQ replay attempts for a transient-looking reason — human attention needed. | Azure Monitor metric alert on `ApproximateMessageCount`. |
| App Insights trace contains `rootkey.event.dlq_replay_terminal_failure` | A file hit a permanent error during DLQ replay (e.g., oversize, 4xx) and was acked without retrying. The poison queue is bypassed deliberately to avoid wasting attempts. | App Insights alert on the message marker. |
| Application Insights `traces` with `severityLevel >= 3` | Recurring runtime errors (Graph 4xx, ROOTKey 4xx, etc.). | App Insights alert. |
| `renewSubscription` not running for > 13h | Timer is unhealthy or the Function App is stopped. | App Insights availability or platform-level health metric. |
| Function App `Http5xx` > 0 | The webhook is failing (Graph will retry). | Azure Monitor metric alert. |

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
// another instance was already running the delta sync). Watching this lets you
// size between "healthy serialization" (rare) and "drive is being hammered" (high).
traces
| where cloud_RoleName == "<function_app_name>"
| where message has "rootkey.metric.sync_lease_contention"
| summarize contentions = count() by bin(timestamp, 5m)
| render timechart
```

To peek at the DLQ contents:

```bash
az storage message peek \
  --queue-name rootkey-dlq \
  --account-name $(terraform output -raw storage_account_name) \
  --num-messages 10
```

## Verification

1. After `terraform apply` completes, give the Function App ~30s for `runOnStartup` to fire and register the Graph subscription.
2. Upload a test file to the monitored OneDrive drive.
3. Within a few seconds the file should appear in your ROOTKey vault.
4. Confirm in App Insights traces:

```kusto
traces
| where cloud_RoleName == "<function_app_name>"
| where message startswith "Uploaded item"
| order by timestamp desc
```

If nothing arrives:

1. **Check the subscription was registered.** Look in the `connector-state` blob container for `subscription.json`.
2. **Check the DLQ.** `az storage message peek …` (see above).
3. **Check the poison queue (`rootkey-dlq-poison`)** for items that failed all replay attempts.
4. **Check App Insights traces** for errors from `notification`, `renewSubscription`, or `dlqReplay`.
5. **Confirm Graph permissions.** Azure Entra ID → App registrations → API permissions: `Files.Read.All` must be granted with admin consent.

## Cost

For the resources this module creates, the customer pays:

- **Function App (Consumption Y1):** $0 within free tier (1M executions + 400K GB-s/month, perpetual).
- **Storage Account:** ~$0.05–1/month (function backing + state blobs + queue).
- **Key Vault Standard:** ~$0.01/month (per-op pricing only).
- **App Insights + Log Analytics:** $0 within free tier (5 GB/month).
- **Egress to ROOTKey API:** $0 for the first 100 GB/month; ~$0.087/GB after that.

Realistic monthly cost for small/mid-market deployments: **< $5/month**, dominated by egress when bulk-uploading files. See `aws-s3/README.md` for a parallel cost comparison.

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
