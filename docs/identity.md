GMD-016 identity and compatibility contract

New records use identity version 1. Names and imported Feature IDs remain display/business data; `aoi_id` remains the legacy sanitized name for compatible consumers. Use `gmd_aoi_id`, job/clip identifiers and prediction IDs for joins.

| Entity | Identity and lifetime |
| --- | --- |
| AOI | Managed `_gmd_id`, normally a UUID. Rename preserves it. Exact external-content deduplication precedes ID assignment and ignores managed aliases/property ordering. Distinct polygons or external metadata remain distinct. Duplicate managed IDs on distinct imports are repaired with the prior value in `_gmd_aliases`. Imported business IDs and unknown fields survive, including expanded point/collection features. |
| Job | Existing dated browser/server prefixes with a complete UUID suffix. Captured settings, AOIs and model sources remain frozen for the run. Existing saved job IDs are opaque and unchanged. |
| Clip | `gmd:c1:<SHA-256 of job/AOI/release/model tuple>`. The model component uses actual downloaded ONNX/checkpoint bytes when available; imagery-only runs use `imagery`. Existing queued plans retain their original clip IDs when resumed. |
| Prediction | `gmd:p1:<clip namespace>:<class/original geometry digest>:<duplicate occurrence>`. Confidence/rank do not participate. Ring rotation/direction is normalized for the key; exported coordinates stay unchanged. Identical duplicate predictions receive separate IDs and remain ambiguous for legacy matching. Editing never recomputes a persisted ID. |
| Manual object | Independent UUID with captured clip/live-map scope. |
| Review | Exact clip scope plus immutable Feature ID. Physical new review keys also use that identity rather than list order. Unscoped legacy IDs cannot authorize an automatic merge. |

The fields `gmd_identity_version`, `gmd_job_id`, `gmd_clip_id`, `gmd_aoi_id`, `gmd_model_id`, `gmd_model_key` and `gmd_prediction_id` provide provenance. New prediction properties retain former rank-based IDs in `gmd_legacy_ids`; these are aliases, never permission to transfer a review to another run.

SHA-256 uses Web Crypto on normal HTTPS GitHub Pages and workers. Without that API, small identity keys use a collision-free encoded content string rather than a truncated hash. Unavailable model byte hashes remain unknown/source-labelled. The original model bytes are not retained a second time for fingerprinting. Anonymous direct engine calls receive a session scope and a captured-feature key; durable application AOIs already carry managed IDs. Future SQL adapters should treat historical/namespaced keys as opaque strings rather than requiring every existing key to be a UUID column.

Compatibility and migration

No IndexedDB version upgrade or bulk prediction/image rewrite is required; schema version 2 remains readable. Existing AOIs, job plans, clip IDs, predictions, drafts, review scopes and artifact descriptors retain their stored values. Committing different predictions over an existing clip is rejected atomically. A new run creates a new namespace.

The existing `legacy-v1` import journal/read-back verification still protects the localStorage backup. New explicit review links use additive `meta` records named `identity:legacy:<legacy row key>` with source ID, target scope/ID and linked/verified timestamps. Draft, scoped review and link journal commit atomically under the existing writer fence. Read-back verifies the target before marking the link verified. Retrying the same link is idempotent, including interruption between commit and verification. Reassigning an existing link to another object is rejected.

Original legacy rows are never deleted by linking. Verified originals are excluded from the combined training view because their linked review replaces them; **Export originals** includes the untouched source features and resolution journal. Job deletion retains saved training reviews and this audit history. These are owned user records, not disposable caches.

Existing v2 review rows already scoped by IndexedDB can be adapted on read without rewriting their source. Optional-server annotations likewise merge only when their explicit clip scope matches. Legacy server result paths continue to work through the existing `server:<job>:<path>` scope; new server results expose their clip ID directly. No rank-based cross-job/model merge is performed.

Recovering a legacy review

1. Open a saved browser clip and select its prediction on the map.
2. In Annotate, expand **Recover legacy reviews**, choose **Load reviews**, and select the source record. **Next 100** pages through the remaining records.
3. Choose **Link to selected object**. Release, known AOI/job/model provenance and a unique original shape must match. A class-only correction can be linked; a changed legacy polygon without its original geometry remains unresolved and exportable.

The action saves the recovered draft/training review immediately. It does not refit or cover the map. An invalid match reports its reason without pausing jobs or making storage read-only. Linking requires writable IndexedDB; session-only originals remain downloadable. The recovery panel handles the local legacy collection; old optional-server collections remain available from `/api/annotations` and the server backup. Unknown historical provenance is preserved rather than inferred.

Exports and the optional backend

Browser ZIP roots/human-readable paths retain the existing collision handling. Both ZIP writers add `identity_schema`, per-clip identity and `legacy_path` to summaries; CSV appends provenance columns. Native image dimensions, pixels, EPSG/world files and existing GeoJSON fields retain their contracts.

New backend folders combine the readable AOI slug with its managed-ID digest and a release/clip digest. Colliding names and repeated dates cannot overwrite another clip. New summaries carry the identity and old readable path as an alias; previously published output directories and ZIPs are not moved or rewritten. Aliases can be ambiguous and are not used as lookup keys.

Backend annotation upsert keys include explicit clip scope. Conflicting/unscoped legacy IDs and unknown top-level fields remain present. The first write retains `annotations.legacy-v1.geojson`; updates use a same-directory temporary file, flush/fsync, atomic replace and read-back verification. Temporary files are removed after failure. A process-local lock serializes these writes; multi-process coordination and broader backend resource limits remain GMD-019.

Backend model fingerprints are captured with the loaded cache entry. Replacing a checkpoint filename later does not relabel an already loaded model with the replacement file's digest; model cache invalidation remains a separate policy.

Ownership, observability and checks

The recovery panel owns its operation/controller and one page of at most 100 vector records. Retained bytes count against the existing result-memory budget. Closing the panel/tab releases rows and read wrappers; an authorized atomic link is allowed to finish when the panel closes. Page hide cancels its UI work and aborts an uncommitted linking transaction; storage shutdown drains queued writes. If cancellation occurs after a commit, the unverified journal remains retryable. Every transaction abort listener is removed on completion/abort. Read-only IndexedDB reads cannot be individually cancelled; late results are consumed and ignored. A page-count bound does not prevent a temporary spike from an unusually large individual legacy feature.

Legacy exports use the existing delayed object-URL/download lease owner and a temporary memory reservation. This task creates no map canvas, bitmap, image URL, worker or model session for review recovery. Existing processing/model owners retain those resources. `GVApp.diagnostics().identity` reports retained rows and active linking/operations; engine diagnostics expose pending reads/requests and `timings.identityMs` separates prediction identity work from detection/encoding.

Run `npm test`, `python3 -m unittest discover -s tests -p 'test_*.py' -v`, and `node tests/browser/persistence.cjs --lifecycle --queue-recovery --identity`. Pages CI includes all three. Native worker and bounded-output probes compare full prediction/provenance records using the same captured job/clip in both processing contexts; pixel, input-hash and suppression assertions remain exact. `worker-runtime.cjs` checks real nano/small WebGPU/WASM paths separately. Current results/source hashes are in [GMD-016 verification](./gmd-016-verification.json).

No resolution, overlap, precision, confidence or suppression default changed. Ownership counters establish cleanup, not a sustained native/GPU memory-leak fix. Extra hashing and provenance strings have a cost; no throughput or startup speedup is claimed. CI/deployed parity and actual optional-backend ML/provider execution remain separate release checks.
