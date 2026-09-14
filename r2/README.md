# Cloudflare R2 Connector

Deploys a serverless integration into your Cloudflare account. A Cloudflare Worker (TypeScript, V8 isolate) consumes R2 event notifications from a Cloudflare Queue and streams each new object to the ROOTKey API using your Connector API Key.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## What this module creates

| Resource | Purpose |
|---|---|
| `cloudflare_workers_script` | The connector itself (TypeScript bundled to ESM, deployed as a Workers module), including its bindings: the R2 bucket, the plain-text config, and the ROOTKey Connector API Key as a `secret_text` binding. |
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

- **Secret in a Workers secret binding, not in code.** The ROOTKey API key is delivered as a `secret_text` binding on the Worker, encrypted at rest by Cloudflare. It cannot be read back through the dashboard or API — only overwritten via `terraform apply` with a new value. It *is*, however, written to the Terraform state file; read [Secrets and Terraform state](#secrets-and-terraform-state) before you choose where that state lives.
- **HTTPS-only.** The module rejects non-`https://` ROOTKey API URLs at plan time. The R2 binding read is in-cluster (no HTTP egress involved).
- **No outbound from R2 → Worker.** Cloudflare bills $0/GB for the R2 → Worker read path — both the security and cost story for large files are stronger than the equivalent AWS S3 → Lambda flow.
- **Bucket scope, not account scope.** The R2 binding is scoped to a single bucket. If the Worker is ever compromised, the blast radius is one bucket — not the customer's whole R2 footprint.
- **No additional IAM permissions to grant.** Unlike AWS (where the module attaches a role policy) or Azure (where it grants RBAC roles to a managed identity), the Cloudflare model is "the Worker can use the bindings it was created with" — fewer moving parts to audit.

## Secrets and Terraform state

Terraform records the attributes of everything it manages in a state file. By default that includes the *value* of any secret you pass in — marking a variable `sensitive` only masks it in CLI output, it does not keep it off disk. For a regulated environment that is usually the first question asked about an IaC module, so it is worth being precise about what this one does.

**Read this first: this connector behaves differently from the other three.** In the sharepoint, onedrive and aws-s3 modules the secrets you supply are never written to state — they use *write-only arguments* (`value_wo` on `azurerm_key_vault_secret`, `secret_string_wo` on `aws_secretsmanager_secret_version`), so the provider receives the value, sends it to the vault, and Terraform persists nothing.

**The Cloudflare provider offers no equivalent, so `rootkey_api_key` IS persisted to `terraform.tfstate`.**

This is a limitation of the provider, not a choice of this module. It was verified against the schema the pinned version actually ships rather than assumed from the docs — the check below reports `0` on cloudflare/cloudflare v5.25.0, across all 264 of its resources:

```bash
terraform providers schema -json | jq '[.provider_schemas."registry.terraform.io/cloudflare/cloudflare" | .. | objects | select(.write_only == true)] | length'
```

The recursive descent (`..`) matters: write-only attributes can be nested inside a
resource's attribute types — `cloudflare_workers_script.bindings` is exactly such a
nested type — so a scan that only walks top-level attributes would miss them.

Re-run it when you bump the provider floor. If it ever returns non-zero, this module should move to the write-only argument and this section should shrink to match the other three.

The consequences are worth stating plainly:

- The API key appears in `terraform.tfstate` under `cloudflare_workers_script.connector`, in the `bindings` entry named `ROOTKEY_API_KEY`. It is also present in any saved plan file (`terraform plan -out=…`).
- `rootkey_api_key` is therefore **not** declared `ephemeral`, and there is no `rootkey_api_key_version` rotation counter here. Both exist in the other three connectors only to serve write-only arguments; without such an argument to feed, an ephemeral value cannot legally reach a resource argument at all, and Terraform would reject the configuration.
- The upside of that: Terraform *can* see this value, so rotation is a one-step change — update `rootkey_api_key` and apply. There is no silent-no-op sharp edge to remember.

You can confirm the exposure yourself after an apply — unlike the other three connectors, this prints a non-zero count:

```bash
grep -c "rk_conn_" terraform.tfstate
```

**What else lives in the state file:**

| What | Why it is there |
|---|---|
| `rootkey_api_key` (as a Worker binding) | The limitation described above. |
| The compiled Worker bundle (`data.local_file.worker_bundle.content`) | The built `dist/index.js`, read in to be uploaded. Not secret — it is the source in this repo. |
| Queue IDs and names, the Worker name, the event-notification config | Infrastructure metadata, not credentials. |

**What to do about it.** Treat the state file itself as a secret, at the same classification as the API key:

1. **Use a remote backend with encryption at rest and least-privilege access.** R2 works as an S3-compatible backend and keeps the state in the same account as the rest of this deployment:

   ```hcl
   terraform {
     backend "s3" {
       bucket                      = "my-tfstate"
       key                         = "rootkey-connector.tfstate"
       region                      = "auto"
       endpoints                   = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
       skip_credentials_validation = true
       skip_region_validation      = true
       skip_requesting_account_id  = true
       skip_s3_checksum            = true
       use_lockfile                = true # state locking
     }
   }
   ```

2. **Never commit state.** `r2/.gitignore` already excludes `*.tfstate` and `*.tfstate.backup`; keep it that way.
3. **Scope the blast radius.** A Connector API Key grants upload to one ROOTKey vault — it is not a credential to your Cloudflare account. If the state file is exposed, rotate the key (see [Operational notes](#operational-notes)); you do not need to rebuild the deployment.
4. **Do not pass the key on the command line.** `-var="rootkey_api_key=…"` lands in your shell history. Use `TF_VAR_rootkey_api_key` from a secret manager, or a `.tfvars` file that is gitignored.

## Prerequisites

### 1. Cloudflare account access

- A Cloudflare account with R2 enabled.
- An **API token** with permissions to manage Workers Scripts, Queues, and R2 event notifications in the target account. (There is no separate "Workers Secrets" permission to grant: since provider v5 the API key is a binding on the Worker script itself, so Workers Scripts edit is what covers it.) Generate at [dash.cloudflare.com → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).
- The **Cloudflare Account ID** (visible in the dashboard sidebar).

### 2. A pre-existing R2 bucket

The bucket must already exist. The module does not create it. Bucket name + Cloudflare account ID are required inputs.

### 3. Tooling

- [Terraform](https://developer.hashicorp.com/terraform/install) **v1.11 or later**. The four connectors in this repo share one floor so there is a single version to support; sharepoint, onedrive and aws-s3 genuinely require it for write-only arguments, and this module matches them. Older versions fail at `terraform init` with an explicit version error.
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

  # Prefer TF_VAR_rootkey_api_key from a secret manager over an inline literal:
  # this value is persisted to state. See "Secrets and Terraform state" above.
  rootkey_api_key = var.rootkey_api_key

  # Optional
  rootkey_api_url     = "https://api.rootkey.ai" # default; only change if instructed
  prefix              = "uploads/"               # default ""; monitor only this prefix
  max_file_size_bytes = 524288000                # default: 500 MiB
}
```

## Inputs

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `cloudflare_account_id` | string | yes | — | Cloudflare Account ID (32-char hex). |
| `bucket_name` | string | yes | — | Pre-existing R2 bucket to monitor. |
| `name_suffix` | string | yes | — | 3–12 lowercase alphanumeric chars used to namespace the resources. |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Delivered as a `secret_text` binding on the Worker. **Persisted to Terraform state** — see [Secrets and Terraform state](#secrets-and-terraform-state). |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL. Must use `https://`. |
| `prefix` | string | no | `""` | R2 key prefix filter. Empty = entire bucket. |
| `max_file_size_bytes` | number | no | `524288000` (500 MiB) | Files larger than this are skipped with a structured log marker. |

There is deliberately no `rootkey_api_key_version` input here. The other three connectors use one to tell Terraform that a write-only secret changed; this module has no write-only argument to feed, and Terraform can see the value directly, so the counter would do nothing.

## Outputs

| Name | Description |
|---|---|
| `worker_name` | Name of the deployed Worker. |
| `events_queue_id` / `events_queue_name` | The main events queue. |
| `dlq_queue_id` / `dlq_queue_name` | The dead-letter queue — monitor depth here. |
| `r2_event_notification_bucket` | Bucket the R2 event-notification binding is attached to. |

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

## Operational notes

- **Rotating the ROOTKey API key.** Create a replacement connector in the ROOTKey dashboard (reuse the same bucket and Cloudflare account), then update `rootkey_api_key` and run `terraform apply`. That is the whole procedure — unlike the other three connectors there is no version counter to increment, because Terraform can see this value and detects the change itself.

  Apply first and revoke the old key in the dashboard afterwards, once the connector is confirmed healthy. A Worker deployment is effectively instant, but in-flight queue messages picked up by the previous version may still be using the old key for a few seconds.

  Rotate through `terraform apply`, not through `wrangler secret put` or the dashboard. A secret changed outside Terraform is reverted on the next apply, because the value in state is what the module reconciles against.

  Rotate the key if the Terraform state file is ever exposed — see [Secrets and Terraform state](#secrets-and-terraform-state).

- **Changing `prefix` or `max_file_size_bytes`.** Both are ordinary in-place updates. `prefix` re-writes the R2 event notification; `max_file_size_bytes` re-deploys the Worker with a new plain-text binding. Neither drains the queue, so messages already in flight are processed under the old setting.

- **Every apply rebuilds and re-uploads the Worker.** `null_resource.worker_build` is triggered on `timestamp()`, so `terraform plan` always shows a Worker update even when nothing changed. This is deliberate — see the comment in `main.tf` — and means a plan diff on `cloudflare_workers_script` is not by itself a sign that something drifted.

- **Upgrading from a pre-v5-provider version of this module.** The Cloudflare provider v5 migration changed the module's public surface. If you are bumping an existing deployment:

  | Change | What to do |
  |---|---|
  | The `tags` input was **removed** | Delete it from your module block. No version of provider v5 accepts `tags` on `cloudflare_workers_script`, and no other resource this module creates accepts them either. Leaving it in place fails at plan time with "An argument named `tags` is not expected here". |
  | The `r2_event_notification_id` output was **renamed** to `r2_event_notification_bucket` | Update any reference. `cloudflare_r2_bucket_event_notification` exports no `id` in v5. |
  | `cloudflare_workers_secret` is gone | **Requires one manual step before you can plan.** The key moves into the Worker's `secret_text` binding, but the old resource is still recorded in your state file and provider v5.25 no longer has a schema for it — so *every* `terraform plan` aborts with `no schema available for cloudflare_workers_secret.rootkey_api_key while reading state; this is a bug in Terraform and should be reported`. It is not a Terraform bug and re-running does not help. Drop the orphaned entry first: `terraform state rm cloudflare_workers_secret.rootkey_api_key`. That only makes Terraform forget the resource — it does not delete the secret from Cloudflare — and the next apply rewrites the same `ROOTKEY_API_KEY` value as a binding, so the Worker never goes without it. |
  | The dead-letter queue is now actually wired | `dead_letter_queue` was previously nested inside `settings`, where the provider ignored it, so exhausted messages were dropped rather than routed to the DLQ. The first apply after this upgrade fixes that. |

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
4. **Check the secret binding.** `ROOTKEY_API_KEY` must be listed on the Worker as a secret (Cloudflare dashboard → Workers → your worker → Settings → Variables and Secrets). The value is masked there; only its presence is verifiable.

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
