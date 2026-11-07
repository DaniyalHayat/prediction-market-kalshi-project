mock_provider "azurerm" {
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      default_domain = "fixture.eastus2.azurecontainerapps.io"
    }
  }
}

variables {
  subscription_id = "11111111-1111-1111-1111-111111111111"
  images = {
    front   = "fixtureacr.azurecr.io/predictir-front@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    backend = "fixtureacr.azurecr.io/predictir-backend@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }
  existing_acr = {
    resource_id        = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.ContainerRegistry/registries/fixtureacr"
    login_server       = "fixtureacr.azurecr.io"
    authorization_mode = "abac"
  }
  spend_approval = {
    approved_monthly_usd     = 25
    reviewed_monthly_usd     = 20
    accepts_metered_overages = true
  }
}

run "default_is_zero_azure_resources" {
  command = plan

  assert {
    condition = (
      output.profile.mode == "replay" &&
      !output.profile.azure &&
      length(terraform_data.release_approval) == 0 &&
      length(azurerm_resource_group.edition) == 0 &&
      length(azurerm_container_app_environment.edition) == 0 &&
      length(azurerm_log_analytics_workspace.runtime) == 0 &&
      length(azurerm_monitor_diagnostic_setting.runtime) == 0 &&
      length(azurerm_container_app.front) == 0 &&
      length(azurerm_container_app.backend) == 0 &&
      length(azurerm_postgresql_flexible_server.live) == 0 &&
      length(azurerm_container_app_job.bootstrap) == 0
    )
    error_message = "Default replay must create no guard, resource group, compute or database."
  }
}

run "saved_logs_do_not_create_resources_when_azure_is_disabled" {
  command = plan

  variables {
    enable_saved_logs = true
  }

  assert {
    condition = (
      !output.profile.saved_logs &&
      output.saved_logs == null &&
      length(azurerm_log_analytics_workspace.runtime) == 0 &&
      length(azurerm_monitor_diagnostic_setting.runtime) == 0
    )
    error_message = "A disabled deployment must create no saved-log resources even when the option is selected."
  }
}

run "replay_keeps_streaming_only_when_saved_logs_are_selected" {
  command = plan

  variables {
    azure_enabled     = true
    enable_saved_logs = true
  }

  assert {
    condition = (
      !output.profile.saved_logs &&
      azurerm_container_app_environment.edition[0].logs_destination == null &&
      output.saved_logs == null &&
      length(azurerm_log_analytics_workspace.runtime) == 0 &&
      length(azurerm_monitor_diagnostic_setting.runtime) == 0
    )
    error_message = "Saved logs must remain isolated to an enabled live edition."
  }
}

run "live_saved_logs_are_bounded_and_use_azure_identity" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    enable_saved_logs       = true
    postgres_admin_password = "isolated-mock-input-not-a-secret"
    spend_approval = {
      approved_monthly_usd     = 25
      reviewed_monthly_usd     = 25
      accepts_metered_overages = true
    }
  }

  assert {
    condition = (
      output.profile.saved_logs &&
      azurerm_container_app_environment.edition[0].logs_destination == "azure-monitor" &&
      length(azurerm_log_analytics_workspace.runtime) == 1 &&
      length(azurerm_monitor_diagnostic_setting.runtime) == 1 &&
      azurerm_log_analytics_workspace.runtime[0].sku == "PerGB2018" &&
      azurerm_log_analytics_workspace.runtime[0].retention_in_days == 30 &&
      azurerm_log_analytics_workspace.runtime[0].daily_quota_gb == 0.05 &&
      !azurerm_log_analytics_workspace.runtime[0].local_authentication_enabled &&
      !azurerm_log_analytics_workspace.runtime[0].allow_resource_only_permissions &&
      one(azurerm_monitor_diagnostic_setting.runtime[0].enabled_log).category_group == "allLogs" &&
      length(azurerm_monitor_diagnostic_setting.runtime[0].enabled_metric) == 0 &&
      output.saved_logs.monthly_review_usd == 5
    )
    error_message = "Live console and system logs require 30-day retention, bounded ingestion, reviewed spend, and workspace authorization."
  }
}

run "saved_logs_require_the_additional_reviewed_reserve" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    enable_saved_logs       = true
    postgres_admin_password = "isolated-mock-input-not-a-secret"
  }

  expect_failures = [terraform_data.release_approval]
}

run "hosted_replay_consumption_and_private_backend" {
  command = plan

  variables {
    azure_enabled = true
  }

  assert {
    condition = (
      azurerm_container_app.front[0].ingress[0].external_enabled &&
      !azurerm_container_app.backend[0].ingress[0].external_enabled &&
      azurerm_container_app.front[0].ingress[0].target_port == 3000 &&
      azurerm_container_app.backend[0].ingress[0].target_port == 8780 &&
      azurerm_container_app.front[0].template[0].min_replicas == 0 &&
      azurerm_container_app.backend[0].template[0].min_replicas == 0 &&
      azurerm_container_app.front[0].template[0].max_replicas == 1 &&
      azurerm_container_app.backend[0].template[0].max_replicas == 1
    )
    error_message = "Only the frontend should have public ingress, with both apps restricted to one replica."
  }

  assert {
    condition = (
      azurerm_container_app_environment.edition[0].logs_destination == null &&
      azurerm_container_app.front[0].workload_profile_name == "Consumption" &&
      azurerm_container_app.backend[0].workload_profile_name == "Consumption" &&
      length(azurerm_user_assigned_identity.app) == 2 &&
      length(azurerm_role_assignment.key_vault_secret) == 0 &&
      length(azurerm_postgresql_flexible_server.live) == 0 &&
      length(azurerm_virtual_network.live) == 0 &&
      length(azurerm_container_app.front[0].secret) == 0 &&
      length(azurerm_container_app.backend[0].secret) == 0 &&
      azurerm_container_app.front[0].template[0].container[0].readiness_probe[0].path == "/" &&
      azurerm_container_app.front[0].template[0].container[0].readiness_probe[0].success_count_threshold == 1 &&
      azurerm_container_app.backend[0].template[0].container[0].readiness_probe[0].success_count_threshold == 1 &&
      azurerm_container_app.backend[0].template[0].container[0].readiness_probe[0].port == 8780 &&
      azurerm_container_app.backend[0].template[0].container[0].readiness_probe[0].path == "/api/health" &&
      azurerm_container_app.backend[0].template[0].container[0].readiness_probe[0].interval_seconds == 15 &&
      azurerm_container_app.backend[0].template[0].container[0].liveness_probe[0].interval_seconds == 15 &&
      contains([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name], "PREDICTIR_SHUTDOWN_TIMEOUT_MS") &&
      !contains([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name], "PREDICTIR_KEEP_CATALOG_WARM") &&
      !contains([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name], "PREDICTIR_DATABASE_HOST")
    )
    error_message = "Hosted replay must use Consumption, streaming-only logs, and no database, VNet or app secrets."
  }
}

run "warm_replicas_require_a_reviewed_estimate" {
  command = plan

  variables {
    azure_enabled  = true
    keep_apps_warm = true
    spend_approval = {
      approved_monthly_usd     = 25
      reviewed_monthly_usd     = 10
      accepts_metered_overages = false
      credit_only              = true
    }
  }

  expect_failures = [terraform_data.release_approval]
}

run "warm_replicas_remain_bounded" {
  command = plan

  variables {
    azure_enabled  = true
    keep_apps_warm = true
  }

  assert {
    condition = alltrue([
      for app in [azurerm_container_app.front[0], azurerm_container_app.backend[0]] :
      app.template[0].min_replicas == 1 && app.template[0].max_replicas == 1
    ])
    error_message = "The warm profile must keep exactly one replica per workload."
  }
}

run "unapproved_hosted_replay_is_rejected" {
  command = plan

  variables {
    azure_enabled = true
    spend_approval = {
      approved_monthly_usd     = 0
      reviewed_monthly_usd     = 0
      accepts_metered_overages = false
    }
  }

  expect_failures = [terraform_data.release_approval]
}

run "live_foundation_does_not_launch_apps" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    postgres_admin_password = "isolated-mock-input-not-a-secret"
  }

  assert {
    condition = (
      !output.profile.apps &&
      !output.profile.saved_logs &&
      output.saved_logs == null &&
      azurerm_postgresql_flexible_server.live[0].version == "17" &&
      azurerm_postgresql_flexible_server.live[0].sku_name == "B_Standard_B1ms" &&
      !azurerm_postgresql_flexible_server.live[0].public_network_access_enabled &&
      azurerm_postgresql_flexible_server.live[0].storage_mb == 32768 &&
      !azurerm_postgresql_flexible_server.live[0].auto_grow_enabled &&
      azurerm_postgresql_flexible_server_configuration.tls[0].value == "on" &&
      azurerm_postgresql_flexible_server_configuration.extensions[0].value == "PGCRYPTO,VECTOR" &&
      length(azurerm_subnet_network_security_group_association.postgres) == 1 &&
      length(azurerm_container_app_job.bootstrap) == 0 &&
      length(azurerm_container_app.front) == 0 &&
      length(azurerm_container_app.backend) == 0
    )
    error_message = "Live foundation must create only the bounded private database and supporting infrastructure before app launch."
  }
}

run "live_rejects_cost_below_guard" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    postgres_admin_password = "isolated-mock-input-not-a-secret"
    spend_approval = {
      approved_monthly_usd     = 18
      reviewed_monthly_usd     = 17
      accepts_metered_overages = true
    }
  }

  expect_failures = [terraform_data.release_approval]
}

run "live_requires_ephemeral_admin_input" {
  command = plan

  variables {
    azure_enabled = true
    profile       = "live"
  }

  expect_failures = [var.postgres_admin_password]
}

run "live_rejects_launch_without_initialization" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    postgres_admin_password = "isolated-mock-input-not-a-secret"
    launch_live_apps        = true
  }

  expect_failures = [terraform_data.release_approval]
}

run "live_runtime_uses_referenced_secrets" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    postgres_admin_password = "isolated-mock-input-not-a-secret"
    launch_live_apps        = true
    live_database_ready     = true

    live_secrets = {
      vault_resource_id    = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.KeyVault/vaults/fixturevault"
      edge_secret_uri      = "https://fixturevault.vault.azure.net/secrets/edge/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      assistant_secret_uri = "https://fixturevault.vault.azure.net/secrets/assistant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      account_secret_uri   = "https://fixturevault.vault.azure.net/secrets/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      database_url_uri     = "https://fixturevault.vault.azure.net/secrets/db-url/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      database_ca_uri      = "https://fixturevault.vault.azure.net/secrets/db-ca/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      provider_secret_uris = {
        spotify-client-id     = "https://fixturevault.vault.azure.net/secrets/spotify-id/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        spotify-client-secret = "https://fixturevault.vault.azure.net/secrets/spotify-secret/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        x-bearer-token        = "https://fixturevault.vault.azure.net/secrets/x-token/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }

  assert {
    condition = (
      length(azurerm_user_assigned_identity.app) == 2 &&
      length(azurerm_role_assignment.key_vault_secret) == 10 &&
      toset([for s in azurerm_container_app.front[0].secret : s.name]) == toset(["edge", "assistant"]) &&
      toset([for s in azurerm_container_app.backend[0].secret : s.name]) == toset(["edge", "assistant", "account", "database", "database-ca", "spotify-client-id", "spotify-client-secret", "x-bearer-token"]) &&
      contains([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name], "PREDICTIR_DATABASE_HOST") &&
      toset([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name if env.secret_name != null && env.secret_name != ""]) == toset(["MARKET_EDGE_SECRET", "ASSISTANT_SERVICE_SECRET", "ACCOUNT_COOKIE_SECRET", "DATABASE_URL", "DATABASE_CA_CERT", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "X_BEARER_TOKEN"]) &&
      one([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.value if env.name == "X_MONTHLY_COST_CENTS"]) == "150" &&
      contains([for env in azurerm_container_app.backend[0].template[0].container[0].env : env.name], "PREDICTIR_SHUTDOWN_TIMEOUT_MS")
    )
    error_message = "Live secrets must be Key Vault references scoped to the relevant app identity."
  }
}

run "image_tags_are_rejected" {
  command = plan

  variables {
    azure_enabled = true
    images = {
      front   = "ghcr.io/example/predictir-front:latest"
      backend = "ghcr.io/example/predictir-backend:latest"
    }
  }

  expect_failures = [var.images]
}

run "existing_acr_uses_identity_without_runtime_secrets" {
  command = plan

  variables {
    azure_enabled = true
    images = {
      front   = "fixtureacr.azurecr.io/predictir-front@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      backend = "fixtureacr.azurecr.io/predictir-backend@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    }
    existing_acr = {
      resource_id        = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.ContainerRegistry/registries/fixtureacr"
      login_server       = "fixtureacr.azurecr.io"
      authorization_mode = "abac"
    }
  }

  assert {
    condition = (
      length(azurerm_user_assigned_identity.app) == 2 &&
      length(azurerm_role_assignment.registry_pull) == 2 &&
      azurerm_role_assignment.registry_pull["front"].role_definition_name == "Container Registry Repository Reader" &&
      strcontains(azurerm_role_assignment.registry_pull["front"].condition, "StringEqualsIgnoreCase 'predictir-front'") &&
      strcontains(azurerm_role_assignment.registry_pull["backend"].condition, "StringEqualsIgnoreCase 'predictir-backend'") &&
      length(azurerm_role_assignment.key_vault_secret) == 0 &&
      length(azurerm_container_app.backend[0].secret) == 0
    )
    error_message = "Existing ACR image pull must use scoped identities and no replay runtime secrets."
  }
}

run "hosted_apps_require_private_registry" {
  command = plan

  variables {
    azure_enabled = true
    existing_acr  = null
  }

  expect_failures = [terraform_data.release_approval]
}

run "manual_bootstrap_is_private_bounded_and_separate" {
  command = plan

  variables {
    azure_enabled           = true
    profile                 = "live"
    postgres_admin_password = "isolated-mock-input-not-a-secret"
    live_secrets = {
      vault_resource_id    = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.KeyVault/vaults/fixturevault"
      edge_secret_uri      = "https://fixturevault.vault.azure.net/secrets/edge/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      assistant_secret_uri = "https://fixturevault.vault.azure.net/secrets/assistant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      account_secret_uri   = "https://fixturevault.vault.azure.net/secrets/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      database_url_uri     = "https://fixturevault.vault.azure.net/secrets/db-url/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      database_ca_uri      = "https://fixturevault.vault.azure.net/secrets/db-ca/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
    live_bootstrap = {
      image              = "fixtureacr.azurecr.io/predictir-bootstrap@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      admin_password_uri = "https://fixturevault.vault.azure.net/secrets/db-admin/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }

  assert {
    condition = (
      output.profile.bootstrap && !output.profile.apps &&
      length(azurerm_user_assigned_identity.bootstrap) == 1 &&
      length(azurerm_role_assignment.bootstrap_secret) == 3 &&
      length(azurerm_container_app_job.bootstrap[0].manual_trigger_config) == 1 &&
      length(azurerm_container_app_job.bootstrap[0].schedule_trigger_config) == 0 &&
      length(azurerm_container_app_job.bootstrap[0].event_trigger_config) == 0 &&
      azurerm_container_app_job.bootstrap[0].replica_retry_limit == 0 &&
      azurerm_container_app_job.bootstrap[0].replica_timeout_in_seconds == 300 &&
      toset([for s in azurerm_container_app_job.bootstrap[0].secret : s.name]) == toset(["postgres-admin", "database", "database-ca"]) &&
      strcontains(azurerm_role_assignment.registry_pull["bootstrap"].condition, "StringEqualsIgnoreCase 'predictir-bootstrap'")
    )
    error_message = "The bootstrap must be manually triggered once with a separate identity and narrowly scoped secrets and image."
  }
}
