const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { setup: appSetup, turn } = require('./helpers/app.cjs');
const source = fs.readFileSync(require.resolve('../frontend/engine.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const context = vm.createContext({ Blob, Response, AbortController, DOMException, setTimeout, clearTimeout, Uint8Array, Uint8ClampedArray,
    navigator: { gpu: {} }, fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    ort: { InferenceSession: { create: async () => ({ release: async () => {} }) } }, ...options });
  vm.runInContext(source, context); return { context, engine: context.GVEngine };
}
const spec = { key: 'test', url: 'models/test.onnx', names: ['plane'], imgsz: 1024 };
const assertIdle = engine => { const state = engine.operations.diagnostics(); assert.equal(state.active.length, 0); assert.equal(state.pendingReads, 0); assert.equal(state.requests, 0); assert.equal(state.inference, 0); assert.equal(state.tensors, 0); assert.equal(engine.allocations.diagnostics().reservedBytes, 0); };
test('processing admission waits for temporary download reservations and observes release even inside its callback', async () => {
  const { engine } = fixture(), limits = { maxEstimatedBytes: 1048576 }, download = engine.allocations.download(200000, limits);
  const lease = await engine.allocations.acquire('processing', 700000, limits, { onWaiting: () => download.release() });
  assert.equal(engine.allocations.diagnostics().waiting, 0); lease.release(); assertIdle(engine);
});
test('cancelling resource admission clears its waiter without releasing another owner', async () => {
  const { engine } = fixture(), limits = { maxEstimatedBytes: 1048576 }, download = engine.allocations.download(200000, limits), controller = new AbortController();
  const pending = engine.allocations.acquire('processing', 700000, limits, { signal: controller.signal });
  assert.equal(engine.allocations.diagnostics().waiting, 1); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(engine.allocations.diagnostics().waiting, 0); assert.equal(engine.allocations.diagnostics().reservedBytes, 600000);
  download.release(); assertIdle(engine);
});
test('download reservations have a separate count limit while sharing the same working-byte cap', async () => {
  const { engine } = fixture(), limits = { maxEstimatedBytes: 1048576 }, downloads = Array.from({ length: 4 }, () => engine.allocations.download(1, limits));
  assert.throws(() => engine.allocations.download(1, limits), { code: 'RESOURCE_BUSY' });
  const helper = engine.allocations.reserve('comparison', 100000, limits); assert.equal(engine.allocations.diagnostics().activeOperations.length, 5);
  assert.throws(() => engine.allocations.reserve('too big', 1000000, limits), { code: 'MEMORY_LIMIT' });
  helper.release(); downloads.forEach(lease => lease.release()); assertIdle(engine);
});
test('page hide revokes pending download URLs and releases their working reservations once', async () => {
  const app=await appSetup();app.element('#exportCombine').onclick();
  assert.equal(app.context.GVApp.diagnostics().downloadLeases,1);assert.ok(app.context.GVEngine.allocations.diagnostics().reservedBytes>0);
  const timer=[...app.timers.values()].find(t=>t.ms===10000);app.events.get('pagehide')();await turn();
  assert.equal(app.context.GVApp.diagnostics().downloadLeases,0);assertIdle(app.context.GVEngine);
  timer.callback();assert.equal(app.urlEvents.filter(e=>e.type==='revoke').length,1);
});
test('pre-aborted metadata/model/library actions start no request, session or script', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const f = fixture({ fetch: async () => { calls++; }, document: { createElement() { calls++; } } });
  await assert.rejects(f.engine.requestJSON('/metadata', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(f.engine.loadModel({ ...spec, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(f.engine.ensureLibrary('ort', { signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 0); assertIdle(f.engine);
});
test('model/metadata timeouts remain distinct from user cancellation and clear owned timers', async () => {
  const f = fixture({ fetch: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
  await assert.rejects(f.engine.requestJSON('/metadata', { timeoutMs: 2 }), { name: 'TimeoutError', code: 'REQUEST_TIMEOUT' });
  await assert.rejects(f.engine.loadModel({ ...spec, timeoutMs: 2 }), { name: 'TimeoutError', code: 'OPERATION_TIMEOUT' }); assertIdle(f.engine);
});
test('cancelled WebGPU creation drains and releases its late session without WASM fallback/cache insertion', async () => {
  const gate = deferred(), entered = deferred(), release = deferred(); let releases = 0, creates = 0;
  const f = fixture({ ort: { InferenceSession: { create: async () => { creates++; entered.resolve(); await gate.promise; return { release: async () => { releases++; await release.promise; } }; } } } });
  const controller = new AbortController(), pending = f.engine.loadModel({ ...spec, signal: controller.signal });
  await entered.promise; controller.abort(); let settled = false; pending.catch(() => { settled = true; }); gate.resolve(); await turn();
  assert.equal(releases, 1); assert.equal(settled, false); release.resolve(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(creates, 1); assertIdle(f.engine);
  f.context.ort.InferenceSession.create = async () => { creates++; return {}; }; await f.engine.loadModel(spec); assert.equal(creates, 2); assertIdle(f.engine);
});
test('aborting a failed GPU attempt cannot initialize a fallback provider', async () => {
  const controller = new AbortController(); let creates = 0;
  const f = fixture({ ort: { InferenceSession: { create: async () => { creates++; controller.abort(); throw Error('device lost'); } } } });
  await assert.rejects(f.engine.loadModel({ ...spec, signal: controller.signal }), { name: 'AbortError' }); assert.equal(creates, 1); assertIdle(f.engine);
});
function detectionFixture(run) {
  const owned = []; const f = fixture({ ort: { Tensor: class { constructor(type, data, dims) { this.data = data; this.dims = dims; this.disposed = 0; owned.push(this); } dispose() { this.disposed++; } } } });
  const pixels = new Uint8ClampedArray(1024 * 1024 * 4).fill(255);
  const raster = { w: 1024, h: 1024, rings: [[[0, 0], [1024, 0], [1024, 1024], [0, 1024], [0, 0]]], canvas: { getContext: () => ({ getImageData: () => ({ data: pixels }) }) } };
  return { ...f, owned, raster, model: { imgsz: 1024, names: ['plane'], session: { inputNames: ['images'], outputNames: ['output'], run } } };
}
test('preprocessing cancellation yields before constructing a tensor or calling inference', async () => {
  let runs = 0; const f = detectionFixture(async () => { runs++; }), controller = new AbortController();
  const pending = f.engine.detect(f.raster, f.model, { signal: controller.signal }); setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(runs, 0); assert.equal(f.owned.length, 0); assertIdle(f.engine);
});
test('inference failure disposes its input; late cancellation disposes every distinct output without progress', async () => {
  const failing = detectionFixture(async () => { throw Error('inference failed'); });
  await assert.rejects(failing.engine.detect(failing.raster, failing.model), /inference failed/); assert.equal(failing.owned[0].disposed, 1); assertIdle(failing.engine);
  const gate = deferred(), entered = deferred(), controller = new AbortController(); let disposed = 0, progress = 0;
  const output = { dims: [1, 6, 0], data: new Float32Array(0), dispose() { disposed++; } };
  const f = detectionFixture(async () => { entered.resolve(); await gate.promise; return { output, alias: output }; });
  const pending = f.engine.detect(f.raster, f.model, { signal: controller.signal, onProgress: () => progress++ });
  await entered.promise; controller.abort(); gate.resolve(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(disposed, 1); assert.equal(f.owned[0].disposed, 1); assert.equal(progress, 0); assertIdle(f.engine);
});
test('dense suppression yields to cancellation and releases tensors without emitting partial results', async () => {
  const controller = new AbortController(); let disposed = 0;
  const f = detectionFixture(async () => {
    const n = 3000, data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { data[i] = i % 100 * 10 + 2; data[n + i] = Math.floor(i / 100) * 10 + 2; data[n * 2 + i] = 2; data[n * 3 + i] = 2; data[n * 4 + i] = .9; }
    setTimeout(() => controller.abort(), 2); return { output: { dims: [1, 6, n], data, dispose() { disposed++; } } };
  });
  await assert.rejects(f.engine.detect(f.raster, f.model, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(disposed, 1); assertIdle(f.engine);
});
test('dataset/export cancellation rejects late success without downloads and permits retry', async () => {
  const app = await appSetup(), dataset = deferred(), archive = deferred(); let started = false;
  app.context.GVEngine.exportDataset = async () => { started = true; return dataset.promise; };
  const pending = app.element('#dsBtn').onclick(); for (let i = 0; i < 5 && !started; i++) await turn();
  app.element('#cancelDataset').onclick(); dataset.resolve({ blob: new Blob(['dataset']), chips: 1, classes: ['ship'] }); await pending;
  assert.equal(app.urlEvents.filter(e => e.type === 'create').length, 0); assert.equal(app.element('#dsBtn').disabled, false);
  const job = await app.element('#runBtn').onclick(); await turn();
  app.context.GVEngine.exportJobZip = async () => archive.promise;
  const exp = app.element('#expZip').onclick(); await turn(); app.element('#cancelExport').onclick(); archive.resolve(new Blob(['zip'])); await exp;
  assert.equal(job.exporting, false); assert.equal(app.urlEvents.filter(e => e.type === 'create').length, 0);
  app.context.GVEngine.exportJobZip = async () => new Blob(['retry']); await app.element('#expZip').onclick(); assert.equal(app.urlEvents.filter(e => e.type === 'create').length, 1);
});
test('a picked file destination aborts exactly once when settings fail before export starts', async () => {
  const app = await appSetup(); await app.element('#runBtn').onclick(); await turn(); let aborted = 0;
  app.context.showSaveFilePicker = async () => ({ createWritable: async () => ({ abort: async () => aborted++ }) });
  app.element('#rasterMemory').value = '0'; await app.element('#expSave').onclick(); assert.equal(aborted, 1); assert.equal(app.element('#expZip').disabled, false);
});
test('page hide clears server poll requests/timers and late callbacks cannot reschedule', async () => {
  const signals = []; const app = await appSetup({ server: true, fetchHook: async (url, options) => {
    if (url.endsWith('/api/jobs/server_job')) {
      signals.push(options.signal);
      if (signals.length > 1) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
      return { ok: true, json: async () => ({ status: 'running', log: [], progress: .1 }) };
    }
  } });
  await app.element('#runBtn').onclick(); await turn();
  const timers = [...app.timers.values()].filter(timer => timer.ms === 1500); assert.equal(timers.length, 1);
  timers[0].callback(); await turn(); const before = signals.length; assert.equal(before, 2);
  app.events.get('pagehide')(); await turn();
  assert.equal([...app.timers.values()].filter(timer => [1500, 3000].includes(timer.ms)).length, 0);
  timers[0].callback(); await turn(); assert.equal(signals.length, before); assert.equal(signals.at(-1).aborted, true); assertIdle(app.context.GVEngine);
});
test('page hide drains a pending training submission and cannot start a late status poll', async () => {
  let signal,entered=false;const app=await appSetup({server:true,fetchHook:async(url,options)=>{
    if(url.endsWith('/api/train')){signal=options.signal;entered=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))}
  }});
  const pending=app.element('#trainBtn').onclick();while(!entered)await turn();
  app.events.get('pagehide')();await pending;await turn();assert.equal(signal.aborted,true);
  assert.equal(app.context.GVApp.diagnostics().auxiliary.trainingPoll,false);assert.equal(app.requests.some(r=>r.url.includes('/api/train/')),false);assertIdle(app.context.GVEngine);
});
