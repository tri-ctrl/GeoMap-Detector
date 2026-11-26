import json

import boto3
from botocore.config import Config
from boto3.s3.transfer import TransferConfig

from .config import settings

TRANSFER = TransferConfig(multipart_threshold=16 * 1024**2, multipart_chunksize=16 * 1024**2, max_concurrency=3)


def s3(public=False):
    return boto3.client("s3", endpoint_url=settings.s3_public_endpoint if public else settings.s3_endpoint,
                        aws_access_key_id=settings.s3_access_key, aws_secret_access_key=settings.s3_secret_key,
                        region_name="us-east-1", config=Config(signature_version="s3v4", retries={"max_attempts": 4},
                        connect_timeout=5, read_timeout=60, s3={"addressing_style": "path"}))


def read_json(client, key, limit=2 * 1024**2):
    response = client.get_object(Bucket=settings.bucket, Key=key)
    with response["Body"] as body:
        if response["ContentLength"] > limit:
            raise ValueError("Manifest exceeds size limit")
        return json.loads(body.read(limit + 1))


def put_json(client, key, value):
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
    client.put_object(Bucket=settings.bucket, Key=key,
                      Body=encoded,
                      ContentType="application/json")
    return len(encoded)
