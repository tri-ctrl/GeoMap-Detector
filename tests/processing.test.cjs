const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const scripts = Object.fromEntries(['engine.js', 'streaming.js', 'processing.js', 'processing-worker.js'].map(file => [file, fs.readFileSync(path.join(__dirname, '../frontend', file), 'utf8')]));
const feature = { type: 'Feature', properties: { name: 'Test' }, geometry: { type: 'Polygon', coordinates: [[[55.36,25.25],[55.361,25.25],[55.361,25.251],[55.36,25.25]]] } };
const release = { release: 101, date: '2026-10-29' };
const spec = { key: 'model', names: ['plane'], imgsz: 1024, buffer: new Uint8Array([1,2,3]) };
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup({ worker = true, failBoot = false, process } = {}) {
  const workers = [], calls = [], spools = new Map(); let released = 0, disposed = 0;
  const base = () => ({ AbortController, DOMException, URL, Blob, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, performance, navigator: {} });
  function engine(context) {
    vm.runInContext(scripts['engine.js'], context);
    context.GVEngine.loadModel = async input => { calls.push({ kind: 'model', input }); return { key: input.key, names: input.names, imgsz: 1024, provider: 'wasm', session: { release: async () => { released++; } } }; };
    context.GVEngine.processClip = process || (async (aoi, rel, options) => {
      calls.push({ kind: 'clip', options });
      if (!options.store) return { total: 0, blobs: {} };
      const spool = await options.store.createSpool({});
      await spool.put('png', 0, new Uint8Array([4,5,6]));
      const value = await spool.get('png', 0);
      assert.deepEqual([...value], [4,5,6]);
      options.onProgress?.(.5);
      return { total: 1, blobs: { png: { gmdArtifact: 1, spool: spool.id, file: 'png', size: 3, chunks: 1 } } };
    });
  }
  class Worker {
    constructor(url) {
      if (failBoot) throw new Error('Blocked by CSP');
      this.url = url; this.messages = []; workers.push(this);
      const context = this.context = vm.createContext({ ...base(), OffscreenCanvas: function(){}, createImageBitmap(){} });
      context.self = context;
      context.postMessage = (message, transfer) => { const copy = structuredClone(message, { transfer }); queueMicrotask(() => { if (!this.stopped) this.onmessage?.({ data: copy }); }); };
      context.importScripts = (...files) => { for (const file of files) { if (file === 'engine.js') engine(context); else vm.runInContext(scripts[file], context); } };
      vm.runInContext(scripts['processing-worker.js'], context);
    }
    postMessage(message, transfer) { this.messages.push(message); const copy = structuredClone(message, { transfer }); queueMicrotask(() => { if (!this.stopped) this.context.onmessage({ data: copy }); }); }
    terminate() { this.stopped = true; }
    emit(message) { this.onmessage({ data: message }); }
    crash() { this.onerror({ message: 'GPU worker crashed', preventDefault(){} }); }
  }
  const context = vm.createContext({ ...base(), Worker: worker ? Worker : undefined, OffscreenCanvas: function(){}, createImageBitmap(){}, document: { currentScript: { src: 'https://site.test/GeoMap-Detector/processing.js' } } });
  engine(context);
  vm.runInContext(scripts['streaming.js'], context);
  vm.runInContext(scripts['processing.js'], context);
  const store = { state: () => ({ available: true, writable: true }), async createSpool() {
    const id = 'spool-' + (spools.size + 1), data = new Map();
    const spool = { id, persistent: true, maxChunkBytes: 1048576,
      async put(file, sequence, value) { data.set(file + sequence, value.slice()); },
      async get(file, sequence) { return data.get(file + sequence); },
      async removeFile(file) { for (const key of data.keys()) if (key.startsWith(file)) data.delete(key); },
      async dispose() { disposed++; spools.delete(id); }, data };
    spools.set(id, spool); return spool;
  } };
  return { api: context.GVProcessing, engine: context.GVEngine, context, workers, calls, spools, store, stats: () => ({ released, disposed }) };
}

test('worker protocol preserves project paths, predictions, source weights and spool handoff', async () => {
  const h = setup(), controller = new AbortController();
  const runner = await h.api.create({ jobId: 'a', signal: controller.signal, store: h.store });
  assert.equal(runner.context, 'worker');
  await runner.loadModel({ ...spec, url: 'models/model.onnx' });
  let progress = 0;
  const result = await runner.processClip(feature, release, { bounded: true, clipId: 'a:0', onProgress: value => progress = value });
  assert.equal(progress, .5); assert.equal(result.total, 1);
  assert.equal(spec.buffer.byteLength, 3);
  assert.equal(h.workers[0].url.href, 'https://site.test/GeoMap-Detector/processing-worker.js');
  assert.equal(h.calls[0].input.url, 'https://site.test/GeoMap-Detector/models/model.onnx');
  assert.equal(h.spools.size, 1, 'The page now owns the successful export spool');
  await runner.close(); await runner.close();
  assert.equal(h.stats().released, 1); assert.equal(h.stats().disposed, 0);
  assert.equal(h.api.diagnostics().active, 0); assert.equal(h.api.diagnostics().pendingStorage, 0);
  assert.equal(h.engine.allocations.diagnostics().reservedBytes, 0);
  assert.equal(h.workers[0].stopped, true);
});

test('unavailable workers use the bounded compatibility path and release the job model once', async () => {
  const h = setup({ worker: false }), runner = await h.api.create({ jobId: 'a' });
  assert.equal(runner.context, 'main');
  await runner.loadModel(spec); await runner.processClip(feature, release, { bounded: true }); await runner.close();
  assert.equal(h.stats().released, 1); assert.equal(h.api.diagnostics().fallbacks, 1);
  assert.equal(h.calls[0].input.cache, false);
});

test('a CSP startup failure falls back before work; later jobs can retry worker startup', async () => {
  const h = setup({ failBoot: true }), reasons = [];
  const runner = await h.api.create({ jobId: 'a', onFallback: reason => reasons.push(reason) });
  assert.equal(runner.context, 'main'); assert.match(reasons[0], /CSP/);
  await runner.loadModel(null); await runner.close();
  assert.equal(h.api.diagnostics().active, 0);
});

test('cancellation drains storage/native work, rejects stale messages and disposes uncommitted spools', async () => {
  let finishNative, reached;
  const native = new Promise(resolve => finishNative = resolve), started = new Promise(resolve => reached = resolve);
  const h = setup({ process: async (aoi, rel, options) => {
    const spool = await options.store.createSpool({}); await spool.put('raw', 0, new Uint8Array([8])); reached();
    try { await native; options.signal.throwIfAborted(); }
    finally { await spool.dispose(); }
  } });
  const controller = new AbortController(), runner = await h.api.create({ jobId: 'a', signal: controller.signal, store: h.store });
  await runner.loadModel(spec);
  let progress = 0, settled = false;
  const processing = runner.processClip(feature, release, { bounded: true, clipId: 'a:0', onProgress: () => progress++ });
  processing.then(() => settled = true, () => settled = true);
  await started; controller.abort(); await turn();
  assert.equal(settled, false); assert.ok(h.engine.allocations.diagnostics().reservedBytes > 0);
  h.workers[0].emit({ v: 1, jobId: 'other', id: 2, type: 'result', payload: { result: 'stale' } });
  h.workers[0].emit({ v: 2, jobId: 'a', id: 2, type: 'result', payload: { result: 'incompatible' } });
  h.workers[0].emit({ v: 1, jobId: 'a', id: 99, type: 'progress', payload: { kind: 'onProgress', value: 1 } });
  finishNative(); await assert.rejects(processing, { name: 'AbortError' }); await runner.close();
  assert.equal(progress, 0); assert.equal(h.stats().disposed, 1); assert.equal(h.spools.size, 0);
  assert.equal(h.engine.allocations.diagnostics().reservedBytes, 0); assert.equal(h.stats().released, 1);
});

test('a crashed worker drains pending page writes, cleans its spool and permits a fresh job', async () => {
  let reached;
  const started = new Promise(resolve => reached = resolve);
  const h = setup({ process: async (aoi, rel, options) => { const spool = await options.store.createSpool({}); await spool.put('raw', 0, new Uint8Array([9])); reached(); return new Promise(()=>{}); } });
  const runner = await h.api.create({ jobId: 'a', store: h.store }); await runner.loadModel(spec);
  const pending = runner.processClip(feature, release, { bounded: true, clipId: 'a:0' });
  await started; h.workers[0].crash(); await assert.rejects(pending, { code: 'WORKER_CRASH' }); await runner.close();
  assert.equal(h.spools.size, 0); assert.equal(h.api.diagnostics().active, 0);
  const next = await h.api.create({ jobId: 'b', store: h.store }); await next.loadModel(spec); await next.close();
  assert.equal(h.api.diagnostics().created, 2); assert.equal(h.api.diagnostics().terminated, 2);
});

test('one job owns admission; a queued job cannot create a second worker', async () => {
  const h = setup(), runner = await h.api.create({ jobId: 'a' });
  await assert.rejects(h.api.create({ jobId: 'b' }), { code: 'RESOURCE_BUSY' });
  await runner.loadModel(null); await runner.close(); assert.equal(h.workers.length, 1);
});

test('quota failures cross the protocol intact and discard the unfinished spool', async () => {
  const h = setup({ process: async (aoi, rel, options) => {
    const spool = await options.store.createSpool({});
    try { await spool.put('png', 0, new Uint8Array([1])); }
    finally { await spool.dispose(); }
  } });
  const createSpool = h.store.createSpool;
  h.store.createSpool = async () => { const spool = await createSpool(); spool.put = async () => { throw new DOMException('Full device storage', 'QuotaExceededError'); }; return spool; };
  const runner = await h.api.create({ jobId: 'quota', store: h.store }); await runner.loadModel(spec);
  await assert.rejects(runner.processClip(feature, release, { bounded: true }), { name: 'QuotaExceededError' });
  await runner.close(); assert.equal(h.spools.size, 0); assert.equal(h.api.diagnostics().pendingStorage, 0);
});

test('a progress callback failure stops its worker and cleans staging before releasing admission', async () => {
  const h = setup(), runner = await h.api.create({ jobId: 'callback', store: h.store }); await runner.loadModel(spec);
  await assert.rejects(runner.processClip(feature, release, { bounded: true, onProgress: () => { throw new Error('Observer failed'); } }), /Observer failed/);
  await runner.close(); assert.equal(h.spools.size, 0); assert.equal(h.engine.allocations.diagnostics().reservedBytes, 0);
});

test('preflight includes transfer copies and rejects tight budgets before any clip/storage request', async () => {
  const h = setup(), runner = await h.api.create({ jobId: 'budget', store: h.store }); await runner.loadModel(spec);
  let options;
  for (let mib = 32; mib <= 256; mib++) {
    const candidate = { bounded: true, modelSize: 1024, limits: { maxEstimatedBytes: mib * 1048576 } };
    if (h.engine.estimateRaster(feature.geometry, 18, candidate).allowed && !h.api.estimateRaster(feature.geometry, 18, candidate).allowed) { options = candidate; break; }
  }
  assert.ok(options, 'Fixture must isolate the transfer allowance from native working bytes');
  await assert.rejects(runner.processClip(feature, release, options), { code: 'MEMORY_LIMIT' });
  assert.equal(h.calls.filter(call => call.kind === 'clip').length, 0); assert.equal(h.spools.size, 0);
  await runner.close();
});

test('worker settings preserve the captured concurrency, mask and timeout contract', async () => {
  const h = setup(), runner = await h.api.create({ jobId: 'settings', store: h.store }); await runner.loadModel(spec);
  await runner.processClip(feature, release, { bounded: true, concurrency: 1, forceBlocks: true, maskVersion: 'area-evenodd-v1', timeoutMs: 10000 });
  const options = h.calls.find(call => call.kind === 'clip').options;
  assert.equal(options.concurrency, 1); assert.equal(options.forceBlocks, true); assert.equal(options.maskVersion, 'area-evenodd-v1'); assert.equal(options.timeoutMs, 10000);
  await runner.close();
});

test('closing before model initialization acknowledges immediately and leaves no worker or timers', async () => {
  const h = setup(), runner = await h.api.create({ jobId: 'empty' });
  await assert.rejects(runner.processClip(feature, release, {}), { code: 'RESOURCE_BUSY' });
  await runner.close();
  assert.equal(h.api.diagnostics().active, 0); assert.equal(h.api.diagnostics().crashes, 0); assert.equal(h.workers[0].stopped, true);
});

test('compatibility sessions cannot be replaced before their job lease is released', async () => {
  const h = setup({ worker: false }), runner = await h.api.create({ jobId: 'once' }); await runner.loadModel(spec);
  await assert.rejects(runner.loadModel(spec), { code: 'RESOURCE_BUSY' });
  await runner.close(); assert.equal(h.stats().released, 1);
  await assert.rejects(runner.loadModel(spec), { code: 'RESOURCE_BUSY' });
});
