variable "profile" {
  type    = string
  default = "disabled"
  validation {
    condition     = contains(["disabled", "registry", "aws-reference"], var.profile)
    error_message = "Select disabled, registry, or aws-reference. Existing Railway/Supabase resources are not imported."
  }
}
variable "migration_approved" {
  type    = bool
  default = false
}
variable "external_registry_approved" {
  type    = bool
  default = false
}
variable "enable_compute" {
  type    = bool
  default = false
}
variable "approved_monthly_budget_usd" {
  type    = number
  default = 0
}
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "review"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,16}$", var.environment))
    error_message = "Use a short lowercase environment name."
  }
}
variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
  validation {
    condition     = length(var.availability_zones) == 2 && length(toset(var.availability_zones)) == 2
    error_message = "Two distinct availability zones in the selected region are required."
  }
}
variable "container_image" {
  type    = string
  default = ""
}
variable "certificate_arn" {
  type    = string
  default = ""
}
variable "application_secret_arns" {
  type    = map(string)
  default = {}
  validation {
    condition     = alltrue([for key, value in var.application_secret_arns : can(regex("^[A-Z][A-Z0-9_]*$", key)) && can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", value))])
    error_message = "Only environment variable names and complete Secrets Manager ARNs are accepted; never pass secret values."
  }
}
variable "secret_kms_key_arns" {
  type    = list(string)
  default = []
}
variable "postgres_engine_version" {
  type    = string
  default = "17"
  validation {
    condition     = can(regex("^17([.][0-9]+)?$", var.postgres_engine_version))
    error_message = "Keep the reviewed PostgreSQL 17 major version. Review an 18 upgrade separately."
  }
}

locals {
  enabled  = var.profile == "aws-reference"
  compute  = var.profile == "aws-reference" && var.enable_compute
  registry = var.profile != "disabled"
  name     = "predictir-${var.environment}"
}

resource "terraform_data" "approval_gate" {
  input = var.profile
  lifecycle {
    precondition {
      condition     = !local.registry || (var.external_registry_approved && var.approved_monthly_budget_usd >= 1)
      error_message = "A paid external registry requires separate approval and a reviewed storage budget. No cloud resource creation is currently authorized."
    }
    precondition {
      condition     = !local.enabled || (var.migration_approved && var.approved_monthly_budget_usd >= 60)
      error_message = "AWS reference compute+RDS+ALB exceeds the current $25 incremental budget. Separate migration approval and a reviewed budget of at least $60/month are required. This is a floor, not a cost cap."
    }
    precondition {
      condition     = !local.compute || (can(regex("@sha256:[a-f0-9]{64}$", var.container_image)) && can(regex("^arn:aws:acm:", var.certificate_arn)))
      error_message = "Compute requires an immutable image digest and an existing validated ACM certificate."
    }
    precondition {
      condition     = !local.compute || alltrue([for key in ["DATABASE_URL", "MARKET_EDGE_SECRET"] : contains(keys(var.application_secret_arns), key)])
      error_message = "A separately bootstrapped least-privilege database URL and edge secret must exist in Secrets Manager first. Never inject the RDS master user into the application."
    }
  }
}
