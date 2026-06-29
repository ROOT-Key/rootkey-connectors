variable "bucket_name" {
  type        = string
  description = "Name of the S3 bucket to monitor. EventBridge notifications must be enabled on the bucket (see README)."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid S3 bucket name (3–63 lowercase alphanumeric chars, dots and hyphens; cannot start or end with a dot or hyphen)."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region where the S3 bucket resides."

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region identifier, e.g. eu-west-1."
  }
}

variable "iam_role_arn" {
  type        = string
  description = "ARN of a pre-existing IAM Role that the Lambda function will assume. The module will attach an inline policy to this role with the runtime permissions it needs (S3, Secrets Manager, SQS, CloudWatch Logs)."

  validation {
    condition     = can(regex("^arn:aws[a-zA-Z-]*:iam::[0-9]{12}:role/.+$", var.iam_role_arn))
    error_message = "iam_role_arn must be a valid IAM role ARN, e.g. arn:aws:iam::123456789012:role/my-role."
  }
}

variable "rootkey_api_key" {
  type        = string
  sensitive   = true
  description = "Connector API Key from the ROOTKey dashboard. Stored in AWS Secrets Manager; the Lambda reads it at cold start."

  validation {
    condition     = length(var.rootkey_api_key) > 0
    error_message = "rootkey_api_key must not be empty."
  }
}

variable "prefix" {
  type        = string
  default     = ""
  description = "S3 key prefix filter. Leave empty to monitor the entire bucket."
}

variable "rootkey_api_url" {
  type        = string
  default     = "https://api.rootkey.ai"
  description = "ROOTKey API base URL. Must use https://."

  validation {
    condition     = startswith(var.rootkey_api_url, "https://")
    error_message = "rootkey_api_url must start with https:// — plaintext HTTP is not supported."
  }
}

variable "max_file_size_bytes" {
  type        = number
  default     = 524288000 # 500 MiB
  description = "Maximum object size (in bytes) the Lambda will forward to ROOTKey. Objects above this are skipped with an error. Default 500 MiB; raise only after increasing Lambda memory_size proportionally."

  validation {
    condition     = var.max_file_size_bytes > 0 && var.max_file_size_bytes <= 5368709120
    error_message = "max_file_size_bytes must be between 1 and 5368709120 (5 GiB)."
  }
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "Number of days to retain CloudWatch logs for the Lambda. Must be a value accepted by aws_cloudwatch_log_group.retention_in_days."

  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      var.log_retention_days,
    )
    error_message = "log_retention_days must be one of: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653."
  }
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Extra tags applied to every resource created by this module. Module-managed tags (rootkey:managed-by, rootkey:connector, rootkey:bucket) cannot be overridden."
}
