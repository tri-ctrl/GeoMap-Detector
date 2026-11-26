# Native ingestion without Docker

The reference `ingestion-processor/src/main.py` invokes Python format parsers on
an input path and writes files/metadata to an output directory. Its Docker entry
point only sets up the runtime. This implementation reuses that boundary: file
dispatch, archive checks, CRS conversion, COGs, previews and layer metadata run
in Python. The same output builder serves local bundles and S3 manifests.

## Process a file now

Install Python **3.12**. The pinned Rasterio 1.5.2 requires it. Setup creates
separate environments inside ignored `.runtime/`; it uses `uv` when available
and otherwise pip. No containers are built or started.

The default Codespaces configuration also installs these native environments;
Docker-in-Docker is no longer part of that configuration. After creation, the
standalone command works immediately. For the upload workflow, configure
native/managed infrastructure and `.env.native` as described below.

```sh
python3.12 scripts/setup_native_ingestion.py --processor-only
.runtime/venvs/processor/bin/python -m processor.local /path/to/input.tif outputs/my-raster
.runtime/venvs/processor/bin/python -m processor.local /path/to/data.geojson outputs/my-vector
```

Choose a new output directory each time. A successful bundle contains
`manifest.json` plus `layer-0/`, `layer-1/`, etc. Artifacts have relative paths,
media types and sizes. Spatial layers retain WGS84 bounds; raster previews use
Web Mercator. Unlocated media/documents retain their original location state.
Generated artifacts move into the bundle without another disk copy; original
assets are copied so deleting the input does not break it. Failure leaves no completed bundle; existing directories are never
overwritten. This standalone command needs no other services.

Directory Files uses the service-backed workflow below to upload and browse
durable files and display these same processed layers on the globe.

## Run the upload workflow as native services

```sh
python3.12 scripts/setup_native_ingestion.py
cp .env.native.example .env.native
# Configure dedicated PostgreSQL, Kafka, S3/MinIO endpoints and generated credentials.
.runtime/venvs/services/bin/python scripts/native_services.py check
.runtime/venvs/services/bin/python scripts/native_services.py init
.runtime/venvs/services/bin/python scripts/native_services.py run
```

`init` creates the upload schema, S3 bucket/Kafka topics when absent, migrates
Airflow metadata and creates its admin. The database/user must already exist;
use a database dedicated to this application. Keep passwords and Airflow's
encryption key stable in ignored `.env.native`. Generate the Fernet key with:

```sh
python3.12 -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'
```

`run` starts the upload API, result/outbox worker, Airflow webserver/scheduler,
Kafka-to-Airflow bridge and development frontend as native processes. Ctrl-C
stops them. A child service exiting also stops the group so a partial stack is
visible as a failed start. Use a host process manager for persistent deployment.

Example ports differ from the earlier Compose stack: frontend 8098, API 8097,
Airflow 8099, MinIO 9018, PostgreSQL 5545 and Kafka 19095. The launcher starts the
Python applications; **PostgreSQL, Kafka and S3/MinIO must already be running as
native or managed services**. It does not install/start those infrastructure
servers. Adjust `.env.native` to their endpoints. `check` validates configuration,
imports and optional tools without connecting to infrastructure.

The development frontend generates its `ingestion-config.json` response from
`INGESTION_API_URL`, without changing the tracked file. S3 CORS must allow the
frontend origin, permit multipart PUT/GET/HEAD and expose `ETag`. For native
MinIO, set `MINIO_API_CORS_ALLOW_ORIGIN` when starting MinIO. The browser uses
`S3_PUBLIC_ENDPOINT` exactly as signed; processors use internal `S3_ENDPOINT`.

## Native Airflow execution

The DAG defaults to `INGESTION_EXECUTOR=python`. When operating Airflow directly:

```env
INGESTION_EXECUTOR=python
INGESTION_PYTHON=/absolute/path/to/.runtime/venvs/processor/bin/python
INGESTION_PROCESSOR_ROOT=/absolute/path/to/GeoMap-Detector/services/ingestion
```

Airflow launches that interpreter with `python -m processor.main --request-stdin`.
A bounded JSON request travels over stdin without shell interpolation. Output
streams into task logs. Runs have separate temporary work directories. Nonzero
exits fail tasks; timeout/cancellation retires the process group and decoder
children. Attempt-specific S3 manifests and Kafka results stay compatible with
Directory Files.

The native path neither imports Docker packages nor accesses a Docker socket.
Compose explicitly selects `INGESTION_EXECUTOR=docker` for compatibility. Native
processes run under the host user account; configure CPU/memory isolation in the
host process manager. Input/archive/vector/preview/task-time limits still apply.

## Native format dependencies

Rasterio/Fiona wheels supply GDAL support for common rasters and vectors.
Additional formats use tools installed on the host:

| Capability | Native dependency |
| --- | --- |
| Additional GDAL drivers, NetCDF/GRIB/GeoPDF fallback | `gdalinfo`, `gdal_translate` |
| PDF preview | Poppler `pdftoppm` |
| Video metadata/preview | FFmpeg `ffprobe`, `ffmpeg` |
| DWG | GNU LibreDWG `dwgread` |
| ECW | Licensed GDAL ECW decoder |

The extension registry is unchanged. Decoding depends on installed drivers;
missing tools fail the attempt with task logs. CZML snapshots, sampled LAS/LAZ
and GIQ packages retain the [format matrix's limits](upload-ingestion.md).

## GitHub Pages and deployment

Python/Airflow still need a running server or development Codespace. For the
public Pages app, use native services behind HTTPS and set repository variable
`INGESTION_API_URL` to their actual API/gateway origin. Configure S3's public
endpoint and CORS for `https://tri-ctrl.github.io`. The existing SSH/Docker
deployment workflow is for containers; native deployment uses the setup/launcher
commands above on the selected host. No remote runtime was provisioned here.

## Tests

```sh
.runtime/venvs/processor/bin/python -m unittest discover -s tests/ingestion -p test_native.py -v
.runtime/venvs/processor/bin/python -m unittest discover -s tests/ingestion -p test_processor.py -v
.runtime/venvs/services/bin/python -m pip install -r tests/ingestion/requirements-native.txt
.runtime/venvs/services/bin/python -m unittest discover -s tests/ingestion -p test_native_launcher.py -v
INGESTION_TEST_NATIVE=1 AIRFLOW_HOME="$PWD/.runtime/airflow-tests" \
AIRFLOW__DATABASE__SQL_ALCHEMY_CONN="sqlite:///$PWD/.runtime/airflow-tests/airflow.db" \
.runtime/venvs/services/bin/python -m unittest discover -s tests/ingestion -p test_native_airflow.py -v
```

Airflow integration tests run real tasks, a separate native processor and HTTP
S3 transfers against an isolated Moto test server. Kafka publication is captured,
not a live broker delivery test. No Docker command is used. See
[GMD-038 scope and evidence](native-ingestion-tasks.md).
