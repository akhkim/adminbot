output "api_repository_url" {
  description = "ECR repository URL for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "aws_region" {
  description = "AWS region containing this deployment."
  value       = var.aws_region
}

output "web_repository_url" {
  description = "ECR repository URL for the web image."
  value       = aws_ecr_repository.web.repository_url
}

output "runtime_secret_arn" {
  description = "Secrets Manager container to populate out-of-band with the AWS CLI."
  value       = aws_secretsmanager_secret.runtime.arn
}

output "instance_id" {
  description = "SSM managed-instance target."
  value       = aws_instance.adminbot.id
}

output "state_volume_id" {
  description = "Persistent encrypted EBS volume containing SQLite state."
  value       = aws_ebs_volume.state.id
}

output "ssm_port_forward_command" {
  description = "Open the private web UI at http://127.0.0.1:8080 while this session runs."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.adminbot.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=8080,localPortNumber=8080"
}

output "ssm_shell_command" {
  description = "Open an audited administrative shell without SSH."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.adminbot.id}"
}
