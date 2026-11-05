output "profile" {
  value = var.profile
}
output "registry_url" {
  value = try(aws_ecr_repository.backend[0].repository_url, null)
}
output "backend_load_balancer_hostname" {
  value = try(aws_lb.backend[0].dns_name, null)
}
output "database_endpoint" {
  value = try(aws_db_instance.backend[0].address, null)
}
output "database_owner_secret_arn" {
  value       = try(aws_db_instance.backend[0].master_user_secret[0].secret_arn, null)
  description = "Bootstrap-only owner credential reference; do not grant the runtime access."
}
output "deployment_is_not_authorized" {
  value = "All profiles are pending separate review. No apply or production deployment is authorized by these files."
}
