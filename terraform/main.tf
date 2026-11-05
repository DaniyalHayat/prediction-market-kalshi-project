data "aws_caller_identity" "current" {
  count = local.enabled ? 1 : 0
}

resource "aws_ecr_repository" "backend" {
  count                = local.registry ? 1 : 0
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration {
    encryption_type = "AES256"
  }
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  count      = local.registry ? 1 : 0
  repository = aws_ecr_repository.backend[0].name
  policy = jsonencode({ rules = [{ rulePriority = 1, description = "Expire untagged images after 14 days", selection = {
    tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14
  }, action = { type = "expire" } }] })
}

resource "aws_vpc" "backend" {
  count                = local.enabled ? 1 : 0
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  depends_on           = [terraform_data.approval_gate]
}

resource "aws_subnet" "public" {
  count             = local.enabled ? 2 : 0
  vpc_id            = aws_vpc.backend[0].id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(aws_vpc.backend[0].cidr_block, 8, count.index)
}

resource "aws_subnet" "database" {
  count             = local.enabled ? 2 : 0
  vpc_id            = aws_vpc.backend[0].id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(aws_vpc.backend[0].cidr_block, 8, count.index + 10)
}

resource "aws_internet_gateway" "backend" {
  count  = local.enabled ? 1 : 0
  vpc_id = aws_vpc.backend[0].id
}

resource "aws_route_table" "public" {
  count  = local.enabled ? 1 : 0
  vpc_id = aws_vpc.backend[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.backend[0].id
  }
}

resource "aws_route_table_association" "public" {
  count          = local.enabled ? 2 : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "database" {
  count  = local.enabled ? 1 : 0
  vpc_id = aws_vpc.backend[0].id
}

resource "aws_route_table_association" "database" {
  count          = local.enabled ? 2 : 0
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database[0].id
}

resource "aws_security_group" "load_balancer" {
  count  = local.enabled ? 1 : 0
  name   = "${local.name}-https"
  vpc_id = aws_vpc.backend[0].id
}

resource "aws_security_group" "application" {
  count  = local.enabled ? 1 : 0
  name   = "${local.name}-application"
  vpc_id = aws_vpc.backend[0].id
}

resource "aws_security_group" "database" {
  count  = local.enabled ? 1 : 0
  name   = "${local.name}-database"
  vpc_id = aws_vpc.backend[0].id
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  count             = local.enabled ? 1 : 0
  security_group_id = aws_security_group.load_balancer[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "load_balancer" {
  count                        = local.enabled ? 1 : 0
  security_group_id            = aws_security_group.load_balancer[0].id
  referenced_security_group_id = aws_security_group.application[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8780
  to_port                      = 8780
}

resource "aws_vpc_security_group_ingress_rule" "application" {
  count                        = local.enabled ? 1 : 0
  security_group_id            = aws_security_group.application[0].id
  referenced_security_group_id = aws_security_group.load_balancer[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8780
  to_port                      = 8780
}

resource "aws_vpc_security_group_egress_rule" "application_https" {
  count             = local.enabled ? 1 : 0
  security_group_id = aws_security_group.application[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "application_postgres" {
  count                        = local.enabled ? 1 : 0
  security_group_id            = aws_security_group.application[0].id
  referenced_security_group_id = aws_security_group.database[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  count                        = local.enabled ? 1 : 0
  security_group_id            = aws_security_group.database[0].id
  referenced_security_group_id = aws_security_group.application[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "backend" {
  count      = local.enabled ? 1 : 0
  name       = local.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "backend" {
  count  = local.enabled ? 1 : 0
  name   = local.name
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "backend" {
  count                           = local.enabled ? 1 : 0
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = var.postgres_engine_version
  instance_class                  = "db.t4g.micro"
  allocated_storage               = 20
  max_allocated_storage           = 25
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "marketlab"
  username                        = "marketlab_owner"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.backend[0].name
  parameter_group_name            = aws_db_parameter_group.backend[0].name
  vpc_security_group_ids          = [aws_security_group.database[0].id]
  publicly_accessible             = false
  multi_az                        = false
  backup_retention_period         = 7
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  auto_minor_version_upgrade      = true
  allow_major_version_upgrade     = false
  apply_immediately               = false
  enabled_cloudwatch_logs_exports = ["postgresql"]
  depends_on                      = [aws_cloudwatch_log_group.database]
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "database" {
  count             = local.enabled ? 1 : 0
  name              = "/aws/rds/instance/${local.name}/postgresql"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "backend" {
  count             = local.compute ? 1 : 0
  name              = "/predictir/${var.environment}/backend"
  retention_in_days = 7
}

resource "aws_iam_role" "execution" {
  count = local.compute ? 1 : 0
  name  = "${local.name}-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole", Condition = {
    StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current[0].account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current[0].account_id}:*" }
  } }] })
}

resource "aws_iam_role_policy" "execution" {
  count = local.compute ? 1 : 0
  name  = "scoped-container-runtime"
  role  = aws_iam_role.execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.backend[0].arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.backend[0].arn}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = values(var.application_secret_arns) }
  ], length(var.secret_kms_key_arns) > 0 ? [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.secret_kms_key_arns, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } } }] : []) })
}

resource "aws_ecs_cluster" "backend" {
  count = local.compute ? 1 : 0
  name  = local.name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_task_definition" "backend" {
  count                    = local.compute ? 1 : 0
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution[0].arn
  volume {
    name = "model-cache"
  }
  container_definitions = jsonencode([{
    name             = "backend", image = var.container_image, essential = true, user = "1000", readonlyRootFilesystem = true,
    portMappings     = [{ containerPort = 8780, protocol = "tcp" }],
    environment      = [{ name = "PORT", value = "8780" }, { name = "HOST", value = "0.0.0.0" }, { name = "NODE_ENV", value = "production" }, { name = "MARKET_PIPELINE_ENABLED", value = "0" }, { name = "SEMANTIC_MODEL_CACHE_DIR", value = "/tmp/market-lab-models" }],
    mountPoints      = [{ sourceVolume = "model-cache", containerPath = "/tmp/market-lab-models", readOnly = false }],
    secrets          = [for key, arn in var.application_secret_arns : { name = key, valueFrom = arn }],
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.backend[0].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "backend", "mode" = "non-blocking", "max-buffer-size" = "4m" } },
    linuxParameters  = { capabilities = { drop = ["ALL"] } },
    healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8780/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
  }])
}

resource "aws_lb" "backend" {
  count                      = local.compute ? 1 : 0
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.load_balancer[0].id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "backend" {
  count       = local.compute ? 1 : 0
  name        = local.name
  port        = 8780
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.backend[0].id
  health_check {
    path    = "/api/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "https" {
  count             = local.compute ? 1 : 0
  load_balancer_arn = aws_lb.backend[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend[0].arn
  }
}

resource "aws_ecs_service" "backend" {
  count                              = local.compute ? 1 : 0
  name                               = local.name
  cluster                            = aws_ecs_cluster.backend[0].id
  task_definition                    = aws_ecs_task_definition.backend[0].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  wait_for_steady_state              = true
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.application[0].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.backend[0].arn
    container_name   = "backend"
    container_port   = 8780
  }
  depends_on = [aws_lb_listener.https, aws_iam_role_policy.execution]
}
