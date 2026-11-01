# OllaChat Desktop - Infrastructure as Code (IaC)

This directory contains Terraform Infrastructure as Code configurations to provision, manage, and scale the distribution infrastructure for the OllaChat Windows Desktop Client.

## Architecture Overview

```
+-----------------------------------------------------------+
|               GitHub Actions CI/CD Pipeline               |
|   (Builds NSIS Installer, Portable EXE, latest.yml)       |
+-----------------------------+-----------------------------+
                              | Uploads
                              v
                +---------------------------+
                |    Amazon S3 Bucket       |
                | (Encrypted, Versioned,    |
                |   Public Access Blocked)  |
                +-------------+-------------+
                              | Origin Access Control (OAC)
                              v
                +---------------------------+
                | CloudFront Global CDN     |
                |  - HTTPS (TLS 1.2+)       |
                |  - Low TTL for latest.yml |
                |  - Edge cache for .exe    |
                +-------------+-------------+
                              |
                              v
        +-------------------------------------------+
        |   End Users & Electron Auto-Updater       |
        +-------------------------------------------+
```

## Resources Managed by Terraform

1. **Amazon S3 Bucket (`aws_s3_bucket.releases`)**:
   - Secure artifact storage for `.exe` installers, `.blockmap` binary diffs, and `latest.yml` manifests.
   - Versioning enabled for zero-downtime rollbacks.
   - Server-Side Encryption (AES256) enabled.
   - All direct public ACLs and public policies blocked.
   - CORS enabled for HTTP GET/HEAD requests.

2. **CloudFront Origin Access Control (OAC) (`aws_cloudfront_origin_access_control.oac`)**:
   - SigV4 authenticated service connection between CloudFront and S3.
   - Enforces that S3 objects can **only** be read through the CloudFront CDN.

3. **CloudFront CDN Distribution (`aws_cloudfront_distribution.cdn`)**:
   - Global edge network ensuring sub-second downloads worldwide.
   - **`*latest*.yml` cache behavior**: 5-minute TTL (`default_ttl = 300`) so desktop clients detect newly published versions without delay.
   - **Binary cache behavior**: 24-hour default TTL for immutable release binaries (`OllaChat Setup 1.0.0.exe`).
   - Automated HTTP to HTTPS redirection.
   - Modern security headers (HSTS, X-Content-Type-Options: nosniff, Frame Options: DENY).

---

## Deployment Instructions

### Prerequisites
- [Terraform](https://developer.hashicorp.com/terraform/downloads) >= 1.5.0
- [AWS CLI](https://aws.amazon.com/cli/) authenticated with appropriate permissions (`s3:*`, `cloudfront:*`, `iam:*`)

### 1. Initialize Terraform
```bash
cd infra/terraform
terraform init
```

### 2. Configure Variables
Copy the example variables file:
```bash
cp terraform.tfvars.example terraform.tfvars
```
Adjust `aws_region`, `project_name`, and `environment` if desired.

### 3. Review Plan
```bash
terraform plan
```

### 4. Deploy Infrastructure
```bash
terraform apply
```

Upon completion, Terraform will output:
- `release_bucket_name`: Name of the S3 bucket created.
- `cloudfront_domain_name`: Domain name of the CDN (e.g. `d123456789.cloudfront.net`).
- `cdn_base_url`: HTTPS download base URL (e.g. `https://d123456789.cloudfront.net`).

---

## Syncing Releases via CLI / CI

Once the infrastructure is deployed, release artifacts can be published directly to S3 and CDN invalidated using the AWS CLI:

```bash
# 1. Sync release artifacts to S3
aws s3 sync release/ s3://<RELEASE_BUCKET_NAME>/ --exclude "*" --include "*.exe" --include "*.yml" --include "*.blockmap"

# 2. Invalidate latest.yml cache on CloudFront
aws cloudfront create-invalidation --distribution-id <CLOUDFRONT_DIST_ID> --paths "/latest.yml"
```

