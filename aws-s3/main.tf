terraform {
  required_version = ">= 1.3"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  function_name = substr("rootkey-s3-connector-${var.bucket_name}", 0, 64)
  role_name     = element(split("/", var.iam_role_arn), length(split("/", var.iam_role_arn)) - 1)

  common_tags = merge(
    {
      "rootkey:managed-by" = "terraform"
      "rootkey:connector"  = "aws-s3"
      "rootkey:bucket"     = var.bucket_name
    },
    var.tags,
  )
}

# ─── Lambda build ──────────────────────────────────────────────────────────────

resource "null_resource" "lambda_build" {
  triggers = {
    source_hash  = filemd5("${path.module}/lambda/index.ts")
    package_hash = filemd5("${path.module}/lambda/package.json")
  }

  provisioner "local-exec" {
    command     = "npm ci && npm run build"
    working_dir = "${path.module}/lambda"
  }
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/dist"
  output_path = "${path.module}/lambda.zip"

  depends_on = [null_resource.lambda_build]
}

# ─── Secret: ROOTKey API key ───────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "api_key" {
  name_prefix = "rootkey-connector-${var.bucket_name}-"
  description = "ROOTKey Connector API Key for bucket ${var.bucket_name}"
  tags        = local.common_tags
}

resource "aws_secretsmanager_secret_version" "api_key" {
  secret_id     = aws_secretsmanager_secret.api_key.id
  secret_string = var.rootkey_api_key
}

# ─── CloudWatch log group (managed retention) ──────────────────────────────────

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

# ─── Dead-letter queue for failed async invocations ────────────────────────────

resource "aws_sqs_queue" "dlq" {
  name                      = substr("${local.function_name}-dlq", 0, 80)
  message_retention_seconds = 1209600 # 14 days
  tags                      = local.common_tags
}

# ─── IAM: inline policy on the customer's pre-existing role ────────────────────

resource "aws_iam_role_policy" "lambda" {
  name = "rootkey-s3-connector"
  role = local.role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadS3Objects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectAttributes",
        ]
        Resource = "arn:aws:s3:::${var.bucket_name}/*"
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid      = "ReadApiKeySecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.api_key.arn
      },
      {
        Sid      = "SendToDLQ"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.dlq.arn
      },
    ]
  })
}

# ─── Lambda function ───────────────────────────────────────────────────────────

resource "aws_lambda_function" "rootkey_connector" {
  function_name    = local.function_name
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  role             = var.iam_role_arn
  timeout          = 300
  memory_size      = 1024
  tags             = local.common_tags

  environment {
    variables = {
      ROOTKEY_API_URL            = var.rootkey_api_url
      ROOTKEY_API_KEY_SECRET_ARN = aws_secretsmanager_secret.api_key.arn
      MAX_FILE_SIZE_BYTES        = tostring(var.max_file_size_bytes)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
    aws_secretsmanager_secret_version.api_key,
  ]
}

resource "aws_lambda_function_event_invoke_config" "retries" {
  function_name                = aws_lambda_function.rootkey_connector.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.dlq.arn
    }
  }
}

# ─── EventBridge wiring ────────────────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "s3_object_created" {
  name        = substr("${local.function_name}-rule", 0, 64)
  description = "ROOTKey S3 connector: forward Object Created events to the connector Lambda"
  tags        = local.common_tags

  event_pattern = jsonencode(merge(
    {
      source        = ["aws.s3"]
      "detail-type" = ["Object Created"]
      detail = {
        bucket = {
          name = [var.bucket_name]
        }
      }
    },
    var.prefix != "" ? {
      detail = {
        bucket = { name = [var.bucket_name] }
        object = { key = [{ prefix = var.prefix }] }
      }
    } : {},
  ))
}

resource "aws_cloudwatch_event_target" "lambda" {
  rule = aws_cloudwatch_event_rule.s3_object_created.name
  arn  = aws_lambda_function.rootkey_connector.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id   = "AllowEventBridgeInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.rootkey_connector.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.s3_object_created.arn
  source_account = data.aws_caller_identity.current.account_id
}
