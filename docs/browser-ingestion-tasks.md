# GMD-039 — Files uploads on GitHub Pages

The published revision `5776f82` has an empty `ingestion-config.json` API URL.
Files currently refuses to open without a backend. Native Python execution from
GMD-038 does not run inside GitHub Pages. The optional detection health endpoint
(`/api/health`) is separate from file ingestion (`/api/ingestion/health`).

## Tasks

- [x] Select browser ingestion on Pages when no remote API is configured.
- [x] Persist directories, original files and processed artifacts in IndexedDB,
  with transaction limits, interrupted-job recovery and removal of saved copies.
- [x] Process GIS data in a cancellable Web Worker. Normalize vectors and create
  bounded, geographically aligned raster previews using browser GDAL.
- [x] Keep all accepted file extensions; clearly distinguish decoded layers from
  originals requiring a native decoder. Preserve originals and download actions.
- [x] Reuse Directory Files and its independent raster/vector globe layer controls.
- [x] Package pinned browser dependencies as lazy same-origin Pages assets and
  include new source files in deployment verification.
- [x] Verify actual static-site file addition, processing, globe display, reload,
  failure/cancel, independent AOIs, resource cleanup and small-screen layout.
- [ ] Commit/push and verify the updated public deployment (the user has been
  publishing the staged changes in this session).

## Acceptance

On the GitHub Pages deployment, Files can add a file without contacting an API.
Common GIS files become globe layers; local files and directories survive reload.
The interface clearly identifies browser-local storage. Configured remote
ingestion remains available. Codec/size/storage limits are explicit. A prepared
fix is distinct from publishing it to the live site.

## Verification

Implemented and verified against a static server under `/GeoMap-Detector/`.
**366 JavaScript / 25 Python checks pass.** Real Chromium IndexedDB, disposable
GDAL WebAssembly workers and Cesium render GeoJSON, GeoTIFF and zipped Shapefiles
without an ingestion API. Tests cover unsafe archives, invalid CSV, native-only
original preservation, cancellation/retry, selected-layer restoration, deletion,
mobile layout and resource ownership. Seven workers are created and terminated;
no worker remains active and no runtime exception occurs. Base imagery and CDN
asset routing are controlled; the ingestion and raster/vector rendering are real.

Five cold/warm startup pairs preserve seven initial scripts. Native saved-review,
queue, migration/rollback, identity and lifecycle checks pass. Pinned dependencies
pass `npm audit`; runtime bytes match the committed fingerprints. New source and
runtime availability checks are included in Pages deployment verification.

Live source inspection found the published `5776f82` configuration had no backend
URL. This fix has not been committed/pushed/published by the agent. A live Pages
test of the new revision remains pending publication.

[Operation and limits](browser-ingestion.md) · [Evidence](gmd-039-verification.json).
