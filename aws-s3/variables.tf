variable "bucket_name" {
  type        = string
  description = "Name of the S3 bucket to monitor."
}

variable "aws_region" {
  type        = string
  description = "AWS region where the S3 bucket resides."
}

variable "iam_role_arn" {
  type        = string
  description = "ARN of a pre-existing IAM Role that the Lambda function will assume."
}

variable "rootkey_api_key" {
  type        = string
  sensitive   = true
  description = "Connector API Key from the ROOTKey dashboard."
}

variable "prefix" {
  type        = string
  default     = ""
  description = "S3 key prefix filter. Leave empty to monitor the entire bucket."
}

variable "rootkey_api_url" {
  type        = string
  default     = "https://api.rootkey.ai"
  description = "ROOTKey API base URL."
}
