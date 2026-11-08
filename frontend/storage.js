/* Device-local repository. Values are plain records/Blobs; never DOM, sessions,
 * canvases, controllers or promises. Keep this async boundary for a future API.
 */
(function (global) {
"use strict";
const VERSION = 2, NAME = "geomap-detector", LEASE_MS = 30000;
const uuid = () => global.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (message, name = "StorageError") => Object.assign(new Error(message), { name });
const schema = {
  meta: {}, aois: {}, jobs: {}, queue: {}, models: {}, weights: {},
  results: { jobId: "jobId", aoiId: "aoiId" }, predictions: { jobId: "jobId" },
  artifacts: { clipId: "clipId", jobId: "jobId" }, drafts: { jobId: "jobId" },
  reviews: { scope: "scope", jobId: "jobId", aoiId: "aoiId" },
};
function jobRecord(job) {
  const record = {};
  for (const key of ["id", "status", "progress", "log", "outcomes", "params", "aois", "releaseSource", "fingerprint", "plan", "createdAt", "exported"])
    if (job[key] !== undefined) record[key] = copy(job[key]);
  if (job.modelSpec) { const { buffer, ...source } = job.modelSpec; record.modelSpec = copy(source); }
  record.updatedAt = Date.now(); return record;
}
function resultRecord(result, jobId) {
  const { fc, draftFC, blobs, ...meta } = result;
  return { ...copy(meta), persisted: true, id: result.storeId, storeId: result.storeId, jobId, aoiId: result.aoiFeature?._gmd_id || null };
}
function modelRecord(model) { const { buffer, ...record } = model; return copy(record); }
function create(options = {}) {
  let { indexedDB, locks, name = NAME, onState = () => {} } = options;
  if (!("indexedDB" in options)) { try { indexedDB = global.indexedDB; } catch {} }
  if (!("locks" in options)) { try { locks = global.navigator?.locks; } catch {} }
  let db = null, writable = false, heartbeat = null, releaseLock = null, closing = false;
  const owner = uuid(), stats = { reads: {}, writes: 0, commits: 0, lastCommitMs: 0 };
  const state = () => ({ available: Boolean(db), writable, ...stats, reads: { ...stats.reads } });
  const emit = reason => onState({ ...state(), reason });
  function transaction(names, mode, action, protectedWrite = true) {
    if (!db) return Promise.reject(fail("Device database is unavailable"));
    if (mode === "readwrite" && protectedWrite && !writable) return Promise.reject(fail("Another tab owns this workspace. Reload after closing it.", "ReadOnlyError"));
    return new Promise((resolve, reject) => {
      const started = global.performance?.now?.() || Date.now();
      let tx, value, ownError;
      try { tx = db.transaction([...new Set([...names, ...(mode === "readwrite" && protectedWrite ? ["meta"] : [])])], mode); }
      catch (error) { reject(error); return; }
      const stores = Object.fromEntries([...tx.objectStoreNames].map(key => [key, tx.objectStore(key)]));
      const abort = error => { ownError = error; try { tx.abort(); } catch {} };
      const run = () => { try { action(stores, result => { value = result; }, abort); } catch (error) { abort(error); } };
      tx.oncomplete = () => {
        if (mode === "readwrite") { stats.commits++; stats.lastCommitMs = (global.performance?.now?.() || Date.now()) - started; }
        resolve(value);
      };
      tx.onabort = () => reject(ownError || tx.error || fail("Database transaction aborted", "AbortError"));
      tx.onerror = () => {}; // Abort reports the actual request/transaction error.
      if (mode === "readwrite" && protectedWrite) {
        const request = stores.meta.get("writer");
        request.onsuccess = () => {
          if (request.result?.owner !== owner || (!releaseLock && request.result.expires <= Date.now())) {
            writable = false; emit("ownership-lost"); abort(fail("Workspace ownership expired. Reload to recover safely.", "ReadOnlyError")); return;
          }
          if (releaseLock && request.result.expires <= Date.now()) stores.meta.put({ id: "writer", owner, expires: Date.now() + LEASE_MS });
          stats.writes++; run();
        };
      } else run();
    });
  }
  function read(store, id, index) {
    stats.reads[store] = (stats.reads[store] || 0) + 1;
    return transaction([store], "readonly", (s, done) => {
      const source = index ? s[store].index(index) : s[store];
      const r = id === undefined ? source.getAll() : index ? source.getAll(id) : source.get(id);
      r.onsuccess = () => done(r.result);
    });
  }
  const removeIndex = (store, index, value) => {
    const r = store.index(index).openKeyCursor(value);
    r.onsuccess = () => { const cursor = r.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
  };
  function putJob(s, job) {
    s.jobs.put(jobRecord(job));
    if (["queued", "running", "interrupted", "cancelling"].includes(job.status)) s.queue.put({ id: job.id, createdAt: job.createdAt, state: job.status });
    else s.queue.delete(job.id);
  }
  async function claim() {
    if (locks) {
      let acquired;
      const ready = new Promise(resolve => { acquired = resolve; });
      locks.request(name + ":writer", { ifAvailable: true }, async lock => {
        if (!lock) { acquired(false); return; }
        await new Promise(resolve => { releaseLock = resolve; acquired(true); });
      }).catch(() => acquired(false));
      if (!await ready) return;
    }
    writable = await transaction(["meta"], "readwrite", (s, done) => {
      const r = s.meta.get("writer"); r.onsuccess = () => {
        // A Web Lock proves the previous lock holder has exited, even if its
        // final best-effort lease deletion was interrupted by browser shutdown.
        if (locks || !r.result || r.result.owner === owner || r.result.expires <= Date.now()) {
          s.meta.put({ id: "writer", owner, expires: Date.now() + LEASE_MS }); done(true);
        } else done(false);
      };
    }, false);
    if (!writable) { releaseLock?.(); releaseLock = null; return; }
    heartbeat = global.setInterval?.(() => {
      transaction(["meta"], "readwrite", s => s.meta.put({ id: "writer", owner, expires: Date.now() + LEASE_MS }))
        .catch(() => { writable = false; emit("ownership-lost"); });
    }, LEASE_MS / 3);
    heartbeat?.unref?.();
  }
  async function open() {
    if (db) return state();
    closing = false;
    if (!indexedDB) { emit("unavailable"); return state(); }
    await new Promise((resolve, reject) => {
      let abandoned = false;
      const request = indexedDB.open(name, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const [key, indexes] of Object.entries(schema)) {
          const store = database.objectStoreNames.contains(key) ? request.transaction.objectStore(key) : database.createObjectStore(key, { keyPath: "id" });
          for (const [index, field] of Object.entries(indexes)) if (!store.indexNames.contains(index)) store.createIndex(index, field);
        }
      };
      request.onblocked = () => { abandoned = true; reject(fail("Database upgrade is blocked by another tab. Close it and reload.", "BlockedError")); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (abandoned) { request.result.close(); return; }
        db = request.result;
        db.onversionchange = () => { writable = false; db.close(); db = null; releaseLock?.(); releaseLock = null; global.clearInterval?.(heartbeat); emit("version-change"); };
        db.onclose = () => { if (!closing) { writable = false; db = null; emit("connection-closed"); } };
        resolve();
      };
    });
    try { await claim(); }
    catch (error) { releaseLock?.(); releaseLock = null; throw error; }
    emit(writable ? "ready" : "read-only"); return state();
  }
  async function migrate(legacy) {
    const existing = await read("meta", "legacy-v1");
    if (existing?.verifiedAt) return;
    const aois = legacy.aois, annotations = legacy.annotations;
    if (!Array.isArray(aois) || !aois.every(f => f?.type === "Feature" && f.geometry && f.properties) ||
        annotations?.type !== "FeatureCollection" || !Array.isArray(annotations.features) ||
        !annotations.features.every(f => f?.type === "Feature" && f.geometry && f.properties))
      throw fail("Legacy saved records are malformed. The original localStorage backup has been kept.", "MigrationError");
    const ids = new Set();
    const records = aois.map((feature, order) => {
      const id = existing?.aoiIds?.[order] || (feature._gmd_id && !ids.has(feature._gmd_id) ? feature._gmd_id : uuid()); ids.add(id);
      return { id, feature: { ...copy(feature), _gmd_id: id }, order, active: true };
    });
    await transaction(["meta", "aois", "reviews"], "readwrite", s => {
      // Recheck in the same transaction; a repeated migration cannot duplicate
      // legacy features (including duplicate/missing external Feature IDs).
      const marker = s.meta.get("legacy-v1"); marker.onsuccess = () => {
        if (marker.result) return;
        records.forEach(r => s.aois.put(r));
        annotations.features.forEach((feature, i) => s.reviews.put({ id: "legacy:" + i, scope: "legacy", order: i, feature: copy(feature) }));
        s.meta.put({ id: "legacy-v1", importedAt: Date.now(), aois: records.length, aoiIds: records.map(r => r.id), reviews: annotations.features.length });
      };
    });
    const [marker, savedAois, reviews] = await Promise.all([read("meta", "legacy-v1"), read("aois"), read("reviews", "legacy", "scope")]);
    const actualAois = savedAois.filter(r => r.active).sort((a, b) => a.order - b.order).map(r => r.feature);
    const actualReviews = reviews.sort((a, b) => a.order - b.order).map(r => r.feature);
    if (marker.aois !== actualAois.length || marker.reviews !== reviews.length ||
        JSON.stringify(actualAois) !== JSON.stringify(records.map(r => r.feature)) || JSON.stringify(actualReviews) !== JSON.stringify(annotations.features))
      throw fail("Legacy import read-back verification failed", "MigrationError");
    await transaction(["meta"], "readwrite", s => s.meta.put({ ...marker, verifiedAt: Date.now() }));
  }
  async function restore({ recover = false } = {}) {
    const [aois, jobs, results, queue, models] = await Promise.all([read("aois"), read("jobs"), read("results"), read("queue"), read("models")]);
    jobs.sort((a, b) => a.createdAt - b.createdAt).forEach(job => {
      if (recover && ["running", "cancelling"].includes(job.status)) job.status = "interrupted";
      job.results = results.filter(result => result.jobId === job.id).sort((a, b) => a.order - b.order);
    });
    if (recover && writable) await transaction(["jobs", "queue"], "readwrite", s => jobs.forEach(job => putJob(s, job)));
    return { aois: aois.filter(r => r.active).sort((a, b) => a.order - b.order).map(r => r.feature), jobs,
      queue: queue.sort((a, b) => a.createdAt - b.createdAt).map(r => r.id), models };
  }
  function saveAois(features) {
    const records = features.map((f, order) => { f._gmd_id ||= uuid(); return { id: f._gmd_id, feature: copy(f), order, active: true }; });
    return transaction(["aois"], "readwrite", s => {
      const current = new Set(records.map(r => r.id)), r = s.aois.openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { if (!current.has(c.key)) c.update({ ...c.value, active: false }); c.continue(); } };
      records.forEach(record => s.aois.put(record));
    });
  }
  function saveModel(model) {
    return transaction(["models", "weights"], "readwrite", s => {
      s.models.put({ ...modelRecord(model), id: model.key });
      if (model.buffer) s.weights.put({ id: model.key, blob: new Blob([model.buffer], { type: "application/octet-stream" }) });
    });
  }
  function saveJob(job) { return transaction(["jobs", "queue"], "readwrite", s => putJob(s, job)); }
  function saveClip(job, result) {
    const meta = resultRecord(result, job.id);
    return transaction(["jobs", "queue", "results", "predictions", "artifacts"], "readwrite", (s, done, abort) => {
      s.results.put(meta); s.predictions.put({ id: meta.id, jobId: job.id, fc: copy(result.fc) });
      for (const [kind, value] of Object.entries(result.blobs)) if (value != null) s.artifacts.put({ id: meta.id + ":" + kind, clipId: meta.id, jobId: job.id, kind, value });
      if (result.artifactSpool) {
        const request = s.artifacts.get("spool:" + result.artifactSpool);
        request.onsuccess = () => {
          const spool = request.result;
          if (!spool || spool.jobId !== job.id || spool.value.clipId !== meta.id) { abort(fail("Artifact staging owner does not match this job/clip")); return; }
          s.artifacts.put({ ...spool, clipId: "gmd-committed", value: { ...spool.value, state: "committed" } });
        };
      }
      putJob(s, job);
    });
  }
  async function clip(id, { images = true, draft = true } = {}) {
    const [meta, raw, edit, artifacts] = await Promise.all([read("results", id), read("predictions", id),
      draft ? read("drafts", id) : null, images ? read("artifacts", id, "clipId") : []]);
    if (!meta || !raw) throw fail("Saved clip is missing: " + id);
    return { ...meta, fc: raw.fc, draftFC: edit?.fc, blobs: Object.fromEntries(artifacts.map(a => [a.kind, a.value])) };
  }
  function saveDraft(id, jobId, fc) { return transaction(["drafts"], "readwrite", s => s.drafts.put({ id, jobId, fc: copy(fc), updatedAt: Date.now() })); }
  function saveReviews(scope, jobId, aoiId, features) {
    return transaction(["reviews"], "readwrite", s => {
      const r = s.reviews.index("scope").openKeyCursor(scope);
      r.onsuccess = () => {
        const cursor = r.result;
        if (cursor) { s.reviews.delete(cursor.primaryKey); cursor.continue(); }
        else features.forEach((feature, index) => s.reviews.put({ id: scope + ":" + index, scope, jobId, aoiId, order: index, feature: copy(feature) }));
      };
    });
  }
  function deleteJob(id) {
    return transaction(["jobs", "queue", "results", "predictions", "artifacts", "drafts"], "readwrite", s => {
      s.jobs.delete(id); s.queue.delete(id);
      for (const key of ["results", "predictions", "artifacts", "drafts"]) removeIndex(s[key], "jobId", id);
      // Saved training reviews and user-imported model sources are independent.
    });
  }
  // Staged chunks share the existing artifacts store/indexes. Result metadata
  // commits their manifest atomically; clip() never hydrates the chunk payloads.
  let sweptSpools = false;
  const cancelled = signal => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
  const chunkId = (id, file, sequence) => `chunk:${id}:${file}:${sequence}`;
  async function discardSpool(id) {
    await transaction(["artifacts"], "readwrite", s => {
      s.artifacts.delete("spool:" + id); removeIndex(s.artifacts, "clipId", "chunks:" + id);
    });
  }
  async function createSpool({ jobId, clipId, signal, maxBytes = 2 * 1024 ** 3 } = {}) {
    cancelled(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail("Temporary storage budget must be a positive whole number", "SpoolLimitError");
    if (!sweptSpools) {
      // Defer crash recovery to first processing/export use, preserving a lazy
      // startup. Never sweep the live owner's or committed result manifests.
      const records = await read("artifacts", "gmd-staging", "clipId");
      for (const record of records) if (record.value.owner !== owner) await discardSpool(record.value.id);
      sweptSpools = true;
    }
    const id = uuid(), manifest = { id: "spool:" + id, jobId: jobId || "temporary:" + id, clipId: "gmd-staging", kind: "spool",
      value: { id, owner, clipId, state: "staging", createdAt: Date.now() } };
    await transaction(["artifacts"], "readwrite", s => s.artifacts.put(manifest));
    let bytes = 0, closed = false;
    return { id, persistent: true, maxChunkBytes: 1048576,
      async put(file, sequence, value) {
        cancelled(signal); if (closed) throw fail("Temporary output owner is closed");
        const length = value.size ?? value.byteLength;
        if (!Number.isSafeInteger(length) || length > 1048576 || !Number.isSafeInteger(bytes + length) || bytes + length > maxBytes)
          throw fail("Temporary imagery/output exceeds its storage budget. Use a smaller AOI or fewer native formats.", "SpoolLimitError");
        // Concurrent acquisition callbacks reserve bytes before awaiting their
        // transactions, so they cannot all pass against the same old total.
        bytes += length;
        try { await transaction(["artifacts"], "readwrite", s => s.artifacts.put({ id: chunkId(id, file, sequence),
          jobId: manifest.jobId, clipId: "chunks:" + id, kind: "chunk", file, sequence, value })); }
        catch (error) { bytes -= length; throw error; }
        cancelled(signal);
      },
      async get(file, sequence) { cancelled(signal); const record = await read("artifacts", chunkId(id, file, sequence)); cancelled(signal); if (!record) throw fail("A temporary imagery/output chunk is missing"); return record.value; },
      async removeFile(file) {
        // Key prefixes avoid reading encoded pixel payloads while deleting.
        await transaction(["artifacts"], "readwrite", s => {
          const request = s.artifacts.index("clipId").openKeyCursor("chunks:" + id);
          request.onsuccess = () => { const c = request.result; if (c) { if (String(c.primaryKey).startsWith(`chunk:${id}:${file}:`)) s.artifacts.delete(c.primaryKey); c.continue(); } };
        });
      },
      async dispose() { if (closed) return; closed = true; await discardSpool(id); },
      state: () => ({ id, bytes, maxBytes, closed }),
    };
  }
  async function readArtifactChunk(artifact, sequence) {
    if (artifact?.gmdArtifact !== 1 || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= artifact.chunks) throw fail("Invalid chunked artifact reference");
    const record = await read("artifacts", chunkId(artifact.spool, artifact.file, sequence));
    if (!record) throw fail("Saved image/export artifact is incomplete. Its metadata has been preserved.");
    return record.value;
  }
  async function close() {
    closing = true; global.clearInterval?.(heartbeat);
    if (db && writable) await transaction(["meta"], "readwrite", s => s.meta.delete("writer")).catch(() => {});
    writable = false; db?.close(); db = null; releaseLock?.(); releaseLock = null;
  }
  return { open, close, state, migrate, restore, saveAois, saveModel, saveJob, saveClip, clip, saveDraft, saveReviews, deleteJob,
    createSpool, readArtifactChunk, discardSpool,
    migrated: async () => Boolean((await read("meta", "legacy-v1"))?.verifiedAt),
    reviews: async scope => ({ type: "FeatureCollection", features: (await read("reviews", scope, scope === undefined ? undefined : "scope")).sort((a, b) => (a.scope || "").localeCompare(b.scope || "") || (a.order || 0) - (b.order || 0)).map(r => r.feature) }),
    draft: async id => (await read("drafts", id))?.fc,
    model: async key => { const meta = await read("models", key); const weights = await read("weights", key); return meta ? { ...meta, buffer: weights ? new Uint8Array(await weights.blob.arrayBuffer()) : undefined } : null; },
  };
}
global.GVStorage = { create, uuid, jobRecord, resultRecord, modelRecord, VERSION, NAME };
})(typeof window !== "undefined" ? window : globalThis);
