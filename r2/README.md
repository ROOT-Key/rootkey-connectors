# Cloudflare R2 Connector

Deploys a serverless integration into your Cloudflare account. A Cloudflare Worker (TypeScript, V8 isolate) consumes R2 event notifications from a Cloudflare Queue and streams each new object to the ROOTKey API using your Connector API Key.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## What this module creates

| Resource | Purpose |
|---|---|
| `cloudflare_workers_script` | The connector itself (TypeScript bundled to ESM, deployed as a Workers module). |
| `cloudflare_workers_secret` | Stores the ROOTKey Connector API Key — encrypted at rest, never visible in plaintext after creation. |
| `cloudflare_queue` (×2) | One main events queue + one dead-letter queue. R2 publishes object-created events to the main queue; the Worker consumes from it. |
| `cloudflare_queue_consumer` | Binds the Worker as the consumer of the events queue with `max_retries = 5` and the DLQ as the failure destination. |
| `cloudflare_r2_bucket_event_notification` | The R2-side trigger: routes `PutObject`, `CompleteMultipartUpload`, and `CopyObject` events from the bucket into the queue. Supports server-side prefix filtering. |

The module **does not** create the R2 bucket — that's a customer-owned resource you point at. It also does not modify any existing event notifications on the bucket; the new notification config is additive.

## How the Worker works

The architecture is intentionally simpler than the AWS/Azure equivalents because Cloudflare Queues handle retries and DLQ routing natively:

1. **R2 → Queue.** When an object is created, R2 publishes an event to the main queue.
2. **Queue → Worker.** The Worker is bound as a queue consumer; it receives batches of up to 25 messages.
3. **Per message**: validate, fetch the object via the R2 binding (in-cluster, no HTTP egress), stream-pipe it through a multipart envelope, POST to the ROOTKey API.
4. **On success**: `message.ack()` — done.
5. **On transient failure** (5xx, 429, network blip): `message.retry()` — the Queue retries with exponential backoff up to 5 times, then sends the message to the DLQ.
6. **On `PermanentError`** (object too large, object no longer exists, ROOTKey 4xx): `message.ack()` + structured log marker `rootkey.event.dlq_terminal_failure` — bypasses the DLQ (which is reserved for "we don't know why this keeps failing").

## Reliability model

- **Per-message retry budget**: 5 attempts at the Queue level with exponential backoff (default Cloudflare Queues behaviour). After exhaustion the message lands in the DLQ.
- **Permanent failure short-circuit**: `PermanentError` (4xx from ROOTKey, oversize, missing object) is caught inside the Worker, acked immediately, and surfaced via a stable log marker. Avoids wasting the Queue's retry budget on known-permanent failures.
- **Server-side prefix filter**: the optional `prefix` variable is enforced at the R2 event-notification layer, so non-matching events never invoke the Worker.
- **Idempotency**: every upload carries `x-rootkey-source-bucket`, `x-rootkey-source-key`, and `x-rootkey-source-etag` headers. The ROOTKey API uses these to deduplicate redelivered events.
- **Live etag override**: the Worker uses the etag from the live R2 object (read at processing time) rather than the etag embedded in the original event, so a successful upload always reflects the version actually anchored.

## Security considerations

- **Secret in a Workers Secret, not in code.** The ROOTKey API key is stored as a `cloudflare_workers_secret`, encrypted at rest. After creation it cannot be read back through the dashboard or API — only mutated via `terraform apply` with a new value.
- **HTTPS-only.** The module rejects non-`https://` ROOTKey API URLs at plan time. The R2 binding read is in-cluster (no HTTP egress involved).
- **No outbound from R2 → Worker.** Cloudflare bills $0/GB for the R2 → Worker read path — both the security and cost story for large files are stronger than the equivalent AWS S3 → Lambda flow.
- **Bucket scope, not account scope.** The R2 binding is scoped to a single bucket. If the Worker is ever compromised, the blast radius is one bucket — not the customer's whole R2 footprint.
- **No additional IAM permissions to grant.** Unlike AWS (where the module attaches a role policy) or Azure (where it grants RBAC roles to a managed identity), the Cloudflare model is "the Worker can use the bindings it was created with" — fewer moving parts to audit.

## Prerequisites

### 1. Cloudflare account access

- A Cloudflare account with R2 enabled.
- An **API token** with permissions to manage Workers, Queues, R2 event notifications, and Workers Secrets in the target account. Generate at [dash.cloudflare.com → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).
- The **Cloudflare Account ID** (visible in the dashboard sidebar).

### 2. A pre-existing R2 bucket

The bucket must already exist. The module does not create it. Bucket name + Cloudflare account ID are required inputs.

### 3. Tooling

- [Terraform](https://developer.hashicorp.com/terraform/install) v1.3 or later.
- [Node.js](https://nodejs.org) 22+ on the machine running Terraform (used to compile the Worker at `terraform apply` time).
- Cloudflare provider credentials configured at the root level (commonly via `CLOUDFLARE_API_TOKEN` env var).

## Setup

1. Create the R2 bucket in your Cloudflare account if it doesn't exist.
2. Create an API token with the permissions listed above. Export it as `CLOUDFLARE_API_TOKEN` (or wire it into your provider config).
3. Create a connector in the ROOTKey dashboard. The bucket name and Cloudflare Account ID are required during the wizard. At the end, the dashboard generates a pre-filled Terraform block — copy it.
4. Apply the module:

```bash
export CLOUDFLARE_API_TOKEN="cf_..."
terraform init
terraform apply
```

5. Within seconds of apply finishing, the Worker is live and R2 events are flowing. Upload a test object to confirm.

## Usage

```hcl
module "rootkey_r2_connector" {
  # Pin to a release tag. Without a ?ref= the source resolves to whatever is on
  # the default branch at the moment you run terraform init, which means two
  # people deploying a week apart can get different code — not acceptable
  # under most change-control regimes.
  source = "github.com/ROOT-Key/rootkey-connectors//r2?ref=v1.0.0"

  cloudflare_account_id = "00112233445566778899aabbccddeeff"
  bucket_name           = "my-company-documents"
  name_suffix           = "acme"                  # 3–12 lowercase alphanumeric chars

  rootkey_api_key = "rk_conn_xxxxxxxxxxxxxxxxxxxx"

  # Optional
  rootkey_api_url     = "https://api.rootkey.ai" # default; only change if instructed
  prefix              = "uploads/"               # default ""; monitor only this prefix
  max_file_size_bytes = 524288000                # default: 500 MiB
  tags = {
    cost-center = "security"
    owner       = "platform-team"
  }
}
```

## Inputs

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `cloudflare_account_id` | string | yes | — | Cloudflare Account ID (32-char hex). |
| `bucket_name` | string | yes | — | Pre-existing R2 bucket to monitor. |
| `name_suffix` | string | yes | — | 3–12 lowercase alphanumeric chars used to namespace the resources. |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Stored as a Workers Secret. |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL. Must use `https://`. |
| `prefix` | string | no | `""` | R2 key prefix filter. Empty = entire bucket. |
| `max_file_size_bytes` | number | no | `524288000` (500 MiB) | Files larger than this are skipped with a structured log marker. |
| `tags` | map(string) | no | `{}` | Tags applied to the Worker script. |

## Outputs

| Name | Description |
|---|---|
| `worker_name` | Name of the deployed Worker. |
| `events_queue_id` / `events_queue_name` | The main events queue. |
| `dlq_queue_id` / `dlq_queue_name` | The dead-letter queue — monitor depth here. |
| `r2_event_notification_id` | The R2 event-notification binding ID. |

## Observability

Cloudflare Workers emit logs via `console.log/warn/error`, which you can view through:
- The Workers tail (`wrangler tail <worker_name>` for live tailing)
- Cloudflare Workers Logs (real-time and historical, in the dashboard)
- Workers Logpush to your own observability stack (Datadog, Splunk, R2)

**Stable log markers** (use these for alerting):

| Marker | Meaning | Suggested alert |
|---|---|---|
| `rootkey.event.dlq_terminal_failure` | A message hit a `PermanentError` (oversize, missing object, 4xx) and was acked without going to the DLQ. | Any occurrence over 15 min → page on-call. |

**What to monitor:**

| Signal | What it means | How to alert |
|---|---|---|
| DLQ queue depth > 0 for more than ~10 min | Transient failures exhausted the retry budget. | Cloudflare dashboard → Queues → depth metric. |
| Worker invocation error rate > 0 | Recurring runtime errors. | Workers Analytics → error count. |
| Worker `subrequests` failing | R2 read or ROOTKey upload throwing. | Workers Logs filter on severity. |
| ROOTKey dashboard connector status `ERROR` | API rejected uploads (invalid key, vault deleted, quota). | Email/Slack via your dashboard notification settings. |

To peek at the DLQ messages:

```bash
# Cloudflare provides DLQ pull via the API:
curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${DLQ_ID}/messages/pull" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 10, "visibility_timeout_ms": 30000}'
```

## Cost

For the resources this module creates, the customer pays:

- **Workers**: Free tier covers 100 K invocations/day; paid plan is $5/month for 10 M + $0.30 per additional million.
- **Queues**: $0.40 per million operations (write + read each count). One R2 event = 1 write + 1 read = 2 operations.
- **R2 storage and reads**: standard R2 pricing applies; the Worker → R2 read is **free** (in-cluster, no egress).
- **Egress to ROOTKey API**: **$0** — Cloudflare does not charge egress.

For typical workloads (a few thousand uploads per month), the recurring cost added to the Cloudflare bill is **under $1/month**, dominated by Queues operations.

## Verification

After `terraform apply`:

1. Upload a test object to the R2 bucket:
   ```bash
   wrangler r2 object put your-bucket/test.txt --file ./test.txt
   ```
2. Within a few seconds the object should appear anchored in the destination ROOTKey vault.
3. Tail the Worker logs to see the upload trace:
   ```bash
   wrangler tail $(terraform output -raw worker_name)
   ```

If nothing arrives:
1. **Check the event notification.** The Cloudflare dashboard → R2 → your bucket → Settings → Event notifications should show the `rootkey-r2-events-*` queue subscribed.
2. **Check the DLQ depth.** Anything > 0 indicates failed messages.
3. **Tail the Worker.** Look for `rootkey.event.dlq_terminal_failure` markers — these surface permanent failures (4xx, oversize, missing object) that the connector caught and acked.
4. **Check the Workers Secret.** The `ROOTKEY_API_KEY` must be set on the Worker (Cloudflare dashboard → Workers → your worker → Settings → Variables and Secrets).

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
