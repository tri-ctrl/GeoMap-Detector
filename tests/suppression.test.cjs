const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { scan, box, random, workloads } = require('./helpers/nms-fixtures.cjs');
const source = fs.readFileSync(require.resolve('../frontend/engine.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function setup(extra = {}) {
  const context = vm.createContext({ performance, AbortController, DOMException, setTimeout, clearTimeout,
    scheduler: { yield: () => new Promise(setImmediate) }, ...extra });
  vm.runInContext(source, context); return { context, engine: context.GVEngine };
}
const ids = values => Array.from(values, d => d.id);
function idle(engine) { const s = engine.suppression.diagnostics(); assert.equal(s.active, 0); assert.equal(s.activeIndexEstimateBytes, 0); }
test('indexed/scan suppression returns the original ordered objects on all declared workloads and both policies', () => {
  const { engine } = setup();
  for (const scene of workloads()) for (const useMin of [false, true]) {
    const expected = scan(scene.dets, .45, useMin), profile = {};
    const indexed = engine.nms(scene.dets, .45, useMin, { profile });
    assert.deepEqual(ids(indexed), ids(expected), scene.name); indexed.forEach((d, i) => assert.equal(d, expected[i]));
    assert.deepEqual(ids(engine.nms(scene.dets, .45, useMin, { mode: 'scan' })), ids(expected));
    assert.ok(profile.peakIndexEstimateBytes <= 2 * 1048576); assert.equal(profile.status, 'complete'); idle(engine);
  }
});
test('seeded rotated boxes preserve confidence ties, class grouping and exact threshold semantics', () => {
  const { engine } = setup();
  for (let seed = 1; seed <= 12; seed++) {
    const rand = random(seed), dets = Array.from({ length: 700 }, (_, i) => box(i, rand() * 2000 - 500, rand() * 2000 - 500,
      rand() * 180, rand() * 100, rand() * Math.PI, seed % 2 ? 'ship' : ['0', 'solar_array'][i % 2], Math.round(rand() * 4) / 4));
    const before = JSON.stringify(dets);
    for (const threshold of [0, .45, 1, -.1]) for (const useMin of [false, true])
      assert.deepEqual(ids(engine.nms(dets, threshold, useMin)), ids(scan(dets, threshold, useMin)), `seed ${seed}/${threshold}/${useMin}`);
    assert.equal(JSON.stringify(dets), before);
  }
});
test('closed cell boundaries, zero-area boxes, containment and unindexable coordinates match the scan', () => {
  const { engine } = setup(), dets = Array.from({ length: 700 }, (_, i) => box(i, i * 64 + 63, -64, 2, 2));
  dets.push(box('touch', 65, -64, 2, 2), box('zero', 100, 100, 0, 0), box('giant', 0, 0, 1e8, 1e8),
    box('nan', NaN, 0), box('infinite', Infinity, 0), box('unsafe', 1e20, 1e20));
  for (const threshold of [0, .45, 1, NaN]) for (const useMin of [false, true])
    assert.deepEqual(ids(engine.nms(dets, threshold, useMin)), ids(scan(dets, threshold, useMin)));
  const contained = [box('outer', 0, 0, 20, 20), box('inner', 0, 0, 2, 2)];
  assert.deepEqual(ids(engine.nms(contained, .45, false)), ['outer', 'inner']);
  assert.deepEqual(ids(engine.nms(contained, .45, true)), ['outer']); idle(engine);
});
test('large/overflow boxes and tiny scratch budgets fall back without truncating detections', () => {
  const { engine } = setup(), dets = workloads().find(s => s.name === 'sparse-global-3000').dets, expected = ids(scan(dets, .45, false));
  for (const maxIndexBytes of [0, 1024, 8192, 262144, 2 * 1048576]) {
    const profile = {}; assert.deepEqual(ids(engine.nms(dets, .45, false, { maxIndexBytes, profile })), expected);
    assert.ok(profile.peakIndexEstimateBytes <= maxIndexBytes); idle(engine);
  }
});
test('the spatial broad phase removes most sparse bounding-box checks and keeps adversarial dense fallback', () => {
  const { engine } = setup(), scenes = workloads(), sparse = scenes.find(s => s.name === 'sparse-global-3000'), dense = scenes.find(s => s.name === 'parallel-retained-512');
  const profile = {}; engine.nms(sparse.dets, .45, false, { profile });
  assert.ok(profile.bboxTests < sparse.dets.length * (sparse.dets.length - 1) / 2 / 4); assert.ok(profile.indexQueries > 0);
  const other = {}; engine.nms(dense.dets, .45, false, { profile: other }); assert.ok(other.denseFallbacks > 0); idle(engine);
});
test('custom class names including numeric and prototype-like labels retain independent groups', () => {
  const { engine } = setup(), dets = ['ship', '0', '1', 'constructor', '__proto__', 'solar_array'].map((cls, i) => box(i, 0, 0, 5, 5, 0, cls));
  assert.deepEqual(ids(engine.nms(dets, .45, false)), [1, 2, 0, 3, 4, 5]); idle(engine);
});
test('async suppression matches sync and releases scratch when cancelled after the index becomes active', async () => {
  let engine, observed = false; const controller = new AbortController();
  ({ engine } = setup({ scheduler: { yield: async () => { if (engine.suppression.diagnostics().activeIndexEstimateBytes) { observed = true; controller.abort(); } await new Promise(setImmediate); } } }));
  const dets = workloads().find(s => s.name === 'sparse-global-3000').dets, profile = {};
  await assert.rejects(engine.suppression.runAsync(dets, .45, false, controller.signal, { profile }), { name: 'AbortError' });
  assert.ok(observed); assert.equal(profile.status, 'cancelled'); assert.ok(profile.kept > 0 && profile.kept < dets.length); idle(engine);
  const other = setup().engine;
  assert.deepEqual(ids(await other.suppression.runAsync(dets, .45, false)), ids(scan(dets, .45, false))); idle(other);
});
test('errors and pre-aborted work cannot leave index owners or borrowed candidates behind', async () => {
  const { engine } = setup(), dets = workloads().find(s => s.name === 'sparse-global-3000').dets;
  Object.defineProperty(dets[900], 'bb', { get() { throw Error('bad bounds'); } });
  assert.throws(() => engine.nms(dets, .45, false), /bad bounds/); idle(engine);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.suppression.runAsync(dets, .45, false, controller.signal), { name: 'AbortError' }); idle(engine);
});
test('cancelling one suppression owner cannot clear another active index', async () => {
  let engine; const controller = new AbortController();
  ({ engine } = setup({ scheduler: { yield: async () => {
    if (engine.suppression.diagnostics().activeIndexEstimateBytes > 2 * 1048576) controller.abort();
    await new Promise(setImmediate);
  } } }));
  const dets = workloads().find(s => s.name === 'sparse-global-3000').dets, a = {}, b = {};
  const first = engine.suppression.runAsync(dets, .45, false, controller.signal, { profile: a });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const other = await engine.suppression.runAsync(dets, .45, false, undefined, { profile: b }); await rejected;
  assert.deepEqual(ids(other), ids(scan(dets, .45, false))); assert.equal(a.status, 'cancelled'); assert.equal(b.status, 'complete');
  assert.ok(a.peakIndexEstimateBytes <= 2 * 1048576 && b.peakIndexEstimateBytes <= 2 * 1048576); idle(engine);
});
test('decoding keeps the stable top-3000 boundary and reads the selected tensor data only once', () => {
  const { engine } = setup(), n = 4000, data = new Float32Array(n * 6); let reads = 0;
  for (let i = 0; i < n; i++) { data[i] = i * 5; data[n + i] = 10; data[n * 2 + i] = 2; data[n * 3 + i] = 2; data[n * 4 + i] = .9; }
  const out = { dims: [1, 6, n], get data() { reads++; return data; } }, profile = { selectedOutputBytes: 0, peakSelectedOutputBytes: 0, outputAnchors: 0, decodedCandidates: 0, topKDiscarded: 0 };
  const decoded = engine.decode(out, ['plane'], .3, new Set(['aircraft']), true, profile);
  assert.equal(reads, 1); assert.equal(decoded.length, 3000); assert.equal(profile.topKDiscarded, 1000);
  assert.equal(profile.selectedOutputBytes, data.byteLength);
  const centre = d => d.poly.reduce((sum, p) => sum + p[0], 0) / 4;
  assert.equal(centre(decoded[0]), 0); assert.equal(centre(decoded.at(-1)), 2999 * 5);
  assert.ok(decoded.every(d => d.cls === 'aircraft'));
  const axis = engine.decode({ dims: [1, 5, n], data: data.subarray(0, 5 * n) }, ['plane'], .3, new Set(['aircraft']), true);
  assert.deepEqual(plain(axis), plain(decoded), 'axis-aligned custom outputs match zero-angle OBB outputs');
});
function detector() {
  let disposed = 0, reads = 0, selectedReads = 0; const inputBuffers = [];
  const { engine } = setup({ ort: { Tensor: class { constructor(type, data, dims) { this.data = data; this.dims = dims; inputBuffers.push(data); } dispose() { disposed++; } } } });
  const data = new Float32Array([8, 16, 8, 16, 4, 4, 4, 4, .9, .8, 0, 0]);
  const model = { imgsz: 32, names: ['plane'], key: 'custom-test', provider: 'fixture', session: { inputNames: ['images'], outputNames: ['output'], async run() {
    const output = { dims: [1, 6, 2], get data() { selectedReads++; return data; }, dispose() { disposed++; } };
    return { output, alias: output, unused: { get data() { throw Error('Unused output readback'); }, dispose() { disposed++; } } };
  } } };
  const raster = { w: 48, h: 32, rings: [[[0, 0], [48, 0], [48, 32], [0, 32], [0, 0]]],
    canvas: { getContext: () => ({ getImageData() { reads++; return { data: new Uint8ClampedArray(32 * 32 * 4).fill(255) }; } }) } };
  return { engine, model, raster, state: () => ({ disposed, reads, selectedReads, inputBuffers }) };
}
test('inference profiling preserves custom-model outputs/input reuse and does not read unused tensor data', async () => {
  const f = detector(), profile = {}, baseline = await f.engine.detect(f.raster, f.model, { nmsMode: 'scan' });
  const result = await f.engine.detect(f.raster, f.model, { profile }); assert.deepEqual(plain(result), plain(baseline));
  assert.equal(profile.status, 'complete'); assert.equal(profile.windows, 17); assert.equal(profile.inferredWindows, 17);
  assert.equal(profile.logicalInputBytes, profile.inputBufferBytes * 17); assert.equal(profile.tensorsDisposed, 17 * 3);
  assert.equal(profile.selectedOutputBytes, 2 * 6 * 4 * 17); assert.equal(f.state().selectedReads, 34);
  assert.ok(f.state().inputBuffers.slice(17).every(buffer => buffer === f.state().inputBuffers[17]));
  for (const key of ['modelCallMs', 'rasterReadMs', 'normalizeMs', 'decodeMs', 'chipNmsMs', 'globalNmsMs', 'disposeMs']) assert.ok(profile[key] >= 0);
  assert.equal(f.engine.inference.diagnostics().active, 0); assert.equal(f.engine.allocations.diagnostics().reservedBytes, 0); idle(f.engine);
});
test('filtering wanted classes happens after inference; transparent windows skip the model without changing suppression', async () => {
  const f = detector(), profile = {};
  assert.equal((await f.engine.detect(f.raster, f.model, { classes: ['ship'], profile })).length, 0);
  assert.equal(profile.inferredWindows, 17); assert.equal(profile.decodedCandidates, 0);
  const transparent = { ...f.raster, canvas: { getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(4096) }) }) } }, blank = {};
  assert.equal((await f.engine.detect(transparent, f.model, { profile: blank })).length, 0); assert.equal(blank.inferredWindows, 0); assert.equal(blank.skippedWindows, 17); idle(f.engine);
});
