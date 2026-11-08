Bounded processing and exports (GMD-006, GMD-012, GMD-015)

The browser application now uses a bounded native-resolution producer and chunked
PNG/TIFF/archive writers. It keeps the existing GitHub Pages deployment, sequential
job queue, WebGPU/WASM models, reviewed geometry and native georeferencing.
The older full-canvas engine APIs remain available behind GMD-005's strict limits
for compatibility and reference checks. The application selects the bounded path.

Processing and limits

1. Preflight computes the original pixel-snapped extent and existing tile-limit
   zoom choice. Memory gates never silently reduce that zoom. The final z10 tile
   cap remains enforced. Settings are frozen in each queued job.
2. Scenes fitting one fixed block of at most 2048 pixels per side keep the original
   Canvas mask. Larger scenes acquire 256-pixel tiles, mask/crop their native
   pixels and spool raw blocks into IndexedDB. Acquisition concurrency stays
   bounded (default 12). Tile bitmaps and acquisition canvases close after each
   awaited write. Missing coverage remains distinct from transport/decode failure.
3. A byte-limited LRU (at most 16 MiB) serves unchanged 1024-pixel model windows
   across blocks. Window order, overlap, transparent padding, normalization,
   per-window top-3000 decoding and global suppression are preserved. Windows are
   generated lazily. A conservative candidate allowance (at most 32 MiB, estimated
   at 2048 bytes per candidate) rejects excessive scenes explicitly; it never
   silently trims predictions to fit the budget.
4. Writers read bounded rows/strips from the same source. Native PNG/TIFF keep
   dimensions, RGBA alpha, EPSG:3857, pixel-corner TIFF transform and pixel-center
   world-file offsets. PNG and TIFF are independently selectable before running.
   Selecting neither retains detections and display images. Regenerating an omitted
   native format later requires rerunning imagery; no recovery claim is made for
   raw blocks, which are temporary.
5. An unannotated display PNG and annotated JPEG use at most 2048 pixels per side.
   The map/comparison use the unannotated image while vectors retain full precision.
   Native artifacts remain available for export; display pixels are not inference
   inputs. Large displays use global bilinear sampling to avoid block seams.

`maxPixels` and `maxDimension` now bound each working canvas, rather than the full
native extent on this path. The default policy remains 32 MP / 8192 px / 512 MiB
estimated working buffers. A bounded estimate includes the block cache, candidate
allowance, concurrent acquisition/decode scratch, display buffers, model input and
8 MiB of writer scratch. It does not include model/session pools, all JS objects,
driver/browser decoder caches or the browser process. Temporary storage has a
separate conservative 2 GiB per-operation allowance. Its estimate includes raw
blocks, PNG and both TIFF strip/output writes; actual cumulative writes are capped.
Session-only storage has a shared 32 MiB ceiling and reports a smaller-AOI/enable
storage error when exceeded. It does not promise to process large sample AOIs.

One processing owner, two image/export helper owners and up to four short-lived
download owners share the strictest active working-byte cap. A processing owner
waits cancellably for temporary reservations to clear; oversized work is rejected.
Part downloads are additionally limited to two in the UI and reserve three times
their bytes until the browser download URL's 10-second consumption grace ends.
Downloads release immediately on page hide. These are admission estimates, not
hard limits on physical JS/native/GPU memory.

Format/output contract

| Resource | Bound and behavior |
| --- | --- |
| Native row buffers | 256 KiB input batch; width must satisfy `width*4+1 <= 262144` |
| Encoded output queue | At most 1 MiB per writer; every sink write is awaited before producing more |
| Durable output chunks | 256 KiB; repository rejects individual chunks above 1 MiB |
| PNG | Lossless 8-bit RGBA, streaming zlib/IDAT; positive signed-31-bit dimensions |
| GeoTIFF | Lossless deflated strips, at most 20,000 strips; directory at most 1 MiB; Classic TIFF 32-bit offsets/positive dimensions |
| ZIP | Classic ZIP, at most 4096 files, 256 KiB directory accounting, 4 GiB total and per-entry sizes; explicit split-by-clip error before overflow |
| Fallback downloads | One Blob only when output fits 16 MiB; otherwise numbered byte parts, each at most 16 MiB |
| Direct file output | Feature-detected `showSaveFilePicker`; sequential awaited writes and close/abort; file picker stays in UI code |

PNG/TIFF/JPEG archive entries use STORE; GeoJSON/CSV/text use streaming compression
where applicable. Text is encoded in bounded UTF-8 chunks. Combined GeoJSON reads
clips/features incrementally, rather than collecting one whole-job feature array.
One FeatureCollection/feature can still be resident while serialized; the feature
and result catalogs are not covered by a general object-byte budget (GMD-009).
Active-GeoJSON/AOI downloads also retain their existing serialization behavior.
ZIP paths, original fields and CSV columns stay compatible; collision suffixes
are computed against the whole job, including selected-clip exports. New summaries
also report native/display sizes and actual paths.

For large fallback output, Export shows individual part buttons, a JSON manifest
and `combine.py`. Download all into one folder, run `python3 combine.py`, then
extract the combined ZIP. Parts are consecutive bytes, not independently valid
ZIP files. The script checks names, size, each part's CRC32 and the combined ZIP's
CRCs. It refuses an existing output or partial file and removes only its own failed
partial output. Temporary export records are removed on dismiss, replacement or
page hide; committed detection artifacts remain. A stale crashed export is swept
on the next processing/export use. Large CSV fallback parts use the same reassembly
script without ZIP validation. Unsupported file pickers retain the part workflow.

Persistence compatibility

IndexedDB schema version **2** uses the existing stores and indexes. Version-1
AOIs, job/queue records, Blob artifacts, predictions, reviews and unknown result
fields are retained without rewriting. The version increase is a capability fence:
old version-1 clients must not open version-2 chunk descriptors as if they were
Blobs. A newer schema still produces an explicit compatibility error. Existing open
tabs close on versionchange; normal fenced writer/read-only behavior remains.

Native artifact values may now be either old Blobs or
`{gmdArtifact:1,spool,file,type,size,chunks}`. Descriptors stay small; one chunk is
read on demand and its declared size/sequence is validated. Staging manifests and
chunks use the existing `artifacts` store, indexed by job ID. Raw blocks and export
spools are disposable. `saveClip` atomically commits result/prediction descriptors,
job outcome and its staging manifest, checking job/clip ownership first. Restore
still performs zero artifact/weight/prediction hydration. First processing use
sweeps only interrupted staging owners from prior page instances, not committed
records. Quota failures pause the queue with prior committed clips intact.
Deleting a job removes its artifacts/chunks but keeps saved reviews and model
sources. No full native artifact is reconstructed merely to open a map view.

Ownership and cancellation

| Resource | Owner and terminal action |
| --- | --- |
| Processing/export operation | Immutable ID, linked AbortController and deadline; `finally` clears timer/listener and closes reservation after draining children |
| Metadata/model/tile request | Request timeout and consumer signal; pre-aborted work starts no request; siblings settle before raster cleanup |
| CacheStorage open/match and shared library load | Page-owned promise with cancellable consumer; late completion cannot continue a retired operation; shared library load remains reusable |
| CacheStorage writes | Tile owner awaits the write; no write is launched after a stop is observed |
| Decoded tile/comparison ImageBitmap | Consumer closes once after use/failure, including late decode completion |
| Raster/display/chip canvases | Allocation lease, idempotent release to 1×1 in `finally`, including encoder/source failures |
| Raw-block LRU | Raster owner clears before removing raw spool records |
| Input/output tensors | Each inference disposes every distinct tensor in `finally`; native inference already running is drained before cancellation acknowledges |
| Model sessions | Engine cache owns successful reusable sessions; cancelled late initialization releases its session without caching/fallback. Idle cache eviction remains GMD-010 |
| Chunk writers/file destinations | Operation awaits outstanding writes, aborts incomplete output, removes its staging spool, retains completed clips |
| Clip view/object URLs | Existing GMD-004 disposer; bounded display URL is independent of stored native data; timed download URLs own separate reservations |
| Auxiliary dataset/ZIP/CSV and part reads | UI controllers, cancel buttons, completed promises; page hide aborts/drains before repository close |
| Server job/training polls | Local controller, deadline, current-request promise and retry timer; page hide/API change drains/stops; five consecutive failures stop polling. Server work can continue remotely |
| Persisted user data | Repository transaction; user/job-scoped deletion only. Temporary spool cleanup never deletes unrelated committed records |
| Workers | No processing worker is introduced. Lazy runtime loading remains worker-compatible; GMD-007 owns worker lifetime/termination |

Preprocessing, suppression, masks and encoders yield so UI cancellation can be
received. A stop checks before/after await boundaries and before publishing results.
AbortError, deadline TimeoutError and actual processing/storage failures remain
distinct. Cancellation acknowledgement can wait for one non-interruptible active
session creation, inference, browser decode/encode or storage/file write; no false
one-second guarantee is made for those native calls. A completed clip transaction
is retained. Cleanup errors are counted and attached without masking the original
failure. Page teardown/hard process termination cannot guarantee a final write;
committed snapshots and staging-owner recovery provide the durable boundary.

Quality and measurements

The original planning gate required identical pixels. Native block clipping with
Canvas introduces clip-dependent diagonal antialiasing. Tests rejected the first
approach, which moved real predicted corners by 9.42 pixels on one small fixture.
The delivered policy keeps the original Canvas mask for small fixed-block scenes
and uses deterministic global even-odd pixel-area coverage for larger scenes.
This is an explicit amendment to literal diagonal-edge pixel equality, not a
resolution/overlap/precision/suppression optimization. `maskVersion` is recorded on
results; comparisons warn about differing AOI edge masks.

Declared before the real-model experiment: original-to-production masks must keep
classes/counts, move corners at most 0.5 native pixel and confidence at most 0.005.
Canonical whole-image-to-block output must keep classes/counts, move corners at
most 0.05 pixel and confidence at most 0.0001. Synthetic canonical block pixels and
SHA-256 model inputs must match exactly; diagonal differences versus old Canvas
must stay within one pixel of the boundary, alpha/premultiplied channels within
16/255, with opaque interiors unchanged. Rectangles, holes, MultiPolygons, diagonal
crossings, thin extents and fixed overlapping seam predictions are checked.

Evidence files record browser, source hashes, dimensions and settings:

- [Native bounded processing](./gmd-006-012-015-verification.json): all six native
  sample AOIs, pixel/input hashes, owner counts, CRC-valid OPFS ZIP, dataset/format
  and failure checks. Tiles and inference outputs here are deterministic fixtures;
  timings do not establish live detection throughput or accuracy.
- [WebGPU model equivalence](./gmd-006-quality-webgpu.json): both real models,
  small and large rectangle/diagonal/hole/MultiPolygon fixtures; same classes/counts,
  maximum observed old-to-production corner change about 0.07 native pixel.
  These are non-regression fixtures, not labelled accuracy evaluation.
- [Forced-WASM equivalence](./gmd-006-quality-wasm.json): the same 16 positive
  nano/small fixtures pass the same gates. Both providers retain identical
  canonical-to-block features. The native evidence also appends final-source
  CI-sized bounded processing, legacy allocation, persistence/editing, live imagery
  and map interaction checks. **201 JS and 12 Python tests pass.** Each experiment
  retains its actual source fingerprints; later storage/download guards are
  covered by the final-source CI/native and unit checks. CI/deployed parity is
  separate from local overrides.

`GVEngine.diagnostics()` exposes operation, tensor/request/cache-write, allocation
and streaming-queue counters; results include phase timings and cache high water.
`GVApp.diagnostics()` includes auxiliary/part/poll state. Zero owners after terminal
acknowledgement verifies these lifetimes; it does not establish a general absence
of leaks. Persistent native artifacts, CacheStorage, model/session caches and
drafts are intentional retention. Decoding/encoding/runtime allocation can cause
temporary spikes. Sustained JS/native/GPU profiling, physical constrained devices,
Safari/Firefox, incremental vectors and moving CPU work to a worker remain the
corresponding GMD-009/010/013/007/011/020/021 tasks. No production speedup or process
memory reduction percentage is claimed.

Reproduce with `npm test`, Python model-asset tests,
`node tests/browser/allocation.cjs --bounded`, and
`node --use-system-ca tests/browser/queue.cjs --quality [--wasm]`.
The offline CI bounded probe uses `--ci` (DXB plus small integration fixtures).
Pages keeps `scripts/export_onnx.py` on fresh cache misses and unconditional
`--check` on fresh/cached assets. `streaming.js` is published and checked with the
other frontend sources, but loads only when processing/export first needs it.
