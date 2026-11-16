# Esri basemaps, 3D and coordinate CRS

Open **Map settings** at the top right of the map. The controls use the existing
theme and stay over the map at desktop and mobile widths.

The Esri equivalent of the supplied Google satellite tile is:

```text
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

For example, Google's `x=32&y=53&z=7` corresponds to Esri's
[`tile/7/53/32`](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/7/53/32).
The ordering matters: Esri uses zoom, row, column.

Choose **Wayback**, **Esri satellite · latest**, **topographic**, **streets** or
**dark gray**. Satellite/topographic/street/dark services currently advertise
levels 0–23; Wayback retains its existing display policy. The live satellite
service is a mosaic whose acquisition dates vary by location. It is not a
specific historical release or a promise of imagery captured today.

Basemaps control the background display. Detection jobs retain their captured
Wayback dates and processing settings. Opening a dated result or clicking an
Imagery release restores its Wayback background. Switching basemaps preserves
viewport, selected processing dates, AOIs, review data and annotations. The same
Leaflet tile layer is reused, with its URL, native level and attribution updated.
A saved live basemap starts immediately even while Wayback metadata is pending.

## 3D exploration

Use **3D** to explore AOIs, detections and the active clipped image on a globe.
Drag to navigate, right-drag to tilt, and scroll to zoom. Clicking a detection
opens the existing annotation details; detection picking takes priority over a
covering AOI. **Edit shape**, drawing and comparison return to the 2D editor.
Merely viewing/selecting an object preserves the original 2D center and zoom.
Actual 3D navigation transfers its target and approximate scale back to 2D.

The default surface is the WGS 84 ellipsoid. **Esri World Elevation 3D** loads
terrain on request. Failed metadata or availability requests leave a usable
ellipsoid globe, report the failure, and reset the surface selector for retry.
The live probe samples a real terrain height; it does not infer height from
detected objects. Detection geometries remain footprints without invented object
heights. Basemap credits remain visible and available through the viewer.

Cesium **1.147.0** and its CSS/worker assets load only when 3D is requested.
The 2D map stays visible during loading. Unsupported workers/WebGL, failed
downloads, cancelled opening or a renderer error preserve the 2D workspace.
Returning to 2D or hiding the page destroys the viewer, canvas, event handlers,
imagery layers and owned URLs. A later request creates a fresh viewer. The
downloaded library and its reusable task-processor worker pools are page-owned
runtime retention; they are not per-view canvases or proof of a leak.

The globe uses request-render mode, a 64-tile cache target (visible tiles can exceed it) and an explicit
3D vector limit of 10,000 features / 200,000 vertices. Larger scenes return to
2D instead of silently omitting objects. Display-image RGBA estimates and
additional vector estimates share the existing retained-result admission budget.
Old and replacement vectors have separate reservations during replacement.
Logical estimates do not bound physical browser/GPU memory or guarantee dense
scene frame rates; constrained-device profiling remains GMD-021 work.

## Coordinate CRS scope

**Coordinate CRS** formats pointer coordinates in either view:

- WGS 84 / EPSG:4326: latitude and longitude in degrees.
- Web Mercator / EPSG:3857: easting and northing in metres, within Mercator coverage.
- Automatic UTM: WGS 84 northern/southern EPSG zone, including Norway/Svalbard exceptions.
- Explicit WGS 84 / UTM 39N, 40N (UAE) and 41N.

Proj4 **2.22.0** loads only for UTM. The readout identifies the effective EPSG
code and zone. Polar points or points too far from an explicit UTM region get an
explicit coverage message instead of misleading coordinates. Definitions use
WGS 84, without an implicit conversion to a regional datum.

This control changes coordinate **readouts**, not the 2D map projection. The
2D tile grid remains EPSG:3857. GeoJSON/IndexedDB geometry remains WGS 84; PNG
world files and GeoTIFFs retain their original Mercator transform/CRS. Existing
saved records require no migration. Full 2D reprojection is a separate choice
raised with the user: it also requires reprojection of cached basemap pixels,
clipped images, comparisons and editor transforms. Relabelling a tile map as UTM
would not provide that behavior. The UI states this distinction explicitly.

## Ownership and verification

| Resource | Owner and cleanup |
| --- | --- |
| Leaflet map/tile layer | Existing page owner; provider switches reuse the layer without replacing AOIs, detections or editor state. |
| Cesium library/CSS/task pools | Shared lazy page loader; failed scripts/styles can retry. No default map-only download. |
| 3D viewer/GL canvas/input handlers | One scene owner; generation checks reject stale openings. Exit/page hide removes listeners and destroys the viewer. Failed construction removes partial DOM. |
| 3D image URL/layer | Scene owns a separate URL and decoded-surface estimate. Remove the imagery layer before revoking/releasing it. The page clip retains its independent display lease. |
| 3D vectors | Scene owns additional geometry estimates. Admission precedes creation; replacements/exit release old reservations. No saved feature is deleted to fit the view. |
| Elevation metadata/availability | An owned abort controller and request deadlines survive Cesium's derived JSON resources. Retired availability probes settle without an unhandled rejection or mutating another scene. Cesium owns terrain tile buffers and its tile scheduler. |
| Persisted entities/exports/model jobs | Existing owners and schemas; this display feature does not rewrite or delete them. |

`GVApp.diagnostics().mapDisplay` reports the display provider, mode, coordinate
CRS, actual 2D projection and scene creation/destruction, image URLs, frames,
entities, loading and terrain state. Result-memory diagnostics include the
protected 3D vector/image reservations. Counters describe ownership, not total
native/GPU usage.

Run:

```sh
npm ci --ignore-scripts
npm test
node tests/browser/allocation.cjs --scene
# Optional live service + real elevation sample:
node tests/browser/allocation.cjs --scene --live-esri
```

The offline native probe uses real Cesium, Proj4, Leaflet, WebGL2 and processing
workers with fixed imagery/predictions. It tests picking, Mercator image
projection, image toggles, UTM, failed terrain, exact return to editing, repeated
viewer teardown, mobile bounds and page hide. The live probe additionally uses
actual Esri imagery/elevation requests. Neither is a detector-accuracy benchmark.
[Measurements](./gmd-032-034-verification.json) retain source fingerprints and
test conditions. Normal CI/deployed-source parity, Firefox/Safari, physical
mobile GPU/thermal behavior and dense scenes remain release/profiling checks.

The new script is included in the Pages source guard and the native scene probe
runs in `pages.yml`. The existing `export_onnx.py`, model cache key and fresh/cache
validation steps are preserved.

References: [Esri World Imagery service](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer),
[Cesium URL-template imagery](https://cesium.com/learn/cesiumjs/ref-doc/UrlTemplateImageryProvider.html),
[Esri terrain provider](https://cesium.com/learn/cesiumjs/ref-doc/ArcGISTiledElevationTerrainProvider.html),
[Leaflet CRS definitions](https://leafletjs.com/reference.html#crs).
