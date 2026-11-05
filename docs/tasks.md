GeoMap-Detector issue tracker and implementation plan

Updated: 2026-11-05. Findings and baseline measurements are recorded in [the performance review](./performance-review.md). This file is the persistent record of scope, dependencies, acceptance checks, and progress.

Current work: **GMD-001 — GitHub Pages build check is ready for CI**. Model export stays in `.github/workflows/pages.yml`; local validation now covers fresh export packaging and restored assets. Actual export/deployment verification in GitHub is still pending. The remaining issues are planned in the order below.

Status values: **Planned**, **In progress**, **Ready for CI**, **Verified in CI**, **Verified deployed**. Update a task after implementation and record its evidence. Local checks alone do not establish that a change has reached the public site. Dependencies must be satisfied before dependent work is considered finished.

| ID | Priority | Status | Issue and planned fix | Acceptance evidence / dependencies |
| --- | --- | --- | --- | --- |
| GMD-001 | P1 | Ready for CI | Restore `export_onnx.py --check`, make it independent of ML packages, and run asset regression tests in `pages.yml` | 12 local tests pass, including CLI checks without site-packages and normal export packaging using an ML test double; workflow YAML parses. Fresh and cache-hit GitHub runs remain pending |
| GMD-002 | P1 | Planned | Publish the existing AOI deduplication and model-download fixes; verify deployed/source parity | Loading the sample twice leaves six AOIs, saved duplicates are skipped, download errors identify HTTP status, and the intended revision is live; depends on GMD-001 |
| GMD-003 | P1 | Planned | Reuse the basemap and separate image visibility from clip loading | Selecting the current release causes no tile-layer replacement; toggling the image does not reset the map, reload annotations, or rebuild detections |
| GMD-004 | P1 | Planned | Dispose clip views and prevent stale asynchronous responses | Old image URLs are revoked after removal; editing/selection is cleaned up; rapid clip switches cannot display an earlier response over the current clip |
| GMD-005 | P1 | Planned | Add pixel/dimension and estimated-memory limits before raster allocation | Oversized AOIs cannot allocate beyond the configured limits, including when zoom selection reaches its lower bound; requested/actual zoom is clear |
| GMD-006 | P1 | Planned | Process large AOIs in bounded mosaics at native resolution | Sample AOIs process without an unbounded full-AOI canvas; block-edge detections retain expected coverage; depends on GMD-005 |
| GMD-007 | P1 | Planned | Move preprocessing, inference, NMS, and TIFF work into a dedicated worker | Map interactions remain responsive during processing; WebGPU/WASM fallback, progress, cancellation, and errors work; depends on GMD-005 and GMD-012 |
| GMD-008 | P1 | Planned | Persist job outputs incrementally and query annotations through IndexedDB | Completed clips survive reload; only active display data is loaded; annotation queries use AOI/release indexes; quotas preserve unsaved work; depends on GMD-016 |
| GMD-009 | P1 | Planned | Add job removal, a memory budget, and a smaller unannotated display image | Disposed jobs release in-memory references; current image size follows viewport needs; native exports remain available; depends on GMD-004 and GMD-008 |
| GMD-010 | P1 | Planned | Bound model/session caches and correct custom-model identities/metadata | Idle sessions call `release()` safely; simultaneous loads are deduplicated; changed weights with the same name/size cannot reuse stale sessions; class-name edits take effect |
| GMD-011 | P2 | Planned | Update map layers by ID and restyle only changed selections | AOI/detection selection avoids rebuilding all layers; dense scenes remain editable; evaluate Canvas rendering with selected-object editing |
| GMD-012 | P1 | Planned | Make cancellation, timeouts, and error cleanup consistent | Cancellation works during model/metadata/tile requests and cached-tile loops; sibling requests stop/drain; canvas/bitmap cleanup runs on failures |
| GMD-013 | P2 | Planned | Bound the imagery cache and avoid redundant tile work | Cache use stays within its budget; cache can be inspected/cleared; in-flight requests are shared where safe; non-intersecting tiles can be skipped |
| GMD-014 | P2 | Planned | Load map essentials first and cache Wayback metadata | Detection/export dependencies load on demand; valid cached metadata starts the map while refreshing; compare cold/warm startup against the recorded baseline |
| GMD-015 | P1 | Planned | Reduce export memory and avoid recompressing compressed imagery | Per-clip/split exports work; image choices are respected; JSON remains compressed; a streaming destination or bounded fallback prevents whole-job memory spikes; depends on GMD-008 |
| GMD-016 | P1 | Planned | Introduce persistent AOI IDs and reliable result/review identities | Different AOIs with equal/similar names cannot overwrite files; rerunning a different model cannot apply reviews by confidence-rank index alone |
| GMD-017 | P2 | Planned | Profile and optimize inference/NMS with accuracy checks | Measure stages first; spatial candidate filtering preserves suppression behavior; overlap/precision experiments retain validated detection quality; depends on GMD-007 and GMD-020 |
| GMD-018 | P2 | Planned | Fix dataset split isolation and define negative-example handling | Overlapping chips do not leak across train/validation groups; insufficient validation is reported; rejected-only areas have an explicit training policy |
| GMD-019 | P2 | Planned | Bound optional backend jobs, cached models, and stored data | Queue/concurrency limits cover detection and training; completed jobs/caches expire; annotation writes are atomic/synchronized; large GeoJSON is written incrementally |
| GMD-020 | P1 | Planned | Add stage timings, byte counters, and deployed revision/provider diagnostics | Baselines distinguish startup, download, tiles, preprocessing, inference, NMS, encoding, and export; diagnostics identify running revision and model |
| GMD-021 | P1 | Planned | Establish sustained memory, responsiveness, and regression acceptance checks | Exercise repeated jobs/clip/model switches, failure/cancellation, cold/warm loading, dense detections, and a smaller-memory/mobile device; measure JS/native/GPU memory separately |

Implementation order:

1. GMD-001, then deploy/parity GMD-002; address basemap/view cleanup GMD-003/GMD-004 and cancellation GMD-012. Begin observability GMD-020 so subsequent changes can be compared.
2. Establish identities GMD-016 and limits GMD-005; add bounded mosaics GMD-006, worker processing GMD-007, persistence GMD-008, memory controls GMD-009/GMD-010, and export GMD-015.
3. Improve rendering GMD-011, tile caching GMD-013, startup GMD-014, inference GMD-017, dataset correctness GMD-018, and the optional backend GMD-019. Expand GMD-021 with each affected stage.

GMD-001 progress:

- Confirmed that `pages.yml` already exports ONNX models on cache misses and restores `frontend/models` on cache hits.
- Confirmed the verification step invokes `--check` although the current argument parser does not define it.
- Confirmed the top-level Ultralytics import prevents dependency-free validation of cached assets.
- Restored `--check` and moved the Ultralytics import into export mode. The check validates a non-empty manifest, valid file entries, and non-empty referenced files; it does not parse ONNX graphs or measure detection accuracy.
- Kept the normal `python scripts/export_onnx.py` step in `pages.yml`. Asset validation always runs afterward, including when the cache skips export and ML installation.
- Added a dependency-free asset-test step before cache restore/export. Include `tests/test_model_assets.py` when committing the workflow change.
- Local verification: `python3 -m unittest discover -s tests -p 'test_model_assets.py' -v` — **12 passed**. The expensive ML exporter is replaced only in the packaging test; CLI cache checks run in fresh Python processes with `-S`.
- Workflow YAML parses and `git diff --check` passes.
- Pending: commit/push the changes and observe successful fresh-export and cache-hit Pages runs; record their run URLs here. No GitHub workflow has been triggered by this task.
