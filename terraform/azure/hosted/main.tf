locals {
  location   = var.location
  live       = var.azure_enabled && var.profile == "live"
  apps       = var.azure_enabled && (var.profile == "replay" || var.launch_live_apps)
  identities = local.live || (local.apps && var.existing_acr != null)
  bootstrap  = local.live && var.live_bootstrap != null

  postgres_monthly_base_usd = var.location == "centralus" ? 18.69 : 16.59
  minimum_approval_usd      = var.profile == "live" ? 25 : 1

  unresolved_image = "invalid.invalid/release-required@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  images = var.images == null ? {
    front   = local.unresolved_image
    backend = local.unresolved_image
  } : var.images

  app_names = {
    front   = "${var.name_prefix}-front"
    backend = "${var.name_prefix}-backend"
  }

  registry_app_images = local.identities && var.existing_acr != null && var.images != null ? var.images : {}
  registry_job_images = local.bootstrap && var.existing_acr != null ? { bootstrap = var.live_bootstrap.image } : {}
  registry_images     = merge(local.registry_app_images, local.registry_job_images)

  registry_read_action = "Microsoft.ContainerRegistry/registries/repositories"

  tags = {
    application = "predictir"
    edition     = "azure"
    profile     = var.profile
  }
}

resource "terraform_data" "release_approval" {
  count = var.azure_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.subscription_id != null
      error_message = "Select the exact Azure subscription before enabling resources."
    }

    precondition {
      condition = var.spend_approval == null ? false : (
        (var.spend_approval.credit_only != var.spend_approval.accepts_metered_overages) &&
        var.spend_approval.approved_monthly_usd >= local.minimum_approval_usd &&
        var.spend_approval.reviewed_monthly_usd >= (local.live ? local.postgres_monthly_base_usd : 0) &&
        var.spend_approval.reviewed_monthly_usd <= var.spend_approval.approved_monthly_usd
      )
      error_message = "The estimate must fit a reviewed release limit of at least $1 for replay or $25 for live and cover the regional database and DNS base. Choose usage-based billing or attest a verified credit-only subscription with its spending limit enabled."
    }

    precondition {
      condition     = !local.apps || (var.images != null && var.existing_acr != null)
      error_message = "Supply the existing private Azure registry and both reviewed image digests before enabling the apps."
    }

    precondition {
      condition = var.profile == "replay" ? (
        !var.launch_live_apps && !var.live_database_ready && var.live_secrets == null && var.live_bootstrap == null && var.live_owner == null
        ) : (
        !var.launch_live_apps || (var.live_database_ready && var.live_secrets != null)
      )
      error_message = "Replay accepts no live database settings or secrets. Live apps require verified database initialization and explicit Key Vault references."
    }

    precondition {
      condition = var.live_bootstrap == null ? true : (
        var.live_secrets == null || var.existing_acr == null ? false : (
          local.live && !var.launch_live_apps && !var.live_database_ready &&
          startswith(var.live_bootstrap.admin_password_uri, "https://${lower(element(reverse(split("/", var.live_secrets.vault_resource_id)), 0))}.vault.azure.net/secrets/") &&
          !contains([
            for uri in values(local.backend_secrets) : lower(split("/", uri)[4])
          ], lower(split("/", var.live_bootstrap.admin_password_uri)[4]))
        )
      )
      error_message = "A manual bootstrap job requires the existing private registry, runtime secret references, and its own administrator secret in the same vault. Remove it before live launch."
    }

    precondition {
      condition = var.live_secrets == null || var.subscription_id == null ? true : startswith(
        lower(var.live_secrets.vault_resource_id), "/subscriptions/${lower(var.subscription_id)}/"
      )
      error_message = "Use an existing Key Vault in the selected Azure subscription."
    }

    precondition {
      condition = var.existing_acr == null || var.subscription_id == null ? true : (
        startswith(lower(var.existing_acr.resource_id), "/subscriptions/${lower(var.subscription_id)}/") &&
        alltrue([for image in values(local.registry_images) : startswith(image, "${var.existing_acr.login_server}/")])
      )
      error_message = "The existing registry must belong to the selected subscription, and both images must use its login server."
    }
  }
}

resource "azurerm_resource_group" "edition" {
  count = var.azure_enabled ? 1 : 0

  name     = "${var.name_prefix}-rg"
  location = local.location
  tags     = local.tags

  depends_on = [terraform_data.release_approval]
}

resource "azurerm_container_app_environment" "edition" {
  count = var.azure_enabled ? 1 : 0

  name                           = "${var.name_prefix}-cae"
  location                       = azurerm_resource_group.edition[0].location
  resource_group_name            = azurerm_resource_group.edition[0].name
  infrastructure_subnet_id       = local.live ? azurerm_subnet.apps[0].id : null
  internal_load_balancer_enabled = local.live ? false : null
  public_network_access          = "Enabled"
  logs_destination               = null
  tags                           = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_user_assigned_identity" "app" {
  for_each = local.identities ? local.app_names : {}

  name                = "${each.value}-identity"
  resource_group_name = azurerm_resource_group.edition[0].name
  location            = azurerm_resource_group.edition[0].location
  tags                = local.tags
}

resource "azurerm_role_assignment" "registry_pull" {
  for_each = local.registry_images

  scope                            = var.existing_acr.resource_id
  role_definition_name             = var.existing_acr.authorization_mode == "abac" ? "Container Registry Repository Reader" : "AcrPull"
  principal_id                     = each.key == "bootstrap" ? azurerm_user_assigned_identity.bootstrap[0].principal_id : azurerm_user_assigned_identity.app[each.key].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
  condition_version                = var.existing_acr.authorization_mode == "abac" ? "2.0" : null
  condition = var.existing_acr.authorization_mode == "abac" ? join(" ", [
    "((!(ActionMatches{'${local.registry_read_action}/content/read'}) AND",
    "!(ActionMatches{'${local.registry_read_action}/metadata/read'})) OR",
    "(@Request[${local.registry_read_action}:name] StringEqualsIgnoreCase '${split("@", trimprefix(each.value, "${var.existing_acr.login_server}/"))[0]}'))",
  ]) : null
}

locals {
  front_secrets = local.live && var.live_secrets != null ? {
    edge      = var.live_secrets.edge_secret_uri
    assistant = var.live_secrets.assistant_secret_uri
  } : {}

  backend_secrets = local.live && var.live_secrets != null ? {
    edge        = var.live_secrets.edge_secret_uri
    assistant   = var.live_secrets.assistant_secret_uri
    account     = var.live_secrets.account_secret_uri
    database    = var.live_secrets.database_url_uri
    database-ca = var.live_secrets.database_ca_uri
  } : {}

  secret_grants = merge(
    { for name, uri in local.front_secrets : "front/${name}" => { app = "front", uri = uri } },
    { for name, uri in local.backend_secrets : "backend/${name}" => { app = "backend", uri = uri } },
  )
}

resource "azurerm_role_assignment" "key_vault_secret" {
  for_each = local.secret_grants

  scope                            = "${var.live_secrets.vault_resource_id}/secrets/${split("/", each.value.uri)[4]}"
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.app[each.value.app].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
