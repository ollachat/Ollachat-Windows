output "release_bucket_name" {
  description = "The name of the S3 bucket hosting desktop releases"
  value       = aws_s3_bucket.releases.id
}

output "release_bucket_arn" {
  description = "The ARN of the S3 bucket"
  value       = aws_s3_bucket.releases.arn
}

output "cloudfront_distribution_id" {
  description = "The ID of the CloudFront distribution"
  value       = aws_cloudfront_distribution.cdn.id
}

output "cloudfront_domain_name" {
  description = "The CloudFront CDN domain name"
  value       = aws_cloudfront_distribution.cdn.domain_name
}

output "cdn_base_url" {
  description = "Base HTTPS download URL for OllaChat releases"
  value       = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "electron_builder_publish_config" {
  description = "Configuration snippet for electron-builder.yml publish setting"
  value       = <<-EOT
    publish:
      provider: s3
      bucket: ${aws_s3_bucket.releases.id}
      region: ${var.aws_region}
  EOT
}
