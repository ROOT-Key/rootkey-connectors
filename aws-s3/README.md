# AWS S3 Connector

Deploys a serverless integration into your AWS account. A Lambda function (TypeScript, Node.js 22) triggers on every new object upload to the monitored S3 bucket and uploads the file to the ROOTKey API using your Connector API Key.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## Prerequisites

- An AWS account with the target S3 bucket already created.
- An IAM Role already created with the following permissions (the Lambda assumes this role):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadS3Objects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    },
    {
      "Sid": "WriteLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

The role's trust policy must allow `lambda.amazonaws.com` to assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

- [Terraform](https://developer.hashicorp.com/terraform/install) installed (v1.3 or later).
- [Node.js](https://nodejs.org) 18+ installed on the machine running Terraform (used to compile the Lambda at `terraform apply` time).

## Setup

1. **Create the IAM Role** in your AWS account using the policy above. Note its ARN.
2. **Create a connector** in the ROOTKey dashboard. The IAM Role ARN is required during the wizard. At the end of the wizard, the dashboard generates a pre-filled Terraform block — copy it.
3. **Apply the Terraform module:**

```bash
terraform init
terraform apply
```

## Usage

Paste the pre-filled block from the ROOTKey dashboard into a `.tf` file, or configure it manually:

```hcl
module "rootkey_s3_connector" {
  source = "github.com/rootkey-ai/rootkey-connectors//aws-s3"

  bucket_name     = "my-company-documents"
  aws_region      = "eu-west-1"
  iam_role_arn    = "arn:aws:iam::123456789012:role/rootkey-lambda-role"
  rootkey_api_key = "rk_conn_xxxxxxxxxxxxxxxxxxxx"

  # Optional
  prefix          = "uploads/"           # monitor only a prefix; omit for the entire bucket
  rootkey_api_url = "https://api.rootkey.ai"  # default; only change if instructed
}
```

## Inputs

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `bucket_name` | string | yes | — | S3 bucket to monitor |
| `aws_region` | string | yes | — | AWS region of the bucket |
| `iam_role_arn` | string | yes | — | ARN of the pre-existing IAM Role the Lambda will assume |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard |
| `prefix` | string | no | `""` | S3 key prefix filter; leave empty to monitor the entire bucket |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL |

## Outputs

| Name | Description |
|---|---|
| `lambda_arn` | ARN of the deployed Lambda function |
| `lambda_function_name` | Name of the deployed Lambda function |

## Verification

Upload a test file to the monitored bucket:

```bash
aws s3 cp test.txt s3://my-company-documents/test.txt
```

Within a few seconds the file should appear in your ROOTKey vault. You can also check the Lambda logs in CloudWatch under `/aws/lambda/rootkey-s3-connector-<bucket-name>`.

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
