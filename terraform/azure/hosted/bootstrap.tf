locals {
  bootstrap_secrets = local.bootstrap && var.live_secrets != null ? {
    postgres-admin = var.live_bootstrap.admin_password_uri
    database       = var.live_secrets.database_url_uri
    database-ca    = var.live_secrets.database_ca_uri
  } : {}
}

resource "azurerm_user_assigned_identity" "bootstrap" {
  count = local.bootstrap ? 1 : 0

  name                = "${var.name_prefix}-db-bootstrap"
  resource_group_name = azurerm_resource_group.edition[0].name
  location            = azurerm_resource_group.edition[0].location
  tags                = local.tags
}

resource "azurerm_role_assignment" "bootstrap_secret" {
  for_each = local.bootstrap_secrets

  scope                            = "${var.live_secrets.vault_resource_id}/secrets/${split("/", each.value)[4]}"
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.bootstrap[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "bootstrap" {
  count = local.bootstrap && var.existing_acr != null && var.live_secrets != null ? 1 : 0

  name                         = "${var.name_prefix}-db-bootstrap"
  resource_group_name          = azurerm_resource_group.edition[0].name
  location                     = azurerm_resource_group.edition[0].location
  container_app_environment_id = azurerm_container_app_environment.edition[0].id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 300
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.bootstrap[0].id]
  }

  registry {
    server   = var.existing_acr.login_server
    identity = azurerm_user_assigned_identity.bootstrap[0].id
  }

  dynamic "secret" {
    for_each = local.bootstrap_secrets

    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.bootstrap[0].id
    }
  }

  template {
    container {
      name   = "bootstrap"
      image  = var.live_bootstrap.image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PREDICTIR_DATABASE_HOST"
        value = azurerm_postgresql_flexible_server.live[0].fqdn
      }

      dynamic "env" {
        for_each = local.bootstrap_secrets

        content {
          name        = env.key == "postgres-admin" ? "POSTGRES_ADMIN_PASSWORD" : local.secret_environment[env.key]
          secret_name = env.key
        }
      }
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.predictir,
    azurerm_postgresql_flexible_server_configuration.tls,
    azurerm_postgresql_flexible_server_configuration.extensions,
    azurerm_role_assignment.bootstrap_secret,
    azurerm_role_assignment.registry_pull,
  ]
}
