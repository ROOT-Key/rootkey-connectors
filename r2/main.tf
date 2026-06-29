terraform {
  required_version = ">= 1.3"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# The Cloudflare provider authentication (api_token or email + api_key) is configured
# by the customer in their own root config — this module only requires the provider
# to be aliased / present, not configured here.

locals {
  bucket_hash = substr(sha256(var.bucket_name), 0, 8)

  worker_name        = substr("rootkey-r2-${var.name_suffix}-${local.bucket_hash}", 0, 63)
  events_queue_name  = substr("rootkey-r2-events-${var.name_suffix}-${local.bucket_hash}", 0, 63)
  dlq_queue_name     = substr("rootkey-r2-dlq-${var.name_suffix}-${local.bucket_hash}", 0, 63)
  worker_module_name = "index.js"
}

# ─── Worker build ──────────────────────────────────────────────────────────────

resource "null_resource" "worker_build" {
  # Always rebuild on every apply. Source-hash triggers were too narrow: after
  # `terraform get -update` (which re-clones the module from git and wipes the
  # local dist/ folder), the source files are unchanged so the hashes match
  # state — but the dist/ folder is gone, and `data "local_file"` fails with
  # "no such file or directory". `npm ci && npm run build` is fast (~10s on a
  # warm cache), so the cost of always running is negligible.
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm ci && npm run build"
    working_dir = "${path.module}/worker"
  }
}

# Read the freshly-built bundle into Terraform state for upload.
data "local_file" "worker_bundle" {
  filename   = "${path.module}/worker/dist/index.js"
  depends_on = [null_resource.worker_build]
}

# ─── Main events queue + Dead-Letter Queue ─────────────────────────────────────

# Dead-letter queue. Messages that fail max_retries times on the main queue land
# here. The connector does NOT consume the DLQ — it is read-only for operators.
# Permanent failures (oversize, 4xx) bypass this queue entirely and surface via
# the structured `rootkey.event.dlq_terminal_failure` log marker instead.
resource "cloudflare_queue" "dlq" {
  account_id = var.cloudflare_account_id
  queue_name = local.dlq_queue_name
}

# Main events queue. R2 publishes object-created events here; the Worker consumes
# them. Cloudflare Queues handle retries + DLQ routing natively — see consumer
# settings below.
resource "cloudflare_queue" "events" {
  account_id = var.cloudflare_account_id
  queue_name = local.events_queue_name
}

# ─── Worker script ─────────────────────────────────────────────────────────────

resource "cloudflare_workers_script" "connector" {
  account_id  = var.cloudflare_account_id
  script_name = local.worker_name
  main_module = local.worker_module_name

  content = data.local_file.worker_bundle.content

  bindings = concat(
    [
      {
        name        = "BUCKET"
        type        = "r2_bucket"
        bucket_name = var.bucket_name
      },
      {
        name = "ROOTKEY_API_URL"
        type = "plain_text"
        text = var.rootkey_api_url
      },
      {
        name = "MAX_FILE_SIZE_BYTES"
        type = "plain_text"
        text = tostring(var.max_file_size_bytes)
      },
    ],
  )

  tags = var.tags
}

# Connector API Key — held as a Workers Secret (encrypted at rest, never visible
# in plaintext through the dashboard or API after creation).
resource "cloudflare_workers_secret" "rootkey_api_key" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.connector.script_name
  name        = "ROOTKEY_API_KEY"
  secret_text = var.rootkey_api_key
}

# ─── Queue → Worker wiring ─────────────────────────────────────────────────────

resource "cloudflare_queue_consumer" "events" {
  account_id = var.cloudflare_account_id
  queue_id   = cloudflare_queue.events.id
  type       = "worker"
  script_name = cloudflare_workers_script.connector.script_name

  settings = {
    batch_size        = 25
    max_retries       = 5
    max_wait_time_ms  = 5000
    dead_letter_queue = cloudflare_queue.dlq.queue_name
  }
}

# ─── R2 → Queue wiring (event notification) ────────────────────────────────────

# Forwards `object-created` events on the customer's bucket to the events queue.
# This is the equivalent of the S3 EventBridge rule. R2 supports server-side
# prefix filters so we save Worker invocations when only a subset of the bucket
# is interesting.
resource "cloudflare_r2_bucket_event_notification" "rootkey" {
  account_id  = var.cloudflare_account_id
  bucket_name = var.bucket_name
  queue_id    = cloudflare_queue.events.id

  rules = [
    {
      actions = ["PutObject", "CompleteMultipartUpload", "CopyObject"]
      prefix  = var.prefix != "" ? var.prefix : null
    },
  ]

  depends_on = [
    cloudflare_queue_consumer.events,
    cloudflare_workers_secret.rootkey_api_key,
  ]
}
