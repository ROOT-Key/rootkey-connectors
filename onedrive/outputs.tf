output "function_app_name" {
  description = "Name of the deployed Azure Function App."
  value       = azurerm_linux_function_app.func.name
}

output "function_app_hostname" {
  description = "Default hostname of the Function App (used as the Microsoft Graph webhook target)."
  value       = azurerm_linux_function_app.func.default_hostname
}

output "notification_url" {
  description = "Microsoft Graph webhook notification URL. Used by the Function App itself to register the subscription; surfaced for diagnostics."
  value       = "https://${azurerm_linux_function_app.func.default_hostname}/api/notification"
}

output "key_vault_name" {
  description = "Key Vault holding the Graph client secret, ROOTKey API key, and webhook client state."
  value       = azurerm_key_vault.kv.name
}

output "storage_account_name" {
  description = "Storage Account used for Function App backing, delta token state, and the DLQ."
  value       = azurerm_storage_account.func.name
}

output "dlq_queue_name" {
  description = "Storage Queue receiving per-file failures after all retries — monitor this for missed uploads."
  value       = azurerm_storage_queue.dlq.name
}

output "application_insights_name" {
  description = "Application Insights resource where the Function App writes logs and telemetry."
  value       = azurerm_application_insights.ai.name
}

output "managed_identity_id" {
  description = "Resource ID of the user-assigned managed identity used by the Function App."
  value       = azurerm_user_assigned_identity.func.id
}
