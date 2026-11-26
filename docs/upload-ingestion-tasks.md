# GMD-035 — File upload and Airflow ingestion

Started 2026-11-26. This task implements the requested local Docker Compose stack.

## Reference analysis

Read-only references (their source and infrastructure are not modified):

- `../frontend-new/frontend/apps/giq/src/cmd/UploaderApi.ts`: initialize multipart, slice browser Files, bounded concurrency, presigned PUT, ETags, complete only after all parts succeed. Correct the reference's `file.size - 1` boundary calculation and unawaited retry paths.
- `../backend-service/.../service/multipart/MultipartUploadFacade.java`, `IngestionJobService.java`, `notification/kafka/FileUploadProducer.java`, and `ingestion/IngestionServiceListener.java`: completion creates ingestion work, keyed Kafka requests, result listener updates durable file records.
- `../airflow/helm/airflow/dags/ingest_dags.py` and `common.py`: consume requests, trigger one DAG per job, run an ingestion Docker image, publish artifact metadata/status. Replace the large multipurpose DAG and shared input/output mounts with one focused DAG, stable run IDs, and direct object storage access.
- `../ingestion-processor/src/main.py`, `main_parser.py`, `geojson_parser.py`, and `plugin_manager.py`: dispatch by format, normalize geospatial data, produce metadata and display artifacts. Use a small extensible processor instead of copying vendor-specific code, private images, shell commands, or proprietary dependencies.

## Implementation decisions

`Browser → presigned multipart PUT → MinIO → upload API → PostgreSQL outbox → Kafka → Airflow bridge → DAG → Docker processor → MinIO artifacts → Kafka result → backend catalog → browser/map`.

- New `services/upload-api`, `services/airflow`, `services/ingestion`, `services/web`, and shared `services/common` folders. Existing browser detection and optional Python server remain usable.
- PostgreSQL stores upload sessions, status, attempts, processed file manifests, and a transactional outbox. Completion checks storage's authoritative part sizes/order/ETags. A retry of completion recovers a storage-completed/database-uncommitted object. Kafka is at least once; consumers use stable attempt IDs and commit after durable work.
- Lazy Files panel with progress, upload cancellation/resume by reselecting the original file, processing retries, catalog refresh, downloads, vector/raster map preview, and optional vector-to-AOI import. No ingestion requests during normal static map startup.
- Initial supported inputs: GeoJSON/JSON, CSV (`lat,lon`), KML, zipped Shapefile, GeoPackage, GeoTIFF. Vectors become WGS84 GeoJSON; rasters become COG plus a bounded Web Mercator PNG preview and footprint metadata. Explicit bounds on uploads, extracted archives, vector features, preview dimensions, and task/container resources.
- Local Compose uses independent names, ports, volumes and network. Builds publicly available images; Airflow launches the locally built processor image. Browser-facing S3 URL is configured separately from container S3 URL to preserve signatures. No private registry dependencies.

## Tasks and acceptance

- [x] 035.1 Inspect current app and all four reference services; record plan and scope.
- [x] 035.2 Implement shared versioned event/manifests, storage helpers, durable upload API and Kafka workers.
- [x] 035.3 Implement bridge, focused Airflow DAG, isolated Docker processor and failure publication.
- [x] 035.4 Integrate lazy frontend upload/catalog/map flows while preserving static startup.
- [x] 035.5 Add Compose, environment example, operating/architecture docs and repeatable smoke test.
- [x] 035.6 Run focused failure/contract/upload tests and existing regressions.
- [x] 035.7 Build and run Compose. Exercise actual multipart upload, processing, artifact download, map display, failed input and retry. Record exact outcomes and any environment limits.

## Verification record

**Complete and locally verified, 2026-11-26.** The Compose stack is running on
ports 8095/8096/9010/9011. [Machine-readable verification](gmd-035-verification.json).

- Existing + new JavaScript suite: **344 passing**, including 11 multipart checks.
- Existing Python regression suite: **24 passing**.
- Built upload API image: **6 multipart/contract/bootstrap checks** and **3 real PostgreSQL delivery/attempt checks** passing. Combined with processor checks and the original suite: **39 Python checks**.
- Native isolated Chrome startup regression: five cold/warm pairs, lazy drawing, cached/failed/retried metadata, page lifecycle and live-basemap independence pass. Initial map script count remains seven; file tools remain lazy.
- All nine application services are running; every configured health check is healthy. Default ports 8095, 8096, 9010 and 9011 were checked free before startup; existing applications were left running.
- Build findings addressed: corporate TLS roots supplied through an optional build secret; native ARM parser builds require GDAL headers; removed upstream MinIO image tags replaced with an official pinned source build. An incomplete Airflow Docker Hub layer was fetched through the organization mirror to repair the local build cache; application definitions retain public upstream defaults.
- Native ARM processor image: **6 passing checks**, including real multi-layer projected GeoPackage, zipped Shapefile, KML, CSV, unsafe archives, COG layout and bounded preview, plus missing-CRS rejection.
- All Compose images build, including MinIO from pinned official source. Airflow is healthy and has no DAG import errors. The MinIO build used direct Git dependency fetching after the network's Go proxy returned truncated archives; a final full build also succeeds with the default configuration and cached dependencies.
- Actual multipart **16 MiB + 1 byte** upload passes storage part listing/resumption, premature completion rejection, ETag/CORS checks, completion deduplication, Kafka request dispatch, Airflow Docker task, Kafka result application, and processed download. Invalid CSV reports its coordinate error; retry creates attempt 2 and fails honestly; cancellation revokes further signing.
- Native isolated Chrome verifies current served HTML/app/upload bytes, lazy Files loading, actual vector and GeoTIFF uploads, completed catalog cards, vector and raster map previews, AOI import, clearing a raster preview, tab switching and 390 px layout without horizontal overflow. **Zero runtime exceptions**. Desktop and narrow screenshots were inspected from temporary artifacts.
- Actual invalid Kafka events reach the dead-letter topic from both consumers. A completed upload remains queued while the worker is stopped and processes after restart. Restart testing found and fixed an empty Kafka-topic initialization call; bootstrap regression checks cover first and repeated startup.
- Final source-built MinIO image was recreated from the final build. Its running image ID matches the built image; the durable catalog and previously processed artifact remain readable after restart. Native MinIO stale-upload settings replace its unsupported S3 incomplete-upload lifecycle rule.
- Reproduction commands and local/production boundaries are in [operations](upload-ingestion.md). This initial feature processes and displays uploaded data; direct YOLO inference on uploaded rasters is outside scope. No remote publishing or changes to reference services were performed.

Local acceptance includes actual Airflow task containers and Kafka round trips;
these results establish the declared local workflow, not production throughput.
