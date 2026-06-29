terraform {
  required_version = ">= 1.3"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
  }
}

data "azurerm_resource_group" "rg" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

resource "random_string" "client_state" {
  length  = 32
  special = false
  upper   = true
  lower   = true
  numeric = true
}

locals {
  drive_hash = substr(sha256(var.drive_id), 0, 8)

  function_name      = substr("rk-od-${var.name_suffix}-${local.drive_hash}", 0, 60)
  storage_name       = substr("rkod${var.name_suffix}${local.drive_hash}", 0, 24)
  key_vault_name     = substr("rkod-kv-${var.name_suffix}-${local.drive_hash}", 0, 24)
  app_insights_name  = "rkod-ai-${var.name_suffix}-${local.drive_hash}"
  log_workspace_name = "rkod-law-${var.name_suffix}-${local.drive_hash}"
  service_plan_name  = "rkod-plan-${var.name_suffix}-${local.drive_hash}"
  identity_name      = "rkod-id-${var.name_suffix}-${local.drive_hash}"

  common_tags = merge(
    {
      "rootkey:managed-by" = "terraform"
      "rootkey:connector"  = "onedrive"
      "rootkey:drive-id"   = substr(var.drive_id, 0, 60)
    },
    var.tags,
  )
}

# ─── Function build ────────────────────────────────────────────────────────────

resource "null_resource" "function_build" {
  # Always rebuild on every apply. Source-hash triggers were too narrow: after
  # `terraform get -update` (which re-clones the module from git and wipes the
  # local dist/ folder), the source files are unchanged so the hashes match
  # state — but the dist/ folder is gone, and `data "archive_file"` fails with
  # "could not archive missing directory". `npm ci && npm run build` is fast
  # (~10s on a warm cache), so the cost of always running is negligible.
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm ci && npm run build"
    working_dir = "${path.module}/function"
  }
}

data "archive_file" "function_zip" {
  type        = "zip"
  source_dir  = "${path.module}/function/dist"
  output_path = "${path.module}/function.zip"

  depends_on = [null_resource.function_build]
}

# ─── User-assigned managed identity for the Function App ───────────────────────
# Created first so role assignments can reference it before the Function App
# itself exists — avoids the chicken-and-egg between identity, RBAC, and the
# Function App's startup (which resolves Key Vault references at boot).

resource "azurerm_user_assigned_identity" "func" {
  name                = local.identity_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  tags                = local.common_tags
}

# ─── Storage Account (function backing + delta state + DLQ) ────────────────────
#
# SECURITY NOTE — shared_access_key_enabled = true
#
# Storage account access keys are enabled because the Azure Functions Consumption
# runtime requires the legacy AzureWebJobsStorage connection string to bootstrap.
# This is the same model used by the majority of Azure Functions deployments.
#
# Mitigations in this module:
#  - The Function App's user-assigned managed identity uses RBAC (not the keys)
#    for the connector's own state operations (delta blob, DLQ queue).
#  - allow_nested_items_to_be_public = false prevents public blob exposure.
#  - min_tls_version = TLS1_2 enforces modern transport security.
#  - public_network_access_enabled defaults to true; tighten via firewall/VNet
#    if your tenancy requires it (Consumption plan limits VNet integration).
#
# Roadmap: migrate to identity-based AzureWebJobsStorage connections once the
# customer is on a plan that supports it (Premium / Flex Consumption / App Service).
# Track: https://learn.microsoft.com/azure/azure-functions/functions-reference#configure-an-identity-based-connection

resource "azurerm_storage_account" "func" {
  name                            = local.storage_name
  resource_group_name             = data.azurerm_resource_group.rg.name
  location                        = data.azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  tags                            = local.common_tags
}

resource "azurerm_storage_container" "state" {
  name                  = "connector-state"
  storage_account_id    = azurerm_storage_account.func.id
  container_access_type = "private"
}

resource "azurerm_storage_queue" "dlq" {
  name               = "rootkey-dlq"
  storage_account_id = azurerm_storage_account.func.id
}

# ─── Key Vault (Graph client secret + ROOTKey API key + webhook secret) ────────

resource "azurerm_key_vault" "kv" {
  name                          = local.key_vault_name
  location                      = data.azurerm_resource_group.rg.location
  resource_group_name           = data.azurerm_resource_group.rg.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.enable_key_vault_purge_protection
  public_network_access_enabled = true
  soft_delete_retention_days    = 7
  tags                          = local.common_tags
}

# Grant the Terraform principal permission to write secrets during apply.
resource "azurerm_role_assignment" "kv_admin_terraform" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "graph_client_secret" {
  name         = "graph-client-secret"
  value        = var.graph_client_secret
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

resource "azurerm_key_vault_secret" "rootkey_api_key" {
  name         = "rootkey-api-key"
  value        = var.rootkey_api_key
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

resource "azurerm_key_vault_secret" "webhook_client_state" {
  name         = "webhook-client-state"
  value        = random_string.client_state.result
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

# ─── Role assignments for the Function App's identity ──────────────────────────

resource "azurerm_role_assignment" "kv_reader_func" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.func.principal_id
}

resource "azurerm_role_assignment" "storage_blob_func" {
  scope                = azurerm_storage_account.func.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.func.principal_id
}

resource "azurerm_role_assignment" "storage_queue_func" {
  scope                = azurerm_storage_account.func.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_user_assigned_identity.func.principal_id
}

# ─── Logs (Log Analytics workspace + Application Insights) ─────────────────────

resource "azurerm_log_analytics_workspace" "law" {
  name                = local.log_workspace_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.common_tags
}

resource "azurerm_application_insights" "ai" {
  name                = local.app_insights_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  workspace_id        = azurerm_log_analytics_workspace.law.id
  application_type    = "Node.JS"
  retention_in_days   = var.log_retention_days
  tags                = local.common_tags
}

# ─── Service plan + Function App ───────────────────────────────────────────────

resource "azurerm_service_plan" "plan" {
  name                = local.service_plan_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  os_type             = "Linux"
  sku_name            = "Y1" # Consumption
  tags                = local.common_tags
}

resource "azurerm_linux_function_app" "func" {
  name                = local.function_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  service_plan_id     = azurerm_service_plan.plan.id

  storage_account_name       = azurerm_storage_account.func.name
  storage_account_access_key = azurerm_storage_account.func.primary_access_key

  https_only = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.func.id]
  }

  key_vault_reference_identity_id = azurerm_user_assigned_identity.func.id

  site_config {
    application_insights_connection_string = azurerm_application_insights.ai.connection_string
    application_insights_key               = azurerm_application_insights.ai.instrumentation_key
    ftps_state                             = "Disabled"
    minimum_tls_version                    = "1.2"
    http2_enabled                          = true

    # No `cors {}` block: the Azure Function App default is no CORS configuration
    # at all, which means browsers receive no Access-Control-Allow-Origin headers
    # and cross-origin requests are blocked. The webhook is called by Microsoft
    # Graph server-to-server, so this is the correct posture. An explicit empty
    # allowed_origins list is rejected by the azurerm provider (min 1 item).

    application_stack {
      node_version = "22"
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME       = "node"
    WEBSITE_NODE_DEFAULT_VERSION   = "~22"
    WEBSITE_RUN_FROM_PACKAGE       = "1"
    SCM_DO_BUILD_DURING_DEPLOYMENT = "false"

    # Required by the Azure Functions Node.js v4 programming model: we register
    # functions programmatically (app.http/app.timer/app.storageQueue) instead
    # of providing function.json files. Without this flag, the host falls back
    # to the v3 discovery path and finds zero functions.
    AzureWebJobsFeatureFlags = "EnableWorkerIndexing"

    # Fail the worker boot loudly if our bundle throws on import — otherwise
    # startup errors get silently swallowed and the host runs with no
    # registered functions.
    FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR = "true"

    ROOTKEY_API_URL     = var.rootkey_api_url
    MAX_FILE_SIZE_BYTES = tostring(var.max_file_size_bytes)

    GRAPH_TENANT_ID = var.graph_tenant_id
    GRAPH_CLIENT_ID = var.graph_client_id
    GRAPH_DRIVE_ID  = var.drive_id

    STATE_STORAGE_ACCOUNT = azurerm_storage_account.func.name
    STATE_CONTAINER_NAME  = azurerm_storage_container.state.name
    DLQ_QUEUE_NAME        = azurerm_storage_queue.dlq.name
    UAMI_CLIENT_ID        = azurerm_user_assigned_identity.func.client_id

    GRAPH_CLIENT_SECRET  = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.graph_client_secret.versionless_id})"
    ROOTKEY_API_KEY      = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.rootkey_api_key.versionless_id})"
    WEBHOOK_CLIENT_STATE = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.webhook_client_state.versionless_id})"
  }

  zip_deploy_file = data.archive_file.function_zip.output_path
  tags            = local.common_tags

  depends_on = [
    azurerm_role_assignment.kv_reader_func,
    azurerm_role_assignment.storage_blob_func,
    azurerm_role_assignment.storage_queue_func,
    azurerm_key_vault_secret.graph_client_secret,
    azurerm_key_vault_secret.rootkey_api_key,
    azurerm_key_vault_secret.webhook_client_state,
  ]
}
