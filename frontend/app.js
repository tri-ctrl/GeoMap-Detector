/* GeoVision Annotator — portal UI. Runs fully in the browser (GVEngine) or against the optional Python server. */
(() => {
"use strict";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const E = window.GVEngine;
const store = { get(k, d) { try { const v = localStorage.getItem("gv_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem("gv_" + k, JSON.stringify(v)); return true; } catch { return false; } } };

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
let activeBrowserJob = null, selectedBrowserJobId = null, serverRunning = false, queueDraining = false;
let browserJobSequence = 0, modelSourceSequence = 0, viewEpoch = 0;
let localHits = new Set(), localLookup = null, pageActive = true;
let pendingLiveRelease = null;
let volatileLiveDraft = null;
let persistenceReady = false, durable = false, readOnly = false, queuePaused = false, storageError = null;
let writing = false, restoring = false;
let writingDone = Promise.resolve();
let storageShutdown = Promise.resolve();
const pendingWrites = [];
const DB = window.GVStorage?.create({ onState: state => {
  if (["ownership-lost", "version-change", "connection-closed"].includes(state.reason)) {
    finishEdit();
    readOnly = true; queuePaused = true; storageError = new Error("Storage ownership changed. Reload this tab to recover.");
    if (activeBrowserJob) { activeBrowserJob.suspending = true; activeBrowserJob.controller?.abort(); }
    renderStorage(); updateRunSelection();
  }
} });
function renderStorage() {
  $("#storageStatus").textContent = !persistenceReady ? "Opening device storage…" : storageError ? "Not saved · " + storageError.message
    : readOnly ? "Read only · close the other tab and reload to edit." : !durable ? "Session only · storage unavailable. Export before closing."
    : pendingWrites.length ? "Saving on this device…" : "Saved on this device · IndexedDB";
  $("#storageRetry").hidden = !storageError || readOnly;
  $("#resumeQueue").hidden = !queuePaused || readOnly || !browserQueue.length;
  $("#resumeQueue").disabled = Boolean(storageError);
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
  } finally { writing = false; finished(); }
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
  const scope = S.clip ? (S.clip.storeId || "server:" + S.clip.job + ":" + S.clip.path) : "live";
  const fc = JSON.parse(JSON.stringify(S.annFC)), jobId = S.clip?.job || null, original = S.annFC, source = S.clip?.source;
  persistWrite(async () => {
    await DB.saveDraft(scope, jobId, fc);
    if (source && S.clip?.source !== source) delete source.draftFC;
    if (S.annFC === original && JSON.stringify(original) === JSON.stringify(fc)) dirty = false;
  }, jobId || "live").catch(() => {});
}
async function readClip(source, options) {
  const images = options?.images !== false;
  if (source.fc && (!images || source.blobs?.png)) return source;
  const payload = await DB.clip(source.storeId, options);
  if (source.draftFC && options?.draft !== false) payload.draftFC = source.draftFC;
  return payload;
}
$("#storageRetry").onclick = async () => { storageError = null; await flushWrites(); renderStorage(); };
$("#resumeQueue").onclick = () => { if (storageError || readOnly) return; queuePaused = false; renderStorage(); drainBrowserQueue(); };
const isServer = () => S.engine === "server" && S.online;
const api = p => (S.api || "") + p;
const toast = (m, ms = 2600) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), ms); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const saveBlob = (name, blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); };
const download = (name, text, type = "application/geo+json") => saveBlob(name, new Blob([text], { type }));
const postJSON = async (p, body) => { const r = await fetch(api(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); };

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
$("#apiSave").onclick = async () => { S.api = $("#apiUrl").value.trim().replace(/\/$/, ""); store.set("api", S.api); await checkApi(); if (S.online) { S.engine = "server"; store.set("engine", "server"); } await loadModels(); updEngineUI(); };

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
  if (aoiLayer.getLayers().length) map.fitBounds(aoiLayer.getBounds().pad(0.1));
  toast(`${added} AOI${added === 1 ? "" : "s"} added${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}`);
}
function saveAois() {
  if (!durable) { if (!store.set("aois", S.aois)) { dirty = true; toast("AOIs could not be saved. Export them before closing.", 5000); } return; }
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
      <div class="row" style="gap:0"><button class="icon-btn" data-ren="${i}" title="Rename" aria-label="Rename">✎</button><button class="icon-btn" data-del="${i}" title="Remove" aria-label="Remove">✕</button></div>`;
    it.onclick = e => { if (e.target.closest("[data-del],[data-ren]")) return; selectAoi(i); };
    list.append(it);
  });
  if (!S.aois.length) list.innerHTML = `<div class="item"><span></span><span class="s">No AOIs yet. Import a file, draw one, or load the UAE sample (6 airports and ports).</span><span></span></div>`;
  list.querySelectorAll("[data-del]").forEach(b => { b.disabled = readOnly; b.onclick = () => { if (readOnly) return; S.aois.splice(+b.dataset.del, 1); S.activeAoi = null; saveAois(); renderAois(); }; });
  list.querySelectorAll("[data-ren]").forEach(b => { b.disabled = readOnly; b.onclick = () => { if (!readOnly) renameAoi(+b.dataset.ren, b.closest(".item")); }; });
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
    : "Checked AOIs will use your Wayback date settings. Map selection controls the view.";
  const busy = Boolean(activeBrowserJob || browserQueue.length || queueDraining);
  $("#runVerb").textContent = !isServer() && busy ? "Queue" : "Run";
  $("#runBtn").disabled = !persistenceReady || readOnly || Boolean(storageError) || count === 0 || serverRunning || (isServer() ? busy : browserQueue.length >= MAX_WAITING_JOBS);
  $("#runAoiAll").disabled = $("#runAoiNone").disabled = !S.aois.length;
}
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
      selectAoi(index); $("#map").focus({ preventScroll: true });
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
function setServerRunning(running) { serverRunning = running; updateRunSelection(); }
function renameAoi(i, el) {
  const t = el.querySelector(".t"), inp = document.createElement("input"); inp.type = "text"; inp.value = S.aois[i].properties.name;
  t.replaceWith(inp); inp.focus(); inp.select();
  const done = () => { S.aois[i].properties.name = inp.value.trim() || S.aois[i].properties.name; saveAois(); renderAois(); };
  inp.onkeydown = e => { if (e.key === "Enter") done(); if (e.key === "Escape") renderAois(); }; inp.onblur = done;
}
function selectAoi(i) { S.activeAoi = i; renderAois(); map.fitBounds(L.geoJSON(S.aois[i]).getBounds().pad(0.15)); }
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

let drawMode = null, drawRequest = 0, drawTool = null;
async function startDraw(kind, purpose) {
  if (readOnly || !persistenceReady) return;
  const request = ++drawRequest;
  drawTool?.disable();
  try {
    await E.ensureLibrary("draw");
    if (request !== drawRequest || !pageActive) return;
    drawMode = purpose;
    drawTool = new (kind === "rect" ? L.Draw.Rectangle : L.Draw.Polygon)(map, { shapeOptions: { color: purpose === "aoi" ? "#f2a516" : color($("#drawClass").value), weight: 2 }, showArea: false });
    drawTool.enable();
  } catch (error) { if (request === drawRequest) toast(error.message, 5000); }
}
$("#drawRect").onclick = () => startDraw("rect", "aoi");
$("#drawPoly").onclick = () => startDraw("poly", "aoi");
map.on("draw:created", e => {
  const g = e.layer.toGeoJSON().geometry;
  if (drawMode === "aoi") addAois([{ type: "Feature", properties: { name: "AOI " + (S.aois.length + 1) }, geometry: g }]);
  else if (drawMode === "ann") addManualObject(g);
  drawMode = null; drawTool = null;
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
  $("#queueStatus").textContent = `${activeBrowserJob ? "1 running" : "Idle"} · ${browserQueue.length}/${MAX_WAITING_JOBS} queued`;
  if (queuePaused) $("#queueStatus").textContent += " · paused";
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
}
async function drainBrowserQueue() {
  if (queueDraining || serverRunning || !pageActive || queuePaused || !persistenceReady || readOnly || storageError) return;
  queueDraining = true;
  try {
    while (browserQueue.length && browserQueue[0].durableReady !== false && pageActive && !serverRunning && !queuePaused && !readOnly && !storageError) {
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
  const params = { release_mode: mode, releases: [...S.selRel], zoom: +$("#zoom").value, classes: [...S.wantClasses], conf: +$("#conf").value,
    model: m ? m.label : null, model_key: m?.key || null, imgsz: m?.imgsz || null, detect: detectOn, maxTiles: +$("#maxTiles").value || 1200,
    geotiff: $("#tifOn").checked, model_names: m?.names?.slice() };
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
          maxTiles: params.maxTiles, geotiff: params.geotiff,
          onCoverage: coverage => { outcome.zoom = coverage.zoom; outcome.coverage = coverage;
            jlog(job, `    Coverage z${coverage.zoom}: ${coverage.available}/${coverage.total} tiles available, ${coverage.unavailable} unavailable, ${coverage.unknown} unknown · ${coverage.checks} check(s) · ${(coverage.ms / 1000).toFixed(1)}s`); },
          onProgress: f => { job.progress = base + step * f; updateJobProgress(job); } });
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
        if (storageError) throw error;
        if (error.name === "AbortError" || signal.aborted) throw error;
        Object.assign(outcome, { status: error.code === "NO_IMAGERY" ? "unavailable" : "failed", code: error.code || "CLIP_ERROR",
          message: error.message, zoom: error.zoom ?? outcome.zoom ?? params.zoom, coverage: error.coverage || outcome.coverage });
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
    if (pageActive) toast(job.status === "done" ? `${GVCompare.modelName(params)}: job finished` : `${GVCompare.modelName(params)}: job finished with imagery issues. See Results.`);
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
  setServerRunning(true);
  try { S.jobId = (await postJSON("/api/jobs", body)).job_id; store.set("job", S.jobId); pollJob(S.jobId, base); }
  catch (e) { toast(e.message); setServerRunning(false); }
}
async function pollJob(id, base) {
  try {
    const j = await (await fetch(base + "/api/jobs/" + id)).json();
    if (!selectedBrowserJobId) {
      $("#prog").style.width = (j.progress * 100).toFixed(1) + "%";
      logEl.textContent = j.log.join("\n") || j.status; logEl.scrollTop = logEl.scrollHeight;
    }
    if (j.status === "running" || j.status === "queued") return setTimeout(() => pollJob(id, base), 1500);
    setServerRunning(false);
    if (j.status === "done") { toast("Job finished"); showTab("res"); }
  } catch { setTimeout(() => pollJob(id, base), 3000); }
}

// ---------------------------------------------------------------- results
let RES = [], clipGeneration = 0;
let compareRecords = [], compareChosen = [], catalogController = null, pairController = null;
let catalogGeneration = 0, compareGeneration = 0, compareView = null, compareSaved = null;
function comparing() { return $("#resultView").value === "compare"; }
function outputBase(job, path) { return api("/outputs/" + encodeURIComponent(job) + "/" + path.split("/").map(encodeURIComponent).join("/") + "/"); }
function compareRecord(r, params, job, index, browser) {
  return { ...r, params, job, browser, key: `${browser ? "browser" : "server"}:${job}:${index}`,
    model: GVCompare.modelName(params), modelKey: params.detect === false ? "imagery" : params.model_key || params.model || null,
    geometry: GVCompare.geometryKey(r.aoiFeature), source: r };
}
function stopComparison({ resumeEdit = true } = {}) {
  ++compareGeneration; pairController?.abort(); pairController = null; compareView?.stop();
  if (compareSaved) {
    const previous = compareSaved; compareSaved = null;
    if (previous.image) clipLayer.addTo(map); if (previous.detections) detLayer.addTo(map);
    map.setView(previous.centre, previous.zoom, { animate: false });
    $("#hudRel").textContent = previous.hud; $("#legend").style.visibility = previous.legend;
    if (resumeEdit && previous.editing && S.sel === previous.editing && detLayer.getLayers().includes(previous.editing)) {
      S.editing = previous.editing; previous.editing.editing.enable();
    }
  }
}
function exitComparison() {
  ++catalogGeneration; catalogController?.abort(); catalogController = null;
  stopComparison(); compareChosen = []; compareRecords = [];
  $("#resultView").value = "review"; $("#compareControls").hidden = true; $("#resultJobControls").hidden = false;
  $("#showImg").disabled = false; $("#resultHint").textContent = "Select a row to review its clipped imagery and detections.";
  renderResults();
}
async function refreshCompareCatalog() {
  catalogController?.abort(); const controller = catalogController = new AbortController(), generation = ++catalogGeneration;
  stopComparison(); $("#compareHint").textContent = "Loading available runs…"; $("#compareRefresh").disabled = true;
  const records = [], failures = [];
  for (const job of Object.values(BJOBS)) job.results.forEach((r, index) => records.push(compareRecord(r, job.params, job.id, index, true)));
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
              const record = compareRecord(r, params || {}, id, index, false);
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
    compareRecords = records; compareChosen = compareChosen.filter(key => records.some(r => r.key === key));
    renderResults();
    $("#compareHint").textContent = failures.length ? `${failures.length} run/clip lookup(s) unavailable. Refresh to retry. Select two available clips.`
      : records.length < 2 ? "At least two completed clips are needed. Run the same AOI on different dates or models first."
      : "Select two clips with the same AOI. Date comparison orders older left and newer right.";
    if (compareChosen.length === 2) showComparison();
  } catch (error) { if (!controller.signal.aborted && generation === catalogGeneration) $("#compareHint").textContent = "Could not load comparison runs: " + error.message; }
  finally { if (generation === catalogGeneration) $("#compareRefresh").disabled = false; }
}
async function comparisonAsset(record, signal) {
  let fc, blob;
  if (record.browser) { const result = await readClip(record.source, { draft: false, images: true }); fc = result.fc; blob = result.blobs.png; }
  else {
    const base = outputBase(record.job, record.path);
    fc = await E.requestJSON(base + "detections.geojson", { signal });
    const response = await fetch(base + "image.png", { signal });
    if (!response.ok) throw new Error(`Comparison image unavailable (HTTP ${response.status})`);
    blob = await response.blob();
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !blob) throw new Error("This clip has no usable imagery/detections.");
  return { fc, preview: await GVCompare.preview(blob, record.size, signal), bounds: clipBounds(record) };
}
async function showComparison() {
  stopComparison(); $("#compareSettings").textContent = "";
  const selected = compareChosen.map(key => compareRecords.find(r => r.key === key)).filter(Boolean);
  const validation = GVCompare.validatePair(selected, $("#compareKind").value || "dates");
  if (validation.error) { $("#compareHint").textContent = validation.error; return; }
  const generation = ++compareGeneration, controller = pairController = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  $("#compareHint").textContent = "Preparing comparison…";
  try {
    // Sequential preparation bounds retained decoded images; originals stay in exports.
    const left = await comparisonAsset(validation.pair[0], controller.signal), right = await comparisonAsset(validation.pair[1], controller.signal);
    if (generation !== compareGeneration || controller.signal.aborted || !comparing()) return;
    compareSaved = { centre: map.getCenter(), zoom: map.getZoom(), hud: $("#hudRel").textContent,
      image: map.hasLayer(clipLayer), detections: map.hasLayer(detLayer), editing: S.editing, legend: $("#legend").style.visibility };
    finishEdit(); map.removeLayer(clipLayer); map.removeLayer(detLayer); $("#legend").style.visibility = "hidden";
    compareView ||= new GVCompare.Swipe(map, $("#compareMap"));
    await compareView.show([left, right], feature => ({ color: color(feature.properties.class), weight: 2, fillOpacity: 0.08 }));
    if (generation !== compareGeneration) return;
    const [a, b] = validation.pair;
    $("#compareLeftLabel").textContent = `${validation.roles[0]} · ${a.date} · ${a.model} · ${left.fc.features.length} objects`;
    $("#compareRightLabel").textContent = `${validation.roles[1]} · ${b.date} · ${b.model} · ${right.fc.features.length} objects`;
    $("#hudRel").textContent = `${a.date} ↔ ${b.date}`;
    $("#compareHint").textContent = `${a.aoi} · drag the map divider to compare. Model predictions are read-only.`;
    $("#compareSettings").textContent = GVCompare.settingsNote(a, b) + " Full-resolution images remain in exports.";
    map.fitBounds(left.bounds);
  } catch (error) {
    if (generation === compareGeneration) { stopComparison(); $("#compareHint").textContent = controller.signal.aborted ? "Comparison timed out. Refresh or select the pair again." : error.message; }
  } finally { clearTimeout(timer); }
}
$("#resultView").onchange = () => {
  if (!comparing()) return exitComparison();
  ++clipGeneration;
  $("#resultJobControls").hidden = true; $("#compareControls").hidden = false; $("#showImg").disabled = true;
  $("#resultHint").textContent = "Select two checkboxes to compare available runs. Model names are shown for each clip.";
  renderResults(); refreshCompareCatalog();
};
$("#compareRefresh").onclick = refreshCompareCatalog;
$("#compareClear").onclick = () => { compareChosen = []; stopComparison(); renderResults(); $("#compareHint").textContent = "Select two clips in the table."; };
$("#compareKind").onchange = () => { compareChosen = []; stopComparison(); renderResults(); $("#compareHint").textContent = "Select two clips in the table."; };
$("#compareExit").onclick = exitComparison;
async function loadJobs() {
  const opts = Object.values(BJOBS).reverse().map(j => `<option value="${j.id}">${j.id.replace("browser_", "This browser · ")} · ${j.status}</option>`);
  if (S.online) { try { (await (await fetch(api("/api/jobs"))).json()).forEach(j => opts.push(`<option value="${j.id}">Server · ${j.id} · ${j.status}</option>`)); } catch {} }
  $("#jobSel").innerHTML = opts.join("") || "<option value=''>No jobs yet. Run one in Detect.</option>";
  if (S.jobId && [...$("#jobSel").options].some(o => o.value === S.jobId)) $("#jobSel").value = S.jobId;
  if ($("#jobSel").value) loadResults($("#jobSel").value); else { RES = []; renderResults(); }
}
$("#jobSel").onchange = () => { ++viewEpoch; S.jobId = $("#jobSel").value; loadResults(S.jobId); };
$("#jobRefresh").onclick = loadJobs;
async function loadResults(id) {
  if (BJOBS[id]) RES = BJOBS[id].results.map(r => ({ ...r, browser: true, job: id, params: BJOBS[id].params, source: r }));
  else { const j = await (await fetch(api("/api/jobs/" + id))).json(); RES = (j.results || []).map(r => ({ ...r, job: id, params: j.params || {} })); }
  renderResults();
  $("#deleteJob").disabled = readOnly || !BJOBS[id] || pendingJob(BJOBS[id]);
}
function renderResults() {
  const tb = $("#resTable tbody");
  const compare = comparing(), rows = compare ? compareRecords : RES;
  const job = BJOBS[$("#jobSel").value || S.jobId], issues = (job?.outcomes || []).filter(outcome => outcome.status !== "completed");
  $("#jobOutcomes").hidden = compare || !issues.length;
  $("#jobOutcomes").innerHTML = issues.length ? `<p class="hint">${job.results.length} usable clip(s) · ${esc(job.status)}. Unavailable and failed dates have no detection count. Incomplete clips cover available tiles only.</p><div class="tablewrap"><table><thead><tr><th>AOI / date</th><th>Outcome</th></tr></thead><tbody>${issues.map(outcome => `<tr><td>${esc(outcome.aoi)}<br><span class="mono">${esc(outcome.date)}</span></td><td>${esc(outcome.status.replace(/_/g, " "))}${outcome.zoom != null ? ` · z${outcome.zoom}` : ""}<br><span class="hint">${esc(outcome.message || (outcome.status === "partial" ? "Missing imagery tiles; counts are incomplete." : ""))}</span></td></tr>`).join("")}</tbody></table></div>` : "";
  $("#compareColumn").hidden = !compare;
  tb.innerHTML = rows.map((r, i) => `<tr class="${compare ? "" : "click"}" data-i="${i}">${compare ? `<td><input type="checkbox" data-compare-row="${i}" aria-label="Compare ${esc(r.aoi)} ${r.date} ${esc(r.model)}" ${compareChosen.includes(r.key) ? "checked" : ""} ${compareChosen.length === 2 && !compareChosen.includes(r.key) ? "disabled" : ""}></td>` : ""}<td>${esc(r.aoi)}</td><td class="mono">${r.date}</td><td class="model" title="${esc(r.model || GVCompare.modelName(r.params))}">${esc(r.model || GVCompare.modelName(r.params))}</td><td>${
    (Object.entries(r.counts).map(([k, v]) => `<span class="mono" style="color:${color(k)}">${v}</span> ${esc(k.replace(/_/g, " "))}`).join("<br>") || '<span class="muted">0</span>') + (r.missing ? '<br><span class="hint">Incomplete imagery</span>' : "")}</td></tr>`).join("")
    || `<tr><td colspan="${compare ? 5 : 4}" class="muted">No clips yet.</td></tr>`;
  if (compare) tb.querySelectorAll("[data-compare-row]").forEach(checkbox => { checkbox.onchange = () => {
    const key = compareRecords[+checkbox.dataset.compareRow].key;
    compareChosen = checkbox.checked ? [...compareChosen.filter(value => value !== key), key].slice(-2) : compareChosen.filter(value => value !== key);
    renderResults(); showComparison();
  }; });
  else tb.querySelectorAll("tr[data-i]").forEach(tr => tr.onclick = () => openClip(+tr.dataset.i));
  if (compare) $("#trendSec").hidden = true; else drawTrend();
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
    bar.onclick = () => { if (!comparing()) return openClip(+bar.dataset.trendI); };
    bar.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); return bar.onclick(); } };
  });
}
let displayURL = null, displayBlob = null;
function releaseClipImage() { clipLayer.clearLayers(); if (displayURL) URL.revokeObjectURL(displayURL); displayURL = displayBlob = null; }
const blobURL = blob => {
  if (displayBlob !== blob) { releaseClipImage(); displayBlob = blob; displayURL = URL.createObjectURL(blob); }
  return displayURL;
};
const clipBounds = r => [[r.bounds[1], r.bounds[0]], [r.bounds[3], r.bounds[2]]];
function renderClipImage() {
  clipLayer.clearLayers();
  const r = S.clip;
  if (!r || !$("#showImg").checked) return;
  if (r.browser && !r.blobs?.png) return;
  const src = r.browser ? blobURL(r.blobs.png) : api(`/outputs/${r.job}/${r.path}/image.png`);
  L.imageOverlay(src, clipBounds(r)).addTo(clipLayer);
}
async function openClip(i) {
  stopComparison({ resumeEdit: false }); finishEdit(); saveDraft(); const generation = ++clipGeneration;
  const previous = S.clip;
  if (durable && previous?.browser && !pendingWrites.length) { delete previous.source.draftFC; delete previous.source.fc; delete previous.source.blobs; }
  releaseClipImage();
  if (previous?.browser) delete previous.blobs;
  const r = RES[i]; S.clip = r; S.annFC = null; S.sel = null; detLayer.clearLayers();
  $$("#resTable tr").forEach(tr => tr.classList.toggle("sel", tr.dataset.i == i));
  $("#trend").querySelectorAll("[data-trend-i]").forEach(bar => {
    const selected = +bar.dataset.trendI === i;
    bar.classList.toggle("selected", selected); bar.setAttribute("aria-pressed", String(selected));
  });
  const b = clipBounds(r);
  const base = r.browser ? null : api(`/outputs/${r.job}/${r.path}/`);
  map.fitBounds(b);
  const rel = S.releases.find(x => x.release === r.release); if (rel) setWayback(rel);
  const source = r.browser ? r.source : null;
  // Keep model predictions immutable; a separate job-owned draft retains edits.
  let payload;
  try { if (source) payload = await readClip(source, { images: true }); }
  catch (error) { if (generation === clipGeneration) toast(error.message, 5000); return; }
  if (generation !== clipGeneration || comparing()) return;
  if (payload) r.blobs = payload.blobs;
  renderClipImage();
  const fc = source ? (source.draftFC ||= payload.draftFC || JSON.parse(JSON.stringify(payload.fc))) : await (await fetch(base + "detections.geojson")).json();
  if (generation !== clipGeneration || comparing()) return;
  const scope = r.storeId || "server:" + r.job + ":" + r.path;
  const savedDraft = !source && durable ? await DB.draft(scope) : null;
  if (savedDraft) { fc.features = savedDraft.features; }
  // New reviews are scoped to the exact run/clip. Ambiguous legacy reviews
  // remain available for training/export without overwriting another model.
  const ann = durable ? await DB.reviews(scope) : await getAnnotations(), byId = Object.fromEntries(ann.features.map(f => [f.id, f]));
  if (generation !== clipGeneration || comparing()) return;
  const hasDraft = Boolean(payload?.draftFC || savedDraft);
  if (!hasDraft) fc.features = fc.features.map(f => byId[f.id] || f);
  const have = new Set(fc.features.map(f => f.id));
  if (!hasDraft) ann.features.filter(f => f.properties.status === "manual" && f.properties.release === r.release && f.properties.aoi_id === r.aoi_id && !have.has(f.id)).forEach(f => fc.features.push(f));
  S.annFC = fc; if (durable) dirty = false; S.sel = null; renderDetections(); renderAnnCtx(); toast(`${fc.features.length} objects · ${r.aoi} · ${r.date}`);
}
$("#showImg").onchange = renderClipImage;
$("#openLiveDraft").onclick = async () => {
  finishEdit(); saveDraft(); stopComparison({ resumeEdit: false }); const generation = ++clipGeneration;
  const fc = durable ? await DB.draft("live") : volatileLiveDraft;
  if (generation !== clipGeneration || comparing()) return;
  if (!fc) return toast("No saved live-map draft yet");
  releaseClipImage();
  S.clip = null; S.sel = null; S.annFC = fc; if (durable) dirty = false; renderDetections();
  restoreLiveDate(fc);
  $("#annCtx").textContent = "Live map · recovered draft"; showTab("ann");
};
function restoreLiveDate(fc) {
  const releases = [...new Set(fc.features.map(f => f.properties.release).filter(r => r != null))];
  pendingLiveRelease = releases.length === 1 ? releases[0] : null;
  const release = S.releases.find(r => r.release === pendingLiveRelease);
  if (release) { pendingLiveRelease = null; setWayback(release); }
}

// ---------------------------------------------------------------- annotations
async function getAnnotations() {
  const local = durable ? await DB.reviews() : store.get("ann", { type: "FeatureCollection", features: [] });
  if (!isServer()) return local;
  try { const srv = await (await fetch(api("/api/annotations"))).json(); const exact = new Set(srv.features.map(f => JSON.stringify(f))); return { type: "FeatureCollection", features: srv.features.concat(local.features.filter(f => !exact.has(JSON.stringify(f)))) }; }
  catch { return local; }
}
async function upsertLocal(features) {
  if (durable) {
    const scope = S.clip ? S.clip.storeId || "server:" + S.clip.job + ":" + S.clip.path : "live";
    const jobId = S.clip?.job || null, aoiId = S.clip?.source?.aoiFeature?._gmd_id || null;
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
  detLayer.clearLayers(); if (!S.annFC) return;
  L.geoJSON(S.annFC, { pane: "gmd-detections", bubblingMouseEvents: false, style: STYLE, onEachFeature: (f, l) => {
    l.feature = f; l.on("click", e => { L.DomEvent.stopPropagation(e); if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); select(l); });
  } }).eachLayer(l => detLayer.addLayer(l));
  updStats();
}
function renderAnnCtx() {
  const c = S.clip; if (!c) return;
  $("#annCtx").innerHTML = `<dl class="kv"><dt>AOI</dt><dd>${esc(c.aoi)}</dd><dt>Imagery</dt><dd>${c.date} · release ${c.release}</dd><dt>Zoom</dt><dd>z${c.zoom}</dd><dt>Objects</dt><dd>${S.annFC.features.length}</dd></dl>`;
}
function finishEdit() { if (S.editing) { S.editing.editing.disable(); syncGeom(S.editing); S.editing = null; } }
function selectionNumber(value, digits) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return "—";
  const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : "—";
}
function select(l) {
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
  if (!S.sel || readOnly || !persistenceReady) return; const p = S.sel.feature.properties;
  if (cls) { p.original_class = p.original_class || p.class; p.class = cls; }
  p.status = st; p.reviewed_at = new Date().toISOString(); S.sel.setStyle(STYLE(S.sel.feature)); select(S.sel); updStats(); dirty = true; saveDraft();
}
async function editShape() {
  const selected = S.sel;
  if (!selected || readOnly || !persistenceReady) return;
  try {
    await E.ensureLibrary("draw");
    if (!pageActive || S.sel !== selected || !detLayer.getLayers().includes(selected)) return;
    // Leaflet.Draw init hooks do not run retroactively for pre-existing polygons.
    if (!selected.editing) selected.editing = new L.Edit.Poly(selected);
    S.editing = selected; selected.editing.enable(); toast("Drag the corners, then press Enter or click the map");
  } catch (error) { toast(error.message, 5000); }
}
function syncGeom(l) { if (readOnly) return; l.feature.geometry = l.toGeoJSON().geometry; if (l.feature.properties.status === "predicted") l.feature.properties.status = "corrected"; dirty = true; saveDraft(); }
function delSel() { if (!S.sel || readOnly || !persistenceReady) return; S.annFC.features = S.annFC.features.filter(f => f !== S.sel.feature); detLayer.removeLayer(S.sel); S.sel = null; $("#selCard").innerHTML = '<span class="hint">Click an object on the map.</span>'; updStats(); dirty = true; saveDraft(); }
function nextPending() {
  const ls = detLayer.getLayers().filter(l => l.feature.properties.status === "predicted").sort((a, b) => (b.feature.properties.confidence || 0) - (a.feature.properties.confidence || 0));
  if (!ls.length) return toast("Everything in this clip is reviewed");
  select(ls[0]); map.panTo(ls[0].getBounds().getCenter());
}
function addManualObject(geom) {
  if (readOnly || !persistenceReady) return;
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
$("#acceptAll").onclick = () => { if (!S.annFC || readOnly || !persistenceReady) return; let n = 0; S.annFC.features.forEach(f => { if (f.properties.status === "predicted" && f.properties.confidence >= 0.6) { f.properties.status = "verified"; n++; } }); renderDetections(); dirty = true; saveDraft(); toast(`${n} accepted`); };
$("#saveAnn").onclick = async () => {
  if (!S.annFC) return toast("Nothing to save");
  if (readOnly) return;
  finishEdit();
  const reviewed = S.annFC.features.filter(f => f.properties.status !== "predicted");
  if (!reviewed.length) {
    const scope = S.clip ? S.clip.storeId || "server:" + S.clip.job + ":" + S.clip.path : "live";
    if (!durable || !(await DB.reviews(scope)).features.length) return toast("Review at least one object first");
  }
  let out;
  try { saveDraft(); out = await upsertLocal(reviewed); }
  catch { return; }
  if (isServer()) { try { await postJSON("/api/annotations", { type: "FeatureCollection", features: reviewed }); } catch { toast("Saved in this browser; the server did not respond"); } }
  dirty = false; toast(`Saved · training set has ${out.features.length} objects`);
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
  const unsaved = Object.values(BJOBS).some(job => durable ? job.durableReady === false || job.results.some(r => r.persisted === false) : job.results.length && !job.exported);
  if (dirty || pendingWrites.length || unsaved) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------- train
async function loadAnnStats() {
  const fc = await getAnnotations(), c = {};
  fc.features.forEach(f => { const k = f.properties.class, r = f.properties.status === "rejected"; c[k] = c[k] || [0, 0]; c[k][r ? 1 : 0]++; });
  $("#annTable tbody").innerHTML = Object.entries(c).sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color(k)};margin-right:6px"></span>${esc(k.replace(/_/g, " "))}</td><td class="mono">${v[0]}</td><td class="mono">${v[1]}</td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">No saved annotations. Review objects in Annotate and press Save.</td></tr>`;
}
$("#annReload").onclick = loadAnnStats;
$("#dsBtn").onclick = async () => {
  const btn = $("#dsBtn"); btn.disabled = true; btn.textContent = "Building dataset…";
  try {
    const { blob, chips, classes } = await E.exportDataset(await getAnnotations(), { onProgress: f => $("#dsProg").style.width = (f * 100).toFixed(0) + "%" });
    store.set("dsClasses", classes);
    saveBlob(`geovision_dataset_${new Date().toISOString().slice(0, 10)}.zip`, blob);
    toast(`${chips} chips · ${classes.length} classes`);
  } catch (e) { toast(e.message, 4000); }
  btn.disabled = false; btn.textContent = "Download training dataset";
};
$("#trainBtn").onclick = async () => {
  if (!isServer()) return toast("Connect a server in Export → Processing");
  const body = { base_model: $("#baseModel").value, epochs: +$("#epochs").value, batch: +$("#batch").value, name: $("#mName").value.trim(), zoom: +$("#zoom").value };
  const { train_id } = await postJSON("/api/train", body);
  $("#trainBtn").disabled = true;
  const poll = async () => { const j = await (await fetch(api("/api/train/" + train_id))).json(); $("#trainLog").textContent = j.log.join("\n");
    if (j.status === "running") setTimeout(poll, 3000); else { $("#trainBtn").disabled = false; loadModels(); toast(j.status === "done" ? "Training finished" : "Training failed"); } };
  poll();
};

// ---------------------------------------------------------------- export
$("#expZip").onclick = async () => {
  const id = $("#jobSel").value || S.jobId;
  if (!id) return toast("Run a job first");
  if (BJOBS[id]) {
    const btn = $("#expZip"); btn.disabled = true;
    BJOBS[id].exporting = true;
    try {
      finishEdit(); saveDraft();
      const blob = await E.exportJobZip(BJOBS[id], { readResult: r => readClip(r, { images: true }), onProgress: m => btn.textContent = `Zipping… ${m.percent.toFixed(0)}%` });
      saveBlob(`geovision_${id}.zip`, blob); BJOBS[id].exported = true;
    } catch (e) { toast(e.message); }
    if (BJOBS[id]) BJOBS[id].exporting = false;
    btn.disabled = false; btn.textContent = "Download job zip";
  } else if (S.online) window.location.href = api(`/api/jobs/${id}/export`);
};
$("#expAoi").onclick = () => download("aois.geojson", JSON.stringify({ type: "FeatureCollection", features: S.aois }, null, 1));
$("#expDet").onclick = async () => {
  if (S.annFC) return download(`detections_${S.clip ? S.clip.aoi_id + "_" + S.clip.date : "live"}.geojson`, JSON.stringify(S.annFC));
  const a = await getAnnotations(); if (!a.features.length) return toast("Open a clip or save annotations first");
  download("annotations.geojson", JSON.stringify(a));
};
$("#expCsv").onclick = async () => {
  const id = $("#jobSel").value || S.jobId, feats = [];
  if (BJOBS[id]) { for (const r of BJOBS[id].results) feats.push(...(await readClip(r, { images: false, draft: false })).fc.features); }
  else if (S.annFC) feats.push(...S.annFC.features);
  if (!feats.length) return toast("Run a job or open a clip first");
  const cols = ["id","aoi_name","imagery_date","release","class","status","confidence","length_m","width_m","heading_deg","lon","lat"];
  const rows = feats.map(f => { const p = f.properties, c = p.centroid || [0, 0]; return cols.map(k => k === "id" ? f.id : k === "lon" ? c[0] : k === "lat" ? c[1] : (p[k] ?? "")).map(v => /[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(","); });
  download("detections.csv", [cols.join(","), ...rows].join("\n"), "text/csv");
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
      else { releaseClipImage(); S.clip = S.annFC = S.sel = null; detLayer.clearLayers(); }
    }
    for (const id of saved.queue) if (BJOBS[id] && pendingJob(BJOBS[id])) browserQueue.push(BJOBS[id]);
    queuePaused = browserQueue.length > 0;
    S.customModels = saved.models.filter(model => model.custom);
    const live = await DB.draft("live");
    if (live && !S.clip) { S.annFC = live; restoreLiveDate(live); renderDetections(); $("#annCtx").textContent = "Live map · recovered draft"; }
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
    if (S.clip?.job === id) { ++clipGeneration; if (S.editing) { S.editing.editing.disable(); S.editing = null; } releaseClipImage(); S.clip = S.annFC = S.sel = null; detLayer.clearLayers(); dirty = false; }
    if (comparing()) exitComparison();
    delete BJOBS[id]; S.jobId = null; if (selectedBrowserJobId === id) selectedBrowserJobId = null;
    renderBrowserQueue(); await loadJobs(); toast("Job deleted. Saved training reviews are kept.");
  } catch {} finally { job.deleting = false; renderStorage(); }
};
window.addEventListener("pagehide", () => {
  pageActive = false; ++drawRequest; drawTool?.disable(); invalidateLocalChanges(true); E.cancelReleaseRefresh();
  finishEdit(); saveDraft(); releaseClipImage();
  if (durable) {
    queuePaused = true;
    if (activeBrowserJob) { activeBrowserJob.suspending = true; activeBrowserJob.controller?.abort(); }
    // A hard close can skip this promise entirely. Committed running/queued
    // records already suffice for recovery; no final unload write is required.
    const runtime = activeBrowserJob?.runtimeFinished;
    storageShutdown = storageShutdown.then(async () => {
      await runtime;
      await flushWrites(); await DB.close();
    });
  } else {
    for (const job of [...browserQueue]) cancelBrowserJob(job.id, "Page closed or suspended");
    if (activeBrowserJob) cancelBrowserJob(activeBrowserJob.id, "Page closed or suspended");
  }
  if (comparing()) exitComparison(); compareView?.destroy(); compareView = null;
});
window.addEventListener("pageshow", async event => {
  if (!event.persisted) return;
  pageActive = true; loadReleases();
  if (durable) {
    persistenceReady = false; renderStorage(); updateRunSelection();
    await storageShutdown;
    if (pendingWrites.length) {
      const state = await DB.open(); readOnly = !state.writable; persistenceReady = true; renderBrowserQueue();
    } else { await restoreStorage(); await loadModels(); }
  } else drainBrowserQueue();
});
})();
