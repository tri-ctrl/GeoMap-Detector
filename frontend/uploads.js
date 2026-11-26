/* Lazy file ingestion client. Upload bytes go directly to object storage. */
(function (root) {
"use strict";
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`;
const abortError = () => new DOMException("Upload paused. Reselect the file to resume.", "AbortError");

function client(base = "", fetcher = fetch) {
  base = base.trim().replace(/\/+$/, "");
  if (base && !/^https?:\/\/[^/]+/i.test(base)) throw new Error("Enter an HTTP or HTTPS server URL");
  return { base, async request(path, { method = "GET", body, signal } = {}) {
    const timeout = AbortSignal.timeout(120000);
    const response = await fetcher(base + path, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(typeof data.detail === "string" ? data.detail : `File server returned HTTP ${response.status}`);
      error.status = response.status; throw error;
    }
    return response.json();
  } };
}

async function fingerprint(file) {
  // A bounded re-selection fingerprint, not a whole-file integrity checksum.
  const sample = 1024 * 1024;
  const metadata = new TextEncoder().encode(`${file.name}\n${file.size}\n${file.lastModified || 0}\n`);
  const buffer = await new Blob([metadata, file.slice(0, sample), file.slice(Math.max(sample, file.size - sample))]).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(v => v.toString(16).padStart(2, "0")).join("");
}

function putPart(url, blob, signal, progress = () => {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error, value) => { signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
    xhr.open("PUT", url); xhr.timeout = 120000;
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onerror = () => finish(new Error("Chunk upload failed. Check the object storage URL and CORS settings."));
    xhr.ontimeout = () => finish(new Error("Chunk upload timed out"));
    xhr.onabort = () => finish(abortError());
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return finish(new Error(`Chunk upload returned HTTP ${xhr.status}`));
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) return finish(new Error("Storage did not expose ETag. Check its CORS configuration."));
      finish(null, etag.replace(/"/g, ""));
    };
    signal.addEventListener("abort", abort, { once: true }); xhr.send(blob);
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function uploadFile({ api, file, session, signal, onProgress = () => {}, sendPart = putPart, wait = delay }) {
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  const path = `/api/uploads/${encodeURIComponent(session.id)}`;
  const count = Math.ceil(file.size / session.part_size);
  const saved = await api.request(path + "/parts", { signal: combined });
  const parts = new Map(), loaded = new Map();
  for (const part of saved.parts) {
    const expected = Math.min(session.part_size, file.size - (part.part_number - 1) * session.part_size);
    if (part.part_number >= 1 && part.part_number <= count && part.size === expected) {
      parts.set(part.part_number, { part_number: part.part_number, etag: part.etag });
      loaded.set(part.part_number, part.size);
    }
  }
  const update = () => onProgress(Math.min(file.size, [...loaded.values()].reduce((a, b) => a + b, 0)), file.size);
  update();
  let next = 1, failure;
  const worker = async () => {
    while (next <= count) {
      if (combined.aborted) throw abortError();
      const number = next++;
      if (parts.has(number)) continue;
      const offset = (number - 1) * session.part_size, blob = file.slice(offset, offset + session.part_size);
      for (let attempt = 0; ; attempt++) {
        try {
          // Refresh the signature on every retry, including an expired URL.
          const signed = await api.request(path + `/parts/${number}`, { method: "POST", signal: combined });
          const etag = await sendPart(signed.url, blob, combined, value => { loaded.set(number, value); update(); });
          parts.set(number, { part_number: number, etag }); loaded.set(number, blob.size); update(); break;
        } catch (error) {
          loaded.set(number, 0); update();
          if (combined.aborted || attempt >= 2) throw error;
          await wait(500 * 2 ** attempt, combined);
        }
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(3, count) }, async () => {
    try { await worker(); } catch (error) { if (!failure) failure = error; stop.abort(); }
  }));
  if (failure) throw failure;
  if (signal.aborted) throw abortError();
  if (parts.size !== count) throw new Error("Some upload parts are missing");
  return api.request(path + "/complete", { method: "POST", signal,
    body: { parts: [...parts.values()].sort((a, b) => a.part_number - b.part_number) } });
}

function create({ root: panel, map, L, beforeShow, notify, addAois }) {
  const $ = selector => panel.querySelector(selector);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  let api, visible = false, generation = 0, timer = null, catalogOwner = null, uploadOwner = null, previewOwner = null;
  let layer = null, previewUrl = null, offset = 0, ready = false, connectionOwner = null, selected = null;
  $("#filesApi").value = read("gv_uploadApi", "");
  api = client($("#filesApi").value);
  const status = message => { $("#filesStatus").textContent = message; };
  const uploadStatus = message => { $("#uploadStatus").textContent = message; };
  const busy = value => {
    $("#uploadPause").hidden = !value; $("#uploadStart").disabled = value || !selected || !ready;
    $("#uploadFile").disabled = value; $("#filesConnect").disabled = value;
  };
  function clearPreview() {
    previewOwner?.abort(); previewOwner = null;
    if (layer) map.removeLayer(layer);
    layer = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  async function refresh() {
    clearTimeout(timer);
    if (!visible || !ready || catalogOwner) return;
    const owner = catalogOwner = new AbortController(), epoch = generation;
    try {
      const data = await api.request(`/api/uploads?limit=25&offset=${offset}`, { signal: owner.signal });
      if (owner.signal.aborted || epoch !== generation) return;
      $("#uploadedFiles").innerHTML = data.items.length ? data.items.map(row => `<article class="queue-job uploaded-file" data-upload="${esc(row.id)}">
        <strong style="overflow-wrap:anywhere">${esc(row.name)}</strong>
        <div class="hint">${esc(row.status)} · ${bytes(row.size)} · attempt ${row.attempt}</div>
        ${row.error ? `<p class="hint" style="color:var(--bad)">${esc(row.error)}</p>` : ""}
        ${row.status === "uploading" ? '<p class="hint">Select the original file above to resume.</p><button class="btn" data-action="cancel">Cancel upload</button>' : ""}
        ${row.status === "failed" ? '<button class="btn" data-action="retry">Retry processing</button>' : ""}
        ${row.processed_files.map(file => `<div class="sec" style="margin-top:10px"><span>${esc(file.name)} · ${esc(file.kind)}${file.feature_count == null ? "" : ` · ${file.feature_count.toLocaleString()} ${file.feature_count === 1 ? "feature" : "features"}`}</span><div class="row">
          <button class="btn" data-action="preview" data-file="${esc(file.id)}">Show on map</button>
          <button class="btn" data-action="download" data-file="${esc(file.id)}">Download</button>
          ${file.kind === "vector" ? `<button class="btn" data-action="aois" data-file="${esc(file.id)}">Add as AOIs</button>` : ""}
          </div></div>`).join("")}</article>`).join("") : '<p class="hint">No uploaded files on this page.</p>';
      $("#filesPrevious").disabled = offset === 0; $("#filesNext").disabled = data.items.length < 25;
      $("#uploadedFiles").querySelectorAll("[data-action]").forEach(button => {
        const row = data.items.find(item => item.id === button.closest("[data-upload]").dataset.upload);
        button.onclick = async () => {
          button.disabled = true;
          try { await action(button.dataset.action, row, row.processed_files.find(file => file.id === button.dataset.file)); }
          catch (error) { if (error.name !== "AbortError") status(error.message); }
          finally { button.disabled = false; }
        };
      });
      status("Connected · server processing continues when this page closes.");
    } catch (error) { if (!owner.signal.aborted) status(error.message); }
    finally {
      if (catalogOwner === owner) catalogOwner = null;
      if (visible && epoch === generation) timer = setTimeout(refresh, 5000);
    }
  }
  async function connect() {
    connectionOwner?.abort();
    const owner = connectionOwner = new AbortController();
    ready = false; busy(Boolean(uploadOwner));
    const epoch = generation;
    try {
      const health = await api.request("/api/ingestion/health", { signal: owner.signal });
      if (epoch !== generation || owner.signal.aborted) return;
      ready = health.ok; $("#uploadFile").title = `Maximum file size: ${bytes(health.max_upload_bytes)}`;
      await refresh();
    } catch (error) {
      if (epoch === generation && !owner.signal.aborted) status(error.status === 404 ? "File processing is available with Docker Compose. Enter its portal URL above and connect." : error.message);
    } finally { if (connectionOwner === owner) { connectionOwner = null; busy(Boolean(uploadOwner)); } }
  }
  async function vectorData(row, file, signal) {
    const artifact = file.artifacts.find(a => a.role === "data");
    if (artifact.size > 20 * 1048576 || file.feature_count > 20000) throw new Error("This layer exceeds the map preview limit (20 MiB / 20,000 features). Download it to use a GIS application.");
    const signed = await api.request(`/api/uploads/${row.id}/files/${file.id}/data`, { signal });
    const response = await fetch(signed.url, { signal });
    if (!response.ok) throw new Error(`Processed file returned HTTP ${response.status}`);
    return response.json();
  }
  async function action(kind, row, file) {
    if (kind === "cancel" || kind === "retry") {
      await api.request(`/api/uploads/${row.id}${kind === "retry" ? "/retry" : ""}`, { method: kind === "cancel" ? "DELETE" : "POST" });
      await refresh(); return;
    }
    if (kind === "download") {
      const signed = await api.request(`/api/uploads/${row.id}/files/${file.id}/data?download=true`);
      const link = document.createElement("a"); link.href = signed.url; link.target = "_blank"; link.rel = "noopener";
      link.download = file.name; link.click(); return;
    }
    clearPreview(); const owner = previewOwner = new AbortController();
    if (file.kind === "vector") {
      const fc = await vectorData(row, file, owner.signal);
      if (owner.signal.aborted) return;
      if (kind === "aois") { addAois(fc); return; }
      await beforeShow(); if (owner.signal.aborted) return;
      layer = L.geoJSON(fc, { style: { color: "#0b8fb3", weight: 2 },
        pointToLayer: (_f, position) => L.circleMarker(position, { radius: 5, color: "#0b8fb3" }) }).addTo(map);
      map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 17 });
    } else {
      const signed = await api.request(`/api/uploads/${row.id}/files/${file.id}/preview`, { signal: owner.signal });
      const response = await fetch(signed.url, { signal: owner.signal });
      if (!response.ok) throw new Error("Raster preview is unavailable");
      const blob = await response.blob(); if (owner.signal.aborted) return;
      await beforeShow(); if (owner.signal.aborted) return;
      previewUrl = URL.createObjectURL(blob);
      const [west, south, east, north] = file.bbox, bounds = [[south, west], [north, east]];
      layer = L.imageOverlay(previewUrl, bounds, { opacity: .9, interactive: false }).addTo(map);
      map.fitBounds(bounds, { padding: [24, 24] });
    }
    notify(`Showing ${file.name}`);
  }
  $("#filesConnect").onclick = async () => {
    try {
      generation++; catalogOwner?.abort(); catalogOwner = null; clearTimeout(timer); clearPreview();
      api = client($("#filesApi").value); save("gv_uploadApi", api.base); offset = 0; await connect();
    } catch (error) { status(error.message); }
  };
  $("#uploadFile").onchange = event => { selected = event.target.files[0] || null; busy(Boolean(uploadOwner)); uploadStatus(selected ? `${selected.name} · ${bytes(selected.size)}` : "Choose a file to begin."); };
  $("#uploadPause").onclick = () => uploadOwner?.abort();
  $("#uploadStart").onclick = async () => {
    if (!selected || uploadOwner || !ready) return;
    const file = selected, owner = uploadOwner = new AbortController(); busy(true);
    try {
      uploadStatus("Checking file and resumable upload…");
      const hash = await fingerprint(file);
      if (owner.signal.aborted) throw abortError();
      const sessions = read("gv_uploadSessions", {}), key = api.base + ":" + hash;
      let id = sessions[key] || crypto.randomUUID();
      sessions[key] = id; save("gv_uploadSessions", Object.fromEntries(Object.entries(sessions).slice(-200)));
      let session = await api.request("/api/uploads", { method: "POST", signal: owner.signal,
        body: { id, name: file.name, size: file.size, fingerprint: hash, content_type: file.type || "application/octet-stream" } });
      if (["cancelled", "expired"].includes(session.status)) {
        id = crypto.randomUUID(); sessions[key] = id; save("gv_uploadSessions", sessions);
        session = await api.request("/api/uploads", { method: "POST", signal: owner.signal,
          body: { id, name: file.name, size: file.size, fingerprint: hash, content_type: file.type || "application/octet-stream" } });
      }
      if (session.status === "uploading") {
        await uploadFile({ api, file, session, signal: owner.signal, onProgress: (done, total) => {
          $("#uploadProgress").value = done / total * 100; uploadStatus(`Uploading ${bytes(done)} of ${bytes(total)} (${Math.floor(done / total * 100)}%)`);
        } });
      }
      delete sessions[key]; save("gv_uploadSessions", sessions);
      uploadStatus("Upload complete. Follow processing in the file list below."); selected = null; $("#uploadFile").value = "";
      offset = 0; await refresh();
    } catch (error) { uploadStatus(error.name === "AbortError" ? "Upload paused. Select the same file and upload to resume." : error.message + " Select the same file to retry."); }
    finally { if (uploadOwner === owner) uploadOwner = null; busy(false); }
  };
  $("#filesRefresh").onclick = () => ready ? refresh() : connect();
  $("#filesClearMap").onclick = clearPreview;
  $("#filesPrevious").onclick = () => { offset = Math.max(0, offset - 25); refresh(); };
  $("#filesNext").onclick = () => { offset += 25; refresh(); };
  return {
    show() { visible = true; ready ? refresh() : connect(); },
    hide() { visible = false; generation++; clearTimeout(timer); catalogOwner?.abort(); catalogOwner = null; connectionOwner?.abort(); connectionOwner = null; },
    suspend() { this.hide(); uploadOwner?.abort(); clearPreview(); }
  };
}

const exports = { client, fingerprint, uploadFile, create };
if (typeof module !== "undefined" && module.exports) module.exports = exports;
else root.GVUploads = exports;
})(typeof window !== "undefined" ? window : globalThis);
