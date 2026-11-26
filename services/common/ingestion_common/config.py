"""Environment-only configuration; public and internal S3 hosts must be distinct."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql://geomap:geomap@postgres/geomap")
    s3_endpoint: str = os.getenv("S3_ENDPOINT", "http://minio:9000")
    s3_public_endpoint: str = os.getenv("S3_PUBLIC_ENDPOINT", "http://localhost:9010")
    s3_access_key: str = os.getenv("S3_ACCESS_KEY", "geomap-local")
    s3_secret_key: str = os.getenv("S3_SECRET_KEY", "geomap-local-secret")
    bucket: str = os.getenv("S3_BUCKET", "geomap-files")
    kafka_bootstrap: str = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
    request_topic: str = "geomap.ingestion.request.v1"
    result_topic: str = "geomap.ingestion.result.v1"
    dead_letter_topic: str = "geomap.ingestion.dead-letter.v1"
    part_size: int = int(os.getenv("UPLOAD_PART_SIZE", str(16 * 1024 * 1024)))
    max_upload_bytes: int = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024**3)))
    url_ttl: int = 900


settings = Settings()
