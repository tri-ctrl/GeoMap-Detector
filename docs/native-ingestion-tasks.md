# GMD-038 — Ingestion without Docker

Requested 2026-11-26. Re-read the reference ingestion `src/main.py`,
`src/main_parser.py`, Airflow `dags/common.py` / `ingest_dags.py`, and the
backend's ingestion status handler and extension contract.

The reference parsers already run as Python programs. Docker packages their
dependencies and starts them; it is not part of the raster/vector conversion
algorithm. Preserve the current normalization, COG/preview, bounds, manifests,
upload attempt identity and Kafka result handling while making native execution
available.

## Implementation

- [x] Add a standalone file-to-directory Python CLI using the existing processors.
- [x] Add a bounded native subprocess runner with timeout and process-tree cleanup.
- [x] Let Airflow select native Python execution without importing Docker packages;
  keep the existing Compose deployment explicitly configured for Docker.
- [x] Provide native Python environment setup, configuration and service commands.
- [x] Test real file conversion, output manifests, failed input, request handoff,
  nonzero exits, timeouts and cancellation without invoking Docker.
- [x] Document setup, optional native decoder dependencies and remaining hosting requirements.
- [x] Make native ingestion the default Codespaces/CI path; keep container publishing manual.

## Acceptance and scope

`python -m processor.local INPUT OUTPUT` produces durable normalized layers and
a manifest without Airflow, Kafka, object storage or Docker. The Airflow-backed
upload workflow can use the same processor in a separate Python environment,
with PostgreSQL, Kafka and S3/MinIO supplied as native or managed services.
Native execution still requires a Python host for service-backed uploads.
Browser-only ingestion requires a separate client-side implementation.

## Verification

Implemented and verified natively on macOS ARM64 with Python 3.12.11. No Docker
commands were invoked for this task.

- 28 ingestion/native checks pass: 8 local CLI/subprocess checks, 6 existing GIS
  processor checks, 8 additional format checks, 3 native launcher checks and 3
  actual Airflow integration checks. The 24 baseline Python and 353 JavaScript
  regressions also pass: **52 Python / 353 JavaScript** for this verification.
- Real GeoTIFF/COG, geographic/projected vectors, Shapefile, KMZ/TAR, XLSX, GPX,
  CZML, LAS/LAZ, vector MBTiles and unlocated assets run in native Python.
- The reference `src/test/dataset/hfa/hfa.img` produces a COG, Web Mercator PNG
  and complete local manifest in `outputs/native-reference-hfa-verified/`.
- Airflow runs real tasks and a separate processor against an isolated HTTP S3
  emulator; compatible completion and failure events are captured. Kafka is
  captured in these tests. A full native deployment with a live PostgreSQL/Kafka/
  MinIO stack has not been provisioned or exercised here.
- Timeouts/cancellation reap processor/decoder processes, close stdin and remove
  scratch files. Failed input leaves no completed local bundle; original assets
  remain usable after the input is removed. Existing outputs are preserved.
- Native environment dependency checks, workflow YAML/bash and devcontainer JSON
  validation pass. Docker SDK/provider is absent from native environments.

[Setup and operation](native-ingestion.md) · [Verification record](gmd-038-verification.json).
