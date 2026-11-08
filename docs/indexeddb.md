# Device-local persistence (GMD-008)

The portal now saves browser AOIs, detection jobs, queues, clip results, review
drafts, saved training reviews, native image artifacts and imported model sources
in IndexedDB. The database is `geomap-detector`, schema version **1**.
GitHub Pages remains a static host. Data belongs to this browser profile and
origin; another device, profile or origin has a separate workspace.

The Detect panel reports **Saving**, **Saved on this device**, **Not saved**,
**Read only**, or **Session only**. Saved jobs appear in Results after reload.
Unfinished jobs wait for **Resume queue**; reopening the portal never silently
starts inference. Use **Download job zip** for a portable backup. Clearing site
data removes IndexedDB; browser-managed storage is not an external backup.

## Records and ownership

| Store | Owner and contents | Reads and removal |
| --- | --- | --- |
| `meta` | Schema/import journal and fenced writer lease | Import verification and writer checks; never contains model sessions |
| `aois` | UUID, full GeoJSON feature, active flag, display order | Active AOIs restore; removal archives the AOI without removing historical job snapshots |
| `jobs` | Immutable input snapshots, model/class metadata, release catalog, resolved plan, outcomes, progress and logs | Lightweight catalog; no Blobs, tensors, DOM nodes, promises or controllers |
| `queue` | Job ID, creation order and recoverable state | One browser execution slot; terminal jobs leave the queue |
| `results` | Job/clip/AOI identity, bounds, native dimensions, counts, coverage and output metadata | Indexed by job/AOI; no imagery or feature payloads in catalog reads |
| `predictions` | Immutable original FeatureCollection for one clip | Read by exact clip ID for viewing, comparison and export |
| `artifacts` | Clip/job/kind and native PNG, TIFF, preview Blob or world-file text | Queried by clip ID; deleting a job removes its artifacts |
| `drafts` | Editable FeatureCollection scoped to a clip, server clip, or `live` | Autosaved after review/class/delete/manual/finished geometry actions; distinct from raw predictions |
| `reviews` | Explicitly saved reviewed features, scope, job/AOI provenance and external Feature IDs | Indexed by scope/job/AOI; training/export queries collect saved reviews; job deletion keeps them |
| `models` / `weights` | Model metadata and recoverable imported ONNX Blob, keyed by durable import UUID | Metadata restores without reading weights; bytes load when a custom job runs; job deletion keeps user model sources |

AOIs carry a reserved top-level `_gmd_id`; original Feature IDs, names and unknown
feature properties remain intact. Deduplication ignores only that managed ID.
Job-scoped clip IDs keep results/reviews from different models separate even
when legacy prediction IDs match. Review provenance uses `gmd_clip_id`,
`gmd_job_id` and `gmd_aoi_id`. Original predictions and native raster resolution
are unchanged. ZIP entries retain old paths when unique and receive a clip
suffix for collisions; `summary.json` records the actual paths and clip IDs.

The app retains result metadata and the active draft/display payload. After a
clip transaction commits, inactive PNG/TIFF/prediction references can be released.
The normal map view owns at most one image URL. GMD-004 releases that lease on
hiding and creates a fresh URL from the retained active Blob when showing it
again; vectors, selection and editing stay intact. Replacement/page hide/deletion
use the full view disposer. Comparison keeps its existing
per-pair bitmap/canvas/URL cleanup. Download URLs keep their existing timed
cleanup. The engine still owns and releases processing canvases, decoded bitmaps,
requests and abort listeners; IndexedDB does not persist these resources.
Model-session cache limits and full application disposal remain separate tasks.

GMD-004 keeps dirty/session drafts outside the disposable view, including server
clips in session mode. Clean inactive persisted drafts release after confirmed
writes. Each view owns its request controller, deadline and map handles; late
IndexedDB reads are consumed without committing their data to a retired view.
Vertex edits are captured before replacement/unload at full coordinate precision.
`GVApp.diagnostics()` reports current/cumulative view and image leases, ignored
late reads, selected/edit handles, retained/dirty draft counts and separate
download leases. These counters do not measure total JS/native/GPU memory.
Result/comparison catalogs strip direct prediction/draft/Blob payload fields;
the active view alone may attach display data to its row, removed on disposal.
Diagnostics report these direct row payload counts separately from job/draft
ownership; they are not byte totals.

## Commit, migration and recovery contract

1. Submission saves the recoverable model source and frozen job/queue record
   before entering inference. Waiting jobs create no raster or ORT session.
2. The resolved AOI/date plan is checkpointed with stable clip IDs. Each completed
   clip commits metadata, raw predictions, all native artifacts and its job
   outcome in one transaction. Request success alone does not indicate success;
   the repository resolves writes on transaction completion.
3. Restore reads catalogs without loading image/weight/prediction payloads. A
   stored running/cancelling job becomes interrupted. Resume follows the saved
   plan and skips committed outcomes; an in-flight uncommitted clip runs again.
4. `gv_aois` and `gv_ann` import once. The import transaction records a journal;
   read-back compares full feature contents, identities and counts before marking
   migration verified. Interrupting either phase allows an idempotent retry.
   The original localStorage values remain untouched as backups. Small preferences
   continue to use localStorage. Unavailable/malformed legacy data is never
   silently replaced with an empty successful import.
5. Legacy reviews with ambiguous rank/model associations stay available in
   training/GeoJSON exports. They are not automatically applied to new model
   runs. New drafts take precedence over older saved reviews when reopening a
   clip. Deleting a reviewed object and saving also updates the saved clip scope.
6. A Web Lock grants one document permission to edit/run this workspace. A second
   document can browse, but cannot mutate records or submit jobs. Without Web
   Locks, a renewable 30-second transactional lease fences every write. A stale
   tab cannot overwrite a newer owner's records. This fallback protects records;
   it is not a guarantee against briefly overlapping native inference in a frozen
   old tab. Ownership loss aborts that tab's runner. Closing the other document
   and reloading reacquires ownership; takeover is not automatic.
7. Page hide suspends durable work and aborts/drains the active runner. Recovery
   depends on earlier commits, not a final unload write. Back/forward recovery
   waits for the same shutdown promise before reopening the connection. Each
   repository owns its heartbeat, connection and lock; version changes close the
   connection and require reload. Unsupported newer schemas are preserved.

If IndexedDB is disabled, the map and session processing/export still work with
an explicit **Session only** message. A write/quota failure keeps the output and
pending writes in memory, pauses scheduling, and exposes **Retry saving**.
Unconfirmed data is not evicted. Before-unload protection includes pending writes,
dirty drafts and uncommitted jobs/results. **Delete job** can free old artifacts
while quota blocks ordinary writes; only an explicitly deleted job's pending
records are discarded. Saved training reviews and custom model sources survive.
Review-only edits during an outage still need retry/export before closing.

## Compatibility and the future server adapter

`GVStorage.create()` in `frontend/storage.js` exposes asynchronous record methods:
`open`, `migrate`, `restore`, `saveAois`, `saveModel`, `saveJob`, `saveClip`, `clip`,
`saveDraft`, `draft`, `saveReviews`, `reviews`, `deleteJob`, `model`, and `close`.
The UI uses this boundary rather than issuing IndexedDB requests directly.
Transaction callbacks enqueue database operations synchronously or from request
callbacks, without awaiting unrelated work inside an active transaction. See
[IndexedDB transaction guidance](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB).

A future adapter can implement this contract over an authenticated HTTPS API
backed by PostgreSQL and object storage. Server schema, synchronization, conflict
resolution, authentication and browser-to-server import are future work. The
optional existing Python API still owns its jobs/output files; its review drafts
and locally saved reviews use the new device repository. Existing API responses,
GeoJSON/CSV/training exports, WebGPU/WASM settings, resolution, overlap, precision
and suppression remain compatible. No direct PostgreSQL connection is exposed
to a static page.

## Verification and remaining work

- `npm ci --ignore-scripts` then `npm test`: existing regressions plus transaction
  rollback, two-phase migration interruption, reopen/recovery, lazy reads, scoped
  reviews, custom-weight recovery, quota retry, FIFO resume and page lifecycle.
- `node tests/browser/persistence.cjs --lifecycle`: native Chromium IndexedDB, real Leaflet
  and ZIP, deterministic 32 × 16 raster fixtures; network-independent. Checks
  reloads, paused recovery, untouched raw predictions, drafts, native artifact
  bytes/dimensions/georeferencing, colliding ZIP paths, object URL replacement,
  cross-document ownership, disabled storage, aborted upgrades and newer schemas.
  GMD-004 adds lazy real Leaflet.Draw, an actual vertex drag interrupted by a
  switch, twenty view/toggle cycles, obsolete map-listener checks, delayed reads
  and scoped UI deletion. [Lifecycle evidence](./gmd-004-verification.json).
  Pages CI runs this check before the unchanged model export/cache/check flow.
- `node --use-system-ca tests/browser/queue.cjs` and `--wasm`: actual nano/small
  models, saved outputs, native exports, comparison, one-slot processing and
  existing canvas/bitmap cleanup. Map interaction/pointer tests use scoped review
  fixtures rather than writing new annotations to an already migrated backup.
- [Recorded native verification](./gmd-008-verification.json) identifies source
  hashes and the limits of its measurements. Tiny-fixture commit/startup timings
  are diagnostics, not a production performance baseline or leak benchmark.

GMD-009 still needs byte-budgeted caches and a smaller unannotated display image;
GMD-010 still needs bounded ORT sessions; GMD-015 still needs bounded export
writers (JSZip retains archive inputs); GMD-016 still needs the broader prediction
identity/legacy-resolution/backend contract. Large migrations and exports can
produce temporary memory spikes. GMD-021 should measure repeated real DXB jobs,
opening/closing/comparing/deleting clips, quota pressure and smaller devices,
separating encoded bytes, decoded/native/GPU memory, JS heap and long-task latency.
Firefox/Safari, real browser eviction, power-loss durability and production-scale
quota/performance remain verification work. Keep unrelated task statuses intact.
