# S3 Object Lock (COMPLIANCE) buckets for FieldSync:
#   * archive: long-term, write-once copies of exported events and reports
#   * anchors: independent home for signed audit checkpoints (use a different account/owner)
# COMPLIANCE mode: no principal, including root, can shorten retention or delete a locked version.
# NOTE: the reference service does not yet export events or upload checkpoints by itself; these
# buckets are the target for that deployment step (see docs/RUNBOOK.md). Not applied or validated
# against a real account by the author.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "name_prefix" { type = string }
variable "retention_days" {
  type    = number
  default = 2555
}

resource "aws_kms_key" "fieldsync" {
  description             = "${var.name_prefix} fieldsync encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

locals {
  buckets = { archive = "${var.name_prefix}-fieldsync-archive", anchors = "${var.name_prefix}-fieldsync-audit-anchors" }
}

resource "aws_s3_bucket" "b" {
  for_each            = local.buckets
  bucket              = each.value
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.b]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.fieldsync.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "b" {
  for_each                = aws_s3_bucket.b
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "tls_only" {
  for_each = aws_s3_bucket.b
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.tls_only[each.key].json
}

output "archive_bucket" { value = aws_s3_bucket.b["archive"].bucket }
output "anchors_bucket" { value = aws_s3_bucket.b["anchors"].bucket }
