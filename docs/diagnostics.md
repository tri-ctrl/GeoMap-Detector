GMD-020 local diagnostics and artifact provenance

Implemented 21 November 2026. [The tracker](./tasks.md) is the status authority;
[verification](./gmd-020-verification.json) records source fingerprints, raw
measurements and remaining CI/deployment gates. GMD-017's inference profiling
and all earlier measurements are preserved.

Using diagnostics

Open **Results → Diagnostics → Download diagnostics**. The JSON contains the
executing engine revision, artifact/model fingerprints, configured/reported ORT
version, provider, startup marks, bounded operation events and resource counters.
The section shows the last browser-job inference provider/model. **Clear trace**
clears retained events; it preserves active owners, counters, imagery caches,
saved jobs, reviews and AOIs. There is no remote analytics endpoint.

The report excludes imagery, feature coordinates, reviews, AOI collections, job
logs, request URLs, exception messages/stacks and environment variables. IDs,
model keys/fingerprints and coarse dimensions are retained for correlation.
Strings in events have a 160-character limit and an explicit scalar allowlist.
Downloads use the existing Blob URL and allocation lease, released after ten
seconds or on page hide. The report snapshot precedes its own download lease.

Operation and clock contract

`GVEngine.telemetry` supports `start`, `run`, `metric`, `count`, `snapshot`,
`ingest`, `clear` and a developer `setEnabled` switch. The `createTelemetry`
factory supports injected clocks and smaller limits in tests. Normal processing
enables telemetry; it does not emit events inside pixel, anchor or NMS pair loops.

- Version 1 uses context UUIDs and context-local operation IDs/sequences. Parent
  IDs correlate page jobs, worker RPC waits and processing stages. Each span has
  one start and one idempotent terminal event: `ok`, `partial`, `error` or
  `cancelled`. Error name/code are recorded without retaining the Error object.
- An end event includes `startMs`, `atMs` and `durationMs`. Starts may age out of
  the ring while a long operation is active; terminal events remain self-contained.
  Clock readings clamp backwards movement and durations are nonnegative.
- The default ring holds **256 events**, with a hard factory maximum of 1024.
  There are at most **64 retained active-span summaries** (factory maximum 128),
  **32 counter names** and **16 imported-context cursors**. Extra concurrent
  owners are counted in `omittedActive` and still emit terminal events. Ring
  eviction reports `droppedEvents` and never cancels real work.
- Window and worker durations are calculated within their own `performance.now`
  context, with context ID/kind and `performance.timeOrigin` included. Events
  enter the page's ring in arrival order, rather than a fabricated shared clock.
  Backend `perf_counter` times are relative to their trace start and have no
  browser time origin. Do not subtract UI/worker/server timestamps directly.
- Worker snapshots are bounded, merged by context/sequence, and deduplicated.
  Only a scalar summary is retained in `GVProcessing.diagnostics().last` after
  merging; complete previous worker traces are not collected indefinitely.
  A worker crash/forced stop can prevent remote terminal events. The page RPC's
  terminal error documents that failure; it does not prove cooperative GPU cleanup.

Instrumented boundaries

The browser records jobs, model loading, model-body downloads, each provider's
session attempt, imagery acquisition, inference, ZIP/dataset/output operations,
worker startup and worker load/clip/close waits. Failed/pre-aborted clips also
produce terminal records. Build-information requests have their own owned span.

Existing bounded-clip phase timings become aggregate metric events for preparation,
imagery, detection, identity, PNG/TIFF, display encoding and cleanup. Existing
GMD-017 preprocessing/model/decode/chip/global NMS/disposal/yield totals become
inference metric events. A metric is an aggregate measurement, not a new
continuous start/stop span. Coarse phases can include small boundary overhead;
disabled output formats can have near-zero phase durations. A failure before a
metric completes has the enclosing operation's explicit terminal error.

Model download and session initialization are separate. WebGPU failure followed
by WASM reports both attempts while retaining the existing single download and
fallback behavior. Model loading includes hashing and runtime/library readiness.
The awaited model-call time includes transfers and execution; it does not isolate
physical GPU upload, kernel or readback time. Configured ORT version is pinned
to 1.20.1; a runtime-reported version is included when that property is available.

Startup retains independent app-ready, metadata-ready and first-loaded-map-tile
marks and dependency timings. Wayback metadata source/cache state is included.
Build metadata is fetched **after the first map tile**, with a five-second owned
deadline. It does not gate map startup or model use. Page hide cancels it; a
restored page revalidates even a previously valid manifest. Missing/invalid
metadata remains optional, and a failed refresh keeps the last validated artifact.

Bytes and ownership

Tile counters distinguish Cache Storage hits/misses, network requests, retry and
failed attempts, decoded body bytes and bitmap-decode time. A hit can fail decode
and retry through the network. Coverage-known absent cells skip image requests.
`tile.encodedBytes` counts every completed body read, including cached reads;
`tile.networkBodyBytes` counts completed network bodies. These are logical body
bytes, not wire transfer size, unique imagery size or decoded RGBA memory.

Model counters cover complete successful network bodies, supplied buffer bytes,
downloads and legacy-cache hits. Job-scoped sessions still bypass the legacy cache
and release through the delivered lease contract. Output counters record produced
ZIP/CSV/dataset bytes without counting a streaming wrapper twice. Inference keeps
the existing logical input/output and bounded suppression estimates. Writer bytes
can include temporary/raw spool writes and are not final retained artifact bytes.

The report includes owned canvases/reservations, operations, model leases,
suppression scratch, writers, worker transfers, view/download leases and retained
result estimates. Memory counters are explicitly separate from physical JS heap,
process/native/GPU memory. The latest scalar profiles and committed results are
intentional retention; transient arrays/encoders create temporary working sets.
Balanced ownership is cleanup evidence, not a sustained memory-leak measurement.
No new model session, worker, canvas, bitmap or image URL is introduced by tracing.
The only new request is the optional same-origin build-information request.

Public build provenance and Pages

After the existing export/cache-hit `export_onnx.py --check`, Pages runs
`scripts/write_build_info.cjs` with the full source SHA. It validates both model
assets, streams their SHA-256 hashes and writes `frontend/build-info.json` into the
artifact. It stamps a single declared revision literal in `engine.js`; this is
the revision actually interpreted in the window and worker. The source checkout
keeps the `development` literal; generated build metadata is ignored by Git.

The public manifest contains only schema version, revision, a separate build
timestamp, pinned runtime information, source digests and model file/byte/hash/
input/class-count records. It reads no environment dump or private configuration.
The same step works with fresh exports and restored model assets, and repeating
it does not change model bytes. It changes no model export options or cache key.

`check_deployment.cjs` compares served files with the deterministic stamped
checkout, validates the artifact's revision/source/manifest digests and checks
both model URLs, sizes and provenance. An explicit revision pins the selected
artifact; without one the checker uses the public manifest. Older unstamped
artifacts can still be checked without a manifest when no revision is requested.
The checker does not re-download every model merely to recompute its hash;
actual executed model fingerprints remain available from inference diagnostics.

`matched` means the manifest revision matches the executing engine stamp. A
different manifest or worker revision is shown explicitly, and an executed
built-in model whose fingerprint differs from the artifact is flagged. This
does not prove that every module already cached in a browser matches the current
deployment; the post-deploy guard checks served bytes. Build timestamp is not
source revision, and a development checkout cannot claim deployed parity.

Optional backend

`backend/telemetry.py` provides the same bounded start/end schema, per-job IDs,
scalar filtering and monotonic durations. Pipeline stages cover model readiness,
date discovery, imagery, native encoding, detection and ZIP output. Backend
inference remains one coarse stage and reports `provider: server`; it does not
pretend to identify a GPU device or separate model/preprocessing/NMS internals.
Its revision is a SHA-256 fingerprint of the loaded pipeline/telemetry/imagery/
detector source snapshot, not the Pages Git SHA. Raster bytes are logical NumPy
array sizes; encoded/archive bytes come from file sizes.

Live job polling exposes the trace. Completion/error writes an optional atomic
`diagnostics.json` sidecar; a write failure preserves the job outcome and reports
unavailable diagnostics persistence. Older job folders without it still load.
The original output ZIP is generated before the sidecar. The client merges
server events with a separate backend context and keeps only a small summary
outside the common ring. Backend byte counters are available in the job API and
sidecar; the page report retains backend stage events and a source/status summary.
Per-job traces/sidecars are bounded; the existing total
job/folder retention and backend concurrency policies remain GMD-019 work.

Verification and reproduction

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/browser/allocation.cjs --diagnostics --benchmark --output /tmp/gmd020-native.json
node tests/browser/startup-offline.cjs --output /tmp/gmd020-startup.json
node tests/browser/allocation.cjs --worker
node tests/browser/allocation.cjs --bounded --ci
node tests/browser/persistence.cjs --lifecycle --queue-recovery --identity
node --use-system-ca tests/browser/worker-runtime.cjs --output /tmp/gmd020-gpu.json
node --use-system-ca tests/browser/worker-runtime.cjs --wasm --output /tmp/gmd020-wasm.json
```

Run native probes serially with Chrome installed. The local overhead adoption
gate, declared in GMD-020's plan, is **under 5% median added time**. The controlled
fixture has two warmups per mode and nine alternating enabled/disabled full-clip
runs; GMD-017 profiling remains present in both modes. The disabled path bypasses
coarse wrapper setup, while lightweight disabled metric/counter checks remain.
Native Chrome on Apple M1 Max measured **71.0 → 71.3 ms median (0.42%)**, with
identical ordered GeoJSON/world files. This is a cached synthetic-tile/fixed-60-ms
model fixture, not a universal device, live-network or real-model throughput claim.
Raw samples, p95 and environment/source identifiers are in the verification file.

CI checks deterministic bounds, provenance, privacy filtering, terminal outcomes,
context merging and cleanup without a flaky wall-clock threshold. Five cold/warm
startup pairs and saved-data/worker/native-image regressions are recorded
separately. Fresh/cache artifact generation and deployment verification are tested
without ML packages. Actual new model generation and deployed SHA parity remain
the normal Pages workflow/release gates; earlier CI evidence is not overwritten.

Manual release checks: download diagnostics during a running, cancelled and
completed job; check build/provider/model identity, ring truncation and resource
owners after cleanup. Resume a cached page after a new deployment and verify a
revision mismatch, then reload. Recheck annotation edits, model/date comparison,
saved jobs and native exports. Physical constrained devices, sustained JS/native/
GPU memory, all custom weights and optional real backend GPU load remain GMD-021/
release work. No inference resolution, overlap, precision, thresholds or saved
data schema is changed by this task.
