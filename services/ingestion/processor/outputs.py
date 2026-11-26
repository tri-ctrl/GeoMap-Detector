"""Shared artifact and layer metadata for local files and object storage."""

from ingestion_common.contracts import ProcessedFile


def artifacts(layer):
    yield "data", layer["path"], layer.get(
        "media_type",
        "image/tiff" if layer["kind"] == "raster" else "application/geo+json",
    )
    if layer.get("preview") is not None:
        yield "preview", layer["preview"], "image/png"


def metadata(layer, source):
    return {
        "name": layer["name"],
        "kind": layer["kind"],
        "bbox": layer["bbox"],
        "feature_count": layer.get("feature_count"),
        "source": source,
        "message": layer.get("message"),
        "preview_crs": (
            "EPSG:3857"
            if layer["kind"] == "raster"
            else "EPSG:4326" if layer["bbox"] else None
        ),
    }


def processed_file(layer, file_id, files):
    return ProcessedFile(
        id=file_id,
        name=layer["name"],
        kind=layer["kind"],
        bbox=layer["bbox"],
        message=layer.get("message"),
        feature_count=layer.get("feature_count"),
        artifacts=files,
    )
