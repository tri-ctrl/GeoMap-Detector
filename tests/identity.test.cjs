const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
const { setup, aoi, turn } = require('./helpers/app.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const indexedDB = new IDBFactory(), context = vm.createContext({ indexedDB, Blob, structuredClone, crypto: globalThis.crypto, TextEncoder,
    DOMException, AbortController, performance, setInterval: () => 0, clearInterval() {} });
  for (const name of ['engine', 'storage']) vm.runInContext(fs.readFileSync(require.resolve('../frontend/' + name + '.js'), 'utf8'), context);
  return { identity: context.GVEngine.identity, engine: context.GVEngine, repo: context.GVStorage.create(), storage: context.GVStorage };
}
const feature = (id = 'old_0000', status = 'predicted') => ({ ...copy(aoi), id,
  properties: { class: 'aircraft', status, release: 101, aoi_id: 'Review', unknown: { preserved: true } } });
test('UUID fallback retains the canonical version-4 format without randomUUID support', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(require.resolve('../frontend/storage.js'), 'utf8'), context);
  const ids = Array.from({ length: 100 }, () => context.GVStorage.uuid());
  assert.equal(new Set(ids).size, 100); assert.ok(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
});
async function seed(f, review = feature('legacy-rank-id', 'verified')) {
  await f.repo.open();
  await f.repo.migrate({ aois: [copy(aoi)], annotations: { type: 'FeatureCollection', features: [review] } });
  const managed = (await f.repo.restore()).aois[0], props = { gmd_clip_id: 'clip', gmd_job_id: 'job', gmd_aoi_id: managed._gmd_id, gmd_model_id: 'model' };
  const prediction = feature(); prediction.properties = { ...prediction.properties, ...props };
  await f.identity.predictions([prediction], props);
  const job = { id: 'job', status: 'done', createdAt: 1, results: [], params: {}, aois: [managed] };
  const result = { storeId: 'clip', aoi_id: 'Review', aoiFeature: managed, release: 101, identity: props,
    fc: { type: 'FeatureCollection', features: [prediction], properties: props }, blobs: {} };
  await f.repo.saveClip(job, result);
  return { job, result, prediction, review };
}
test('AOI content dedup ignores managed aliases and property order but preserves external IDs and distinct shapes', async () => {
  const f = fixture(), first = copy(aoi), same = { geometry: copy(aoi.geometry), properties: copy(aoi.properties), type: 'Feature', _gmd_id: 'different', _gmd_aliases: ['previous'] };
  assert.equal(f.engine.uniqueAois([first, same]).length, 1);
  const changed = copy(aoi); changed.geometry.coordinates[0][0][0] += .001; changed.id = 'business-id';
  first._gmd_id = changed._gmd_id = 'colliding-managed-id';
  await f.repo.open(); await f.repo.saveAois([first, changed]);
  const saved = (await f.repo.restore()).aois;
  assert.equal(saved.length, 2); assert.notEqual(saved[0]._gmd_id, saved[1]._gmd_id); assert.equal(saved[1].id, 'business-id');
  const id = saved[0]._gmd_id; saved[0].properties.name = 'Renamed'; await f.repo.saveAois(saved);
  assert.equal((await f.repo.restore()).aois[0]._gmd_id, id); await f.repo.close();
});
test('expanded point imports preserve source IDs and unknown top-level metadata while assigning distinct managed IDs', async () => {
  const app = await setup({ aois: [] }), input = { type: 'Feature', id: 'business-multipoint', unknown: { source: 'preserved' }, properties: { name: 'Ports' }, geometry: { type: 'MultiPoint', coordinates: [[55, 25], [56, 26]] } };
  app.element('#fileIn').onchange({ target: { files: [{ name: 'points.geojson', text: async () => JSON.stringify(input) }] } });
  for (let i = 0; i < 50 && Number(app.element('#runN').textContent) !== 2; i++) await turn();
  const saved = JSON.parse(app.saved.get('gv_aois')); assert.equal(saved.length, 2);
  assert.equal(saved[0].id, input.id); assert.equal(saved[1].id, input.id); assert.deepEqual(saved[0].unknown, input.unknown);
  assert.ok(saved[0]._gmd_id); assert.notEqual(saved[0]._gmd_id, saved[1]._gmd_id);
});
test('clip identity includes the complete job, AOI, release and model provenance', async () => {
  const { identity: i } = fixture(), base = ['job', 'aoi', 101, 'model'];
  const id = await i.clipId(...base); assert.match(id, /^gmd:c1:[a-f0-9]{64}$/);
  assert.equal(await i.clipId(...base), id);
  for (let n = 0; n < base.length; n++) { const other = [...base]; other[n] += '-different'; assert.notEqual(await i.clipId(...other), id); }
});
test('cancellation while deriving clip IDs cannot publish a partial plan or retain the execution slot', async () => {
  let resolve, entered = false;
  const gate = new Promise(ok => { resolve = ok; });
  const app = await setup({ selected: true, beforeBoot: context => { context.GVEngine.identity.clipId = async () => { entered = true; return gate; }; } });
  const running = app.element('#runBtn').onclick();
  for (let i = 0; i < 100 && !entered; i++) await turn(); assert.ok(entered);
  app.element('#cancelBtn').onclick(); resolve('uncommitted-clip');
  const job = await running; assert.equal(job.status, 'cancelled'); assert.equal(job.plan, undefined); assert.equal(job.results.length, 0);
  assert.equal(app.context.GVProcessing.diagnostics().active, 0);
});
test('actual ONNX bytes identify the model independently of its filename and provider', async () => {
  let released = 0;
  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, AbortController, DOMException, performance,
    ort: { env: { wasm: {} }, InferenceSession: { create: async () => ({ release: async () => { released++; } }) } } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/engine.js'), 'utf8'), context);
  const first = new Uint8Array([1, 2, 3]), other = new Uint8Array([1, 2, 4]), engine = context.GVEngine;
  const a = await engine.models.acquire({ key: 'same-name', buffer: first, names: ['plane'] });
  assert.equal(a.model.fingerprint, 'sha256:' + createHash('sha256').update(first).digest('hex'));
  await a.release();
  const b = await engine.models.acquire({ key: 'same-name', buffer: other, names: ['plane'] });
  assert.notEqual(b.model.fingerprint, a.model.fingerprint); await b.release(); assert.equal(released, 2);
});
test('prediction identity survives sorting, confidence changes and ring rotation; different runs and duplicates stay distinct', async () => {
  const { identity: i } = fixture(), props = { gmd_clip_id: 'clip-a' }, first = feature(), second = feature('old_0001');
  second.geometry.coordinates[0][0][0] += .01;
  const original = copy([first, second]); await i.predictions([first, second], props);
  const reordered = copy(original).reverse(); reordered.forEach(f => { f.properties.confidence = .5; }); await i.predictions(reordered, props);
  assert.equal(first.id, reordered[1].id); assert.equal(second.id, reordered[0].id);
  const rotated = copy(original[0]), ring = rotated.geometry.coordinates[0].slice(0, -1); ring.push(ring.shift()); ring.push(ring[0]); rotated.geometry.coordinates[0] = ring.reverse();
  await i.predictions([rotated], props); assert.equal(rotated.id, first.id);
  const repeated = copy(original); await i.predictions(repeated, { gmd_clip_id: 'clip-b' }); assert.notEqual(repeated[0].id, first.id);
  const duplicates = [copy(original[0]), copy(original[0])]; await i.predictions(duplicates, props); assert.notEqual(duplicates[0].id, duplicates[1].id);
  assert.deepEqual(first.geometry, original[0].geometry); assert.deepEqual(copy(first.properties.gmd_legacy_ids), ['old_0000']);
});
test('review merge requires the exact scope, including manual objects and reused legacy IDs', () => {
  const { identity: i } = fixture(), fc = { features: [feature('rank')] };
  const annotations = { features: [feature('rank', 'rejected'), { ...feature('manual', 'manual'), properties: { ...feature().properties, status: 'manual', gmd_clip_id: 'other' } }] };
  i.mergeReviews(fc, annotations, 'current'); assert.equal(fc.features[0].properties.status, 'predicted'); assert.equal(fc.features.length, 1);
  annotations.features[0].properties.gmd_clip_id = 'current'; i.mergeReviews(fc, annotations, 'current'); assert.equal(fc.features[0].properties.status, 'rejected');
});
test('explicit legacy resolution is idempotent, verified and additive; raw predictions and source reviews survive reload', async () => {
  const f = fixture(), data = await seed(f), raw = JSON.stringify(data.result.fc);
  const resolved = await f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id);
  assert.equal(resolved.features[0].properties.status, 'verified'); assert.equal(resolved.features[0].id, data.prediction.id);
  assert.equal(JSON.stringify((await f.repo.clip('clip', { images: false })).fc), raw);
  assert.deepEqual(copy((await f.repo.legacyReviews({ includeResolved: true }))[0].feature), data.review);
  await f.repo.close(); await f.repo.open(); await f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id);
  assert.equal((await f.repo.legacyReviews()).length, 0); assert.equal((await f.repo.reviews()).features.length, 1);
  const journal = (await f.repo.legacyReviews({ includeResolved: true }))[0].resolution; assert.ok(journal.verifiedAt);
  await f.repo.deleteJob('job'); assert.equal((await f.repo.legacyReviews({ includeResolved: true })).length, 1);
  assert.equal((await f.repo.reviews()).features.length, 1); await f.repo.close();
});
test('ambiguous shapes, edited legacy geometry and known foreign provenance cannot be linked', async () => {
  for (const change of [r => { r.properties.release = 100; }, r => { r.properties.gmd_job_id = 'other'; },
    r => { r.properties.status = 'predicted'; },
    r => { r.properties.gmd_model_id = 'other'; }, r => { r.properties.model_key = 'other'; },
    r => { r.geometry.coordinates[0][0][0] += .01; }]) {
    const review = feature('rank', 'corrected'); change(review); const f = fixture(), data = await seed(f, review);
    await assert.rejects(f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id));
    assert.equal((await f.repo.legacyReviews()).length, 1); assert.equal(await f.repo.draft('clip'), undefined); await f.repo.close();
  }
  const f = fixture(), data = await seed(f);
  assert.throws(() => f.identity.resolveReview(data.review, data.prediction, { release: 101, aoiLegacyId: 'Review' }, [data.prediction, copy(data.prediction)]), /unique original shape/);
  data.result.fc.features.push(copy(data.prediction)); await assert.rejects(f.repo.saveClip(data.job, data.result), { name: 'IdentityError' });
  assert.equal((await f.repo.clip('clip', { images: false })).fc.features.length, 1); await f.repo.close();
});
test('link transaction interruption rolls back completely and read-back interruption resumes the same journal', async () => {
  for (const duringVerification of [false, true]) {
    const f = fixture(), data = await seed(f), original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'meta' && value.id.startsWith('identity:legacy:') && Boolean(value.verifiedAt) === duringVerification) throw new DOMException('Interrupted link', 'AbortError');
      return original.call(this, value, ...args);
    };
    try { await assert.rejects(f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id), { name: 'AbortError' }); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.equal((await f.repo.legacyReviews()).length, 1);
    if (!duringVerification) assert.equal(await f.repo.draft('clip'), undefined);
    await f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id);
    assert.equal((await f.repo.reviews()).features.length, 1); await f.repo.close();
  }
});
test('legacy pages are bounded and a read-only tab cannot commit a link', async () => {
  const f = fixture(), data = await seed(f), reader = f.storage.create(); await reader.open();
  await assert.rejects(reader.resolveLegacy('legacy:0', 'clip', data.prediction.id), { name: 'ReadOnlyError' }); await reader.close();
  assert.equal((await f.repo.legacyReviews()).length, 1); await f.repo.close();
  const g = fixture(); await g.repo.open(); await g.repo.migrate({ aois: [], annotations: { type: 'FeatureCollection', features: Array.from({ length: 205 }, () => feature()) } });
  const first = await g.repo.legacyReviews(), second = await g.repo.legacyReviews({ after: first.at(-1).id });
  assert.equal(first.length, 100); assert.equal(second.length, 100); assert.equal(new Set([...first, ...second].map(r => r.id)).size, 200); await g.repo.close();
});
test('cancelling before commit rolls back the link and removes its transaction abort listener', async () => {
  const f = fixture(), data = await seed(f), controller = new AbortController();
  const original = IDBObjectStore.prototype.put, add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  let added = 0, removed = 0;
  controller.signal.addEventListener = (...args) => { added++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === 'meta' && value.id.startsWith('identity:legacy:')) queueMicrotask(() => controller.abort());
    return original.call(this, value, ...args);
  };
  try { await assert.rejects(f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id, { signal: controller.signal }), { name: 'AbortError' }); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.equal(added, removed); assert.equal((await f.repo.legacyReviews()).length, 1);
  assert.equal(await f.repo.draft('clip'), undefined);
  await f.repo.resolveLegacy('legacy:0', 'clip', data.prediction.id); assert.equal((await f.repo.legacyReviews()).length, 0); await f.repo.close();
});
test('legacy review panel links a selected saved prediction without fitting the map; closing releases retained rows', async t => {
  let repository;
  const review = feature('old-review', 'verified'); review.properties.class = 'ship';
  const app = await setup({ indexedDB: new IDBFactory(), beforeBoot: context => {
    context.localStorage.setItem('gv_ann', JSON.stringify({ type: 'FeatureCollection', features: [review] }));
    const create = context.GVStorage.create; context.GVStorage.create = options => (repository = create(options));
  } }); t.after(() => repository.close());
  await app.openClip(); app.groups[2].getLayers()[0].fire('click'); const fits = app.snapshot().fits;
  await app.element('#legacyLoad').onclick(); assert.equal(app.context.GVApp.diagnostics().identity.legacyRows, 1);
  await app.element('#legacyLink').onclick();
  assert.match(app.element('#legacyStatus').textContent, /Linked and saved/); assert.equal(app.groups[2].getLayers()[0].feature.properties.class, 'ship');
  assert.equal(app.snapshot().fits, fits); assert.equal((await repository.legacyReviews()).length, 0);
  app.element('#legacyPanel').open = false; app.element('#legacyPanel').ontoggle();
  assert.equal(app.context.GVApp.diagnostics().identity.legacyRows, 0); assert.equal(app.context.GVEngine.operations.diagnostics().pendingReads, 0);
  assert.equal(app.context.GVApp.diagnostics().memory.protected.legacyReviews, undefined);
});
test('session-only and optional-server review reads cannot attach an unscoped rank-based review to a new job', async () => {
  for (const server of [false, true]) {
    const app = await setup({ server, beforeBoot: context => context.localStorage.setItem('gv_ann', JSON.stringify({ type: 'FeatureCollection', features: [feature('detection-101', 'rejected')] })) });
    await app.openClip(); assert.equal(app.groups[2].getLayers()[0].feature.properties.status, 'predicted'); await turn();
  }
});
test('durable optional-server history restores only reviews bearing that exact server clip scope', async t => {
  for (const foreign of [false, true]) {
    let repository;
    const review = feature('detection-101', 'rejected'); review.properties.gmd_clip_id = foreign ? 'other-server-job' : 'server:server_job:Review/2026-10-29';
    const app = await setup({ server: true, indexedDB: new IDBFactory(), fetchHook: url => url.endsWith('/api/annotations') ? { ok: true, json: async () => ({ type: 'FeatureCollection', features: [review] }) } : null,
      beforeBoot: context => { const create = context.GVStorage.create; context.GVStorage.create = options => (repository = create(options)); } });
    t.after(() => repository.close()); await app.openClip();
    assert.equal(app.groups[2].getLayers()[0].feature.properties.status, foreign ? 'predicted' : 'rejected');
  }
});
test('an invalid legacy link leaves the workspace writable and a late closed-panel read retains no rows', async t => {
  let repository, resolve;
  const review = feature('wrong-date', 'verified'); review.properties.release = 100;
  const app = await setup({ indexedDB: new IDBFactory(), beforeBoot: context => {
    context.localStorage.setItem('gv_ann', JSON.stringify({ type: 'FeatureCollection', features: [review] }));
    const create = context.GVStorage.create; context.GVStorage.create = options => (repository = create(options));
  } }); t.after(() => repository.close());
  await app.openClip(); app.groups[2].getLayers()[0].fire('click'); await app.element('#legacyLoad').onclick(); await app.element('#legacyLink').onclick();
  assert.match(app.element('#legacyStatus').textContent, /imagery releases/);
  assert.match(app.element('#storageStatus').textContent, /^Saved/);
  repository.legacyReviews = () => new Promise(ok => { resolve = ok; });
  const pending = app.element('#legacyLoad').onclick();
  app.element('#legacyPanel').open = false; app.element('#legacyPanel').ontoggle();
  resolve([{ id: 'late', feature: review }]); await pending;
  assert.equal(app.context.GVApp.diagnostics().identity.legacyRows, 0);
  assert.equal(app.context.GVEngine.operations.diagnostics().pendingReads, 0);
});
