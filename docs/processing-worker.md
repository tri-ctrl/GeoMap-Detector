# Browser processing workers (GMD-007)

Browser jobs use one dedicated classic worker when `Worker`, `OffscreenCanvas`
and `createImageBitmap` are available. Acquisition, masking, preprocessing,
inference, suppression, display encoding and native PNG/TIFF encoding execute
there. The page continues to own UI state, the FIFO queue, saved records,
annotation editing, result display and exports.

`processing.js` resolves `processing-worker.js` relative to its own script URL.
The worker imports the existing engine and streaming writers. The Pages artifact
contains both scripts; the deployed-source guard checks their bytes. The pinned
ORT 1.20.1 loader runs inside the worker and tries WebGPU before WASM. This uses
ORT directly, without its WASM proxy. It works without cross-origin isolation;
the existing loader selects single-threaded WASM in that case. See the runtime's
[deployment guidance](https://onnxruntime.ai/docs/tutorials/web/deploy.html).

If capabilities or worker startup are unavailable, the job uses the existing
bounded, yielding main-thread path. A mid-job worker crash fails the affected
clip; it never silently reruns or commits a partial result. The next job creates
a fresh context. Failed/unavailable clip outcomes retain the existing retry and
saved-job behavior. Exporting and the optional Python server retain their paths.

## Lifetime and protocol

`GVProcessing.create({jobId, signal, store, onFallback})` returns a job owner:

1. `loadModel(spec)` acquires a session, or `loadModel(null)` starts imagery-only
   processing. The page retains recoverable custom weights; messaging never
   detaches its buffer. Relative model URLs resolve under the project path.
2. Await each `processClip(aoi, release, options)` sequentially. Progress,
   estimates and coverage callbacks target that command only.
3. Always await `close()` in `finally`, before releasing the queue slot or
   closing the repository. Closing is idempotent.

Version 1 messages carry a job ID and monotonically increasing command ID.
Commands are `load`, `clip`, `cancel` and `close`; replies are `ready`, `progress`,
`result` and `error`. Spool calls use numbered `storage`/`storage-result` RPCs
within the current command. Other versions, stale commands and foreign job IDs
cannot change the current job. Errors preserve their name, code, coverage and
allocation details; quota errors still pause saving/processing.

Cancellation first aborts worker-owned operations. In-flight inference, sibling
requests, encoding and accepted repository writes drain before the terminal
reply and admission release. A 30-second cancellation watchdog terminates a hung
worker; a command deadline also prevents an indefinite wait. Forced termination
cannot provide an explicit native-session release acknowledgement. The context
is terminated, page writes drain and staging cleanup completes before the page
releases ownership. `forcedStops` distinguishes this from cooperative cleanup.
Page hide uses the same cancellation/drain path before database closure; saved
queues remain paused until Resume after page-show recovery.

| Resource | Owner and cleanup |
| --- | --- |
| Worker | One active job; terminate after close acknowledgement, startup failure, crash or watchdog. Clear handlers and command/abort timers. A later job creates a fresh worker. |
| ONNX session | A job-scoped `GVEngine.models.acquire` lease in its execution context; initialization cancellation releases late sessions; awaited, idempotent lease release follows clip cleanup. Job leases bypass the legacy cache. |
| Model source | Page/job and existing IndexedDB model records. Structured cloning preserves the recoverable source. Worker-local loading buffers expire with their context. |
| Canvas, bitmap, tensor, request | Existing engine operation owners inside the worker; native calls drain, tensors dispose, bitmaps close, canvases release and request signals abort before terminal acknowledgement. |
| Transfer buffers | A private copy of at most 1 MiB per chunk; transfer that copy explicitly. Never detach the encoder's reusable row, the page's session spool or custom weights. Await replies for backpressure; existing acquisition concurrency remains bounded (12 by default). |
| Temporary spool | Page-owned `GVStreaming`/IndexedDB handle, accessed by worker RPC. Failed, cancelled and crashed commands drain pending writes and dispose staging. A successful result hands referenced spools to the existing commit/export owner. |
| Session-only artifacts | Spools live in the page's existing bounded memory store, so native downloads remain readable after worker termination. The existing 32 MiB session storage limit remains in force. |
| Persisted result/review | Existing repository commit/deletion policies; no schema upgrade, migration, record rewrite or new writer lock. Committed clips survive cancellation. |
| Display object URL/image | Existing page clip/comparison owners. Workers create no object URLs or DOM images. Map/editor cleanup stays with those owners. |

The page retains the sole IndexedDB writer lock. Giving a worker a second writable
repository would undermine ownership fencing; the bridge deliberately avoids it.
The worker sends metadata, immutable predictions, bounded display Blobs and native
artifact descriptors. Full native raster canvases never travel to the page.

## Admission and observability

`GVProcessing.estimateRaster` includes a conservative transfer/serialization
allowance of `(min(tile concurrency, tile count) + 2) × 1 MiB`, in addition to the
engine's existing estimate. Both the Detect preflight and actual page admission
use this estimate. The worker reserves its local processing buffers; the mirrored
page reservation accounts for those buffers and transfers when admitting other
image/export helpers. Do not sum the two reservations as physical RAM usage.
Neither estimate includes a proven bound on browser/native/GPU memory.

`GVApp.diagnostics().processing` reports active jobs, created/terminated workers,
fallbacks, crashes, forced stops, storage requests, transferred bytes, pending
storage calls and the last worker's engine/session/streaming cleanup snapshot.
Job parameters record `processingContext`, provider and input size; clip timings
retain preparation, imagery, detection, encoding and cleanup stages. Progress is
throttled to at most about 31 updates/second, with stage and final updates intact.

This increment provides the GMD-010 lease prerequisite for the application job
path. GMD-010 remains Planned for reusable bounded caches, pending-load
deduplication, content/metadata-generation identity and broader custom-model
profiling. Job sessions currently reload per job: this avoids idle retention but
can add initialization/download time. The legacy direct `loadModel` API still
caches sessions for existing consumers. No throughput improvement is claimed.

## Reproduction and limits

- `npm test` covers the protocol, stale messages, capability/CSP fallback, quota,
  admission, source-weight preservation, cancellation, callbacks and crash restart.
- `node tests/browser/allocation.cjs --worker` uses actual workers, OffscreenCanvas,
  IndexedDB and pointer input with deterministic tiles/predictions. It compares
  native PNG/TIFF bytes, display pixels, predictions and world coefficients;
  exercises session exports, crash cleanup, page-hide/resume and application
  commits; requires zero staging records and settled reservations. Pages CI runs it.
- `node --use-system-ca tests/browser/worker-runtime.cjs --live-imagery` tests
  actual nano/small weights and pinned runtime on a captured live DXB release.
  Add `--wasm` to disable WebGPU inside both contexts. Worker/main predictions
  must match exactly and remain nonempty; provider and transforms are checked.
  `--gpu-failure` instead supplies an unavailable adapter to exercise automatic
  WebGPU-to-WASM fallback with the actual runtime.
  Without `--live-imagery`, deterministic imagery provides a runtime smoke check.
- Native persistence/queue recovery and the bounded mosaic probes retain their
  explicit main-thread fixture mode. They cover the compatibility path; the new
  worker probe covers cross-context operation instead of relying on page hooks.

[Recorded measurements](./gmd-007-verification.json) identify source fingerprints,
browser and individual samples. The controlled responsiveness gate is p95 map
pointer feedback below 100 ms and no UI long tasks of 50 ms or more during the
measured clip. It uses a fixed model that spends 60 ms per inference window in
its own context. This is a responsiveness regression benchmark, not detector
accuracy, comparative throughput, physical-device calibration or proof that the
entire browser/GPU process is leak-free. Live inference equality is a small scene
non-regression check; resolution, overlap, precision and suppression are unchanged.
Normal CI, deployed-source parity, Firefox/Safari, device loss and sustained
physical-device memory/thermal behavior remain release/profiling checks.
