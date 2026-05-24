terraform {
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

resource "aws_lambda_function" "rootkey_connector" {
  function_name    = "rootkey-s3-connector-${var.bucket_name}"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  role             = var.iam_role_arn
  timeout          = 300
  memory_size      = 1024

  environment {
    variables = {
      ROOTKEY_API_KEY = var.rootkey_api_key
      ROOTKEY_API_URL = var.rootkey_api_url
    }
  }
}

resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rootkey_connector.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = "arn:aws:s3:::${var.bucket_name}"
}

resource "aws_s3_bucket_notification" "rootkey_trigger" {
  bucket = var.bucket_name

  lambda_function {
    lambda_function_arn = aws_lambda_function.rootkey_connector.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = var.prefix != "" ? var.prefix : null
  }

  depends_on = [aws_lambda_permission.allow_s3]
}
