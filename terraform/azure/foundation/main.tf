terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "5.12.0"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = false
    }
  }

  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
}

variable "subscription_id" {
  type        = string
  description = "Explicit Azure subscription ID selected by the authenticated Azure CLI operator."

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "Provide an Azure subscription GUID."
  }
}

variable "name_prefix" {
  type        = string
  default     = "predictir"
  description = "Lowercase project name used for the foundation resource group, registry and vault."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,10}[a-z0-9]$", var.name_prefix)) && !strcontains(var.name_prefix, "--")
    error_message = "Use 3 through 12 lowercase characters, start with a letter, end with a letter or digit and avoid consecutive hyphens."
  }
}

variable "name_suffix" {
  type        = string
  description = "A stable suffix used to make the registry and vault names globally unique."

  validation {
    condition     = can(regex("^[a-z0-9]{4,8}$", var.name_suffix))
    error_message = "Use 4 through 8 lowercase letters or digits."
  }
}

data "azurerm_client_config" "operator" {}

locals {
  base_name = "${var.name_prefix}-${var.name_suffix}"
  tags = {
    project   = var.name_prefix
    component = "azure-foundation"
    managed   = "terraform"
  }
}

resource "azurerm_resource_group" "foundation" {
  name     = "${local.base_name}-foundation-rg"
  location = "eastus2"
  tags     = local.tags
}

resource "azurerm_container_registry" "images" {
  name                                         = "${replace(local.base_name, "-", "")}acr"
  location                                     = azurerm_resource_group.foundation.location
  resource_group_name                          = azurerm_resource_group.foundation.name
  sku                                          = "Basic"
  admin_enabled                                = false
  public_network_access_enabled                = true
  azuread_authentication_as_arm_policy_enabled = true
  role_assignment_mode                         = "AbacRepositoryPermissions"
  tags                                         = local.tags
}

resource "azurerm_key_vault" "runtime" {
  name                          = "${local.base_name}-kv"
  location                      = azurerm_resource_group.foundation.location
  resource_group_name           = azurerm_resource_group.foundation.name
  tenant_id                     = data.azurerm_client_config.operator.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  public_network_access_enabled = true
  soft_delete_retention_days    = 7
  purge_protection_enabled      = true
  tags                          = local.tags
}

resource "azurerm_role_assignment" "publish_images" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "Container Registry Repository Writer"
  principal_id         = data.azurerm_client_config.operator.object_id
}

resource "azurerm_role_assignment" "manage_runtime_secrets" {
  scope                = azurerm_key_vault.runtime.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.operator.object_id
}

output "foundation_resource_group" {
  value = azurerm_resource_group.foundation.name
}

output "acr_name" {
  value = azurerm_container_registry.images.name
}

output "existing_acr" {
  description = "Container Registry inputs for the separate hosted edition."
  value = {
    resource_id        = azurerm_container_registry.images.id
    login_server       = azurerm_container_registry.images.login_server
    authorization_mode = "abac"
  }
}

output "vault_name" {
  value = azurerm_key_vault.runtime.name
}

output "vault_resource_id" {
  value = azurerm_key_vault.runtime.id
}

output "vault_uri" {
  value = azurerm_key_vault.runtime.vault_uri
}
