variable "project_name" {
  description = "Lowercase prefix used for AWS resource names."
  type        = string
  default     = "adminbot-v2"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.project_name))
    error_message = "project_name must be 3-31 lowercase letters, numbers, or hyphens."
  }
}

variable "aws_region" {
  description = "AWS region for the single-instance deployment."
  type        = string
  default     = "eu-west-2"
}

variable "vpc_cidr" {
  description = "CIDR for the isolated AdminBot VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR for the no-ingress application subnet."
  type        = string
  default     = "10.42.1.0/24"
}

variable "instance_type" {
  description = "EC2 instance type. AdminBot currently targets x86_64."
  type        = string
  default     = "t3.small"
}

variable "state_volume_gib" {
  description = "Size of the encrypted, persistent gp3 volume containing SQLite state."
  type        = number
  default     = 30

  validation {
    condition     = var.state_volume_gib >= 8 && var.state_volume_gib <= 1024
    error_message = "state_volume_gib must be between 8 and 1024 GiB."
  }
}

variable "image_tag" {
  description = "Immutable image tag, normally the Git commit SHA. The tag is shared by API and web images."
  type        = string

  validation {
    condition = (
      length(trimspace(var.image_tag)) > 0 &&
      lower(trimspace(var.image_tag)) != "latest" &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    )
    error_message = "image_tag must be a valid immutable container tag and cannot be latest."
  }
}

variable "web_origin" {
  description = "Exact browser origin used through the SSM port-forward tunnel."
  type        = string
  default     = "http://127.0.0.1:8080"

  validation {
    condition     = can(regex("^http://(127\\.0\\.0\\.1|localhost):[0-9]{1,5}$", var.web_origin))
    error_message = "web_origin must remain a loopback HTTP origin for the private SSM deployment."
  }
}

variable "backup_retention_days" {
  description = "Number of days AWS Backup retains daily EBS recovery points."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 365
    error_message = "backup_retention_days must be between 7 and 365."
  }
}

variable "tags" {
  description = "Additional tags applied to all supported AWS resources."
  type        = map(string)
  default     = {}
}
