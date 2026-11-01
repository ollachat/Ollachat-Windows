terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment to use S3 backend for remote state storage
  # backend "s3" {
  #   bucket         = "ollachat-terraform-state"
  #   key            = "desktop-client/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "ollachat-terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "OllaChat"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Repository  = "ollachat-windows-client"
    }
  }
}

# Local variables
locals {
  bucket_name = lower("${var.project_name}-desktop-releases-${var.environment}")
  s3_origin_id = "${var.project_name}-s3-origin"
}

# -----------------------------------------------------------------------------
# S3 Release Bucket
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "releases" {
  bucket        = local.bucket_name
  force_destroy = var.environment != "production"
}

resource "aws_s3_bucket_versioning" "releases" {
  bucket = aws_s3_bucket.releases.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket = aws_s3_bucket.releases.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type"]
    max_age_seconds = 3600
  }
}

# -----------------------------------------------------------------------------
# CloudFront Origin Access Control (OAC)
# -----------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${var.project_name}-oac-${var.environment}"
  description                       = "OAC for OllaChat Desktop client releases"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# CloudFront Response Headers Policy (Security & CORS)
# -----------------------------------------------------------------------------
resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${var.project_name}-security-headers-${var.environment}"
  comment = "Security headers for desktop release downloads"

  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_origins {
      items = ["*"]
    }
    origin_override = false
  }

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }
}

# -----------------------------------------------------------------------------
# CloudFront CDN Distribution
# -----------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "OllaChat Desktop Release CDN (${var.environment})"
  price_class         = var.cloudfront_price_class
  default_root_object = ""

  origin {
    domain_name              = aws_s3_bucket.releases.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  # Default cache behavior for binary files (.exe, .zip, .blockmap)
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = local.s3_origin_id

    forwarded_values {
      query_string = false
      headers      = ["Origin"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy     = "redirect-to-https"
    min_ttl                    = 0
    default_ttl                = 86400    # 24 hours
    max_ttl                    = 2592000  # 30 days
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  # Specialized cache behavior for latest.yml (auto-updater metadata)
  # Low TTL ensures client auto-updaters discover new releases immediately
  ordered_cache_behavior {
    path_pattern     = "*latest*.yml"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = local.s3_origin_id

    forwarded_values {
      query_string = true
      headers      = ["Origin"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy     = "redirect-to-https"
    min_ttl                    = 0
    default_ttl                = 300   # 5 minutes
    max_ttl                    = 600   # 10 minutes
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# -----------------------------------------------------------------------------
# S3 Bucket Policy (Authorizes CloudFront OAC)
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "s3_release_policy" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.releases.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.cdn.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id
  policy = data.aws_iam_policy_document.s3_release_policy.json
}
