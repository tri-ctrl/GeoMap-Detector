# GMD-040 — JPEG-compressed TIFF and GCP georeferencing

The reported ICEYE quicklook is a 4096 × 2401 single-band, JPEG-compressed TIFF.
Its location is carried by 735 ground control points and their CRS. The pinned
GDAL WebAssembly build cannot open its JPEG codec, and the current raster path
also requires an affine CRS/transform.

## Tasks

- [x] Reproduce the codec failure using the actual local file, without publishing it.
- [x] Add a bounded, lazy JPEG-in-TIFF compatibility decoder preserving original
  TIFF georeferencing/GCP metadata and original file bytes.
- [x] Georeference GCP rasters through GDAL before the existing preview/COG pipeline.
- [x] Package/fingerprint decoder assets and update notices/deployment source checks.
- [x] Test synthetic JPEG grayscale/RGB, GCP and affine rasters, metadata
  preservation, limits and errors; verify the actual ICEYE file in a browser.
- [x] Stage the verified fix and document publication status.

The user's source file and imagery must stay outside tracked repository files.

375 JavaScript and 25 Python checks pass. Native Chrome processed the actual
local file, displayed its texture on the Cesium globe, and verified the saved
original's SHA-256. Synthetic grayscale/GCP and RGB/affine rasters also display;
a failed decoder load can be retried from the saved original. All 11 disposable
workers terminate. Existing directory persistence, cancellation and vector/raster
checks pass without an ingestion API. [Evidence](gmd-040-verification.json).

Publish through the existing Pages workflow, reload the public app, then choose
**Retry processing** on the failed entry and **View on globe**. Publication of
this fix remains pending; the user's original does not need to be uploaded again.
