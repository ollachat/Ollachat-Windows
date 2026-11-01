variable "aws_region" {
  description = "AWS Region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project identifier used in naming resources"
  type        = string
  default     = "ollachat"
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging, dev)"
  type        = string
  default     = "production"
}

variable "cloudfront_price_class" {
  description = "CloudFront distribution price class (PriceClass_100, PriceClass_200, PriceClass_All)"
  type        = string
  default     = "PriceClass_100"
}
