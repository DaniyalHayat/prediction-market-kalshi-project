resource "azurerm_log_analytics_workspace" "runtime" {
  count = local.saved_logs ? 1 : 0

  name                            = "${var.name_prefix}-runtime-logs"
  location                        = azurerm_resource_group.edition[0].location
  resource_group_name             = azurerm_resource_group.edition[0].name
  sku                             = "PerGB2018"
  retention_in_days               = 30
  daily_quota_gb                  = 0.05
  local_authentication_enabled    = false
  allow_resource_only_permissions = false
  tags                            = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "runtime" {
  count = local.saved_logs ? 1 : 0

  name                           = "predictir-runtime-logs"
  target_resource_id             = azurerm_container_app_environment.edition[0].id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.runtime[0].id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category_group = "allLogs"
  }
}
