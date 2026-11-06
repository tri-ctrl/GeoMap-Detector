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
function ensureLibrary(name) {
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
async function requestJSON(url, options = {}) {
  const { signal, timeoutMs = 20000, ...init } = options, controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}): ${url}`);
    const json = await response.json();
    if (controller.signal.aborted) throw new DOMException("Request cancelled or timed out", "AbortError");
    return json;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
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
    const key = JSON.stringify(f);
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

// ------------------------------------------------------------------ canvas helpers
const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
};
const ctx2d = c => c.getContext("2d", { willReadFrequently: true });
const canvasBlob = (c, type = "image/png", q) => c.convertToBlob ? c.convertToBlob({ type, quality: q })
  : new Promise(ok => c.toBlob(ok, type, q));

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
async function localChanges(lon, lat, z = 17, { signal } = {}) {
  const rels = await getReleases(), idx = new Map(rels.map((r, i) => [r.release, i]));
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
  if (_tileCache === null) _tileCache = ("caches" in global) ? await caches.open("gv-wayback-tiles").catch(() => false) : false;
  let cached = _tileCache ? await _tileCache.match(url).catch(() => null) : null;
  checkAbort(signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController(), abort = () => controller.abort();
    let timedOut = false, bitmap, fromCache = Boolean(cached);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, 10000);
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
      if (copy) _tileCache.put(url, copy).catch(() => {});
      return { bitmap };
    } catch (error) {
      bitmap?.close(); checkAbort(signal);
      if (fromCache) await _tileCache.delete(url).catch(() => {});
      const code = timedOut ? "TILE_TIMEOUT" : error.code || "TILE_NETWORK";
      const retry = fromCache || code === "TILE_TIMEOUT" || code === "TILE_NETWORK" || (code === "TILE_HTTP" && (error.httpStatus >= 500 || [408, 429].includes(error.httpStatus)));
      if (attempt === 0 && retry) continue;
      return { failure: { code, url, httpStatus: error.httpStatus || null } };
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
async function pool(items, n, fn) {
  let i = 0, failure;
  const run = async () => { while (!failure && i < items.length) { const k = i++; try { await fn(items[k], k); } catch (error) { failure ||= error; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (failure) throw failure; // All sibling callbacks have drained before cleanup.
}
function pickZoom(bb, zoom, maxTiles) {
  for (let z = zoom; z > 10; z--) {
    const [tx0, ty0] = lonlatToTile(bb[0], bb[3], z), [tx1, ty1] = lonlatToTile(bb[2], bb[1], z);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) return z;
  }
  return 10;
}
/** Mosaic Wayback tiles over the AOI and make everything outside the polygon transparent. */
async function buildRaster(geom, release, zoom = 18, opt = {}) {
  const bb = bboxOf(geom), z = pickZoom(bb, zoom, opt.maxTiles || 1200), res = resAt(z);
  let [gx0, gy0] = lonlatToPixel(bb[0], bb[3], z), [gx1, gy1] = lonlatToPixel(bb[2], bb[1], z);
  gx0 = Math.floor(gx0); gy0 = Math.floor(gy0); gx1 = Math.ceil(gx1); gy1 = Math.ceil(gy1);
  const w = gx1 - gx0, h = gy1 - gy0;
  if (w < 1 || h < 1) throw new ImageryError("INVALID_AOI", "AOI has no image area", { release, zoom: z });
  const tiles = [];
  for (let ty = Math.floor(gy0 / TILE); ty <= Math.floor((gy1 - 1) / TILE); ty++)
    for (let tx = Math.floor(gx0 / TILE); tx <= Math.floor((gx1 - 1) / TILE); tx++) tiles.push([tx, ty]);
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
    canvas = makeCanvas(w, h); const ctx = ctx2d(canvas);
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
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath(); rings.forEach(r => { r.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); });
    ctx.fillStyle = "#000"; ctx.fill("evenodd");
    ctx.globalCompositeOperation = "source-over";
    retained = true;
    return { canvas, w, h, x0, y0, res, zoom: z, release, rings, tiles: tiles.length, missing, coverage };
  } catch (error) {
    if (opt.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (timedOut) throw new ImageryError("IMAGERY_TIMEOUT", `Imagery loading timed out for release ${release} at z${z}. Retry this date.`, { release, zoom: z });
    if (error.zoom == null) error.zoom = z;
    throw error;
  } finally {
    controller.abort(); clearTimeout(timer); opt.signal?.removeEventListener("abort", abort);
    if (canvas && !retained) canvas.width = canvas.height = 1;
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

// ------------------------------------------------------------------ model
const _sessions = new Map();
async function loadModel(spec) {
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
    src = new Uint8Array(await response.arrayBuffer());
    if (!src.byteLength) throw new Error(`ONNX model ${spec.url} is empty. ${help}`);
  }
  await ensureLibrary("ort");
  if (spec.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  let session = null, provider = "wasm";
  if (global.navigator && navigator.gpu) {
    try { session = await ort.InferenceSession.create(src, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" }); provider = "webgpu"; } catch (e) { session = null; }
  }
  if (!session) session = await ort.InferenceSession.create(src, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
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
/** Decode a YOLO OBB output [1, 4+nc+1, N] (cx, cy, w, h, scores..., angle). Axis-aligned YOLO [1, 4+nc, N] also works. */
function decode(out, names, conf, wanted) {
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
  return nms(res.slice(0, 3000), 0.45, false);
}
async function detect(r, model, opt = {}) {
  const S = model.imgsz, wanted = opt.classes && opt.classes.length ? new Set(opt.classes) : null;
  const ctx = ctx2d(r.canvas), wins = windows(r.h, r.w, S, opt.overlap ?? 256), all = [];
  const buf = new Float32Array(3 * S * S), plane = S * S;
  for (let i = 0; i < wins.length; i++) {
    if (opt.signal && opt.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const [x, y] = wins[i], px = ctx.getImageData(x, y, S, S).data;
    let cover = 0; for (let j = 3; j < px.length; j += 64) if (px[j]) cover++;
    if (cover / (px.length / 64) >= 0.02) {
      for (let j = 0, p = 0; j < plane; j++, p += 4) { buf[j] = px[p] / 255; buf[plane + j] = px[p + 1] / 255; buf[2 * plane + j] = px[p + 2] / 255; }
      const feeds = { [model.session.inputNames[0]]: new ort.Tensor("float32", buf, [1, 3, S, S]) };
      const out = (await model.session.run(feeds))[model.session.outputNames[0]];
      for (const d of decode(out, model.names, opt.conf ?? 0.3, wanted)) {
        const pts = d.poly.map(([a, b]) => [a + x, b + y]);
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
        if (cx < 0 || cy < 0 || cx >= r.w || cy >= r.h || !pointInRings(r.rings, cx, cy) || d.area < 4) continue;
        all.push(mkDet(d.cls, d.conf, pts));
      }
    }
    if (opt.onProgress) opt.onProgress((i + 1) / wins.length);
    await new Promise(res => setTimeout(res, 0));   // keep the page responsive
  }
  return nms(all, 0.45, true);                       // IoMin removes tile-overlap duplicates
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
  const s = Math.min(1, maxSide / Math.max(r.w, r.h)), c = makeCanvas(Math.round(r.w * s), Math.round(r.h * s)), g = c.getContext("2d");
  try {
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.drawImage(r.canvas, 0, 0, c.width, c.height);
    g.lineWidth = 2;
    dets.forEach(d => { g.strokeStyle = COLORS[d.cls] || "#fff"; g.beginPath(); d.poly.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)); g.closePath(); g.stroke(); });
    return await canvasBlob(c, "image/jpeg", 0.88);
  } finally { c.width = c.height = 1; }
}

// ------------------------------------------------------------------ GeoTIFF writer (RGBA, deflate, EPSG:3857)
function writeGeoTIFF(width, height, getRows, geo, rowsPerStrip = 64) {
  const strips = [];
  for (let y = 0; y < height; y += rowsPerStrip) strips.push(fflate.zlibSync(getRows(y, Math.min(rowsPerStrip, height - y)), { level: 6 }));
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
}
function geotiffBlob(r) {
  const ctx = ctx2d(r.canvas);
  return writeGeoTIFF(r.w, r.h, (y, n) => new Uint8Array(ctx.getImageData(0, y, r.w, n).data.buffer), { res: r.res, x0: r.x0, y0: r.y0 });
}
const worldFile = r => `${r.res}\n0.0\n0.0\n${-r.res}\n${r.x0 + r.res / 2}\n${r.y0 - r.res / 2}\n`;

// ------------------------------------------------------------------ process one AOI × release
async function processClip(aoi, rel, opt) {
  if (opt.geotiff !== false) await ensureLibrary("fflate");
  const r = await buildRaster(aoi.geometry, rel.release, opt.zoom, { signal: opt.signal, maxTiles: opt.maxTiles, onCoverage: opt.onCoverage, onProgress: f => opt.onProgress && opt.onProgress(0.45 * f) });
  try {
    const name = aoi.properties.name, aoi_id = slug(name);
    const [, clat] = pixelToLonLat(r, r.w / 2, r.h / 2);
    const props = { aoi_id, aoi_name: name, release: rel.release, imagery_date: rel.date, zoom: r.zoom, gsd_m: +groundRes(r, clat).toFixed(3), source: "Esri Wayback", imagery_coverage: r.coverage.status, missing_tiles: r.missing };
    let dets = [];
    if (opt.model) dets = await detect(r, opt.model, { classes: opt.classes, conf: opt.conf, signal: opt.signal, onProgress: f => opt.onProgress && opt.onProgress(0.45 + 0.45 * f) });
    const feats = toFeatures(dets, r, props), counts = {};
    feats.forEach(f => counts[f.properties.class] = (counts[f.properties.class] || 0) + 1);
    const bounds = rasterBounds(r);
    const blobs = { png: await canvasBlob(r.canvas, "image/png"), preview: await previewBlob(r, dets),
      tif: opt.geotiff === false ? null : geotiffBlob(r), pgw: worldFile(r) };
    checkAbort(opt.signal);
    opt.onProgress && opt.onProgress(1);
    return { aoi: name, aoi_id, release: rel.release, date: rel.date, zoom: r.zoom, bounds, counts, total: feats.length,
      tiles: r.tiles, missing: r.missing, coverage: r.coverage, size: [r.w, r.h], aoiFeature: aoi,
      fc: { type: "FeatureCollection", features: feats, properties: { ...props, image_bounds: bounds } }, blobs };
  } finally { r.canvas.width = r.canvas.height = 1; }
}
const slug = s => String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "aoi";

// ------------------------------------------------------------------ exports
async function exportJobZip(job, extra = {}) {
  await ensureLibrary("zip");
  const zip = new JSZip(), root = zip.folder(job.id), all = [];
  for (const r of job.results) {
    const f = root.folder(`${r.aoi_id}/${r.date || r.release}`);
    const fc = r.draftFC || r.fc;
    if (r.blobs.tif) f.file("image.tif", r.blobs.tif);
    f.file("image.png", r.blobs.png); f.file("image.pgw", r.blobs.pgw); f.file("image.prj", WKT_3857);
    f.file("preview_detections.jpg", r.blobs.preview);
    f.file("detections.geojson", JSON.stringify(fc));
    f.file("aoi.geojson", JSON.stringify(r.aoiFeature));
    all.push(...fc.features);
  }
  root.file("all_detections.geojson", JSON.stringify({ type: "FeatureCollection", features: all }));
  root.file("aois.geojson", JSON.stringify({ type: "FeatureCollection", features: job.aois }));
  root.file("summary.json", JSON.stringify({ job: job.id, status: job.status, params: job.params, outcomes: job.outcomes || [],
    results: job.results.map(r => ({ aoi: r.aoi, date: r.date, release: r.release, zoom: r.zoom, bounds: r.bounds, counts: r.counts, total: r.total,
      tiles: r.tiles, missing: r.missing, coverage: r.coverage, path: `${r.aoi_id}/${r.date || r.release}` })), ...extra }, null, 2));
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } }, extra.onProgress);
}
/** YOLO-OBB dataset from reviewed annotations (rejected objects are left unlabeled = negatives). */
async function exportDataset(annFC, opt = {}) {
  const feats = annFC.features.filter(f => f.properties.status !== "rejected" && f.properties.class && f.properties.release);
  if (!feats.length) throw new Error("No reviewed objects yet");
  await ensureLibrary("zip");
  const classes = [...new Set(feats.map(f => f.properties.class))].sort(), cid = Object.fromEntries(classes.map((c, i) => [c, i]));
  const zip = new JSZip(), ds = zip.folder("dataset"), groups = new Map(), chip = 1024;
  feats.forEach(f => { const p = f.properties, c = f.properties.centroid || centroidOf(f.geometry);
    const k = `${p.release}|${p.zoom || 18}|${Math.round(c[0] / 0.02)}|${Math.round(c[1] / 0.02)}`; (groups.get(k) || groups.set(k, []).get(k)).push(f); });
  let n = 0, gi = 0, firstChip = null;
  for (const [k, items] of groups) {
    const [rel, z] = k.split("|").map(Number);
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    items.forEach(f => { const b = bboxOf(f.geometry); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
    const pad = 0.0015, poly = { type: "Polygon", coordinates: [[[bb[0] - pad, bb[1] - pad], [bb[2] + pad, bb[1] - pad], [bb[2] + pad, bb[3] + pad], [bb[0] - pad, bb[3] + pad], [bb[0] - pad, bb[1] - pad]]] };
    const r = await buildRaster(poly, rel, z, { maxTiles: 1200 });
    if (r.missing) { r.canvas.width = r.canvas.height = 1; throw new ImageryError("INCOMPLETE_TRAINING_IMAGERY", "Training export needs complete imagery. Missing tiles must not become negative examples; choose another date or retry."); }
    const objs = items.map(f => ({ k: cid[f.properties.class], pts: minRect(f.geometry.coordinates[0].slice(0, -1).map(([lon, lat]) => { const [mx, my] = merc(lon, lat); return [(mx - r.x0) / r.res, (r.y0 - my) / r.res]; })) }));
    for (const [x, y] of windows(r.h, r.w, chip, 200)) {
      const lines = objs.filter(o => { const cx = o.pts.reduce((s, p) => s + p[0], 0) / 4, cy = o.pts.reduce((s, p) => s + p[1], 0) / 4; return cx >= x && cx < x + chip && cy >= y && cy < y + chip; })
        .map(o => o.k + " " + o.pts.map(([px, py]) => [(px - x) / chip, (py - y) / chip].map(v => Math.min(Math.max(v, 0), 1).toFixed(6)).join(" ")).join(" "));
      const c = makeCanvas(chip, chip), g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, chip, chip); g.drawImage(r.canvas, -x, -y);
      const split = (n % 7 === 6) ? "val" : "train", stem = `r${rel}_z${r.zoom}_${String(n).padStart(5, "0")}`;
      const jpg = await canvasBlob(c, "image/jpeg", 0.92);
      ds.file(`images/${split}/${stem}.jpg`, jpg);
      ds.file(`labels/${split}/${stem}.txt`, lines.join("\n"));
      if (!firstChip && lines.length) firstChip = { stem, jpg, txt: lines.join("\n") };
      n++;
    }
    r.canvas.width = r.canvas.height = 1;
    opt.onProgress && opt.onProgress(++gi / groups.size);
  }
  if (n < 7 && firstChip) {                       // tiny sets have no val chip yet: reuse one labelled chip
    ds.file(`images/val/${firstChip.stem}.jpg`, firstChip.jpg); ds.file(`labels/val/${firstChip.stem}.txt`, firstChip.txt);
  }
  ds.file("data.yaml", `path: .\ntrain: images/train\nval: images/val\nnames:\n${classes.map((c, i) => `  ${i}: ${c}`).join("\n")}\n`);
  ds.file("annotations.geojson", JSON.stringify(annFC));
  ds.file("TRAIN.md", `# Train and bring the model back to the portal

pip install ultralytics
cd dataset
yolo obb train data=data.yaml model=yolo11n-obb.pt imgsz=1024 epochs=50 batch=4
yolo export model=runs/obb/train/weights/best.pt format=onnx imgsz=1024 opset=17 simplify=True

Then in the portal: Detect > Load ONNX model > pick best.onnx.
Class names, in order: ${classes.join(", ")}

No GPU? Upload this folder to Google Colab or Kaggle and run the same commands.
`);
  return { blob: await zip.generateAsync({ type: "blob" }), chips: n, classes };
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

global.GVEngine = { getReleases, localChanges, releaseCacheInfo, cancelReleaseRefresh, requestJSON, ensureLibrary, markStartup,
  diagnostics: () => ({ startup: { ...startup }, dependencies: JSON.parse(JSON.stringify(dependencyTimings)), metadata: releaseCacheInfo() }),
  buildRaster, checkCoverage, loadModel, detect, toFeatures, processClip, exportJobZip, exportDataset,
  writeGeoTIFF, decode, nms, minRect, windows, slug, merc, unmerc, lonlatToPixel, uniqueAois, DOTA_NAMES, LABELS, WKT_3857, TILE_URL };
})(typeof window !== "undefined" ? window : globalThis);
