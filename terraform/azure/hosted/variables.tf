variable "azure_enabled" {
  description = "Explicit opt-in to Azure resource creation. The default replay plan creates no cloud resources."
  type        = bool
  default     = false
}

variable "keep_apps_warm" {
  description = "Keep one frontend and one backend replica running continuously to avoid cold starts. Include their compute in the reviewed spending estimate."
  type        = bool
  default     = false
}

variable "profile" {
  description = "Replay runs the embedded fixture without a database or external provider credentials. Live enables the private PostgreSQL foundation."
  type        = string
  default     = "replay"

  validation {
    condition     = contains(["replay", "live"], var.profile)
    error_message = "profile must be replay or live."
  }
}

variable "name_prefix" {
  description = "Lowercase letters and numbers used for resource names. Choose a globally unique prefix for the live PostgreSQL server."
  type        = string
  default     = "predictirlab"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,17}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and contain 3 to 18 lowercase letters or numbers."
  }
}

variable "subscription_id" {
  description = "Explicit Azure subscription for an enabled deployment."
  type        = string
  default     = null

  validation {
    condition     = var.subscription_id == null ? true : can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription GUID."
  }
}

variable "location" {
  description = "Azure region with compatible Consumption Container Apps and PostgreSQL 17 B1ms capacity for this subscription."
  type        = string
  default     = "eastus2"

  validation {
    condition     = contains(["eastus2", "centralus"], var.location)
    error_message = "Select East US 2 or Central US after checking subscription capacity and rates."
  }
}

variable "spend_approval" {
  description = "Operator's reviewed USD estimate and approval. Azure usage charges are metered and this guard is not a hard spending cap."
  type = object({
    approved_monthly_usd     = number
    reviewed_monthly_usd     = number
    accepts_metered_overages = bool
    credit_only              = optional(bool, false)
  })
  default = null
}

variable "images" {
  description = "Reviewed front and backend OCI image digests in the existing private Azure Container Registry."
  type = object({
    front   = string
    backend = string
  })
  default = null

  validation {
    condition = var.images == null ? true : alltrue([
      for image in [var.images.front, var.images.backend] :
      can(regex("^[a-z0-9][a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", image))
    ])
    error_message = "Both images must use a fully qualified registry and a sha256 digest."
  }
}

variable "existing_acr" {
  description = "Existing private Azure Container Registry. Required for hosted workloads. Terraform only manages the runtime pull grants."
  type = object({
    resource_id        = string
    login_server       = string
    authorization_mode = optional(string, "rbac")
  })
  default = null

  validation {
    condition = var.existing_acr == null ? true : (
      can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.ContainerRegistry/registries/[a-zA-Z0-9]+$", var.existing_acr.resource_id)) &&
      can(regex("^${lower(element(reverse(split("/", var.existing_acr.resource_id)), 0))}(-[a-z0-9]+)?\\.azurecr\\.io$", var.existing_acr.login_server)) &&
      contains(["rbac", "abac"], var.existing_acr.authorization_mode)
    )
    error_message = "existing_acr requires a matching registry resource ID and Azure login server, with rbac or abac authorization."
  }
}

variable "launch_live_apps" {
  description = "Enable live web apps after private database initialization, runtime role grants, and Key Vault secret preparation."
  type        = bool
  default     = false
}

variable "live_database_ready" {
  description = "Operator attestation that the live schema and least privilege application login have been verified inside the VNet."
  type        = bool
  default     = false
}

variable "postgres_admin_password" {
  description = "Ephemeral password for PostgreSQL provisioning or administrator password rotation. Supply through a private input such as TF_VAR_postgres_admin_password."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null

  validation {
    condition = (
      !var.azure_enabled || var.profile != "live"
      ) ? var.postgres_admin_password == null : (
      var.postgres_admin_password == null ? false : length(var.postgres_admin_password) >= 24
    )
    error_message = "An enabled live profile requires an ephemeral administrator password of at least 24 characters. Leave it unset for replay or a disabled deployment."
  }
}

variable "postgres_admin_password_version" {
  description = "Increment deliberately when rotating the write-only PostgreSQL administrator password."
  type        = number
  default     = 1

  validation {
    condition     = var.postgres_admin_password_version >= 1 && floor(var.postgres_admin_password_version) == var.postgres_admin_password_version
    error_message = "postgres_admin_password_version must be a positive integer."
  }
}

variable "live_secrets" {
  description = "Existing RBAC-enabled Key Vault and references to runtime secrets. Use an application database login in DATABASE_URL, separate from the provisioning administrator."
  type = object({
    vault_resource_id        = string
    edge_secret_uri          = string
    assistant_secret_uri     = string
    account_secret_uri       = string
    database_url_uri         = string
    database_ca_uri          = string
    provider_secret_uris     = optional(map(string), {})
    reddit_data_api_approved = optional(bool, false)
  })
  default = null

  validation {
    condition = var.live_secrets == null ? true : (
      can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.KeyVault/vaults/[a-zA-Z0-9-]+$", var.live_secrets.vault_resource_id)) &&
      alltrue([
        for uri in concat([var.live_secrets.edge_secret_uri, var.live_secrets.assistant_secret_uri, var.live_secrets.account_secret_uri, var.live_secrets.database_url_uri, var.live_secrets.database_ca_uri], values(var.live_secrets.provider_secret_uris)) :
        can(regex("^https://[a-z0-9-]+\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9-]+/[a-f0-9]{32}$", uri)) &&
        startswith(uri, "https://${lower(element(reverse(split("/", var.live_secrets.vault_resource_id)), 0))}.vault.azure.net/secrets/")
      ]) &&
      length(distinct([
        for uri in concat([var.live_secrets.edge_secret_uri, var.live_secrets.assistant_secret_uri, var.live_secrets.account_secret_uri, var.live_secrets.database_url_uri, var.live_secrets.database_ca_uri], values(var.live_secrets.provider_secret_uris)) :
        try(lower(split("/", uri)[4]), "")
      ])) == 5 + length(var.live_secrets.provider_secret_uris)
    )
    error_message = "Provide distinct, version-pinned runtime references from the specified Key Vault."
  }

  validation {
    condition = var.live_secrets == null ? true : (
      alltrue([for name in keys(var.live_secrets.provider_secret_uris) : contains([
        "spotify-client-id", "spotify-client-secret", "x-bearer-token", "reddit-client-id", "reddit-client-secret",
        "reddit-access-token", "reddit-refresh-token", "reddit-user-agent",
      ], name)]) &&
      contains(keys(var.live_secrets.provider_secret_uris), "spotify-client-id") == contains(keys(var.live_secrets.provider_secret_uris), "spotify-client-secret") &&
      contains(keys(var.live_secrets.provider_secret_uris), "reddit-client-id") == contains(keys(var.live_secrets.provider_secret_uris), "reddit-client-secret") &&
      (!contains(keys(var.live_secrets.provider_secret_uris), "reddit-refresh-token") || contains(keys(var.live_secrets.provider_secret_uris), "reddit-client-secret")) &&
      (var.live_secrets.reddit_data_api_approved ? (
        contains(keys(var.live_secrets.provider_secret_uris), "reddit-user-agent") &&
        (contains(keys(var.live_secrets.provider_secret_uris), "reddit-access-token") || contains(keys(var.live_secrets.provider_secret_uris), "reddit-client-secret"))
      ) : !anytrue([for name in keys(var.live_secrets.provider_secret_uris) : startswith(name, "reddit-")]))
    )
    error_message = "Provide complete Spotify or approved Reddit credential sets and use only supported backend provider references."
  }
}

variable "live_bootstrap" {
  description = "Temporary manual database bootstrap job. Set only for the private foundation stage and remove the job before opening live ingress."
  type = object({
    image              = string
    admin_password_uri = string
  })
  default = null

  validation {
    condition = var.live_bootstrap == null ? true : (
      can(regex("^[a-z0-9][a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.live_bootstrap.image)) &&
      can(regex("^https://[a-z0-9-]+\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9-]+/[a-f0-9]{32}$", var.live_bootstrap.admin_password_uri))
    )
    error_message = "The bootstrap requires an immutable image and a version-pinned administrator password reference."
  }
}

variable "live_owner" {
  description = "Optional existing single-tenant Entra owner application and the one approved user's object ID. Values are identifiers, not secrets."
  type = object({
    tenant_id = string
    client_id = string
    object_id = string
  })
  default = null

  validation {
    condition = var.live_owner == null ? true : alltrue([
      for id in values(var.live_owner) : can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", id))
    ])
    error_message = "The optional Entra owner configuration requires tenant, client and owner object GUIDs."
  }
}
