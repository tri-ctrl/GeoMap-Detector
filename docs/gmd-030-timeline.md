GMD-030 — Created ordering and AOI history

In Results, choose **View → Compare results** to see all available clips with the newest creation time first. **Date** is the imagery release date; **Created ↓ (UTC)** is the detection clip's completion/creation time. These dates serve different purposes. New browser results save `createdAt` with their existing result transaction. Older clips fall back to the parent job's saved creation time. When neither exists, the row shows **Unknown** after all known timestamps, with deterministic job/index ties. No timestamp is inferred from a job ID, last edit or imagery date.

To explore a story of one AOI:

1. Choose **View → Timeline · AOI history**.
2. Check the results to include, or check one result and use **Select this AOI's history**. Checkboxes for other AOI geometries become disabled until the selection is cleared. Select at least two different imagery dates.
3. Choose **Open timeline**. The map fits the AOI once and shows the earliest selected imagery date, with its original model predictions.
4. Use the player at the **bottom center of the map**: drag the slider, use the previous/next buttons or press **Play**. Frames follow imagery date from oldest to newest. The native slider also supports arrow keys, Home and End. Playback stops at the latest frame; **Replay** starts again.
5. Use **Back to review**, change View or leave Results to restore the previous review clip, viewport and annotation editor.

Each frame displays its imagery date, model, AOI and object total. Different runs on the same date stay separate, ordered by creation time within that date. Mixed model/settings selections are allowed with a visible difference notice. Counts are predictions; differences do not establish actual object changes or model accuracy. Incomplete imagery remains identified in the table and settings notice. Comparison covers the saved clip's extent; the underlying map outside the AOI retains its viewed release.

Choose **Settings** on the map player to set a 1, 2 or 4 second **Frame pause**, a **Fade**, **Wipe** or **Instant** layer transition, and a **200, 450 or 900 ms** transition duration. Frame pause starts after image loading and transition completion. The sample-layer preview demonstrates the chosen effect without reading/changing result images. Opening Settings pauses playback; Escape closes Settings first. Preferences are validated and saved locally across reloads. Reduced-motion preferences use instant changes; browsers without animation support also replace frames instantly.

Both imagery and detection vectors share the transition and retain their original coordinates. Map movement completes any active transition immediately so layers stay aligned. The first fit leaves room for the player; later frame changes preserve pan/zoom. Settings are centered above the player and scroll inside the available map space on small screens. The usual imagery HUD is replaced by the player's date/model/count label while Timeline is selected.

The timeline is read-only. It uses immutable raw predictions, not the reviewed annotation draft. Selecting a different history clears the current playback and requires Open timeline again. The selected timeline itself is transient; all existing AOIs, results, reviews, images, model sources and job queues remain in their existing storage. There is no schema migration or record rewrite. Playback preferences use a separate `gv_timelinePlayback` preference record and do not alter job/model settings.

Ownership and limits:

| Resource | Owner and cleanup |
| --- | --- |
| Catalog and selected frames | Metadata/identities only in the comparison controller; released on exit. Durable catalogs do not read prediction/image artifacts until a selected frame is opened. |
| Artifact reads and previews | One serialized frame operation. Rapid seeks coalesce for 80 ms; replacements abort the previous request and drain uncancellable reads/decodes. Preview canvases and bitmaps use the existing allocation policy and `finally` cleanup. Source images/exports retain native resolution. |
| Image/vector layers and URLs | The timeline renderer owns one image, vector group and SVG renderer per frame. It retains the displayed and incoming frames together during loading/transition, at most two; completion releases the outgoing frame and leaves one. Failure keeps the previous displayed frame. Two empty timeline panes are intentionally reused, separately from the swipe comparison's two panes. Exit removes active layers/URLs/listeners. |
| Requests, animations and timers | The catalog owns its AbortController; each frame owns a 45 second deadline and controller. The renderer bounds image loading to 15 seconds. Its two transition animations and duration+100 ms fallback are cancelled/released on completion/replacement/stop. The separate sample owns two animations and its own fallback timer. Closing Settings, visibility loss, exit and page hide cancel the sample. Playback/seek timers clear on pause, selection, exit, tab navigation and page hide. Page hide drains frame work before closing IndexedDB. |
| Reviews and persisted records | Existing view/draft and storage owners retain them. Playback does not write/delete records, acquire model sessions, perform inference or start workers. Job deletion uses the existing scoped deletion flow and exits comparison first. |

A failed frame pauses playback and reports a retry action. A failed artifact read, preview or incoming DOM image keeps the previous displayed frame intact; select/reopen a frame to retry, or return to review. Late responses cannot take over a newer frame or a closed comparison. Actual native decodes/IndexedDB transactions may finish after cancellation; cleanup waits for them rather than releasing their ownership early.

Verification commands:

```sh
npm test
python3 -m unittest discover -s tests -p test_model_assets.py -v
node tests/browser/allocation.cjs --timeline --quiet --output docs/gmd-031-verification.json
node tests/browser/persistence.cjs --lifecycle --queue-recovery
```

The native timeline probe uses synthetic saved PNGs/predictions across two models and three dates. It verifies descending creation order independently of imagery order, six-frame chronological playback, immutable feature/date and PNG pixel identity, slider/keyboard seeks, preserved zoom, 390 px layout and repeated cleanup. It also measures bottom-center placement, settings bounds, real Fade/Wipe animations, sample isolation, Instant/reduced-motion paths and exit during an active transition. [GMD-031 counters/source fingerprints](./gmd-031-verification.json) extend [the original GMD-030 record](./gmd-030-verification.json). These are local checks, not deployed evidence, detection quality, total process/GPU memory or a confirmed general leak fix. Pages keeps this offline probe alongside its existing fresh ONNX export, model cache and unconditional validation. Normal CI, deployed parity, Safari/Firefox and physical phone checks remain release follow-ups in [the tracker](./tasks.md).
