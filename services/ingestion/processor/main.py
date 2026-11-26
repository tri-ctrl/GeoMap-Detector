"""Disposable processor entry point; only manifests cross the service boundary."""
import json
import logging
import os
import tempfile
from pathlib import Path

from ingestion_common.config import settings
from ingestion_common.contracts import Artifact, IngestionRequest, IngestionResult, ProcessedFile, validate_source
from ingestion_common.storage import TRANSFER, put_json, s3
from .rasters import raster_layers
from .vectors import vector_layers

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
        client.download_file(settings.bucket, request.source.key, str(source), Config=TRANSFER)
        layers = raster_layers(source, workdir) if source.suffix.lower() in (".tif", ".tiff") else vector_layers(source, workdir)
        files = []
        for index, layer in enumerate(layers):
            file_id = f"layer-{index}"
            artifacts = []
            for role, file, media_type in [("data", layer["path"], "image/tiff" if layer["kind"] == "raster" else "application/geo+json"),
                                           ("preview", layer.get("preview"), "image/png")]:
                if file is None:
                    continue
                key = request.prefix + file_id + "/" + file.name
                client.upload_file(str(file), settings.bucket, key, ExtraArgs={"ContentType": media_type}, Config=TRANSFER)
                artifacts.append(Artifact(role=role, key=key, media_type=media_type, size=file.stat().st_size))
            metadata = {"name": layer["name"], "kind": layer["kind"], "bbox": layer["bbox"], "feature_count": layer.get("feature_count"),
                        "source": request.source.model_dump(), "preview_crs": "EPSG:3857" if layer["kind"] == "raster" else "EPSG:4326"}
            metadata_key = request.prefix + file_id + "/metadata.json"
            metadata_size = put_json(client, metadata_key, metadata)
            artifacts.append(Artifact(role="metadata", key=metadata_key, media_type="application/json", size=metadata_size))
            files.append(ProcessedFile(id=file_id, name=layer["name"], kind=layer["kind"], bbox=layer["bbox"], feature_count=layer.get("feature_count"), artifacts=artifacts))
        result = IngestionResult(upload_id=request.upload_id, attempt=request.attempt, status="completed", processed_files=files)
        put_json(client, request.prefix + "manifest.json", result.model_dump(mode="json"))
        return result


def main():
    logging.basicConfig(level=logging.INFO)
    request = IngestionRequest.model_validate_json(os.environ["INGESTION_REQUEST"])
    validate_source(request, settings.bucket)
    try:
        result = run(request)
        print(json.dumps({"manifest": request.prefix + "manifest.json", "files": len(result.processed_files)}))
    except Exception as error:
        log.exception("Processing failed for %s attempt %s", request.upload_id, request.attempt)
        # Parser errors are useful; infrastructure details remain in Airflow logs.
        detail = str(error)[:1000] if isinstance(error, ValueError) else "File processing failed; see Airflow task logs for details."
        put_json(s3(), request.prefix + "error.json", {"error": detail})
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
