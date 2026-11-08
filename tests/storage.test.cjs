const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
const source = fs.readFileSync(require.resolve('../frontend/storage.js'), 'utf8');
const { aoi } = require('./helpers/app.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
function factory(indexedDB = new IDBFactory(), clock = () => Date.now()) {
  class Clock extends Date { static now() { return clock(); } }
  const context = vm.createContext({ indexedDB, Blob, structuredClone, crypto: globalThis.crypto, Date: Clock,
    setInterval: () => 0, clearInterval() {}, performance });
  vm.runInContext(source, context);
  return { indexedDB, create: options => context.GVStorage.create(options) };
}
const empty = () => ({ aois: [plain(aoi)], annotations: { type: 'FeatureCollection', features: [] } });
function fixture() {
  const job = { id: 'job-a', createdAt: 100, status: 'running', progress: 0.5, params: { model_key: 'model-a' },
    aois: [plain(aoi)], outcomes: [{ status: 'completed', clipId: 'clip-a' }], results: [], log: ['Saved first clip'],
    plan: [{ aoiIndex: 0, release: { release: 101, date: '2026-10-29' }, clipId: 'clip-a' }],
    modelSpec: { key: 'custom-a', names: ['plane'], buffer: new Uint8Array([1, 2, 3]) }, controller: new AbortController(), finished: Promise.resolve() };
  const feature = { ...plain(aoi), id: 'external-id', properties: { status: 'predicted', class: 'aircraft', confidence: '0.91', unknown: { kept: true } } };
  const result = { storeId: 'clip-a', order: 0, aoi: 'Review', aoi_id: 'Review', aoiFeature: job.aois[0], date: '2026-10-29', release: 101,
    bounds: [55, 25, 56, 26], size: [100, 50], total: 1, counts: { aircraft: 1 },
    fc: { type: 'FeatureCollection', features: [feature] },
    blobs: { png: new Blob(['native-png']), tif: new Blob(['native-tiff']), preview: new Blob(['preview']), pgw: '0.5\n0\n0\n-0.5\n1\n2' } };
  return { job, result };
}
test('legacy migration is idempotent, preserves external IDs/unknown properties and keeps duplicate review IDs', async () => {
  const f = factory(), repo = f.create(); await repo.open();
  const { result } = fixture(), legacy = empty(); legacy.annotations.features = [result.fc.features[0], plain(result.fc.features[0])];
  await repo.migrate(legacy); const first = await repo.restore();
  assert.ok(first.aois[0]._gmd_id); assert.equal((await repo.reviews()).features.length, 2);
  await repo.migrate(legacy); const second = await repo.restore();
  assert.deepEqual(plain(second.aois), plain(first.aois));
  assert.deepEqual(plain((await repo.reviews()).features), legacy.annotations.features);
  await repo.saveAois([]); await repo.migrate(legacy); assert.equal((await repo.restore()).aois.length, 0, 'Deletion must not reimport the legacy backup');
  await repo.close();
});
test('malformed migration does not mark an empty import complete or modify originals', async () => {
  const repo = factory().create(); await repo.open(); const legacy = empty(); legacy.annotations.features.push(null);
  await assert.rejects(repo.migrate(legacy), { name: 'MigrationError' });
  assert.equal((await repo.restore()).aois.length, 0); assert.equal(legacy.aois[0]._gmd_id, undefined);
  await repo.migrate(empty()); assert.equal((await repo.restore()).aois.length, 1); await repo.close();
});
test('interrupted legacy import rolls back its marker and records, leaving the original available for retry', async () => {
  const repo = factory().create(); await repo.open(); const legacy = empty(); legacy.annotations.features.push(fixture().result.fc.features[0]);
  const before = JSON.stringify(legacy), put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'reviews') throw new DOMException('Interrupted migration', 'AbortError'); return put.apply(this, args); };
  try { await assert.rejects(repo.migrate(legacy), { name: 'AbortError' }); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await repo.migrated(), false); assert.equal((await repo.restore()).aois.length, 0); assert.equal(JSON.stringify(legacy), before);
  await repo.migrate(legacy); assert.equal(await repo.migrated(), true); assert.equal((await repo.reviews()).features.length, 1); await repo.close();
});
test('interruption between import and read-back verification recovers the same IDs and records on retry', async () => {
  const f = factory(); let repo = f.create(); await repo.open(); const legacy = empty(), put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'meta' && args[0].id === 'legacy-v1' && args[0].verifiedAt) throw new DOMException('Interrupted verification', 'AbortError'); return put.apply(this, args); };
  try { await assert.rejects(repo.migrate(legacy), { name: 'AbortError' }); } finally { IDBObjectStore.prototype.put = put; }
  const id = (await repo.restore()).aois[0]._gmd_id; assert.equal(await repo.migrated(), false); await repo.close();
  repo = f.create(); await repo.open(); await repo.migrate(legacy);
  assert.equal(await repo.migrated(), true); assert.equal((await repo.restore()).aois[0]._gmd_id, id); await repo.close();
});
test('clip transaction restores native artifacts and immutable predictions without hydrating them in the catalog', async () => {
  const f = factory(); let repo = f.create(); await repo.open(); await repo.migrate(empty());
  const { job, result } = fixture(); await repo.saveJob(job); await repo.saveClip(job, result);
  const edited = plain(result.fc); edited.features[0].properties.class = 'ship';
  await repo.saveDraft(result.storeId, job.id, edited); await repo.saveReviews(result.storeId, job.id, 'aoi-a', edited.features);
  await repo.saveModel({ key: 'custom-a', label: 'User model', custom: true, buffer: new Uint8Array([1, 2, 3]), names: ['plane'] });
  await repo.close(); repo = f.create(); await repo.open();
  const saved = await repo.restore({ recover: true }); assert.equal(saved.jobs[0].status, 'interrupted'); assert.deepEqual(Array.from(saved.queue), ['job-a']);
  assert.equal(saved.jobs[0].controller, undefined); assert.equal(saved.jobs[0].modelSpec.buffer, undefined);
  assert.equal(saved.jobs[0].results[0].fc, undefined); assert.equal(saved.jobs[0].results[0].blobs, undefined);
  assert.equal(repo.state().reads.artifacts, undefined, 'Startup must not query artifact payloads');
  const clip = await repo.clip('clip-a'); assert.equal(await clip.blobs.png.text(), 'native-png'); assert.equal(await clip.blobs.tif.text(), 'native-tiff');
  assert.equal(clip.blobs.pgw, result.blobs.pgw); assert.equal(clip.fc.features[0].properties.class, 'aircraft');
  assert.equal(clip.draftFC.features[0].properties.class, 'ship'); assert.equal(clip.fc.features[0].id, 'external-id');
  assert.deepEqual(Array.from((await repo.model('custom-a')).buffer), [1, 2, 3]);
  const reads = repo.state().reads.artifacts; await repo.clip('clip-a', { images: false }); assert.equal(repo.state().reads.artifacts, reads);
  await repo.close();
});
test('aborted artifact writes roll back predictions and the completed outcome; retry commits once', async () => {
  const repo = factory().create(); await repo.open(); const { job, result } = fixture();
  const pending = plain({ ...job, finished: null, controller: null }); pending.outcomes[0].status = 'pending'; await repo.saveJob(pending);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'artifacts') throw new DOMException('Injected quota exhaustion', 'QuotaExceededError'); return original.apply(this, args); };
  try { await assert.rejects(repo.saveClip(job, result), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = original; }
  const saved = await repo.restore(); assert.equal(saved.jobs[0].results.length, 0); assert.equal(saved.jobs[0].outcomes[0].status, 'pending');
  await assert.rejects(repo.clip('clip-a'));
  await repo.saveClip(job, result); await repo.saveClip(job, result);
  assert.equal((await repo.restore()).jobs[0].results.length, 1); await repo.close();
});
test('reviews are scoped to model runs; replacing a review snapshot removes deleted objects without changing other scopes', async () => {
  const repo = factory().create(); await repo.open(); const { result } = fixture();
  await repo.saveReviews('clip-a', 'job-a', 'aoi-a', result.fc.features); await repo.saveReviews('clip-b', 'job-b', 'aoi-a', result.fc.features);
  assert.equal((await repo.reviews()).features.length, 2);
  await repo.saveReviews('clip-a', 'job-a', 'aoi-a', []);
  assert.equal((await repo.reviews('clip-a')).features.length, 0); assert.equal((await repo.reviews('clip-b')).features.length, 1); await repo.close();
});
test('job deletion removes owned artifacts/drafts/queue but keeps saved reviews, custom sources and archived AOIs', async () => {
  const repo = factory().create(); await repo.open(); await repo.migrate(empty()); const { job, result } = fixture();
  await repo.saveClip(job, result); await repo.saveDraft('clip-a', 'job-a', result.fc); await repo.saveReviews('clip-a', 'job-a', 'aoi-a', result.fc.features);
  await repo.saveModel({ key: 'custom-a', custom: true, buffer: new Uint8Array([7]) });
  await repo.saveAois([]); await repo.deleteJob('job-a'); const saved = await repo.restore();
  assert.equal(saved.jobs.length, 0); assert.equal(saved.queue.length, 0); assert.equal(saved.aois.length, 0);
  assert.equal(await repo.draft('clip-a'), undefined); await assert.rejects(repo.clip('clip-a'));
  assert.equal((await repo.reviews()).features.length, 1); assert.equal((await repo.model('custom-a')).buffer[0], 7); await repo.close();
});
test('two tabs cannot write together; expired owners are fenced out even after a takeover', async () => {
  let now = 1000; const f = factory(undefined, () => now), a = f.create(), b = f.create();
  await a.open(); assert.equal((await b.open()).writable, false);
  await assert.rejects(b.saveAois([]), { name: 'ReadOnlyError' }); await b.close();
  now += 31000; const c = f.create(); assert.equal((await c.open()).writable, true);
  await assert.rejects(a.saveAois([]), { name: 'ReadOnlyError' }); await c.saveAois([plain(aoi)]);
  await a.close(); assert.equal((await c.restore()).aois.length, 1); await c.close();
});
test('storage unavailable is explicit; newer schemas are preserved rather than deleted', async () => {
  assert.equal((await factory().create({ indexedDB: null }).open()).available, false);
  const f = factory(); await new Promise((resolve, reject) => { const r = f.indexedDB.open('geomap-detector', 3); r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
  await assert.rejects(f.create().open(), { name: 'VersionError' });
  const r = f.indexedDB.open('geomap-detector'); await new Promise(resolve => { r.onsuccess = resolve; }); assert.equal(r.result.version, 3); r.result.close();
});
