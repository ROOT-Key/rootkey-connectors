# AWS S3 Connector

Deploys a serverless integration into your AWS account. An EventBridge rule listens for new objects in the monitored S3 bucket and invokes a Lambda function (TypeScript, Node.js 22) that streams each file to the ROOTKey API using your Connector API Key.

**Why the full file is uploaded:** ROOTKey's cyber resilience guarantee covers recovery — not just detection. Anchoring a hash alone cannot restore a corrupted or encrypted file. The full file content is required so ROOTKey can return the verified original on demand.

## What this module creates

| Resource | Purpose |
|---|---|
| `aws_lambda_function` | The connector itself (Node.js 22). |
| `aws_cloudwatch_event_rule` + `aws_cloudwatch_event_target` | Routes `s3:Object Created` events from EventBridge to the Lambda. |
| `aws_lambda_permission` | Allows EventBridge to invoke the Lambda, scoped to your account. |
| `aws_secretsmanager_secret` (+ version) | Stores the ROOTKey API key. The Lambda reads it at cold start; it is **not** stored in plain text as a Lambda env var. |
| `aws_cloudwatch_log_group` | Pre-created with a configurable retention (default 30 days) — avoids the indefinite retention you'd otherwise inherit. |
| `aws_sqs_queue` | Dead-letter queue for events that fail after retries. |
| `aws_lambda_function_event_invoke_config` | 2 async retries before sending the event to the DLQ. |
| `aws_iam_role_policy` | Inline policy attached to your existing role with exactly the runtime permissions the Lambda needs. |

The module does **not** touch your S3 bucket's notification configuration. That stays under your control.

## Secrets and Terraform state

Terraform records the attributes of everything it manages in a state file. By default that includes the *value* of any secret you pass in — marking a variable `sensitive` only masks it in CLI output, it does not keep it off disk. For a regulated environment that is usually the first question asked about an IaC module, so it is worth being precise about what this one does.

**The secrets you supply are never written to state.** `rootkey_api_key` is written with `secret_string_wo` — a write-only argument. The provider receives the value, sends it to Secrets Manager, and Terraform persists nothing. The same value is also absent from a saved plan file (`terraform plan -out=…`), because the corresponding input variables are declared `ephemeral`.

You can verify this yourself after an apply — the following returns nothing:

```bash
grep -i -c "<the secret value>" terraform.tfstate
```

**The cost of this: Terraform cannot detect that a secret changed.** It never sees the value, so it has nothing to compare against. That is what the `*_version` counters are for. Change a secret *and* increment its counter, and the new value is written. Change a secret and leave the counter alone, and **the apply succeeds while silently doing nothing** — this is the one sharp edge of the design, and it is why the rotation procedures below always name both steps.

**What does still live in the state file.** Being complete about this matters more than the headline:

| What | Why it is there |
|---|---|
| Resource ARNs, names, IAM policy documents | Infrastructure metadata. The Lambda's `environment` block holds the secret's **ARN**, never its value — the Lambda reads the value from Secrets Manager at cold start using its execution role. |
| CloudWatch log group and SQS queue names | Infrastructure metadata. |

None of these is a credential to your tenant, but list them anyway if you are producing an inventory for an audit.

**Where to keep the state file.** Even with no secrets in it, the state is an accurate map of your deployment and should not sit on an operator's laptop. Use a remote backend in your own cloud account — it also gives you state locking, so two people cannot apply at once:

```hcl
terraform {
  backend "s3" {
    bucket       = "my-tfstate-bucket"
    key          = "rootkey-connector.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true # S3-native state locking
  }
}
```

The trust boundary here is the same one you already accepted by letting the module create a Secrets Manager in your own subscription. If that is acceptable, the state is acceptable in the same place.

## Prerequisites

### 1. EventBridge notifications enabled on the bucket

This is the only manual setup step. In your existing bucket configuration, enable EventBridge:

**Terraform:**
```hcl
resource "aws_s3_bucket_notification" "my_bucket" {
  bucket      = "my-company-documents"
  eventbridge = true
  # ...keep any other notifications you already have here...
}
```

**AWS Console:** S3 → your bucket → Properties → Event notifications → Amazon EventBridge → **Edit** → On.

Because the module never touches `aws_s3_bucket_notification`, you can safely keep any other notifications (Lambda, SQS, SNS) already configured on the bucket — they are untouched.

### 2. A pre-existing IAM Role

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

No managed policies are needed on the role — the module attaches an inline policy granting **only** what the Lambda needs at runtime (S3 read of the configured bucket, Secrets Manager read of the API key secret, SQS write to the DLQ, and CloudWatch log writes).

The Terraform principal applying this module needs `iam:PutRolePolicy` on the role ARN.

### 3. Tooling

- [Terraform](https://developer.hashicorp.com/terraform/install) **v1.11 or later**. This is a hard floor, not a recommendation: the module uses write-only arguments to keep your secrets out of the Terraform state file, and those require 1.11. Older versions fail at `terraform init` with an explicit version error rather than silently writing the secret to disk.
- [Node.js](https://nodejs.org) 22+ on the machine running Terraform (used to compile the Lambda at `terraform apply` time).

## Setup

1. Enable EventBridge notifications on the bucket (above).
2. Create the IAM Role in your AWS account. Note its ARN.
3. Create a connector in the ROOTKey dashboard. The IAM Role ARN is required during the wizard. At the end of the wizard, the dashboard generates a pre-filled Terraform block — copy it.
4. Apply the Terraform module:

```bash
terraform init
terraform apply
```

## Usage

Paste the pre-filled block from the ROOTKey dashboard into a `.tf` file, or configure it manually:

```hcl
module "rootkey_s3_connector" {
  # Pin to a release tag. Without a ?ref= the source resolves to whatever is on
  # the default branch at the moment you run terraform init, which means two
  # people deploying a week apart can get different code — not acceptable
  # under most change-control regimes.
  source = "github.com/ROOT-Key/rootkey-connectors//aws-s3?ref=v1.0.0"

  bucket_name     = "my-company-documents"
  aws_region      = "eu-west-1"
  iam_role_arn    = "arn:aws:iam::123456789012:role/rootkey-lambda-role"
  rootkey_api_key = "rk_conn_xxxxxxxxxxxxxxxxxxxx"

  # Increment whenever you change rootkey_api_key above — see
  # "Secrets and Terraform state" below for why.
  rootkey_api_key_version = 1

  # Optional
  prefix              = "uploads/"             # monitor only a prefix; omit for the entire bucket
  rootkey_api_url     = "https://api.rootkey.ai" # default; only change if instructed
  max_file_size_bytes = 524288000              # default: 500 MiB
  log_retention_days  = 30                     # default
  tags = {
    "cost-center" = "security"
    "owner"       = "platform-team"
  }
}
```

## Inputs

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `bucket_name` | string | yes | — | S3 bucket to monitor (EventBridge must be enabled on it). |
| `aws_region` | string | yes | — | AWS region of the bucket. |
| `iam_role_arn` | string | yes | — | ARN of the pre-existing IAM Role the Lambda will assume. The module attaches an inline policy to it. |
| `rootkey_api_key` | string | yes | — | Connector API Key from the ROOTKey dashboard. Written to Secrets Manager as a write-only argument — never persisted to Terraform state or to a saved plan. |
| `rootkey_api_key_version` | number | no | `1` | Rotation counter. **Must be incremented whenever `rootkey_api_key` changes**, or the new value is silently ignored. |
| `prefix` | string | no | `""` | S3 key prefix filter; leave empty to monitor the entire bucket. |
| `rootkey_api_url` | string | no | `"https://api.rootkey.ai"` | ROOTKey API base URL. Must use `https://`. |
| `max_file_size_bytes` | number | no | `524288000` (500 MiB) | Objects larger than this are skipped with an error. Raise only after increasing Lambda memory_size. |
| `log_retention_days` | number | no | `30` | CloudWatch log retention. Must be a value accepted by AWS (1, 3, 7, 14, 30, 60, 90, …). |
| `tags` | map(string) | no | `{}` | Extra tags applied to every module-managed resource. |

## Outputs

| Name | Description |
|---|---|
| `lambda_arn` | ARN of the deployed Lambda function. |
| `lambda_function_name` | Name of the deployed Lambda function. |
| `log_group_name` | CloudWatch log group with the Lambda's logs. |
| `dlq_arn` / `dlq_url` | Dead-letter queue ARN and URL — monitor this for events that failed all retries. |
| `api_key_secret_arn` | ARN of the Secrets Manager secret holding the API key. |
| `event_rule_arn` | ARN of the EventBridge rule routing S3 events to the Lambda. |

## Reliability model

- **Async invocation with retries.** EventBridge invokes the Lambda asynchronously. On failure, Lambda's `event_invoke_config` retries 2 more times with exponential backoff. After that the event goes to the SQS DLQ.
- **Monitor the DLQ.** Set a CloudWatch alarm on `ApproximateNumberOfMessagesVisible` for the DLQ — any non-zero value means at least one file did not reach ROOTKey.
- **Per-event idempotency.** Each upload carries `x-rootkey-source-bucket`, `x-rootkey-source-key`, `x-rootkey-source-etag` and `x-rootkey-source-version-id` headers so the ROOTKey API can deduplicate redelivered events.
- **Versioning aware.** When EventBridge reports `version-id`, the Lambda passes it to `GetObject` so the exact version that triggered the event is uploaded, even if the object is overwritten later.

## Verification

Upload a test file to the monitored bucket:

```bash
aws s3 cp test.txt s3://my-company-documents/test.txt
```

Within a few seconds the file should appear in your ROOTKey vault. You can also check the Lambda logs in CloudWatch under `/aws/lambda/rootkey-s3-connector-<bucket-name>`.

If nothing arrives:
1. Confirm EventBridge is enabled on the bucket (Properties → Event notifications).
2. Check the DLQ — `terraform output dlq_url`.
3. Tail the Lambda logs — `aws logs tail $(terraform output -raw log_group_name) --follow`.

## Operational notes

- **Rotating the ROOTKey API key.** Delete the connector in the dashboard and create a new one (reuse the same bucket and role), then update **both** `rootkey_api_key` **and** `rootkey_api_key_version` (increment it), then `terraform apply`. Updating the key without incrementing the counter produces a successful apply that changes nothing — Terraform cannot see a write-only value, so the counter is its only signal. The Lambda reads the secret at cold start, so allow for warm containers still holding the old value for a few minutes, or force a new version to cycle them.

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](../LICENSE).
