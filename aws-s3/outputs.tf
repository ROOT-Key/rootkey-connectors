output "lambda_arn" {
  description = "ARN of the deployed Lambda function."
  value       = aws_lambda_function.rootkey_connector.arn
}

output "lambda_function_name" {
  description = "Name of the deployed Lambda function."
  value       = aws_lambda_function.rootkey_connector.function_name
}
