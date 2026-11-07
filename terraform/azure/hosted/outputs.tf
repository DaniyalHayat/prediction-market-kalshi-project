output "profile" {
  description = "Selected runtime profile and the resources it enables."
  value = {
    mode       = var.profile
    azure      = var.azure_enabled
    apps       = local.apps
    postgresql = local.live
    bootstrap  = local.bootstrap
    saved_logs = local.saved_logs
  }
}

output "saved_logs" {
  description = "Authorized workspace coordinates for retained console and system logs. Azure ingestion may lag and daily quotas may overshoot."
  value = local.saved_logs ? {
    workspace_resource_id = azurerm_log_analytics_workspace.runtime[0].id
    workspace_id          = azurerm_log_analytics_workspace.runtime[0].workspace_id
    retention_days        = azurerm_log_analytics_workspace.runtime[0].retention_in_days
    daily_quota_gb        = azurerm_log_analytics_workspace.runtime[0].daily_quota_gb
    monthly_review_usd    = local.saved_logs_reserve_usd
  } : null
}

output "bootstrap_job_name" {
  description = "Temporary manual job. Successful execution verifies database initialization before live app launch."
  value       = length(azurerm_container_app_job.bootstrap) == 1 ? azurerm_container_app_job.bootstrap[0].name : null
}

output "container_apps_subnet_id" {
  description = "Delegated live ACA subnet. Use to verify existing Key Vault connectivity before running bootstrap."
  value       = local.live ? azurerm_subnet.apps[0].id : null
}

output "container_app_ids" {
  description = "Azure Monitor resource IDs for the two hosted workloads."
  value = local.apps ? {
    front   = azurerm_container_app.front[0].id
    backend = azurerm_container_app.backend[0].id
  } : null
}

output "public_frontend_url" {
  description = "Public HTTPS frontend once the apps are enabled."
  value       = local.apps ? "https://${azurerm_container_app.front[0].ingress[0].fqdn}" : null
}

output "backend_internal_url" {
  description = "Private ACA endpoint, reachable from within the edition environment."
  value       = local.apps ? "https://${azurerm_container_app.backend[0].ingress[0].fqdn}" : null
}

output "container_apps_environment_name" {
  description = "Existing environment to use for an approved private database initialization job."
  value       = var.azure_enabled ? azurerm_container_app_environment.edition[0].name : null
}

output "resource_group_name" {
  description = "Azure resource group for this edition."
  value       = var.azure_enabled ? azurerm_resource_group.edition[0].name : null
}

output "azure_subscription_id" {
  description = "Subscription selected for the hosted environment."
  value       = var.azure_enabled ? var.subscription_id : null
}

output "front_identity" {
  description = "Public identifiers of the frontend managed identity, for separately approved Azure-native integrations."
  value = local.identities ? {
    client_id    = azurerm_user_assigned_identity.app["front"].client_id
    principal_id = azurerm_user_assigned_identity.app["front"].principal_id
  } : null
}

output "postgresql" {
  description = "Private database coordinates only, with no connection credentials."
  value = local.live ? {
    host     = azurerm_postgresql_flexible_server.live[0].fqdn
    port     = 5432
    database = azurerm_postgresql_flexible_server_database.predictir[0].name
  } : null
}
