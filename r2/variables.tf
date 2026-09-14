variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare Account ID where the R2 bucket lives and the connector will be deployed. Find it in the Cloudflare dashboard under the account selector."

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex string (Cloudflare Account ID format)."
  }
}

variable "bucket_name" {
  type        = string
  description = "Name of the R2 bucket to monitor. The bucket must already exist in the Cloudflare account specified above."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid R2 bucket name (3–63 lowercase alphanumeric chars and hyphens; cannot start or end with a hyphen)."
  }
}

variable "name_suffix" {
  type        = string
  description = "Short suffix used to make resource names unique across the Cloudflare account (e.g. 'acme' or 'prod'). 3–12 lowercase alphanumeric chars."

  validation {
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_suffix))
    error_message = "name_suffix must be 3–12 lowercase alphanumeric chars."
  }
}

variable "rootkey_api_key" {
  type        = string
  sensitive   = true
  description = "Connector API Key from the ROOTKey dashboard. Delivered to the Worker as a `secret_text` binding, which the Worker reads from `env.ROOTKEY_API_KEY` at runtime. NOTE: unlike the sharepoint/onedrive/aws-s3 connectors, this value IS persisted to terraform.tfstate — the Cloudflare provider implements no write-only argument to avoid it. See README.md -> \"Secrets and Terraform state\"."

  validation {
    condition     = length(var.rootkey_api_key) > 0
    error_message = "rootkey_api_key must not be empty."
  }
}

variable "rootkey_api_url" {
  type        = string
  default     = "https://api.rootkey.ai"
  description = "ROOTKey API base URL. Must use https://."

  validation {
    condition     = startswith(var.rootkey_api_url, "https://")
    error_message = "rootkey_api_url must start with https:// — plaintext HTTP is not supported."
  }
}

variable "prefix" {
  type        = string
  default     = ""
  description = "R2 key prefix filter. Leave empty to monitor the entire bucket. Filtering happens server-side at the R2 event-notification layer, so non-matching events never reach the Worker."
}

variable "max_file_size_bytes" {
  type        = number
  default     = 524288000 # 500 MiB
  description = "Maximum object size (in bytes) the Worker will forward to ROOTKey. Objects above this are skipped with a structured log marker (`rootkey.event.dlq_terminal_failure`). Default 500 MiB matches the Cloudflare Workers paid-plan practical streaming ceiling."

  validation {
    condition     = var.max_file_size_bytes > 0 && var.max_file_size_bytes <= 5368709120
    error_message = "max_file_size_bytes must be between 1 and 5368709120 (5 GiB). Above ~500 MiB you may also need to upgrade the Workers plan to keep CPU/memory headroom."
  }
}
