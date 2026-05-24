# ROOTKey Connectors

[![CI](https://github.com/ROOT-Key/rootkey-connectors/actions/workflows/ci.yml/badge.svg)](https://github.com/ROOT-Key/rootkey-connectors/actions/workflows/ci.yml)

Official deployment modules for integrating external storage and messaging services with the [ROOTKey](https://rootkey.ai) cyber resilience platform.

## What is ROOTKey?

ROOTKey is a cyber resilience platform that guarantees file integrity, authenticity, and recovery via blockchain anchoring. Every file uploaded through a connector is stored in full and anchored on the blockchain, enabling verified recovery in the event of corruption, ransomware, or data loss in the origin storage.

## What is this repository?

This repository contains the official modules that customers deploy on their own infrastructure to connect external storage and messaging services to ROOTKey. Each module is self-contained, auditable, and designed to run entirely within the customer's environment.

Connectors that operate exclusively within ROOTKey's backend (SharePoint, OneDrive) are not represented here — no customer-side deployment is required for those.

## How connectors work

1. Create a connector in the ROOTKey dashboard. The dashboard generates a unique **Connector API Key** for that connector.
2. Deploy the relevant module from this repository into your infrastructure, providing the Connector API Key.
3. From that point on, the module automatically detects new files and uploads them to the ROOTKey API:

```
POST {ROOTKEY_API_URL}/api-v1/files/
x-api-key: {ROOTKEY_API_KEY}
Content-Type: multipart/form-data
```

The multipart body must include the file as a binary field named `file`, with the original filename in the `Content-Disposition` header.

The **full file is uploaded** — this is intentional. ROOTKey's cyber resilience guarantee requires the actual file content for recovery, not just a hash.

## Connector index

| Connector | Technology | Customer deployment required | Directory |
|---|---|---|---|
| AWS S3 | Terraform + Lambda (TypeScript / Node.js 22) | Yes | [aws-s3/](aws-s3/) |
| SharePoint | Microsoft Graph | No | — |
| OneDrive | Microsoft Graph | No | — |

## Documentation

Full setup guides are available in the [ROOTKey documentation](https://docs.rootkey.ai).

## License

Copyright 2026 ROOTKey. Licensed under the [Apache License, Version 2.0](LICENSE).
