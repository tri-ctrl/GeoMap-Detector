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

// Session payload ownership; Cesium owns its own render objects and URLs.
function createLayerStore({ map, L, changed = () => {} }) {
  const entries = new Map();
  const layerId = (row, file) => `${row.id}:${row.attempt}:${file.id}`;
  const layers = () => [...entries.values()].filter(entry => entry.ready);
  function remove(id) {
    const entry = entries.get(id); if (!entry) return;
    entry.owner.abort();
    if (entry.leaflet) map.removeLayer(entry.leaflet);
    if (entry.url) URL.revokeObjectURL(entry.url);
    entries.delete(id); changed();
  }
  function update2D(entry) {
    if (entry.kind === 'raster') entry.leaflet?.setOpacity(entry.opacity);
    else entry.leaflet?.setStyle({ opacity: entry.opacity, fillOpacity: entry.opacity * .3 });
    if (entry.leaflet) {
      if (entry.visible && !map.hasLayer(entry.leaflet)) entry.leaflet.addTo(map);
      if (!entry.visible && map.hasLayer(entry.leaflet)) map.removeLayer(entry.leaflet);
    }
  }
  async function add(row, file, load) {
    const id = layerId(row, file);
    if (entries.has(id)) return entries.get(id).pending;
    if (entries.size >= 8) throw new Error('Remove a map layer before adding another (maximum 8).');
    const entry = { id, uploadId: row.id, fileId: file.id, attempt: row.attempt, name: file.name,
      kind: file.kind, bounds: file.bbox, visible: true, opacity: .9, color: '#20b5cd', owner: new AbortController() };
    entries.set(id, entry); changed();
    entry.pending = (async () => {
      try {
        Object.assign(entry, await load(entry.owner.signal));
        if (entries.get(id) !== entry || entry.owner.signal.aborted) throw abortError();
        let features = 0, vertices = 0, pixels = 0;
        for (const item of entries.values()) {
          if (item.fc) {
            features += item.fc.features.length;
            const visit = value => { if (typeof value[0] === 'number') vertices++; else value.forEach(visit); };
            const geometry = g => { if (g.type === 'GeometryCollection') g.geometries.forEach(geometry); else visit(g.coordinates); };
            item.fc.features.forEach(f => geometry(f.geometry));
          }
          if (item.image) pixels += item.image.size[0] * item.image.size[1];
        }
        if (features > 10000 || vertices > 200000 || pixels * 4 > 64 * 1048576) throw new Error('Selected layers exceed the display budget (10,000 features / 200,000 vertices / 64 MiB raster pixels). Download large layers or remove another layer.');
        if (entry.fc) entry.leaflet = L.geoJSON(entry.fc, { style: { color: entry.color, weight: 2, opacity: entry.opacity, fillOpacity: entry.opacity * .3 },
          pointToLayer: (_feature, point) => L.circleMarker(point, { radius: 5, color: entry.color, opacity: entry.opacity }) });
        else {
          entry.url = URL.createObjectURL(entry.image.blob);
          const [w,s,e,n] = entry.bounds;
          entry.leaflet = L.imageOverlay(entry.url, [[s,w],[n,e]], { opacity: entry.opacity, interactive: false });
        }
        entry.ready = true; update2D(entry); changed(); return entry;
      } catch (error) { if (entries.get(id) === entry) remove(id); throw error; }
    })();
    return entry.pending;
  }
  return { entries, layers, layerId, add, remove,
    visibility(id, visible) { const entry = entries.get(id); if (entry) { entry.visible = visible; update2D(entry); changed(); } },
    opacity(id, value) { const entry = entries.get(id); if (entry) { entry.opacity = Math.max(0, Math.min(1, value)); update2D(entry); changed(); } },
    clear() { for (const id of entries.keys()) remove(id); },
    diagnostics() { return { loaded: layers().length, pending: entries.size - layers().length,
      visible: layers().filter(entry => entry.visible).length, urls: layers().filter(entry => entry.url).length }; }
  };
}

function create({ root: panel, apiBase = '', api: suppliedApi, saveFile, map, L, showLayer, changed = () => {} }) {
  const $ = selector => panel.querySelector(selector);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  // Integrated deployments use the same-origin API; static deployments receive
  // a published API base without asking users for server addresses.
  const api = suppliedApi || client(apiBase), local = api.mode === 'browser';
  let visible = false, generation = 0, timer = null, catalogOwner = null, uploadOwner = null, connectionOwner = null;
  let offset = 0, ready = false, selected = null, folders = [], rows = [], queryTimer = null;
  const folderKey='gv_directoryFolder:'+api.base;
  let folder = read(folderKey,local?'root':read('gv_directoryFolder','root')), restored = false;
  const status = message => { $('#filesStatus').textContent = message; };
  const uploadStatus = message => { $('#uploadStatus').textContent = message; };
  const selectedKey = 'gv_directoryLayers:' + api.base;
  const store = createLayerStore({ map, L, changed() {
    save(selectedKey, store.layers().map(entry => ({ uploadId: entry.uploadId, fileId: entry.fileId, attempt: entry.attempt,
      visible: entry.visible, opacity: entry.opacity })));
    renderActive(); renderRows(); changed();
  } });
  const busy = value => { $('#uploadPause').hidden = !value; $('#uploadStart').disabled = value || !selected || !ready;
    $('#uploadFile').disabled = value; $('#directoryNew').disabled = value || !ready; };
  const parent = id => folders.find(item => item.id === id);
  function directoryPath(id) {
    const names = [], seen = new Set();
    while (id && id !== 'root' && !seen.has(id)) { seen.add(id); const item = parent(id); if (!item) break; names.unshift(item.name); id = item.parent_id; }
    return '/' + names.join('/');
  }
  function openDirectory(id) {
    folder = id || 'root'; offset = 0; save(folderKey, folder);
    generation++; catalogOwner?.abort(); catalogOwner = null; refresh();
  }
  function renderDirectories() {
    const chain = []; let id = folder, seen = new Set();
    while (id !== 'root' && !seen.has(id)) { seen.add(id); const item = parent(id); if (!item) break; chain.unshift(item); id = item.parent_id || 'root'; }
    $('#directoryPath').innerHTML = '<button type="button" class="btn ghost" data-directory="root">All files</button>' + chain.map(item => `<span aria-hidden="true">/</span><button type="button" class="btn ghost" data-directory="${esc(item.id)}">${esc(item.name)}</button>`).join('');
    $('#directoryChildren').innerHTML = folders.filter(item => (item.parent_id || 'root') === folder).map(item => `<button type="button" class="directory-folder" data-directory="${esc(item.id)}"><span aria-hidden="true">▸</span> ${esc(item.name)}</button>`).join('');
    panel.querySelectorAll('[data-directory]').forEach(button => button.onclick = () => openDirectory(button.dataset.directory));
    $('#uploadDirectory').textContent = (local?'Add files to ':'Upload into ') + directoryPath(folder);
  }
  function renderActive() {
    $('#directoryLayerCount').textContent = `${store.layers().filter(entry => entry.visible).length} visible`;
    $('#directoryActive').innerHTML = [...store.entries.values()].map(entry => `<div class="directory-layer" data-layer="${esc(entry.id)}">
      <label class="row"><input type="checkbox" data-visible ${entry.visible ? 'checked' : ''} ${entry.ready ? '' : 'disabled'}><span style="flex:1">${esc(entry.name)}</span><span class="hint">${entry.ready ? entry.kind : 'Loading…'}</span></label>
      <div class="row"><label class="hint" style="flex:1">Opacity <input type="range" data-opacity min="0" max="100" value="${Math.round(entry.opacity*100)}" aria-label="Opacity for ${esc(entry.name)}"></label>
      <button type="button" class="btn" data-zoom ${entry.ready ? '' : 'disabled'}>Zoom</button><button type="button" class="btn" data-remove>Remove</button></div></div>`).join('') || '<p class="hint">Check a processed layer below to display it on the globe.</p>';
    $('#directoryActive').querySelectorAll('[data-layer]').forEach(element => {
      const id = element.dataset.layer;
      element.querySelector('[data-visible]').onchange = event => store.visibility(id, event.target.checked);
      element.querySelector('[data-opacity]').onchange = event => store.opacity(id, Number(event.target.value)/100);
      element.querySelector('[data-remove]').onclick = () => store.remove(id);
      element.querySelector('[data-zoom]').onclick = () => showLayer(store.entries.get(id).bounds).catch(error => status(error.message));
    });
  }
  function renderRows() {
    $('#uploadedFiles').innerHTML = rows.map(row => `<article class="uploaded-file" data-upload="${esc(row.id)}">
      <strong style="overflow-wrap:anywhere">${esc(row.name)}</strong><div class="hint">${esc(row.status)} · ${bytes(row.size)} · attempt ${row.attempt}</div>
      ${row.error ? `<p class="hint" style="color:var(--bad)">${esc(row.error)}</p>` : ''}
      ${row.status === 'uploading' ? '<p class="hint">Reselect the original file to resume.</p><button class="btn" data-action="cancel">Cancel upload</button>' : ''}
      ${row.status === 'failed' ? '<button class="btn" data-action="retry">Retry processing</button>' : ''}
      ${['completed','stored','failed','queued','processing'].includes(row.status)?'<button class="btn" data-action="source">Download original</button>':''}
      ${local&&row.status!=='processing'?'<button class="btn" data-action="remove-file">Delete saved copy</button>':''}
      ${row.processed_files.map(file => {
        const entry = store.entries.get(store.layerId(row,file)), spatial = file.bbox;
        return `<div class="directory-result" data-file="${esc(file.id)}"><div class="row">${spatial ? `<input type="checkbox" data-toggle ${entry ? 'checked' : ''} aria-label="Show ${esc(file.name)} on globe">` : ''}<span style="flex:1">${esc(file.name)}</span><span class="pill">${esc(file.kind)}</span></div>
        ${file.message ? `<p class="hint">${esc(file.message)}</p>` : ''}${!spatial ? '<span class="hint">No map location. Available in the directory.</span>' : ''}
        <div class="row">${spatial ? '<button type="button" class="btn" data-action="globe">View on globe</button>' : ''}<button type="button" class="btn" data-action="download">Download</button></div></div>`;
      }).join('')}
      <label class="hint">Move to directory<select data-move aria-label="Directory for ${esc(row.name)}"><option value="root">/</option>${folders.map(item => `<option value="${esc(item.id)}">${esc(directoryPath(item.id).length>96?'…'+directoryPath(item.id).slice(-93):directoryPath(item.id))}</option>`).join('')}</select></label>
      </article>`).join('') || '<p class="hint">This directory has no files. Upload a file or open a folder.</p>';
    $('#uploadedFiles').querySelectorAll('[data-upload]').forEach(element => {
      const row = rows.find(item => item.id === element.dataset.upload);
      const move = element.querySelector('[data-move]'); move.value = row.folder_id || 'root';
      move.onchange = async () => { try { await api.request(`/api/uploads/${row.id}/directory`, { method:'PATCH',body:{folder_id:move.value==='root'?null:move.value} }); await refresh(); } catch(error) { status(error.message); } };
      element.querySelectorAll('[data-toggle]').forEach(input => input.onchange = async () => {
        const file = row.processed_files.find(f => f.id === input.closest('[data-file]').dataset.file);
        if (!input.checked) return store.remove(store.layerId(row,file));
        try { await enable(row,file,true); } catch(error) { if(error.name!=='AbortError') status(error.message); }
      });
      element.querySelectorAll('[data-action]').forEach(button => button.onclick = async () => {
        const file = row.processed_files.find(f => f.id === button.closest('[data-file]')?.dataset.file);
        button.disabled = true;
        try { await action(button.dataset.action,row,file); } catch(error) { if(error.name!=='AbortError') status(error.message); }
        finally { button.disabled = false; }
      });
    });
  }
  async function payload(row,file,signal) {
    if (!['vector','raster'].includes(file.kind)) {
      const [w,s,e,n]=file.bbox;
      return {fc:{type:'FeatureCollection',features:[{type:'Feature',properties:{name:file.name},geometry:{type:'Point',coordinates:[(w+e)/2,(s+n)/2]}}]}};
    }
    const role = file.kind === 'vector' ? 'data' : 'preview', artifact = file.artifacts.find(a => a.role===role);
    if (!artifact || artifact.size > 20*1048576 || file.feature_count > 10000) throw new Error('Layer exceeds the globe display limit (20 MiB / 10,000 features). Download it or select a smaller layer.');
    let blob;
    if(local)blob=await api.readArtifact(row,file,role,signal);
    else {const signed = await api.request(`/api/uploads/${row.id}/files/${file.id}/${role}`,{signal});const response = await fetch(signed.url,{signal});if(!response.ok)throw new Error(`Layer download returned HTTP ${response.status}`);blob=await response.blob();}
    if(file.kind==='vector') return {fc:JSON.parse(await blob.text())};
    const bitmap = await createImageBitmap(blob);
    const size = [bitmap.width,bitmap.height]; bitmap.close();
    return {image:{blob,size,bounds:file.bbox}};
  }
  async function enable(row,file,zoom) {
    const entry = await store.add(row,file,signal => payload(row,file,signal));
    if (zoom && store.entries.has(entry.id)) await showLayer(entry.bounds);
  }
  async function action(kind,row,file) {
    if(local&&kind==='source'){saveFile(row.name,await api.readSource(row.id));return;}
    if(local&&kind==='download'){const artifact=file.artifacts.find(a=>a.role==='data');const extension=artifact?.media_type==='application/geo+json'?'.geojson':artifact?.media_type==='image/tiff'?'.tif':'';saveFile(file.name+(extension&&!file.name.toLowerCase().endsWith(extension)?extension:''),await api.readArtifact(row,file,'data'));return;}
    if(local&&kind==='remove-file'){await api.remove(row.id);for(const entry of store.entries.values())if(entry.uploadId===row.id)store.remove(entry.id);return refresh();}
    if(kind==='source') {const signed=await api.request(`/api/uploads/${row.id}/source`);const link=document.createElement('a');link.href=signed.url;link.target='_blank';link.rel='noopener';link.click();return;}
    if(kind==='globe') return enable(row,file,true);
    if(kind==='retry' || kind==='cancel') {
      await api.request(`/api/uploads/${row.id}${kind==='retry'?'/retry':''}`,{method:kind==='retry'?'POST':'DELETE'}); return refresh();
    }
    const signed=await api.request(`/api/uploads/${row.id}/files/${file.id}/data?download=true`);
    const link=document.createElement('a');link.href=signed.url;link.target='_blank';link.rel='noopener';link.click();
  }
  async function refresh() {
    clearTimeout(timer); if(!visible || !ready || catalogOwner) return;
    const owner=catalogOwner=new AbortController(),epoch=generation;
    try {
      const query=$('#directorySearch').value.trim();
      const [directory,data]=await Promise.all([api.request('/api/directories',{signal:owner.signal}),api.request(`/api/uploads?limit=25&offset=${offset}&folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(query)}`,{signal:owner.signal})]);
      if(owner.signal.aborted || epoch!==generation) return;
      folders=directory.items;rows=data.items;renderDirectories();renderRows();
      $('#filesPrevious').disabled=offset===0;$('#filesNext').disabled=rows.length<25;
      status(local?'Saved in this browser · files stay on this device.':'Connected · files and processing are saved on the server.');
    } catch(error) { if(!owner.signal.aborted) status(error.message); }
    finally { if(catalogOwner===owner)catalogOwner=null;if(visible&&epoch===generation)timer=setTimeout(refresh,5000); }
  }
  async function connect() {
    connectionOwner?.abort();const owner=connectionOwner=new AbortController(),epoch=generation;
    ready=false;busy(Boolean(uploadOwner));status('Loading Directory Files…');
    try {
      const health=await api.request('/api/ingestion/health',{signal:owner.signal});
      if(epoch!==generation || owner.signal.aborted)return;
      const directory=await api.request('/api/directories',{signal:owner.signal});folders=directory.items;
      if(folder!=='root'&&!folders.some(item=>item.id===folder))folder='root';
      renderDirectories();
      ready=health.ok;$('#uploadFile').accept=health.extensions.join(',');
      $('#uploadFormats').textContent=`Accepted file types: ${health.extensions.join(', ')}. ${local?'Browser limit: 128 MiB per file, 512 MiB saved total. GeoJSON/CSV/CZML and browser GDAL formats become globe layers; formats needing native decoders keep their originals for download.':'Spatial data becomes globe layers; documents and media keep their original location metadata.'}`;
      $('#filesStorageHint').textContent=local?'Files are saved and processed in this browser. Spatial outputs can be displayed together on the globe. Clearing site data removes saved copies.':'Uploads are processed on the server. Spatial outputs can be displayed together on the globe; files without coordinates remain in the directory.';
      $('#uploadStart').textContent=local?'Add and process':'Upload and process';$('#uploadPause').textContent=local?'Stop processing':'Pause upload';
      await refresh();
      if(!restored) {
        restored=true;const selection=read(selectedKey,[]).slice(0,8);
        for(const saved of selection) {
          if(owner.signal.aborted)break;
          try { const row=await api.request(`/api/uploads/${saved.uploadId}`,{signal:owner.signal}),file=row.processed_files.find(f=>f.id===saved.fileId);
            if(file&&row.attempt===saved.attempt&&file.bbox) { await enable(row,file,false);store.visibility(store.layerId(row,file),saved.visible);store.opacity(store.layerId(row,file),saved.opacity); }
          } catch(error) { if(error.name!=='AbortError')status('A saved layer could not be restored: '+error.message); }
        }
      }
    } catch(error) { if(!owner.signal.aborted)status(error.status===404?'Directory Files needs the application services. Open the full-stack application URL.':error.message); }
    finally {if(connectionOwner===owner){connectionOwner=null;busy(Boolean(uploadOwner));}}
  }
  $('#directoryNew').onclick=async()=>{
    const input=$('#directoryName'),name=input.value.trim();if(!name)return;
    try {await api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),parent_id:folder==='root'?null:folder,name}});input.value='';await refresh();}
    catch(error){status(error.message);}
  };
  $('#directorySearch').oninput=()=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{offset=0;generation++;catalogOwner?.abort();catalogOwner=null;refresh();},250);};
  $('#uploadFile').onchange=event=>{selected=event.target.files[0]||null;busy(Boolean(uploadOwner));uploadStatus(selected?`${selected.name} · ${bytes(selected.size)}`:'Choose a file to begin.');};
  $('#uploadPause').onclick=()=>uploadOwner?.abort();
  $('#uploadStart').onclick=async()=>{
    if(!selected||uploadOwner||!ready)return;
    const file=selected,owner=uploadOwner=new AbortController(),target=folder;busy(true);
    try {
      if(local){
        $('#uploadProgress').value=0;
        const row=await api.add(file,{folder_id:target==='root'?null:target,signal:owner.signal,onProgress:(message,value)=>{uploadStatus(message);$('#uploadProgress').value=value;}});
        $('#uploadProgress').value=100;uploadStatus(row.status==='stored'?'Original saved in this browser. See its format/location details below.':'File saved and processed in this browser.');selected=null;$('#uploadFile').value='';openDirectory(row.folder_id||'root');return;
      }
      uploadStatus('Checking file and resumable upload…');const hash=await fingerprint(file);if(owner.signal.aborted)throw abortError();
      const sessions=read('gv_uploadSessions',{}),key=api.base+':'+target+':'+hash;
      let id=sessions[key]||crypto.randomUUID();sessions[key]=id;save('gv_uploadSessions',Object.fromEntries(Object.entries(sessions).slice(-200)));
      const initialize=()=>api.request('/api/uploads',{method:'POST',signal:owner.signal,body:{id,name:file.name,size:file.size,fingerprint:hash,content_type:file.type||'application/octet-stream',folder_id:target==='root'?null:target}});
      let session=await initialize();
      if(['cancelled','expired'].includes(session.status)){id=crypto.randomUUID();sessions[key]=id;save('gv_uploadSessions',sessions);session=await initialize();}
      if(session.status==='uploading')await uploadFile({api,file,session,signal:owner.signal,onProgress:(done,total)=>{
        $('#uploadProgress').value=done/total*100;uploadStatus(`Uploading ${bytes(done)} of ${bytes(total)} (${Math.floor(done/total*100)}%)`);
      }});
      delete sessions[key];save('gv_uploadSessions',sessions);uploadStatus('Upload complete. Processing continues in this directory.');selected=null;$('#uploadFile').value='';
      openDirectory(session.folder_id||'root');
    } catch(error){uploadStatus(local?(error.name==='AbortError'?'Processing stopped. Any saved original remains available in this directory.':error.message):error.name==='AbortError'?'Upload paused. Reselect the same file to resume.':error.message+' Reselect the same file to retry.');if(local)await refresh();}
    finally{if(uploadOwner===owner)uploadOwner=null;busy(false);}
  };
  $('#filesRefresh').onclick=()=>ready?refresh():connect();$('#filesClearMap').onclick=()=>store.clear();
  $('#filesPrevious').onclick=()=>{offset=Math.max(0,offset-25);refresh();};$('#filesNext').onclick=()=>{offset+=25;refresh();};
  renderDirectories();renderActive();
  return { layers:store.layers, diagnostics:()=>({...store.diagnostics(),mode:local?'browser':'remote',processing:api.diagnostics?.().active||0,workers:api.diagnostics?.().workers||null}),
    select(id,index){const entry=store.entries.get(id);if(entry)status(`${entry.name} · ${entry.fc?.features[index]?.properties?.name||'feature '+(index+1)}`);},
    show(){visible=true;ready?refresh():connect();},
    hide(){visible=false;generation++;clearTimeout(timer);clearTimeout(queryTimer);catalogOwner?.abort();catalogOwner=null;connectionOwner?.abort();connectionOwner=null;},
    suspend(){this.hide();ready=false;uploadOwner?.abort();api.suspend?.();const selection=read(selectedKey,[]);store.clear();save(selectedKey,selection);restored=false;}
  };
}

const exports = { client, fingerprint, uploadFile, createLayerStore, create };
if (typeof module !== 'undefined' && module.exports) module.exports = exports;
else root.GVUploads = exports;
})(typeof window !== 'undefined' ? window : globalThis);
