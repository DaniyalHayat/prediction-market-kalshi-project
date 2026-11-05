mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      object_id = "12345678-1111-2222-3333-123456789abc"
      tenant_id = "12345678-1111-2222-3333-123456789abd"
    }
  }
}

variables {
  subscription_id = "12345678-1111-2222-3333-123456789abc"
  name_suffix     = "mock1234"
}

run "foundation_access" {
  command = plan

  assert {
    condition     = azurerm_container_registry.images.sku == "Basic" && !azurerm_container_registry.images.admin_enabled && azurerm_container_registry.images.role_assignment_mode == "AbacRepositoryPermissions"
    error_message = "The foundation registry must remain Basic with Entra permissions and no shared administrator login."
  }

  assert {
    condition     = azurerm_key_vault.runtime.rbac_authorization_enabled && azurerm_key_vault.runtime.purge_protection_enabled && azurerm_key_vault.runtime.sku_name == "standard"
    error_message = "The runtime vault must use Standard RBAC with purge protection."
  }

  assert {
    condition     = azurerm_role_assignment.publish_images.role_definition_name == "Container Registry Repository Writer" && azurerm_role_assignment.manage_runtime_secrets.role_definition_name == "Key Vault Secrets Officer"
    error_message = "The deployer must receive the data-plane roles scoped to the registry and vault."
  }
}
