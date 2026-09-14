terraform {
  # 1.11 is the floor for write-only arguments. They are what keeps the
  # customer-supplied secrets out of terraform.tfstate and out of any saved
  # plan file. `ephemeral` input variables alone would only need 1.10, but the
  # two mechanisms are only useful together: ephemeral keeps the value out of
  # the plan, write-only keeps it out of the state.
  required_version = ">= 1.11"
  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # Floor verified to expose value_wo / value_wo_version on
      # azurerm_key_vault_secret. Do not loosen to "~> 4.0".
      version = ">= 4.79.0, < 5.0.0"
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
  # storage_use_azuread = true forces AAD-based auth for any storage data-plane
  # operations the provider performs. Required because we disable shared access
  # keys on the storage account; without it the provider falls back to shared
  # key auth and any data-plane call fails.
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
  drive_hash = substr(sha256(var.drive_id), 0, 8)

  function_name      = substr("rk-od-${var.name_suffix}-${local.drive_hash}", 0, 60)
  storage_name       = substr("rkod${var.name_suffix}${local.drive_hash}", 0, 24)
  key_vault_name     = substr("rkod-kv-${var.name_suffix}-${local.drive_hash}", 0, 24)
  app_insights_name  = "rkod-ai-${var.name_suffix}-${local.drive_hash}"
  log_workspace_name = "rkod-law-${var.name_suffix}-${local.drive_hash}"
  service_plan_name  = "rkod-plan-${var.name_suffix}-${local.drive_hash}"
  identity_name      = "rkod-id-${var.name_suffix}-${local.drive_hash}"

  deployment_package_endpoint = "${azurerm_storage_account.func.primary_blob_endpoint}deploymentpackage"

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
#
# We ship the function/ folder as a ready-to-run package — the same shape Azure
# Functions Core Tools produces when you run `func azure functionapp publish`:
#
#   function/
#   ├── host.json
#   ├── package.json   (main = "dist/index.js")
#   ├── node_modules/  (production deps only — devDeps pruned after build)
#   └── dist/          (compiled JS from tsc)
#
# Build sequence:
#   1. npm ci             — install everything (incl. devDeps like typescript)
#   2. npm run build      — tsc compiles src/ → dist/
#   3. npm prune --omit=dev — remove devDependencies so the deployed zip only
#                             carries runtime packages (@azure/*)
#
# The archive then includes the folder as-is, with `excludes` filtering source
# TypeScript, test files, and tooling that doesn't need to ship.

resource "null_resource" "function_build" {
  # Always rebuild on every apply so the deployment artifact is fresh. The build
  # itself is fast (~10s with a warm npm cache) and ensures the bundle exists
  # even after `terraform get -update` re-clones the module and wipes node_modules/.
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    # --no-package-lock on prune so the dev workflow's package-lock.json
    # isn't rewritten as a side-effect of building the deploy artifact.
    command     = "npm ci && npm run build && npm prune --omit=dev --no-package-lock"
    working_dir = "${path.module}/function"
  }
}

data "archive_file" "function_zip" {
  type        = "zip"
  source_dir  = "${path.module}/function"
  output_path = "${path.module}/function.zip"

  excludes = [
    "src",
    "coverage",
    "tsconfig.json",
    "jest.config.js",
    "package-lock.json",
    ".gitignore",
    "function.zip",
  ]

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

# Container for the connector's own state (delta cursor, subscription metadata,
# sync lock blobs). Used by the Worker code via the managed identity.
resource "azurerm_storage_container" "state" {
  name                  = "connector-state"
  storage_account_id    = azurerm_storage_account.func.id
  container_access_type = "private"
}

# Container that Flex Consumption pulls the deployment zip from.
resource "azurerm_storage_container" "deployment" {
  name                  = "deploymentpackage"
  storage_account_id    = azurerm_storage_account.func.id
  container_access_type = "private"
}

resource "azurerm_storage_queue" "dlq" {
  name               = "rootkey-dlq"
  storage_account_id = azurerm_storage_account.func.id
}

# Note: the deployment package itself is published AFTER the Function App is
# created, via `az functionapp deployment source config-zip` in a local-exec
# below. Flex Consumption only picks up blobs uploaded through that path — it
# expects a specific blob name (`released-package.zip`) plus a `kudu-state.json`
# tracker that the platform writes for it. A direct `azurerm_storage_blob` write
# to the container is silently ignored even when content and permissions are
# correct, so the upload has to go through the Flex deployment endpoint.

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

# The two customer-supplied secrets are written with `value_wo`, a write-only
# argument: the provider receives the value, sends it to Key Vault, and
# Terraform persists nothing. It appears in neither terraform.tfstate nor a
# saved plan file.
#
# The trade-off is that Terraform cannot see a write-only value, so it cannot
# detect that the secret changed. `value_wo_version` is the explicit signal:
# bump it and the secret is re-written to Key Vault as a new version, which
# changes the resource ID, which changes the versioned Key Vault reference in
# app_settings, which makes the Function App pick the new value up. Change the
# secret without bumping the counter and the new value is silently ignored.
resource "azurerm_key_vault_secret" "graph_client_secret" {
  name             = "graph-client-secret"
  value_wo         = var.graph_client_secret
  value_wo_version = var.graph_client_secret_version
  key_vault_id     = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

resource "azurerm_key_vault_secret" "rootkey_api_key" {
  name             = "rootkey-api-key"
  value_wo         = var.rootkey_api_key
  value_wo_version = var.rootkey_api_key_version
  key_vault_id     = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

# Deliberately NOT write-only. The value comes from random_string, whose
# `result` is persisted in state no matter what this resource does, so
# value_wo would remove nothing. Making it ephemeral would regenerate the
# clientState on every apply and invalidate in-flight Graph notifications
# until the next reconciliation — a real availability cost for no real gain,
# since this is a webhook validation token we generate, not a credential to
# the customer tenant. Called out in the README so it is not a surprise in an
# audit.
resource "azurerm_key_vault_secret" "webhook_client_state" {
  name         = "webhook-client-state"
  value        = random_string.client_state.result
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_admin_terraform]
}

# ─── Role assignments ──────────────────────────────────────────────────────────

# Function App identity needs to:
#  - Read the deployment package (Flex Consumption pulls the zip from blob storage)
#  - Read/write its own state blobs (delta cursor, sync lock) and DLQ queue
#  - Read Key Vault secrets
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

  # Flex Consumption pulls the zip directly from a blob container, watching for
  # new blobs. We upload the zip via azurerm_storage_blob.deployment_package above.
  storage_container_type            = "blobContainer"
  storage_container_endpoint        = local.deployment_package_endpoint
  storage_authentication_type       = "UserAssignedIdentity"
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

  # Cap concurrent scale-out. A single drive rarely needs many concurrent
  # invocations; the singleton sync lease serializes within a drive anyway.
  maximum_instance_count = 40

  https_only = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.func.id]
  }

  # See sharepoint/main.tf — keyVaultReferenceIdentity is bound below via
  # a null_resource + az CLI because the flex_consumption resource doesn't
  # expose it directly.

  site_config {
    application_insights_connection_string = azurerm_application_insights.ai.connection_string
  }

  app_settings = {
    # See sharepoint/main.tf for the rationale on the split between
    # AzureWebJobsStorage (host runtime state) and DlqStorage (dedicated
    # connection for the queue trigger, which requires a non-special-cased
    # connection name under identity-based auth on Flex Consumption).
    AzureWebJobsStorage              = ""
    AzureWebJobsStorage__accountName = azurerm_storage_account.func.name
    AzureWebJobsStorage__credential  = "managedidentity"
    AzureWebJobsStorage__clientId    = azurerm_user_assigned_identity.func.client_id

    DlqStorage__queueServiceUri = azurerm_storage_account.func.primary_queue_endpoint
    DlqStorage__credential      = "managedidentity"
    DlqStorage__clientId        = azurerm_user_assigned_identity.func.client_id

    # Fail loud if the worker can't import the entry point — without this flag,
    # a throw during module load silently leaves the host with 0 registered
    # functions, which is indistinguishable from a genuine empty deployment.
    # Useful in any hosting plan (not just Y1).
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

    # See sharepoint/main.tf for the rationale — versioned KV URIs force the
    # Function App to see a real app_settings change on rotation.
    GRAPH_CLIENT_SECRET  = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.graph_client_secret.id})"
    ROOTKEY_API_KEY      = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.rootkey_api_key.id})"
    WEBHOOK_CLIENT_STATE = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.webhook_client_state.id})"
  }

  tags = local.common_tags

  depends_on = [
    azurerm_role_assignment.kv_reader_func,
    azurerm_role_assignment.storage_blob_func,
    azurerm_role_assignment.storage_queue_func,
    azurerm_key_vault_secret.graph_client_secret,
    azurerm_key_vault_secret.rootkey_api_key,
    azurerm_key_vault_secret.webhook_client_state,
  ]
}

# ─── Bind KV reference resolution to the UAMI ──────────────────────────────────
# See sharepoint/main.tf for the full rationale — the platform defaults to
# SystemAssignedIdentity when resolving KV references and we only have a UAMI,
# so all @Microsoft.KeyVault(...) settings fail to resolve until we set
# keyVaultReferenceIdentity to point at our UAMI. The flex_consumption resource
# doesn't expose the property, so we set it via `az functionapp update`.
resource "null_resource" "kv_reference_identity" {
  triggers = {
    uami_id = azurerm_user_assigned_identity.func.id
    fn_name = azurerm_function_app_flex_consumption.func.name
  }

  provisioner "local-exec" {
    command = "az functionapp update --name ${azurerm_function_app_flex_consumption.func.name} --resource-group ${data.azurerm_resource_group.rg.name} --set keyVaultReferenceIdentity=${azurerm_user_assigned_identity.func.id}"
  }

  depends_on = [
    azurerm_function_app_flex_consumption.func,
    azurerm_role_assignment.kv_reader_func,
  ]
}

# ─── Deploy the function bundle ────────────────────────────────────────────────
#
# `az functionapp deployment source config-zip` is the canonical Microsoft
# deployment path for Flex Consumption: it uploads the zip as `released-package.zip`
# in the deployment container AND writes the `kudu-state.json` tracker the host
# uses to discover the active deployment. Without that tracker, Flex silently
# ignores anything in the container, which is why a plain `azurerm_storage_blob`
# upload doesn't work even with correct identity/permissions on the blob itself.
#
# Trigger: the zip's SHA-256 hash. If the source code is unchanged across applies
# the trigger is stable and Terraform skips the deploy step. When code changes,
# the hash changes and the deploy runs.
#
# Prereq: the `az` CLI must be available on PATH where `terraform apply` runs.
# This is already the case for any Azure deployment workflow, so no new ask of
# customers.
resource "null_resource" "function_deploy" {
  triggers = {
    zip_hash = data.archive_file.function_zip.output_sha256
  }

  provisioner "local-exec" {
    command = "az functionapp deployment source config-zip --src ${data.archive_file.function_zip.output_path} --name ${azurerm_function_app_flex_consumption.func.name} --resource-group ${data.azurerm_resource_group.rg.name}"
  }

  depends_on = [
    azurerm_function_app_flex_consumption.func,
    # Deploy AFTER keyVaultReferenceIdentity is bound so the restart triggered
    # by config-zip picks up KV references with the correct identity.
    null_resource.kv_reference_identity,
  ]
}
