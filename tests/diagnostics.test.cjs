const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { stampEngine } = require('../scripts/write_build_info.cjs');
const { setup: appSetup, turn } = require('./helpers/app.cjs');
const source = fs.readFileSync(require.resolve('../frontend/engine.js'), 'utf8');
const revision = 'a'.repeat(40), other = 'b'.repeat(40), plain = value => JSON.parse(JSON.stringify(value));
function setup(extra = {}, stamped = false) {
  const context = vm.createContext({ performance, crypto: webcrypto, setTimeout, clearTimeout, AbortController, DOMException, ...extra });
  vm.runInContext(stamped ? stampEngine(source, revision) : source, context); return { engine: context.GVEngine, context };
}
const manifest = (rev = revision) => ({ version: 1, revision: rev, builtAt: '2026-11-21T00:00:00.000Z',
  runtime: { name: 'onnxruntime-web', version: '1.20.1' }, files: { 'engine.js': 'c'.repeat(64) },
  models: [{ file: 'nano.onnx', bytes: 1024, sha256: 'd'.repeat(64), imgsz: 1024, classes: 15 }] });
test('scalar traces preserve monotonic durations, IDs and balanced terminal events across errors and cancellation', async () => {
  const { engine } = setup(); let clock = 10;
  const t = engine.createTelemetry({ clock: () => clock, contextId: 'test', timeOrigin: 1000 });
  const span = t.start('clip', { jobId: 'job', clipId: 'clip' }); clock = 15; span.end(); span.end();
  await assert.rejects(t.run('inference', {}, () => { clock = 17; throw Object.assign(new Error('secret pixels'), { code: 'TEST' }); }), /secret pixels/);
  await assert.rejects(t.run('imagery', {}, () => { clock = 2; throw new DOMException('Cancelled', 'AbortError'); }), { name: 'AbortError' });
  const s = t.snapshot(), ends = s.events.filter(e => e.type === 'end');
  assert.equal(s.active.length, 0); assert.deepEqual(Array.from(ends, e => e.status), ['ok', 'error', 'cancelled']);
  assert.equal(ends[0].durationMs, 5); assert.ok(ends.every(e => e.durationMs >= 0));
  assert.equal(new Set(ends.map(e => e.id)).size, 3); assert.equal(ends[1].errorCode, 'TEST');
  assert.ok(!JSON.stringify(s).includes('secret pixels'));
});
test('event and active limits hold under overflow; clear and toggling cannot strand a live span', () => {
  const { engine } = setup(), t = engine.createTelemetry({ limit: 8, activeLimit: 2 });
  const spans = Array.from({ length: 20 }, () => t.start('clip'));
  assert.equal(t.snapshot().events.length, 8); assert.equal(t.snapshot().active.length, 2); assert.equal(t.snapshot().omittedActive, 18);
  t.clear(); assert.equal(t.snapshot().active.length, 2); t.setEnabled(false);
  assert.equal(t.start('job').id, null); spans.forEach(span => span.end());
  assert.equal(t.snapshot().active.length, 0); assert.equal(t.snapshot().omittedActive, 0); assert.equal(t.snapshot().events.length, 8);
  assert.ok(t.snapshot().events.every(e => e.type === 'end' && Number.isFinite(e.startMs)));
});
test('diagnostics never borrow geometry, image, arbitrary labels or mutable caller records', () => {
  const { engine } = setup(), t = engine.createTelemetry(), tags = { jobId: 'j', modelKey: 'm'.repeat(10000), width: 10 };
  Object.defineProperty(tags, 'geometry', { get() { throw Error('Geometry read'); } });
  Object.defineProperty(tags, 'pixels', { get() { throw Error('Pixels read'); } });
  t.start('clip', tags).end(); tags.width = 20;
  const a = t.snapshot(); a.events[0].width = 99;
  assert.equal(t.snapshot().events[0].width, 10); assert.equal(t.snapshot().events[0].modelKey.length, 160);
  for (let i = 0; i < 1000; i++) t.count('tile.c' + String.fromCharCode(65 + i % 26) + String.fromCharCode(65 + Math.floor(i / 26) % 26), 1);
  assert.equal(Object.keys(t.snapshot().counters).length, 32);
  assert.throws(() => t.start('unbounded user label'), /Unknown diagnostic/);
});
test('worker and backend imports deduplicate by bounded context cursors without mixing clocks or payloads', () => {
  const { engine } = setup(), t = engine.createTelemetry({ limit: 8 }), remote = engine.createTelemetry({ clock: () => 50000, contextId: 'remote', timeOrigin: 123456789 });
  remote.start('clip', { jobId: 'j' }).end(); const batch = remote.snapshot();
  batch.events[0].geometry = { secret: true }; t.ingest(batch); t.ingest(batch);
  assert.equal(t.snapshot().events.length, 2); assert.equal(t.snapshot().events[1].durationMs, 0);
  assert.equal(t.snapshot().events[1].timeOrigin, 123456789); assert.equal(t.snapshot().events[0].geometry, undefined);
  for (let i = 0; i < 25; i++) { const s = engine.createTelemetry({ contextId: 'backend' + i }).snapshot(); s.events = [{ contextId: s.context.id, sequence: 1, type: 'end', name: 'job', atMs: 1, durationMs: 1 }]; t.ingest(s, 'backend'); }
  assert.equal(t.snapshot().importedContexts, 16); assert.equal(t.snapshot().events.length, 8); assert.equal(t.snapshot().events.at(-1).contextKind, 'backend');
});
test('build loading is shared, validates public fields and distinguishes the executing stamp from another artifact', async () => {
  let calls = 0;
  const f = setup({ fetch: async () => { calls++; return new Response(JSON.stringify({ ...manifest(), secret: 'must not retain' })); } }, true);
  await Promise.all([f.engine.build.load(), f.engine.build.load()]);
  assert.equal(calls, 1); assert.equal(f.engine.build.info().status, 'matched');
  assert.equal(f.engine.build.info().executingRevision, revision); assert.ok(!JSON.stringify(f.engine.build.info()).includes('secret'));
  f.context.fetch = async () => new Response(JSON.stringify(manifest(other)));
  await f.engine.build.load({ refresh: true }); assert.equal(f.engine.build.info().status, 'mismatch');
  assert.equal(f.engine.build.info().artifact.revision, other); assert.equal(f.engine.operations.diagnostics().active.length, 0);
});
test('missing/invalid build information remains optional; failed refresh retains the last validated artifact', async () => {
  const f = setup({ fetch: async () => new Response(JSON.stringify(manifest())) }, true);
  await f.engine.build.load();
  for (const response of [new Response('', { status: 404 }), new Response('<html>fallback</html>'), new Response('x'.repeat(131073)), new Response(JSON.stringify({ ...manifest(), runtime: {} }))]) {
    f.context.fetch = async () => response;
    await f.engine.build.load({ refresh: true }); assert.equal(f.engine.build.info().status, 'unavailable');
    assert.equal(f.engine.build.info().artifact.revision, revision);
  }
  assert.equal(f.engine.telemetry.snapshot().active.length, 0); assert.equal(f.engine.operations.diagnostics().active.length, 0);
});
test('page-owned build cancellation rejects late responses and does not release a replacement owner', async () => {
  let resolveOld;
  const f = setup({ fetch: () => new Promise(resolve => { resolveOld = resolve; }) }, true);
  const old = f.engine.build.load(); f.engine.build.cancel();
  f.context.fetch = async () => new Response(JSON.stringify(manifest())); await f.engine.build.load();
  resolveOld(new Response(JSON.stringify(manifest(other)))); await old;
  assert.equal(f.engine.build.info().status, 'matched'); assert.equal(f.engine.build.info().artifact.revision, revision);
  assert.equal(f.engine.telemetry.snapshot().active.length, 0); assert.equal(f.engine.operations.diagnostics().active.length, 0);
});
test('a stalled build request times out as an explicit error and releases its timer and owner', async () => {
  const timers = new Map(); let next = 0;
  const f = setup({ setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: id => timers.delete(id),
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }, true);
  const pending = f.engine.build.load(); [...timers.values()].find(t => t.ms === 5000).fn(); await pending;
  const terminal = f.engine.telemetry.snapshot().events.at(-1);
  assert.equal(terminal.type, 'end'); assert.equal(terminal.status, 'error'); assert.equal(terminal.errorName, 'TimeoutError');
  assert.equal(timers.size, 0); assert.equal(f.engine.operations.diagnostics().active.length, 0);
});
test('GPU fallback reports one download, both session attempts, final provider and actual model fingerprint', async () => {
  let fetches = 0, creates = 0;
  const f = setup({ navigator: { gpu: {} }, fetch: async () => { fetches++; return new Response(new Uint8Array([1, 2, 3])); },
    ort: { InferenceSession: { create: async (_bytes, options) => { creates++; if (options.executionProviders[0] === 'webgpu') throw Error('GPU unavailable'); return { inputMetadata: [], release() {} }; } } } });
  const spec = { key: 'nano', url: '/models/n.onnx', imgsz: 1024, names: ['plane'] }, model = await f.engine.loadModel(spec);
  assert.equal((await f.engine.loadModel(spec)), model); assert.equal(fetches, 1); assert.equal(creates, 2);
  const s = f.engine.telemetry.snapshot(), ends = s.events.filter(e => e.type === 'end');
  assert.equal(s.counters['model.networkBytes'], 3); assert.equal(s.counters['model.cacheHits'], 1);
  assert.deepEqual(Array.from(ends.filter(e => e.name === 'model.session'), e => [e.provider, e.status]), [['webgpu', 'error'], ['wasm', 'ok']]);
  assert.equal(ends.find(e => e.name === 'model.load').provider, 'wasm'); assert.match(model.fingerprint, /^sha256:[a-f0-9]{64}$/);
});
test('Results diagnostics download contains bounded telemetry and resources without AOIs, reviews or logs; hide releases its URL', async () => {
  const f = await appSetup(); f.context.GVEngine.telemetry.start('job', { jobId: 'public-id' }).end();
  const report = f.context.GVApp.diagnosticReport(), body = JSON.stringify(report);
  assert.equal(report.version, 1); assert.ok(report.telemetry.events.length <= report.telemetry.limit);
  assert.ok(!body.includes('coordinates')); assert.ok(!body.includes('FeatureCollection')); assert.ok(!body.includes('Review'));
  f.element('#downloadDiagnostics').click(); const url = f.urlEvents.filter(e => e.type === 'create').at(-1);
  assert.equal(url.blob.type, 'application/json'); assert.equal(JSON.parse(await url.blob.text()).version, 1);
  assert.equal(f.context.GVApp.diagnostics().downloadLeases, 1);
  f.events.get('pagehide')(); await turn(); assert.equal(f.context.GVApp.diagnostics().downloadLeases, 0);
  f.element('#clearDiagnostics').click(); assert.equal(f.context.GVEngine.telemetry.snapshot().events.length, 0);
});
test('build information waits for the first map tile and revalidates when a cached page resumes', async () => {
  const calls = [];
  const f = await appSetup({ beforeBoot: context => { context.GVEngine.build.load = options => { calls.push(options); return Promise.resolve(context.GVEngine.build.info()); }; } });
  assert.equal(calls.length, 0); f.tiles[0].fire('tileload'); await turn();
  assert.equal(calls.length, 1); assert.equal(calls[0].refresh, false);
  f.tiles[0].fire('tileload'); assert.equal(calls.length, 1);
  f.events.get('pagehide')(); await turn(); await f.events.get('pageshow')({ persisted: true }); await turn();
  assert.equal(calls.length, 2); assert.equal(calls[1].refresh, true);
});
