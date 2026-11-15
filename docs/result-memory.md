GMD-009 — Retained results, display cache and deletion

Results → **Result memory and display** controls the retained-result budget (default **128 MiB**, configurable from 1–2048 MiB) and the longest side of newly opened display images (**512, 1024 or 2048 px**, default 2048). Changing display size keeps the current view/editor and takes effect when a clip or comparison is opened again. Native inference inputs, overlap, suppression, PNG/TIFF exports, world files and prediction coordinates are unchanged.

The memory panel distinguishes retained estimates, protected data, unused cache and known saved artifact bytes. `GVApp.diagnostics().memory` exposes cache hits/misses/evictions, entry/pin counts, encoded cache bytes, vector estimates, decoded-display estimates, protected categories, over-budget bytes and peaks. Saved artifact bytes are logical encoded sizes, not measured disk usage; old records without size metadata are reported as unmeasured. Counts and byte estimates do not require loading native image artifacts at startup.

| Category | Accounting and lifetime |
| --- | --- |
| Raw prediction/display cache | LRU entries contain immutable raw predictions and a normalized unannotated PNG. Account encoded Blob bytes plus conservative JS/vector/metadata estimates. Active leases pin entries; unused entries are evicted first. |
| Catalog | Lightweight jobs/results/AOI metadata and logs are protected so navigation/history remain available. Payloads, model buffers and runtime handles are excluded from catalog accounting. |
| Drafts and writes | Active/private annotation collections, dirty/session drafts and queued write snapshots remain protected. Only a confirmed transaction allows an inactive durable draft/output to be released. |
| Session/unsaved outputs | Native output Blobs/raw predictions stay job-owned and protected until explicitly deleted or confirmed saved. Session chunk-spool bytes are counted separately from their small manifests. Exporting alone does not provide a reload source, so it does not silently evict session data. |
| Active image surfaces | Each displayed review/comparison image reserves an additional `width × height × 4` byte estimate. Hiding/removing the layer releases this reservation after removing the layer and revoking its URL. This is a decoded RGBA estimate, not a native browser/GPU allocation measurement. |
| Database artifacts | IndexedDB owns native PNG/TIFF/chunks, world files, drafts and reviews. Cache eviction never deletes these records. New results add logical artifact/vector size metadata without a schema migration or rewriting old data. |

The cap bounds evictable retained data and admission. It is deliberately **soft for protected data**: lowering the limit or creating an unsaved result may leave more protected bytes than the new limit. The panel reports the overage, preserves that data and pauses further browser clips/jobs. Increase the limit, close a comparison, release unused cache or cancel/export/delete a session job, then choose **Resume queue**. Already completed clips are skipped when resuming. A result too large to display reports a retryable limit error; its stored native files remain retrievable.

Processing/export canvases, transient database/JSON/native-decode work, models and browser rendering use additional memory. GMD-005/006/012/015 own processing admission and bounded writers; GMD-010 still owns model/session cache limits. Vector estimates describe retained GeoJSON, not the exact heap of Leaflet renderers or DOM nodes. Estimates include conservative object/string overhead and can overcount shared representations across separately owned scopes. They are not a total JavaScript heap, process RSS or GPU-memory cap. Existing browser/native pools may remain allocated after objects are released.

Review and comparison use `DB.clip(id, {images: "display", draft: false})`: read only the display PNG, or the original PNG when a legacy record has no display. They do not hydrate TIFFs, annotated JPEGs or native chunk payloads. PNG dimensions are validated and decoding/encoding obeys the existing working-allocation policy. Exports use the full native read path and keep their original bytes. Fresh annotation drafts/reviews are read independently of the immutable raw cache, so revisiting a warm clip cannot restore stale edits.

Ownership and terminal paths:

- A review view owns its cache lease and image-surface reservation. A hidden image releases its URL/surface while vectors and the active draft remain usable. Replacing/closing the view releases its payload lease.
- Each swipe side or timeline frame owns a cache/image lease. A timeline can retain current and incoming frames during loading/transitions; the outgoing frame releases on commit. Failed or obsolete preparation releases unadopted leases. Exit/page hide releases all comparison owners, image/vector/renderer resources and URLs.
- Clear unused cache removes only unpinned entries. Active views, drafts, unsaved outputs and stored records are preserved.
- Deletion is scoped to a terminal, non-exporting job. Its database transaction must succeed before views/cache/source payloads are invalidated. A failed deletion keeps the existing view usable and permits retry. Deleting under quota preserves other jobs' pending writes and independent saved training reviews. Late reads check view/job ownership and cannot recreate deleted data.
- Page hide clears unused cache and drains existing request/writer/view cleanup before closing the database. Dirty/session records remain protected and recover through the existing lifecycle rules.

The native probe reproduced a separate browser-side retention path: removing `src` from a detached Leaflet IMG created Chromium's broken-image shadow tree, retained through `MediaQueryMatcher → HTMLImageElement::ViewportChangeListener`. Cleanup now clears all four Leaflet DOM handlers and replaces the old source with a valid one-pixel data image before revoking the old URL. In the recorded 20-cycle fixture, detached-image inspection then found no images and settled DOM/listener growth was zero. This specific finding is separate from intentional cache retention and temporary decode/write peaks.

Verification:

```sh
npm test
python3 -m unittest discover -s tests -p test_model_assets.py -v
node tests/browser/allocation.cjs --memory --quiet --output docs/gmd-009-verification.json
node tests/browser/allocation.cjs --timeline --quiet
node tests/browser/persistence.cjs --lifecycle --queue-recovery
```

The memory probe seeds eight persisted legacy clips using real PNG/TIFF generation and fixed inference outputs, verifies a 512 px display under a 1 MiB retained budget, warm cache hits and LRU rereads, and independently compares native exported PNG/TIFF bytes and world coefficients. Five warmup cycles precede **20 measured submit/open/delete cycles**; unrelated jobs and a saved review must survive. Samples wait for transient toasts to expire, then collect garbage before recording JS heap/DOM/listener counts and, where available, summed browser/renderer/GPU RSS. The declared tiny-fixture JS-heap growth regression gate is **less than 5 MiB** over those 20 cycles. Owned leases/cache/surfaces/writers must reach zero after cleanup.

[Native evidence and source fingerprints](./gmd-009-verification.json) record actual counters and measurement limits. This finite deterministic fixture is not a production throughput, model-accuracy, physical-device or sustained GPU-memory benchmark. Large-history metadata, browser decoder pools and model caches remain separate measured follow-ups under GMD-010/GMD-020/GMD-021. Pages keeps its existing fresh ONNX export, cache key and unconditional validation; the offline memory probe is added to CI. Normal CI/deployed-source parity remains pending in [the tracker](./tasks.md).
