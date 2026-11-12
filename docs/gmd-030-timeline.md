GMD-030 — Created ordering and AOI history

In Results, choose **View → Compare results** to see all available clips with the newest creation time first. **Date** is the imagery release date; **Created ↓ (UTC)** is the detection clip's completion/creation time. These dates serve different purposes. New browser results save `createdAt` with their existing result transaction. Older clips fall back to the parent job's saved creation time. When neither exists, the row shows **Unknown** after all known timestamps, with deterministic job/index ties. No timestamp is inferred from a job ID, last edit or imagery date.

To explore a story of one AOI:

1. Choose **View → Timeline · AOI history**.
2. Check the results to include, or check one result and use **Select this AOI's history**. Checkboxes for other AOI geometries become disabled until the selection is cleared. Select at least two different imagery dates.
3. Choose **Open timeline**. The map fits the AOI once and shows the earliest selected imagery date, with its original model predictions.
4. Drag the slider, use the previous/next buttons or press **Play**. Frames follow imagery date from oldest to newest. The native slider also supports arrow keys, Home and End. Choose a 1, 2 or 4 second pause between loaded frames. Playback stops at the latest frame; **Replay** starts again.
5. Use **Back to review**, change View or leave Results to restore the previous review clip, viewport and annotation editor.

Each frame displays its imagery date, model, AOI and object total. Different runs on the same date stay separate, ordered by creation time within that date. Mixed model/settings selections are allowed with a visible difference notice. Counts are predictions; differences do not establish actual object changes or model accuracy. Incomplete imagery remains identified in the table and settings notice. Comparison covers the saved clip's extent; the underlying map outside the AOI retains its viewed release.

The timeline is read-only. It uses immutable raw predictions, not the reviewed annotation draft. Selecting a different history clears the current playback and requires Open timeline again. The selected timeline itself is transient; all existing AOIs, results, reviews, images, model sources and job queues remain in their existing storage. There is no schema migration or record rewrite.

Ownership and limits:

| Resource | Owner and cleanup |
| --- | --- |
| Catalog and selected frames | Metadata/identities only in the comparison controller; released on exit. Durable catalogs do not read prediction/image artifacts until a selected frame is opened. |
| Artifact reads and previews | One serialized frame operation. Rapid seeks coalesce for 80 ms; replacements abort the previous request and drain uncancellable reads/decodes. Preview canvases and bitmaps use the existing allocation policy and `finally` cleanup. Source images/exports retain native resolution. |
| Image/vector layers and URLs | The existing comparison renderer owns one image, one vector group and its SVG renderer per frame. Replacing a frame removes previous layers/listeners and revokes its URL. Two empty map panes are intentionally reused. Exit removes all active layers/URLs; page hide destroys handle listeners as well. |
| Requests and timers | The catalog owns its AbortController; each frame owns a 45 second deadline and controller. The renderer bounds image loading to 15 seconds. Playback/seek timers clear on pause, selection, exit, tab navigation and page hide; hidden documents pause playback. Page hide drains frame work before closing IndexedDB. |
| Reviews and persisted records | Existing view/draft and storage owners retain them. Playback does not write/delete records, acquire model sessions, perform inference or start workers. Job deletion uses the existing scoped deletion flow and exits comparison first. |

A failed frame pauses playback and reports a retry action. A failed artifact read or preview leaves the last displayed frame intact. A DOM image-load failure can remove the pending overlay; select/reopen a frame to retry, or return to review. Late responses cannot take over a newer frame or a closed comparison. Actual native decodes/IndexedDB transactions may finish after cancellation; cleanup waits for them rather than releasing their ownership early.

Verification commands:

```sh
npm test
python3 -m unittest discover -s tests -p test_model_assets.py -v
node tests/browser/allocation.cjs --timeline --quiet --output docs/gmd-030-verification.json
node tests/browser/persistence.cjs --lifecycle --queue-recovery
```

The native timeline probe uses synthetic saved PNGs/predictions across two models and three dates. It verifies descending creation order independently of imagery order, six-frame chronological playback, immutable feature/date and PNG pixel identity, slider/keyboard seeks, preserved zoom, 390 px layout and repeated cleanup. [Recorded counters and source fingerprints](./gmd-030-verification.json) describe local source checks, not deployed evidence, detection quality, total process/GPU memory or a confirmed general leak fix. CI adds this offline probe while preserving Pages' existing fresh ONNX export, model cache and unconditional validation. Normal CI, deployed parity, Safari/Firefox and physical phone checks remain release follow-ups in [the tracker](./tasks.md).
