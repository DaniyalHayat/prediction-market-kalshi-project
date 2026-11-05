terraform {
  required_version = ">= 1.11, < 2.0"
}

variable "azure_enabled" {
  description = "The offline replay root cannot enable Azure resources."
  type        = bool
  default     = false

  validation {
    condition     = !var.azure_enabled
    error_message = "Use terraform/azure/hosted for an approved Azure deployment."
  }
}

output "profile" {
  description = "Provider-free replay has no Azure resources or paid service prerequisites."
  value = {
    mode       = "replay"
    azure      = var.azure_enabled
    apps       = false
    postgresql = false
  }
}
