variable "resource_group_name" {
  type        = string
  description = "Name of a pre-existing Azure Resource Group where the connector will be deployed. The Terraform principal must have Contributor (or equivalent) on this RG."

  validation {
    condition     = can(regex("^[a-zA-Z0-9._()-]{1,90}$", var.resource_group_name))
    error_message = "resource_group_name must be 1–90 chars and use only letters, digits, hyphens, periods, underscores or parentheses."
  }
}

variable "azure_location" {
  type        = string
  description = "Azure region where the connector resources will be created (e.g. westeurope, northeurope, eastus)."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]+$", var.azure_location))
    error_message = "azure_location must be a valid Azure region identifier (lowercase, no spaces), e.g. westeurope."
  }
}

variable "name_suffix" {
  type        = string
  description = "Short suffix used to make resource names unique across the subscription (e.g. 'acme' or 'prod'). 3–12 lowercase alphanumeric chars."

  validation {
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_suffix))
    error_message = "name_suffix must be 3–12 lowercase alphanumeric chars."
  }
}

variable "graph_tenant_id" {
  type        = string
  description = "Azure Entra ID tenant ID (a UUID) of the Microsoft 365 tenant whose OneDrive will be monitored."

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.graph_tenant_id))
    error_message = "graph_tenant_id must be a UUID."
  }
}

variable "graph_client_id" {
  type        = string
  description = "Application (client) ID of the pre-existing App Registration used to call Microsoft Graph. Requires Files.Read.All application permission with admin consent."

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.graph_client_id))
    error_message = "graph_client_id must be a UUID."
  }
}

variable "graph_client_secret" {
  type        = string
  sensitive   = true
  ephemeral   = true
  description = "Client secret value generated for the App Registration. Written to Azure Key Vault; the Function App resolves it at startup via Key Vault references. Marked ephemeral and written with a write-only argument, so the value is never persisted to terraform.tfstate nor to a saved plan file. When you rotate it, you must also increment graph_client_secret_version."

  validation {
    condition     = length(var.graph_client_secret) > 0
    error_message = "graph_client_secret must not be empty."
  }
}

variable "graph_client_secret_version" {
  type        = number
  default     = 1
  description = "Rotation counter for graph_client_secret. Increment it every time graph_client_secret changes. Because graph_client_secret is written as a write-only argument, Terraform never sees its value and therefore cannot detect that it changed — this counter is the only signal that the secret must be re-written to Key Vault. Change the secret without incrementing this and the new value is silently ignored."

  validation {
    condition     = var.graph_client_secret_version >= 1
    error_message = "graph_client_secret_version must be >= 1."
  }
}

variable "drive_id" {
  type        = string
  description = "Microsoft Graph drive ID of the OneDrive drive to monitor. Find it via GET https://graph.microsoft.com/v1.0/users/{userId}/drives — the response contains an 'id' field per drive."

  validation {
    condition     = length(var.drive_id) > 0
    error_message = "drive_id must not be empty."
  }
}

variable "rootkey_api_key" {
  type        = string
  sensitive   = true
  ephemeral   = true
  description = "Connector API Key from the ROOTKey dashboard. Written to Azure Key Vault; the Function App resolves it at startup via Key Vault references. Marked ephemeral and written with a write-only argument, so the value is never persisted to terraform.tfstate nor to a saved plan file. When you rotate it, you must also increment rootkey_api_key_version."

  validation {
    condition     = length(var.rootkey_api_key) > 0
    error_message = "rootkey_api_key must not be empty."
  }
}

variable "rootkey_api_key_version" {
  type        = number
  default     = 1
  description = "Rotation counter for rootkey_api_key. Increment it every time rootkey_api_key changes. Because rootkey_api_key is written as a write-only argument, Terraform never sees its value and therefore cannot detect that it changed — this counter is the only signal that the secret must be re-written to Key Vault. Change the secret without incrementing this and the new value is silently ignored."

  validation {
    condition     = var.rootkey_api_key_version >= 1
    error_message = "rootkey_api_key_version must be >= 1."
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

variable "max_file_size_bytes" {
  type        = number
  default     = 524288000 # 500 MiB
  description = "Maximum file size (in bytes) the Function App will forward to ROOTKey. Files above this are skipped with an error. Default 500 MiB; raise only after increasing the Function App SKU."

  validation {
    condition     = var.max_file_size_bytes > 0 && var.max_file_size_bytes <= 5368709120
    error_message = "max_file_size_bytes must be between 1 and 5368709120 (5 GiB)."
  }
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "Number of days to retain Application Insights / Log Analytics data for the Function App."

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730 (Application Insights limits)."
  }
}

variable "enable_key_vault_purge_protection" {
  type        = bool
  default     = true
  description = "Whether to enable purge protection on the Key Vault holding the connector secrets. Production default is true (prevents accidental permanent deletion before the soft-delete window). Set to false only during short-lived pilots — once enabled, purge protection CANNOT be disabled, and the Key Vault cannot be fully purged until the soft-delete retention window elapses (7 days)."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Extra tags applied to every resource created by this module. Module-managed tags (rootkey:managed-by, rootkey:connector, rootkey:drive-id) cannot be overridden."
}
