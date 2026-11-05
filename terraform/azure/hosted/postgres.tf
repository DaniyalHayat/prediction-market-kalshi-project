locals {
  apps_subnet_cidr     = "10.196.0.0/26"
  postgres_subnet_cidr = "10.196.0.64/28"
}

resource "azurerm_virtual_network" "live" {
  count = local.live ? 1 : 0

  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.edition[0].location
  resource_group_name = azurerm_resource_group.edition[0].name
  address_space       = ["10.196.0.0/23"]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  count = local.live ? 1 : 0

  name                 = "container-apps"
  resource_group_name  = azurerm_resource_group.edition[0].name
  virtual_network_name = azurerm_virtual_network.live[0].name
  address_prefixes     = [local.apps_subnet_cidr]

  service_endpoint {
    service = "Microsoft.KeyVault"
  }

  delegation {
    name = "container-apps"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  count = local.live ? 1 : 0

  name                 = "postgres"
  resource_group_name  = azurerm_resource_group.edition[0].name
  virtual_network_name = azurerm_virtual_network.live[0].name
  address_prefixes     = [local.postgres_subnet_cidr]

  service_endpoint {
    service = "Microsoft.Storage"
  }

  delegation {
    name = "postgres"

    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_network_security_group" "postgres" {
  count = local.live ? 1 : 0

  name                = "${var.name_prefix}-postgres-nsg"
  location            = azurerm_resource_group.edition[0].location
  resource_group_name = azurerm_resource_group.edition[0].name
  tags                = local.tags

  security_rule {
    name                       = "AllowPostgresFromAppAndDatabaseSubnets"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    source_address_prefixes    = [local.apps_subnet_cidr, local.postgres_subnet_cidr]
    destination_port_range     = "5432"
    destination_address_prefix = local.postgres_subnet_cidr
  }

  security_rule {
    name                       = "DenyOtherPostgresIngress"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    source_address_prefix      = "*"
    destination_port_range     = "5432"
    destination_address_prefix = local.postgres_subnet_cidr
  }
}

resource "azurerm_subnet_network_security_group_association" "postgres" {
  count = local.live ? 1 : 0

  subnet_id                 = azurerm_subnet.postgres[0].id
  network_security_group_id = azurerm_network_security_group.postgres[0].id
}

resource "azurerm_private_dns_zone" "postgres" {
  count = local.live ? 1 : 0

  name                = "${var.name_prefix}-private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.edition[0].name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count = local.live ? 1 : 0

  name                 = "${var.name_prefix}-postgres-dns"
  private_dns_zone_id  = azurerm_private_dns_zone.postgres[0].id
  virtual_network_id   = azurerm_virtual_network.live[0].id
  registration_enabled = false
  tags                 = local.tags
}

resource "azurerm_postgresql_flexible_server" "live" {
  count = local.live ? 1 : 0

  name                = "${var.name_prefix}-postgres"
  location            = azurerm_resource_group.edition[0].location
  resource_group_name = azurerm_resource_group.edition[0].name
  version             = "17"
  sku_name            = "B_Standard_B1ms"

  delegated_subnet_id           = azurerm_subnet.postgres[0].id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres[0].id
  public_network_access_enabled = false

  administrator_login               = "predictir_admin"
  administrator_password_wo         = var.postgres_admin_password
  administrator_password_wo_version = var.postgres_admin_password_version

  storage_type                 = "Premium_LRS"
  storage_mb                   = 32768
  storage_tier                 = "P4"
  auto_grow_enabled            = false
  backup_retention_days        = 7
  geo_redundant_backup_enabled = false
  tags                         = local.tags

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [zone]
  }

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.postgres,
    azurerm_subnet_network_security_group_association.postgres,
  ]
}

resource "azurerm_postgresql_flexible_server_database" "predictir" {
  count = local.live ? 1 : 0

  name      = "predictir"
  server_id = azurerm_postgresql_flexible_server.live[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "tls" {
  count = local.live ? 1 : 0

  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.live[0].id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  count = local.live ? 1 : 0

  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.live[0].id
  value     = "PGCRYPTO,VECTOR"
}
