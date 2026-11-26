/* Esri display basemaps, coordinate readouts and an opt-in 3D globe.
 * Geographic records stay WGS84; the detection/export pipeline owns its CRS.
 */
(function (global) {
"use strict";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const CREDIT = "Esri, Vantor, Earthstar Geographics, GIS User Community";
const BASEMAPS = Object.freeze([
  { id: "wayback", label: "Esri Wayback · selected date", credit: "Esri World Imagery Wayback · " + CREDIT, maxLevel: 19 },
  { id: "imagery", label: "Esri satellite · latest", service: "World_Imagery", credit: CREDIT, maxLevel: 23 },
  { id: "topographic", label: "Esri topographic", service: "World_Topo_Map", credit: "Esri, HERE, Garmin, USGS, OpenStreetMap contributors", maxLevel: 23 },
  { id: "streets", label: "Esri streets", service: "World_Street_Map", credit: "Esri, HERE, Garmin, OpenStreetMap contributors", maxLevel: 23 },
  { id: "dark", label: "Esri dark gray", service: "Canvas/World_Dark_Gray_Base", credit: "Esri, HERE, Garmin, OpenStreetMap contributors", maxLevel: 23 },
]);
const CESIUM_BASE = "https://cdn.jsdelivr.net/npm/cesium@1.147.0/Build/Cesium/";
const TERRAIN = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
// File geometry has its own identities and never becomes AOI/detection state.
function fileGeometries(geometry, output = []) {
  if (!geometry) return output;
  if (geometry.type === "GeometryCollection") geometry.geometries.forEach(g => fileGeometries(g, output));
  else if (geometry.type.startsWith("Multi")) geometry.coordinates.forEach(coordinates => output.push({ type: geometry.type.slice(5), coordinates }));
  else output.push(geometry);
  return output;
}
function fileVectorSize(fc) {
  let vertices = 0;
  const visit = coordinates => { if (typeof coordinates[0] === "number") vertices++; else coordinates.forEach(visit); };
  for (const feature of fc.features || []) for (const geometry of fileGeometries(feature.geometry)) visit(geometry.coordinates);
  return { features: (fc.features || []).length, vertices };
}
function fileEntities(C, layer) {
  const result = [], color = C.Color.fromCssColorString(layer.color || "#20b5cd").withAlpha(layer.opacity ?? 1);
  const positions = coordinates => C.Cartesian3.fromDegreesArray(coordinates.flatMap(point => point.slice(0, 2)));
  for (const [index, feature] of layer.fc.features.entries()) for (const [part, geometry] of fileGeometries(feature.geometry).entries()) {
    const record = { id: `file:${layer.id}:${index}:${part}`, name: String(feature.properties?.name || layer.name), properties: { kind: "file", layerId: layer.id, index } };
    if (geometry.type === "Point") {
      record.position = C.Cartesian3.fromDegrees(...geometry.coordinates.slice(0, 2));
      record.point = { pixelSize: 7, color, outlineColor: C.Color.WHITE, outlineWidth: 1, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Infinity };
    } else if (geometry.type === "LineString") record.polyline = { positions: positions(geometry.coordinates), width: 2.5, material: color, clampToGround: true };
    else if (geometry.type === "Polygon") {
      const rings = geometry.coordinates;
      record.polygon = { hierarchy: new C.PolygonHierarchy(positions(rings[0]), rings.slice(1).map(ring => new C.PolygonHierarchy(positions(ring)))), material: color.withAlpha((layer.opacity ?? 1) * .35), zIndex: 20 };
      record.polyline = { positions: positions(rings[0]), width: 2, material: color, clampToGround: true };
    } else throw new Error("Unsupported layer geometry: " + geometry.type);
    result.push(record);
  }
  return result;
}
function basemap(id, release, waybackURL) {
  const item = BASEMAPS.find(entry => entry.id === id) || BASEMAPS[0];
  if (item.id === "wayback" && !release) return null;
  return { ...item, key: item.id === "wayback" ? "wayback:" + release.release : item.id,
    label: item.id === "wayback" ? "Wayback · " + release.date : item.label,
    url: item.id === "wayback" ? waybackURL(release.release, "{z}", "{y}", "{x}") : ESRI + item.service + "/MapServer/tile/{z}/{y}/{x}" };
}
const COORDINATES = Object.freeze([
  { id: "EPSG:4326", label: "WGS 84 · latitude, longitude" },
  { id: "EPSG:3857", label: "Web Mercator · metres" },
  { id: "UTM", label: "WGS 84 / UTM · automatic zone" },
  { id: "EPSG:32639", label: "WGS 84 / UTM 39N" },
  { id: "EPSG:32640", label: "WGS 84 / UTM 40N · UAE" },
  { id: "EPSG:32641", label: "WGS 84 / UTM 41N" },
]);
function coordinates(point, id = "EPSG:4326") {
  const { lng, lat } = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error("Invalid geographic coordinates");
  if (!COORDINATES.some(item => item.id === id)) throw new Error("Unsupported coordinate CRS");
  if (id === "EPSG:4326") return { code: id, x: lng, y: lat, text: lat.toFixed(5) + ", " + lng.toFixed(5) };
  if (id === "EPSG:3857") {
    if (Math.abs(lat) > 85.0511287798) return { code: id, text: "Outside Web Mercator coverage" };
    const [x, y] = global.GVEngine.merc(lng, lat);
    return { code: id, x, y, text: `E ${x.toFixed(2)} · N ${y.toFixed(2)} m` };
  }
  if (lat < -80 || lat > 84) return { code: id, text: "Outside UTM coverage (80°S–84°N)" };
  let zone;
  if (id === "UTM") {
    zone = Math.min(60, Math.floor((lng + 180) / 6) + 1);
    if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) zone = 32;
    if (lat >= 72 && lat < 84 && lng >= 0 && lng < 42) zone = lng < 9 ? 31 : lng < 21 ? 33 : lng < 33 ? 35 : 37;
  } else zone = Number(id.slice(-2));
  const south = id === "UTM" && lat < 0, code = "EPSG:" + ((south ? 32700 : 32600) + zone);
  if (Math.abs(lng - (zone * 6 - 183)) > 9 || (!south && lat < 0)) return { code, text: "Outside the selected UTM zone; choose Automatic UTM" };
  if (!global.proj4) throw Object.assign(new Error("Loading coordinate projection…"), { code: "PROJECTION_LOADING" });
  const [x, y] = global.proj4("EPSG:4326", `+proj=utm +zone=${zone} ${south ? "+south " : ""}+datum=WGS84 +units=m +no_defs`, [lng, lat]);
  return { code, x, y, text: `E ${x.toFixed(2)} · N ${y.toFixed(2)} m · ${zone}${south ? "S" : "N"}` };
}
let styleReady;
function loadStyle() {
  if (styleReady) return styleReady;
  styleReady = new Promise((resolve, reject) => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = CESIUM_BASE + "Widgets/widgets.css";
    const timer = setTimeout(() => finish(new Error("3D styles timed out. Try 3D again.")), 30000);
    const finish = error => { clearTimeout(timer); link.onload = link.onerror = null; if (error) { link.remove(); reject(error); } else resolve(); };
    link.onload = () => finish(); link.onerror = () => finish(new Error("Could not load 3D styles. Try again.")); document.head.append(link);
  }).catch(error => { styleReady = null; throw error; });
  return styleReady;
}
async function loadCesium(signal) {
  if (typeof global.Worker !== "function") throw new Error("This browser cannot start the 3D rendering workers.");
  global.CESIUM_BASE_URL = CESIUM_BASE;
  await Promise.all([global.GVEngine.ensureLibrary("cesium", { signal }), global.GVEngine.operations.read(loadStyle(), signal)]);
  global.GVEngine.operations.check(signal); return global.Cesium;
}
function terrainResource(C, url, { signal, onAvailabilityFailure }) {
  // Keep JSON cancellation attached when Cesium derives metadata/tilemap URLs.
  function wrap(resource) {
    resource.fetchJson = () => global.GVEngine.requestJSON(resource.url, { signal, timeoutMs: 20000 }).then(value => {
      if (value?.error) throw Object.assign(new Error(value.error.message || "Esri elevation request failed"), { name: "EsriServiceError", code: value.error.code });
      if (resource.url.includes("/tilemap/")) {
        const parts = resource.url.split("?")[0].split("/"), size = Number(parts.at(-2)) * Number(parts.at(-1));
        if (!Array.isArray(value?.data) || value.data.length !== size) throw new Error("Esri returned invalid elevation availability metadata");
      }
      return value;
    }).catch(error => {
      if (!resource.url.includes("/tilemap/")) throw error;
      // Availability probes are fire-and-forget in the pinned provider. Retire
      // failures before resolving abandoned grids; never publish false coverage
      // for an active elevation provider or leave cancellation unhandled.
      if (!signal.aborted) onAvailabilityFailure(error);
      const parts = resource.url.split("?")[0].split("/"), dimension = value => Math.max(1, Math.min(128, Number(value) || 1));
      return { data: new Uint8Array(dimension(parts.at(-2)) * dimension(parts.at(-1))) };
    });
    resource.getDerivedResource = function (options) { return wrap(C.Resource.prototype.getDerivedResource.call(this, options)); };
    return resource;
  }
  return wrap(new C.Resource({ url }));
}
function createScene({ container, load = loadCesium, onPick, onCoordinates, onStatus, onFailure, onTerrainChange, reserveImage = () => () => {}, reserveVectors = () => () => {} }) {
  let viewer = null, opening = null, generation = 0, data = null, baseKey = null, baseLayer = null, clipLayer = null, clipBlob = null;
  let releaseImage = null, url = null, screen = null, removeCamera = null, frameRemover = null, terrainGeneration = 0;
  let lastCamera = null, userMoved = false, terrainRequest = null, terrainLoading = false;
  let releaseVectors = null, cameraPosition = null, cameraDirection = null, renderErrorRemover = null;
  const fileLayers = new Map();
  const stats = { created: 0, destroyed: 0, urlsCreated: 0, urlsRevoked: 0, frames: 0, entities: 0, stale: 0, picks: 0, lastPick: null };
  const render = () => viewer?.scene.requestRender();
  function removeFile(id) {
    const entry = fileLayers.get(id); if (!entry) return;
    if (entry.source && viewer) viewer.dataSources.remove(entry.source, true);
    if (entry.image && viewer) viewer.imageryLayers.remove(entry.image, true);
    if (entry.url) { URL.revokeObjectURL(entry.url); stats.urlsRevoked++; }
    entry.release?.(); fileLayers.delete(id);
  }
  function syncFiles(layers = []) {
    const ids = new Set(layers.map(layer => layer.id)), C = global.Cesium;
    for (const id of fileLayers.keys()) if (!ids.has(id)) removeFile(id);
    for (const layer of layers) {
      let entry = fileLayers.get(layer.id);
      if (entry && (entry.payload !== (layer.fc || layer.image.blob) || (entry.source && entry.opacity !== layer.opacity))) { removeFile(layer.id); entry = null; }
      if (!entry) {
        entry = { payload: layer.fc || layer.image.blob, opacity: layer.opacity };
        fileLayers.set(layer.id, entry);
        try {
          if (layer.fc) {
            const size = fileVectorSize(layer.fc);
            entry.release = reserveVectors(size.vertices * 128 + size.features * 512);
            entry.source = new C.CustomDataSource(layer.name);
            for (const entity of fileEntities(C, layer)) entry.source.entities.add(entity);
            const current = viewer;
            current.dataSources.add(entry.source).then(source => {
              if (viewer !== current || fileLayers.get(layer.id) !== entry) { if (!current.isDestroyed()) current.dataSources.remove(source,true); }
              else render();
            }).catch(error => { if(viewer===current && fileLayers.get(layer.id)===entry)onStatus?.("Layer could not be displayed: " + error.message); });
          } else {
            const { blob, size: [width, height], bounds: [w, s, e, n] } = layer.image;
            entry.release = reserveImage(width * height * 4);
            entry.url = URL.createObjectURL(blob); stats.urlsCreated++;
            const imageURL = entry.url;
            const scheme = new C.WebMercatorTilingScheme({ rectangleSouthwestInMeters: new C.Cartesian2(...global.GVEngine.merc(w, s)), rectangleNortheastInMeters: new C.Cartesian2(...global.GVEngine.merc(e, n)) });
            const provider = { rectangle: scheme.rectangle, tilingScheme: scheme, tileWidth: width, tileHeight: height,
              minimumLevel: 0, maximumLevel: 0, errorEvent: new C.Event(), credit: new C.Credit(String(layer.name).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))), hasAlphaChannel: true,
              getTileCredits: () => undefined, pickFeatures: () => undefined,
              requestImage: (_x, _y, _level, request) => C.ImageryProvider.loadImage(provider, new C.Resource({ url: imageURL, request })) };
            entry.image = viewer.imageryLayers.addImageryProvider(provider);
          }
        } catch (error) { removeFile(layer.id); throw error; }
      }
      if (entry.source) entry.source.show = layer.visible !== false;
      if (entry.image) { entry.image.show = layer.visible !== false; entry.image.alpha = layer.opacity ?? 1; }
    }
    render();
  }
  function clearImage() {
    if (clipLayer && viewer) viewer.imageryLayers.remove(clipLayer, true);
    clipLayer = null; clipBlob = null;
    if (url) { URL.revokeObjectURL(url); stats.urlsRevoked++; url = null; }
    releaseImage?.(); releaseImage = null;
  }
  function setBase(item) {
    if (!viewer || !item || item.key === baseKey) return;
    const C = global.Cesium;
    const provider = new C.UrlTemplateImageryProvider({ url: item.url, tilingScheme: new C.WebMercatorTilingScheme(),
      maximumLevel: item.maxLevel, credit: item.credit, enablePickFeatures: false });
    const next = viewer.imageryLayers.addImageryProvider(provider, 0);
    if (baseLayer) viewer.imageryLayers.remove(baseLayer, true);
    baseLayer = next; baseKey = item.key; render();
  }
  function setImage(image) {
    if (image?.blob === clipBlob) return;
    clearImage(); if (!image?.blob) return;
    const C = global.Cesium, [w, s, e, n] = image.bounds, [width, height] = image.size;
    try {
      releaseImage = reserveImage(width * height * 4);
      url = URL.createObjectURL(image.blob); stats.urlsCreated++;
      const southwest = global.GVEngine.merc(w, s), northeast = global.GVEngine.merc(e, n);
      const scheme = new C.WebMercatorTilingScheme({ rectangleSouthwestInMeters: new C.Cartesian2(...southwest), rectangleNortheastInMeters: new C.Cartesian2(...northeast) });
      // The display PNG's rows are Mercator-spaced, not latitude-spaced. A
      // custom single-tile provider preserves the native image transform.
      const provider = { rectangle: scheme.rectangle, tilingScheme: scheme, tileWidth: width, tileHeight: height,
        minimumLevel: 0, maximumLevel: 0, errorEvent: new C.Event(), credit: new C.Credit("AOI imagery · Esri Wayback"), hasAlphaChannel: true,
        getTileCredits: () => undefined, pickFeatures: () => undefined,
        requestImage: (_x, _y, _level, request) => C.ImageryProvider.loadImage(provider, new C.Resource({ url: imageURL, request })) };
      const imageURL = url;
      clipLayer = viewer.imageryLayers.addImageryProvider(provider); clipBlob = image.blob; render();
    } catch (error) { clearImage(); throw error; }
  }
  function sync(next) {
    data = next; if (!viewer) return;
    const C = global.Cesium;
    const features = [...(next.aois || []), ...(next.detections?.features || [])];
    let vertices = 0;
    for (const feature of features) {
      const geometry = feature.geometry;
      const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : [];
      for (const ring of rings) vertices += ring.length;
    }
    if (features.length > 10000 || vertices > 200000) throw new Error("This result exceeds the 3D vector limit (10,000 features / 200,000 vertices). Review it in 2D or select a smaller AOI.");
    const nextReservation = reserveVectors(vertices * 128 + features.length * 512);
    viewer.entities.suspendEvents();
    try {
      setBase(next.basemap); setImage(next.image); syncFiles(next.fileLayers);
      viewer.entities.removeAll();
      for (const [kind, features] of [["aoi", next.aois || []], ["detection", next.detections?.features || []]]) features.forEach((feature, index) => {
        const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];
        const css = next.color?.(feature, kind, index) || (kind === "aoi" ? "#ffffff" : "#f2a516"), color = C.Color.fromCssColorString(css);
        for (const [part, rings] of polygons.entries()) {
          if (!rings[0]?.length) continue;
          const positions = ring => C.Cartesian3.fromDegreesArray(ring.flatMap(point => point.slice(0, 2)));
          viewer.entities.add({ id: kind + ":" + index + ":" + part, properties: { kind, index },
            polygon: { hierarchy: new C.PolygonHierarchy(positions(rings[0]), rings.slice(1).map(ring => new C.PolygonHierarchy(positions(ring)))), material: color.withAlpha(kind === "aoi" ? .025 : .12), zIndex: kind === "aoi" ? 0 : 10 },
            polyline: { positions: positions(rings[0]), width: kind === "aoi" ? 2 : 2.5, material: color, clampToGround: true } });
        }
      });
    } catch (error) { nextReservation(); throw error; }
    finally { viewer.entities.resumeEvents(); }
    releaseVectors?.(); releaseVectors = nextReservation;
    stats.entities = viewer.entities.values.length; render();
  }
  function setCamera(camera) {
    lastCamera = { center: { ...camera.center }, zoom: camera.zoom }; userMoved = false;
    if (!viewer) return;
    const C = global.Cesium, { lat, lng } = camera.center;
    const height = Math.max(1, container.clientHeight || 800), resolution = 156543.03392804097 * Math.cos(lat * Math.PI / 180) / 2 ** camera.zoom;
    const range = Math.max(30, resolution * height / (2 * Math.tan(Math.PI / 6)));
    viewer.camera.lookAt(C.Cartesian3.fromDegrees(lng, lat), new C.HeadingPitchRange(0, -C.Math.toRadians(55), range));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); render();
    cameraPosition = C.Cartesian3.clone(viewer.camera.positionWC); cameraDirection = C.Cartesian3.clone(viewer.camera.directionWC);
  }
  function viewpoint() {
    if (!viewer || !userMoved) return lastCamera;
    const C = global.Cesium, canvas = viewer.canvas;
    if (cameraPosition && C.Cartesian3.equalsEpsilon(viewer.camera.positionWC, cameraPosition, 1e-12) && C.Cartesian3.equalsEpsilon(viewer.camera.directionWC, cameraDirection, 1e-12)) return lastCamera;
    const position = viewer.scene.globe.pick(viewer.camera.getPickRay(new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)), viewer.scene);
    if (!position) return lastCamera;
    const point = C.Cartographic.fromCartesian(position), lat = C.Math.toDegrees(point.latitude), lng = C.Math.toDegrees(point.longitude);
    const distance = C.Cartesian3.distance(position, viewer.camera.positionWC), resolution = distance * 2 * Math.tan(Math.PI / 6) / Math.max(1, canvas.clientHeight);
    return { center: { lat, lng }, zoom: Math.max(2, Math.min(21, Math.log2(156543.03392804097 * Math.cos(point.latitude) / resolution))) };
  }
  async function terrain(enabled) {
    const epoch = ++terrainGeneration;
    terrainRequest?.abort(); terrainRequest = null; terrainLoading = false;
    if (!viewer) return;
    const C = global.Cesium, current = viewer;
    if (!enabled) {
      if (!(current.terrainProvider instanceof C.EllipsoidTerrainProvider)) { current.terrainProvider = new C.EllipsoidTerrainProvider(); render(); }
      onTerrainChange?.(false); return;
    }
    const request = terrainRequest = new AbortController(); terrainLoading = true;
    const resource = terrainResource(C, TERRAIN, { signal: request.signal, onAvailabilityFailure() {
        if (viewer === current && epoch === terrainGeneration) {
          current.terrainProvider = new C.EllipsoidTerrainProvider(); request.abort();
          onTerrainChange?.(false);
          onStatus?.("Esri elevation availability failed. Showing the ellipsoid globe; choose the surface again to retry."); render();
        }
      } });
    try {
      const provider = await C.ArcGISTiledElevationTerrainProvider.fromUrl(resource);
      if (viewer !== current || epoch !== terrainGeneration) { stats.stale++; return; }
      current.terrainProvider = provider; onTerrainChange?.(true); onStatus?.("Esri elevation terrain enabled."); render();
    } catch (error) { if (viewer === current && epoch === terrainGeneration) { onTerrainChange?.(false); onStatus?.("Esri elevation unavailable. The globe remains usable without terrain. " + (error.message || "")); } }
    finally { if (terrainRequest === request) terrainLoading = false; }
  }
  function close() {
    generation++; opening?.abort(); opening = null; ++terrainGeneration; terrainRequest?.abort(); terrainRequest = null; terrainLoading = false;
    const camera = viewer ? viewpoint() : null;
    for (const id of fileLayers.keys()) removeFile(id);
    clearImage(); screen = null; removeCamera?.(); removeCamera = null; frameRemover?.(); frameRemover = null; renderErrorRemover?.(); renderErrorRemover = null;
    if (viewer) { viewer.destroy(); viewer = null; stats.destroyed++; }
    releaseVectors?.(); releaseVectors = null; cameraPosition = cameraDirection = null;
    baseLayer = null; baseKey = null; data = null; lastCamera = null; stats.entities = 0; return camera;
  }
  async function open(camera, next) {
    close(); const epoch = generation, controller = opening = new AbortController();
    try {
      const C = await load(controller.signal);
      if (epoch !== generation || controller.signal.aborted) throw new DOMException("3D opening cancelled", "AbortError");
      viewer = new C.Viewer(container, { baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(),
        baseLayerPicker: false, animation: false, timeline: false, geocoder: false, homeButton: false, navigationHelpButton: false,
        fullscreenButton: false, sceneModePicker: false, selectionIndicator: false, infoBox: false,
        requestRenderMode: true, maximumRenderTimeChange: Infinity, shouldAnimate: false });
      stats.created++; viewer.scene.globe.maximumScreenSpaceError = 3; viewer.resolutionScale = Math.min(1, 1.5 / (global.devicePixelRatio || 1));
      viewer.scene.globe.tileCacheSize = 64;
      viewer.scene.globe.depthTestAgainstTerrain = false;
      // Replace Viewer selection actions rather than adding a second handler
      // which competes with its default pick/tracking behavior. Viewer owns it.
      screen = viewer.screenSpaceEventHandler;
      screen.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      screen.setInputAction(event => {
        stats.picks++;
        stats.lastPickPosition = { x: event.position.x, y: event.position.y };
        const primary = viewer.scene.pick(event.position)?.id;
        let entity = primary?.properties?.kind ? primary : null;
        if (entity?.properties.kind.getValue() !== "detection") {
          const entities = viewer.scene.drillPick(event.position, 16).map(hit => hit.id).filter(item => item?.properties?.kind);
          entity = entities.find(item => item.properties.kind.getValue() === "detection") || entity || entities[0];
        }
        stats.lastPick = entity ? entity.properties.kind.getValue() : null;
        if (entity) onPick?.(entity.properties.kind.getValue(), entity.properties.index.getValue(), entity.properties.layerId?.getValue());
      }, C.ScreenSpaceEventType.LEFT_CLICK);
      screen.setInputAction(event => { const ray = viewer.camera.getPickRay(event.endPosition), position = ray && viewer.scene.globe.pick(ray, viewer.scene);
        if (position) { const p = C.Cartographic.fromCartesian(position); onCoordinates?.({ lat: C.Math.toDegrees(p.latitude), lng: C.Math.toDegrees(p.longitude) }); } }, C.ScreenSpaceEventType.MOUSE_MOVE);
      let down = null; const canvas = viewer.canvas;
      const downAt = event => { down = { x: event.clientX, y: event.clientY }; };
      const moveAt = event => { if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 3) userMoved = true; };
      const up = () => { down = null; }, wheel = () => { userMoved = true; };
      const navigation = [["pointerdown", downAt], ["pointermove", moveAt], ["pointerup", up], ["pointercancel", up], ["wheel", wheel]];
      for (const [name, handler] of navigation) canvas.addEventListener(name, handler, { passive: true });
      removeCamera = () => { for (const [name, handler] of navigation) canvas.removeEventListener(name, handler); };
      frameRemover = viewer.scene.postRender.addEventListener(() => { stats.frames++; });
      renderErrorRemover = viewer.scene.renderError.addEventListener((_scene, error) => {
        Promise.resolve().then(() => { if (epoch === generation) onFailure?.(error); });
      });
      setCamera(camera); sync(next); return true;
    } catch (error) { if (epoch === generation) { close(); container.replaceChildren?.(); } throw error; }
    finally { if (opening === controller) opening = null; }
  }
  function fitBounds(bounds) {
    if (!viewer) return;
    const C = global.Cesium, [w,s,e,n] = bounds, padding = Math.max(.001, Math.max(e-w,n-s) * .08);
    viewer.camera.flyTo({ destination: C.Rectangle.fromDegrees(Math.max(-180,w-padding),Math.max(-90,s-padding),Math.min(180,e+padding),Math.min(90,n+padding)), duration: .6 });
    userMoved = true; render();
  }
  return { open, close, sync, setCamera, viewpoint, terrain, render, fitBounds,
    diagnostics: () => ({ ...stats, active: Boolean(viewer), loading: Boolean(opening), image: Boolean(clipLayer), terrainLoading,
      fileLayers: fileLayers.size, fileVectors: [...fileLayers.values()].filter(layer => layer.source).length,
      fileRasters: [...fileLayers.values()].filter(layer => layer.image).length,
      fileEntities: [...fileLayers.values()].reduce((sum,layer) => sum + (layer.source?.entities.values.length || 0),0) }) };
}
global.GVMapView = { BASEMAPS, COORDINATES, basemap, coordinates, createScene, terrainResource, fileGeometries, fileVectorSize, fileEntities, CESIUM_BASE, TERRAIN };
})(typeof window !== "undefined" ? window : globalThis);
