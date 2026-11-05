mock_provider "aws" {}

run "disabled_creates_no_cloud_resources" {
  command = plan
  assert {
    condition     = length(aws_vpc.backend) == 0 && length(aws_db_instance.backend) == 0 && length(aws_ecs_service.backend) == 0 && length(aws_ecr_repository.backend) == 0
    error_message = "The default profile must never create cloud resources."
  }
}

run "registry_does_not_create_compute_or_database" {
  command = plan
  variables {
    profile                     = "registry"
    external_registry_approved  = true
    approved_monthly_budget_usd = 1
  }
  assert {
    condition     = length(aws_ecr_repository.backend) == 1 && length(aws_vpc.backend) == 0 && length(aws_db_instance.backend) == 0 && length(aws_ecs_service.backend) == 0
    error_message = "The registry-only option must not create a compute/database migration."
  }
}

run "migration_requires_approval" {
  command = plan
  variables {
    profile = "aws-reference"
  }
  expect_failures = [terraform_data.approval_gate]
}

run "reviewed_profile_security" {
  command = plan
  variables {
    profile                     = "aws-reference"
    enable_compute              = true
    migration_approved          = true
    external_registry_approved  = true
    approved_monthly_budget_usd = 60
    container_image             = "123456789012.dkr.ecr.us-east-1.amazonaws.com/predictir-review@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    certificate_arn             = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-4000-8000-000000000001"
    application_secret_arns = {
      DATABASE_URL       = "arn:aws:secretsmanager:us-east-1:123456789012:secret:review-db-AAAAAA"
      MARKET_EDGE_SECRET = "arn:aws:secretsmanager:us-east-1:123456789012:secret:review-edge-AAAAAA"
    }
  }
  assert {
    condition     = !aws_db_instance.backend[0].publicly_accessible && aws_db_instance.backend[0].storage_encrypted && aws_db_instance.backend[0].deletion_protection && aws_db_instance.backend[0].manage_master_user_password
    error_message = "Database must remain private, encrypted and protected, with AWS-managed owner credentials."
  }
  assert {
    condition     = aws_ecs_service.backend[0].desired_count == 1 && aws_ecs_service.backend[0].deployment_maximum_percent == 100 && aws_ecs_service.backend[0].deployment_minimum_healthy_percent == 0
    error_message = "Do not double the bounded app pool during rolling replacement without a separate connection-budget review."
  }
}

run "database_bootstrap_precedes_compute" {
  command = plan
  variables {
    profile                     = "aws-reference"
    migration_approved          = true
    external_registry_approved  = true
    approved_monthly_budget_usd = 60
  }
  assert {
    condition     = length(aws_db_instance.backend) == 1 && length(aws_ecs_service.backend) == 0 && length(aws_lb.backend) == 0
    error_message = "Bootstrap the private database and restricted runtime secret before enabling compute."
  }
}
