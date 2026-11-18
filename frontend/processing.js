/* Job-scoped worker adapter. The page retains its sole IndexedDB writer lease.
 * No native pixels, tensors or model sessions cross the worker boundary.
 */
(function (global) {
"use strict";
const VERSION = 1, CHUNK = 1048576, E = global.GVEngine;
const scriptURL = global.document?.currentScript?.src || global.location?.href;
const stats = { active: 0, created: 0, terminated: 0, crashes: 0, forcedStops: 0, fallbacks: 0, storageRequests: 0, transferredBytes: 0, pendingStorage: 0, last: null };
let activeJob = null;
const failure = (code, message) => Object.assign(new Error(message), { code });
const restoreError = value => Object.assign(new Error(value?.message || "Processing worker failed"), value);
const recordError = error => ({ name: error.name, message: error.message, code: error.code });
const capable = () => typeof global.Worker === "function" && typeof global.OffscreenCanvas === "function" && typeof global.createImageBitmap === "function";
function estimateRaster(geometry, zoom, options, worker = capable()) {
  const plan = E.estimateRaster(geometry, zoom, options);
  if (!worker) return plan;
  const workerTransferBytes = (Math.min(plan.concurrency, plan.tiles) + 2) * CHUNK;
  const estimatedBytes = plan.estimatedBytes + workerTransferBytes, violations = plan.violations.slice();
  if (estimatedBytes > plan.limits.maxEstimatedBytes && !violations.some(value => value.code === "MEMORY_LIMIT"))
    violations.push({ code: "MEMORY_LIMIT", message: `Worker processing including transfer buffers needs an estimated ${(estimatedBytes / 1048576).toFixed(1)} MiB. Reduce the AOI/preview or adjust Browser limits.` });
  return { ...plan, estimatedBytes, workerTransferBytes, allowed: !violations.length, violations };
}
async function create({ jobId, signal, store, onFallback } = {}) {
  E.operations.check(signal);
  if (typeof jobId !== "string" || !jobId) throw failure("INVALID_PROTOCOL", "A processing job ID is required.");
  if (activeJob) throw failure("RESOURCE_BUSY", "Another browser processing job owns the worker.");
  activeJob = jobId; stats.active++;
  let worker, command, sequence = 0, dead = false, closed = false, lease, model, closing, loading = false, initialized = false;
  const spools = new Map(), writes = new Set();
  const send = (type, id, payload, transfer = []) => { if (!dead) worker.postMessage({ v: VERSION, jobId, id, type, payload }, transfer); };
  const track = task => { writes.add(task); stats.pendingStorage++; task.finally(() => { writes.delete(task); stats.pendingStorage--; }).catch(() => {}); return task; };
  const drain = async () => { while (writes.size) await Promise.allSettled([...writes]); };
  async function discard(keep) {
    await drain();
    const errors = [];
    for (const [id, spool] of spools) {
      if (keep?.has(id)) continue;
      try { await spool.dispose(); spools.delete(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }
  function terminate() {
    if (dead) return; dead = true;
    if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); stats.terminated++; }
  }
  async function crash(error) {
    if (dead) return;
    stats.crashes++; terminate();
    const pending = command;
    try { await discard(); } catch (cleanup) { error.cleanupErrors = [cleanup.message]; }
    pending?.finish(error);
  }
  async function storage(message) {
    const { request, method, args = {} } = message.payload || {}, owner = command;
    if (!owner || message.id !== owner.id) return;
    stats.storageRequests++;
    let value, transfer = [];
    try {
      if (method === "create") {
        E.operations.check(signal);
        const spool = await global.GVStreaming.createSpool({ store, jobId, clipId: owner.clipId, maxBytes: args.maxBytes, signal });
        spools.set(spool.id, spool);
        value = { id: spool.id, persistent: spool.persistent, maxChunkBytes: spool.maxChunkBytes };
      } else {
        const spool = spools.get(args.spool);
        if (!spool) throw failure("MISSING_SPOOL", "The processing spool is no longer owned by this job.");
        if (method === "put") {
          E.operations.check(signal);
          if (!(args.data instanceof Uint8Array) || args.data.byteLength > CHUNK) throw failure("INVALID_BUFFER", "Worker chunk exceeds its transfer limit.");
          stats.transferredBytes += args.data.byteLength;
          await spool.put(args.file, args.sequence, args.data);
        } else if (method === "get") {
          E.operations.check(signal);
          const input = await spool.get(args.file, args.sequence);
          const data = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice()
            : input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(await input.arrayBuffer());
          if (data.byteLength > CHUNK) throw failure("INVALID_BUFFER", "Stored chunk exceeds its transfer limit.");
          stats.transferredBytes += data.byteLength; value = data; transfer = [data.buffer];
        } else if (method === "removeFile") await spool.removeFile(args.file);
        else if (method === "dispose") { await spool.dispose(); spools.delete(spool.id); }
        else throw failure("INVALID_PROTOCOL", "Unknown processing storage request.");
      }
      send("storage-result", message.id, { request, value }, transfer);
    } catch (error) { send("storage-result", message.id, { request, error: recordError(error) }); }
  }
  function call(type, payload, { callbacks, timeoutMs = 180000, clipId, cancellable = true } = {}) {
    if (dead) return Promise.reject(failure("WORKER_CRASH", "The processing worker stopped. Retry the unfinished clip."));
    if (command) return Promise.reject(failure("RESOURCE_BUSY", "Processing commands must run sequentially."));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      let cancelTimer;
      const timeout = setTimeout(() => crash(failure("WORKER_TIMEOUT", "Processing worker timed out. Retry the unfinished clip.")), timeoutMs);
      const abort = () => {
        send("cancel", id);
        // Native inference cannot be interrupted safely. Give it time to drain;
        // a hung context is terminated before the page releases its write lock.
        cancelTimer ??= setTimeout(() => { stats.forcedStops++; crash(failure("WORKER_CANCEL_TIMEOUT", "The worker did not acknowledge cancellation; its context was stopped.")); }, 30000);
      };
      command = { id, clipId, callbacks, finish(error, value) {
        if (command?.id !== id) return;
        clearTimeout(timeout); clearTimeout(cancelTimer); signal?.removeEventListener("abort", abort); command = null;
        error ? reject(error) : resolve(value);
      } };
      try { send(type, id, payload); if (cancellable) { if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); } }
      catch (error) { crash(error); }
    });
  }
  async function boot() {
    if (!capable()) return false;
    await E.ensureLibrary("streaming", { signal });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, supported) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(supported); };
      const abort = () => finish(new DOMException("Cancelled", "AbortError"));
      const timer = setTimeout(() => finish(failure("WORKER_STARTUP", "Processing worker startup timed out.")), 15000);
      try {
        worker = new global.Worker(new URL("processing-worker.js", scriptURL)); stats.created++;
        worker.onerror = event => { event.preventDefault?.(); const error = failure("WORKER_CRASH", event.message || "The processing worker stopped. Retry the unfinished clip."); if (!settled) finish(error); else crash(error); };
        worker.onmessageerror = () => {
          const error = failure("INVALID_PROTOCOL", "Could not read a processing worker message.");
          if (!settled) finish(error); else crash(error);
        };
        worker.onmessage = ({ data: message }) => {
          if (message?.v !== VERSION || dead) return;
          if (message.type === "ready") { finish(null, message.payload?.supported === true); return; }
          if (message.jobId !== jobId || message.id !== command?.id) return;
          if (message.type === "storage") { track(storage(message)); return; }
          if (message.type === "progress") {
            const { kind, value } = message.payload || {};
            if (["onProgress", "onEstimate", "onCoverage", "onWaiting"].includes(kind) && !signal?.aborted) {
              try { command.callbacks?.[kind]?.(value); } catch (error) { crash(error); }
            }
            return;
          }
          if (!["result", "error"].includes(message.type)) return;
          stats.last = message.payload?.diagnostics;
          command.finish(message.type === "error" ? restoreError(message.payload.error) : null, message.payload?.result);
        };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      } catch (error) { finish(error); }
    });
  }
  let supported = false;
  try { supported = await boot(); }
  catch (error) { if (signal?.aborted) { terminate(); stats.active--; activeJob = null; throw error; } onFallback?.(error.message); }
  if (!supported) { terminate(); stats.fallbacks++; }
  const runner = { context: supported ? "worker" : "main", async loadModel(spec) {
    if (closed || loading || initialized) throw failure("RESOURCE_BUSY", "A processing job can initialize its model only once.");
    E.operations.check(signal); loading = true;
    try {
      if (!supported) {
        if (spec) { lease = await E.models.acquire({ ...spec, signal }); model = { ...lease.model, names: spec.names?.slice() || lease.model.names }; }
      } else {
        const source = spec ? { ...spec } : null;
        // Clone a recoverable source; never detach imported weights on the page.
        if (source?.url) source.url = new URL(source.url, scriptURL).href;
        model = await call("load", { spec: source });
      }
      initialized = true; return model;
    } finally { loading = false; }
  }, async processClip(aoi, release, options) {
    if (closed || !initialized) throw failure("RESOURCE_BUSY", "Initialize the processing job before running a clip.");
    if (!supported) return E.processClip(aoi, release, { ...options, model, signal, store });
    E.operations.check(signal);
    const { onWaiting, onEstimate, onCoverage, onProgress } = options;
    const plan = E.allocations.requireRaster(estimateRaster(aoi.geometry, options.zoom ?? 18, { ...options, modelSize: model?.imgsz || 0 }, true));
    // Account conservatively for transfer copies plus IndexedDB serialization.
    // The mirrored page reservation also blocks overlapping dataset helpers.
    const transferBytes = plan.workerTransferBytes;
    const reservation = await E.allocations.acquire("Worker AOI clip", plan.estimatedBytes, plan.limits, { signal, onWaiting });
    try {
      const result = await call("clip", { aoi, release, options: { zoom: options.zoom, classes: options.classes, conf: options.conf,
        maxTiles: options.maxTiles, geotiff: options.geotiff, limits: options.limits, bounded: options.bounded, png: options.png,
        concurrency: options.concurrency, forceBlocks: options.forceBlocks, maskVersion: options.maskVersion,
        timeoutMs: options.timeoutMs, imageryTimeoutMs: options.imageryTimeoutMs, nmsMode: options.nmsMode,
        jobId, clipId: options.clipId, maxSpoolBytes: options.maxSpoolBytes } }, { callbacks: { onWaiting,
          onEstimate: value => onEstimate?.({ ...value, estimatedBytes: value.estimatedBytes + transferBytes, workerTransferBytes: transferBytes }),
          onCoverage, onProgress }, timeoutMs: 1860000, clipId: options.clipId });
      result.allocation = { ...result.allocation, workerTransferBytes: transferBytes, estimatedBytes: plan.estimatedBytes };
      if (signal?.aborted) { await discard(); E.operations.check(signal); }
      const retained = new Set(Object.values(result.blobs || {}).filter(value => value?.gmdArtifact).map(value => value.spool));
      await discard(retained);
      E.operations.check(signal);
      // Successful results hand their spool to the page's commit/export owner.
      for (const id of retained) spools.delete(id);
      return result;
    } catch (error) {
      try { await discard(); } catch (cleanup) { error.cleanupErrors = [...(error.cleanupErrors || []), cleanup.message]; }
      throw error;
    }
    finally { reservation.release(); }
  }, close() {
    if (!closing) closing = (async () => {
      if (closed) return; closed = true;
      const errors = [];
      try {
        const actions = [async () => { if (supported && !dead) await call("close", {}, { cancellable: false, timeoutMs: 30000 }); },
          async () => { await lease?.release(); }, discard];
        for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
      } finally { terminate(); stats.active--; activeJob = null; }
      if (errors.length) throw errors[0];
    })();
    return closing;
  } };
  return runner;
}
global.GVProcessing = { create, estimateRaster, diagnostics: () => ({ ...stats, jobId: activeJob }) };
})(typeof window !== "undefined" ? window : globalThis);
