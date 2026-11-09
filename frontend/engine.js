/* GeoVision browser engine — everything runs client-side (works on GitHub Pages).
 *  - Esri Wayback releases, local-change lookup, tile mosaics clipped to AOI polygons
 *  - YOLO-OBB detection with ONNX Runtime Web (WebGPU when available, else WASM)
 *  - GeoTIFF (EPSG:3857, RGBA, deflate) writer, PNG + world file, GeoJSON, zip export
 *  - YOLO-OBB training dataset export from reviewed annotations
 * Optional libraries load on first use in the processing context.
 */
(function (global) {
"use strict";
const ORIGIN = 20037508.342789244, TILE = 256;
const CONFIG_URL = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";
const TILE_URL = (r, z, y, x) => `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${r}/${z}/${y}/${x}`;
const TILEMAP_URL = (r, z, y, x) => `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${r}/${z}/${y}/${x}`;
const WKT_3857 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]';
const LABELS = { "plane": "aircraft", "ship": "ship", "storage tank": "storage_tank", "baseball diamond": "baseball_diamond",
  "tennis court": "tennis_court", "basketball court": "basketball_court", "ground track field": "track_field", "harbor": "harbor",
  "bridge": "bridge", "large vehicle": "large_vehicle", "small vehicle": "small_vehicle", "helicopter": "helicopter",
  "roundabout": "roundabout", "soccer ball field": "soccer_field", "swimming pool": "swimming_pool" };
const DOTA_NAMES = ["plane", "ship", "storage tank", "baseball diamond", "tennis court", "basketball court", "ground track field",
  "harbor", "bridge", "large vehicle", "small vehicle", "helicopter", "roundabout", "soccer ball field", "swimming pool"];

// One loader per context, shared by concurrent consumers. Failed attempts are
// removed so the next user action can retry; loaded libraries live with the page.
const libraries = {
  draw: { url: "https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js", ready: () => global.L?.Draw?.Polygon },
  ort: { url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js", ready: () => global.ort?.InferenceSession },
  fflate: { url: "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js", ready: () => global.fflate?.zlibSync },
  zip: { url: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", ready: () => global.JSZip },
  streaming: { url: "streaming.js", ready: () => global.GVStreaming },
  shp: { url: "https://unpkg.com/shpjs@4.0.4/dist/shp.js", ready: () => global.shp },
  kml: { url: "https://unpkg.com/@mapbox/togeojson@0.16.0/togeojson.js", ready: () => global.toGeoJSON },
};
const libraryLoads = new Map(), startup = {}, dependencyTimings = {};
const now = () => global.performance?.now() ?? Date.now();
function markStartup(name) {
  if (startup[name] != null) return;
  startup[name] = now(); global.performance?.mark?.("gmd:" + name);
}
function configureOrt() {
  if (!global.ort?.env?.wasm) return;
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
  if (!global.crossOriginIsolated) ort.env.wasm.numThreads = 1;
}
function ensureLibrary(name, options) {
  if (options?.signal) { if (options.signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError")); return ownedRead(ensureLibrary(name), options.signal); }
  const library = libraries[name];
  if (!library) return Promise.reject(new Error("Unknown library: " + name));
  if (library.ready()) { if (name === "ort") configureOrt(); return Promise.resolve(); }
  if (libraryLoads.has(name)) return libraryLoads.get(name);
  const started = now();
  const promise = new Promise((resolve, reject) => {
    let script, timer;
    const finish = error => {
      if (timer) clearTimeout(timer);
      if (script) script.onload = script.onerror = null;
      if (error) { script?.remove(); reject(error); }
      else if (!library.ready()) { script?.remove(); reject(new Error("Library did not initialize: " + library.url)); }
      else { if (name === "ort") configureOrt(); resolve(); }
    };
    try {
      if (global.document) {
        script = document.createElement("script"); script.src = library.url; script.async = true;
        script.onload = () => finish(); script.onerror = () => finish(new Error("Could not load " + library.url + ". Try again."));
        timer = setTimeout(() => finish(new Error("Timed out loading " + library.url + ". Try again.")), 30000);
        document.head.append(script);
      } else if (typeof global.importScripts === "function" && name !== "draw") {
        global.importScripts(library.url); finish();
      } else finish(new Error("Cannot load " + name + " in this context"));
    } catch (error) { finish(error); }
  }).then(() => { dependencyTimings[name] = { ms: now() - started, status: "ready" }; }, error => {
    libraryLoads.delete(name); dependencyTimings[name] = { ms: now() - started, status: "error" }; throw error;
  });
  libraryLoads.set(name, promise);
  return promise;
}

// Request owns its timeout and abort listener. A cancelled metadata lookup must
// not continue walking releases or publish partially successful results.
const activeOperations = new Map(); let operationSequence = 0;
const lifecycleStats = { created: 0, closed: 0, timedOut: 0, pendingReads: 0, requests: 0, tileAttempts: 0, cacheWrites: 0, inference: 0, bitmaps: 0, tensors: 0 };
function operation(label, { signal, timeoutMs = 0 } = {}) {
  const controller = new AbortController(), id = ++operationSequence;
  let expired = false, closed = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs ? global.setTimeout?.(() => { expired = true; lifecycleStats.timedOut++; abort(); }, timeoutMs) : null;
  const owner = { id, label, signal: controller.signal, abort, get timedOut() { return expired; },
    check() {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (expired) throw Object.assign(new Error(`${label} timed out. Retry this operation.`), { name: "TimeoutError", code: "OPERATION_TIMEOUT" });
      if (closed || controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    },
    close() { if (closed) return; closed = true; if (timer != null) global.clearTimeout?.(timer); signal?.removeEventListener("abort", abort); controller.abort(); activeOperations.delete(id); lifecycleStats.closed++; } };
  activeOperations.set(id, owner); lifecycleStats.created++; return owner;
}
function ownedRead(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; lifecycleStats.pendingReads--; signal.removeEventListener("abort", abort); fn(value); };
    const abort = () => finish(reject, new DOMException("Cancelled", "AbortError"));
    lifecycleStats.pendingReads++;
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function yieldTask(signal) { checkAbort(signal); if (global.scheduler?.yield) await global.scheduler.yield(); else await new Promise(resolve => global.setTimeout ? global.setTimeout(resolve, 0) : resolve()); checkAbort(signal); }
async function cleanupOwned(failure, actions) {
  const errors = [];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); lifecycleStats.cleanupFailures = (lifecycleStats.cleanupFailures || 0) + 1; } }
  if (errors.length) { if (failure) failure.cleanupErrors = errors.map(error => error.message); else throw errors[0]; }
}
async function requestJSON(url, options = {}) {
  const { signal, timeoutMs = 20000, ...init } = options, controller = new AbortController();
  checkAbort(signal); lifecycleStats.requests++;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = typeof response.json === "function" ? await response.json().catch(() => null) : null;
      throw new Error(`Request failed (HTTP ${response.status}): ${url}${typeof detail?.detail === "string" ? ": " + detail.detail : ""}`);
    }
    const json = await response.json();
    checkAbort(signal);
    if (expired) throw Object.assign(new Error(`Request timed out: ${url}`), { name: "TimeoutError", code: "REQUEST_TIMEOUT" });
    return json;
  } catch (error) {
    checkAbort(signal);
    if (expired) throw Object.assign(new Error(`Request timed out: ${url}`), { name: "TimeoutError", code: "REQUEST_TIMEOUT" });
    throw error;
  } finally { lifecycleStats.requests--; clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

// ------------------------------------------------------------------ transient map search (no persisted geocoder results)
const GEOCODER = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/";
const MAX_MAP_LAT = 85.05112878;
function mapPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new Error("Enter valid latitude (−90 to 90), longitude (−180 to 180).");
  if (Math.abs(lat) > MAX_MAP_LAT) throw new Error("Wayback map imagery supports latitudes between −85.05113 and 85.05113.");
  return { lat, lon, label: `${lat.toFixed(6)}, ${lon.toFixed(6)}` };
}
function parseMapCoordinates(value) {
  const text = String(value).trim().replace(/−/g, "-"), number = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))";
  let match = text.match(new RegExp("^" + number + "(?:\\s*[,;]\\s*|\\s+)" + number + "$"));
  if (match) {
    let lat = Number(match[1]), lon = Number(match[2]);
    // Ambiguous decimal pairs are latitude, longitude, as shown by the hint.
    if (Math.abs(lat) > 90 && Math.abs(lat) <= 180 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    return mapPoint(lat, lon);
  }
  const named = new RegExp("\\b(latitude|lat|longitude|lon|lng)\\s*[:=]?\\s*" + number, "gi");
  const directed = new RegExp(number + "\\s*°?\\s*([NSEW])\\b", "gi");
  for (const [pattern, directions] of [[named, false], [directed, true]]) {
    const parts = [...text.matchAll(pattern)];
    if (parts.length !== 2 || text.replace(pattern, "").replace(/[\s,;]+/g, "")) continue;
    const point = {};
    for (const part of parts) {
      const direction = directions ? part[2].toUpperCase() : null, axis = directions ? /[NS]/.test(direction) ? "lat" : "lon" : /^lat/i.test(part[1]) ? "lat" : "lon";
      const n = Number(part[directions ? 1 : 2]);
      if (point[axis] !== undefined || (directions && n < 0)) throw new Error("Use one latitude and one longitude; hemisphere coordinates use positive numbers.");
      point[axis] = directions && /[SW]/.test(direction) ? -n : n;
    }
    return mapPoint(point.lat, point.lon);
  }
  if (/^[\d\s+.,;\-]+$/.test(text) && /[,;]/.test(text)) throw new Error("Enter two decimal coordinates: latitude, longitude (for example 25.25, 55.36).");
  return null;
}
async function mapPlaceRequest(action, text, { signal, center, magicKey } = {}) {
  checkAbort(signal);
  if (typeof text !== "string" || !text.trim() || text.length > 300) throw new Error("Enter a place name of at most 300 characters.");
  const parameters = new URLSearchParams({ f: "json" });
  parameters.set(action === "suggest" ? "text" : "SingleLine", text.trim());
  if (action === "suggest") parameters.set("maxSuggestions", "5");
  else { parameters.set("maxLocations", "5"); parameters.set("outSR", "4326"); parameters.set("forStorage", "false"); if (magicKey) parameters.set("magicKey", magicKey); }
  if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng) && Math.abs(center.lat) <= MAX_MAP_LAT && Math.abs(center.lng) <= 180)
    parameters.set("location", `${center.lng},${center.lat}`);
  const data = await requestJSON(GEOCODER + action + "?" + parameters, { signal, timeoutMs: 10000 });
  checkAbort(signal);
  if (data?.error) throw new Error("Place search is unavailable. Try again or enter latitude, longitude.");
  return data;
}
async function suggestMapPlaces(text, options) {
  const data = await mapPlaceRequest("suggest", text, options);
  if (!Array.isArray(data?.suggestions)) throw new Error("Place search returned invalid suggestions. Try again.");
  return data.suggestions.slice(0, 5).map(item => {
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 500 || typeof item.magicKey !== "string" || item.magicKey.length > 4096)
      throw new Error("Place search returned invalid suggestions. Try again.");
    return { label: item.text, magicKey: item.magicKey };
  });
}
async function findMapPlace(text, options) {
  const data = await mapPlaceRequest("findAddressCandidates", text, options);
  if (!Array.isArray(data?.candidates)) throw new Error("Place search returned invalid locations. Try again.");
  const candidate = data.candidates[0];
  if (!candidate) return null;
  if (typeof candidate.address !== "string" || !candidate.address.trim() || candidate.address.length > 500)
    throw new Error("Place search returned an invalid location. Try again.");
  const point = mapPoint(candidate.location?.y, candidate.location?.x), extent = candidate.extent;
  const values = extent && [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  const bounds = values?.every(Number.isFinite) && values[0] >= -180 && values[2] <= 180 && values[0] < values[2] && values[1] >= -90 && values[3] <= 90 && values[1] < values[3]
    ? [[Math.max(-MAX_MAP_LAT, values[1]), values[0]], [Math.min(MAX_MAP_LAT, values[3]), values[2]]] : null;
  return { ...point, label: candidate.address, bounds };
}
async function currentMapLocation({ signal, timeoutMs = 12000 } = {}) {
  const owner = operation("Current location", { signal, timeoutMs });
  try {
    owner.check();
    const geo = global.navigator?.geolocation;
    if (!geo || global.isSecureContext === false) throw new Error("Current location is unavailable in this browser. Enter a place or coordinates instead.");
    return await new Promise((resolve, reject) => {
      let watch, settled = false;
      const clear = () => { if (watch != null) { geo.clearWatch(watch); watch = null; } };
      const finish = (error, point) => { if (settled) return; settled = true; owner.signal.removeEventListener("abort", abort); clear(); error ? reject(error) : resolve(point); };
      const abort = () => { try { owner.check(); } catch (error) { finish(error); } };
      owner.signal.addEventListener("abort", abort, { once: true });
      try {
        watch = geo.watchPosition(position => {
          try { owner.check(); finish(null, mapPoint(position.coords.latitude, position.coords.longitude)); } catch (error) { finish(error); }
        }, error => finish(new Error(error.code === 1 ? "Location permission was denied. Allow location access in your browser or enter coordinates."
          : error.code === 3 ? "Current location timed out. Try again or enter coordinates." : "Your current location could not be found. Try a place name or coordinates.")),
        { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
        if (settled) clear();
      } catch (error) { finish(error); }
    });
  } finally { owner.close(); }
}

// ------------------------------------------------------------------ geo math
const merc = (lon, lat) => { lat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  return [lon * ORIGIN / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * ORIGIN / Math.PI]; };
const unmerc = (x, y) => [x / ORIGIN * 180, (2 * Math.atan(Math.exp(y / ORIGIN * Math.PI)) - Math.PI / 2) * 180 / Math.PI];
const resAt = z => 2 * ORIGIN / (TILE * 2 ** z);
const lonlatToPixel = (lon, lat, z) => { const [x, y] = merc(lon, lat), r = resAt(z); return [(x + ORIGIN) / r, (ORIGIN - y) / r]; };
const lonlatToTile = (lon, lat, z) => lonlatToPixel(lon, lat, z).map(v => Math.floor(v / TILE));

function polygonsOf(geom) {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  throw new Error("AOI must be a polygon");
}
function bboxOf(geom) {
  let a = [Infinity, Infinity, -Infinity, -Infinity];
  polygonsOf(geom).forEach(p => p.forEach(ring => ring.forEach(([x, y]) => { a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)]; })));
  return a;
}
function uniqueAois(features) {
  // Skip exact duplicates from repeated imports or previously saved AOI lists.
  // Keep different names, geometries, and metadata as separate AOIs.
  const seen = new Set();
  return features.filter(f => {
    const { _gmd_id, ...external } = f;
    const key = JSON.stringify(external);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function pointInRings(rings, x, y) {          // even-odd over all rings (holes included)
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ allocation policy / canvas ownership
const DEFAULT_LIMITS = Object.freeze({ maxPixels: 32000000, maxDimension: 8192, maxEstimatedBytes: 512 * 1024 * 1024 });
let allocationDefaults = { ...DEFAULT_LIMITS }, allocationSequence = 0;
const allocationLeases = new Map(), canvasOwners = new WeakMap();
const allocationWaiters = new Set();
const allocationChanged = () => { for (const wake of [...allocationWaiters]) wake(); };
const allocationStats = { rejected: 0, canvasesCreated: 0, canvasesReleased: 0, liveCanvasBytes: 0, peakCanvasBytes: 0, peakReservedBytes: 0 };
class AllocationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "AllocationError"; this.code = code; Object.assign(this, details); }
}
const mib = bytes => (bytes / 1048576).toFixed(1) + " MiB";
function limitsFor(values = {}) {
  const limits = { ...allocationDefaults, ...values };
  for (const name of Object.keys(DEFAULT_LIMITS)) if (!Number.isSafeInteger(limits[name]) || limits[name] < 1)
    throw new AllocationError("INVALID_LIMIT", `${name} must be a positive whole number.`);
  return limits;
}
function dimensions(width, height, limits = limitsFor(), label = "Canvas") {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(width * height * 4))
    throw new AllocationError("INVALID_DIMENSIONS", `${label} dimensions must be finite positive integer pixels.`, { width, height });
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels)
    throw new AllocationError("RASTER_LIMIT", `${label} ${width}×${height} px exceeds the ${limits.maxDimension} px side or ${(limits.maxPixels / 1e6).toFixed(2)} MP limit. Use a smaller AOI at the same zoom, or adjust Browser limits.`, { width, height, limits });
  return width * height * 4;
}
function reserveAllocation(label, estimatedBytes, values, processing = false, kind = processing ? "processing" : "helper") {
  const limits = limitsFor(values);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1) throw new AllocationError("INVALID_DIMENSIONS", "Invalid working-buffer estimate.");
  const active = [...allocationLeases.values()], total = active.reduce((sum, lease) => sum + lease.estimatedBytes, 0);
  if (processing && active.some(lease => lease.processing)) {
    allocationStats.rejected++; throw new AllocationError("RESOURCE_BUSY", "Another browser raster/dataset operation is active. Wait for it to finish and retry.");
  }
  if (kind === "download" && active.filter(lease => lease.kind === "download").length >= 4) throw new AllocationError("RESOURCE_BUSY", "Four downloads are pending. Wait for the browser to consume them, then retry.");
  if (!processing && kind !== "download" && active.filter(lease => !lease.processing && lease.kind !== "download").length >= 2) { allocationStats.rejected++; throw new AllocationError("RESOURCE_BUSY", "Two browser image/export helpers are already active. Wait and retry."); }
  const cap = Math.min(limits.maxEstimatedBytes, ...active.map(lease => lease.limits.maxEstimatedBytes));
  if (estimatedBytes + total > cap) {
    allocationStats.rejected++; throw new AllocationError("MEMORY_LIMIT", `${label} needs an estimated ${mib(estimatedBytes)}; ${mib(total)} is reserved and the working limit is ${mib(cap)}. Use a smaller AOI at the same zoom, disable GeoTIFF, or adjust Browser limits.`, { estimatedBytes, reservedBytes: total, limits });
  }
  const lease = { id: ++allocationSequence, label, limits, processing, kind, estimatedBytes, canvases: new Set(), canvasBytes: 0, closed: false,
    check(bytes) { if (this.closed) throw new AllocationError("RESOURCE_BUSY", "Allocation owner has already closed."); if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.estimatedBytes) { allocationStats.rejected++; throw new AllocationError("MEMORY_LIMIT", `${label} exceeds its reserved working estimate.`, { estimatedBytes: bytes, reservedBytes: this.estimatedBytes }); } },
    resize(bytes) {
      const other = [...allocationLeases.values()].filter(value => value !== this), used = other.reduce((sum, value) => sum + value.estimatedBytes, 0);
      const cap = Math.min(this.limits.maxEstimatedBytes, ...other.map(value => value.limits.maxEstimatedBytes));
      if (this.closed || !Number.isSafeInteger(bytes) || bytes < 1 || bytes < this.canvasBytes || bytes + used > cap) { allocationStats.rejected++; throw new AllocationError("MEMORY_LIMIT", `${label} exceeds the estimated working limit ${mib(cap)}. Export fewer clips or adjust Browser limits.`, { estimatedBytes: bytes, reservedBytes: used, limits: this.limits }); }
      this.estimatedBytes = bytes; allocationStats.peakReservedBytes = Math.max(allocationStats.peakReservedBytes, used + bytes);
      allocationChanged();
    },
    release() { if (this.closed) return; for (const canvas of [...this.canvases]) releaseCanvas(canvas); this.closed = true; allocationLeases.delete(this.id); allocationChanged(); } };
  allocationLeases.set(lease.id, lease); allocationStats.peakReservedBytes = Math.max(allocationStats.peakReservedBytes, total + estimatedBytes); return lease;
}
async function acquireAllocation(label, bytes, limits, { signal, onWaiting } = {}) {
  for (;;) {
    checkAbort(signal);
    try { return reserveAllocation(label, bytes, limits, true); }
    catch (error) {
      if (!["RESOURCE_BUSY", "MEMORY_LIMIT"].includes(error.code) || !allocationLeases.size || bytes > limitsFor(limits).maxEstimatedBytes) throw error;
      await new Promise((resolve, reject) => {
        const finish = error => { allocationWaiters.delete(wake); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const wake = () => finish(), abort = () => finish(new DOMException("Cancelled", "AbortError"));
        allocationWaiters.add(wake); if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        try { onWaiting?.(); } catch (error) { finish(error); }
      });
    }
  }
}
function releaseCanvas(canvas) {
  if (!canvas) return;
  const record = canvasOwners.get(canvas);
  if (record) { record.lease.canvases.delete(canvas); record.lease.canvasBytes -= record.bytes; allocationStats.liveCanvasBytes -= record.bytes; allocationStats.canvasesReleased++; canvasOwners.delete(canvas); }
  canvas.width = canvas.height = 1;
}
function makeCanvas(w, h, lease) {
  if (!lease) throw new AllocationError("ALLOCATION_OWNER", "Canvas allocation needs an operation owner.");
  const bytes = dimensions(w, h, lease.limits); lease.check(lease.canvasBytes + bytes);
  let canvas;
  try {
    canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
    if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
    if (canvas.width !== w || canvas.height !== h) throw new Error("Browser rejected canvas dimensions");
  } catch (error) { if (canvas) canvas.width = canvas.height = 1; throw new AllocationError("CANVAS_ALLOCATION", `Browser could not allocate ${w}×${h} px. Reduce Browser limits or use a smaller AOI. ${error.message}`, { width: w, height: h }); }
  canvasOwners.set(canvas, { lease, bytes }); lease.canvases.add(canvas); lease.canvasBytes += bytes;
  allocationStats.canvasesCreated++; allocationStats.liveCanvasBytes += bytes; allocationStats.peakCanvasBytes = Math.max(allocationStats.peakCanvasBytes, allocationStats.liveCanvasBytes); return canvas;
}
const ctx2d = c => { const context = c.getContext("2d", { willReadFrequently: true }); if (!context) throw new AllocationError("CANVAS_CONTEXT", "Browser could not create a canvas context. Use a smaller AOI or lower Browser limits."); return context; };
const canvasBlob = (c, type = "image/png", q) => c.convertToBlob ? c.convertToBlob({ type, quality: q })
  : new Promise(ok => c.toBlob(ok, type, q));
// Read the fixed PNG header without decoding pixels, including legacy server
// clips which did not save dimensions. Metadata must not authorize a decode.
async function pngDimensions(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (bytes.length !== 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    || new DataView(bytes.buffer).getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR")
    throw new AllocationError("INVALID_IMAGE", "Comparison requires a valid PNG image header.");
  const view = new DataView(bytes.buffer), size = [view.getUint32(16), view.getUint32(20)];
  if (!size.every(value => value > 0)) throw new AllocationError("INVALID_IMAGE", "PNG dimensions must be positive.");
  return size;
}

// ------------------------------------------------------------------ Wayback
const RELEASE_CACHE_KEY = "gv_wayback_releases_v1";
let _releases = null, _releaseRequest = null, _releaseController = null;
let _releaseInfo = { source: null, fetchedAt: null, refreshing: false, error: null };
function normalizeReleases(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 5000) throw new Error("Invalid Wayback release list");
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || !Number.isSafeInteger(entry.release) || entry.release <= 0 || seen.has(entry.release)
      || typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      || Number.isNaN(Date.parse(entry.date)) || new Date(entry.date).toISOString().slice(0, 10) !== entry.date
      || typeof entry.title !== "string" || entry.title.length > 1000) throw new Error("Invalid Wayback release entry");
    seen.add(entry.release);
    return { release: entry.release, date: entry.date, title: entry.title, tileUrl: TILE_URL(entry.release, "{z}", "{y}", "{x}") };
  }).sort((a, b) => b.date.localeCompare(a.date));
}
function readReleaseCache() {
  try {
    const raw = global.localStorage?.getItem(RELEASE_CACHE_KEY);
    if (!raw || raw.length > 1e6) return;
    const cached = JSON.parse(raw);
    if (cached.version !== 1 || !Number.isSafeInteger(cached.fetchedAt) || cached.fetchedAt <= 0 || cached.fetchedAt > Date.now() + 60000) return;
    _releases = normalizeReleases(cached.releases);
    _releaseInfo = { source: "cache", fetchedAt: cached.fetchedAt, refreshing: false, error: null };
  } catch { /* Private/disabled/corrupt cache must not prevent a network load. */ }
}
function releaseCacheInfo() { return { ..._releaseInfo }; }
function cancelReleaseRefresh() { _releaseController?.abort(); }
async function getReleases({ refresh = false } = {}) {
  if (!_releases && !refresh) readReleaseCache();
  if (_releases && !refresh) return _releases;
  if (_releaseRequest) return _releaseRequest;
  const controller = _releaseController = new AbortController();
  _releaseInfo = { ..._releaseInfo, refreshing: true, error: null };
  _releaseRequest = (async () => {
    try {
      const cfg = await requestJSON(CONFIG_URL, { signal: controller.signal });
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("Invalid Wayback configuration");
      const releases = normalizeReleases(Object.entries(cfg).map(([k, v]) => ({ release: +k,
        date: ((v?.itemTitle || "").match(/\d{4}-\d{2}-\d{2}/) || [""])[0], title: v?.itemTitle })));
      const fetchedAt = Date.now();
      _releases = releases; _releaseInfo = { source: "network", fetchedAt, refreshing: false, error: null };
      try { global.localStorage?.setItem(RELEASE_CACHE_KEY, JSON.stringify({ version: 1, fetchedAt,
        releases: releases.map(({ release, date, title }) => ({ release, date, title })) })); } catch { /* Cache only; user data is untouched. */ }
      return releases;
    } catch (error) { _releaseInfo = { ..._releaseInfo, refreshing: false, error: error.message }; throw error; }
    finally { _releaseController = null; _releaseRequest = null; }
  })();
  return _releaseRequest;
}
async function localChanges(lon, lat, z = 17, { signal, releases } = {}) {
  const rels = releases || await getReleases(), idx = new Map(rels.map((r, i) => [r.release, i]));
  const [x, y] = lonlatToTile(lon, lat, z), found = [];
  let i = 0;
  while (i < rels.length) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const js = await requestJSON(TILEMAP_URL(rels[i].release, z, y, x), { signal });
    if (!js || !Array.isArray(js.data) || ![0, 1].includes(js.data[0])) throw new Error("Invalid Wayback local-change response");
    if (js.data[0] !== 1) break;
    const eff = (js.select && js.select[0]) || rels[i].release;
    if (idx.has(eff) && (!found.length || found[found.length - 1].release !== eff)) found.push(rels[idx.get(eff)]);
    i = Math.max(i + 1, (idx.get(eff) ?? i) + 1);
  }
  return found;
}
let _tileCache = null;
const checkAbort = signal => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
class ImageryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "ImageryError"; this.code = code; Object.assign(this, details); }
}
// A tilemap response may be clipped at a provider bundle boundary. Only the
// returned, validated rectangle is authoritative; unqueried cells stay unknown.
async function checkCoverage(release, zoom, extent, { signal } = {}) {
  const { left, top, width, height } = extent, states = new Uint8Array(width * height);
  const queue = [{ left, top, width, height }], errors = [];
  let checks = 0;
  const started = now();
  while (queue.length) {
    checkAbort(signal);
    const area = queue.shift();
    try {
      ++checks;
      const data = await requestJSON(TILEMAP_URL(release, zoom, area.top, area.left) + `/${area.width}/${area.height}`, { signal, timeoutMs: 10000 });
      const loc = data?.location;
      if (data.valid === false || !loc || loc.left !== area.left || loc.top !== area.top
        || !Number.isSafeInteger(loc.width) || !Number.isSafeInteger(loc.height) || loc.width < 1 || loc.height < 1
        || loc.width > area.width || loc.height > area.height || !Array.isArray(data.data)
        || data.data.length !== loc.width * loc.height || data.data.some(value => value !== 0 && value !== 1))
        throw new Error("Invalid imagery coverage response");
      for (let row = 0; row < loc.height; row++) for (let col = 0; col < loc.width; col++)
        states[(loc.top - top + row) * width + loc.left - left + col] = data.data[row * loc.width + col] ? 1 : 2;
      if (loc.width < area.width) queue.push({ ...area, left: area.left + loc.width, width: area.width - loc.width, height: loc.height });
      if (loc.height < area.height) queue.push({ ...area, top: area.top + loc.height, height: area.height - loc.height });
      // Bound pathological fragmentation. The remaining cells are unknown and
      // fall back to normal timed image requests, never assumed to be absent.
      if (checks >= 32) break;
    } catch (error) { checkAbort(signal); errors.push(error.message); break; }
  }
  const available = states.filter(value => value === 1).length, unavailable = states.filter(value => value === 2).length;
  const unknown = states.length - available - unavailable;
  return { states, total: states.length, available, unavailable, unknown, checks, ms: now() - started,
    status: unavailable === states.length ? "unavailable" : unknown ? "unknown" : unavailable ? "partial" : "full", errors };
}
async function fetchTile(release, z, x, y, signal) {
  const url = TILE_URL(release, z, y, x);
  checkAbort(signal);
  if (_tileCache === null) {
    const cache = ("caches" in global) ? await ownedRead(caches.open("gv-wayback-tiles").catch(() => false), signal) : false;
    checkAbort(signal); _tileCache = cache;
  }
  let cached = _tileCache ? await ownedRead(_tileCache.match(url).catch(() => null), signal) : null;
  checkAbort(signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController(), abort = () => controller.abort();
    let timedOut = false, bitmap, fromCache = Boolean(cached);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, 10000);
    lifecycleStats.tileAttempts++;
    try {
      checkAbort(signal);
      const response = cached || await fetch(url, { signal: controller.signal, mode: "cors" });
      cached = null;
      if (!response.ok) throw new ImageryError(response.status === 404 ? "TILE_UNAVAILABLE" : "TILE_HTTP", `Imagery request returned HTTP ${response.status}`, { httpStatus: response.status });
      const copy = !fromCache && _tileCache ? response.clone() : null;
      const blob = await response.blob();
      checkAbort(signal);
      if (timedOut) throw new ImageryError("TILE_TIMEOUT", "Imagery request timed out");
      try { bitmap = await createImageBitmap(blob); }
      catch { throw new ImageryError("TILE_DECODE", "Imagery response could not be decoded"); }
      checkAbort(signal);
      if (timedOut) throw new ImageryError("TILE_TIMEOUT", "Imagery request timed out");
      if (copy) { lifecycleStats.cacheWrites++; try { await _tileCache.put(url, copy).catch(() => {}); } finally { lifecycleStats.cacheWrites--; } checkAbort(signal); }
      if (timedOut) throw new ImageryError("TILE_TIMEOUT", "Imagery request timed out");
      return { bitmap };
    } catch (error) {
      bitmap?.close(); checkAbort(signal);
      if (fromCache) await _tileCache.delete(url).catch(() => {});
      const code = timedOut ? "TILE_TIMEOUT" : error.code || "TILE_NETWORK";
      const retry = fromCache || code === "TILE_TIMEOUT" || code === "TILE_NETWORK" || (code === "TILE_HTTP" && (error.httpStatus >= 500 || [408, 429].includes(error.httpStatus)));
      if (attempt === 0 && retry) continue;
      return { failure: { code, url, httpStatus: error.httpStatus || null } };
    } finally { lifecycleStats.tileAttempts--; clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
async function pool(items, n, fn) {
  let i = 0, failure;
  const run = async () => { while (!failure && i < items.length) { const k = i++; try { await fn(items[k], k); } catch (error) { failure ||= error; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (failure) throw failure; // All sibling callbacks have drained before cleanup.
}
function validatedBounds(geometry) {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type) || !Array.isArray(geometry.coordinates))
    throw new AllocationError("INVALID_AOI", "AOI must contain Polygon or MultiPolygon coordinates.");
  const polygons = polygonsOf(geometry), bb = [Infinity, Infinity, -Infinity, -Infinity];
  if (!polygons.length) throw new AllocationError("INVALID_AOI", "AOI has no polygons.");
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw new AllocationError("INVALID_AOI", "AOI has an empty polygon.");
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw new AllocationError("INVALID_AOI", "AOI rings need at least four coordinates.");
      for (const point of ring) {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878)
          throw new AllocationError("INVALID_AOI", "AOI coordinates must be finite longitude/latitude within Web Mercator coverage.");
        bb[0] = Math.min(bb[0], point[0]); bb[1] = Math.min(bb[1], point[1]); bb[2] = Math.max(bb[2], point[0]); bb[3] = Math.max(bb[3], point[1]);
      }
      const first = ring[0], last = ring[ring.length - 1]; let area = 0;
      if (first[0] !== last[0] || first[1] !== last[1]) throw new AllocationError("INVALID_AOI", "AOI rings must be closed.");
      for (let i = 1; i < ring.length; i++) area += (ring[i - 1][0] - first[0]) * (ring[i][1] - first[1]) - (ring[i][0] - first[0]) * (ring[i - 1][1] - first[1]);
      if (!Number.isFinite(area) || area === 0) throw new AllocationError("INVALID_AOI", "AOI has a zero-area ring.");
    }
  }
  return bb;
}
function rasterLayout(bb, zoom) {
  const world = TILE * 2 ** zoom, clamp = value => Math.max(0, Math.min(world, value));
  const [a, b] = lonlatToPixel(bb[0], bb[3], zoom), [c, d] = lonlatToPixel(bb[2], bb[1], zoom);
  const gx0 = Math.floor(clamp(a)), gy0 = Math.floor(clamp(b)), gx1 = Math.ceil(clamp(c)), gy1 = Math.ceil(clamp(d));
  const width = gx1 - gx0, height = gy1 - gy0, left = Math.floor(gx0 / TILE), top = Math.floor(gy0 / TILE);
  const columns = Math.floor((gx1 - 1) / TILE) - left + 1, rows = Math.floor((gy1 - 1) / TILE) - top + 1;
  return { zoom, res: resAt(zoom), gx0, gy0, width, height, pixels: width * height, tiles: columns * rows,
    extent: { left, top, width: columns, height: rows } };
}
function inferenceBytes(width, height, size, overlap = 256) {
  if (!Number.isSafeInteger(overlap) || overlap < 0) throw new AllocationError("INVALID_LIMIT", "Window overlap must be nonnegative integer pixels.");
  const count = length => { const step = Math.max(size - overlap, 1), n = Math.floor(Math.max(length - size, 0) / step) + 1; return n + ((n - 1) * step + size < length ? 1 : 0); };
  // Include the materialized window index before windows() can build it. This
  // matters for custom inputs smaller than the existing 256px overlap.
  return 16 * size * size + count(width) * count(height) * 64;
}
function estimateRaster(geometry, zoom = 18, options = {}) {
  const limits = limitsFor(options.limits), maxTiles = options.maxTiles ?? 1200, concurrency = options.concurrency ?? 12;
  if (!Number.isInteger(zoom) || zoom < 10 || zoom > 19) throw new AllocationError("INVALID_ZOOM", "Imagery zoom must be a whole number from 10 to 19.");
  if (!Number.isSafeInteger(maxTiles) || maxTiles < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new AllocationError("INVALID_LIMIT", "Tile limit must be positive; tile concurrency must be from 1 to 64.");
  const bb = validatedBounds(geometry); let z = zoom;
  // Preserve the existing conservative tile-selection rule. Memory/dimension
  // limits never choose another zoom. The final z10 footprint is checked too.
  for (; z > 10; z--) {
    const [tx0, ty0] = lonlatToTile(bb[0], bb[3], z), [tx1, ty1] = lonlatToTile(bb[2], bb[1], z);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) break;
  }
  const layout = rasterLayout(bb, z), rgbaBytes = layout.pixels * 4;
  const previewScale = Math.min(1, 4000 / Math.max(layout.width, layout.height));
  const previewWidth = Math.max(1, Math.round(layout.width * previewScale)), previewHeight = Math.max(1, Math.round(layout.height * previewScale));
  const previewBytes = previewWidth * previewHeight * 4;
  const modelSize = options.modelSize ?? (options.detect ? 1024 : 0), mode = options.mode || "clip";
  if (!Number.isSafeInteger(modelSize) || modelSize < 0) throw new AllocationError("INVALID_DIMENSIONS", "Model input size is invalid.");
  const encodedAllowance = Math.ceil(rgbaBytes * 1.02) + 65536, stripBytes = layout.width * Math.min(64, layout.height) * 4;
  const stages = { tiles: rgbaBytes + Math.min(concurrency, layout.tiles) * TILE * TILE * 4 };
  if (options.bounded) {
    const singleBlock = !options.forceBlocks && layout.width <= Math.min(2048, limits.maxDimension) && layout.height <= Math.min(2048, limits.maxDimension) && layout.pixels <= limits.maxPixels;
    const scale = Math.min(1, 2048 / Math.max(layout.width, layout.height), limits.maxDimension / Math.max(layout.width, layout.height), Math.sqrt(limits.maxPixels / layout.pixels));
    const displayWidth = Math.max(1, Math.round(layout.width * scale)), displayHeight = Math.max(1, Math.round(layout.height * scale));
    const cacheBytes = Math.max(TILE * TILE * 4, Math.min(16 * 1048576, Math.floor(limits.maxEstimatedBytes / 8)));
    const candidateBytes = modelSize ? Math.min(32 * 1048576, Math.floor(limits.maxEstimatedBytes / 8)) : 0;
    const estimatedBytes = Math.ceil(cacheBytes + candidateBytes + Math.min(concurrency, layout.tiles) * TILE * TILE * 16
      + displayWidth * displayHeight * 12 + modelSize * modelSize * 16 + 8 * 1048576 + layout.tiles * 64);
    const violations = [];
    if (layout.tiles > maxTiles) violations.push({ code: "TILE_LIMIT", message: `The AOI still needs ${layout.tiles} tiles at z10, above ${maxTiles}. Split it into smaller AOIs.` });
    try { dimensions(TILE, TILE, limits, "Acquisition block"); dimensions(displayWidth, displayHeight, limits, "Display preview"); if (modelSize) dimensions(modelSize, modelSize, limits, "Model input"); }
    catch (error) { violations.push({ code: error.code, message: error.message }); }
    if (!Number.isSafeInteger(layout.pixels) || layout.pixels < 1 || layout.width * 4 + 1 > 262144 || layout.height > 0x7fffffff)
      violations.push({ code: "NATIVE_ROW_LIMIT", message: "Native output dimensions exceed the bounded row writer. Split this AOI." });
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limits.maxEstimatedBytes)
      violations.push({ code: "MEMORY_LIMIT", message: `Bounded working buffers need an estimated ${mib(estimatedBytes)}, exceeding ${mib(limits.maxEstimatedBytes)}. Reduce the AOI/preview or adjust Browser limits.` });
    const spoolBytes = rgbaBytes * (1 + (options.png === false ? 0 : 1.02) + (options.geotiff === false ? 0 : 2.04)) + 1048576;
    if (spoolBytes > (options.maxSpoolBytes ?? 2 * 1024 ** 3)) violations.push({ code: "SPOOL_LIMIT", message: "The native imagery/output estimate exceeds the 2 GiB temporary-storage policy. Split the AOI or select fewer formats." });
    return { ...layout, requestedZoom: zoom, zoomReduced: z !== zoom, maxTiles, concurrency, limits, rgbaBytes, estimatedBytes, spoolBytes,
      bounded: true, blockSide: TILE, singleBlock, maskVersion: singleBlock ? "canvas-v1" : "area-evenodd-v1", displayWidth, displayHeight, cacheBytes, candidateBytes, allowed: !violations.length, violations };
  }
  if (mode === "clip") {
    stages.inference = rgbaBytes + (modelSize ? inferenceBytes(layout.width, layout.height, modelSize, options.overlap) : 0);
    stages.png = rgbaBytes * 2 + encodedAllowance;
    stages.preview = rgbaBytes + encodedAllowance + previewBytes * 3;
    if (options.geotiff !== false) stages.tiff = rgbaBytes + encodedAllowance + previewBytes + encodedAllowance * 3 + stripBytes * 2;
  }
  if (mode === "dataset") stages.chips = rgbaBytes + 1024 * 1024 * 12;
  const estimatedBytes = Math.ceil(Math.max(...Object.values(stages))), violations = [];
  if (layout.tiles > maxTiles) violations.push({ code: "TILE_LIMIT", message: `The AOI still needs ${layout.tiles} tiles at z10, above the ${maxTiles}-tile limit. Split it into smaller AOIs.` });
  try { dimensions(layout.width, layout.height, limits, "AOI raster"); if (mode === "clip") dimensions(previewWidth, previewHeight, limits, "Preview"); if (modelSize) dimensions(modelSize, modelSize, limits, "Model input"); if (mode === "dataset") dimensions(1024, 1024, limits, "Training chip"); }
  catch (error) { violations.push({ code: error.code, message: error.message }); }
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limits.maxEstimatedBytes) violations.push({ code: "MEMORY_LIMIT", message: `Estimated working buffers ${mib(estimatedBytes)} exceed ${mib(limits.maxEstimatedBytes)}. Use a smaller AOI at the same zoom, disable GeoTIFF, or adjust Browser limits.` });
  return { ...layout, requestedZoom: zoom, zoomReduced: z !== zoom, maxTiles, concurrency, limits, rgbaBytes,
    previewWidth, previewHeight, stages, estimatedBytes, allowed: !violations.length, violations };
}
function requireRaster(plan) {
  if (plan.allowed) return plan;
  allocationStats.rejected++; const problem = plan.violations[0];
  throw new AllocationError(problem.code, `z${plan.requestedZoom}${plan.zoomReduced ? " → z" + plan.zoom : ""} · ${plan.width}×${plan.height} px: ${problem.message}`, { estimate: plan, requestedZoom: plan.requestedZoom, zoom: plan.zoom, limits: plan.limits });
}
/** Mosaic Wayback tiles over the AOI and make everything outside the polygon transparent. */
async function buildRaster(geom, release, zoom = 18, opt = {}) {
  checkAbort(opt.signal);
  const plan = requireRaster(estimateRaster(geom, zoom, { ...opt, bounded: false, mode: "raster" }));
  const { zoom: z, res, gx0, gy0, width: w, height: h } = plan;
  const lease = opt.allocation || reserveAllocation("AOI raster", plan.estimatedBytes, plan.limits, true), ownLease = !opt.allocation;
  lease.check(plan.estimatedBytes);
  const tiles = [];
  for (let ty = plan.extent.top; ty < plan.extent.top + plan.extent.height; ty++)
    for (let tx = plan.extent.left; tx < plan.extent.left + plan.extent.width; tx++) tiles.push([tx, ty]);
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false, canvas, retained = false;
  opt.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 120000);
  try {
    checkAbort(opt.signal);
    const extent = { left: tiles[0][0], top: tiles[0][1], width: tiles[tiles.length - 1][0] - tiles[0][0] + 1,
      height: tiles[tiles.length - 1][1] - tiles[0][1] + 1 };
    const { states, ...coverage } = await checkCoverage(release, z, extent, { signal: controller.signal });
    opt.onCoverage?.({ ...coverage, zoom: z, release });
    if (coverage.status === "unavailable") throw new ImageryError("NO_IMAGERY", `No imagery coverage for release ${release} at z${z}. Choose a newer date, or explicitly lower Imagery zoom and rerun this date; detection detail will differ.`, { release, zoom: z, coverage });
    canvas = makeCanvas(w, h, lease); const ctx = ctx2d(canvas);
    let done = 0, missing = 0; const failures = {};
    await pool(tiles, opt.concurrency || 12, async ([tx, ty], index) => {
      try {
        checkAbort(controller.signal);
        const value = states[index] === 2 ? { failure: { code: "TILE_UNAVAILABLE" } } : await fetchTile(release, z, tx, ty, controller.signal);
        try {
          checkAbort(controller.signal);
          if (value.bitmap) ctx.drawImage(value.bitmap, tx * TILE - gx0, ty * TILE - gy0, TILE, TILE);
          else { missing++; const code = value.failure.code; failures[code] = (failures[code] || 0) + 1; coverage.sampleFailure ||= value.failure; }
        } finally { value.bitmap?.close(); }
        ++done; if (opt.onProgress && (done % 10 === 0 || done === tiles.length)) opt.onProgress(done / tiles.length);
      } catch (error) { controller.abort(); throw error; }
    });
    coverage.missing = missing; coverage.failures = failures;
    if (missing === tiles.length) {
      const unavailable = failures.TILE_UNAVAILABLE === tiles.length;
      throw new ImageryError(unavailable ? "NO_IMAGERY" : "IMAGERY_FETCH_FAILED",
        unavailable ? `No imagery tiles available for release ${release} at z${z}. Choose another date or explicitly lower Imagery zoom.`
          : `Could not load imagery for release ${release} at z${z}: ${Object.entries(failures).map(([code, count]) => `${code}: ${count}`).join(", ")}. Coverage is not confirmed absent; check connectivity/provider access and retry.`,
        { release, zoom: z, coverage, failures });
    }
    coverage.status = missing ? "partial" : "full";
    const x0 = -ORIGIN + gx0 * res, y0 = ORIGIN - gy0 * res;
    const rings = polygonsOf(geom).flatMap(p => p.map(ring => ring.map(([lon, lat]) => { const [mx, my] = merc(lon, lat); return [(mx - x0) / res, (y0 - my) / res]; })));
    if (opt.maskVersion === "area-evenodd-v1") {
      await ensureLibrary("streaming", { signal: opt.signal });
      const pixels = ctx.getImageData(0, 0, w, h); await global.GVStreaming.masker(rings)(pixels.data, 0, 0, w, h, opt.signal); ctx.putImageData(pixels, 0, 0);
    } else {
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath(); rings.forEach(r => { r.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); });
    ctx.fillStyle = "#000"; ctx.fill("evenodd");
    ctx.globalCompositeOperation = "source-over";
    }
    retained = true;
    return { canvas, w, h, x0, y0, res, zoom: z, requestedZoom: zoom, rings, tiles: tiles.length, missing, coverage, allocation: lease,
      release() { releaseCanvas(canvas); if (ownLease) lease.release(); } };
  } catch (error) {
    if (opt.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (timedOut) throw new ImageryError("IMAGERY_TIMEOUT", `Imagery loading timed out for release ${release} at z${z}. Retry this date.`, { release, zoom: z });
    if (error.zoom == null) error.zoom = z;
    throw error;
  } finally {
    controller.abort(); clearTimeout(timer); opt.signal?.removeEventListener("abort", abort);
    if (!retained) { releaseCanvas(canvas); if (ownLease) lease.release(); }
  }
}
const pixelToLonLat = (r, px, py) => unmerc(r.x0 + px * r.res, r.y0 - py * r.res);
const groundRes = (r, lat) => r.res * Math.cos(lat * Math.PI / 180);
function rasterBounds(r) { const [a, b] = pixelToLonLat(r, 0, r.h), [c, d] = pixelToLonLat(r, r.w, 0); return [a, b, c, d]; }

// ------------------------------------------------------------------ polygons
const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; } return s / 2; };
const ccw = p => area(p) < 0 ? p.slice().reverse() : p;
function clip(subject, clipPoly) {          // Sutherland–Hodgman, both convex and CCW
  let out = subject;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const [ax, ay] = clipPoly[i], [bx, by] = clipPoly[(i + 1) % clipPoly.length];
    const inside = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
    const cross = (p, q) => { const [x1, y1] = p, [x2, y2] = q, dx = x2 - x1, dy = y2 - y1;
      const t = ((ax - x1) * (by - ay) - (ay - y1) * (bx - ax)) / (dx * (by - ay) - dy * (bx - ax)); return [x1 + t * dx, y1 + t * dy]; };
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      if (inside(q)) { if (!inside(p)) out.push(cross(p, q)); out.push(q); } else if (inside(p)) out.push(cross(p, q));
    }
  }
  return out;
}
const interArea = (p, q) => { const c = clip(p, q); return c.length > 2 ? Math.abs(area(c)) : 0; };
function nms(dets, thr, useMin) {
  const keep = [], byCls = {};
  dets.forEach(d => (byCls[d.cls] = byCls[d.cls] || []).push(d));
  for (const g of Object.values(byCls)) {
    g.sort((a, b) => b.conf - a.conf);
    const kept = [];
    for (const d of g) {
      let ok = true;
      for (const k of kept) {
        if (d.bb[0] > k.bb[2] || k.bb[0] > d.bb[2] || d.bb[1] > k.bb[3] || k.bb[1] > d.bb[3]) continue;
        const inter = interArea(d.poly, k.poly);
        const den = useMin ? Math.min(d.area, k.area) : d.area + k.area - inter;
        if (inter / Math.max(den, 1e-9) > thr) { ok = false; break; }
      }
      if (ok) kept.push(d);
    }
    keep.push(...kept);
  }
  return keep;
}
function mkDet(cls, conf, pts) {
  const poly = ccw(pts), xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  return { cls, conf, poly, area: Math.abs(area(poly)), bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}
async function nmsAsync(dets, thr, useMin, signal) {
  const keep = [], byCls = {}; let comparisons = 0;
  dets.forEach(d => (byCls[d.cls] = byCls[d.cls] || []).push(d));
  for (const group of Object.values(byCls)) {
    group.sort((a, b) => b.conf - a.conf); const kept = [];
    for (const d of group) {
      checkAbort(signal); let ok = true;
      for (const k of kept) {
        if (++comparisons % 512 === 0) await yieldTask(signal);
        if (d.bb[0] > k.bb[2] || k.bb[0] > d.bb[2] || d.bb[1] > k.bb[3] || k.bb[1] > d.bb[3]) continue;
        const inter = interArea(d.poly, k.poly), den = useMin ? Math.min(d.area, k.area) : d.area + k.area - inter;
        if (inter / Math.max(den, 1e-9) > thr) { ok = false; break; }
      }
      if (ok) kept.push(d);
    }
    keep.push(...kept);
  }
  checkAbort(signal); return keep;
}

// ------------------------------------------------------------------ model
const _sessions = new Map();
async function loadModel(spec) {
  checkAbort(spec.signal);
  const owner = operation("Model loading", { signal: spec.signal, timeoutMs: spec.timeoutMs ?? 120000 });
  try { return await loadModelOwned({ ...spec, signal: owner.signal }, owner); }
  catch (error) { owner.check(); throw error; }
  finally { owner.close(); }
}
async function loadModelOwned(spec, owner) {
  // spec: {key, url | buffer, names[], imgsz, signal}
  if (_sessions.has(spec.key)) return _sessions.get(spec.key);
  let src = spec.buffer;
  if (!src) {
    if (!spec.url) throw new Error("No ONNX model file was specified");
    // Fetch once before choosing a provider. ORT reports a missing model URL as
    // "failed to load external data file", hiding the HTTP status and remedy.
    const help = "Export the models with scripts/export_onnx.py before serving the portal. For GitHub Pages, enable Settings → Pages → Source: GitHub Actions and rerun the publish workflow. You can also use Load ONNX model.";
    let response;
    try { response = await fetch(spec.url, { signal: spec.signal, cache: "no-cache" }); }
    catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error(`Could not download ONNX model ${spec.url}: ${e.message}. Check your connection and the model URL.`);
    }
    if (!response.ok) throw new Error(`Could not download ONNX model ${spec.url} (HTTP ${response.status}). ${help}`);
    if ((response.headers.get("content-type") || "").toLowerCase().includes("text/html"))
      throw new Error(`The server returned an HTML page instead of ONNX model ${spec.url}. ${help}`);
    src = new Uint8Array(await response.arrayBuffer()); owner.check();
    if (!src.byteLength) throw new Error(`ONNX model ${spec.url} is empty. ${help}`);
  }
  await ensureLibrary("ort", { signal: spec.signal }); owner.check();
  let session = null, provider = "wasm";
  try {
    if (global.navigator && navigator.gpu) {
      try { session = await ort.InferenceSession.create(src, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" }); provider = "webgpu"; } catch (e) { owner.check(); }
    }
    owner.check();
    if (!session) session = await ort.InferenceSession.create(src, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    owner.check();
  } catch (error) { if (session?.release) await session.release(); throw error; }
  const dims = (session.inputMetadata && session.inputMetadata[0] && session.inputMetadata[0].dimensions) || null;
  const m = { session, provider, names: spec.names || DOTA_NAMES, imgsz: spec.imgsz || (dims && typeof dims[2] === "number" ? dims[2] : 1024), key: spec.key };
  _sessions.set(spec.key, m);
  return m;
}
function windows(h, w, size, overlap) {
  const step = Math.max(size - overlap, 1), ys = [], xs = [];
  for (let y = 0; y <= Math.max(h - size, 0); y += step) ys.push(y);
  for (let x = 0; x <= Math.max(w - size, 0); x += step) xs.push(x);
  if (ys[ys.length - 1] + size < h) ys.push(h - size);
  if (xs[xs.length - 1] + size < w) xs.push(w - size);
  const out = []; ys.forEach(y => xs.forEach(x => out.push([Math.max(x, 0), Math.max(y, 0)]))); return out;
}
function* windowPositions(h, w, size, overlap) {
  const step = Math.max(size - overlap, 1);
  function* axis(length) { let last = 0; for (let p = 0; p <= Math.max(length - size, 0); p += step) { last = p; yield p; } if (last + size < length) yield length - size; }
  for (const y of axis(h)) for (const x of axis(w)) yield [Math.max(x, 0), Math.max(y, 0)];
}
/** Decode a YOLO OBB output [1, 4+nc+1, N] (cx, cy, w, h, scores..., angle). Axis-aligned YOLO [1, 4+nc, N] also works. */
function decode(out, names, conf, wanted, candidatesOnly = false) {
  const [, C, N] = out.dims, d = out.data, obb = C - 4 > names.length, nc = obb ? C - 5 : C - 4, res = [];
  for (let n = 0; n < N; n++) {
    let best = 0, k = -1;
    for (let c = 0; c < nc; c++) { const s = d[(4 + c) * N + n]; if (s > best) { best = s; k = c; } }
    if (best < conf) continue;
    const name = LABELS[names[k]] || names[k] || String(k);
    if (wanted && !wanted.has(name)) continue;
    const cx = d[n], cy = d[N + n], w = d[2 * N + n], h = d[3 * N + n], a = obb ? d[(C - 1) * N + n] : 0;
    const cs = Math.cos(a), sn = Math.sin(a), v1 = [w / 2 * cs, w / 2 * sn], v2 = [-h / 2 * sn, h / 2 * cs];
    res.push(mkDet(name, best, [[cx + v1[0] + v2[0], cy + v1[1] + v2[1]], [cx + v1[0] - v2[0], cy + v1[1] - v2[1]],
      [cx - v1[0] - v2[0], cy - v1[1] - v2[1]], [cx - v1[0] + v2[0], cy - v1[1] + v2[1]]]));
  }
  res.sort((a, b) => b.conf - a.conf);
  return candidatesOnly ? res.slice(0, 3000) : nms(res.slice(0, 3000), 0.45, false);
}
async function detect(r, model, opt = {}) {
  const S = model.imgsz, wanted = opt.classes && opt.classes.length ? new Set(opt.classes) : null;
  const limits = r.allocation?.limits || limitsFor(opt.limits);
  const rasterBytes = r.bounded ? r.workingBytes : dimensions(r.w, r.h, limits, "Detection raster");
  dimensions(S, S, limits, "Model input");
  const needed = rasterBytes + (r.bounded ? S * S * 16 : inferenceBytes(r.w, r.h, S, opt.overlap));
  const lease = r.allocation || reserveAllocation("Detection", needed, limits, true), ownLease = !r.allocation;
  if (lease.estimatedBytes < needed) lease.resize(needed);
  try {
  lease.check(needed);
  const ctx = r.readPixels ? null : ctx2d(r.canvas), all = [], overlap = opt.overlap ?? 256;
  const countAxis = length => { const step = Math.max(S - overlap, 1), count = Math.floor(Math.max(length - S, 0) / step) + 1; return count + ((count - 1) * step + S < length ? 1 : 0); };
  const count = countAxis(r.w) * countAxis(r.h); let i = 0;
  const buf = new Float32Array(3 * S * S), plane = S * S;
  for (const [x, y] of windowPositions(r.h, r.w, S, overlap)) {
    if (opt.signal && opt.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const px = r.readPixels ? await r.readPixels(x, y, S, S) : ctx.getImageData(x, y, S, S).data;
    checkAbort(opt.signal);
    let cover = 0; for (let j = 3; j < px.length; j += 64) if (px[j]) cover++;
    if (cover / (px.length / 64) >= 0.02) {
      for (let j = 0, p = 0; j < plane; j++, p += 4) {
        if (j && j % (S * 64) === 0) await yieldTask(opt.signal);
        buf[j] = px[p] / 255; buf[plane + j] = px[p + 1] / 255; buf[2 * plane + j] = px[p + 2] / 255;
      }
      checkAbort(opt.signal);
      const input = new ort.Tensor("float32", buf, [1, 3, S, S]); let outputs;
      lifecycleStats.tensors++;
      try {
      lifecycleStats.inference++;
      try { outputs = await model.session.run({ [model.session.inputNames[0]]: input }); }
      finally { lifecycleStats.inference--; }
      checkAbort(opt.signal);
      const candidates = decode(outputs[model.session.outputNames[0]], model.names, opt.conf ?? 0.3, wanted, true);
      for (const d of await nmsAsync(candidates, 0.45, false, opt.signal)) {
        const pts = d.poly.map(([a, b]) => [a + x, b + y]);
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
        if (cx < 0 || cy < 0 || cx >= r.w || cy >= r.h || !pointInRings(r.rings, cx, cy) || d.area < 4) continue;
        all.push(mkDet(d.cls, d.conf, pts));
        if (r.bounded && all.length * 2048 > r.candidateBytes) throw new AllocationError("CANDIDATE_LIMIT", "Candidate metadata exceeds the bounded working budget. Split this dense AOI; detections have not been silently truncated.");
      }
      } finally {
        for (const tensor of new Set([input, ...Object.values(outputs || {})])) { try { tensor?.dispose?.(); } catch { lifecycleStats.tensorCleanupFailures = (lifecycleStats.tensorCleanupFailures || 0) + 1; } }
        lifecycleStats.tensors--;
      }
    }
    checkAbort(opt.signal); if (opt.onProgress) opt.onProgress(++i / count);
    await yieldTask(opt.signal);
  }
  return await nmsAsync(all, 0.45, true, opt.signal); // Identical confidence/tie and IoMin suppression rules.
  } finally { if (ownLease) lease.release(); }
}
function toFeatures(dets, r, props) {
  return dets.slice().sort((a, b) => b.conf - a.conf).map((d, i) => {
    const c = d.poly, ll = c.map(([x, y]) => pixelToLonLat(r, x, y)); ll.push(ll[0]);
    const cx = c.reduce((s, p) => s + p[0], 0) / 4, cy = c.reduce((s, p) => s + p[1], 0) / 4, [clon, clat] = pixelToLonLat(r, cx, cy);
    const gr = groundRes(r, clat), e1 = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) * gr, e2 = Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]) * gr;
    const [a, b] = e1 >= e2 ? [c[0], c[1]] : [c[1], c[2]];
    const heading = ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI) + 360) % 180;
    return { type: "Feature", id: `${props.aoi_id}_${props.release}_${String(i).padStart(4, "0")}`,
      geometry: { type: "Polygon", coordinates: [ll.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)])] },
      properties: { ...props, class: d.cls, confidence: +d.conf.toFixed(4), length_m: +Math.max(e1, e2).toFixed(1), width_m: +Math.min(e1, e2).toFixed(1),
        heading_deg: +heading.toFixed(1), centroid: [+clon.toFixed(7), +clat.toFixed(7)], status: "predicted" } };
  });
}
const COLORS = { aircraft: "#f2a516", ship: "#1fb3dc", helicopter: "#ff5aa0", storage_tank: "#7ad65a", large_vehicle: "#ff7a3c", small_vehicle: "#a9a9ff", harbor: "#58d2d2", bridge: "#e6e678" };
async function previewBlob(r, dets, maxSide = 4000) {
  const s = Math.min(1, maxSide / Math.max(r.w, r.h)), c = makeCanvas(Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)), r.allocation);
  try {
    const g = ctx2d(c);
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.drawImage(r.canvas, 0, 0, c.width, c.height);
    g.lineWidth = 2;
    dets.forEach(d => { g.strokeStyle = COLORS[d.cls] || "#fff"; g.beginPath(); d.poly.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)); g.closePath(); g.stroke(); });
    return await canvasBlob(c, "image/jpeg", 0.88);
  } finally { releaseCanvas(c); }
}

// ------------------------------------------------------------------ GeoTIFF writer (RGBA, deflate, EPSG:3857)
function writeGeoTIFF(width, height, getRows, geo, rowsPerStrip = 64, opt = {}) {
  const limits = limitsFor(opt.limits), rgba = dimensions(width, height, limits, "GeoTIFF"), encoded = Math.ceil(rgba * 1.02) + 65536;
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1 || !geo || !Number.isFinite(geo.res) || geo.res <= 0 || !Number.isFinite(geo.x0) || !Number.isFinite(geo.y0))
    throw new AllocationError("INVALID_TIFF", "GeoTIFF strip size or georeferencing is invalid.");
  const stripBytes = width * Math.min(rowsPerStrip, height) * 4;
  const lease = opt.allocation || reserveAllocation("GeoTIFF", encoded * 3 + stripBytes * 2, limits), ownLease = !opt.allocation;
  try {
  const strips = [];
  let compressed = 0;
  for (let y = 0; y < height; y += rowsPerStrip) {
    const count = Math.min(rowsPerStrip, height - y), bytes = getRows(y, count);
    if (!bytes || bytes.byteLength !== width * count * 4) throw new AllocationError("INVALID_TIFF", "GeoTIFF row provider returned an invalid RGBA buffer.");
    const strip = fflate.zlibSync(bytes, { level: 6 }); compressed += strip.byteLength;
    lease.check((opt.baseBytes || 0) + compressed * 3 + stripBytes * 2); strips.push(strip);
  }
  const SHORT = 3, LONG = 4, DOUBLE = 12, size = { 3: 2, 4: 4, 12: 8 };
  let off = 8; const stripOffsets = strips.map(s => { const o = off; off += s.length; return o; });
  if (off % 2) off++;
  const tags = [
    [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, [8, 8, 8, 8]], [259, SHORT, [8]], [262, SHORT, [2]],
    [273, LONG, stripOffsets], [277, SHORT, [4]], [278, LONG, [rowsPerStrip]], [279, LONG, strips.map(s => s.length)],
    [284, SHORT, [1]], [338, SHORT, [2]], [339, SHORT, [1, 1, 1, 1]],
    [33550, DOUBLE, [geo.res, geo.res, 0]], [33922, DOUBLE, [0, 0, 0, geo.x0, geo.y0, 0]],
    [34735, SHORT, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, geo.epsg || 3857]],
  ];
  const ifdOff = off, ifdLen = 2 + tags.length * 12 + 4; let ext = ifdOff + ifdLen;
  const extEntries = tags.map(([, t, v]) => { const n = v.length * size[t]; if (n <= 4) return null; const o = ext; ext += n + (n % 2); return o; });
  if (!Number.isSafeInteger(ext) || ext > 0xffffffff) throw new AllocationError("TIFF_SIZE_LIMIT", "Classic GeoTIFF exceeds its 32-bit file limit. Split this output into smaller AOIs.");
  lease.check((opt.baseBytes || 0) + compressed + ext * 2 + stripBytes);
  const buf = new ArrayBuffer(ext), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  strips.forEach((s, i) => u8.set(s, stripOffsets[i]));
  dv.setUint16(ifdOff, tags.length, true);
  const put = (o, t, v) => { if (t === SHORT) dv.setUint16(o, v, true); else if (t === LONG) dv.setUint32(o, v, true); else dv.setFloat64(o, v, true); };
  tags.forEach(([tag, t, v], i) => {
    const e = ifdOff + 2 + i * 12; dv.setUint16(e, tag, true); dv.setUint16(e + 2, t, true); dv.setUint32(e + 4, v.length, true);
    if (extEntries[i] == null) v.forEach((x, k) => put(e + 8 + k * size[t], t, x));
    else { dv.setUint32(e + 8, extEntries[i], true); v.forEach((x, k) => put(extEntries[i] + k * size[t], t, x)); }
  });
  dv.setUint32(ifdOff + 2 + tags.length * 12, 0, true);
  return new Blob([buf], { type: "image/tiff" });
  } finally { if (ownLease) lease.release(); }
}
function geotiffBlob(r, encodedBytes = 0) {
  const ctx = ctx2d(r.canvas);
  return writeGeoTIFF(r.w, r.h, (y, n) => new Uint8Array(ctx.getImageData(0, y, r.w, n).data.buffer), { res: r.res, x0: r.x0, y0: r.y0 }, 64, { allocation: r.allocation, limits: r.allocation.limits, baseBytes: r.w * r.h * 4 + encodedBytes });
}
const worldFile = r => `${r.res}\n0.0\n0.0\n${-r.res}\n${r.x0 + r.res / 2}\n${r.y0 - r.res / 2}\n`;

// Native acquisition blocks are stored independently. A model window reads the
// original global chip grid across as many blocks as needed; blocks never reset
// window origins or apply local suppression. Native writers consume the same rows.
async function buildTiledRaster(geometry, release, zoom, opt) {
  const plan = opt.plan || requireRaster(estimateRaster(geometry, zoom, { ...opt, bounded: true }));
  if (plan.singleBlock) {
    // A scene which fits one fixed 2048-side block keeps the original Canvas
    // mask verbatim. It still uses row writers, bounded output and cancellation.
    const r = await buildRaster(geometry, release, zoom, { ...opt, maskVersion: "canvas-v1" });
    return { ...r, bounded: true, singleBlock: true, candidateBytes: plan.candidateBytes, workingBytes: plan.estimatedBytes - plan.candidateBytes - (opt.modelSize || 0) ** 2 * 16,
      readPixels: async (x, y, width, height) => { checkAbort(opt.signal); return ctx2d(r.canvas).getImageData(x, y, width, height).data; },
      diagnostics: () => ({ cachedBytes: 0, peakCachedBytes: 0, cacheLimit: plan.cacheBytes, singleBlock: true }),
      release: async () => r.release() };
  }
  const lease = opt.allocation, spool = opt.spool, owner = operation("Imagery loading", { signal: opt.signal, timeoutMs: opt.imageryTimeoutMs ?? 120000 });
  const { width: w, height: h, gx0, gy0, res, extent } = plan;
  const x0 = gx0 * res - ORIGIN, y0 = ORIGIN - gy0 * res;
  const rings = polygonsOf(geometry).flat().map(ring => ring.map(([lon, lat]) => { const [mx, my] = merc(lon, lat); return [(mx - x0) / res, (y0 - my) / res]; }));
  const mask = global.GVStreaming.masker(rings);
  let display, retained = false, failureCause; const cache = new Map(); let cachedBytes = 0, peakCachedBytes = 0;
  const absent = new Uint8Array(plan.tiles);
  try {
    owner.check();
    const { states, ...coverage } = await checkCoverage(release, plan.zoom, extent, { signal: owner.signal });
    owner.check(); opt.onCoverage?.({ ...coverage, zoom: plan.zoom, release });
    if (coverage.status === "unavailable") throw new ImageryError("NO_IMAGERY", `No imagery coverage for release ${release} at z${plan.zoom}. Choose another date or explicitly choose a different imagery zoom.`, { release, zoom: plan.zoom, coverage });
    display = makeCanvas(plan.displayWidth, plan.displayHeight, lease);
    let missing = 0, done = 0; const failures = {};
    const indices = Array.from({ length: plan.tiles }, (_, i) => i);
    await pool(indices, plan.concurrency, async index => {
      let canvas, bitmap;
      try {
        owner.check();
        const tx = extent.left + index % extent.width, ty = extent.top + Math.floor(index / extent.width);
        const tile = states[index] === 2 ? { failure: { code: "TILE_UNAVAILABLE" } } : await fetchTile(release, plan.zoom, tx, ty, owner.signal);
        bitmap = tile.bitmap;
        if (bitmap) lifecycleStats.bitmaps++;
        owner.check();
        if (!bitmap) { absent[index] = 1; missing++; const code = tile.failure.code; failures[code] = (failures[code] || 0) + 1; coverage.sampleFailure ||= tile.failure; }
        else {
          canvas = makeCanvas(TILE, TILE, lease); const ctx = ctx2d(canvas), dx = tx * TILE - gx0, dy = ty * TILE - gy0;
          ctx.drawImage(bitmap, 0, 0, TILE, TILE);
          const sx = Math.max(0, -dx), sy = Math.max(0, -dy), width = Math.min(TILE, w - dx) - sx, height = Math.min(TILE, h - dy) - sy;
          const image = ctx.getImageData(sx, sy, width, height); await mask(image.data, dx + sx, dy + sy, width, height, owner.signal);
          // Use the same browser premultiply/unpremultiply normalization as the
          // whole-image reference before handing bytes to inference or writers.
          ctx.putImageData(image, sx, sy); const data = ctx.getImageData(sx, sy, width, height).data;
          owner.check(); await spool.put("raw", index, data); owner.check();
        }
        owner.check(); opt.onProgress?.(++done / plan.tiles);
      } catch (error) { failureCause ||= error; owner.abort(); throw error; }
      finally { if (bitmap) { bitmap.close(); lifecycleStats.bitmaps--; } releaseCanvas(canvas); }
    });
    Object.assign(coverage, { missing, failures, status: missing ? "partial" : "full" });
    if (missing === plan.tiles) throw new ImageryError("IMAGERY_FETCH_FAILED", "No Wayback images could be fetched or decoded. This does not confirm absent coverage; retry this release.", { release, zoom: plan.zoom, coverage, failures });
    owner.check(); retained = true;
    async function getTile(index) {
      checkAbort(opt.signal); if (absent[index]) return null;
      if (cache.has(index)) { const value = cache.get(index); cache.delete(index); cache.set(index, value); return value; }
      const value = await spool.get("raw", index); checkAbort(opt.signal);
      const data = value?.arrayBuffer ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const dx = (extent.left + index % extent.width) * TILE - gx0, dy = (extent.top + Math.floor(index / extent.width)) * TILE - gy0;
      const sx = Math.max(0, -dx), sy = Math.max(0, -dy), width = Math.min(TILE, w - dx) - sx, height = Math.min(TILE, h - dy) - sy;
      if (data.length !== width * height * 4) throw new ImageryError("INVALID_RAW_BLOCK", "A native imagery block is incomplete");
      while (cache.size && cachedBytes + data.length > plan.cacheBytes) { const key = cache.keys().next().value; cachedBytes -= cache.get(key).data.length; cache.delete(key); }
      const tile = { data, width, sx, sy }; cache.set(index, tile); cachedBytes += data.length; peakCachedBytes = Math.max(peakCachedBytes, cachedBytes); return tile;
    }
    return { w, h, x0, y0, gx0, gy0, res, zoom: plan.zoom, requestedZoom: plan.requestedZoom, rings, coverage, missing, tiles: plan.tiles,
      canvas: display, allocation: lease, bounded: true, candidateBytes: plan.candidateBytes,
      workingBytes: plan.estimatedBytes - plan.candidateBytes - (opt.modelSize || 0) ** 2 * 16,
      diagnostics: () => ({ cachedBytes, peakCachedBytes, cacheLimit: plan.cacheBytes }),
      async readPixels(x, y, width, height) {
        checkAbort(opt.signal);
        if (![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 || width * height * 4 > Math.max(1048576, (opt.modelSize || 1024) ** 2 * 4))
          throw new AllocationError("ROW_BUFFER_LIMIT", "Native read window exceeds the bounded pixel buffer");
        const output = new Uint8ClampedArray(width * height * 4);
        const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(w, x + width), bottom = Math.min(h, y + height);
        for (let ty = Math.floor((gy0 + top) / TILE); ty <= Math.floor((gy0 + bottom - 1) / TILE); ty++) {
          for (let tx = Math.floor((gx0 + left) / TILE); tx <= Math.floor((gx0 + right - 1) / TILE); tx++) {
            const index = (ty - extent.top) * extent.width + tx - extent.left, tile = await getTile(index); if (!tile) continue;
            const a = Math.max(gx0 + left, tx * TILE), b = Math.min(gx0 + right, (tx + 1) * TILE);
            const c = Math.max(gy0 + top, ty * TILE), d = Math.min(gy0 + bottom, (ty + 1) * TILE);
            for (let row = c; row < d; row++) {
              const start = ((row - ty * TILE - tile.sy) * tile.width + a - tx * TILE - tile.sx) * 4;
              output.set(tile.data.subarray(start, start + (b - a) * 4), ((row - gy0 - y) * width + a - gx0 - x) * 4);
            }
          }
        }
        checkAbort(opt.signal); return output;
      },
      async release() { cache.clear(); cachedBytes = 0; releaseCanvas(display); await spool.removeFile("raw"); },
    };
  } catch (error) { error = failureCause || error; if (opt.signal?.aborted) checkAbort(opt.signal); if (error.code !== "NO_IMAGERY" && error.name === "AbortError") owner.check(); throw error; }
  finally { owner.close(); if (!retained) { cache.clear(); releaseCanvas(display); } }
}

async function renderDisplay(r, signal) {
  if (r.singleBlock) return;
  const width = r.canvas.width, height = r.canvas.height, pixels = new Uint8ClampedArray(width * height * 4);
  const xLeft = new Int32Array(width), xRight = new Int32Array(width), fractions = new Float64Array(width);
  for (let x = 0; x < width; x++) { const px = Math.max(0, Math.min(r.w - 1, (x + .5) * r.w / width - .5)); xLeft[x] = Math.floor(px) * 4; xRight[x] = Math.min(r.w - 1, Math.floor(px) + 1) * 4; fractions[x] = px - Math.floor(px); }
  let previousY = -1, previousRow, lastYield = now();
  for (let y = 0; y < height; y++) {
    checkAbort(signal); const py = Math.max(0, Math.min(r.h - 1, (y + .5) * r.h / height - .5)), a = Math.floor(py), b = Math.min(r.h - 1, a + 1), fy = py - a;
    const top = previousY === a ? previousRow : await r.readPixels(0, a, r.w, 1), bottom = b === a ? top : await r.readPixels(0, b, r.w, 1);
    previousY = b; previousRow = bottom;
    for (let x = 0; x < width; x++) {
      const left = xLeft[x], right = xRight[x], fx = fractions[x], a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
      const alpha = top[left + 3] * a + top[right + 3] * b + bottom[left + 3] * c + bottom[right + 3] * d;
      const out = (y * width + x) * 4; pixels[out + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel++) {
        const value = top[left + channel] * top[left + 3] * a + top[right + channel] * top[right + 3] * b + bottom[left + channel] * bottom[left + 3] * c + bottom[right + channel] * bottom[right + 3] * d;
        pixels[out + channel] = alpha ? Math.round(value / alpha) : 0;
      }
    }
    if (now() - lastYield >= 8) { await yieldTask(signal); lastYield = now(); }
  }
  checkAbort(signal); ctx2d(r.canvas).putImageData(new ImageData(pixels, width, height), 0, 0);
}

async function processClipBounded(aoi, rel, opt) {
  const owner = operation("Clip processing", { signal: opt.signal, timeoutMs: opt.timeoutMs ?? 1800000 });
  const started = now(), timings = {}; let stage = started;
  const mark = name => { timings[name] = now() - stage; stage = now(); };
  let raster, spool, lease, complete = false, failure;
  try {
    owner.check();
    const plan = requireRaster(estimateRaster(aoi.geometry, opt.zoom ?? 18, { ...opt, bounded: true, modelSize: opt.model?.imgsz || 0 }));
    opt.onEstimate?.(plan); lease = await acquireAllocation("Bounded AOI clip", plan.estimatedBytes, plan.limits, { signal: owner.signal, onWaiting: opt.onWaiting });
    await ensureLibrary("streaming", { signal: owner.signal }); await ensureLibrary("fflate", { signal: owner.signal }); owner.check();
    spool = await global.GVStreaming.createSpool({ store: opt.store, jobId: opt.jobId, clipId: opt.clipId, signal: owner.signal, maxBytes: opt.maxSpoolBytes });
    mark("prepareMs");
    raster = await buildTiledRaster(aoi.geometry, rel.release, opt.zoom, { ...opt, plan, spool, allocation: lease, signal: owner.signal,
      modelSize: opt.model?.imgsz || 0, onProgress: f => opt.onProgress?.(f * 0.4) }); owner.check();
    mark("imageryMs");
    const name = aoi.properties.name, aoi_id = slug(name), [, clat] = pixelToLonLat(raster, raster.w / 2, raster.h / 2);
    const props = { aoi_id, aoi_name: name, release: rel.release, imagery_date: rel.date, zoom: raster.zoom, gsd_m: +groundRes(raster, clat).toFixed(3),
      source: "Esri Wayback", imagery_coverage: raster.coverage.status, missing_tiles: raster.missing };
    const dets = opt.model ? await detect(raster, opt.model, { classes: opt.classes, conf: opt.conf, signal: owner.signal, onProgress: f => opt.onProgress?.(0.4 + f * 0.4) }) : [];
    mark("detectionMs");
    owner.check(); const features = toFeatures(dets, raster, props), counts = {}; for (const feature of features) counts[feature.properties.class] = (counts[feature.properties.class] || 0) + 1;
    const IO = global.GVStreaming, blobs = { pgw: worldFile(raster) };
    if (opt.png !== false) blobs.png = await IO.png(raster, IO.sink(spool, "png", "image/png", { signal: owner.signal }), { signal: owner.signal });
    mark("pngMs");
    owner.check(); opt.onProgress?.(0.9);
    if (opt.geotiff !== false) blobs.tif = await IO.tiff(raster, IO.sink(spool, "tif", "image/tiff", { signal: owner.signal }), spool, { signal: owner.signal });
    mark("tiffMs");
    await renderDisplay(raster, owner.signal);
    owner.check(); blobs.display = await canvasBlob(raster.canvas, "image/png"); owner.check();
    const context = ctx2d(raster.canvas), sx = raster.canvas.width / raster.w, sy = raster.canvas.height / raster.h;
    context.lineWidth = 2;
    for (const d of dets) { context.strokeStyle = COLORS[d.cls] || "#fff"; context.beginPath(); d.poly.forEach(([x, y], i) => i ? context.lineTo(x * sx, y * sy) : context.moveTo(x * sx, y * sy)); context.closePath(); context.stroke(); }
    blobs.preview = await canvasBlob(raster.canvas, "image/jpeg", 0.88); owner.check();
    if (!blobs.display || !blobs.preview) throw new AllocationError("CANVAS_ENCODING", "Could not encode the bounded display image");
    const bounds = rasterBounds(raster), result = { aoi: name, aoi_id, release: rel.release, date: rel.date, zoom: raster.zoom, bounds, counts, total: features.length,
      tiles: raster.tiles, missing: raster.missing, coverage: raster.coverage, size: [raster.w, raster.h], requestedZoom: plan.requestedZoom,
      displaySize: [raster.canvas.width, raster.canvas.height], maskVersion: plan.maskVersion, artifactSpool: spool.persistent ? spool.id : undefined,
      timings,
      allocation: { estimatedBytes: plan.estimatedBytes, rgbaBytes: plan.rgbaBytes, bounded: true, blockSide: TILE, limits: plan.limits, cache: raster.diagnostics() },
      aoiFeature: aoi, fc: { type: "FeatureCollection", features, properties: { ...props, image_bounds: bounds } }, blobs };
    mark("displayMs"); await raster.release(); raster = null; mark("cleanupMs"); timings.totalMs = now() - started; owner.check(); opt.onProgress?.(1); owner.check();
    if (!blobs.png && !blobs.tif) { await spool.dispose(); spool = null; delete result.artifactSpool; }
    complete = true; return result;
  } catch (error) { try { if (owner.signal.aborted) owner.check(); } catch (reason) { error = reason; } failure = error; throw error; }
  finally {
    try { await cleanupOwned(failure, [async () => { if (raster) await raster.release(); }, async () => { if (!complete && spool) await global.GVStreaming.discard(spool); }]); }
    finally { lease?.release(); owner.close(); }
  }
}

// ------------------------------------------------------------------ process one AOI × release
async function processClip(aoi, rel, opt = {}) {
  checkAbort(opt.signal);
  if (opt.model && (!Number.isSafeInteger(opt.model.imgsz) || opt.model.imgsz < 1)) throw new AllocationError("INVALID_DIMENSIONS", "Model input size is invalid.");
  if (opt.bounded) return processClipBounded(aoi, rel, opt);
  const estimate = requireRaster(estimateRaster(aoi.geometry, opt.zoom ?? 18, { ...opt, overlap: 256, modelSize: opt.model?.imgsz || 0 }));
  const lease = reserveAllocation("AOI clip", estimate.estimatedBytes, estimate.limits, true);
  let r;
  try {
    opt.onEstimate?.(estimate);
    if (opt.geotiff !== false) await ensureLibrary("fflate");
    r = await buildRaster(aoi.geometry, rel.release, opt.zoom, { ...opt, allocation: lease, limits: estimate.limits, onProgress: f => opt.onProgress && opt.onProgress(0.45 * f) });
    const name = aoi.properties.name, aoi_id = slug(name);
    const [, clat] = pixelToLonLat(r, r.w / 2, r.h / 2);
    const props = { aoi_id, aoi_name: name, release: rel.release, imagery_date: rel.date, zoom: r.zoom, gsd_m: +groundRes(r, clat).toFixed(3), source: "Esri Wayback", imagery_coverage: r.coverage.status, missing_tiles: r.missing };
    let dets = [];
    if (opt.model) dets = await detect(r, opt.model, { classes: opt.classes, conf: opt.conf, signal: opt.signal, onProgress: f => opt.onProgress && opt.onProgress(0.45 + 0.45 * f) });
    const feats = toFeatures(dets, r, props), counts = {};
    feats.forEach(f => counts[f.properties.class] = (counts[f.properties.class] || 0) + 1);
    const bounds = rasterBounds(r);
    const png = await canvasBlob(r.canvas, "image/png"), preview = await previewBlob(r, dets);
    if (!png || !preview) throw new AllocationError("CANVAS_ENCODING", "Browser could not encode the clip imagery. Use a smaller AOI and retry.");
    lease.check(estimate.rgbaBytes + png.size + preview.size);
    const blobs = { png, preview, tif: opt.geotiff === false ? null : geotiffBlob(r, png.size + preview.size), pgw: worldFile(r) };
    checkAbort(opt.signal);
    opt.onProgress && opt.onProgress(1);
    return { aoi: name, aoi_id, release: rel.release, date: rel.date, zoom: r.zoom, bounds, counts, total: feats.length,
      tiles: r.tiles, missing: r.missing, coverage: r.coverage, size: [r.w, r.h], requestedZoom: estimate.requestedZoom, allocation: { estimatedBytes: estimate.estimatedBytes, rgbaBytes: estimate.rgbaBytes, limits: estimate.limits }, aoiFeature: aoi,
      fc: { type: "FeatureCollection", features: feats, properties: { ...props, image_bounds: bounds } }, blobs };
  } finally { r?.release(); lease.release(); }
}
const slug = s => String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "aoi";

// ------------------------------------------------------------------ exports
async function exportJobZip(job, extra = {}) {
  if (extra.streaming) return exportJobZipStream(job, extra);
  const lease = reserveAllocation("Job ZIP export", 65536, extra.limits);
  try {
  await ensureLibrary("zip");
  const zip = new JSZip(), root = zip.folder(job.id), all = [], usedPaths = new Set(); let inputBytes = 0;
  const track = value => { inputBytes += typeof value === "string" ? value.length * 3 : value?.size || value?.byteLength || 0; lease.resize(Math.max(65536, inputBytes * 3)); return value; };
  const paths = job.results.map((r, index) => {
    const base = `${r.aoi_id}/${r.date || r.release}`; let path = base, suffix = index;
    while (usedPaths.has(path)) path = base + "__clip_" + suffix++;
    usedPaths.add(path); return path;
  });
  for (const [index, descriptor] of job.results.entries()) {
    const r = extra.readResult ? await extra.readResult(descriptor) : descriptor;
    const f = root.folder(paths[index]);
    const fc = r.draftFC || r.fc;
    if (r.blobs.tif) f.file("image.tif", track(r.blobs.tif));
    f.file("image.png", track(r.blobs.png)); f.file("image.pgw", track(r.blobs.pgw)); f.file("image.prj", track(WKT_3857));
    f.file("preview_detections.jpg", track(r.blobs.preview));
    f.file("detections.geojson", track(JSON.stringify(fc)));
    f.file("aoi.geojson", track(JSON.stringify(r.aoiFeature)));
    all.push(...fc.features);
  }
  root.file("all_detections.geojson", track(JSON.stringify({ type: "FeatureCollection", features: all })));
  root.file("aois.geojson", track(JSON.stringify({ type: "FeatureCollection", features: job.aois })));
  root.file("summary.json", track(JSON.stringify({ job: job.id, status: job.status, params: job.params, outcomes: job.outcomes || [],
    results: job.results.map((r, index) => ({ aoi: r.aoi, date: r.date, release: r.release, zoom: r.zoom, bounds: r.bounds, counts: r.counts, total: r.total,
      clipId: r.storeId, tiles: r.tiles, missing: r.missing, coverage: r.coverage, path: paths[index] })), ...extra }, null, 2)));
  return await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } }, extra.onProgress);
  } finally { lease.release(); }
}
/** YOLO-OBB dataset from reviewed annotations (rejected objects are left unlabeled = negatives). */
async function exportDataset(annFC, opt = {}) {
  if (opt.streaming) return exportDatasetStream(annFC, opt);
  const feats = annFC.features.filter(f => f.properties.status !== "rejected" && f.properties.class && f.properties.release);
  if (!feats.length) throw new Error("No reviewed objects yet");
  const classes = [...new Set(feats.map(f => f.properties.class))].sort(), cid = Object.fromEntries(classes.map((c, i) => [c, i]));
  const groups = new Map(), chip = 1024;
  feats.forEach(f => validatedBounds(f.geometry));
  feats.forEach(f => { const p = f.properties, c = f.properties.centroid || centroidOf(f.geometry);
    const k = `${p.release}|${p.zoom || 18}|${Math.round(c[0] / 0.02)}|${Math.round(c[1] / 0.02)}`; (groups.get(k) || groups.set(k, []).get(k)).push(f); });
  const plans = [];
  for (const [k, items] of groups) {
    const [rel, z] = k.split("|").map(Number);
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    items.forEach(f => { const b = bboxOf(f.geometry); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
    const pad = 0.0015, poly = { type: "Polygon", coordinates: [[[bb[0] - pad, bb[1] - pad], [bb[2] + pad, bb[1] - pad], [bb[2] + pad, bb[3] + pad], [bb[0] - pad, bb[3] + pad], [bb[0] - pad, bb[1] - pad]]] };
    const estimate = requireRaster(estimateRaster(poly, z, { maxTiles: opt.maxTiles ?? 1200, limits: opt.limits, mode: "dataset" }));
    plans.push({ poly, rel, z, items, estimate });
  }
  checkAbort(opt.signal);
  const limits = limitsFor(opt.limits), lease = reserveAllocation("Training dataset", Math.max(...plans.map(plan => plan.estimate.estimatedBytes)), limits, true);
  try {
  await ensureLibrary("zip");
  const zip = new JSZip(), ds = zip.folder("dataset");
  let n = 0, gi = 0, firstChip = null, archiveBytes = 0;
  const retain = value => { archiveBytes += typeof value === "string" ? value.length * 3 : value.size; return value; };
  for (const { poly, rel, z, items, estimate } of plans) {
    lease.resize(estimate.estimatedBytes + archiveBytes * 3);
    opt.onEstimate?.(estimate);
    const r = await buildRaster(poly, rel, z, { maxTiles: opt.maxTiles ?? 1200, limits, signal: opt.signal, allocation: lease });
    try {
    if (r.missing) throw new ImageryError("INCOMPLETE_TRAINING_IMAGERY", "Training export needs complete imagery. Missing tiles must not become negative examples; choose another date or retry.");
    const objs = items.map(f => ({ k: cid[f.properties.class], pts: minRect(f.geometry.coordinates[0].slice(0, -1).map(([lon, lat]) => { const [mx, my] = merc(lon, lat); return [(mx - r.x0) / r.res, (r.y0 - my) / r.res]; })) }));
    for (const [x, y] of windows(r.h, r.w, chip, 200)) {
      checkAbort(opt.signal);
      const lines = objs.filter(o => { const cx = o.pts.reduce((s, p) => s + p[0], 0) / 4, cy = o.pts.reduce((s, p) => s + p[1], 0) / 4; return cx >= x && cx < x + chip && cy >= y && cy < y + chip; })
        .map(o => o.k + " " + o.pts.map(([px, py]) => [(px - x) / chip, (py - y) / chip].map(v => Math.min(Math.max(v, 0), 1).toFixed(6)).join(" ")).join(" "));
      const c = makeCanvas(chip, chip, lease);
      try {
      const g = ctx2d(c); g.fillStyle = "#000"; g.fillRect(0, 0, chip, chip); g.drawImage(r.canvas, -x, -y);
      const split = (n % 7 === 6) ? "val" : "train", stem = `r${rel}_z${r.zoom}_${String(n).padStart(5, "0")}`;
      const jpg = await canvasBlob(c, "image/jpeg", 0.92);
      if (!jpg) throw new AllocationError("CANVAS_ENCODING", "Browser could not encode a training chip.");
      retain(jpg); retain(lines.join("\n"));
      lease.resize(estimate.estimatedBytes + archiveBytes * 3);
      ds.file(`images/${split}/${stem}.jpg`, jpg);
      ds.file(`labels/${split}/${stem}.txt`, lines.join("\n"));
      if (!firstChip && lines.length) firstChip = { stem, jpg, txt: lines.join("\n") };
      n++;
      } finally { releaseCanvas(c); }
    }
    } finally { r.release(); }
    opt.onProgress && opt.onProgress(++gi / groups.size);
  }
  if (n < 7 && firstChip) {                       // tiny sets have no val chip yet: reuse one labelled chip
    retain(firstChip.jpg); retain(firstChip.txt);
    ds.file(`images/val/${firstChip.stem}.jpg`, firstChip.jpg); ds.file(`labels/val/${firstChip.stem}.txt`, firstChip.txt);
  }
  ds.file("data.yaml", `path: .\ntrain: images/train\nval: images/val\nnames:\n${classes.map((c, i) => `  ${i}: ${c}`).join("\n")}\n`);
  ds.file("annotations.geojson", retain(JSON.stringify(annFC)));
  ds.file("TRAIN.md", `# Train and bring the model back to the portal

pip install ultralytics
cd dataset
yolo obb train data=data.yaml model=yolo11n-obb.pt imgsz=1024 epochs=50 batch=4
yolo export model=runs/obb/train/weights/best.pt format=onnx imgsz=1024 opset=17 simplify=True

Then in the portal: Detect > Load ONNX model > pick best.onnx.
Class names, in order: ${classes.join(", ")}

No GPU? Upload this folder to Google Colab or Kaggle and run the same commands.
`);
  lease.resize(Math.max(65536, archiveBytes * 3 + 65536));
  return { blob: await zip.generateAsync({ type: "blob" }), chips: n, classes };
  } finally { lease.release(); }
}
function centroidOf(g) { const r = polygonsOf(g)[0][0]; return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; }
function minRect(pts) {                          // minimum-area rotated rectangle (rotating calipers over hull edges)
  const hull = convexHull(pts); if (hull.length < 3) return [pts[0], pts[0], pts[0], pts[0]];
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length], L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    hull.forEach(([x, y]) => { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); });
    const ar = (a1 - a0) * (b1 - b0);
    if (!best || ar < best.ar) best = { ar, pts: [[a0, b0], [a1, b0], [a1, b1], [a0, b1]].map(([a, b]) => [a * ux - b * uy, a * uy + b * ux]) };
  }
  return best.pts;
}
function convexHull(p) {
  p = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

async function exportOutput(name, opt, produce) {
  const owner = operation("Export", { signal: opt.signal, timeoutMs: opt.timeoutMs ?? 1800000 });
  let spool, writer, lease, keep = false, failure;
  try {
    owner.check();
    lease = opt.processing ? await acquireAllocation("Bounded dataset", opt.estimatedBytes, opt.limits, { signal: owner.signal, onWaiting: opt.onWaiting }) : reserveAllocation("Streaming export", opt.estimatedBytes || 8 * 1048576, opt.limits);
    await ensureLibrary("streaming", { signal: owner.signal }); await ensureLibrary("fflate", { signal: owner.signal }); owner.check();
    const IO = global.GVStreaming;
    spool = await IO.createSpool({ store: opt.store, jobId: opt.jobId, signal: owner.signal, maxBytes: opt.maxSpoolBytes });
    const output = IO.output(spool, { name, signal: owner.signal, destination: opt.destination, partBytes: opt.partBytes });
    writer = opt.archive === false ? output : IO.zip(output, { signal: owner.signal });
    await produce(writer, { spool, lease, signal: owner.signal, IO }); owner.check();
    const result = await writer.close(); owner.check();
    if (result.parts?.length === 1) {
      lease.resize(Math.max(lease.estimatedBytes, result.parts[0].size * 3 + 8 * 1048576));
      const blob = await IO.materialize(result.parts[0], { store: opt.store, signal: owner.signal }); owner.check(); return new Blob([blob], { type: name.endsWith(".zip") ? "application/zip" : "text/csv" });
    }
    keep = Boolean(result.parts?.length); return result;
  } catch (error) { try { if (owner.signal.aborted) owner.check(); } catch (reason) { error = reason; } failure = error; throw error; }
  finally {
    try { await cleanupOwned(failure, [async () => { await writer?.abort?.(); if (!writer) await opt.destination?.abort?.(); }, async () => { if (!keep && spool) await global.GVStreaming.discard(spool); }]); }
    finally { lease?.release(); owner.close(); }
  }
}
function exportPaths(results) {
  const seen = new Set(); return results.map((r, index) => {
    const base = `${r.aoi_id}/${r.date || r.release}`; let path = base, suffix = index;
    while (seen.has(path)) path = base + "__clip_" + suffix++;
    seen.add(path); return path;
  });
}
async function exportJobZipStream(job, opt = {}) {
  const allPaths = exportPaths(job.results), selected = job.results.map((r, index) => ({ r, index })).filter(({ r }) => !opt.clipId || r.storeId === opt.clipId);
  const results = selected.map(({ r }) => r);
  if (opt.clipId && !results.length) throw new Error("Select a completed clip to export");
  const paths = selected.map(({ index }) => allPaths[index]), root = String(job.id), readResult = opt.readResult || (async r => r);
  return exportOutput(opt.name || `geovision_${job.id}.zip`, { ...opt, jobId: "export:" + job.id }, async (writer, { signal, IO }) => {
    for (const [index, descriptor] of results.entries()) {
      checkAbort(signal); const r = await readResult(descriptor); checkAbort(signal); const base = root + "/" + paths[index];
      const fc = r.draftFC || r.fc, properties = { ...fc }; delete properties.features;
      for (const [kind, name] of [["png", "image.png"], ["tif", "image.tif"], ["display", "display.png"], ["preview", "preview_detections.jpg"]])
        if (r.blobs[kind]) await writer.add(base + "/" + name, IO.source(r.blobs[kind], { store: opt.store, signal }));
      await writer.add(base + "/image.pgw", r.blobs.pgw, { compress: true }); await writer.add(base + "/image.prj", WKT_3857, { compress: true });
      await writer.add(base + "/detections.geojson", IO.collection(fc.features, properties), { compress: true });
      await writer.add(base + "/aoi.geojson", JSON.stringify(r.aoiFeature), { compress: true });
      opt.onProgress?.({ percent: (index + 1) / Math.max(results.length, 1) * 90 });
    }
    async function* allFeatures() {
      for (const descriptor of results) { checkAbort(signal); const r = await readResult(descriptor); checkAbort(signal); yield* (r.draftFC || r.fc).features; }
    }
    await writer.add(root + "/all_detections.geojson", IO.collection(allFeatures()), { compress: true });
    await writer.add(root + "/aois.geojson", IO.collection(job.aois), { compress: true });
    const summary = { job: job.id, status: job.status, params: job.params, outcomes: job.outcomes || [],
      results: results.map((r, i) => ({ aoi: r.aoi, date: r.date, release: r.release, zoom: r.zoom, requestedZoom: r.requestedZoom, bounds: r.bounds,
        size: r.size, displaySize: r.displaySize, counts: r.counts, total: r.total, clipId: r.storeId, tiles: r.tiles, missing: r.missing, coverage: r.coverage, path: paths[i] })) };
    await writer.add(root + "/summary.json", JSON.stringify(summary), { compress: true }); opt.onProgress?.({ percent: 100 });
  });
}
async function exportDatasetStream(annFC, opt = {}) {
  const features = annFC.features.filter(f => f.properties.status !== "rejected" && f.properties.class && f.properties.release);
  if (!features.length) throw new Error("No reviewed objects yet");
  const classes = [...new Set(features.map(f => f.properties.class))].sort(), classesByName = Object.fromEntries(classes.map((c, i) => [c, i])), groups = new Map();
  for (const feature of features) {
    validatedBounds(feature.geometry); const p = feature.properties, c = p.centroid || centroidOf(feature.geometry);
    const key = `${p.release}|${p.zoom || 18}|${Math.round(c[0] / .02)}|${Math.round(c[1] / .02)}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(feature);
  }
  const plans = [];
  for (const [key, items] of groups) {
    const [release, zoom] = key.split("|").map(Number), bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of items) { const bounds = bboxOf(feature.geometry); bb[0] = Math.min(bb[0], bounds[0]); bb[1] = Math.min(bb[1], bounds[1]); bb[2] = Math.max(bb[2], bounds[2]); bb[3] = Math.max(bb[3], bounds[3]); }
    const pad = .0015, geometry = { type: "Polygon", coordinates: [[[bb[0] - pad, bb[1] - pad], [bb[2] + pad, bb[1] - pad], [bb[2] + pad, bb[3] + pad], [bb[0] - pad, bb[3] + pad], [bb[0] - pad, bb[1] - pad]]] };
    const plan = requireRaster(estimateRaster(geometry, zoom, { ...opt, bounded: true, modelSize: 1024, png: false, geotiff: false }));
    plans.push({ release, zoom, geometry, items, plan });
  }
  let chips = 0, first = null, groupIndex = 0;
  const blob = await exportOutput(opt.name || "geovision_dataset.zip", { ...opt, processing: true, estimatedBytes: plans.reduce((n, p) => Math.max(n, p.plan.estimatedBytes), 0) }, async (writer, { signal, spool, lease, IO }) => {
    for (const { release, zoom, geometry, items, plan } of plans) {
      checkAbort(signal); opt.onEstimate?.(plan);
      const r = await buildTiledRaster(geometry, release, zoom, { ...opt, plan, spool, allocation: lease, modelSize: 1024, signal });
      try {
        if (r.missing) throw new ImageryError("INCOMPLETE_TRAINING_IMAGERY", "Training export needs complete imagery; missing tiles must not become negative examples.");
        const objects = items.map(f => ({ k: classesByName[f.properties.class], pts: minRect(f.geometry.coordinates[0].slice(0, -1).map(([lon, lat]) => { const [mx, my] = merc(lon, lat); return [(mx - r.x0) / r.res, (r.y0 - my) / r.res]; })) }));
        for (const [x, y] of windowPositions(r.h, r.w, 1024, 200)) {
          checkAbort(signal);
          const lines = objects.filter(o => { const cx = o.pts.reduce((s, p) => s + p[0], 0) / 4, cy = o.pts.reduce((s, p) => s + p[1], 0) / 4; return cx >= x && cx < x + 1024 && cy >= y && cy < y + 1024; })
            .map(o => o.k + " " + o.pts.map(([px, py]) => [(px - x) / 1024, (py - y) / 1024].map(v => Math.min(Math.max(v, 0), 1).toFixed(6)).join(" ")).join(" "));
          const canvas = makeCanvas(1024, 1024, lease);
          try {
            const data = await r.readPixels(x, y, 1024, 1024); checkAbort(signal); const ctx = ctx2d(canvas);
            ctx.putImageData(new ImageData(data, 1024, 1024), 0, 0); ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 1024, 1024); ctx.globalCompositeOperation = "source-over";
            const jpg = await canvasBlob(canvas, "image/jpeg", .92); checkAbort(signal); if (!jpg) throw new Error("Could not encode a training chip");
            const split = chips % 7 === 6 ? "val" : "train", stem = `r${release}_z${r.zoom}_${String(chips).padStart(5, "0")}`;
            await writer.add(`dataset/images/${split}/${stem}.jpg`, IO.source(jpg, { signal })); await writer.add(`dataset/labels/${split}/${stem}.txt`, lines.join("\n"), { compress: true });
            if (!first && lines.length && chips < 7) first = { stem, jpg, text: lines.join("\n") }; chips++; if (chips >= 7) first = null;
          } finally { releaseCanvas(canvas); }
        }
      } finally { await r.release(); }
      opt.onProgress?.(++groupIndex / plans.length);
    }
    // Preserve the historical split policy here. GMD-018 owns its correction.
    if (chips < 7 && first) { await writer.add(`dataset/images/val/${first.stem}.jpg`, IO.source(first.jpg, { signal })); await writer.add(`dataset/labels/val/${first.stem}.txt`, first.text, { compress: true }); }
    await writer.add("dataset/data.yaml", `path: .\ntrain: images/train\nval: images/val\nnames:\n${classes.map((name, i) => `  ${i}: ${name}`).join("\n")}\n`, { compress: true });
    const properties = { ...annFC }; delete properties.features;
    await writer.add("dataset/annotations.geojson", IO.collection(annFC.features, properties), { compress: true });
    await writer.add("dataset/TRAIN.md", `# Train and bring the model back to the portal\n\npip install ultralytics\ncd dataset\nyolo obb train data=data.yaml model=yolo11n-obb.pt imgsz=1024 epochs=50 batch=4\nyolo export model=runs/obb/train/weights/best.pt format=onnx imgsz=1024 opset=17 simplify=True\n\nThen in the portal: Detect > Load ONNX model > pick best.onnx.\nClass names, in order: ${classes.join(", ")}\n\nNo GPU? Upload this folder to Google Colab or Kaggle and run the same commands.\n`, { compress: true });
  });
  return { blob, chips, classes };
}
async function exportCSV(job, opt = {}) {
  const columns = ["id", "aoi_name", "imagery_date", "release", "class", "status", "confidence", "length_m", "width_m", "heading_deg", "lon", "lat"];
  return exportOutput(opt.name || "detections.csv", { ...opt, archive: false }, async (output, { signal, IO }) => {
    await output.write(fflate.strToU8(columns.join(",") + "\n"));
    for (const descriptor of job.results) {
      checkAbort(signal); const r = opt.readResult ? await opt.readResult(descriptor) : descriptor;
      for (const feature of r.fc.features) {
        const p = feature.properties, c = p.centroid || [0, 0], line = columns.map(k => k === "id" ? feature.id : k === "lon" ? c[0] : k === "lat" ? c[1] : p[k] ?? "")
          .map(value => /[,"\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : value).join(",") + "\n";
        for await (const chunk of IO.source(line, { signal })) await output.write(chunk);
      }
      await yieldTask(signal);
    }
  });
}
async function exportPart(artifact, { store, limits, signal, retainLease = false } = {}) {
  const lease = reserveAllocation("Download part", Math.max(1048576, artifact.size * 3), limits, false, "download");
  let handed = false;
  try { checkAbort(signal); await ensureLibrary("streaming", { signal }); const blob = await global.GVStreaming.materialize(artifact, { store, signal }); if (retainLease) { handed = true; return { blob, release: () => lease.release() }; } return blob; }
  finally { if (!handed) lease.release(); }
}

const allocationDiagnostics = () => ({ ...allocationStats, reservedBytes: [...allocationLeases.values()].reduce((sum, lease) => sum + lease.estimatedBytes, 0),
  activeOperations: [...allocationLeases.values()].map(lease => ({ id: lease.id, label: lease.label, estimatedBytes: lease.estimatedBytes, canvasBytes: lease.canvasBytes, processing: lease.processing, kind: lease.kind })), waiting: allocationWaiters.size, limits: { ...allocationDefaults }, maxConcurrentProcessing: 1, maxConcurrentDownloads: 4 });
const allocations = { defaults: DEFAULT_LIMITS, limits: () => ({ ...allocationDefaults }), configure(values) { allocationDefaults = limitsFor({ ...DEFAULT_LIMITS, ...values }); return { ...allocationDefaults }; },
  dimensions, pngDimensions, reserve: reserveAllocation, acquire: acquireAllocation, download: (bytes, limits) => reserveAllocation("Download", Math.max(65536, bytes * 3), limits, false, "download"), makeCanvas, releaseCanvas, requireRaster, diagnostics: allocationDiagnostics };
const operationDiagnostics = () => ({ ...lifecycleStats, active: [...activeOperations.values()].map(({ id, label, signal }) => ({ id, label, aborted: signal.aborted })) });
global.GVEngine = { getReleases, localChanges, releaseCacheInfo, cancelReleaseRefresh, requestJSON, ensureLibrary, markStartup, estimateRaster, allocations,
  mapSearch: { parseCoordinates: parseMapCoordinates, suggest: suggestMapPlaces, find: findMapPlace, currentLocation: currentMapLocation },
  operations: { open: operation, check: checkAbort, yield: yieldTask, read: ownedRead, diagnostics: operationDiagnostics },
  diagnostics: () => ({ startup: { ...startup }, dependencies: JSON.parse(JSON.stringify(dependencyTimings)), metadata: releaseCacheInfo(), allocations: allocationDiagnostics(), operations: operationDiagnostics(), streaming: global.GVStreaming?.diagnostics() || null }),
  buildRaster, checkCoverage, loadModel, detect, toFeatures, processClip, exportJobZip, exportDataset, exportCSV, exportPart,
  writeGeoTIFF, decode, nms, minRect, windows, slug, merc, unmerc, lonlatToPixel, uniqueAois, DOTA_NAMES, LABELS, WKT_3857, TILE_URL };
})(typeof window !== "undefined" ? window : globalThis);
