"""Disposable processor entry point; only manifests cross the service boundary."""

import json
import logging
import os
import sys
import tempfile
from pathlib import Path

from ingestion_common.config import settings
from ingestion_common.contracts import (
    Artifact,
    IngestionRequest,
    IngestionResult,
    validate_source,
)
from ingestion_common.storage import TRANSFER, put_json, s3
from .dispatch import process
from .outputs import artifacts as layer_artifacts, metadata, processed_file

log = logging.getLogger(__name__)


def run(request):
    validate_source(request, settings.bucket)
    if request.source.size > settings.max_upload_bytes:
        raise ValueError("Input exceeds the configured upload size limit")
    client = s3()
    head = client.head_object(Bucket=settings.bucket, Key=request.source.key)
    if head["ContentLength"] != request.source.size:
        raise ValueError("Source object size changed")
    with tempfile.TemporaryDirectory(prefix="geomap-ingest-") as directory:
        workdir = Path(directory)
        (workdir / "input").mkdir()
        source = workdir / "input" / request.source.name
        client.download_file(
            settings.bucket, request.source.key, str(source), Config=TRANSFER
        )
        layers = process(source, workdir / "processed")
        files = []
        for index, layer in enumerate(layers):
            file_id = f"layer-{index}"
            artifacts = []
            for role, file, media_type in layer_artifacts(layer):
                key = request.prefix + file_id + "/" + file.name
                if file.resolve() == source.resolve():
                    client.copy(
                        {"Bucket": settings.bucket, "Key": request.source.key},
                        settings.bucket,
                        key,
                        ExtraArgs={
                            "ContentType": media_type,
                            "MetadataDirective": "REPLACE",
                        },
                        Config=TRANSFER,
                    )
                else:
                    client.upload_file(
                        str(file),
                        settings.bucket,
                        key,
                        ExtraArgs={"ContentType": media_type},
                        Config=TRANSFER,
                    )
                artifacts.append(
                    Artifact(
                        role=role,
                        key=key,
                        media_type=media_type,
                        size=file.stat().st_size,
                    )
                )
            metadata_key = request.prefix + file_id + "/metadata.json"
            metadata_size = put_json(
                client, metadata_key, metadata(layer, request.source.model_dump())
            )
            artifacts.append(
                Artifact(
                    role="metadata",
                    key=metadata_key,
                    media_type="application/json",
                    size=metadata_size,
                )
            )
            files.append(processed_file(layer, file_id, artifacts))
        result = IngestionResult(
            upload_id=request.upload_id,
            attempt=request.attempt,
            status="completed",
            processed_files=files,
        )
        put_json(
            client, request.prefix + "manifest.json", result.model_dump(mode="json")
        )
        return result


def main():
    logging.basicConfig(level=logging.INFO)
    if sys.argv[1:] == ["--request-stdin"]:
        payload = sys.stdin.buffer.read(65537)
        if len(payload) > 65536:
            raise ValueError("Processor request exceeds the 64 KiB handoff limit")
    elif not sys.argv[1:]:
        payload = os.environ["INGESTION_REQUEST"]
    else:
        raise SystemExit("Usage: python -m processor.main [--request-stdin]")
    request = IngestionRequest.model_validate_json(payload)
    validate_source(request, settings.bucket)
    try:
        result = run(request)
        print(
            json.dumps(
                {
                    "manifest": request.prefix + "manifest.json",
                    "files": len(result.processed_files),
                }
            )
        )
    except Exception as error:
        log.exception(
            "Processing failed for %s attempt %s", request.upload_id, request.attempt
        )
        # Parser errors are useful; infrastructure details remain in Airflow logs.
        detail = (
            str(error)[:1000]
            if isinstance(error, ValueError)
            else "File processing failed; see Airflow task logs for details."
        )
        put_json(s3(), request.prefix + "error.json", {"error": detail})
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
