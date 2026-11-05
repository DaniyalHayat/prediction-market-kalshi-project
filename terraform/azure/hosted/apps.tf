locals {
  public_origin = var.azure_enabled ? "https://${local.app_names.front}.${azurerm_container_app_environment.edition[0].default_domain}" : null

  owner_front_environment = var.live_owner == null ? {} : {
    AZURE_OWNER_AUTH_ENABLED = "1"
  }
  owner_backend_environment = var.live_owner == null ? {} : merge(local.owner_front_environment, {
    AZURE_OWNER_TENANT_ID = var.live_owner.tenant_id
    AZURE_OWNER_CLIENT_ID = var.live_owner.client_id
    AZURE_OWNER_OBJECT_ID = var.live_owner.object_id
  })

  front_environment = merge({
    PORT           = "3000"
    PREDICTIR_MODE = var.profile
    APP_ORIGIN     = local.public_origin
  }, local.live ? local.owner_front_environment : {})

  backend_environment = merge({
    PORT           = "8780"
    PREDICTIR_MODE = var.profile
    APP_ORIGIN     = local.public_origin
    }, local.live ? {
    PREDICTIR_DATABASE_HOST  = azurerm_postgresql_flexible_server.live[0].fqdn
    MARKET_STREAM_MINUTES    = "2400"
    MARKET_STREAM_BYTE_LIMIT = "1000000000"
  } : {}, local.live ? local.owner_backend_environment : {})

  secret_environment = {
    edge        = "MARKET_EDGE_SECRET"
    assistant   = "ASSISTANT_SERVICE_SECRET"
    account     = "ACCOUNT_COOKIE_SECRET"
    database    = "DATABASE_URL"
    database-ca = "DATABASE_CA_CERT"
  }
}

resource "azurerm_container_app" "backend" {
  count = local.apps ? 1 : 0

  name                         = local.app_names.backend
  resource_group_name          = azurerm_resource_group.edition[0].name
  container_app_environment_id = azurerm_container_app_environment.edition[0].id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 2
  tags                         = local.tags

  dynamic "identity" {
    for_each = local.identities ? [azurerm_user_assigned_identity.app["backend"].id] : []

    content {
      type         = "UserAssigned"
      identity_ids = [identity.value]
    }
  }

  dynamic "registry" {
    for_each = var.existing_acr == null ? [] : [var.existing_acr]

    content {
      server   = registry.value.login_server
      identity = azurerm_user_assigned_identity.app["backend"].id
    }
  }

  dynamic "secret" {
    for_each = local.backend_secrets

    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app["backend"].id
    }
  }

  ingress {
    external_enabled           = false
    allow_insecure_connections = false
    target_port                = 8780
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 1

    http_scale_rule {
      name                = "http"
      concurrent_requests = "16"
    }

    container {
      name   = "backend"
      image  = local.images.backend
      cpu    = local.live ? 0.5 : 0.25
      memory = local.live ? "1Gi" : "0.5Gi"

      dynamic "env" {
        for_each = local.backend_environment

        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.backend_secrets

        content {
          name        = local.secret_environment[env.key]
          secret_name = env.key
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 8780
        path                    = "/api/health"
        interval_seconds        = 3
        timeout                 = 2
        failure_count_threshold = 20
      }

      readiness_probe {
        transport        = "HTTP"
        port             = 8780
        path             = "/api/health"
        interval_seconds = 10
        timeout          = 3
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 8780
        path             = "/api/health"
        interval_seconds = 20
        timeout          = 3
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.key_vault_secret,
    azurerm_role_assignment.registry_pull,
    azurerm_postgresql_flexible_server_configuration.tls,
    azurerm_postgresql_flexible_server_configuration.extensions,
  ]
}

resource "azurerm_container_app" "front" {
  count = local.apps ? 1 : 0

  name                         = local.app_names.front
  resource_group_name          = azurerm_resource_group.edition[0].name
  container_app_environment_id = azurerm_container_app_environment.edition[0].id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 2
  tags                         = local.tags

  dynamic "identity" {
    for_each = local.identities ? [azurerm_user_assigned_identity.app["front"].id] : []

    content {
      type         = "UserAssigned"
      identity_ids = [identity.value]
    }
  }

  dynamic "registry" {
    for_each = var.existing_acr == null ? [] : [var.existing_acr]

    content {
      server   = registry.value.login_server
      identity = azurerm_user_assigned_identity.app["front"].id
    }
  }

  dynamic "secret" {
    for_each = local.front_secrets

    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app["front"].id
    }
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 3000
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 1

    http_scale_rule {
      name                = "http"
      concurrent_requests = "16"
    }

    container {
      name   = "front"
      image  = local.images.front
      cpu    = 0.25
      memory = "0.5Gi"

      dynamic "env" {
        for_each = local.front_environment

        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name  = "MARKET_BACKEND_URL"
        value = "https://${azurerm_container_app.backend[0].ingress[0].fqdn}"
      }

      dynamic "env" {
        for_each = local.front_secrets

        content {
          name        = local.secret_environment[env.key]
          secret_name = env.key
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/"
        interval_seconds        = 3
        timeout                 = 2
        failure_count_threshold = 20
      }

      readiness_probe {
        transport        = "HTTP"
        port             = 3000
        path             = "/"
        interval_seconds = 10
        timeout          = 3
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 3000
        path             = "/"
        interval_seconds = 20
        timeout          = 3
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.key_vault_secret,
    azurerm_role_assignment.registry_pull,
  ]
}
