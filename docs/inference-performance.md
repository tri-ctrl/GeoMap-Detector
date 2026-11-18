GMD-017 performance and equivalence gates

Implemented 2026-11-17. Status: **Ready for CI** after local verification.
[Measurements and source fingerprints](./gmd-017-verification.json) contain the
raw samples; [tracker](./tasks.md) retains the release gates and earlier evidence.

Before enabling an optimization, compare the frozen pre-change scan in
`tests/helpers/nms-fixtures.cjs` with production suppression. Run three warmups
and nine measured alternating-order repetitions per workload/policy. Report
median/p95 and raw samples with browser/CPU/source/model/provider identifiers.

The initial adoption gates are:

- Exact ordered detections for deterministic, randomized and adversarial boxes,
  ties, class grouping, chip IoU/global IoMin, boundaries and degenerate data.
- At least 30% lower median suppression time on the 3000-object sparse global
  and dense-chip retained workloads on the measured development machine.
- No median regression larger than the greater of 20% or 0.2 ms on the other
  declared workloads. Revisit the broad-phase heuristic if it misses this gate.
- Bounded index scratch, deterministic fallback rather than truncation, and zero
  retained index owners after success/cancellation/error.
- Exact same-provider baseline/indexed model outputs on captured nano/small and
  custom fixtures. Compare identities, class, confidence, geometry and order,
  plus native image/world-file checks. Counts alone cannot establish parity.

These local timing gates decide whether to enable the implementation; CI checks
deterministic parity/counters/cleanup, not device-dependent wall-clock ratios.
No change to chip size 1024, overlap 256, confidence, top-3000, precision or IoU/
IoMin semantics is included. Any later numeric/model change needs a labelled
held-out set with per-class precision/recall gates declared before experimentation.

Profile raster reads, normalization, tensor setup, the awaited model call,
decode, chip/global suppression, filtering, disposal and cooperative yields.
`session.run` includes runtime input/output transfers and execution; it does not
separate GPU upload, kernel time and readback. Report logical input/output bytes
and bounded index estimates separately from process/native/GPU memory.

Implementation and ownership

`frontend/engine.js` uses an exact spatial broad phase for both per-chip IoU
and final AOI IoMin suppression. Confidence sorting, stable ties, class grouping,
polygon intersection, denominator, strict threshold comparison and returned
object order remain the same. Only pairs whose bounding boxes cannot meet are
excluded. Selected classes still filter decoded predictions after the model
runs; class selection does not reduce the neural network's computation.

- Small groups use the direct scan. Groups of 512–32768 candidates build a
  64-pixel grid after 64 objects survive. Larger groups scan rather than allocate
  an unbounded index. Each class releases its index before the next class starts.
- Two Uint32Array buffers hold query stamps and matches, reused for every query.
  Grid references are numeric indexes into borrowed detections. There are at most
  4096 occupied cells, 32768 cell references and 64 cells per indexed box/query.
- Unindexable/huge boxes and entries beyond the admission limits go into an
  overflow scan. Crowded queries use the direct scan when cell visits exceed
  twice the retained count. Nothing is silently truncated or approximated.
- The index budget is the smaller of 2 MiB and 1/32 of the configured working
  budget. The estimate reserves 24 bytes per candidate, 4096 base bytes,
  256 bytes per occupied cell and 24 per cell reference. Array/container overhead
  varies by engine: these are admission estimates, not measured heap/native/GPU
  bytes. Structural entry/buffer limits are enforced independently. The estimate
  is included in preflight/processing reservations, rather than hidden scratch.
  Near-limit jobs can therefore reach the existing working-budget error sooner;
  split the AOI or adjust the configured budget. Tile/resolution policy is unchanged.
- Each suppression invocation owns its grid, buffers and overflow array. `finally`
  clears them on success, error and iterator cancellation; concurrent invocations
  never clear each other's index. Async work yields every 512 candidate/pair
  steps. The separate synchronous loop keeps small-call overhead low; parity
  checks exercise both paths against the same frozen scan.
- Inference continues to reuse one Float32 input buffer across a clip's windows.
  It stays alive through the awaited model call. The selected output's data is
  read once; unused output data is not accessed. Input and distinct returned
  tensors are disposed once, including aliases, in `finally`. Job-owned model
  sessions, requests, workers, canvases, bitmaps, URLs and persisted artifacts keep
  the existing GMD-007/012/008 ownership contracts. This change adds no new model
  cache, worker, network request, canvas or object URL.

Observability and compatibility

Every newly processed clip stores optional `timings.inference` version 1, with
provider/model fingerprint; window/anchor/candidate counts; logical raster/input/
selected-output bytes; disposal counts; stage durations; and chip/global NMS
comparison, fallback, yield and scratch counters. Normalization excludes measured
cooperative-yield time. Suppression records both active work and elapsed time;
elapsed includes yields/scheduling. The awaited model-call timing includes the
runtime's transfers and execution, which are not separately instrumented.

Detect logs a compact per-clip timing line. Developer diagnostics are available
through `GVEngine.inference.diagnostics()`, `GVEngine.suppression.diagnostics()`
and worker close diagnostics. Only the latest aggregate profile is retained in
the engine, as a detached scalar snapshot; there is no growing event/tensor log.
Committed profiles belong to the existing clip record and follow its deletion
policy. Older saved records without timings load normally. IndexedDB version 2,
prediction IDs/reviews, custom weights, editing and exported geometry are unchanged.

`nmsMode: "scan"` on `detect`/`processClip` remains a developer/reference fallback,
including the processing worker; normal jobs default to `"indexed"`. The public
`nms` three-argument call is compatible. Runtime 1.20.1, WebGPU → WASM fallback,
1024 input, 256 overlap, float32 normalization, top-3000 and 0.45 IoU/IoMin remain
unchanged. FP16, graph capture, GPU output residency, preallocated runtime outputs
and runtime/model upgrades were not adopted. They need independent measurements
and predeclared labelled per-class quality gates; no held-out labels were supplied.

Measured results and limits

Apple M1 Max, native headless Chrome 157, same renderer/context, three warmups
and nine alternating scan/indexed repetitions per workload/policy:

| Synthetic workload | Policy | Original scan median / p95 ms | Indexed median / p95 ms | Median reduction |
| --- | --- | --- | --- | --- |
| Sparse global, 3000 retained | IoU | 17.8 / 17.9 | 3.4 / 4.8 | 80.9% |
| Sparse global, 3000 retained | IoMin | 18.1 / 18.6 | 3.2 / 5.1 | 82.3% |
| Dense chip, 3000 small retained boxes | IoU | 17.5 / 17.9 | 2.9 / 3.0 | 83.4% |
| Dense chip, 3000 small retained boxes | IoMin | 17.4 / 18.0 | 2.9 / 3.3 | 83.3% |

All eight declared workloads and both policies satisfy the initial median gates
on this machine. The thin parallel adversary is about 9% slower and the
multi-class/tie fixture about 14% slower; both are within the declared 20%/0.2 ms
allowance. Tiny timings quantize to zero in Chrome; ratios there are meaningless.
Sparse bounding-box checks fall from 4,498,500 to 91,270. Peak admitted index
estimate is 1,222,976 bytes for that fixture, then zero after completion. This
is CPU suppression evidence, not a general inference/throughput claim.

The supplementary same-realm Node run also passes the adoption gates (54–60%
median reduction on the four 3000-candidate cases). A preceding tuning run
exceeded the allowance on a large set which retained only one box (1.566 →
1.900 ms); the final fast path skips grid-query setup while fewer than 64 boxes
survive. The rejected run and final rerun are both retained in the report.

Real published nano/small models were tested on captured 2026-10-29 DXB aircraft
and Port Rashid ship imagery on both WebGPU and forced WASM. Each scene/mode has
one warmup and three measured runs. Full ordered GeoJSON, including identities,
confidence and geometry, display PNG hashes, native dimensions and world files
match exactly within each provider/model. Nano finds one DXB aircraft and five
Rashid ships plus a pool; small finds one aircraft and five ships. Actual native
PNG/TIFF decoding, masks, model-input hashes and seam/global suppression are
covered separately by deterministic bounded/writer and worker regressions.

These real scenes have only 1/9 inference windows and few predictions, so their
indexes stay inactive. Model-call medians dominate on both providers; the report
contains per-stage median/p95 and individual run timings. Raster reads and
normalization also matter on WebGPU. There is no demonstrated
whole-job speedup for these scenes. The three-sample p95 is the maximum sample,
not a stable tail estimate. A bounded test-only same-origin proxy reuses captured
provider bytes; this does not verify production CORS, the live deployment, or
future release availability. Provider response hashes match between GPU/WASM
captures; model fingerprints are recorded. Equality is not labelled accuracy.

Balanced index/tensor/worker/reservation counters establish logical ownership
cleanup. Temporary typed arrays and candidates are working allocations; the last
profile and saved results are intentional retention. Native/GPU runtime pools and
sustained process memory were not measured here, and no confirmed leak fix is
claimed. Physical mobile devices, other browsers, device loss, large real dense
AOIs and arbitrary user-supplied ONNX models remain release/quality checks.

Reproduction and regression checks

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
node scripts/benchmark_nms.cjs --output /tmp/gmd017-cpu.json
node tests/browser/allocation.cjs --suppression --output /tmp/gmd017-nms.json
node tests/browser/allocation.cjs --bounded --ci
node tests/browser/allocation.cjs --worker
node tests/browser/persistence.cjs --lifecycle --queue-recovery --identity
node tests/browser/startup-offline.cjs
node --use-system-ca tests/browser/worker-runtime.cjs --profile --output /tmp/gmd017-gpu.json
node --use-system-ca tests/browser/worker-runtime.cjs --profile --wasm --output /tmp/gmd017-wasm.json
```

Run native probes serially with Chrome installed. Real-model profiles require
network access to published weights, pinned runtime assets and provider imagery.
The frozen scan and both functions must share one JS realm for meaningful CPU
comparisons; cross-realm polygon clipping introduces measurement bias. The Node
benchmark also reports hardware/source fingerprints and nine raw samples.

Pages CI adds native deterministic suppression parity, comparison-reduction and
cleanup checks without flaky wall-clock thresholds. The existing exporter/cache
key, fresh export, dependency-free `--check` on cache hits, Pages artifact and
post-deployment model/source guard are preserved. Twelve asset tests validate
fresh packaging with a fake exporter plus cached/malformed assets; actual fresh
model generation remains the normal workflow gate. Local `--check` reports the
expected missing binary because this checkout contains no exported ONNX files;
real runtime profiles use the published models rather than claiming a fresh export.

Manual release checks: run a representative dense AOI, inspect the new timings
and counts, cancel during suppression and retry; open/edit/save/reload its result,
compare dates/models and export native imagery/reviews. Repeat with forced WASM
and user-provided weights. Do not lower resolution/overlap/precision to pass a
speed gate. CI success and deployed parity must be recorded separately.
