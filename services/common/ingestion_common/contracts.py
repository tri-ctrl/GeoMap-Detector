"""Versioned, bounded messages. Kafka carries metadata, never file bytes."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

SUPPORTED_EXTENSIONS = (".geojson", ".json", ".csv", ".kml", ".zip", ".gpkg", ".tif", ".tiff")


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Source(Contract):
    bucket: str = Field(min_length=1, max_length=63)
    key: str = Field(min_length=1, max_length=1024)
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)


class IngestionRequest(Contract):
    version: Literal[1] = 1
    upload_id: UUID
    attempt: int = Field(ge=1)
    source: Source

    @property
    def prefix(self):
        return f"processed/{self.upload_id}/{self.attempt}/"

    @property
    def run_id(self):
        return f"upload_{self.upload_id}_{self.attempt}"


class Artifact(Contract):
    role: Literal["data", "preview", "metadata"]
    key: str = Field(min_length=1, max_length=1024)
    media_type: str = Field(max_length=100)
    size: int = Field(ge=0)


class ProcessedFile(Contract):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(max_length=255)
    kind: Literal["vector", "raster"]
    bbox: tuple[float, float, float, float]
    feature_count: int | None = Field(default=None, ge=0)
    artifacts: list[Artifact] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def valid_bounds(self):
        west, south, east, north = self.bbox
        if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
            raise ValueError("Invalid WGS84 bounds")
        return self


class IngestionResult(Contract):
    version: Literal[1] = 1
    upload_id: UUID
    attempt: int = Field(ge=1)
    status: Literal["processing", "completed", "failed"]
    processed_files: list[ProcessedFile] = Field(default_factory=list, max_length=20)
    error: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def valid_result(self):
        if self.status == "completed" and not self.processed_files:
            raise ValueError("Completion requires processed files")
        if self.status != "completed" and self.processed_files:
            raise ValueError("Only completion may carry files")
        prefix = f"processed/{self.upload_id}/{self.attempt}/"
        for file in self.processed_files:
            for artifact in file.artifacts:
                if not artifact.key.startswith(prefix) or ".." in artifact.key.split("/"):
                    raise ValueError("Artifact outside this ingestion attempt")
        return self


def validate_source(request: IngestionRequest, bucket: str):
    """Only backend-owned object paths can be passed to a processor container."""
    if request.source.bucket != bucket or not request.source.key.startswith(f"uploads/{request.upload_id}/"):
        raise ValueError("Source outside this upload")
    if "/" in request.source.name or "\\" in request.source.name or ".." in request.source.key.split("/"):
        raise ValueError("Invalid source path")
    if not request.source.name.lower().endswith(SUPPORTED_EXTENSIONS):
        raise ValueError("Unsupported input format")
