# GMD-036 — Directory Files and globe layers

Started 2026-11-26, following the user's clarification of GMD-035.

The intended workflow is a file directory: upload GIS data, process it with the
ingestion service, and display the resulting raster/vector layers on the globe.
Uploaded layers are independent from AOIs. The previous AOI import action and
single 2D preview do not fulfill this clarified requirement.

## Tasks

- [x] Inspect upload UI, durable catalog, processor outputs, Leaflet and Cesium ownership.
- [x] Add durable directories and folder-scoped uploads/catalog, with a safe migration for existing files.
- [x] Replace the upload cards with Directory Files browsing, folder creation, processing state and independent layer controls.
- [x] Render multiple processed vector/raster layers in 2D and on the 3D globe, including points, lines and polygons; preserve raster Web Mercator alignment.
- [x] Bound payloads, release map/globe resources, reject stale loads and preserve layers across tab/map switches.
- [x] Remove the processing-server/connect controls from the directory; use deployment configuration for same-origin or remote HTTPS services.
- [x] Match all reference backend ingestion extensions via one server-owned registry; add format dispatch and distinguish spatial layers from unlocated documents/media/packages.
- [x] Test folder persistence/isolation, geometry conversion, concurrent layer visibility/opacity/removal, and existing behavior.
- [x] Rebuild/run Compose and verify actual ingestion plus raster/vector globe rendering in an isolated browser; record evidence.

## Acceptance

Directory Files provides folders/breadcrumbs, upload processing state and resulting
layers. Checking a processed layer displays it on the globe without creating an
AOI. Multiple layers coexist, can be hidden or removed, and have opacity and zoom
controls. Switching 2D/3D retains the selected layers. Existing uploads appear at
the root after migration. The upload/Kafka/Airflow pipeline stays compatible.

## Verification

Implemented and locally verified. Earlier GMD-035 evidence describes the prior
2D/AOI-import workflow and remains historical evidence. This follow-up has its own
[verification record](gmd-036-verification.json).

- **353 JavaScript / 55 Python checks pass**: existing regressions, real PostgreSQL
  directory isolation/move/depth tests, multipart/bootstrap/delivery checks, real
  format decoders and Cesium geometry/layer ownership cases.
- Actual decoder checks include JP2, NITF, IMG, NetCDF, GRIB, LibreDWG conversion,
  LAS/LAZ, vector MBTiles, GPX/CZML, KMZ/TAR, XLSX, PDF, PNG and video previews.
- Real browser upload/ingestion creates a directory and processes mixed geometry,
  GeoTIFF and unlocated PNG. Cesium displays simultaneous raster/vector layers;
  native picking, visibility/opacity, 2D/3D switching and cleanup pass without
  changing AOIs. Zero runtime exceptions. Controlled base tiles isolate provider
  latency; uploaded artifacts and rendering are real. Desktop/mobile screenshots
  were inspected from temporary files.
- Seven initial scripts and five cold/warm startup pairs remain intact. The
  multipart/Kafka/Airflow/container/result/download/failure/retry/cancel smoke test
  passes through the same-origin S3 gateway.
- All nine local services are running with healthy configured health checks.
  These are local verification results, not a claim of remote hosting.

Extension source: `../backend-service/src/main/resources/application.properties:151`
(`minio.upload.ingestion.file.extension`). Proprietary ECW decoding requires a
licensed driver; LibreDWG is built for DWG. GIQ package contents must not be mistaken for ordinary GeoJSON.
Files without location information stay in the directory without an invented map position.

## GMD-037 — Remote hosting follow-up

- [x] Main Pages frontend reads an automatically generated remote HTTPS API URL.
- [x] Pages workflow writes/verifies deployment config; uploaded JavaScript is
  included in public source fingerprints and deployment parity checks.
- [x] GitHub Actions workflow can publish service images to GHCR; registry Compose
  override and a full-stack Codespaces configuration are provided.
- [x] Add a manual Actions deployment workflow for a remote Docker engine over
  SSH, with runtime configuration validation and a public HTTPS health check.
- [ ] Provision an actual remote runtime and configure its HTTPS origin in the
  repository's `INGESTION_API_URL` variable.
- [ ] Run remote upload/globe tests against the public Pages frontend.

The repository currently has only the `github-pages` environment and no backend
URL/deployment secrets. The current CLI token cannot access the Codespaces API
(HTTP 403; missing `codespace` scope). GitHub Pages cannot run these containers.
Runtime provisioning and live remote verification remain pending a runtime target
and access. [Deployment runbook](remote-ingestion.md).
