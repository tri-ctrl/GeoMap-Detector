"""Storage-authoritative multipart validation, including completion crash recovery."""
import math
from datetime import datetime, timezone

from fastapi import HTTPException
from botocore.exceptions import ClientError

from ingestion_common.config import settings


def assert_uploading(row):
    if row["status"] != "uploading":
        raise HTTPException(409, f"Upload is {row['status']}")
    if row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(410, "Upload session expired; start a new upload")


def list_parts(client, row):
    parts = []
    for page in client.get_paginator("list_parts").paginate(
            Bucket=settings.bucket, Key=row["object_key"], UploadId=row["s3_upload_id"]):
        parts.extend(page.get("Parts", []))
    return parts


def validate_parts(row, stored, submitted):
    expected_count = math.ceil(row["size"] / row["part_size"])
    if len(stored) != expected_count or len(submitted) != expected_count:
        raise HTTPException(409, "All parts must finish before completion")
    for number, (actual, provided) in enumerate(zip(stored, submitted), 1):
        expected_size = min(row["part_size"], row["size"] - (number - 1) * row["part_size"])
        if (actual["PartNumber"] != number or provided.part_number != number or
                actual["Size"] != expected_size or actual["ETag"].strip('"') != provided.etag.strip('"')):
            raise HTTPException(409, f"Part {number} does not match storage or declared size")


def complete_object(client, row, submitted):
    # If S3 completed but the DB transaction failed, validate the immutable metadata
    # and recover the object instead of attempting a missing multipart session.
    try:
        head = client.head_object(Bucket=settings.bucket, Key=row["object_key"])
    except ClientError as error:
        if error.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
            raise
    else:
        if (head["ContentLength"] != row["size"] or head.get("Metadata", {}).get("upload-id") != str(row["id"])):
            raise HTTPException(409, "Stored object does not match this upload")
        return
    stored = list_parts(client, row)
    validate_parts(row, stored, submitted)
    client.complete_multipart_upload(Bucket=settings.bucket, Key=row["object_key"], UploadId=row["s3_upload_id"],
                                    MultipartUpload={"Parts": [{"PartNumber": p["PartNumber"], "ETag": p["ETag"]} for p in stored]})
