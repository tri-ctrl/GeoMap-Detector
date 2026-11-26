# File upload and Airflow processing

The **Files** tab uploads geospatial files directly from the browser to MinIO in
16 MiB parts. The backend completes the object only after validating MinIO's part
sizes and ETags, records a durable ingestion request, and publishes it to Kafka.
Airflow launches this repository's processor Docker image. Processed artifacts go
back to MinIO, and a Kafka result updates the catalog shown in the portal.

The existing browser Esri/Wayback detection, saved annotations, static deployment,
and optional `backend/app.py` server keep their current behavior. Uploaded layers
can be previewed and vectors can become AOIs for Wayback detection. Running YOLO
directly on uploaded rasters is outside this feature.

## Start locally

Docker Compose and a running Docker Engine are required. Allow approximately
8 GiB of Docker memory for the complete stack. First builds download Python/GDAL,
Airflow and Go dependencies and compile MinIO and the native vector reader.

```sh
cp .env.example .env
docker compose up -d --build
docker compose ps
python3 scripts/smoke_ingestion.py
```

| Application | Default URL |
| --- | --- |
| Portal | http://localhost:8095 |
| Airflow | http://localhost:8096 |
| MinIO S3 API | http://localhost:9010 |
| MinIO console | http://localhost:9011 |

Airflow's local account defaults to `geomap` / `geomap-local-airflow`. MinIO's
local account defaults to `geomap-local` / `geomap-local-secret`. `.env.example`
contains the configurable credentials and port numbers. Ports bind to loopback;
PostgreSQL and Kafka have no published host ports. The stack has its own Compose
project, named volumes and network, without fixed container names.

If a port is occupied, change `WEB_PORT`, `AIRFLOW_PORT`, `MINIO_PORT` or
`MINIO_CONSOLE_PORT` in `.env`. When changing the portal or S3 port, also update
`UPLOAD_CORS_ORIGIN` and `S3_PUBLIC_ENDPOINT`. These must match the exact browser
origins, including `localhost` versus `127.0.0.1`. The public S3 hostname is used
when generating signatures; it must never be substituted into an already signed
URL. Airflow and workers always use the internal `http://minio:9000` address.

On GitHub Pages or another static server, open **Files**, enter
`http://localhost:8095` in **File processing server**, and connect. HTTPS pages may
require HTTPS for a remote processing server; use a trusted reverse proxy for
that deployment. The Files connection is independent from **Export → Processing**
and its optional detection server.
Set `UPLOAD_CORS_ORIGIN` to include that static page's origin (for example,
`http://localhost:8095,https://tri-ctrl.github.io`) before restarting MinIO.

The upload stack does not generate YOLO model weights. To run built-in browser
detection from the Compose portal, first follow the existing model export setup
(`python scripts/export_onnx.py`), then rebuild `web`. Generated local ONNX assets
are included in the web image when present.

For a corporate TLS proxy, supply a trusted PEM CA bundle as a build secret:

```sh
export BUILD_CA_BUNDLE=/absolute/path/to/trusted-ca-bundle.pem
docker compose -f compose.yaml -f compose.ca.yaml build
docker compose up -d
```

The bundle must include all required public and organization roots. It is mounted
only during dependency/source downloads and is not copied into the images.
Certificate verification remains enabled. Normal networks need only `compose.yaml`.
If the network's Go module proxy returns truncated archives, set
`GO_MODULE_PROXY=direct` for the MinIO build; module checksums are still verified.

## Files workflow

1. Open **Files** and choose a file. **Upload and process** starts up to three
   simultaneous direct-to-MinIO PUT requests. Progress counts transferred bytes.
2. **Pause upload** aborts active requests. Choose the original file and upload
   again to reuse confirmed parts. Reloading the page also permits resumption.
   **Cancel upload** discards the multipart session. Sessions expire after 24 hours.
   MinIO also cleans orphaned multipart sessions using its native stale-upload
   settings; its lifecycle API does not support S3's incomplete-upload rule.
3. The catalog shows `queued`, `processing`, `completed` or `failed`. Processing
   continues when the browser closes. **Retry processing** creates a new attempt
   from the already uploaded source.
4. **Show on map** displays one processed vector or raster preview at a time in
   2D. **Clear preview** releases the layer and any object URL. **Download** fetches
   the normalized GeoJSON or full COG. **Add as AOIs** imports polygon features
   and buffers points using the existing AOI buffer setting; line-only layers do
   not produce AOIs.

The catalog is paginated in groups of 25. It refreshes every five seconds while
Files is open, stops refreshing while hidden, and reloads server state on return.
The browser retains a bounded sample fingerprint (filename, size, modification
time, first/last MiB) and session UUID for resumption. This is a file-selection
check, not a whole-file content checksum. Do not modify a file while resuming it.

## Formats and bounds

| Input | Processed output |
| --- | --- |
| GeoJSON / JSON | Validated WGS84 FeatureCollection |
| CSV | WGS84 point FeatureCollection; requires `lat` and `lon` headers |
| KML | Placemark points, lines, polygons and MultiGeometry; network links are not followed |
| ZIP Shapefile | One output per Shapefile; include `.shp`, `.shx`, `.dbf`, `.prj` |
| GeoPackage | One GeoJSON per vector layer; requires a declared CRS |
| GeoTIFF | Cloud Optimized GeoTIFF plus transparent Web Mercator PNG preview |

Invalid coordinates, empty/invalid geometry, missing projections and unsupported
archives fail with an actionable catalog error. Nothing is silently assigned an
invented projection. Raster COGs retain the source CRS, resolution and bit depth;
only previews use Web Mercator and display stretching. Downloads are not reduced
to preview resolution. Raster display covers latitudes -85 through 85 degrees;
dateline-crossing rasters are not supported in this initial implementation.

Default limits: 10 GiB per upload (configurable), 10,000 multipart parts, 256 MiB
per vector input/output, 100,000 features per layer, 20 layers per upload, 200 ZIP
entries / 2 GiB extracted / 200:1 compression ratio. ZIP paths, links and encrypted
entries are rejected. Browser vector previews and AOI import are limited to
20 MiB / 20,000 features. Raster previews have a maximum side of 2,048 pixels;
processing permits at most 32 bands and 4 billion pixels. Each processor has a
2 GiB memory limit, one CPU share and a 30-minute task timeout. Two attempts can
run concurrently. Temporary inputs and intermediate files are deleted with the
container; source objects and processed artifacts remain durable in MinIO.

## Service boundaries and delivery

```mermaid
sequenceDiagram
  participant UI as Files panel
  participant API as Upload API / PostgreSQL
  participant S3 as MinIO
  participant K as Kafka
  participant A as Airflow bridge / DAG
  participant P as Processor container
  UI->>API: Initialize upload UUID, filename, size
  API->>S3: Create multipart session
  UI->>API: Request short-lived part URL
  UI->>S3: PUT parts (up to 3 concurrent)
  UI->>API: Complete with ordered ETags
  API->>S3: Verify parts; complete object
  API->>API: Commit queued state + outbox
  API->>K: IngestionRequest v1
  K->>A: Stable upload + attempt
  A->>P: DockerOperator
  P->>S3: Read source; write outputs + manifest
  A->>K: IngestionResult v1
  K->>API: Commit catalog update, then offset
  UI->>API: Poll catalog / request artifact URL
  UI->>S3: Read processed layer
```

- `services/common`: typed event/manifests, path validation, S3 and Kafka adapters.
- `services/upload-api`: stateless FastAPI routes, PostgreSQL schema, transactional
  outbox/result worker, expiration and infrastructure initializer.
- `services/airflow`: lightweight Kafka-to-REST bridge and one focused DAG using
  the official Docker provider. Airflow uses LocalExecutor and PostgreSQL.
- `services/ingestion`: format dispatch, streaming vector conversion, windowed
  COG conversion, bounded previews, deterministic per-attempt artifact paths.
- `services/minio`: pinned source build of official MinIO Community Edition.
- `services/web`: nginx hosting the existing portal and proxying `/api/`.

Kafka topics are `geomap.ingestion.request.v1`, `geomap.ingestion.result.v1`, and
`geomap.ingestion.dead-letter.v1`, each with three partitions and seven-day
retention. Messages are keyed by upload UUID. Schemas are in
`services/common/ingestion_common/contracts.py`; payloads contain object paths and
metadata, not file bytes, signed URLs or credentials.

Delivery is **at least once**. HTTP initialization is idempotent for a client UUID;
completion and outbox insertion use a row lock and one transaction. A completed
S3 object can recover a failed database commit through immutable object metadata.
Outbox delivery is marked only after Kafka acknowledgement. The bridge commits
only after Airflow accepts the stable `upload_<uuid>_<attempt>` run ID (or reports
that it already exists). Results apply only to the current unfinished attempt;
duplicates, stale attempts and late nonterminal updates cannot overwrite terminal
results. Invalid events go to the bounded dead-letter topic before their offset
is committed. Infrastructure errors retry without advancing offsets.

The processor writes the completion manifest last. Airflow publishes success only
after validating that manifest. Processor failures produce a bounded error object
and a failed result; the DAG remains failed even when error delivery succeeds.
Task and notification retries are bounded. If Kafka remains unavailable past all
notification retries, repair the broker and clear/retry `publish_result` in
Airflow; this republishes the same idempotent result. Do not clear an entire
successful run just to redeliver its notification.
An attempt still marked processing after two hours becomes failed and can be
retried; this exceeds both configured task and DAG execution limits.

## Operation and verification

```sh
docker compose logs --tail=100 upload-api ingestion-worker airflow-bridge
docker compose logs --tail=100 airflow-scheduler
docker compose exec airflow-scheduler airflow dags list-import-errors
python3 scripts/smoke_ingestion.py --url http://localhost:8095
python3 scripts/check_ingestion_recovery.py  # briefly stops/restarts this stack's Kafka worker
node tests/browser/uploads.cjs
npm test
python3 -m unittest discover -s tests -p 'test_*.py'

# Focused checks use built dependencies, with no host Python installation required.
docker compose run --rm --no-deps -v "$PWD/tests/ingestion:/checks:ro" upload-api \
  python -m unittest discover -s /checks -p test_uploads.py
docker compose run --rm --no-deps -v "$PWD/tests/ingestion:/checks:ro" upload-api \
  python -m unittest discover -s /checks -p test_delivery.py
docker compose run --rm --no-deps --entrypoint python \
  -v "$PWD/tests/ingestion:/checks:ro" ingestion-image \
  -m unittest discover -s /checks -p test_processor.py

docker compose stop    # keep all data
docker compose up -d   # restart with existing data
```

The smoke test creates its own records and artifacts, including a 16 MiB + 1 byte
upload, interrupted-session part listing, premature completion rejection, real
Airflow/Kafka processing, artifact download, invalid CSV, processing retry, and
cancellation. The browser check uses a disposable Chrome profile. Evidence and
current acceptance status live in [the task file](upload-ingestion-tasks.md).

This Compose setup is a **local single-workspace deployment**, matching the
existing portal's access model. Before exposing it to multiple users, add identity
and authorization to upload/catalog/download routes, use per-workspace storage
prefixes and credentials, TLS/SASL, backups, secret management and production
Airflow deployment. DockerOperator requires access to the Docker daemon; only the
scheduler mounts the socket. MinIO's upstream source is no longer maintained;
the adapter uses S3 APIs and can target an organization's maintained MinIO/S3
deployment when preparing production infrastructure.

Implementation references: [Airflow DockerOperator](https://airflow.apache.org/docs/apache-airflow-providers-docker/stable/_api/airflow/providers/docker/operators/docker/index.html),
[Airflow LocalExecutor](https://airflow.apache.org/docs/apache-airflow/2.11.0/core-concepts/executor/local.html),
[S3 presigning](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/generate_presigned_url.html),
[MinIO source distribution](https://github.com/minio/minio/blob/master/README.md).
