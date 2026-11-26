# Directory Files and ingestion services

Open **Files → Directory Files**, create or open a folder, and upload a file.
The browser sends resumable chunks directly to object storage using signed URLs.
The backend validates completion and queues an ingestion request through Kafka.
Airflow launches the processor container, which writes processed artifacts and
returns their metadata through Kafka.

Directory Files is independent from AOIs. It does not import uploaded geometry
into the AOI collection. Processed geographic layers can be checked, viewed on the
3D globe, hidden, zoomed, assigned opacity, and removed individually. Multiple
raster/vector layers coexist. Switching tabs or 2D/3D retains the session's layers.

## Run locally

```sh
cp .env.example .env
docker compose up -d --build
```

| Service | Local address |
| --- | --- |
| Portal and API/storage gateway | http://localhost:8095 |
| Airflow | http://localhost:8096 |
| MinIO administration | http://localhost:9011 |
| Direct MinIO S3 endpoint | http://localhost:9010 |

Ports are configurable. PostgreSQL and Kafka remain private. Airflow's local
account defaults to `geomap` / `geomap-local-airflow`; MinIO defaults to
`geomap-local` / `geomap-local-secret`. The stack is a single workspace and does
not yet implement multi-user authorization.

The integrated portal uses its own API automatically. There is no processing
server field or Connect button in Directory Files. Remote HTTPS deployments and
the public GitHub Pages frontend use the deployment configuration described in
[remote services](remote-ingestion.md). GitHub Pages does not run the backend.

For a corporate TLS proxy:

```sh
BUILD_CA_BUNDLE=/absolute/path/to/trusted-ca-bundle.pem \
  docker compose -f compose.yaml -f compose.ca.yaml build
```

The CA bundle is a build-only secret. Verification stays enabled. If the Go module
proxy returns truncated archives, use `GO_MODULE_PROXY=direct` for the MinIO build.
Native ARM builds compile the Fiona vector reader and LibreDWG; the first build
can take considerably longer than subsequent builds.

## Directories and files

Folders and file membership are stored in PostgreSQL. Existing uploads migrate
into the root directory. Use breadcrumbs, folder buttons and filename search to
browse; a file's **Move to directory** selection changes its directory without
copying object bytes. Folder names are unique within their parent, ignoring case.
The catalog is paginated in groups of 25 and refreshes while the panel is visible.
Directories are limited to 1,000 total and 12 nested levels.

Upload progress measures bytes. **Pause upload** interrupts the browser transfer;
reselecting the same file in the same folder resumes confirmed chunks. **Cancel
upload** aborts its multipart session. After completion, processing continues even
when the browser closes. Failed processing can be retried from the existing
source. **Download original** preserves the uploaded input; each processed output
also has a download action.

A file without geographic coordinates remains in its directory. It is not placed
at an invented location. Geotagged photos/videos can appear as point locations;
an ordinary image is not automatically an orthorectified raster.

## Accepted extensions and processors

The server owns the extension registry. It matches
`backend-service/src/main/resources/application.properties`'s
`minio.upload.ingestion.file.extension`, plus the existing JSON/GeoPackage/Shapefile
compatibility inputs. The frontend obtains its accept list from the API.

| Input family | Processing/viewing behavior |
| --- | --- |
| `tif,tiff,ntf,nitf,jp2,img,grb,grb2,grib,grib2,nc` | GDAL/rasterio decode, COG and bounded Web Mercator preview; multi-dataset rasters produce separate layers. |
| `ecw` | Accepted, but decoding requires a licensed GDAL ECW driver. The standard image reports this missing dependency explicitly. |
| `geojson,json,kml,gpkg,shp,csv,gpx` | WGS84 GeoJSON normalization; CSV requires `lat,lon`; Shapefiles need sidecars/projection, normally in an archive. |
| `kmz,zip,tar` | Safe extraction and dispatch of contained GIS/media files. Unsupported sidecars are skipped. |
| `dwg` | LibreDWG converts supported geometry. Drawings need geographic coordinates; local/projected CAD coordinates must be reprojected before globe display. Unsupported CAD entities are limited by LibreDWG. |
| `xlsx` | `lat,lon` or WKT columns become vectors. Other spreadsheets stay downloadable documents. |
| `czml` | Static geographic snapshot of supported cartographic point/line/polygon packets. Original time-dependent content is preserved for download. |
| `las,laz` | At most 8,000 sampled points become a globe vector preview when CRS metadata exists. Original point clouds are preserved; this is not full-resolution point-cloud rendering. |
| `mbtiles` | Raster tiles become COG; MVT tiles become a bounded GeoJSON snapshot at one zoom. Tile-boundary features may be split. |
| `png,jpg,jpeg,pdf` | Geographic rasters use available projection metadata; otherwise retain original and create a preview. Photo GPS can supply a point location. |
| `mp4,mpg,mpeg` | ffprobe metadata and a preview frame; embedded GPS can supply a point location. |
| `giq,giqreport,giqdrawing,giqcategories` | Package extraction can discover GIS contents; other package contents are preserved. This does not recreate the reference platform's workspace/report/category applications. |

Acceptance of an extension does not guarantee that every file variant has a
usable decoder, projection or geographic content. Unsupported codecs, invalid
geometry, missing raster CRS, encrypted PDFs and unavailable licensed drivers
produce a failed processing state with details. The original remains downloadable.

## Layer rendering and limits

Vectors render as independent Cesium points, lines and polygons, including multipart
and collection geometry. Raster display uses the processor's EPSG:3857 PNG with a
matching Web Mercator tile transform. COG downloads preserve source resolution,
CRS and bit depth; preview stretching does not change the COG. Raster previews
cover latitudes -85 through 85 degrees and have a maximum side of 2,048 pixels.

The display budget is eight loaded layers, 10,000 aggregate features, 200,000
vertices and 64 MiB of decoded raster pixels. A layer download is limited to
20 MiB. These bounds apply to interactive display; larger processed artifacts
remain downloadable. Layers have separate Leaflet/Cesium resources and do not
change AOI selection, detection results or annotation identities.

Upload defaults to 10 GiB, 16 MiB chunks and three parallel requests. There are
at most 10,000 parts. Vectors have a 256 MiB/100,000-feature processing limit.
Archives allow 200 entries/2 GiB extracted/200:1 compression; paths, links and
encrypted members are rejected. At most 20 outputs/subdatasets are processed.
Native fallback conversion has a conservative 16 GiB decoded-size estimate and a
32-band limit. Each processor has a 2 GiB memory limit and a 30-minute task timeout;
two runs can be active. Docker needs enough disk space for downloaded sources and
intermediate raster files.

## Service boundaries and recovery

`services/common` defines typed events, format registry, storage and messaging
adapters. `upload-api` stores sessions, directories, attempts, processed manifests
and an outbox in PostgreSQL. `airflow` contains a Kafka/REST bridge and one DAG.
`ingestion` contains format processors; `minio` builds pinned official source;
`web` provides a same-origin API and signed-object gateway.

Delivery is at least once. Completion validates storage part sizes/ETags and
commits queued state plus outbox atomically. The bridge uses stable per-attempt
DAG run IDs and commits only after acceptance. Results apply only to the current
unfinished attempt. Both consumers quarantine malformed messages before committing
their offsets. Object storage holds the completion manifest before success is
published. Lost processing attempts become retryable after two hours.

Upload sessions expire after 24 hours. The worker aborts expired sessions, and
MinIO's native stale-upload cleanup handles orphans. Source/intermediate temporary
files disappear with their processor container. Durable inputs and outputs remain
in MinIO. If Kafka remains unavailable beyond notification retries, clear/retry
Airflow's `publish_result` task after repairing the broker.

## Verification

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/smoke_ingestion.py
python3 scripts/check_ingestion_recovery.py
GMD_UPLOAD_RASTER=/path/to/georeferenced.tif node tests/browser/uploads.cjs

docker compose run --rm --no-deps -v "$PWD/tests/ingestion:/checks:ro" upload-api \
  python -m unittest discover -s /checks -p test_uploads.py
docker compose run --rm --no-deps -v "$PWD/tests/ingestion:/checks:ro" upload-api \
  python -m unittest discover -s /checks -p test_directories.py
docker compose run --rm --no-deps --entrypoint python \
  -v "$PWD/tests/ingestion:/checks:ro" ingestion-image \
  -m unittest discover -s /checks -p test_formats.py
```

The checks create labeled test records. Browser checks use a disposable Chrome
profile and controlled base tiles; uploaded geometry/raster data, MinIO transfers,
Airflow container processing and Cesium rendering are real. This is functional
verification, not a detection-accuracy or production-throughput benchmark.

Current scope and evidence: [GMD-036](directory-files-tasks.md). Earlier
[GMD-035 evidence](gmd-035-verification.json) describes its historical 2D/AOI-import
UI. YOLO inference on uploaded rasters remains outside this ingestion feature.
The existing browser ONNX model export/setup still applies to Wayback detection.
