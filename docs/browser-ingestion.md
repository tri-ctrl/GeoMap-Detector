# Directory Files on GitHub Pages

The Pages deployment now supports file ingestion in the browser when
`INGESTION_API_URL` is empty. It needs no file-processing server, Docker, Airflow,
MinIO or Kafka. A configured remote HTTPS API selects the existing service flow.

The earlier native Python implementation needs a running server. Deploying its
source alongside Pages does not create one. The reported `/api/health` endpoint
belongs to the optional detection backend; Files' browser mode does not use a
health API.

## Use Files

Open **Files**, create/open a directory, select a file, then choose **Add and
process**. Spatial outputs have **View on globe** and independent visibility,
opacity, zoom and removal controls. They do not become AOIs.

Files, directories, original bytes and processed artifacts are stored in a
separate IndexedDB database on this browser/device. They survive reloads. The
interface says **Saved in this browser · files stay on this device**. Clearing
site data removes those saved copies. **Delete saved copy** frees their storage;
**Download original** keeps a copy outside the browser. There is no automatic
synchronization with another device or a later remote backend.

Failed/stopped jobs retain their saved originals and offer **Retry processing**.
A closed/reloaded page releases its worker; interrupted jobs become retryable.
Only complete artifact sets and manifests are committed to the directory.

## Formats and limits

The accepted extensions match the native backend's 39-extension registry. Format
acceptance and available browser decoders are distinct:

| Files | Browser behavior |
| --- | --- |
| GeoJSON/JSON, CSV with `lat`/`lon`, cartographic CZML | Bounded normalized WGS84 vector layers |
| TIFF/GeoTIFF, NITF, IMG/HFA, GRIB | Browser GDAL creates georeferenced COG output and a Web Mercator preview |
| KML, GPX, Shapefile with sidecars, GeoPackage, XLSX, MBTiles | Browser GDAL vector/raster conversion, subject to driver and geographic metadata |
| ZIP, KMZ, TAR | Bounded extraction; recognized contents become layers |
| PNG/JPEG, PDF, video | Original retained as a directory asset; no invented map coordinates |
| ECW, JP2, NetCDF, LAS/LAZ, DWG | Original retained with an explicit native-decoder message |
| GIQ application packages | Recognized geographic archive contents can be extracted; otherwise preserve the original package |

CSV requires finite WGS84 longitude/latitude. XLSX uses `lat`/`lon` columns when
its worksheets have no geometry. CZML uses a static snapshot of cartographic
positions. A raster must have a CRS or ground control points with a CRS, and fit
the supported Mercator latitude range. JPEG-compressed 8-bit grayscale/RGB TIFFs
use a lazy decoder before GDAL conversion; GCP-only rasters are georeferenced
through a thin-plate spline warp. Affine location and original GCP metadata are
preserved in the intermediate TIFF. Old-style JPEG compression (TIFF type 6)
and non-8-bit JPEG samples are unsupported. Proprietary codecs and other
unsupported driver variants still need
[native ingestion](native-ingestion.md).

Browser admission limits are 128 MiB per original, 512 MiB saved storage and
1,000 files. Archive extraction is limited to 100 entries, 256 MiB expanded data,
200:1 compression ratio and two archive levels. Links and unsafe paths are
rejected. Vector processing permits 100,000 features, one million vertices and
20 MiB encoded output. Raster decoded-size admission is 512 MiB, with a longest
preview edge of 2,048 pixels. JPEG TIFF decoding is limited to a 64 MiB sample
buffer, and GCP georeferencing to 2,048 control points. A disposable worker has a
three-minute deadline.

Map display retains its separate budget: eight layers, 10,000 features,
200,000 vertices and 64 MiB decoded raster pixels. Larger processed vectors
remain downloadable. Files exceeding browser limits can use native ingestion.

## Build and publish

```sh
npm ci --ignore-scripts
node scripts/prepare_browser_ingestion.cjs
npm test
node tests/browser/browser-files.cjs
```

The preparation script copies unmodified, pinned gdal3.js 2.8.1, fflate 0.8.3
and GeoTIFF.js 3.0.5 assets into ignored `frontend/vendor/ingestion/`. Their
fingerprints are checked against tracked `frontend/file-runtime.json`; generated assets are included in
the Pages artifact. The GDAL runtime is about 38 MiB and loads only for formats
that need it. GeoTIFF.js adds about 538 KiB only for JPEG-compressed TIFFs.
GeoJSON/CSV parsing does not load these runtimes. All file processing happens
in disposable workers, and file contents are never sent to a backend in this
mode. License/source notices are available through **Supported files**.

Pages CI generates `{ "mode": "browser", "api_url": "" }` when the repository
variable is empty. For remote ingestion, set `INGESTION_API_URL` to a real public
HTTPS API origin. The existing integrated app also retains legacy same-origin
configuration when no explicit mode is supplied outside GitHub Pages.

Commit/push this change and run **Publish portal to GitHub Pages** to update the
public site. Deployment verification checks source fingerprints, processing mode
and browser runtime asset availability/sizes. A local browser check is not a
claim that the live site has been updated.

For dependency updates, review the new package version, update the worker's
version constants, then run `node scripts/prepare_browser_ingestion.cjs
--write-manifest`. To update extensions, run `python3
scripts/export_file_formats.py`; a Python regression checks the browser/native
contract remains identical.

Verification and scope: [GMD-039](browser-ingestion-tasks.md) ·
[JPEG TIFF and GCP support (GMD-040)](jpeg-tiff-tasks.md).
