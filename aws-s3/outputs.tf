output "lambda_arn" {
  description = "ARN of the deployed Lambda function."
  value       = aws_lambda_function.rootkey_connector.arn
}

output "lambda_function_name" {
  description = "Name of the deployed Lambda function."
  value       = aws_lambda_function.rootkey_connector.function_name
}

output "log_group_name" {
  description = "CloudWatch log group where the Lambda writes its logs."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "dlq_arn" {
  description = "ARN of the dead-letter SQS queue receiving events that failed after all retries."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  description = "URL of the dead-letter SQS queue."
  value       = aws_sqs_queue.dlq.url
}

output "api_key_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the ROOTKey API key."
  value       = aws_secretsmanager_secret.api_key.arn
}

output "event_rule_arn" {
  description = "ARN of the EventBridge rule that forwards S3 Object Created events to the Lambda."
  value       = aws_cloudwatch_event_rule.s3_object_created.arn
}
