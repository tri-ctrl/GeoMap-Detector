Browser raster limits (GMD-005)

Detect now estimates the pixel-snapped processing footprint of every checked AOI before submission. It shows requested/effective zoom, width, height, tile count, megapixels and estimated working MiB. Invalid or oversized work disables Run and receives the same typed error when invoked directly. Limits are saved as device-local preferences and copied into each submitted job, so later changes cannot alter queued work. Existing jobs without captured limits use the current policy when resumed; existing records/artifacts are preserved.

The initial policy is **32,000,000 pixels**, **8192 pixels per side**, and **512 MiB estimated working buffers**. All three gates apply; TIFF-enabled clips may hit the working gate below 32 MP. These are configurable starting limits, not a claim that every device supports those allocations. Browser canvas maxima and practical memory limits vary ([MDN canvas limits](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas#maximum_canvas_size)). Lower the limits on constrained devices. Raising them can still cause browser allocation/encoding failure; the UI reports that failure and releases owned canvases.

The existing tile cap still chooses a lower processing zoom when required. The **final z10 footprint is now checked**, rather than accepted regardless of tile count. Pixel/dimension/memory guards never choose an additional zoom or resize inference/native output. Oversized AOIs must be made smaller at the same zoom, have their configured limits deliberately adjusted, or await GMD-006/GMD-015's bounded processing/writers. Disabling optional TIFF can reduce the estimate. In particular, the previously logged DXB 9322×6391 clip exceeds the initial pixel and side limits; a 1200-tile setting alone does not authorize it.

Estimation and admission

`GVEngine.estimateRaster(geometry, zoom, options)` performs arithmetic and validation only: it makes no canvas, pixel buffer, request or model session. It validates closed, nonzero Polygon/MultiPolygon rings and finite coordinates within Web Mercator coverage, requested zoom 10–19, and positive tile/concurrency settings. Holes contribute to the bounding footprint; filtering interior tiles remains GMD-013. The estimator and builder share the same clamped, pixel-snapped grid, exact tile footprint and ground transform.

Let `R = width × height × 4`, `P` be the existing 4000-side preview RGBA bytes, `S` the unchanged model input side, `A = ceil(1.02 × R) + 65536`, and `T = width × min(64,height) × 4`. The clip reservation is the maximum of sequential stages:

| Stage | Estimated simultaneous bytes |
| --- | --- |
| Tiles | `R + min(tileConcurrency,tileCount) × 256² × 4` |
| Inference | `R + 16 × S² + 64 × windowCount` (Float32 CHW, RGBA input and window-index allowance) |
| PNG encoding | `2R + A` |
| Preview | `R + A + 3P` |
| Optional TIFF | `R + A + P + 3A + 2T` |

Training reserves its raster plus a 1024-chip/encoding allowance and grows its reservation for retained JPEG/label inputs. TIFF validates strip rows and georeferencing, checks actual accumulated compressed sizes, and refuses Classic TIFF offsets beyond 32 bits before allocating the final output buffer. Job ZIP export accounts for retained image/text inputs with a 3× assembly allowance, refuses an over-budget archive, and holds its reservation until generation settles. Dataset export applies the same growing archive allowance. Neither writer streams; GMD-015 still owns bounded native output/backpressure, split archives and compression policy.

Comparison reads the 24-byte PNG header before decoding, rather than trusting saved metadata. This preserves older server clips without recorded dimensions. It checks the source and 2048-side target, reserves native decode scratch plus target buffers, requests an explicitly sized decode and rejects browsers that return a different size. Exports retain their original dimensions. A large legacy image may require a deliberate limit adjustment; no saved data is rewritten or discarded.

One processing operation (clip/raster/detection/dataset) and at most two auxiliary comparison/export helpers are admitted per engine context. Aggregate reservations must fit the strictest active operation's configured cap. Training holds the application's processing slot; newly submitted browser jobs wait in the existing FIFO and resume afterward. Active browser processing prevents starting training. Auxiliary work can receive a retryable resource-busy/limit error. This policy does not synchronize arbitrary external windows or future workers.

Ownership and cleanup

| Resource | Owner and cleanup |
| --- | --- |
| Raster canvas | `buildRaster` owns until it returns; the caller must call **`raster.release()`** in `finally`. `processClip` and dataset export do this. Manually setting dimensions is insufficient to release the reservation. |
| Preview/chip/comparison canvas | Shared allocation lease; each helper releases in `finally`, and the operation lease closes any remaining tracked canvas. Release is idempotent and shrinks canvases to 1×1. |
| Tile/comparison bitmap | Tile callback or comparison helper closes it in `finally`, including abort/mismatched-size cases. Browser decoder internals are outside this accounting. |
| Requests/timers | Existing coverage/tile operation owns its AbortController; sibling work drains and request/operation timers clear before failed raster cleanup. |
| Tensors/session/cache | Inference buffers enter this estimate. Model runtime pools, output candidates, GPU/session ownership and cache retention remain GMD-010/GMD-012/GMD-013 work; no session or precision change here. |
| Blob/object URLs/views | Completed Blobs pass to the existing IndexedDB transaction and clip-view owner. GMD-004 view/download URLs retain their existing separate cleanup. Allocation leases neither delete persisted records nor revoke view URLs. |
| Persisted records | AOIs, jobs, predictions, drafts, reviews, artifacts and queue identity/schema stay unchanged. New limits/estimates are additive metadata. A rejected clip records a typed failure, never fabricated zero detections. |

`GVEngine.diagnostics().allocations` exposes live/peak tracked canvas bytes, current/peak estimated reservations, active owners, admission rejections and created/released canvas counts. A canvas count balanced after release establishes that ownership path only. Model/cache/record retention is separate; encoding/decoding/ZIP assembly can produce temporary native spikes. These estimates are not a process-memory hard limit, a browser maximum detector, or evidence of a confirmed leak fix.

Verification and remaining gates

`npm test` exercises limit boundaries, zoom-floor rejection, long thin/invalid/holed/multipart geometry, imagery-only/model/training paths, failures/cancellation, legacy comparison and asynchronous ZIP ownership. `node tests/browser/allocation.cjs` uses real Chromium canvas/bitmap/PNG/TIFF/ZIP/IndexedDB APIs with deterministic tile and inference outputs; it independently inflates TIFF strips, compares all PNG pixels including a hole, verifies EPSG/world transforms and unchanged fixed predictions, checks preflight/snapshots and balances ten repeated native clip owners. Pages CI runs both and retains the existing lifecycle and fresh-export/cached-asset tests/export flow.

Measured local results and source hashes are in [gmd-005-verification.json](./gmd-005-verification.json). The 390px viewport check establishes layout only. Actual smaller-memory hardware, Firefox/Safari canvas/decode behavior, real imagery/model quality fixtures and sustained JS/native/GPU memory measurements remain GMD-021 acceptance work. Timings from tiny synthetic tiles are diagnostic observations, not production speed claims. CI and deployed verification must be recorded separately.
