/* GeoVision Annotator — portal UI. Runs fully in the browser (GVEngine) or against the optional Python server. */
(() => {
"use strict";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const E = window.GVEngine;
const store = { get(k, d) { try { const v = localStorage.getItem("gv_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem("gv_" + k, JSON.stringify(v)); return true; } catch { return false; } } };
let browserLimits;
try { browserLimits = E.allocations.configure(store.get("rasterLimits", E.allocations.defaults)); }
catch { browserLimits = E.allocations.configure(E.allocations.defaults); }
$("#rasterMP").value = browserLimits.maxPixels / 1e6;
$("#rasterSide").value = browserLimits.maxDimension;
$("#rasterMemory").value = browserLimits.maxEstimatedBytes / 1048576;
$("#pngOn").checked = store.get("nativePNG", true);

const DOTA = ["aircraft","ship","helicopter","storage_tank","large_vehicle","small_vehicle","harbor","bridge",
  "swimming_pool","roundabout","tennis_court","basketball_court","baseball_diamond","soccer_field","track_field"];
const COLORS = {aircraft:"#f2a516",ship:"#1fb3dc",helicopter:"#ff5aa0",storage_tank:"#7ad65a",large_vehicle:"#ff7a3c",
  small_vehicle:"#a9a9ff",harbor:"#58d2d2",bridge:"#e6e678"};
const color = c => COLORS[c] || "#" + (((([...String(c)].reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 7)) | 0x404040) & 0xffffff).toString(16).padStart(6, "0"));

const S = {
  api: store.get("api", ""), online: false, engine: store.get("engine", "browser"),
  releases: [], selRel: new Set(store.get("selRel", [])), viewRel: null,
  aois: E.uniqueAois(store.get("aois", [])), activeAoi: null,
  classes: store.get("classes", DOTA.slice()), wantClasses: new Set(store.get("want", ["aircraft","ship","helicopter"])),
  models: [], customModels: [], jobId: null, clip: null, annFC: null, sel: null, editing: null,
};
const BJOBS = {};                       // lightweight catalog; durable payloads load per clip
const runAoiSelection = new Set(S.aois);
const browserQueue = [], MAX_WAITING_JOBS = 10;
let activeBrowserJob = null, selectedBrowserJobId = null, serverRunning = false, queueDraining = false, datasetExportRunning = false;
let datasetOperation = null, exportOperation = null, serverPoll = null, trainingPoll = null, exportParts = null;
let browserJobSequence = 0, modelSourceSequence = 0, viewEpoch = 0;
let localHits = new Set(), localLookup = null, pageActive = true;
let pendingLiveRelease = null;
let volatileLiveDraft = null;
let suspendedClip = null, unsavedAois = false;
let persistenceReady = false, durable = false, readOnly = false, queuePaused = false, storageError = null;
let writing = false, restoring = false;
let writingDone = Promise.resolve();
let storageShutdown = Promise.resolve();
const pendingWrites = [];
const DB = window.GVStorage?.create({ onState: state => {
  if (["ownership-lost", "version-change", "connection-closed"].includes(state.reason)) {
    finishEdit(); cancelAnnotationDraw();
    if (clipView && !clipView.ready) disposeClipView();
    readOnly = true; queuePaused = true; storageError = new Error("Storage ownership changed. Reload this tab to recover.");
    if (activeBrowserJob) { activeBrowserJob.suspending = true; activeBrowserJob.controller?.abort(); }
    datasetOperation?.controller.abort(); exportOperation?.controller.abort(); exportParts?.controller.abort();
    renderStorage(); updateRunSelection();
  }
} });
function renderStorage() {
  $("#storageStatus").textContent = !persistenceReady ? "Opening device storage…" : storageError ? "Not saved · " + storageError.message
    : readOnly ? "Read only · close the other tab and reload to edit." : !durable ? "Session only · storage unavailable. Export before closing."
    : pendingWrites.length ? "Saving on this device…" : "Saved on this device · IndexedDB";
  $("#storageRetry").hidden = !storageError || readOnly;
  renderQueueState();
  for (const id of ["fileIn", "loadSample", "clearAoi", "drawRect", "drawPoly", "onnxIn", "customNames", "annRect", "annPoly", "acceptAll", "saveAnn"])
    if ($("#" + id)) $("#" + id).disabled = !persistenceReady || readOnly;
}
async function flushWrites() {
  if (writing) return writingDone;
  writing = true;
  let finished;
  writingDone = new Promise(resolve => { finished = resolve; });
  try {
    while (pendingWrites.length && !storageError) {
      const item = pendingWrites[0];
      try { await item.action(); pendingWrites.shift(); item.resolve(); }
      catch (error) { storageError = error; queuePaused = true; item.reject(error); toast("Could not save on this device. Work is kept in this tab; retry saving or export it.", 6500); }
      renderStorage();
    }
  } finally {
    writing = false; finished();
    // Retried submissions may become runnable after their original caller has
    // already returned. Completing persistence must wake the scheduler too.
    if (browserQueue.length) drainBrowserQueue();
  }
}
function persistWrite(action, owner = null) {
  if (!durable) return Promise.resolve();
  if (readOnly) return Promise.reject(new Error("This workspace is read only"));
  const promise = new Promise((resolve, reject) => { pendingWrites.push({ action, owner, resolve, reject }); });
  renderStorage(); flushWrites();
  // Later writes remain queued after a failure; their callers can stop without
  // holding an inference slot or waiting forever for a user-driven retry.
  if (storageError) { promise.catch(() => {}); return Promise.reject(storageError); }
  return promise;
}
const checkpointJob = job => {
  const record = window.GVStorage?.jobRecord(job);
  return persistWrite(() => DB.saveJob(record), job.id);
};
function saveDraft() {
  if (!dirty || !S.annFC || readOnly || restoring || BJOBS[S.clip?.job]?.deleting) return;
  if (S.clip?.browser) S.clip.source.draftFC = S.annFC;
  if (!S.clip) volatileLiveDraft = S.annFC;
  const scope = draftScope(S.clip), entry = retainDraft(scope, S.annFC, S.clip, true);
  const revision = ++entry.revision;
  const fc = JSON.parse(JSON.stringify(S.annFC)), jobId = S.clip?.job || null, original = S.annFC, source = S.clip?.source;
  persistWrite(async () => {
    await DB.saveDraft(scope, jobId, fc);
    if (draftCache.get(scope) === entry && entry.revision === revision) {
      entry.dirty = false;
      if (S.annFC !== original) {
        draftCache.delete(scope);
        if (source?.draftFC === original) delete source.draftFC;
        if (volatileLiveDraft === original) volatileLiveDraft = null;
      } else dirty = false;
    }
  }, jobId || "live").catch(() => {});
}
async function readClip(source, options) {
  const images = options?.images !== false;
  if (source.fc && (!images || source.blobs?.display || source.blobs?.png)) return source;
  const payload = await DB.clip(source.storeId, options);
  if (source.draftFC && options?.draft !== false) payload.draftFC = source.draftFC;
  return payload;
}
$("#storageRetry").onclick = async () => { storageError = null; await flushWrites(); renderStorage(); };
$("#resumeQueue").onclick = () => { if (!pageActive || !persistenceReady || storageError || readOnly) return; queuePaused = false; renderStorage(); drainBrowserQueue(); };
const isServer = () => S.engine === "server" && S.online;
const api = p => (S.api || "") + p;
const toast = (m, ms = 2600) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), ms); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const downloadURLs = new Map();
const saveBlob = (name, blob, onRelease) => {
  const lease = onRelease ? null : E.allocations.download(blob.size, E.allocations.limits());
  const consume = () => { lease?.release(); onRelease?.(); };
  let a, url;
  try { a = document.createElement("a"); url = URL.createObjectURL(blob); } catch (error) { consume(); throw error; }
  const release = () => { const record = downloadURLs.get(url); if (!record) return; clearTimeout(record.timer); downloadURLs.delete(url); URL.revokeObjectURL(url); consume(); };
  // Downloads have a separate delayed lease; a hidden/replaced map view cannot
  // revoke a URL before the browser has consumed the download.
  downloadURLs.set(url, { timer: setTimeout(release, 10000), release });
  try { a.href = url; a.download = name; document.body.append(a); a.click(); }
  catch (error) { release(); throw error; }
  finally { a.remove(); }
};
const download = (name, text, type = "application/geo+json") => { try { return saveBlob(name, new Blob([text], { type })); } catch (error) { toast(error.message, 5000); } };
const postJSON = (p, body, signal) => E.requestJSON(api(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

// ---------------------------------------------------------------- theme
const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get("theme", null));
$("#themeBtn").onclick = () => { const dark = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().startsWith("#0"); const t = dark ? "light" : "dark"; applyTheme(t); store.set("theme", t); };

// ---------------------------------------------------------------- tabs
const TITLES = { aoi:["Areas of interest","Import airports, ports and bases, or draw them on the map."],
  img:["Esri Wayback imagery","Every World Imagery release since 2014, chosen per AOI."],
  det:["Object detection","Oriented boxes for aircraft, ships and more on each AOI clip."],
  res:["Results","Counts and clipped imagery per AOI and imagery date."],
  ann:["Annotate","Review predictions, fix classes and shapes, draw what the model missed."],
  trn:["Train","Turn reviewed objects into a training set and a better model."],
  exp:["Export","GeoJSON and AOI-clipped images for every location and date."] };
function showTab(id) {
  ++viewEpoch;
  if (id !== "res" && comparing()) exitComparison();
  closeRunAoiPanel({ restoreFocus: false });
  $$(".rail [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === id));
  $$(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + id));
  $("#panelTitle").textContent = TITLES[id][0]; $("#panelSub").textContent = TITLES[id][1];
  if (id === "res") loadJobs(); if (id === "trn") loadAnnStats();
  store.set("tab", id);
}
$$(".rail [data-tab]").forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------------------------------------------------------------- map
const map = L.map("map").setView([25.25, 55.36], 11);
// Map-owned panes keep rebuilt AOI paths below selectable detections.
map.createPane("gmd-aois").style.zIndex = "410";
map.createPane("gmd-detections").style.zIndex = "430";
const ATTR = "Esri World Imagery Wayback · Esri, Maxar, Earthstar Geographics, GIS User Community";
let wbLayer = null;
function setWayback(rel) {
  if (wbLayer && S.viewRel && S.viewRel.release === rel.release) return;
  S.viewRel = rel;
  const url = E.TILE_URL(rel.release, "{z}", "{y}", "{x}");
  if (wbLayer) wbLayer.setUrl(url);
  else {
    wbLayer = L.tileLayer(url, { maxZoom: 21, maxNativeZoom: 19, attribution: ATTR }).addTo(map);
    wbLayer.bringToBack();
    wbLayer.on("tileload", () => E.markStartup("mapFirstTile"));
  }
  $("#hudRel").textContent = rel.date;
  renderReleases();
}
const aoiLayer = L.featureGroup().addTo(map), clipLayer = L.layerGroup().addTo(map), detLayer = L.featureGroup().addTo(map);
map.on("zoomend", () => $("#hudZ").textContent = map.getZoom());
map.on("mousemove", e => $("#hudXY").textContent = e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5));
$("#hudZ").textContent = map.getZoom();

// Map-owned navigation only: no AOI, release, job or annotation state is changed.
const placeRoot = $("#mapSearch"), placeInput = $("#mapSearchInput"), placePopup = $("#mapSearchPopup");
let placeGeneration = 0, placeOwner = null, placeTimer = null, placeRows = [], placeIndex = -1, placeMarker = null;
map.createPane("gmd-search").style.zIndex = "450";
map.getPane("gmd-search").style.pointerEvents = "none";
function stopPlaceRequest() {
  ++placeGeneration; clearTimeout(placeTimer); placeTimer = null;
  const previous = placeOwner; placeOwner = null; previous?.abort();
  placeInput.setAttribute("aria-busy", "false"); return previous?.pending;
}
function removePlaceMarker() { if (placeMarker) { map.removeLayer(placeMarker); placeMarker = null; } }
function closePlaceSearch({ removeMarker = false } = {}) {
  const pending = stopPlaceRequest(); placePopup.hidden = true; placeIndex = -1;
  placeInput.setAttribute("aria-expanded", "false"); placeInput.removeAttribute("aria-activedescendant");
  if (removeMarker) removePlaceMarker(); return pending;
}
function renderPlaceOptions(rows = [], message = "") {
  placeRows = [{ kind: "location", label: "Use current location" }, ...rows]; placeIndex = -1;
  placeInput.removeAttribute("aria-activedescendant");
  $("#mapSearchOptions").innerHTML = placeRows.map((row, i) => `<button type="button" class="map-search-option" role="option" tabindex="-1" id="map-place-${i}" data-place-index="${i}" aria-selected="false"><span aria-hidden="true">${row.kind === "location" ? "⌖" : "↗"}</span><span>${esc(row.label)}</span></button>`).join("");
  $("#mapSearchOptions").querySelectorAll("[data-place-index]").forEach(button => {
    button.onpointerdown = event => event.preventDefault();
    button.onclick = () => choosePlaceRow(Number(button.dataset.placeIndex));
  });
  $("#mapSearchStatus").textContent = message;
  $("#mapSearchClear").hidden = !placeInput.value;
  placePopup.hidden = false; placeInput.setAttribute("aria-expanded", "true");
}
function showPlacePoint(point) {
  if (!pageActive) return;
  if (point.bounds) map.fitBounds(point.bounds, { padding: [24, 24], maxZoom: 17, animate: false });
  else map.setView([point.lat, point.lon], Math.max(16, map.getZoom()), { animate: false });
  removePlaceMarker();
  placeMarker = L.circleMarker([point.lat, point.lon], { pane: "gmd-search", interactive: false, radius: 7,
    color: "#ffffff", weight: 2, fillColor: "#0b8fb3", fillOpacity: 1 }).addTo(map);
  placeInput.value = point.label; $("#mapSearchClear").hidden = false; closePlaceSearch();
}
function runPlaceRequest(work, accept, message) {
  stopPlaceRequest(); const generation = placeGeneration;
  const owner = E.operations.open("Map search", { timeoutMs: 12000 }); placeOwner = owner;
  renderPlaceOptions([], message); placeInput.setAttribute("aria-busy", "true");
  const current = () => pageActive && generation === placeGeneration && placeOwner === owner;
  owner.pending = (async () => {
    try { const value = await work(owner.signal); owner.check(); if (current()) accept(value); }
    catch (error) {
      if (!current()) return;
      try { owner.check(); } catch (reason) { error = reason; }
      if (error.name !== "AbortError") renderPlaceOptions([], error.message);
    } finally { if (placeOwner === owner) { placeOwner = null; placeInput.setAttribute("aria-busy", "false"); } owner.close(); }
  })();
  return owner.pending;
}
function findPlace(text, magicKey) {
  return runPlaceRequest(signal => E.mapSearch.find(text, { signal, magicKey, center: map.getCenter() }),
    point => point ? showPlacePoint(point) : renderPlaceOptions([], "No places found. Try a more specific name or latitude, longitude."), "Finding location…");
}
function choosePlaceRow(index) {
  const row = placeRows[index]; if (!row) return;
  if (row.kind === "location") return runPlaceRequest(signal => E.mapSearch.currentLocation({ signal }), showPlacePoint, "Finding your current location…");
  if (row.kind === "coordinates") { stopPlaceRequest(); showPlacePoint(row.point); return; }
  placeInput.value = row.label; return findPlace(row.label, row.magicKey);
}
function previewPlaceInput(search = false) {
  stopPlaceRequest();
  const text = placeInput.value.trim();
  try {
    const point = E.mapSearch.parseCoordinates(text);
    if (point) return renderPlaceOptions([{ kind: "coordinates", label: "Go to " + point.label, point }]);
    if (text.length > 300) return renderPlaceOptions([], "Enter a place name of at most 300 characters.");
    renderPlaceOptions([], text && text.length < 3 ? "Type at least 3 characters for place suggestions." : "Enter a place name or latitude, longitude.");
    if (search && text.length >= 3) placeTimer = setTimeout(() => {
      placeTimer = null;
      runPlaceRequest(signal => E.mapSearch.suggest(text, { signal, center: map.getCenter() }),
        rows => renderPlaceOptions(rows.map(row => ({ ...row, kind: "place" })), rows.length ? "" : "No suggestions. Press Enter to search."), "Searching places…");
    }, 350);
  } catch (error) { renderPlaceOptions([], error.message); }
}
placeInput.onfocus = () => previewPlaceInput();
placeInput.oninput = event => previewPlaceInput(!event?.isComposing);
placeInput.oncompositionend = () => previewPlaceInput(true);
$("#mapSearchForm").onsubmit = event => {
  event.preventDefault();
  if (placeIndex >= 0 && !placePopup.hidden) return choosePlaceRow(placeIndex);
  const text = placeInput.value.trim(); stopPlaceRequest();
  if (!text) return renderPlaceOptions();
  try { const point = E.mapSearch.parseCoordinates(text); return point ? showPlacePoint(point) : findPlace(text); }
  catch (error) { renderPlaceOptions([], error.message); }
};
placeInput.onkeydown = event => {
  if (event.isComposing) { if (event.key === "Enter") event.preventDefault(); event.stopPropagation(); return; }
  if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === "Escape") return closePlaceSearch();
  if (placePopup.hidden) previewPlaceInput();
  placeIndex = placeIndex < 0 ? event.key === "ArrowDown" ? 0 : placeRows.length - 1
    : (placeIndex + (event.key === "ArrowDown" ? 1 : -1) + placeRows.length) % placeRows.length;
  $("#mapSearchOptions").querySelectorAll("[data-place-index]").forEach((button, i) => button.setAttribute("aria-selected", String(i === placeIndex)));
  const selected = $("#mapSearchOptions").querySelectorAll("[data-place-index]")[placeIndex];
  placeInput.setAttribute("aria-activedescendant", selected.id || "map-place-" + placeIndex); selected.scrollIntoView?.({ block: "nearest" });
};
placeRoot.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); placeInput.focus(); closePlaceSearch(); } };
$("#mapSearchClear").onclick = () => { closePlaceSearch({ removeMarker: true }); placeInput.value = ""; placeInput.focus(); previewPlaceInput(); };
document.addEventListener("pointerdown", event => { if (!placeRoot.contains(event.target)) closePlaceSearch(); });

// ---------------------------------------------------------------- engine + server
async function checkApi() {
  if (!S.api && location.hostname.endsWith("github.io")) { S.online = false; }
  else try {
    const j = await (await fetch(api("/api/health"), { signal: AbortSignal.timeout(2500) })).json();
    S.online = true; $("#apiDot").className = "dot on";
    $("#apiTxt").textContent = "Server connected" + (j.detector ? " · detector ready" : " · detector not installed");
  } catch { S.online = false; }
  if (!S.online) { $("#apiDot").className = "dot off"; $("#apiTxt").textContent = "No server connected. Everything runs in this browser."; }
  updEngineUI();
}
function updEngineUI() {
  invalidateLocalChanges();
  $$('[name=engine]').forEach(r => r.checked = r.value === S.engine);
  const srv = isServer();
  $("#engineTag").textContent = srv ? "Python server" : "In browser";
  $("#customRow").hidden = srv; $("#namesRow").hidden = srv || !curModel()?.custom;
  $("#serverTrain").hidden = !srv;
  updateRunSelection();
}
$$('[name=engine]').forEach(r => r.onchange = async () => { S.engine = r.value; store.set("engine", S.engine);
  if (S.engine === "server" && !S.online) toast("Connect to a running server first"); await loadModels(); updEngineUI(); });
$("#apiUrl").value = S.api;
$("#apiSave").onclick = async () => { await Promise.all([stopPoll(serverPoll), stopPoll(trainingPoll)]); serverPoll = trainingPoll = null; setServerRunning(false); S.api = $("#apiUrl").value.trim().replace(/\/$/, ""); store.set("api", S.api); await checkApi(); if (S.online) { S.engine = "server"; store.set("engine", "server"); } await loadModels(); updEngineUI(); };

// ---------------------------------------------------------------- AOIs
function aoiName(f, i) { const p = f.properties || {}; return p.name || p.Name || p.NAME || p.iata || p.IATA || p.icao || p.ICAO || p.title || p.id || ("AOI " + (i + 1)); }
function squareAround(lon, lat, km) {
  const dLat = km / 2 / 110.574, dLon = km / 2 / (111.32 * Math.cos(lat * Math.PI / 180));
  return { type: "Polygon", coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]] };
}
function normalizeFeatures(fc) {
  const km = parseFloat($("#bufKm").value) || 3, out = [];
  const feats = fc.type === "FeatureCollection" ? fc.features : fc.type === "Feature" ? [fc] : [{ type: "Feature", properties: {}, geometry: fc }];
  feats.forEach(f => {
    if (!f || !f.geometry) return;
    const g = f.geometry;
    if (g.type === "Point") out.push({ ...f, geometry: squareAround(g.coordinates[0], g.coordinates[1], km) });
    else if (g.type === "MultiPoint") g.coordinates.forEach((c, i) => out.push({ type: "Feature", properties: { ...f.properties, name: aoiName(f, 0) + "_" + (i + 1) }, geometry: squareAround(c[0], c[1], km) }));
    else if (g.type === "Polygon" || g.type === "MultiPolygon") out.push(f);
    else if (g.type === "GeometryCollection") g.geometries.forEach(gg => out.push(...normalizeFeatures({ type: "Feature", properties: f.properties, geometry: gg })));
  });
  return out;
}
function addAois(feats) {
  if (!persistenceReady || readOnly) return toast("Wait for writable device storage");
  const active = S.aois[S.activeAoi], existing = E.uniqueAois(S.aois), base = existing.length;
  const selectNew = existing.every(aoi => runAoiSelection.has(aoi));
  const incoming = feats.map((f, i) => ({ ...f, type: "Feature", properties: { ...f.properties, name: String(aoiName(f, base + i)) }, geometry: f.geometry }));
  S.aois = E.uniqueAois(existing.concat(incoming));
  if (selectNew) S.aois.forEach(aoi => runAoiSelection.add(aoi));
  const activeIndex = S.aois.indexOf(active);
  S.activeAoi = activeIndex >= 0 ? activeIndex : null;
  const added = S.aois.length - base, skipped = feats.length - added;
  saveAois(); renderAois();
  toast(`${added} AOI${added === 1 ? "" : "s"} added${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}`);
}
function saveAois() {
  if (!durable) { unsavedAois = !store.set("aois", S.aois); if (unsavedAois) toast("AOIs could not be saved. Export them before closing.", 5000); return; }
  const ids = new Set();
  S.aois.forEach(feature => { if (!feature._gmd_id || ids.has(feature._gmd_id)) feature._gmd_id = window.GVStorage.uuid(); ids.add(feature._gmd_id); });
  const features = JSON.parse(JSON.stringify(S.aois));
  persistWrite(() => DB.saveAois(features)).catch(() => {});
}
function renderAois() {
  invalidateLocalChanges();
  aoiLayer.clearLayers();
  const list = $("#aoiList"); list.innerHTML = "";
  S.aois.forEach((f, i) => {
    const act = i === S.activeAoi;
    L.geoJSON(f, { pane: "gmd-aois", style: { color: act ? "#f2a516" : "#ffffff", weight: act ? 2.5 : 1.5, dashArray: "6 4", fillOpacity: 0.04 } })
      .bindTooltip(esc(f.properties.name), { sticky: true }).on("click", () => selectAoi(i)).addTo(aoiLayer);
    const b = L.geoJSON(f).getBounds(), kmW = b.getNorthWest().distanceTo(b.getNorthEast()) / 1000, kmH = b.getNorthWest().distanceTo(b.getSouthWest()) / 1000;
    const it = document.createElement("div"); it.className = "item" + (act ? " active" : "");
    it.innerHTML = `<span style="width:10px;height:10px;border-radius:3px;border:1.5px dashed var(--muted)"></span>
      <div style="min-width:0"><div class="t">${esc(f.properties.name)}</div><div class="s mono">${kmW.toFixed(1)} × ${kmH.toFixed(1)} km${f.properties.type ? " · " + esc(f.properties.type) : ""}</div></div>
      <div class="row" style="gap:0"><button class="btn ghost" data-aoi-zoom="${i}" aria-label="Zoom to ${esc(f.properties.name)}">Zoom</button><button class="icon-btn" data-ren="${i}" title="Rename" aria-label="Rename">✎</button><button class="icon-btn" data-del="${i}" title="Remove" aria-label="Remove">✕</button></div>`;
    it.onclick = e => { if (e.target.closest("[data-del],[data-ren],[data-aoi-zoom]")) return; selectAoi(i); };
    list.append(it);
  });
  if (!S.aois.length) list.innerHTML = `<div class="item"><span></span><span class="s">No AOIs yet. Import a file, draw one, or load the UAE sample (6 airports and ports).</span><span></span></div>`;
  list.querySelectorAll("[data-del]").forEach(b => { b.disabled = readOnly; b.onclick = () => { if (readOnly) return; S.aois.splice(+b.dataset.del, 1); S.activeAoi = null; saveAois(); renderAois(); }; });
  list.querySelectorAll("[data-ren]").forEach(b => { b.disabled = readOnly; b.onclick = () => { if (!readOnly) renameAoi(+b.dataset.ren, b.closest(".item")); }; });
  list.querySelectorAll("[data-aoi-zoom]").forEach(button => button.onclick = () => zoomToAoi(Number(button.dataset.aoiZoom)));
  $("#aoiCount").textContent = S.aois.length ? `(${S.aois.length})` : "";
  renderRunAois();
}
const chosenRunAois = () => S.aois.filter(aoi => runAoiSelection.has(aoi));
function updateRunSelection() {
  const count = chosenRunAois().length;
  $("#runN").textContent = count;
  $("#runAoiCount").textContent = `${count} of ${S.aois.length} selected`;
  $("#runAoiHint").textContent = !S.aois.length ? "Add AOIs in the AOIs tab to get started."
    : !count ? "Select at least one AOI to enable Run."
    : "Checked AOIs will use your Wayback date settings. Use Zoom to navigate; selection keeps the map view.";
  const busy = Boolean(activeBrowserJob || browserQueue.length || queueDraining || datasetExportRunning);
  $("#runVerb").textContent = !isServer() && busy ? "Queue" : "Run";
  $("#runBtn").disabled = !persistenceReady || readOnly || Boolean(storageError) || count === 0 || serverRunning || (isServer() ? busy : browserQueue.length >= MAX_WAITING_JOBS);
  $("#runAoiAll").disabled = $("#runAoiNone").disabled = !S.aois.length;
  if (!renderAllocationPreflight()) $("#runBtn").disabled = true;
}
function readBrowserLimits() {
  const values = { maxPixels: Number($("#rasterMP").value) * 1e6, maxDimension: Number($("#rasterSide").value), maxEstimatedBytes: Number($("#rasterMemory").value) * 1048576 };
  return E.allocations.configure(values);
}
function clipAllocationOptions() {
  return { maxTiles: Number($("#maxTiles").value), detect: $("#detectOn").checked, modelSize: $("#detectOn").checked ? curModel()?.imgsz || 1024 : 0,
    bounded: true, png: $("#pngOn").checked, geotiff: $("#tifOn").checked, limits: readBrowserLimits() };
}
function renderAllocationPreflight() {
  const output = $("#allocationPreflight");
  if (isServer()) { output.textContent = "Browser limits apply to local processing. The Python server manages its own resources."; return true; }
  try {
    const options = clipAllocationOptions(), chosen = chosenRunAois();
    if (!chosen.length) { output.textContent = "Select AOIs to estimate their processing footprint."; return false; }
    const plans = chosen.map(aoi => ({ name: aoi.properties.name, plan: E.estimateRaster(aoi.geometry, Number($("#zoom").value), options) }));
    output.innerHTML = plans.map(({ name, plan }) => `<div>${esc(name)} · z${plan.requestedZoom}${plan.zoomReduced ? " → z" + plan.zoom : ""} · ${plan.width}×${plan.height} px · ${plan.tiles} tiles · ${(plan.pixels / 1e6).toFixed(2)} MP · estimated ${(plan.estimatedBytes / 1048576).toFixed(1)} MiB${plan.allowed ? "" : `<br><span style="color:var(--bad)">${esc(plan.violations[0].message)}</span>`}</div>`).join("");
    return plans.every(({ plan }) => plan.allowed);
  } catch (error) { output.textContent = error.message; return false; }
}
for (const id of ["rasterMP", "rasterSide", "rasterMemory", "zoom", "maxTiles", "detectOn", "tifOn", "pngOn"]) $("#" + id).onchange = () => {
  try { browserLimits = readBrowserLimits(); store.set("rasterLimits", browserLimits); } catch {}
  store.set("nativePNG", $("#pngOn").checked);
  updateRunSelection();
};
function renderRunAois() {
  // References distinguish equal names and survive renames/reindexing. They are
  // tab-local UI state; durable identity belongs to the AOI record itself.
  const current = new Set(S.aois);
  for (const aoi of runAoiSelection) if (!current.has(aoi)) runAoiSelection.delete(aoi);
  const list = $("#runAoiList");
  const query = $("#runAoiSearch").value.trim().toLocaleLowerCase();
  const rows = S.aois.map((aoi, index) => ({ aoi, index })).filter(({ aoi }) => String(aoi.properties.name).toLocaleLowerCase().includes(query));
  list.innerHTML = rows.map(({ aoi, index }) => `<tr>
    <td><input type="checkbox" id="run-aoi-${index}" data-run-aoi="${index}" ${runAoiSelection.has(aoi) ? "checked" : ""} style="accent-color:var(--accent)"></td>
    <td><label for="run-aoi-${index}">${esc(aoi.properties.name)}</label></td>
    <td><button class="btn ghost" data-run-zoom="${index}" aria-label="Zoom to ${esc(aoi.properties.name)}">Zoom</button></td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">${S.aois.length ? "No AOIs match your search." : "No AOIs added yet."}</td></tr>`;
  $("#runAoiMatches").textContent = `Showing ${rows.length} of ${S.aois.length} AOIs`;
  list.querySelectorAll("[data-run-aoi]").forEach(checkbox => {
    const aoi = S.aois[+checkbox.dataset.runAoi];
    checkbox.onchange = () => {
      if (!S.aois.includes(aoi)) return;
      checkbox.checked ? runAoiSelection.add(aoi) : runAoiSelection.delete(aoi);
      updateRunSelection();
    };
  });
  list.querySelectorAll("[data-run-zoom]").forEach(button => {
    const aoi = S.aois[+button.dataset.runZoom];
    button.onclick = () => {
      const index = S.aois.indexOf(aoi);
      if (index < 0) return;
      zoomToAoi(index); $("#map").focus({ preventScroll: true });
    };
  });
  updateRunSelection();
}
function closeRunAoiPanel({ restoreFocus = true } = {}) {
  if ($("#runAoiPanel").hidden) return;
  $("#runAoiPanel").hidden = true; $("#tab-det").classList.add("on");
  $("#runAoiBtn").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#runAoiBtn").focus({ preventScroll: true });
}
$("#runAoiBtn").onclick = () => {
  showTab("det");
  renderRunAois();
  $("#tab-det").classList.remove("on"); $("#runAoiPanel").hidden = false;
  $("#runAoiBtn").setAttribute("aria-expanded", "true"); $("#runAoiSearch").focus();
};
$("#runAoiClose").onclick = $("#runAoiDone").onclick = closeRunAoiPanel;
$("#runAoiSearch").oninput = renderRunAois;
$("#runAoiAll").onclick = () => { S.aois.forEach(aoi => runAoiSelection.add(aoi)); renderRunAois(); };
$("#runAoiNone").onclick = () => { runAoiSelection.clear(); renderRunAois(); };
function setServerRunning(running) { serverRunning = running; updateRunSelection(); renderQueueState(); if (!running) drainBrowserQueue(); }
function renameAoi(i, el) {
  const t = el.querySelector(".t"), inp = document.createElement("input"); inp.type = "text"; inp.value = S.aois[i].properties.name;
  t.replaceWith(inp); inp.focus(); inp.select();
  const done = () => { S.aois[i].properties.name = inp.value.trim() || S.aois[i].properties.name; saveAois(); renderAois(); };
  inp.onkeydown = e => { if (e.key === "Enter") done(); if (e.key === "Escape") renderAois(); }; inp.onblur = done;
}
function selectAoi(i) { if (!S.aois[i]) return; S.activeAoi = i; renderAois(); }
function zoomToAoi(i) {
  if (!S.aois[i]) return;
  selectAoi(i); map.fitBounds(L.geoJSON(S.aois[i]).getBounds().pad(0.15), { animate: false });
}
async function readFile(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith(".zip")) { await E.ensureLibrary("shp"); const g = await shp(await file.arrayBuffer()); return Array.isArray(g) ? { type: "FeatureCollection", features: g.flatMap(x => x.features) } : g; }
  const text = await file.text();
  if (n.endsWith(".kml")) { await E.ensureLibrary("kml"); return toGeoJSON.kml(new DOMParser().parseFromString(text, "text/xml")); }
  if (n.endsWith(".csv")) return csvToFC(text);
  return JSON.parse(text);
}
function csvToFC(text) {
  const rows = text.trim().split(/\r?\n/).map(r => r.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, "").trim()));
  const h = rows.shift().map(x => x.toLowerCase());
  const li = h.findIndex(x => ["lat","latitude","y"].includes(x)), lo = h.findIndex(x => ["lon","lng","long","longitude","x"].includes(x));
  if (li < 0 || lo < 0) throw new Error("CSV needs lat and lon columns");
  return { type: "FeatureCollection", features: rows.filter(r => r.length > Math.max(li, lo)).map(r => ({ type: "Feature",
    properties: Object.fromEntries(h.map((k, i) => [k, r[i]])), geometry: { type: "Point", coordinates: [+r[lo], +r[li]] } })) };
}
async function handleFiles(files) { for (const f of files) { try { addAois(normalizeFeatures(await readFile(f))); } catch (e) { toast(`${f.name}: ${e.message}`, 4000); } } }
$("#fileIn").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
const drop = $("#drop");
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => handleFiles(e.dataTransfer.files));
$("#clearAoi").onclick = () => { if (readOnly || !persistenceReady) return; S.aois = []; S.activeAoi = null; saveAois(); renderAois(); };
$("#loadSample").onclick = async () => { try { addAois(normalizeFeatures(await (await fetch("sample_aois/uae_airports_ports.geojson")).json())); } catch { toast("Sample file not found next to the portal"); } };

let drawMode = null, drawRequest = 0, drawTool = null, drawPurpose = null, drawingView = null;
function cancelAnnotationDraw() {
  if (drawPurpose !== "ann") return;
  ++drawRequest; drawTool?.disable(); drawTool = null; drawMode = drawPurpose = null; drawingView = null;
}
async function startDraw(kind, purpose) {
  if (readOnly || !persistenceReady || !pageActive || comparing()) return;
  if (purpose === "ann" && clipView && !canAnnotate()) return toast("Wait for the clip to finish loading");
  const request = ++drawRequest;
  drawTool?.disable(); drawPurpose = purpose;
  const owner = purpose === "ann" ? clipView : null;
  try {
    await E.ensureLibrary("draw");
    if (request !== drawRequest || !pageActive || readOnly || !persistenceReady || (purpose === "ann" && (owner !== clipView || comparing()))) return;
    drawMode = purpose; drawingView = owner;
    drawTool = new (kind === "rect" ? L.Draw.Rectangle : L.Draw.Polygon)(map, { shapeOptions: { color: purpose === "aoi" ? "#f2a516" : color($("#drawClass").value), weight: 2 }, showArea: false });
    drawTool.enable();
  } catch (error) { if (request === drawRequest) toast(error.message, 5000); }
}
$("#drawRect").onclick = () => startDraw("rect", "aoi");
$("#drawPoly").onclick = () => startDraw("poly", "aoi");
map.on("draw:created", e => {
  const g = e.layer.toGeoJSON().geometry;
  if (drawMode === "aoi") addAois([{ type: "Feature", properties: { name: "AOI " + (S.aois.length + 1) }, geometry: g }]);
  else if (drawMode === "ann" && drawingView === clipView && pageActive && !comparing()) addManualObject(g);
  drawMode = drawPurpose = null; drawTool = drawingView = null;
});

// ---------------------------------------------------------------- Wayback releases
function applyReleases(releases) {
  if (!pageActive) return;
  S.releases = releases;
  if (!S.viewRel && releases.length) setWayback(releases[0]); else renderReleases();
  if (pendingLiveRelease != null && !S.clip) {
    const release = releases.find(r => r.release === pendingLiveRelease);
    if (release) { pendingLiveRelease = null; setWayback(release); }
  }
  E.markStartup("metadataReady");
}
function renderReleaseStatus() {
  const info = E.releaseCacheInfo(), updated = info.fetchedAt ? new Date(info.fetchedAt).toLocaleString() : null;
  $("#releaseStatus").textContent = info.refreshing ? `${updated ? "Saved release list · " + updated + ". " : ""}Refreshing…`
    : info.error ? `${S.releases.length ? "Showing saved release list. " : ""}Refresh failed. Try Refresh dates.`
    : updated ? `${info.source === "cache" ? "Saved" : "Updated"} release list · ${updated}` : "Wayback releases";
  $("#relRefresh").disabled = info.refreshing;
}
async function refreshReleases() {
  const request = E.getReleases({ refresh: true }); renderReleaseStatus();
  try { applyReleases(await request); }
  catch (error) { if (pageActive && !S.releases.length) $("#relList").textContent = "Could not load imagery dates. Check your connection and try Refresh dates."; }
  finally { if (pageActive) renderReleaseStatus(); }
}
async function loadReleases() {
  try {
    applyReleases(await E.getReleases()); renderReleaseStatus();
    if (pageActive && E.releaseCacheInfo().source === "cache") await refreshReleases();
  } catch {
    if (!pageActive) return;
    try { applyReleases(await E.requestJSON(api("/api/releases"))); }
    catch { $("#relList").textContent = "Could not load imagery dates. Check your connection and try Refresh dates."; }
    renderReleaseStatus();
  }
}
$("#relRefresh").onclick = refreshReleases;
function lookupMatches(request) {
  const aoi = S.aois[S.activeAoi];
  return request && aoi === request.aoi && JSON.stringify(aoi.geometry) === request.geometry
    && aoi.properties.name === request.name && request.source === (isServer() ? api("/api/releases/local") : "browser");
}
function invalidateLocalChanges(force = false) {
  if (!localLookup || (!force && lookupMatches(localLookup))) return;
  localLookup.controller.abort(); localLookup = null; localHits = new Set();
  $("#relLocal").disabled = false; $("#relLocal").textContent = "Changes at AOI";
  $("#localChangeStatus").textContent = "Select an AOI, then find its historical imagery updates.";
  renderReleases();
}
function renderReleases() {
  if (localLookup && !lookupMatches(localLookup)) { invalidateLocalChanges(); return; }
  const q = $("#relSearch").value.trim().toLowerCase(), list = $("#relList");
  const rows = S.releases.filter(r => !q || r.date.includes(q) || (r.title || "").toLowerCase().includes(q));
  list.innerHTML = rows.map(r => `
    <div class="item${S.viewRel && S.viewRel.release === r.release ? " active" : ""}" data-r="${r.release}">
      <input type="checkbox" data-c="${r.release}" ${S.selRel.has(r.release) ? "checked" : ""} style="accent-color:var(--accent)" aria-label="Select ${r.date}">
      <div><div class="t mono">${r.date || r.release}</div><div class="s">Release ${r.release}${localHits.has(r.release) ? ' · <span style="color:var(--accent)">Imagery update near ' + esc(localLookup.name) + '</span>' : ""}</div></div>
      <span class="s mono" style="color:var(--accent)">${localHits.has(r.release) ? "●" : ""}</span></div>`).join("") || `<div class="item"><span></span><span class="s">No releases match.</span><span></span></div>`;
  list.querySelectorAll("[data-r]").forEach(it => it.onclick = e => { if (e.target.matches("input")) return; setWayback(S.releases.find(r => r.release === +it.dataset.r)); });
  list.querySelectorAll("[data-c]").forEach(cb => cb.onchange = () => { cb.checked ? S.selRel.add(+cb.dataset.c) : S.selRel.delete(+cb.dataset.c); store.set("selRel", [...S.selRel]); updModeHint(); });
}
$("#relSearch").oninput = renderReleases;
$("#relLocal").onclick = async () => {
  if (S.activeAoi == null) return toast("Select an AOI first");
  invalidateLocalChanges(true);
  const aoi = S.aois[S.activeAoi], c = L.geoJSON(aoi).getBounds().getCenter(), btn = $("#relLocal");
  const request = localLookup = { aoi, name: aoi.properties.name, geometry: JSON.stringify(aoi.geometry),
    source: isServer() ? api("/api/releases/local") : "browser", controller: new AbortController() };
  const current = () => pageActive && localLookup === request && lookupMatches(request) && !request.controller.signal.aborted;
  btn.disabled = true; btn.textContent = "Searching…";
  $("#localChangeStatus").textContent = `Finding historical imagery updates near ${request.name}…`;
  try {
    const hits = isServer() ? await E.requestJSON(api("/api/releases/local"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lon: c.lng, lat: c.lat, zoom: 17 }), signal: request.controller.signal })
      : await E.localChanges(c.lng, c.lat, 17, { signal: request.controller.signal });
    if (!current()) return;
    if (!Array.isArray(hits) || hits.some(hit => !Number.isSafeInteger(hit?.release))) throw new Error("Invalid imagery update list");
    localHits = new Set(hits.map(h => h.release)); renderReleases();
    $("#localChangeStatus").textContent = `${localHits.size} historical imagery update${localHits.size === 1 ? "" : "s"} near ${request.name} · centre tile at zoom 17. Orange labels are updates; the active row is the viewed map.`;
  } catch (error) {
    if (current()) { localHits = new Set(); renderReleases(); $("#localChangeStatus").textContent = `Could not find imagery updates near ${request.name}: ${error.message}. Try again.`; }
  } finally { if (localLookup === request) { btn.disabled = false; btn.textContent = "Changes at AOI"; } }
};
const relMode = () => $$('[name=relMode]').find(r => r.checked).value;
function updModeHint() {
  const m = relMode();
  $("#relModeHint").textContent = m === "latest" ? "Newest Wayback release for every AOI."
    : m === "local" ? "For each AOI, every release where the imagery actually changed. Builds a time series per airport or port."
    : `${S.selRel.size} release${S.selRel.size === 1 ? "" : "s"} ticked below, applied to every AOI.`;
  store.set("relMode", m);
}
$$('[name=relMode]').forEach(r => r.onchange = updModeHint);
{ const m = store.get("relMode", "latest"), el = $$('[name=relMode]').find(r => r.value === m); if (el) el.checked = true; }

// ---------------------------------------------------------------- models
const curModel = () => S.models.find(m => m.key === $("#model").value);
async function loadModels() {
  const sel = $("#model");
  if (isServer()) {
    try { const j = await (await fetch(api("/api/models"))).json();
      S.models = j.models.map(m => ({ key: m, label: m, server: true })); $("#baseModel").innerHTML = j.models.map(m => `<option>${esc(m)}</option>`).join(""); $("#baseModel").value = j.default;
    } catch { S.models = []; }
  } else {
    let list = [];
    try { list = await (await fetch("models/models.json", { cache: "no-cache" })).json(); } catch {}
    S.models = list.map(m => ({ key: "url:" + m.file, label: `${m.label || m.file}`, url: "models/" + m.file, names: m.names, imgsz: m.imgsz, size: m.size_mb }))
      .concat(S.customModels);
  }
  sel.innerHTML = S.models.map(m => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join("") || `<option value="">No model found</option>`;
  const saved = store.get("model", null); if (saved && S.models.some(m => m.key === saved)) sel.value = saved;
  updModelInfo();
}
function updModelInfo() {
  const m = curModel();
  $("#modelInfo").textContent = !m ? (isServer() ? "" : "Built-in models appear after the GitHub Pages workflow runs. You can load an .onnx file now.")
    : m.server ? "" : m.custom ? "Your model" : `DOTA aerial classes · ${m.imgsz || 1024} px${m.size ? " · " + m.size + " MB" : ""}`;
  $("#namesRow").hidden = isServer() || !(m && m.custom);
  if (m && m.custom) $("#customNames").value = (m.names || []).join(", ");
  updateRunSelection();
}
$("#model").onchange = () => { store.set("model", $("#model").value); updModelInfo(); const m = curModel(); if (m && m.names) mergeClasses(m.names.map(n => E.LABELS[n] || n)); };
$("#onnxIn").onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = "";
  const names = store.get("dsClasses", []);
  if (readOnly) return;
  const m = { key: "file:" + (window.GVStorage?.uuid() || Date.now() + ":" + ++modelSourceSequence), label: f.name + " (loaded file)", buffer: new Uint8Array(await f.arrayBuffer()), names, custom: true };
  const source = { ...m };
  await persistWrite(async () => { await DB.saveModel(source); delete m.buffer; }).catch(() => {});
  S.customModels = S.customModels.filter(x => x.key !== m.key).concat(m);
  await loadModels(); $("#model").value = m.key; store.set("model", m.key); updModelInfo();
  toast(names.length ? `Loaded ${f.name}. Class names taken from your last training dataset; check them below.` : `Loaded ${f.name}. Enter its class names below.`, 4500);
};
$("#customNames").onchange = () => { const m = curModel(); if (m && !readOnly) { m.names = $("#customNames").value.split(",").map(s => s.trim()).filter(Boolean); mergeClasses(m.names); const source = { ...m }; persistWrite(() => DB.saveModel(source)).catch(() => {}); } };

function mergeClasses(list) { list.forEach(c => { if (c && !S.classes.includes(c)) S.classes.push(c); }); store.set("classes", S.classes); renderClasses(); }
function renderClasses() {
  $("#classChips").innerHTML = S.classes.map(c => `<label class="chip"><input type="checkbox" value="${esc(c)}" ${S.wantClasses.has(c) ? "checked" : ""}><span class="sw" style="background:${color(c)}"></span>${esc(c.replace(/_/g, " "))}</label>`).join("");
  $$("#classChips input").forEach(i => i.onchange = () => { i.checked ? S.wantClasses.add(i.value) : S.wantClasses.delete(i.value); store.set("want", [...S.wantClasses]); renderLegend(); });
  const cur = $("#drawClass").value;
  $("#drawClass").innerHTML = S.classes.map(c => `<option value="${esc(c)}">${esc(c.replace(/_/g, " "))}</option>`).join("");
  if (cur) $("#drawClass").value = cur;
  renderLegend();
}
function renderLegend() {
  const used = [...S.wantClasses].slice(0, 8);
  $("#legend").innerHTML = '<span class="label">Classes</span>' + used.map(c => `<span><span class="sw" style="background:${color(c)}"></span>${esc(c.replace(/_/g, " "))}</span>`).join("");
  $("#legend").hidden = !used.length;
}
$("#conf").oninput = () => $("#confV").textContent = (+$("#conf").value).toFixed(2);

// ---------------------------------------------------------------- run
const logEl = $("#jobLog");
const pendingJob = job => ["queued", "running", "cancelling", "interrupted"].includes(job.status);
function browserQueueState() {
  let state = "idle", label = "Idle", hint = "One job runs at a time. Queued jobs start when the current job finishes.";
  if (activeBrowserJob) {
    state = "running"; label = activeBrowserJob.status === "cancelling" ? "Cancelling" : pendingJob(activeBrowserJob) ? "1 running" : "Finishing job";
    hint = label === "Finishing job" ? "Saving the completed job before starting the next one." : "The current job must finish or finish cancelling before the next job starts.";
  } else if (browserQueue.length) {
    if (!pageActive) { state = "suspended"; label = "Suspended"; hint = "Return to this page and resume the saved queue."; }
    else if (!persistenceReady) { state = "opening"; label = "Opening storage"; hint = "Waiting for saved jobs to finish loading."; }
    else if (readOnly) { state = "read-only"; label = "Read only"; hint = "Another tab or a storage change prevents processing. Close the other tab and reload this page."; }
    else if (storageError) { state = "storage-error"; label = "Saving blocked"; hint = "The queue is paused because saving failed. Retry saving, then choose Resume queue."; }
    else if (serverRunning) { state = "server"; label = "Server job running"; hint = "Browser jobs will continue after the server job finishes."; }
    else if (datasetExportRunning) { state = "dataset"; label = "Building dataset"; hint = "Browser jobs will continue after the dataset export finishes."; }
    else if (queuePaused) { state = "paused"; label = "Paused"; hint = "Saved work is paused after reopening, suspension or a saving error. Choose Resume queue to continue."; }
    else if (browserQueue[0].durableReady === false) { state = "saving"; label = "Saving queued job"; hint = "Waiting for the first queued job to finish saving before it can start."; }
    else { state = "ready"; label = "Ready"; hint = "Waiting jobs are ready. Choose Start queue if processing has not started."; }
  } else if (datasetExportRunning) { state = "dataset"; label = "Building dataset"; }
  return { state, label, hint, waiting: browserQueue.length, activeId: activeBrowserJob?.id || null,
    paused: queuePaused, draining: queueDraining, pendingWrites: pendingWrites.length, headReady: browserQueue[0]?.durableReady !== false };
}
function renderQueueState() {
  const status = browserQueueState();
  $("#queueStatus").textContent = `${status.label} · ${status.waiting}/${MAX_WAITING_JOBS} queued`;
  $("#queueHint").textContent = status.hint;
  $("#resumeQueue").hidden = !status.waiting || Boolean(activeBrowserJob) || readOnly;
  $("#resumeQueue").disabled = !pageActive || !persistenceReady || Boolean(storageError) || serverRunning || datasetExportRunning || !status.headReady;
  $("#resumeQueue").textContent = queuePaused ? "Resume queue" : "Start queue";
}
function updateJobProgress(job, refreshLog = false) {
  const percent = Math.round(job.progress * 100), bar = $("#queue-progress-" + job.id), label = $("#queue-percent-" + job.id);
  if (bar) { bar.style.width = percent + "%"; bar.setAttribute("aria-valuenow", String(percent)); }
  if (label) label.textContent = percent + "%";
  if (selectedBrowserJobId !== job.id) return;
  $("#prog").style.width = percent + "%";
  if (refreshLog) { logEl.textContent = job.log.join("\n"); logEl.scrollTop = logEl.scrollHeight; }
  $("#cancelBtn").hidden = !pendingJob(job);
  $("#cancelBtn").disabled = job.status === "cancelling";
  $("#cancelBtn").textContent = job.status === "queued" ? "Cancel queued" : job.status === "cancelling" ? "Cancelling…" : "Cancel job";
}
function jlog(job, msg) { job.log.push(`${new Date().toTimeString().slice(0, 8)}  ${msg}`); updateJobProgress(job, true); }
function selectBrowserJob(id) {
  const job = BJOBS[id]; if (!job) return;
  selectedBrowserJobId = id; ++viewEpoch; renderBrowserQueue();
}
function viewBrowserResults(id) {
  if (!BJOBS[id]) return;
  selectedBrowserJobId = id; S.jobId = id; renderBrowserQueue(); showTab("res");
}
function renderBrowserQueue() {
  const focused = document.activeElement?.dataset;
  const focusKey = ["jobLog", "jobResults", "jobCancel"].find(key => focused?.[key]);
  const focusId = focusKey && focused[focusKey];
  const pending = [...(activeBrowserJob ? [activeBrowserJob] : []), ...browserQueue];
  const recent = Object.values(BJOBS).filter(job => !pendingJob(job)).slice(-5).reverse();
  renderQueueState();
  $("#jobQueue").innerHTML = pending.concat(recent).map(job => `<div class="card queue-job${selectedBrowserJobId === job.id ? " selected" : ""}" data-queued-job="${job.id}">
    <div class="row"><b class="queue-model">${esc(GVCompare.modelName(job.params))}</b><span class="hint">${esc(job.status)}</span></div>
    <div class="hint">${job.aois.length} AOI(s) · ${esc(job.params.release_mode)} dates · z${job.params.zoom} · <span id="queue-percent-${job.id}">${Math.round(job.progress * 100)}%</span></div>
    <div class="bar"><i id="queue-progress-${job.id}" role="progressbar" aria-label="Job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(job.progress * 100)}" style="width:${job.progress * 100}%"></i></div>
    <div class="row"><button class="btn ghost" data-job-log="${job.id}" aria-pressed="${selectedBrowserJobId === job.id}">Progress</button><button class="btn ghost" data-job-results="${job.id}" ${job.results.length || !pendingJob(job) ? "" : "disabled"}>Results</button>${pendingJob(job) ? `<button class="btn ghost" data-job-cancel="${job.id}" ${job.status === "cancelling" ? "disabled" : ""}>${job.status === "queued" ? "Cancel queued" : job.status === "cancelling" ? "Cancelling…" : "Cancel job"}</button>` : ""}</div>
  </div>`).join("") || '<p class="hint">No browser jobs yet.</p>';
  $("#jobQueue").querySelectorAll("[data-job-log]").forEach(button => button.onclick = () => selectBrowserJob(button.dataset.jobLog));
  $("#jobQueue").querySelectorAll("[data-job-results]").forEach(button => button.onclick = () => viewBrowserResults(button.dataset.jobResults));
  $("#jobQueue").querySelectorAll("[data-job-cancel]").forEach(button => button.onclick = () => cancelBrowserJob(button.dataset.jobCancel));
  const selected = BJOBS[selectedBrowserJobId]; if (selected) updateJobProgress(selected, true);
  if (focusId) {
    const attribute = focusKey.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
    const target = $("#jobQueue").querySelector(`[data-${attribute}="${focusId}"]`) || $("#jobQueue").querySelector(`[data-job-log="${focusId}"]`);
    target?.focus({ preventScroll: true });
  }
  updateRunSelection();
  renderStorage();
}
function cancelBrowserJob(id, reason = "Cancelled by user") {
  if (readOnly) return;
  const job = BJOBS[id]; if (!job || !pendingJob(job)) return;
  if (job === activeBrowserJob) {
    job.status = "cancelling"; job.controller.abort();
  } else {
    const index = browserQueue.indexOf(job); if (index >= 0) browserQueue.splice(index, 1);
    job.status = "cancelled"; job.modelSpec = null; job.releaseSource = null; job.fingerprint = null;
    jlog(job, reason + ". Removed from the queue before processing."); job.resolveFinished?.(job); job.resolveFinished = null;
    checkpointJob(job).catch(() => {});
  }
  renderBrowserQueue();
  drainBrowserQueue();
}
async function drainBrowserQueue() {
  if (queueDraining || serverRunning || datasetExportRunning || !pageActive || queuePaused || !persistenceReady || readOnly || storageError) return;
  queueDraining = true;
  try {
    while (browserQueue.length && browserQueue[0].durableReady !== false && pageActive && !serverRunning && !datasetExportRunning && !queuePaused && !readOnly && !storageError) {
      const job = browserQueue.shift(); activeBrowserJob = job;
      let runtimeFinished;
      job.runtimeFinished = new Promise(resolve => { runtimeFinished = resolve; });
      job.status = "running"; job.suspending = false; job.controller = new AbortController(); renderBrowserQueue();
      try { await checkpointJob(job); await runBrowser(job); }
      catch (error) { job.status = storageError ? "interrupted" : "error"; jlog(job, "ERROR: " + error.message); }
      finally {
        job.controller = null;
        if (job.status === "interrupted") {
          if (durable && job.durableReady !== false && job.modelSpec) delete job.modelSpec.buffer;
          if (!browserQueue.includes(job)) browserQueue.unshift(job);
          queuePaused = true;
        } else { job.modelSpec = null; job.releaseSource = null; job.fingerprint = null; }
        await checkpointJob(job).catch(() => {});
        activeBrowserJob = null;
        renderBrowserQueue();
        // A finishing job can refresh its own selected results without moving the
        // map, interrupting edits/comparison, or selecting another job's results.
        if (pageActive && selectedBrowserJobId === job.id && !S.clip && !comparing() && viewEpoch === job.viewEpoch) {
          S.jobId = job.id; showTab("res");
        } else if (pageActive && !comparing() && S.jobId === job.id) loadJobs();
        job.resolveFinished?.(job); job.resolveFinished = null;
        runtimeFinished();
      }
    }
  } finally { queueDraining = false; updateRunSelection(); }
}
$("#runBtn").onclick = async () => {
  if (!pageActive || !persistenceReady || readOnly || storageError || serverRunning || (isServer() && (activeBrowserJob || browserQueue.length || queueDraining))) return;
  if (!S.aois.length) return toast("Add at least one AOI");
  const chosen = chosenRunAois();
  if (!chosen.length) return toast("Select at least one AOI in Detect");
  const mode = relMode();
  if (mode === "selected" && !S.selRel.size) { showTab("img"); return toast("Tick at least one release"); }
  const aois = JSON.parse(JSON.stringify(chosen));
  if (isServer()) return runServer(mode, aois);
  return enqueueBrowser(mode, aois);
};
$("#cancelBtn").onclick = () => cancelBrowserJob(selectedBrowserJobId);

async function enqueueBrowser(mode, aois) {
  const detectOn = $("#detectOn").checked, m = curModel();
  if (detectOn && !m) return toast("No model available. Load an .onnx file or untick Run detection.");
  if (detectOn && m.custom && !(m.names && m.names.length)) return toast("Enter the class names of your model");
  if (browserQueue.length >= MAX_WAITING_JOBS) return toast("Queue full. Wait for a job to start or cancel a queued job.");
  if (!S.releases.length) return toast("Wait for Wayback dates to load, or use Refresh dates.");
  let allocationOptions;
  try { allocationOptions = clipAllocationOptions(); aois.forEach(aoi => E.allocations.requireRaster(E.estimateRaster(aoi.geometry, Number($("#zoom").value), allocationOptions))); }
  catch (error) { renderAllocationPreflight(); return toast(error.message, 6500); }
  const params = { release_mode: mode, releases: [...S.selRel], zoom: +$("#zoom").value, classes: [...S.wantClasses], conf: +$("#conf").value,
    model: m ? m.label : null, model_key: m?.key || null, imgsz: m?.imgsz || null, detect: detectOn, maxTiles: allocationOptions.maxTiles,
    bounded: true, maskPolicy: "preserve-small-canvas/area-v1", png: $("#pngOn").checked, geotiff: $("#tifOn").checked, model_names: m?.names?.slice(), allocationLimits: { ...allocationOptions.limits } };
  const releaseSource = JSON.parse(JSON.stringify(S.releases));
  if (mode === "selected" && !releaseSource.some(release => params.releases.includes(release.release))) return toast("The selected dates are unavailable. Check Wayback and select a release.");
  const fingerprint = JSON.stringify({ params, aois, releaseSource: mode === "latest" ? releaseSource.slice(0, 1) : releaseSource });
  const duplicate = Object.values(BJOBS).find(job => pendingJob(job) && job.fingerprint === fingerprint);
  if (duplicate) { selectBrowserJob(duplicate.id); toast("A job with these settings is already running or queued."); return; }
  const id = "browser_" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})/, "$1_") + "_" + (globalThis.crypto?.randomUUID?.().slice(0, 8) || Date.now().toString(36) + "_" + ++browserJobSequence);
  const modelSpec = detectOn ? { key: m.key, url: m.url, buffer: m.buffer, names: m.names?.slice(), imgsz: m.imgsz } : null;
  const job = BJOBS[id] = { id, createdAt: Date.now() + ++browserJobSequence / 1000, status: "queued", progress: 0, log: [], results: [], outcomes: [], params, aois, modelSpec, releaseSource, fingerprint };
  job.durableReady = false;
  job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
  browserQueue.push(job); selectedBrowserJobId = id; job.viewEpoch = ++viewEpoch;
  if (!S.clip && !comparing()) S.jobId = id;
  jlog(job, `Queued: ${GVCompare.modelName(params)} · ${aois.length} AOI(s). Settings captured for this job.`);
  renderBrowserQueue();
  try {
    const source = detectOn ? { ...m, names: modelSpec.names } : null;
    const record = window.GVStorage?.jobRecord(job);
    await persistWrite(async () => {
      if (source) await DB.saveModel(source);
      await DB.saveJob(record); job.durableReady = true;
    }, job.id);
    job.durableReady = true;
    drainBrowserQueue();
  } catch { job.resolveFinished?.(job); job.resolveFinished = null; }
  return job.finished;
}
async function runBrowser(job) {
  const { params, modelSpec, releaseSource, controller } = job, signal = controller.signal;
  try {
    let model = null;
    if (params.detect) {
      if (durable && !modelSpec.buffer && !modelSpec.url) {
        const source = await DB.model(modelSpec.key);
        if (!source?.buffer) throw new Error("Saved custom model is missing. Load the model again before resuming.");
        modelSpec.buffer = source.buffer;
      }
      jlog(job, `Loading model ${params.model}…`);
      const loaded = await E.loadModel({ ...modelSpec, signal });
      // Session reuse must not reuse another job's mutable class-name array.
      model = { ...loaded, names: modelSpec.names?.slice() || loaded.names };
      jlog(job, `Model ready on ${model.provider === "webgpu" ? "GPU (WebGPU)" : "CPU (WebAssembly)"} · ${model.imgsz} px input`);
      params.provider = model.provider; params.imgsz = model.imgsz;
    }
    const plan = job.plan ? job.plan.map(entry => [job.aois[entry.aoiIndex], entry.release]) : [];
    if (!job.plan) for (const aoi of job.aois) {
      let rels;
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (params.release_mode === "latest") rels = releaseSource.slice(0, 1);
      else if (params.release_mode === "selected") rels = releaseSource.filter(r => params.releases.includes(r.release));
      else { const c = L.geoJSON(aoi).getBounds().getCenter(); jlog(job, `${aoi.properties.name}: finding imagery dates…`); rels = await E.localChanges(c.lng, c.lat, Math.min(params.zoom, 17), { signal, releases: releaseSource }); }
      jlog(job, `${aoi.properties.name}: ${rels.length} release(s) ${rels.slice(0, 6).map(r => r.date).join(", ")}${rels.length > 6 ? " …" : ""}`);
      rels.forEach(r => plan.push([aoi, r]));
    }
    if (!job.plan) {
      job.plan = plan.map(([aoi, release], order) => ({ aoiIndex: job.aois.indexOf(aoi), release, clipId: job.id + ":clip:" + order }));
      job.outcomes = plan.map(([aoi, rel], order) => ({ clipId: job.plan[order].clipId, aoi: aoi.properties.name, aoi_id: E.slug(aoi.properties.name),
        date: rel.date, release: rel.release, requestedZoom: params.zoom, status: "pending" }));
      await checkpointJob(job);
    }
    for (let i = 0; i < plan.length; i++) {
      const [aoi, rel] = plan[i], base = i / plan.length, step = 1 / plan.length;
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const outcome = job.outcomes[i];
      if (job.results.some(result => result.storeId === job.plan[i].clipId) || ["completed", "partial", "failed", "unavailable"].includes(outcome.committedStatus)) { outcome.status = outcome.committedStatus || "completed"; continue; }
      outcome.status = "running";
      jlog(job, `[${i + 1}/${plan.length}] ${aoi.properties.name} · ${rel.date}`);
      try {
        const r = await E.processClip(aoi, rel, { zoom: params.zoom, model, classes: params.classes, conf: params.conf, signal,
          maxTiles: params.maxTiles, geotiff: params.geotiff, limits: params.allocationLimits,
          bounded: params.bounded !== false, png: params.png !== false, store: durable ? DB : null, jobId: job.id, clipId: job.plan[i].clipId,
          onWaiting: () => jlog(job, "    Waiting for browser image/export resources to be released…"),
          onEstimate: estimate => { outcome.allocation = estimate; outcome.zoom = estimate.zoom;
            jlog(job, `    Budget: z${estimate.requestedZoom}${estimate.zoomReduced ? " → z" + estimate.zoom : ""} · ${estimate.width}×${estimate.height} px · ${estimate.tiles} tiles · estimated ${(estimate.estimatedBytes / 1048576).toFixed(1)} MiB`); },
          onCoverage: coverage => { outcome.zoom = coverage.zoom; outcome.coverage = coverage;
            jlog(job, `    Coverage z${coverage.zoom}: ${coverage.available}/${coverage.total} tiles available, ${coverage.unavailable} unavailable, ${coverage.unknown} unknown · ${coverage.checks} check(s) · ${(coverage.ms / 1000).toFixed(1)}s`); },
          onProgress: f => { job.progress = base + step * f; updateJobProgress(job); } });
        if (signal.aborted) {
          const spool = r.artifactSpool || Object.values(r.blobs || {}).find(value => value?.gmdArtifact)?.spool;
          if (spool) await window.GVStreaming?.discardArtifact(spool, durable ? DB : null);
          E.operations.check(signal);
        }
        r.createdAt ??= Date.now();
        r.storeId = job.plan[i].clipId; r.order = i; r.persisted = false;
        job.results.push(r);
        Object.assign(outcome, { status: r.missing ? "partial" : "completed", zoom: r.zoom, coverage: r.coverage, total: r.total });
        outcome.committedStatus = outcome.status;
        job.progress = base + step;
        // Commit the native artifacts, immutable predictions and outcome in one
        // transaction. Only a completed transaction permits releasing payloads.
        const snapshot = window.GVStorage?.jobRecord(job);
        await persistWrite(async () => {
          await DB.saveClip(snapshot, r);
          r.persisted = true;
          if (S.clip?.source !== r) { delete r.fc; delete r.blobs; delete r.draftFC; }
        }, job.id);
        jlog(job, `    z${r.zoom} · ${r.size[0]}×${r.size[1]} px${r.missing ? ` · ${r.missing} tiles missing` : ""} · ${r.total} objects ${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(" ")}`);
        if (r.missing) jlog(job, "    WARNING: Incomplete imagery; these counts cover only the available tiles.");
      } catch (error) {
        if (error.name === "QuotaExceededError") { storageError = error; queuePaused = true; }
        if (storageError) throw error;
        if (error.name === "AbortError" || signal.aborted) throw error;
        Object.assign(outcome, { status: error.code === "NO_IMAGERY" ? "unavailable" : "failed", code: error.code || "CLIP_ERROR",
          message: error.message, zoom: error.zoom ?? outcome.zoom ?? params.zoom, coverage: error.coverage || outcome.coverage,
          allocation: error.estimate || outcome.allocation });
        jlog(job, `    ${outcome.status === "unavailable" ? "UNAVAILABLE" : "FAILED"}: ${outcome.aoi} · ${rel.date} · release ${rel.release} · z${outcome.zoom} · ${outcome.code}: ${error.message}`);
        outcome.committedStatus = outcome.status;
      }
      job.progress = base + step; updateJobProgress(job); renderBrowserQueue();
      await checkpointJob(job);
    }
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const incomplete = job.outcomes.filter(outcome => outcome.status !== "completed").length;
    job.status = !job.results.length && job.outcomes.length ? "error" : incomplete ? "partial" : "done";
    job.progress = 1;
    const tot = job.results.reduce((s, r) => s + r.total, 0);
    jlog(job, `Finished${job.status === "partial" ? " (partial)" : job.status === "error" ? " (no completed clips)" : ""}: ${tot} objects across ${job.results.length} AOI/date clips${incomplete ? `; ${job.outcomes.filter(o => o.status === "unavailable").length} unavailable, ${job.outcomes.filter(o => o.status === "failed").length} failed, ${job.outcomes.filter(o => o.status === "partial").length} with incomplete imagery` : ""}. ${durable ? "Saved on this device. Export a zip for a separate backup." : "Export the zip before closing this tab."}`);
    if (pageActive) toast(job.status === "done" ? `${GVCompare.modelName(params)}: job finished` : `${GVCompare.modelName(params)}: job finished with clip issues. See Results.`);
  } catch (e) {
    job.status = job.suspending || storageError ? "interrupted" : signal.aborted || e.name === "AbortError" ? "cancelled" : "error";
    job.outcomes.forEach(outcome => { if (["pending", "running"].includes(outcome.status)) { outcome.status = outcome.status === "running" ? job.status : "not_run"; outcome.message = e.message; } });
    jlog(job, job.status === "interrupted" ? "Paused. Saved clips are kept; resume the unfinished clips when ready." : job.status === "cancelled" ? "Cancelled. Clips finished so far are kept." : "ERROR: " + e.message);
  }
}
async function runServer(mode, aois) {
  const body = { aois: { type: "FeatureCollection", features: aois }, release_mode: mode, releases: [...S.selRel],
    zoom: +$("#zoom").value, classes: [...S.wantClasses], conf: +$("#conf").value, model: $("#model").value, detect: $("#detectOn").checked };
  const base = S.api; selectedBrowserJobId = null; $("#cancelBtn").hidden = true;
  await stopPoll(serverPoll); const owner = E.operations.open("Server job", { timeoutMs: 1800000 }); serverPoll = owner;
  setServerRunning(true);
  try { owner.pending = postJSON("/api/jobs", body, owner.signal); const response = await owner.pending; owner.check(); S.jobId = response.job_id; store.set("job", S.jobId); pollJob(S.jobId, base, owner); }
  catch (e) { if (serverPoll === owner) { serverPoll = null; if (pageActive) toast(e.message); setServerRunning(false); } owner.close(); }
}
async function stopPoll(owner) { if (!owner) return; owner.abort(); clearTimeout(owner.timer); try { await owner.pending; } finally { owner.close(); } }
function pollJob(id, base, owner = E.operations.open("Server job", { timeoutMs: 1800000 })) {
  serverPoll = owner; owner.jobId = id; owner.base = base; let failures = 0;
  const tick = async () => {
    try {
      const j = await E.requestJSON(base + "/api/jobs/" + encodeURIComponent(id), { signal: owner.signal });
      owner.check(); if (!pageActive || serverPoll !== owner) return;
      failures = 0;
    if (!selectedBrowserJobId) {
      $("#prog").style.width = (j.progress * 100).toFixed(1) + "%";
      logEl.textContent = j.log.join("\n") || j.status; logEl.scrollTop = logEl.scrollHeight;
    }
      if (j.status === "running" || j.status === "queued") { owner.timer = setTimeout(() => { owner.pending = tick(); }, 1500); return; }
      serverPoll = null; owner.close(); setServerRunning(false);
      if (j.status === "done") { toast("Job finished"); showTab("res"); }
    } catch (error) {
      if (owner.signal.aborted) { if (serverPoll === owner) { serverPoll = null; owner.close(); setServerRunning(false); if (owner.timedOut && pageActive) toast("Server status polling timed out. Check Results."); } return; }
      if (!pageActive || serverPoll !== owner) return;
      if (++failures >= 5) { serverPoll = null; owner.close(); setServerRunning(false); toast("Server status could not be refreshed. The server job may still be running; check Results.", 6000); }
      else owner.timer = setTimeout(() => { owner.pending = tick(); }, 3000);
    }
  };
  owner.pending = tick(); return owner.pending;
}

// ---------------------------------------------------------------- results
let RES = [], clipGeneration = 0, clipView = null, editRequest = 0;
let jobsGeneration = 0, resultsGeneration = 0, jobsController = null, resultsController = null;
const draftCache = new Map();
const viewMetrics = { created: 0, disposed: 0, imageURLsCreated: 0, imageURLsRevoked: 0, staleReads: 0 };
const draftScope = clip => clip ? clip.storeId || "server:" + clip.job + ":" + clip.path : "live";
function retainDraft(scope, fc, clip, changed = false) {
  let entry = draftCache.get(scope);
  if (!entry || entry.fc !== fc) { entry = { fc, job: clip?.job || null, source: clip?.source, dirty: false, revision: 0 }; draftCache.set(scope, entry); }
  if (changed) entry.dirty = true;
  return entry;
}
function currentView(view) { return clipView === view && !view.disposed && !view.controller.signal.aborted && pageActive && !comparing(); }
const viewAbort = () => new DOMException("Clip view was replaced", "AbortError");
function requireView(view) { if (!currentView(view)) throw viewAbort(); }
function viewRead(view, promise) {
  const signal = view.controller.signal;
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(viewAbort()); };
    if (signal.aborted) cancelled(); else signal.addEventListener("abort", cancelled, { once: true });
    // IndexedDB cannot cancel an individual read. Consume late completion and
    // reject ownership before exposing data; it must never mutate a draft/view.
    Promise.resolve(promise).then(value => {
      signal.removeEventListener("abort", cancelled);
      if (!currentView(view)) { viewMetrics.staleReads++; reject(viewAbort()); } else resolve(value);
    }, error => { signal.removeEventListener("abort", cancelled); reject(error); });
  });
}
let compareRecords = [], compareChosen = [], catalogController = null, pairController = null;
let pairTimer = null;
let catalogGeneration = 0, compareGeneration = 0, compareView = null, compareSaved = null;
let timelineFrames = [], timelineIndex = -1, timelinePlaying = false, timelineLoading = false;
let timelineNeedsFit = false;
let timelineTimer = null, timelineSeekTimer = null, timelineWork = Promise.resolve();
let timelineSampleAnimations = [], timelineSampleTimer = null;
const timelineMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const savedPlayback = GVCompare.playbackSettings(store.get("timelinePlayback", {}));
$("#timelineSpeed").value = String(savedPlayback.interval); $("#timelineEffect").value = savedPlayback.effect; $("#timelineDuration").value = String(savedPlayback.duration);
function timelineMode() { return $("#resultView").value === "timeline"; }
function comparing() { return ["compare", "timeline"].includes($("#resultView").value); }
function outputBase(job, path) { return api("/outputs/" + encodeURIComponent(job) + "/" + path.split("/").map(encodeURIComponent).join("/") + "/"); }
function resultMetadata(result) { const { fc, draftFC, blobs, ...metadata } = result; return metadata; }
function compareRecord(r, params, job, index, browser, metadata) {
  return { ...resultMetadata(r), params, job, browser, sourceIndex: index, createdAt: GVCompare.creationTime(r, metadata), key: `${browser ? "browser" : "server"}:${job}:${index}`,
    model: GVCompare.modelName(params), modelKey: params.detect === false ? "imagery" : params.model_key || params.model || null,
    geometry: GVCompare.geometryKey(r.aoiFeature), source: r };
}
function stopComparison({ resumeEdit = true, restoreView = true } = {}) {
  closeTimelineSettings();
  pauseTimeline(); $("#compareSettings").textContent = "";
  timelineFrames = []; timelineIndex = -1; timelineLoading = false; timelineNeedsFit = false; updateTimelineControls();
  ++compareGeneration; pairController?.abort(); pairController = null; clearTimeout(pairTimer); pairTimer = null; compareView?.stop();
  if (compareSaved) {
    const previous = compareSaved; compareSaved = null;
    if (previous.image) clipLayer.addTo(map); if (previous.detections) detLayer.addTo(map);
    if (restoreView && previous.view === clipView && !clipView?.disposed && pageActive) map.setView(previous.centre, previous.zoom, { animate: false });
    $("#hudRel").textContent = previous.hud; $("#legend").style.visibility = previous.legend;
    if (restoreView && resumeEdit && canAnnotate() && previous.view === clipView && previous.editing && S.sel === previous.editing && detLayer.getLayers().includes(previous.editing)) {
      activateEditor(previous.editing);
    }
  }
  if (restoreView && !comparing() && clipView?.ready && pageActive) {
    renderClipImage();
    const editing = clipView.resumeEditing; clipView.resumeEditing = null;
    if (resumeEdit && canAnnotate() && editing && S.sel === editing && detLayer.getLayers().includes(editing)) activateEditor(editing);
  }
}
function exitComparison() {
  ++catalogGeneration; catalogController?.abort(); catalogController = null;
  $("#resultView").value = "review"; $("#compareControls").hidden = true; $("#resultJobControls").hidden = false;
  $("#timelineControls").hidden = true;
  $("#timelinePlayer").hidden = true; $(".mapwrap").classList.remove("timeline-open");
  stopComparison(); compareChosen = []; compareRecords = [];
  $("#showImg").disabled = false; $("#resultHint").textContent = "Select a row to review its clipped imagery and detections.";
  renderResults();
}
async function refreshCompareCatalog() {
  catalogController?.abort(); const controller = catalogController = new AbortController(), generation = ++catalogGeneration;
  stopComparison(); $("#compareHint").textContent = "Loading available runs…"; $("#compareRefresh").disabled = true;
  const records = [], failures = [];
  for (const job of Object.values(BJOBS)) job.results.forEach((r, index) => records.push(compareRecord(r, job.params, job.id, index, true, job)));
  try {
    if (S.online) {
      const jobs = await E.requestJSON(api("/api/jobs"), { signal: controller.signal });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (next < jobs.length && !controller.signal.aborted) {
          const id = jobs[next++].id;
          try {
            const job = await E.requestJSON(api("/api/jobs/" + encodeURIComponent(id)), { signal: controller.signal });
            let params = job.params;
            if (!params) { try { params = (await E.requestJSON(outputBase(id, "") + "summary.json", { signal: controller.signal })).params; } catch (error) { if (controller.signal.aborted) throw error; } }
            const geometries = new Map(), paths = new Map();
            for (const r of job.results || []) paths.set(r.path, (paths.get(r.path) || 0) + 1);
            for (const [index, r] of (job.results || []).entries()) {
              if (controller.signal.aborted) break;
              if (!r.path || paths.get(r.path) > 1) { failures.push(id + ": ambiguous clip path"); continue; }
              const record = compareRecord(r, params || {}, id, index, false, job);
              const key = JSON.stringify([r.aoi_id, r.bounds]);
              if (!geometries.has(key)) geometries.set(key, await E.requestJSON(outputBase(id, r.path) + "aoi.geojson", { signal: controller.signal }));
              record.aoiFeature = geometries.get(key); record.geometry = GVCompare.geometryKey(record.aoiFeature);
              records.push(record);
            }
          } catch (error) { if (!controller.signal.aborted) failures.push(id + ": " + error.message); }
        }
      }));
    }
    if (controller.signal.aborted || generation !== catalogGeneration || !comparing()) return;
    compareRecords = GVCompare.newestFirst(records); compareChosen = compareChosen.filter(key => records.some(r => r.key === key));
    renderResults();
    $("#compareHint").textContent = failures.length ? `${failures.length} run/clip lookup(s) unavailable. Refresh to retry. Select two available clips.`
      : records.length < 2 ? "At least two completed clips are needed. Run the same AOI on different dates or models first."
      : "Select two clips with the same AOI. Date comparison orders older left and newer right.";
    if (timelineMode()) $("#compareHint").textContent = failures.length ? `${failures.length} run/clip lookup(s) unavailable. Refresh to retry.` : "Select history from one AOI, then open the timeline.";
    else if (compareChosen.length === 2) showComparison();
  } catch (error) { if (!controller.signal.aborted && generation === catalogGeneration) $("#compareHint").textContent = "Could not load comparison runs: " + error.message; }
  finally { if (generation === catalogGeneration) $("#compareRefresh").disabled = false; }
}
async function comparisonAsset(record, signal) {
  if (signal.aborted) throw viewAbort();
  let fc, blob;
  if (record.browser) { const result = await readClip(record.source, { draft: false, images: true }); fc = result.fc; blob = result.blobs.display || result.blobs.png; }
  else {
    const base = outputBase(record.job, record.path);
    fc = await E.requestJSON(base + "detections.geojson", { signal });
    const response = await fetch(base + "image.png", { signal });
    if (!response.ok) throw new Error(`Comparison image unavailable (HTTP ${response.status})`);
    blob = await response.blob();
  }
  if (signal.aborted) throw viewAbort();
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !blob) throw new Error("This clip has no usable imagery/detections.");
  const preview = await GVCompare.preview(blob, record.size, signal);
  if (signal.aborted) throw viewAbort();
  return { fc, preview, bounds: clipBounds(record) };
}
function prepareComparisonMap() {
  compareSaved ||= { centre: map.getCenter(), zoom: map.getZoom(), hud: $("#hudRel").textContent, view: clipView,
    image: map.hasLayer(clipLayer), detections: map.hasLayer(detLayer), editing: clipView?.resumeEditing || S.editing, legend: $("#legend").style.visibility };
  finishEdit(); releaseClipImage(); map.removeLayer(clipLayer); map.removeLayer(detLayer); $("#legend").style.visibility = "hidden";
  const Display = timelineMode() ? GVCompare.Timeline : GVCompare.Swipe;
  if (compareView && !(compareView instanceof Display)) { compareView.destroy(); compareView = null; }
  compareView ||= new Display(map, $("#compareMap"));
  $("#compareMap").classList.toggle("timeline-map", timelineMode());
}
function comparisonStyle(feature) { return { color: color(feature.properties.class), weight: 2, fillOpacity: 0.08 }; }
async function showComparison() {
  stopComparison(); $("#compareSettings").textContent = "";
  const selected = compareChosen.map(key => compareRecords.find(r => r.key === key)).filter(Boolean);
  const validation = GVCompare.validatePair(selected, $("#compareKind").value || "dates");
  if (validation.error) { $("#compareHint").textContent = validation.error; return; }
  const generation = ++compareGeneration, controller = pairController = new AbortController();
  const timer = pairTimer = setTimeout(() => controller.abort(), 45000);
  $("#compareHint").textContent = "Preparing comparison…";
  try {
    // Sequential preparation bounds retained decoded images; originals stay in exports.
    await timelineWork.catch(() => {});
    if (generation !== compareGeneration || controller.signal.aborted || !comparing()) return;
    const left = await comparisonAsset(validation.pair[0], controller.signal);
    if (generation !== compareGeneration || controller.signal.aborted || !pageActive || !comparing()) return;
    const right = await comparisonAsset(validation.pair[1], controller.signal);
    if (generation !== compareGeneration || controller.signal.aborted || !comparing()) return;
    prepareComparisonMap(); compareView.setPosition?.(50);
    await compareView.show([left, right], comparisonStyle);
    if (generation !== compareGeneration || controller.signal.aborted || !pageActive || !comparing()) return;
    const [a, b] = validation.pair;
    $("#compareLeftLabel").textContent = `${validation.roles[0]} · ${a.date} · ${a.model} · ${left.fc.features.length} objects`;
    $("#compareRightLabel").textContent = `${validation.roles[1]} · ${b.date} · ${b.model} · ${right.fc.features.length} objects`;
    $("#hudRel").textContent = `${a.date} ↔ ${b.date}`;
    $("#compareHint").textContent = `${a.aoi} · drag the map divider to compare. Model predictions are read-only.`;
    $("#compareSettings").textContent = GVCompare.settingsNote(a, b) + " Full-resolution images remain in exports.";
    map.fitBounds(left.bounds);
  } catch (error) {
    if (generation === compareGeneration) { stopComparison(); $("#compareHint").textContent = controller.signal.aborted ? "Comparison timed out. Refresh or select the pair again." : error.message; }
  } finally { clearTimeout(timer); if (pairTimer === timer) pairTimer = null; }
}
function chosenHistory() { return compareChosen.map(key => compareRecords.find(record => record.key === key)).filter(Boolean); }
function updateTimelineControls() {
  const selected = chosenHistory(), validation = GVCompare.validateTimeline(selected), count = timelineFrames.length;
  $("#timelineSelectAOI").disabled = !selected.length;
  $("#timelineOpen").disabled = Boolean(validation.error);
  $("#timelineSelection").textContent = `${selected.length} selected. ` + (validation.error || `${validation.frames[0].date} → ${validation.frames.at(-1).date}`);
  $("#timelineSlider").disabled = !count; $("#timelineSlider").max = Math.max(0, count - 1);
  $("#timelineSlider").value = Math.max(0, timelineIndex);
  $("#timelinePrev").disabled = !count || timelineIndex <= 0;
  $("#timelineNext").disabled = !count || timelineIndex >= count - 1;
  $("#timelinePlay").disabled = !count || timelineIndex < 0;
  $("#timelinePlay").textContent = timelinePlaying ? "Pause" : timelineIndex === count - 1 && count ? "Replay" : "Play";
  $("#timelinePlay").setAttribute("aria-pressed", String(timelinePlaying));
  $("#timelineStart").textContent = count ? timelineFrames[0].date : "Older";
  $("#timelineEnd").textContent = count ? timelineFrames.at(-1).date : "Newer";
  $("#timelinePlayer").setAttribute("aria-busy", String(timelineLoading));
  if (!count) {
    $("#timelineSlider").setAttribute("aria-valuetext", "No timeline selected");
    $("#timelineCurrent").textContent = "Open a timeline to view the selected history on the map.";
    $("#timelineStatus").textContent = "Select results in the sidebar, then open the timeline.";
  }
}
function pauseTimeline() {
  timelinePlaying = false; clearTimeout(timelineTimer); timelineTimer = null;
  clearTimeout(timelineSeekTimer); timelineSeekTimer = null;
  compareView?.finishTransition?.();
  updateTimelineControls();
  if (timelineFrames.length && timelineIndex >= 0 && !timelineLoading) $("#timelineStatus").textContent = timelineIndex === timelineFrames.length - 1 ? "Latest selected frame · Replay to start again" : "Paused · drag the slider or press Play";
}
function scheduleTimeline() {
  clearTimeout(timelineTimer); timelineTimer = null;
  if (!timelinePlaying || timelineLoading) return;
  if (timelineIndex >= timelineFrames.length - 1) return pauseTimeline();
  const delay = [1000, 2000, 4000].includes(Number($("#timelineSpeed").value)) ? Number($("#timelineSpeed").value) : 2000;
  timelineTimer = setTimeout(() => { timelineTimer = null; renderTimelineFrame(timelineIndex + 1); }, delay);
}
function renderTimelineFrame(index) {
  if (!timelineMode() || !pageActive || !timelineFrames[index]) return Promise.resolve();
  const frame = timelineFrames[index], generation = ++compareGeneration;
  pairController?.abort(); clearTimeout(pairTimer); pairTimer = null;
  if (compareView?.pending?.size) compareView.stop();
  else compareView?.finishTransition?.();
  const controller = pairController = new AbortController();
  timelineLoading = true; $("#compareHint").textContent = `Loading history ${index + 1}/${timelineFrames.length} · ${frame.date}…`;
  $("#timelineStatus").textContent = $("#compareHint").textContent; $("#timelinePlayer").setAttribute("aria-busy", "true");
  // IndexedDB reads and native bitmap decodes cannot always be interrupted.
  // Drain the previous frame before starting another; stale seeks never decode.
  const work = timelineWork.catch(() => {}).then(async () => {
    const current = () => generation === compareGeneration && !controller.signal.aborted && pageActive && timelineMode();
    if (!current()) return;
    const timer = pairTimer = setTimeout(() => controller.abort(), 45000);
    const cancelImage = () => { if (generation === compareGeneration) { if (compareView?.pending?.size) compareView.stop(); else compareView?.finishTransition?.(); } };
    controller.signal.addEventListener("abort", cancelImage, { once: true });
    try {
      const asset = await comparisonAsset(frame, controller.signal);
      if (!current()) return;
      prepareComparisonMap();
      await compareView.showFrame(asset, comparisonStyle, timelinePlayback());
      if (controller.signal.aborted) throw viewAbort();
      if (!current()) return;
      timelineIndex = index;
      const label = `${index + 1}/${timelineFrames.length} · ${frame.aoi} · ${frame.date} · ${frame.model} · ${asset.fc.features.length} objects`;
      $("#compareLeftLabel").textContent = label; $("#hudRel").textContent = frame.date;
      $("#timelineCurrent").textContent = label; $("#timelineSlider").setAttribute("aria-valuetext", label);
      $("#compareHint").textContent = "Drag the timeline or use Play to explore this AOI. Predictions are read-only.";
      $("#timelineStatus").textContent = timelinePlaying ? "Playing oldest to newest" : "Drag the slider or press Play";
      if (timelineNeedsFit) {
        const playerHeight = $("#timelinePlayer").getBoundingClientRect?.().height || 0;
        const room = Math.max(0, (map.getSize?.().y || Infinity) - 80), top = Math.min(110, room * 0.35);
        map.fitBounds(asset.bounds, { paddingTopLeft: [12, top], paddingBottomRight: [12, Math.min(playerHeight + 42, room - top)] }); timelineNeedsFit = false;
      }
    } catch (error) {
      if (generation === compareGeneration) {
        pauseTimeline(); $("#compareHint").textContent = (controller.signal.aborted ? "History frame timed out." : error.message) + " Select a frame or reopen the timeline to retry.";
        $("#timelineStatus").textContent = $("#compareHint").textContent;
      }
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener("abort", cancelImage);
      if (pairTimer === timer) pairTimer = null;
      if (generation === compareGeneration) { pairController = null; timelineLoading = false; updateTimelineControls(); scheduleTimeline(); }
    }
  });
  timelineWork = work; return work;
}
$("#timelineOpen").onclick = () => {
  const validation = GVCompare.validateTimeline(chosenHistory());
  if (validation.error) { $("#compareHint").textContent = validation.error; return; }
  stopComparison(); timelineFrames = validation.frames; timelineNeedsFit = true;
  $("#compareSettings").textContent = GVCompare.timelineNote(timelineFrames) + " Full-resolution images remain in exports.";
  updateTimelineControls(); return renderTimelineFrame(0);
};
$("#timelineSelectAOI").onclick = () => {
  const first = chosenHistory()[0]; if (!first) return;
  stopComparison(); compareChosen = compareRecords.filter(record => record.geometry === first.geometry).map(record => record.key); renderResults();
  $("#compareHint").textContent = "Open the selected AOI history to begin.";
};
$("#timelineSlider").oninput = () => {
  const index = Number($("#timelineSlider").value); pauseTimeline();
  clearTimeout(timelineSeekTimer);
  timelineSeekTimer = setTimeout(() => { timelineSeekTimer = null; renderTimelineFrame(index); }, 80);
};
$("#timelinePrev").onclick = () => { pauseTimeline(); return renderTimelineFrame(Math.max(0, timelineIndex - 1)); };
$("#timelineNext").onclick = () => { pauseTimeline(); return renderTimelineFrame(Math.min(timelineFrames.length - 1, timelineIndex + 1)); };
$("#timelinePlay").onclick = () => {
  if (timelinePlaying) return pauseTimeline();
  if (!timelineFrames.length) return;
  closeTimelineSettings();
  timelinePlaying = true; updateTimelineControls();
  $("#timelineStatus").textContent = "Playing oldest to newest";
  if (timelineIndex < 0 || timelineIndex === timelineFrames.length - 1) return renderTimelineFrame(0);
  scheduleTimeline();
};
function timelinePlayback() { return GVCompare.playbackSettings({ effect: $("#timelineEffect").value, duration: $("#timelineDuration").value, interval: $("#timelineSpeed").value }); }
function stopTimelineSample() {
  clearTimeout(timelineSampleTimer); timelineSampleTimer = null;
  for (const animation of timelineSampleAnimations) animation.cancel(); timelineSampleAnimations = [];
  $("#timelineSampleBefore").style.opacity = "1"; $("#timelineSampleAfter").style.opacity = "0";
}
function closeTimelineSettings() { stopTimelineSample(); $("#timelineSettings").hidden = true; $("#timelineSettingsToggle").setAttribute("aria-expanded", "false"); }
function fitTimelineSettings() {
  if ($("#timelineSettings").hidden) return;
  const player = $("#timelinePlayer").getBoundingClientRect?.(), bounds = $(".mapwrap").getBoundingClientRect?.();
  if (player && bounds) {
    const available = player.top - bounds.top - 16, compact = available < 80;
    $("#timelineSettings").style.bottom = compact ? "0px" : "calc(100% + 8px)";
    $("#timelineSettings").style.maxHeight = Math.max(40, Math.min(390, compact ? bounds.height - 44 : available)) + "px";
  }
}
function updateTimelineMotion() {
  const settings = timelinePlayback(), reduced = Boolean(timelineMotion?.matches);
  $("#timelineDuration").disabled = settings.effect === "none" || reduced;
  $("#timelinePreview").disabled = settings.effect === "none" || reduced;
  $("#timelineMotionNote").textContent = reduced ? "Reduced motion is enabled. Layer changes are instant." : "Transition imagery and detection layers together. Map position stays fixed.";
}
function previewTimelineTransition() {
  stopTimelineSample(); updateTimelineMotion();
  const settings = timelinePlayback(), before = $("#timelineSampleBefore"), after = $("#timelineSampleAfter");
  if (timelineMotion?.matches || settings.effect === "none" || !after.animate) return;
  const bounds = $("#timelineTransitionPreview").getBoundingClientRect?.() || { width: 300, height: 72 };
  const keyframes = GVCompare.transitionKeyframes(settings.effect, { top: 0, right: bounds.width, bottom: bounds.height, left: 0 });
  try {
    after.style.opacity = "1";
    const timing = { duration: settings.duration, easing: "ease-in-out", fill: "both" };
    timelineSampleAnimations.push(after.animate(keyframes.incoming, timing));
    timelineSampleAnimations.push(before.animate(keyframes.outgoing, timing));
    const owned = timelineSampleAnimations;
    Promise.allSettled(owned.map(animation => animation.finished)).then(() => {
      if (timelineSampleAnimations !== owned) return;
      for (const animation of owned) animation.cancel(); timelineSampleAnimations = [];
      clearTimeout(timelineSampleTimer); timelineSampleTimer = null;
      before.style.opacity = "0"; after.style.opacity = "1";
    });
    timelineSampleTimer = setTimeout(stopTimelineSample, settings.duration + 200);
  } catch { Promise.allSettled(timelineSampleAnimations.map(animation => animation.finished)); stopTimelineSample(); }
}
$("#timelineSettingsToggle").onclick = () => {
  if (!$("#timelineSettings").hidden) return closeTimelineSettings();
  pauseTimeline(); updateTimelineMotion(); $("#timelineSettings").hidden = false; $("#timelineSettings").scrollTop = 0; $("#timelineSettingsToggle").setAttribute("aria-expanded", "true"); fitTimelineSettings();
};
$("#timelineSettingsClose").onclick = () => { closeTimelineSettings(); $("#timelineSettingsToggle").focus(); };
$("#timelinePreview").onclick = previewTimelineTransition;
$("#timelineSpeed").onchange = () => { store.set("timelinePlayback", timelinePlayback()); scheduleTimeline(); };
for (const id of ["#timelineEffect", "#timelineDuration"]) $(id).onchange = () => { store.set("timelinePlayback", timelinePlayback()); previewTimelineTransition(); };
timelineMotion?.addEventListener?.("change", () => { stopTimelineSample(); compareView?.finishTransition?.(); updateTimelineMotion(); });
window.addEventListener("resize", fitTimelineSettings);
for (const event of ["pointerdown", "mousedown", "touchstart", "dblclick", "wheel"]) $("#timelinePlayer").addEventListener(event, e => e.stopPropagation());
$("#timelinePlayer").addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#timelineSettings").hidden) { closeTimelineSettings(); $("#timelineSettingsToggle").focus(); event.stopPropagation(); }
  else if (event.key !== "Escape") event.stopPropagation();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) { pauseTimeline(); stopTimelineSample(); } });
$("#resultView").onchange = () => {
  if (!comparing()) return exitComparison();
  cancelAnnotationDraw(); ++editRequest;
  if (clipView && !clipView.ready) disposeClipView();
  else if (clipView) { clipView.resumeEditing ||= S.editing; finishEdit(); saveDraft(); }
  stopComparison(); compareChosen = [];
  $("#resultJobControls").hidden = true; $("#compareControls").hidden = false; $("#showImg").disabled = true;
  $("#timelineControls").hidden = !timelineMode(); $("#compareKindRow").hidden = timelineMode();
  $("#timelinePlayer").hidden = !timelineMode(); $(".mapwrap").classList.toggle("timeline-open", timelineMode()); updateTimelineMotion();
  $("#compareClear").textContent = timelineMode() ? "Clear selection" : "Clear pair";
  $("#resultHint").textContent = timelineMode() ? "Select several results from one AOI to view its imagery history on the map." : "Select two checkboxes to compare available runs. Model names are shown for each clip.";
  renderResults(); refreshCompareCatalog();
};
$("#compareRefresh").onclick = refreshCompareCatalog;
$("#compareClear").onclick = () => { compareChosen = []; stopComparison(); renderResults(); $("#compareHint").textContent = timelineMode() ? "Select history from one AOI." : "Select two clips in the table."; };
$("#compareKind").onchange = () => { compareChosen = []; stopComparison(); renderResults(); $("#compareHint").textContent = "Select two clips in the table."; };
$("#compareExit").onclick = exitComparison;
async function loadJobs() {
  jobsController?.abort(); const controller = jobsController = new AbortController(), generation = ++jobsGeneration;
  let serverJobs = [];
  if (S.online) { try { serverJobs = await E.requestJSON(api("/api/jobs"), { signal: controller.signal }); } catch {} }
  if (!pageActive || controller.signal.aborted || generation !== jobsGeneration) return;
  const opts = Object.values(BJOBS).reverse().map(j => `<option value="${j.id}">${j.id.replace("browser_", "This browser · ")} · ${j.status}</option>`);
  if (Array.isArray(serverJobs)) serverJobs.forEach(j => opts.push(`<option value="${esc(j.id)}">Server · ${esc(j.id)} · ${esc(j.status)}</option>`));
  $("#jobSel").innerHTML = opts.join("") || "<option value=''>No jobs yet. Run one in Detect.</option>";
  if (S.jobId && [...$("#jobSel").options].some(o => o.value === S.jobId)) $("#jobSel").value = S.jobId;
  if ($("#jobSel").value) return loadResults($("#jobSel").value);
  RES = []; renderResults();
}
$("#jobSel").onchange = () => {
  ++viewEpoch; ++jobsGeneration; jobsController?.abort();
  if (clipView && !clipView.ready) disposeClipView();
  S.jobId = $("#jobSel").value; return loadResults(S.jobId);
};
$("#jobRefresh").onclick = loadJobs;
async function loadResults(id) {
  resultsController?.abort(); const controller = resultsController = new AbortController(), generation = ++resultsGeneration;
  const base = S.api || "";
  try {
    let rows;
    if (BJOBS[id]) rows = BJOBS[id].results.map(r => ({ ...resultMetadata(r), browser: true, job: id, params: BJOBS[id].params, source: r }));
    else { const j = await E.requestJSON(base + "/api/jobs/" + encodeURIComponent(id), { signal: controller.signal }); rows = (j.results || []).map(r => ({ ...resultMetadata(r), job: id, params: j.params || {} })); }
    if (!pageActive || controller.signal.aborted || generation !== resultsGeneration) return;
    RES = rows; renderResults();
    $("#deleteJob").disabled = readOnly || !BJOBS[id] || pendingJob(BJOBS[id]);
  } catch (error) {
    if (pageActive && !controller.signal.aborted && generation === resultsGeneration) { RES = []; renderResults(); $("#resultHint").textContent = "Could not load this job. Refresh to retry. " + error.message; }
  }
}
function renderResults() {
  const tb = $("#resTable tbody");
  const compare = comparing(), rows = compare ? compareRecords : RES;
  const job = BJOBS[$("#jobSel").value || S.jobId], issues = (job?.outcomes || []).filter(outcome => outcome.status !== "completed");
  $("#jobOutcomes").hidden = compare || !issues.length;
  $("#jobOutcomes").innerHTML = issues.length ? `<p class="hint">${job.results.length} usable clip(s) · ${esc(job.status)}. Unavailable and failed dates have no detection count. Incomplete clips cover available tiles only.</p><div class="tablewrap"><table><thead><tr><th>AOI / date</th><th>Outcome</th></tr></thead><tbody>${issues.map(outcome => `<tr><td>${esc(outcome.aoi)}<br><span class="mono">${esc(outcome.date)}</span></td><td>${esc(outcome.status.replace(/_/g, " "))}${outcome.zoom != null ? ` · z${outcome.zoom}` : ""}<br><span class="hint">${esc(outcome.message || (outcome.status === "partial" ? "Missing imagery tiles; counts are incomplete." : ""))}</span></td></tr>`).join("")}</tbody></table></div>` : "";
  $("#compareColumn").hidden = !compare;
  $("#compareCreatedColumn").hidden = !compare;
  const historyAOI = timelineMode() ? chosenHistory()[0]?.geometry : null;
  tb.innerHTML = rows.map((r, i) => `<tr class="${compare ? "" : "click"}" data-i="${i}">${compare ? `<td><input type="checkbox" data-compare-row="${i}" aria-label="Compare ${esc(r.aoi)} ${esc(r.date)} ${esc(r.model)}" ${compareChosen.includes(r.key) ? "checked" : ""} ${!compareChosen.includes(r.key) && (timelineMode() ? historyAOI && r.geometry !== historyAOI : compareChosen.length === 2) ? "disabled" : ""}></td>` : ""}<td>${esc(r.aoi)}</td><td class="mono">${esc(r.date)}</td>${compare ? `<td class="mono">${r.createdAt == null ? "Unknown" : new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 19)}</td>` : ""}<td class="model" title="${esc(r.model || GVCompare.modelName(r.params))}">${esc(r.model || GVCompare.modelName(r.params))}</td><td>${
    (Object.entries(r.counts).map(([k, v]) => `<span class="mono" style="color:${color(k)}">${v}</span> ${esc(k.replace(/_/g, " "))}`).join("<br>") || '<span class="muted">0</span>') + (r.missing ? '<br><span class="hint">Incomplete imagery</span>' : "")}</td></tr>`).join("")
    || `<tr><td colspan="${compare ? 6 : 4}" class="muted">No clips yet.</td></tr>`;
  if (compare) tb.querySelectorAll("[data-compare-row]").forEach(checkbox => { checkbox.onchange = () => {
    if (checkbox.disabled) return;
    const key = compareRecords[+checkbox.dataset.compareRow].key;
    const next = checkbox.checked ? [...compareChosen.filter(value => value !== key), key] : compareChosen.filter(value => value !== key);
    if (timelineMode()) { stopComparison(); compareChosen = next; renderResults(); $("#compareHint").textContent = "Select history from one AOI, then open the timeline."; }
    else { compareChosen = next.slice(-2); renderResults(); showComparison(); }
  }; });
  else tb.querySelectorAll("tr[data-i]").forEach(tr => { const index = +tr.dataset.i, record = rows[index]; tr.onclick = () => { if (RES[index] === record) return openClip(index); }; });
  if (compare) $("#trendSec").hidden = true; else drawTrend();
  updateTimelineControls();
}
function drawTrend() {
  const byAoi = new Map(), trend = $("#trend");
  RES.forEach((row, index) => { if (!byAoi.has(row.aoi)) byAoi.set(row.aoi, []); byAoi.get(row.aoi).push({ row, index }); });
  const multi = [...byAoi.values()].filter(rows => rows.length > 1);
  $("#trendSec").hidden = !multi.length; if (!multi.length) { trend.innerHTML = ""; return; }
  const W = 340, H = 120, P = { l: 28, r: 8, t: 10, b: 22 };
  trend.innerHTML = multi.slice(0, 6).map(arr => {
    arr = arr.slice().sort((a, b) => a.row.date.localeCompare(b.row.date));
    const max = Math.max(1, ...arr.map(a => a.row.total)), n = arr.length, bw = (W - P.l - P.r) / n, ih = H - P.t - P.b;
    const ticks = [...new Set([0, Math.round(max / 2), max])];
    const grid = ticks.map(t => { const y = H - P.b - ih * t / max; return `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${P.l - 5}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--muted)" font-family="var(--f-mono)">${t}</text>`; }).join("");
    const bars = arr.map(({ row, index }, i) => { const h = ih * row.total / max, x = P.l + i * bw + bw * 0.15;
      const details = [`${row.aoi} · ${row.date}`, GVCompare.modelName(row.params), `Total: ${row.total}`,
        ...Object.entries(row.counts).map(([name, count]) => `${count} ${name.replace(/_/g, " ")}`),
        ...(row.missing ? ["Incomplete imagery; counts cover available tiles only."] : [])];
      return `<g class="trend-bar${S.clip === row ? " selected" : ""}" data-trend-i="${index}" role="button" tabindex="0" aria-pressed="${S.clip === row}" aria-label="${esc(details.join("; "))}"><title>${esc(details.join("\n"))}</title><rect class="trend-fill" x="${x.toFixed(1)}" y="${(H - P.b - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="2" fill="var(--accent)"/><rect class="trend-hit" x="${(P.l + i * bw).toFixed(1)}" y="${P.t}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"/></g>`; }).join("");
    const xl = [...new Set([0, n - 1])].map(i => `<text x="${i === 0 ? P.l : W - P.r}" y="${H - 6}" text-anchor="${i === 0 ? "start" : "end"}" font-size="9" fill="var(--muted)" font-family="var(--f-mono)">${arr[i].row.date}</text>`).join("");
    return `<div><div class="hint" style="font-weight:600;color:var(--fg)">${esc(arr[0].row.aoi)}</div><svg class="spark" viewBox="0 0 ${W} ${H}" role="group" aria-label="Objects per date at ${esc(arr[0].row.aoi)}">${grid}${bars}${xl}</svg></div>`;
  }).join("");
  trend.querySelectorAll("[data-trend-i]").forEach(bar => {
    const index = +bar.dataset.trendI, record = RES[index];
    bar.onclick = () => { if (!comparing() && RES[index] === record) return openClip(index); };
    bar.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); return bar.onclick(); } };
  });
}
const clipBounds = r => [[r.bounds[1], r.bounds[0]], [r.bounds[3], r.bounds[2]]];
function makeClipView(clip) {
  viewMetrics.created++;
  return { generation: ++clipGeneration, clip, scope: draftScope(clip), controller: new AbortController(),
    serverBase: S.api || "", annotationServer: isServer(), disposed: false, ready: false, loading: true, image: null, url: null, timer: null, fc: null, resumeEditing: null };
}
function releaseClipImage(view = clipView) {
  if (!view) return;
  if (view.image) {
    // Leaflet's remove event detaches getEvents() listeners from the map.
    // Clearing all listeners before removal would suppress that cleanup.
    clipLayer.removeLayer(view.image); view.image.off();
    const element = view.image.getElement?.();
    if (element) { element.onload = element.onerror = null; element.removeAttribute("src"); }
    view.image = null;
  }
  // Remove the layer before revoking its lease. Revoked URLs are never cached.
  if (view.url) { URL.revokeObjectURL(view.url); viewMetrics.imageURLsRevoked++; view.url = null; }
}
function clearSelection() {
  S.sel = null; S.editing = null;
  $("#selCard").innerHTML = '<span class="hint">Click an object on the map.</span>';
}
function clearDetectionLayers() {
  ++editRequest;
  const layers = detLayer.getLayers();
  layers.forEach(layer => { layer.editing?.disable(); layer.unbindTooltip?.(); });
  detLayer.clearLayers(); layers.forEach(layer => layer.off()); clearSelection();
}
function disposeClipView({ preserveDraft = true } = {}) {
  const view = clipView;
  if (preserveDraft) { finishEdit(); if (S.annFC && view?.ready) { retainDraft(view.scope, S.annFC, view.clip, dirty); saveDraft(); } }
  cancelAnnotationDraw(); ++editRequest;
  if (view && !view.disposed) {
    view.disposed = true; view.controller.abort(); clearTimeout(view.timer); view.timer = null;
    releaseClipImage(view); view.resumeEditing = null;
    const entry = draftCache.get(view.scope), source = view.clip?.source;
    if (!preserveDraft || (durable && !entry?.dirty)) {
      draftCache.delete(view.scope);
      if (source?.draftFC === view.fc) delete source.draftFC;
      if (volatileLiveDraft === view.fc) volatileLiveDraft = null;
    }
    if (durable && source?.persisted) { delete source.fc; delete source.blobs; }
    if (view.clip) { delete view.clip.blobs; delete view.clip.fc; delete view.clip.draftFC; }
    view.fc = null; view.clip = null; viewMetrics.disposed++;
  }
  clearDetectionLayers(); clipView = null; S.clip = S.annFC = null;
  $("#annCtx").innerHTML = '<span class="hint">Open a clip from Results, or annotate on the live Wayback layer.</span>';
  updStats();
}
function renderClipImage() {
  const view = clipView, r = view?.clip;
  if (!view?.ready || !r || !currentView(view) || !$("#showImg").checked) { releaseClipImage(view); return; }
  if (view.image) return;
  const imageBlob = r.blobs?.display || r.blobs?.png;
  if (r.browser && (!imageBlob || imageBlob.gmdArtifact)) return;
  if (r.browser) { view.url = URL.createObjectURL(imageBlob); viewMetrics.imageURLsCreated++; }
  const src = view.url || view.serverBase + `/outputs/${r.job}/${r.path}/image.png`;
  const image = view.image = L.imageOverlay(src, clipBounds(r));
  image.on("error", () => {
    if (!currentView(view) || view.image !== image) return;
    releaseClipImage(view); toast("Clip imagery could not be displayed. Detections are still available; toggle the image to retry.", 5000);
  });
  image.addTo(clipLayer);
}
function validateFeatures(fc) {
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.every(f => f?.type === "Feature" && f.geometry && f.properties))
    throw new Error("This clip has invalid detection data. Select the row to retry.");
  return fc;
}
function commitClipView(view, fc, payload) {
  requireView(view);
  const r = view.clip;
  view.ready = true; view.loading = false; view.fc = fc; clearTimeout(view.timer); view.timer = null;
  if (payload) r.blobs = payload.blobs;
  const entry = retainDraft(view.scope, fc, r);
  if (r?.browser) r.source.draftFC = fc;
  S.annFC = fc; dirty = entry.dirty;
  renderClipImage(); renderDetections(); renderAnnCtx();
}
async function openClip(i, { record = RES[i], fitView = true, selectDate = true } = {}) {
  const r = record; if (!r || !persistenceReady || !pageActive || comparing() || BJOBS[r.job]?.deleting) return;
  stopComparison({ resumeEdit: false, restoreView: false }); disposeClipView();
  const view = clipView = makeClipView(r); S.clip = r;
  $("#annCtx").textContent = `Loading ${r.aoi} · ${r.date}…`;
  $$("#resTable tr").forEach(tr => tr.classList.toggle("sel", tr.dataset.i == i));
  $("#trend").querySelectorAll("[data-trend-i]").forEach(bar => {
    const selected = +bar.dataset.trendI === i;
    bar.classList.toggle("selected", selected); bar.setAttribute("aria-pressed", String(selected));
  });
  if (fitView) map.fitBounds(clipBounds(r));
  const rel = S.releases.find(x => x.release === r.release); if (selectDate && rel) setWayback(rel);
  view.timer = setTimeout(() => { view.timedOut = true; view.controller.abort(); }, 30000);
  try {
    const source = r.browser ? r.source : null, signal = view.controller.signal;
    const payload = source ? await viewRead(view, readClip(source, { images: true })) : null;
    requireView(view);
    // Work on a private candidate until every read is current. In particular a
    // late review read must not mutate a job-owned draft after this view exits.
    const saved = draftCache.get(view.scope)?.fc || payload?.draftFC
      || (!source && durable ? await viewRead(view, DB.draft(view.scope)) : null);
    requireView(view);
    const raw = saved || (source ? payload.fc : await viewRead(view, E.requestJSON(view.serverBase + `/outputs/${r.job}/${r.path}/detections.geojson`, { signal })));
    requireView(view); validateFeatures(raw);
    const fc = JSON.parse(JSON.stringify(raw));
    if (!saved) {
      const ann = await viewRead(view, durable ? DB.reviews(view.scope) : getAnnotations({ signal, base: view.serverBase, server: view.annotationServer }));
      requireView(view); validateFeatures(ann);
      const byId = new Map(ann.features.map(feature => [feature.id, feature]));
      fc.features = fc.features.map(feature => byId.get(feature.id) || feature);
      const have = new Set(fc.features.map(feature => feature.id));
      ann.features.filter(f => f.properties.status === "manual" && f.properties.release === r.release && f.properties.aoi_id === r.aoi_id && !have.has(f.id)).forEach(f => fc.features.push(f));
    }
    requireView(view);
    // Reuse the live draft object only at commit, after checking ownership.
    const entry = draftCache.get(view.scope);
    commitClipView(view, entry?.fc || fc, payload);
    toast(`${S.annFC.features.length} objects · ${r.aoi} · ${r.date}`);
  } catch (error) {
    if (clipView !== view || view.disposed || !pageActive || comparing()) return;
    view.loading = false;
    releaseClipImage(view); clearDetectionLayers(); S.annFC = null;
    if (error.name !== "AbortError" || view.timedOut) {
      const message = view.timedOut ? "Clip loading timed out. Select the row to retry." : error.message;
      $("#annCtx").textContent = message; toast(message, 5000);
    }
  } finally { clearTimeout(view.timer); view.timer = null; }
}
$("#showImg").onchange = renderClipImage;
$("#openLiveDraft").onclick = async () => {
  if (!pageActive) return;
  if (comparing()) exitComparison();
  disposeClipView(); const view = clipView = makeClipView(null);
  view.timer = setTimeout(() => { view.timedOut = true; view.controller.abort(); }, 30000);
  try {
    const fc = draftCache.get("live")?.fc || (durable ? await viewRead(view, DB.draft("live")) : volatileLiveDraft);
    requireView(view);
    if (!fc) { disposeClipView(); return toast("No saved live-map draft yet"); }
    commitClipView(view, validateFeatures(fc)); restoreLiveDate(fc);
    $("#annCtx").textContent = "Live map · recovered draft"; showTab("ann");
  } catch (error) {
    if (clipView === view && !view.disposed && pageActive && !comparing()) { disposeClipView(); toast(view.timedOut ? "Live draft loading timed out. Try again." : error.message, 5000); }
  } finally { clearTimeout(view.timer); view.timer = null; }
};
function restoreLiveDate(fc) {
  const releases = [...new Set(fc.features.map(f => f.properties.release).filter(r => r != null))];
  pendingLiveRelease = releases.length === 1 ? releases[0] : null;
  const release = S.releases.find(r => r.release === pendingLiveRelease);
  if (release) { pendingLiveRelease = null; setWayback(release); }
}

// ---------------------------------------------------------------- annotations
async function getAnnotations({ signal, base = S.api || "", server = isServer() } = {}) {
  const local = durable ? await DB.reviews() : store.get("ann", { type: "FeatureCollection", features: [] });
  if (!server) return local;
  try { const srv = validateFeatures(await E.requestJSON(base + "/api/annotations", { signal })); const exact = new Set(srv.features.map(f => JSON.stringify(f))); return { type: "FeatureCollection", features: srv.features.concat(local.features.filter(f => !exact.has(JSON.stringify(f)))) }; }
  catch (error) { if (signal?.aborted) throw error; return local; }
}
async function upsertLocal(features, clip = S.clip) {
  if (durable) {
    const scope = draftScope(clip);
    const jobId = clip?.job || null, aoiId = clip?.source?.aoiFeature?._gmd_id || null;
    const records = JSON.parse(JSON.stringify(features));
    records.forEach(f => { f.properties = { ...f.properties, gmd_clip_id: scope, gmd_job_id: jobId, gmd_aoi_id: aoiId }; });
    await persistWrite(() => DB.saveReviews(scope, jobId, aoiId, records));
    return DB.reviews();
  }
  const cur = store.get("ann", { type: "FeatureCollection", features: [] }), by = new Map(cur.features.map(f => [f.id, f]));
  features.forEach(f => by.set(f.id, f));
  const out = { type: "FeatureCollection", features: [...by.values()] };
  if (!store.set("ann", out)) { toast("Browser storage is full. Download the training dataset or annotations to keep them.", 5000); throw new Error("Annotations are not saved"); }
  return out;
}
const STYLE = f => { const p = f.properties, c = color(p.class), rej = p.status === "rejected";
  return { color: rej ? "#c23b3b" : c, weight: S.sel && S.sel.feature === f ? 3.5 : 2, dashArray: rej ? "4 4" : null, fillColor: c, fillOpacity: p.status === "predicted" ? 0.08 : rej ? 0 : 0.22 }; };
function renderDetections() {
  if (!clipView && S.annFC) { clipView = makeClipView(S.clip); clipView.ready = true; clipView.loading = false; clipView.fc = S.annFC; retainDraft(clipView.scope, S.annFC, S.clip); }
  const selected = S.sel?.feature;
  finishEdit(); clearDetectionLayers(); if (!S.annFC) return;
  L.geoJSON(S.annFC, { pane: "gmd-detections", bubblingMouseEvents: false, style: STYLE, onEachFeature: (f, l) => {
    l.feature = f; l.on("click", e => { L.DomEvent.stopPropagation(e); if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); select(l); });
  } }).eachLayer(l => detLayer.addLayer(l));
  const replacement = selected && detLayer.getLayers().find(layer => layer.feature === selected); if (replacement) select(replacement);
  updStats();
}
function renderAnnCtx() {
  const c = S.clip; if (!c) return;
  $("#annCtx").innerHTML = `<dl class="kv"><dt>AOI</dt><dd>${esc(c.aoi)}</dd><dt>Imagery</dt><dd>${c.date} · release ${c.release}</dd><dt>Zoom</dt><dd>z${c.zoom}</dd><dt>Objects</dt><dd>${S.annFC.features.length}</dd></dl>`;
}
function finishEdit() {
  ++editRequest;
  if (S.editing) { const editing = S.editing; S.editing = null; syncGeom(editing); editing.editing.disable(); if (clipView) clipView.editStart = null; }
}
function activateEditor(layer) {
  clipView.editStart = JSON.stringify(layer.toGeoJSON(false).geometry);
  S.editing = layer; layer.editing.enable();
}
function canAnnotate() { return Boolean(clipView?.ready && currentView(clipView) && S.annFC && !readOnly && persistenceReady && !BJOBS[S.clip?.job]?.deleting); }
function selectionNumber(value, digits) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return "—";
  const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : "—";
}
function select(l) {
  if (!clipView?.ready || !currentView(clipView) || !detLayer.getLayers().includes(l)) return;
  finishEdit();
  S.sel = l; detLayer.eachLayer(x => x.setStyle && x.setStyle(STYLE(x.feature)));
  const p = l.feature.properties;
  const className = String(p.class || "unknown"), status = ["predicted", "verified", "corrected", "manual", "rejected"].includes(p.status) ? p.status : "predicted";
  const centre = Array.isArray(p.centroid) && p.centroid.length >= 2 ? [selectionNumber(p.centroid[1], 5), selectionNumber(p.centroid[0], 5)] : [];
  const centreText = centre.length === 2 && !centre.includes("—") ? centre.join(", ") : "—";
  const classes = S.classes.includes(className) ? S.classes : [className, ...S.classes];
  $("#selCard").innerHTML = `
    <div class="row"><span style="width:12px;height:12px;border-radius:3px;background:${color(className)}"></span><b style="flex:1">${esc(className.replace(/_/g, " "))}</b><span class="pill ${status}">${status}</span></div>
    <dl class="kv"><dt>Confidence</dt><dd>${selectionNumber(p.confidence, 2)}</dd><dt>Size</dt><dd>${p.length_m != null ? `${esc(p.length_m)} × ${esc(p.width_m ?? "—")} m` : "—"}</dd>
    <dt>Heading</dt><dd>${p.heading_deg != null ? esc(p.heading_deg) + "°" : "—"}</dd><dt>Centre</dt><dd>${centreText}</dd></dl>
    <select id="selClass">${classes.map(c => `<option ${c === className ? "selected" : ""} value="${esc(c)}">${esc(c.replace(/_/g, " "))}</option>`).join("")}</select>
    <div class="row"><button class="btn" id="bAcc" style="color:var(--ok)">Accept</button><button class="btn" id="bRej" style="color:var(--bad)">Reject</button><button class="btn ghost" id="bEdit">Edit shape</button><button class="btn ghost danger" id="bDel">Delete</button></div>`;
  $("#selClass").onchange = e => setStatus(e.target.value !== p.class ? "corrected" : p.status, e.target.value);
  $("#bAcc").onclick = () => setStatus("verified"); $("#bRej").onclick = () => setStatus("rejected");
  $("#bEdit").onclick = editShape; $("#bDel").onclick = delSel;
  for (const id of ["selClass", "bAcc", "bRej", "bEdit", "bDel"]) $("#" + id).disabled = readOnly;
  if (!$("#tab-ann").classList.contains("on")) showTab("ann");
}
function setStatus(st, cls) {
  if (!S.sel || !canAnnotate() || !detLayer.getLayers().includes(S.sel)) return; const p = S.sel.feature.properties;
  if (cls) { p.original_class = p.original_class || p.class; p.class = cls; }
  p.status = st; p.reviewed_at = new Date().toISOString(); S.sel.setStyle(STYLE(S.sel.feature)); select(S.sel); updStats(); dirty = true; saveDraft();
}
async function editShape() {
  const selected = S.sel, owner = clipView, request = ++editRequest;
  if (!selected || !canAnnotate()) return;
  try {
    await E.ensureLibrary("draw");
    if (request !== editRequest || owner !== clipView || !canAnnotate() || S.sel !== selected || !detLayer.getLayers().includes(selected)) return;
    // Leaflet.Draw init hooks do not run retroactively for pre-existing polygons.
    if (!selected.editing) selected.editing = new L.Edit.Poly(selected);
    activateEditor(selected); toast("Drag the corners, then press Enter or click the map");
  } catch (error) { if (request === editRequest && owner === clipView && currentView(owner)) toast(error.message, 5000); }
}
function syncGeom(l) {
  if (readOnly) return;
  const geometry = l.toGeoJSON(false).geometry;
  if (JSON.stringify(geometry) === clipView?.editStart) return;
  l.feature.geometry = geometry;
  if (l.feature.properties.status === "predicted") l.feature.properties.status = "corrected";
  dirty = true; saveDraft();
}
function delSel() { if (!S.sel || !canAnnotate()) return; finishEdit(); const layer = S.sel; S.annFC.features = S.annFC.features.filter(f => f !== layer.feature); layer.editing?.disable(); detLayer.removeLayer(layer); layer.off(); clearSelection(); updStats(); dirty = true; saveDraft(); }
function nextPending() {
  const ls = detLayer.getLayers().filter(l => l.feature.properties.status === "predicted").sort((a, b) => (b.feature.properties.confidence || 0) - (a.feature.properties.confidence || 0));
  if (!ls.length) return toast("Everything in this clip is reviewed");
  select(ls[0]); map.panTo(ls[0].getBounds().getCenter());
}
function addManualObject(geom) {
  if (readOnly || !persistenceReady || !pageActive || comparing() || (clipView && !canAnnotate())) return;
  if (!S.annFC) S.annFC = { type: "FeatureCollection", features: [] };
  const ctx = S.clip ? { release: S.clip.release, imagery_date: S.clip.date, zoom: S.clip.zoom, aoi_id: S.clip.aoi_id, aoi_name: S.clip.aoi }
    : { release: S.viewRel ? S.viewRel.release : null, imagery_date: S.viewRel ? S.viewRel.date : null, zoom: Math.min(19, map.getZoom()), aoi_id: "live", aoi_name: "Live map" };
  const ring = geom.coordinates[0], c = [ring.slice(0, -1).reduce((s, p) => s + p[0], 0) / (ring.length - 1), ring.slice(0, -1).reduce((s, p) => s + p[1], 0) / (ring.length - 1)];
  const f = { type: "Feature", id: "manual_" + (window.GVStorage?.uuid() || Date.now().toString(36) + "_" + Math.random().toString(36).slice(2)), geometry: geom,
    properties: { ...ctx, class: $("#drawClass").value, status: "manual", source: "Esri Wayback", centroid: c, reviewed_at: new Date().toISOString() } };
  S.annFC.features.push(f); renderDetections(); dirty = true; saveDraft();
  const l = detLayer.getLayers().find(x => x.feature === f); if (l) select(l);
}
let dirty = false;
function updStats() { const fs = S.annFC ? S.annFC.features : []; $("#annStats").textContent = `${fs.filter(f => f.properties.status !== "predicted").length}/${fs.length} reviewed`; }
$("#annRect").onclick = () => startDraw("rect", "ann");
$("#annPoly").onclick = () => startDraw("poly", "ann");
$("#addClass").onclick = () => { const v = $("#newClass").value.trim().toLowerCase().replace(/\s+/g, "_"); if (!v) return; mergeClasses([v]); S.wantClasses.add(v); store.set("want", [...S.wantClasses]); renderClasses(); $("#drawClass").value = v; $("#newClass").value = ""; };
$("#acceptAll").onclick = () => { if (!canAnnotate()) return; let n = 0; S.annFC.features.forEach(f => { if (f.properties.status === "predicted" && f.properties.confidence >= 0.6) { f.properties.status = "verified"; n++; } }); renderDetections(); dirty = true; saveDraft(); toast(`${n} accepted`); };
$("#saveAnn").onclick = async () => {
  if (!canAnnotate()) return toast("Open a clip or live draft to review first");
  finishEdit();
  const owner = clipView, original = S.annFC, clip = S.clip, base = S.api || "", server = isServer();
  const snapshot = JSON.stringify(original), reviewed = JSON.parse(snapshot).features.filter(f => f.properties.status !== "predicted");
  let out;
  try {
    if (!reviewed.length && (!durable || !(await DB.reviews(draftScope(clip))).features.length)) {
      if (owner === clipView && currentView(owner)) toast("Review at least one object first"); return;
    }
    if (owner === clipView) saveDraft(); out = await upsertLocal(reviewed, clip);
  }
  catch { return; }
  if (server) { try { const response = await fetch(base + "/api/annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "FeatureCollection", features: reviewed }) }); if (!response.ok) throw new Error("Server annotation save failed"); } catch { if (owner === clipView) toast("Saved in this browser; the server did not respond"); } }
  if (owner === clipView && currentView(owner)) { if (S.annFC === original && JSON.stringify(original) === snapshot) dirty = false; toast(`Saved · training set has ${out.features.length} objects`); }
};
map.on("click", finishEdit);
document.addEventListener("keydown", e => {
  if (comparing()) { if (e.key === "Escape") exitComparison(); return; }
  if (!$("#runAoiPanel").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeRunAoiPanel(); }
    return;
  }
  if (e.target.matches("input,select,textarea,button")) return;
  const k = e.key.toLowerCase();
  if (k === "a") setStatus("verified"); else if (k === "r") setStatus("rejected"); else if (k === "n") nextPending();
  else if (k === "e") editShape(); else if (k === "delete" || k === "backspace") delSel();
  else if (k === "enter" && S.editing) { finishEdit(); toast("Shape updated"); }
});
window.addEventListener("beforeunload", e => {
  // Snapshot a vertex drag before deciding whether leaving can lose work.
  // The actual database write remains separately owned and may still be pending.
  finishEdit();
  const unsaved = Object.values(BJOBS).some(job => durable ? job.durableReady === false || job.results.some(r => r.persisted === false) : job.results.length && !job.exported);
  if (dirty || unsavedAois || [...draftCache.values()].some(entry => entry.dirty) || pendingWrites.length || unsaved) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------- train
async function loadAnnStats() {
  const fc = await getAnnotations(), c = {};
  fc.features.forEach(f => { const k = f.properties.class, r = f.properties.status === "rejected"; c[k] = c[k] || [0, 0]; c[k][r ? 1 : 0]++; });
  $("#annTable tbody").innerHTML = Object.entries(c).sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color(k)};margin-right:6px"></span>${esc(k.replace(/_/g, " "))}</td><td class="mono">${v[0]}</td><td class="mono">${v[1]}</td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">No saved annotations. Review objects in Annotate and press Save.</td></tr>`;
}
$("#annReload").onclick = loadAnnStats;
async function runDataset(toFile = false) {
  if (datasetExportRunning || activeBrowserJob) return toast("Wait for the current browser processing operation to finish before exporting a dataset.");
  datasetExportRunning = true; renderBrowserQueue();
  const task = datasetOperation = auxiliaryTask(), signal = task.controller.signal; let destination;
  const btn = $("#dsBtn"); btn.disabled = true; btn.textContent = "Building dataset…";
  $("#cancelDataset").hidden = false;
  try {
    const name = `geovision_dataset_${new Date().toISOString().slice(0, 10)}.zip`;
    destination = toFile ? await chooseOutput(name, signal) : undefined;
    const limits = readBrowserLimits(), annotations = await getAnnotations({ signal }); E.operations.check(signal);
    const { blob, chips, classes } = await E.exportDataset(annotations, { name, destination, limits, signal, streaming: true, store: durable ? DB : null,
      onProgress: f => { if (!signal.aborted) $("#dsProg").style.width = (f * 100).toFixed(0) + "%"; } });
    E.operations.check(signal);
    store.set("dsClasses", classes);
    await presentOutput(blob, name, signal);
    toast(`${chips} chips · ${classes.length} classes`);
  } catch (e) { if (pageActive) toast(e.name === "AbortError" ? "Dataset export cancelled. Saved reviews are kept." : e.message, 5000); }
  finally {
    await destination?.abort(); datasetOperation = null; task.finish(); $("#cancelDataset").hidden = true;
    datasetExportRunning = false; btn.disabled = false; btn.textContent = "Download training dataset";
    renderBrowserQueue(); drainBrowserQueue();
  }
}
$("#dsBtn").onclick = () => runDataset();
$("#dsSave").onclick = () => runDataset(true);
$("#dsSave").hidden = typeof window.showSaveFilePicker !== "function";
$("#cancelDataset").onclick = () => datasetOperation?.controller.abort();
$("#trainBtn").onclick = async () => {
  if (!isServer()) return toast("Connect a server in Export → Processing");
  await stopPoll(trainingPoll); const owner = E.operations.open("Server training status", { timeoutMs: 12 * 3600000 }); trainingPoll = owner;
  const body = { base_model: $("#baseModel").value, epochs: +$("#epochs").value, batch: +$("#batch").value, name: $("#mName").value.trim(), zoom: +$("#zoom").value };
  try {
    owner.pending = postJSON("/api/train", body, owner.signal); const { train_id } = await owner.pending, base = S.api; owner.check();
    $("#trainBtn").disabled = true; let failures = 0;
    const poll = async () => {
      try {
        const j = await E.requestJSON(base + "/api/train/" + encodeURIComponent(train_id), { signal: owner.signal });
        owner.check(); if (!pageActive || trainingPoll !== owner) return; failures = 0; $("#trainLog").textContent = j.log.join("\n");
        if (j.status === "running" || j.status === "queued") owner.timer = setTimeout(() => { owner.pending = poll(); }, 3000);
        else { trainingPoll = null; owner.close(); $("#trainBtn").disabled = false; loadModels(); toast(j.status === "done" ? "Training finished" : "Training failed"); }
      } catch (error) {
        if (owner.signal.aborted) { if (trainingPoll === owner) { trainingPoll = null; owner.close(); $("#trainBtn").disabled = false; if (owner.timedOut && pageActive) toast("Training status polling timed out; server training may continue."); } return; }
        if (!pageActive || trainingPoll !== owner) return;
        if (++failures >= 5) { trainingPoll = null; owner.close(); $("#trainBtn").disabled = false; toast("Training status is unavailable. Server training may still continue.", 5000); }
        else owner.timer = setTimeout(() => { owner.pending = poll(); }, 3000);
      }
    };
    owner.pending = poll();
  } catch (error) { owner.close(); if (trainingPoll === owner) { trainingPoll = null; $("#trainBtn").disabled = false; if (pageActive) toast(error.message); } }
};

// ---------------------------------------------------------------- export
function auxiliaryTask() {
  const controller = new AbortController(); let finish;
  const finished = new Promise(resolve => { finish = resolve; }); return { controller, finished, finish };
}
async function chooseOutput(name, signal) {
  const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }] });
  E.operations.check(signal); const destination = await handle.createWritable(); let closed = false;
  const owned = { write: data => destination.write(data), close: async () => { await destination.close(); closed = true; },
    abort: async () => { if (closed) return; closed = true; try { await destination.abort(); } catch {} } };
  if (signal.aborted) { await owned.abort(); E.operations.check(signal); } return owned;
}
async function clearExportParts() {
  const previous = exportParts; exportParts = null; $("#exportParts").hidden = true; $("#exportPartList").innerHTML = "";
  if (!previous) return;
  previous.controller.abort(); await Promise.allSettled([...previous.reads]);
  await window.GVStreaming?.discardArtifact(previous.spool, DB);
}
let partDownloads = 0;
async function presentOutput(output, name, signal) {
  E.operations.check(signal);
  if (output?.saved) return toast("File saved");
  if (!output?.parts) return saveBlob(name, output);
  await clearExportParts();
  E.operations.check(signal);
  const bundle = exportParts = { ...output, controller: new AbortController(), reads: new Set() };
  $("#exportParts").hidden = false;
  $("#exportPartsHint").textContent = `${output.parts.length} parts for ${output.name}. Download all parts, the manifest and combine script to one folder; run python3 combine.py. Extract the combined ZIP normally. Temporary parts stay on this device until dismissed or this page closes.`;
  $("#exportPartList").innerHTML = output.parts.map((part, i) => `<button class="btn wide" data-export-part="${i}">${esc(part.name)} · ${(part.size / 1048576).toFixed(1)} MiB</button>`).join("");
  $("#exportPartList").querySelectorAll("[data-export-part]").forEach(button => button.onclick = async () => {
    if (exportParts !== bundle || partDownloads >= 2) return toast("Wait for the current part downloads to finish, then retry.");
    partDownloads++; button.disabled = true; let lease, handed = false, held = true;
    const release = () => { if (held) { held = false; lease?.release(); partDownloads--; } };
    const running = (async () => {
      try {
        const part = bundle.parts[+button.dataset.exportPart];
        lease = await E.exportPart(part, { store: DB, limits: readBrowserLimits(), signal: bundle.controller.signal, retainLease: true });
        E.operations.check(bundle.controller.signal); if (exportParts !== bundle) return;
        saveBlob(part.name, lease.blob, release); handed = true;
      } catch (error) { if (error.name !== "AbortError") toast(error.message, 5000); }
      finally { if (!handed) release(); button.disabled = false; }
    })();
    bundle.reads.add(running); try { await running; } finally { bundle.reads.delete(running); }
  });
  toast("Download parts, manifest and combine script in Export", 6000);
}
$("#exportDismiss").onclick = () => clearExportParts().catch(error => toast(error.message));
$("#exportManifest").onclick = () => {
  if (!exportParts) return;
  download(exportParts.name + ".parts.json", JSON.stringify({ name: exportParts.name, size: exportParts.bytes,
    parts: exportParts.parts.map(({ name, size, crc32 }) => ({ name, size, crc32 })) }, null, 2), "application/json");
};
const combineScript = `# Download this script, the .parts.json manifest and every numbered part into one folder.
import json, pathlib, sys, zipfile, zlib
folder = pathlib.Path(__file__).resolve().parent
manifests = list(folder.glob('*.parts.json'))
manifest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else manifests[0] if len(manifests) == 1 else None
if manifest is None: raise SystemExit('Usage: python3 combine.py job.zip.parts.json')
meta = json.loads(manifest.read_text())
def local(name):
    if pathlib.Path(name).name != name: raise ValueError('Manifest contains a non-local filename')
    return manifest.parent / name
target = local(meta['name'])
if target.exists(): raise SystemExit('Output already exists: ' + str(target))
partial = target.with_name(target.name + '.partial')
created = False
try:
    total = 0
    with partial.open('xb') as output:
        created = True
        for part in meta['parts']:
            source = local(part['name'])
            if source.stat().st_size != part['size']: raise ValueError('Wrong part size: ' + source.name)
            crc = 0
            with source.open('rb') as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk: break
                    output.write(chunk); total += len(chunk); crc = zlib.crc32(chunk, crc)
            if crc != part['crc32']: raise ValueError('Wrong part checksum: ' + source.name)
    if total != meta['size']: raise ValueError('Combined byte count does not match')
    if target.suffix.lower() == '.zip':
        with zipfile.ZipFile(partial) as archive:
            if archive.testzip() is not None: raise ValueError('ZIP checksum failed')
    if target.exists(): raise FileExistsError('Output appeared while combining; preserved both files')
    partial.rename(target)
except BaseException:
    if created: partial.unlink(missing_ok=True)
    raise
print('Created', target)
`;
$("#exportCombine").onclick = () => download("combine.py", combineScript, "text/x-python");
async function runJobExport({ toFile = false, clipOnly = false } = {}) {
  const id = $("#jobSel").value || S.jobId;
  if (!id) return toast("Run a job first");
  if (BJOBS[id]) {
    if (exportOperation) return toast("Wait for the current export or cancel it first");
    const clipId = clipOnly ? S.clip?.storeId : undefined;
    if (clipOnly && (!clipId || S.clip.job !== id)) return toast("Open a completed clip from this job first");
    const task = exportOperation = auxiliaryTask(), signal = task.controller.signal; let destination;
    const btn = $("#expZip"); btn.disabled = true;
    $("#cancelExport").hidden = false;
    BJOBS[id].exporting = true;
    try {
      const name = `geovision_${id}${clipOnly ? "_clip" : ""}.zip`; destination = toFile ? await chooseOutput(name, signal) : undefined;
      E.operations.check(signal);
      finishEdit(); saveDraft();
      const output = await E.exportJobZip(BJOBS[id], { name, destination, clipId, signal, streaming: true, store: durable ? DB : null,
        limits: readBrowserLimits(), readResult: r => readClip(r, { images: true }), onProgress: m => { if (!signal.aborted) btn.textContent = `Zipping… ${m.percent.toFixed(0)}%`; } });
      E.operations.check(signal); await presentOutput(output, name, signal);
      if (BJOBS[id] && !clipOnly && !output?.parts) BJOBS[id].exported = true;
    } catch (e) { if (pageActive) toast(e.name === "AbortError" ? "Export cancelled. Completed results are kept." : e.message, 5000); }
    finally {
      await destination?.abort();
      if (BJOBS[id]) BJOBS[id].exporting = false; exportOperation = null; task.finish();
      btn.disabled = false; btn.textContent = "Download job zip"; $("#cancelExport").hidden = true;
    }
  } else if (S.online) window.location.href = api(`/api/jobs/${id}/export`);
}
$("#expZip").onclick = () => runJobExport();
$("#expSave").onclick = () => runJobExport({ toFile: true });
$("#expClip").onclick = () => runJobExport({ clipOnly: true });
$("#cancelExport").onclick = () => exportOperation?.controller.abort();
$("#expSave").hidden = typeof window.showSaveFilePicker !== "function";
$("#expAoi").onclick = () => download("aois.geojson", JSON.stringify({ type: "FeatureCollection", features: S.aois }, null, 1));
$("#expDet").onclick = async () => {
  if (S.annFC) return download(`detections_${S.clip ? S.clip.aoi_id + "_" + S.clip.date : "live"}.geojson`, JSON.stringify(S.annFC));
  const a = await getAnnotations(); if (!a.features.length) return toast("Open a clip or save annotations first");
  download("annotations.geojson", JSON.stringify(a));
};
$("#expCsv").onclick = async () => {
  if (exportOperation) return toast("Wait for the current export or cancel it first");
  const id = $("#jobSel").value || S.jobId, job = BJOBS[id] || (S.annFC ? { results: [{ fc: S.annFC }] } : null);
  if (!job) return toast("Run a job or open a clip first");
  const task = exportOperation = auxiliaryTask(), signal = task.controller.signal; $("#cancelExport").hidden = false;
  if (BJOBS[id]) BJOBS[id].exporting = true;
  try {
    const output = await E.exportCSV(job, { name: "detections.csv", signal, store: durable ? DB : null, limits: readBrowserLimits(),
      readResult: BJOBS[id] ? r => readClip(r, { images: false, draft: false }) : undefined });
    E.operations.check(signal); await presentOutput(output, "detections.csv", signal);
  } catch (error) { if (pageActive) toast(error.name === "AbortError" ? "Export cancelled" : error.message, 5000); }
  finally { if (BJOBS[id]) BJOBS[id].exporting = false; exportOperation = null; task.finish(); $("#cancelExport").hidden = true; }
};

// ---------------------------------------------------------------- boot
renderAois(); renderClasses(); updModeHint();
showTab(store.get("tab", "aoi"));
E.markStartup("appReady");
loadReleases();
async function restoreStorage() {
  restoring = true;
  try {
    const state = await DB?.open();
    if (!state?.available) { durable = false; return; }
    durable = true; readOnly = !state.writable;
    if (!readOnly && !await DB.migrated()) {
      // Parse without the preference helper's default: corrupt user data must
      // not be silently imported as an empty, successfully migrated workspace.
      const legacyAois = localStorage.getItem("gv_aois"), legacyAnn = localStorage.getItem("gv_ann");
      await DB.migrate({ aois: E.uniqueAois(legacyAois == null ? [] : JSON.parse(legacyAois)),
        annotations: legacyAnn == null ? { type: "FeatureCollection", features: [] } : JSON.parse(legacyAnn) });
    }
    const saved = await DB.restore({ recover: true });
    S.aois = saved.aois; S.activeAoi = null; runAoiSelection.clear(); S.aois.forEach(aoi => runAoiSelection.add(aoi));
    browserQueue.length = 0;
    for (const job of saved.jobs) {
      BJOBS[job.id] = job;
      job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
    }
    if (S.clip?.browser) {
      const source = BJOBS[S.clip.job]?.results.find(r => r.storeId === S.clip.storeId);
      if (source) { S.clip.source = source; source.draftFC = S.annFC; renderClipImage(); }
      else disposeClipView({ preserveDraft: false });
    }
    for (const id of saved.queue) if (BJOBS[id] && pendingJob(BJOBS[id])) browserQueue.push(BJOBS[id]);
    queuePaused = browserQueue.length > 0;
    S.customModels = saved.models.filter(model => model.custom);
    const live = await DB.draft("live");
    if (live && !S.clip && !suspendedClip?.clip) { S.annFC = live; restoreLiveDate(live); renderDetections(); $("#annCtx").textContent = "Live map · recovered draft"; }
    renderAois(); renderBrowserQueue(); loadJobs();
  } catch (error) {
    // Failed upgrades/imports never delete the database or its legacy backup.
    // Keep the visible legacy AOIs exportable, and prevent destructive writes.
    if (DB?.state().available) durable = true;
    if (!durable && error.name !== "VersionError" && error.name !== "BlockedError") { storageError = null; readOnly = false; }
    else { storageError = error; readOnly = true; queuePaused = true; }
    toast("Device storage needs attention: " + error.message, 6500);
  } finally {
    restoring = false; persistenceReady = true; renderStorage(); updateRunSelection();
  }
}
const storageReady = restoreStorage();
(async () => { await checkApi(); await storageReady; await loadModels(); updEngineUI(); })();
$("#deleteJob").onclick = async () => {
  const id = $("#jobSel").value || S.jobId, job = BJOBS[id];
  if (!job || readOnly || pendingJob(job) || job.exporting) return toast("Cancel or finish this job and its export first");
  if (!window.confirm("Delete this job, its images and editing drafts from this device? Saved training reviews are kept.")) return;
  if (clipView?.clip?.job === id) { finishEdit(); saveDraft(); if (!clipView.ready) disposeClipView({ preserveDraft: false }); }
  job.deleting = true;
  try {
    if (durable && storageError && !writing) {
      // Deleting an old job must remain usable when writes are blocked by
      // quota. Remove only this explicitly discarded job's pending records.
      await DB.deleteJob(id);
      for (let i = pendingWrites.length - 1; i >= 0; i--) if (pendingWrites[i].owner === id) {
        pendingWrites[i].resolve(); pendingWrites.splice(i, 1);
      }
      storageError = null; await flushWrites();
    } else await persistWrite(() => DB.deleteJob(id), id);
    if (!durable && window.GVStreaming) {
      const spools = new Set(job.results.flatMap(r => Object.values(r.blobs || {}).filter(value => value?.gmdArtifact).map(value => value.spool)));
      for (const spool of spools) await window.GVStreaming.discardArtifact(spool);
    }
    if (clipView?.clip?.job === id) { disposeClipView({ preserveDraft: false }); dirty = false; }
    for (const [key, entry] of draftCache) if (entry.job === id) draftCache.delete(key);
    if (comparing()) exitComparison();
    ++jobsGeneration; ++resultsGeneration; jobsController?.abort(); resultsController?.abort();
    delete BJOBS[id]; S.jobId = null; if (selectedBrowserJobId === id) selectedBrowserJobId = null;
    renderBrowserQueue(); await loadJobs(); toast("Job deleted. Saved training reviews are kept.");
  } catch (error) { toast("Could not delete this job: " + error.message, 5000); }
  finally { job.deleting = false; renderStorage(); drainBrowserQueue(); }
};
window.addEventListener("pagehide", () => {
  pageActive = false; ++drawRequest; drawTool?.disable(); invalidateLocalChanges(true); E.cancelReleaseRefresh();
  closePlaceSearch({ removeMarker: true });
  for (const record of [...downloadURLs.values()]) record.release();
  datasetOperation?.controller.abort(); exportOperation?.controller.abort();
  const auxiliary = Promise.allSettled([datasetOperation?.finished, exportOperation?.finished, timelineWork, clearExportParts(), stopPoll(serverPoll), stopPoll(trainingPoll)]);
  serverPoll = trainingPoll = null; setServerRunning(false); $("#trainBtn").disabled = false;
  const previous = clipView?.ready ? { clip: S.clip, scope: clipView.scope } : null;
  if (comparing()) exitComparison(); compareView?.destroy(); compareView = null;
  disposeClipView(); suspendedClip = previous;
  ++jobsGeneration; ++resultsGeneration; jobsController?.abort(); resultsController?.abort();
  if (durable) {
    queuePaused = true;
    if (activeBrowserJob) { activeBrowserJob.suspending = true; activeBrowserJob.controller?.abort(); }
    // A hard close can skip this promise entirely. Committed running/queued
    // records already suffice for recovery; no final unload write is required.
    const runtime = activeBrowserJob?.runtimeFinished;
    storageShutdown = storageShutdown.then(async () => {
      await runtime; await auxiliary;
      await flushWrites(); await DB.close();
    });
  } else {
    for (const job of [...browserQueue]) cancelBrowserJob(job.id, "Page closed or suspended");
    if (activeBrowserJob) cancelBrowserJob(activeBrowserJob.id, "Page closed or suspended");
    storageShutdown = storageShutdown.then(() => auxiliary);
  }
});
window.addEventListener("pageshow", async event => {
  if (!event.persisted) return;
  pageActive = true; loadReleases();
  if (S.online && S.jobId && !BJOBS[S.jobId]) { setServerRunning(true); pollJob(S.jobId, S.api); }
  if (durable) {
    persistenceReady = false; renderStorage(); updateRunSelection();
    await storageShutdown;
    if (pendingWrites.length) {
      const state = await DB.open(); readOnly = !state.writable; persistenceReady = true; renderBrowserQueue();
    } else { await restoreStorage(); await loadModels(); }
  } else drainBrowserQueue();
  if (suspendedClip && pageActive) {
    const previous = suspendedClip; suspendedClip = null;
    if (previous.clip) {
      const old = previous.clip, job = BJOBS[old.job];
      const source = old.browser ? job?.results.find(r => r.storeId === old.storeId) : null;
      const record = old.browser && source ? { ...resultMetadata(source), job: old.job, browser: true, params: job.params, source } : !old.browser ? old : null;
      if (record && !clipView) await openClip(-1, { record, fitView: false, selectDate: false });
    } else if (!clipView) await $("#openLiveDraft").onclick();
  }
});
window.GVApp = { diagnostics: () => ({ views: { ...viewMetrics, active: clipView && !clipView.disposed ? 1 : 0,
  loading: Boolean(clipView?.loading), imageLeases: clipView?.url ? 1 : 0, imageLayers: clipView?.image ? 1 : 0,
  selected: Boolean(S.sel), editing: Boolean(S.editing), scope: clipView?.scope || null },
  drafts: { retained: draftCache.size, dirty: [...draftCache.values()].filter(entry => entry.dirty).length },
  rowPayloads: RES.filter(row => row.blobs || row.fc || row.draftFC).length,
  comparisonRowPayloads: compareRecords.filter(row => row.blobs || row.fc || row.draftFC).length,
  timeline: { frames: timelineFrames.length, index: timelineIndex, playing: timelinePlaying, loading: timelineLoading,
    timer: timelineTimer != null, seek: timelineSeekTimer != null },
  timelineEffects: { ...timelinePlayback(), transitioning: Boolean(compareView?.transition), sampleAnimations: timelineSampleAnimations.length, sampleTimer: timelineSampleTimer != null },
  auxiliary: { dataset: Boolean(datasetOperation), export: Boolean(exportOperation), parts: exportParts?.parts.length || 0,
    partReads: exportParts?.reads.size || 0, partDownloads, serverPoll: Boolean(serverPoll), trainingPoll: Boolean(trainingPoll) },
  mapSearch: { open: !placePopup.hidden, request: Boolean(placeOwner), scheduled: placeTimer != null, marker: Boolean(placeMarker) },
  queue: browserQueueState(),
  downloadLeases: downloadURLs.size }) };
})();
