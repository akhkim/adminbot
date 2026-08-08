locals {
  common_tags = merge(var.tags, {
    Application = "AdminBot"
    Environment = "lab"
    ManagedBy   = "Terraform"
    Project     = var.project_name
  })

  api_image    = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
  web_image    = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
  ecr_registry = split("/", aws_ecr_repository.api.repository_url)[0]
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_vpc" "adminbot" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "adminbot" {
  vpc_id = aws_vpc.adminbot.id
  tags   = { Name = "${var.project_name}-igw" }
}

resource "aws_subnet" "app" {
  vpc_id                  = aws_vpc.adminbot.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-app" }
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.adminbot.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.adminbot.id
  }

  tags = { Name = "${var.project_name}-app" }
}

resource "aws_route_table_association" "app" {
  subnet_id      = aws_subnet.app.id
  route_table_id = aws_route_table.app.id
}

resource "aws_security_group" "instance" {
  name_prefix = "${var.project_name}-"
  description = "AdminBot no-ingress instance; access is through SSM only"
  vpc_id      = aws_vpc.adminbot.id

  tags = { Name = "${var.project_name}-no-ingress" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.instance.id
  description       = "TLS for SSM, ECR, Secrets Manager, and package/image retrieval"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.instance.id
  description       = "VPC DNS over UDP"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.instance.id
  description       = "VPC DNS fallback over TCP"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_kms_key" "adminbot" {
  description             = "AdminBot EBS, backup, and Secrets Manager encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = { Name = "${var.project_name}-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "adminbot" {
  name          = "alias/${var.project_name}-data"
  target_key_id = aws_kms_key.adminbot.key_id
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.project_name}/runtime"
  description             = "AdminBot runtime identity key and durable organization UUID"
  kms_key_id              = aws_kms_key.adminbot.arn
  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_repository" "api" {
  name                 = "${var.project_name}/api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.adminbot.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "web" {
  name                 = "${var.project_name}/web"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.adminbot.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy     = local.ecr_lifecycle_policy
}

locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest 30 release images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name_prefix        = "${var.project_name}-instance-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "EcrAuthentication"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PullAdminBotImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.api.arn, aws_ecr_repository.web.arn]
  }

  statement {
    sid       = "ReadRuntimeSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }

  statement {
    sid       = "DecryptRuntimeSecret"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.adminbot.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "instance" {
  name   = "${var.project_name}-runtime"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "${var.project_name}-"
  role        = aws_iam_role.instance.name
}

resource "aws_ebs_volume" "state" {
  availability_zone = aws_subnet.app.availability_zone
  encrypted         = true
  final_snapshot    = true
  kms_key_id        = aws_kms_key.adminbot.arn
  size              = var.state_volume_gib
  type              = "gp3"

  tags = { Name = "${var.project_name}-state" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "adminbot" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.app.id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  monitoring                  = true
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_protocol_ipv6          = "disabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted             = true
    kms_key_id            = aws_kms_key.adminbot.arn
    volume_size           = 16
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    api_image       = local.api_image
    aws_region      = var.aws_region
    ecr_registry    = local.ecr_registry
    secret_arn      = aws_secretsmanager_secret.runtime.arn
    state_volume_id = aws_ebs_volume.state.id
    web_image       = local.web_image
    web_origin      = var.web_origin
  })

  tags = { Name = var.project_name }

  depends_on = [
    aws_iam_role_policy.instance,
    aws_iam_role_policy_attachment.ssm,
    aws_route_table_association.app,
  ]
}

resource "aws_volume_attachment" "state" {
  device_name = "/dev/sdf"
  instance_id = aws_instance.adminbot.id
  volume_id   = aws_ebs_volume.state.id
}

data "aws_iam_policy_document" "backup_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name_prefix        = "${var.project_name}-backup-"
  assume_role_policy = data.aws_iam_policy_document.backup_assume_role.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_vault" "state" {
  name        = "${var.project_name}-state"
  kms_key_arn = aws_kms_key.adminbot.arn
}

resource "aws_backup_plan" "state" {
  name = "${var.project_name}-daily"

  rule {
    rule_name         = "daily-ebs"
    target_vault_name = aws_backup_vault.state.name
    schedule          = "cron(0 5 * * ? *)"
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_retention_days
    }
  }
}

resource "aws_backup_selection" "state" {
  iam_role_arn = aws_iam_role.backup.arn
  name         = "${var.project_name}-state-volume"
  plan_id      = aws_backup_plan.state.id
  resources    = [aws_ebs_volume.state.arn]
}
