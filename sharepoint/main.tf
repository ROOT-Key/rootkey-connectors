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
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
}

provider "azurerm" {
  # storage_use_azuread = true lets the provider use AAD-based auth for storage
  # data-plane operations (e.g. uploading the deployment blob). Required because
  # we disable shared access keys on the storage account.
  storage_use_azuread = true
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
  site_hash = substr(sha256(var.site_url), 0, 8)

  function_name      = substr("rk-sp-${var.name_suffix}-${local.site_hash}", 0, 60)
  storage_name       = substr("rksp${var.name_suffix}${local.site_hash}", 0, 24)
  key_vault_name     = substr("rksp-kv-${var.name_suffix}-${local.site_hash}", 0, 24)
  app_insights_name  = "rksp-ai-${var.name_suffix}-${local.site_hash}"
  log_workspace_name = "rksp-law-${var.name_suffix}-${local.site_hash}"
  service_plan_name  = "rksp-plan-${var.name_suffix}-${local.site_hash}"
  identity_name      = "rksp-id-${var.name_suffix}-${local.site_hash}"

  deployment_package_endpoint = "${azurerm_storage_account.func.primary_blob_endpoint}deploymentpackage"

  common_tags = merge(
    {
      "rootkey:managed-by" = "terraform"
      "rootkey:connector"  = "sharepoint"
      "rootkey:site-url"   = substr(var.site_url, 0, 100)
    },
    var.tags,
  )
}

# ─── Function build ────────────────────────────────────────────────────────────

resource "null_resource" "function_build" {
  # Always rebuild on every apply so the deployment artifact is fresh. The build
  # itself is fast (~10s with a warm npm cache) and ensures the bundle exists
  # even after `terraform get -update` re-clones the module and wipes dist/.
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

resource "azurerm_user_assigned_identity" "func" {
  name                = local.identity_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  tags                = local.common_tags
}

# ─── Storage Account ───────────────────────────────────────────────────────────
#
# Shared access keys are DISABLED. The Function App reaches storage exclusively
# through its user-assigned managed identity (Storage Blob Data Owner +
# Storage Queue Data Contributor). This is supported on Flex Consumption — the
# previous Linux Consumption (Y1) SKU required the legacy connection string and
# could not turn off shared keys, which is one of the reasons for moving to FC1.

resource "azurerm_storage_account" "func" {
  name                            = local.storage_name
  resource_group_name             = data.azurerm_resource_group.rg.name
  location                        = data.azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  tags                            = local.common_tags
}

# Container for the connector's own state (delta cursors, subscriptions registry,
# sync lock blobs). Used by the Worker code via the managed identity.
resource "azurerm_storage_container" "state" {
  name                  = "connector-state"
  storage_account_id    = azurerm_storage_account.func.id
  container_access_type = "private"
}

# Container that Flex Consumption pulls the deployment zip from. The Function
# App is configured to watch this container and reload when a new blob lands.
resource "azurerm_storage_container" "deployment" {
  name                  = "deploymentpackage"
  storage_account_id    = azurerm_storage_account.func.id
  container_access_type = "private"
}

resource "azurerm_storage_queue" "dlq" {
  name               = "rootkey-dlq"
  storage_account_id = azurerm_storage_account.func.id
}

# AAD role assignments are eventually consistent — they typically take 30-60s
# to propagate. Without this explicit wait, the blob upload below races with
# the role assignment for the Terraform principal and fails with a 403 on a
# fresh apply (we saw this with status 403 "not authorized to perform this
# operation using this permission").
resource "time_sleep" "wait_for_storage_rbac" {
  depends_on      = [azurerm_role_assignment.storage_blob_terraform]
  create_duration = "60s"
}

# Upload the freshly-built function bundle to the deployment container. The blob
# name is content-hashed so that Flex Consumption sees a "new" deployment when
# the bundle changes and reloads the worker; if the bundle is unchanged the blob
# name is the same and Terraform / Flex are both no-ops.
resource "azurerm_storage_blob" "deployment_package" {
  # Hex SHA-256 (output_sha256) instead of base64 (output_base64sha256): the
  # base64 alphabet includes '/' which Azure Blob Storage treats as a virtual
  # subdirectory separator, so the blob ends up nested inside a virtual folder
  # that Flex Consumption can't discover. Hex avoids that entirely.
  name                   = "function-${data.archive_file.function_zip.output_sha256}.zip"
  storage_account_name   = azurerm_storage_account.func.name
  storage_container_name = azurerm_storage_container.deployment.name
  type                   = "Block"
  source                 = data.archive_file.function_zip.output_path
  content_md5            = data.archive_file.function_zip.output_md5

  depends_on = [
    azurerm_role_assignment.storage_blob_terraform,
    time_sleep.wait_for_storage_rbac,
  ]
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

# ─── Role assignments ──────────────────────────────────────────────────────────

# Terraform principal needs to write blobs (upload the deployment package).
resource "azurerm_role_assignment" "storage_blob_terraform" {
  scope                = azurerm_storage_account.func.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Function App identity needs to:
#  - Read the deployment package (Flex Consumption pulls the zip from blob storage)
#  - Read/write its own state blobs and DLQ queue
#  - Read Key Vault secrets
# Storage Blob Data Owner gives both deployment-package and state-blob access in
# one role; matches the Microsoft Flex Consumption reference sample.
resource "azurerm_role_assignment" "kv_reader_func" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.func.principal_id
}

resource "azurerm_role_assignment" "storage_blob_func" {
  scope                = azurerm_storage_account.func.id
  role_definition_name = "Storage Blob Data Owner"
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

# ─── Service plan + Function App (Flex Consumption) ───────────────────────────

resource "azurerm_service_plan" "plan" {
  name                = local.service_plan_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  os_type             = "Linux"
  sku_name            = "FC1" # Flex Consumption (Linux Consumption Y1 is Retiring)
  tags                = local.common_tags
}

resource "azurerm_function_app_flex_consumption" "func" {
  name                = local.function_name
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  service_plan_id     = azurerm_service_plan.plan.id

  # Deployment package source: Flex Consumption pulls the zip directly from a
  # blob container, watching for new blobs. We upload the zip via
  # azurerm_storage_blob.deployment_package above.
  storage_container_type      = "blobContainer"
  storage_container_endpoint  = local.deployment_package_endpoint
  storage_authentication_type = "UserAssignedIdentity"
  storage_user_assigned_identity_id = azurerm_user_assigned_identity.func.id

  # Node.js v4 programming model is first-class on Flex — no EnableWorkerIndexing
  # flag needed, no function.json files. The Worker registers functions in code
  # via app.http()/app.timer()/app.storageQueue().
  runtime_name    = "node"
  runtime_version = "22"

  # 512 MB is sufficient for our streaming workload (file pipes through, never
  # buffers the whole content in memory). Larger sizes increase GB-s cost
  # proportionally for negligible benefit on this workload.
  instance_memory_in_mb = 512

  # Cap concurrent scale-out. A single drive's webhook fan-out rarely exceeds
  # a handful of concurrent invocations; the per-drive sync lease serializes
  # within a drive regardless.
  maximum_instance_count = 40

  https_only = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.func.id]
  }

  # With a single UAMI attached, the Functions runtime uses it automatically
  # for resolving @Microsoft.KeyVault(...) references in app_settings — there
  # is no key_vault_reference_identity_id attribute on this resource type.

  site_config {
    application_insights_connection_string = azurerm_application_insights.ai.connection_string
  }

  app_settings = {
    # Identity-based connection to AzureWebJobsStorage. The empty
    # AzureWebJobsStorage value is a workaround for an azurerm provider quirk —
    # it must be present (even empty) alongside the __accountName attribute.
    # See https://github.com/hashicorp/terraform-provider-azurerm/pull/29099
    AzureWebJobsStorage             = ""
    AzureWebJobsStorage__accountName = azurerm_storage_account.func.name

    ROOTKEY_API_URL     = var.rootkey_api_url
    MAX_FILE_SIZE_BYTES = tostring(var.max_file_size_bytes)

    GRAPH_TENANT_ID = var.graph_tenant_id
    GRAPH_CLIENT_ID = var.graph_client_id
    GRAPH_SITE_URL  = var.site_url

    STATE_STORAGE_ACCOUNT = azurerm_storage_account.func.name
    STATE_CONTAINER_NAME  = azurerm_storage_container.state.name
    DLQ_QUEUE_NAME        = azurerm_storage_queue.dlq.name
    UAMI_CLIENT_ID        = azurerm_user_assigned_identity.func.client_id

    GRAPH_CLIENT_SECRET  = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.graph_client_secret.versionless_id})"
    ROOTKEY_API_KEY      = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.rootkey_api_key.versionless_id})"
    WEBHOOK_CLIENT_STATE = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.webhook_client_state.versionless_id})"
  }

  tags = local.common_tags

  depends_on = [
    azurerm_role_assignment.kv_reader_func,
    azurerm_role_assignment.storage_blob_func,
    azurerm_role_assignment.storage_queue_func,
    azurerm_storage_blob.deployment_package,
    azurerm_key_vault_secret.graph_client_secret,
    azurerm_key_vault_secret.rootkey_api_key,
    azurerm_key_vault_secret.webhook_client_state,
  ]
}
