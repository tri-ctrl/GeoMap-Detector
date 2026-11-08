const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { setup, turn, aoi } = require('./helpers/app.cjs');
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const fc = (release, status = 'predicted') => ({ type: 'FeatureCollection', features: [{ ...JSON.parse(JSON.stringify(aoi)), id: 'detection-' + release, properties: { class: 'aircraft', status, confidence: 0.9, release, aoi_id: 'Review' } }] });
const row = (release, date) => ({ aoi: 'Review', aoi_id: 'Review', release, date, path: 'Review/' + date, bounds: [55.36, 25.25, 55.37, 25.26], zoom: 18, total: 1, counts: { aircraft: 1 } });
const rows = [row(101, '2026-10-29'), row(100, '2026-10-22')];
const response = value => ({ ok: true, json: async () => value });
async function until(check) { for (let i = 0; i < 2000; i++) { if (check()) return; await turn(); } assert.fail('View state did not settle'); }
async function serverApp(hook, beforeBoot) {
  const app = await setup({ server: true, selected: true, beforeBoot,
    fetchHook: async (url, options) => await hook?.(url, options) || (url.endsWith('/api/jobs/server_job') ? response({ status: 'done', progress: 1, log: [], results: rows }) : null) });
  await app.element('#runBtn').onclick(); await until(() => app.element('#resTable tbody').querySelectorAll('tr[data-i]').length === 2); return app;
}
const diag = app => app.context.GVApp.diagnostics();
test('twenty clip switches and hide/show cycles release obsolete image leases once, after removing their layers', async () => {
  const app = await setup({ selected: true }); await app.element('#runBtn').onclick();
  assert.equal(diag(app).rowPayloads, 0, 'The result table must not copy job-owned payloads');
  for (let i = 0; i < 20; i++) {
    await app.openClip(i % 2); const layer = app.groups[1].getLayers()[0], previousURL = layer.url;
    app.toggle(false); assert.equal(diag(app).views.imageLeases, 0); assert.equal(app.groups[1].getLayers().length, 0);
    assert.deepEqual(Object.keys(layer.handlers), []);
    app.toggle(true); assert.notEqual(app.groups[1].getLayers()[0].url, previousURL);
    assert.equal(diag(app).views.imageLeases, 1); assert.equal(diag(app).views.active, 1);
    assert.equal(diag(app).views.created - diag(app).views.disposed, 1);
    assert.ok(diag(app).rowPayloads <= 1, 'Only the active view may attach a display payload to its row');
  }
  app.toggle(false); const created = app.urlEvents.filter(e => e.type === 'create'), revoked = app.urlEvents.filter(e => e.type === 'revoke');
  assert.equal(created.length, revoked.length); assert.equal(new Set(revoked.map(e => e.url)).size, revoked.length);
  assert.ok(revoked.every(e => e.attached === false));
});
test('replacement commits edited geometry, clears obsolete selection/handlers, and preserves the original predictions', async () => {
  const app = await setup({ selected: true }), job = await app.element('#runBtn').onclick(); await app.openClip(0);
  const old = app.groups[2].getLayers()[0]; old.fire('click'); app.element('#selClass').onchange({ target: { value: 'ship' } }); await app.element('#bEdit').onclick();
  const geometry = JSON.parse(JSON.stringify(old.feature.geometry)); geometry.coordinates[0][0][0] += 0.001;
  old.toGeoJSON = () => ({ ...old.feature, geometry });
  await app.openClip(1); assert.equal(old.editing.active, false); assert.deepEqual(Object.keys(old.handlers), []);
  assert.equal(diag(app).views.selected, false); assert.equal(diag(app).views.editing, false); assert.doesNotMatch(app.element('#selCard').innerHTML, /bAcc|bEdit/);
  old.fire('click'); assert.equal(diag(app).views.selected, false);
  await app.openClip(0); const restored = app.groups[2].getLayers()[0]; assert.notEqual(restored, old);
  assert.equal(restored.feature.properties.class, 'ship'); assert.deepEqual(JSON.parse(JSON.stringify(restored.feature.geometry)), geometry);
  assert.equal(job.results[0].fc.features[0].properties.class, 'aircraft');
});
test('reordered server detections abort the previous view and only the newest response can render', async () => {
  const old = deferred(); let signal;
  const app = await serverApp((url, options) => {
    if (url.endsWith('2026-10-29/detections.geojson')) { signal = options.signal; return { ok: true, json: () => old.promise }; }
    if (url.endsWith('2026-10-22/detections.geojson')) return response(fc(100));
  });
  const first = app.openClip(0); await until(() => signal); await app.openClip(1); await first;
  assert.equal(signal.aborted, true); const before = app.snapshot(); old.resolve(fc(101, 'rejected')); await turn();
  assert.equal(app.groups[2].getLayers()[0].feature.properties.release, 100); assert.match(app.groups[1].getLayers()[0].url, /2026-10-22/);
  assert.match(app.element('#annCtx').innerHTML, /2026-10-22/); assert.deepEqual(app.snapshot(), before);
});
test('a late non-cancellable IndexedDB review read cannot mutate an old job draft or overwrite the current clip', async t => {
  const gate = deferred(); let repository, waiting = false;
  const app = await setup({ selected: true, indexedDB: new IDBFactory(), beforeBoot: context => {
    const create = context.GVStorage.create; context.GVStorage.create = options => {
      const db = repository = create(options), reviews = db.reviews;
      db.reviews = scope => scope?.endsWith(':clip:0') ? (waiting = true, gate.promise) : reviews(scope); return db;
    };
  } }); t.after(() => repository.close());
  const job = await app.element('#runBtn').onclick(); assert.equal(job?.status, 'done', job?.log?.join('\n') || app.element('#storageStatus').textContent);
  const first = app.openClip(0); await until(() => waiting);
  await app.openClip(1); await first; gate.resolve(fc(101, 'rejected')); await turn();
  assert.equal(job.results[0].draftFC, undefined); assert.equal((await repository.clip(job.results[0].storeId)).fc.features[0].properties.status, 'predicted');
  assert.equal(app.groups[2].getLayers()[0].feature.properties.release, 100); assert.equal(diag(app).views.active, 1);
});
test('server drafts survive switching clips in session mode without modifying fetched predictions', async () => {
  const raw = fc(101), before = JSON.stringify(raw);
  const app = await serverApp(url => url.endsWith('2026-10-29/detections.geojson') ? response(raw) : url.endsWith('2026-10-22/detections.geojson') ? response(fc(100)) : null);
  await app.openClip(0); app.groups[2].getLayers()[0].fire('click'); app.element('#bRej').onclick();
  await app.openClip(1); await app.openClip(0);
  assert.equal(app.groups[2].getLayers()[0].feature.properties.status, 'rejected'); assert.equal(JSON.stringify(raw), before);
  let warning = false; app.events.get('beforeunload')({ preventDefault() { warning = true; } }); assert.equal(warning, true);
});
test('failed and malformed clip responses clear old details and remain retryable without unhandled errors', async () => {
  let fail = true;
  const app = await serverApp(url => url.endsWith('2026-10-29/detections.geojson') ? response(fc(101))
    : url.endsWith('2026-10-22/detections.geojson') ? fail ? { ok: false, status: 503 } : response(fc(100)) : null);
  await app.openClip(0); app.groups[2].getLayers()[0].fire('click'); await app.openClip(1);
  assert.equal(app.groups[1].getLayers().length, 0); assert.equal(app.groups[2].getLayers().length, 0); assert.equal(diag(app).views.selected, false);
  assert.match(app.element('#annCtx').textContent, /HTTP 503/); fail = false; await app.openClip(1); assert.equal(app.groups[2].getLayers().length, 1);
  const malformed = await serverApp(url => url.endsWith('/detections.geojson') ? response({ type: 'FeatureCollection', features: [null] }) : null);
  await malformed.openClip(0); assert.match(malformed.element('#annCtx').textContent, /invalid detection data/); assert.equal(malformed.groups[1].getLayers().length, 0);
});
test('clip deadline aborts a stalled read, releases its timer, and rejects late completion before a retry', async () => {
  const gate = deferred(); let signal, stalled = true;
  const app = await serverApp((url, options) => {
    if (url.endsWith('/detections.geojson')) { signal = options.signal; return stalled ? { ok: true, json: () => gate.promise } : response(fc(101)); }
  });
  const pending = app.openClip(0); await until(() => signal);
  const [id, timer] = [...app.timers].find(([, timer]) => timer.ms === 30000); app.timers.delete(id); timer.callback(); await pending;
  assert.equal(signal.aborted, true); assert.match(app.element('#annCtx').textContent, /timed out/);
  gate.resolve(fc(101)); await turn(); assert.equal(app.groups[2].getLayers().length, 0);
  assert.equal([...app.timers.values()].filter(t => t.ms === 30000).length, 0); stalled = false; await app.openClip(0); assert.equal(app.groups[2].getLayers().length, 1);
});
test('page hide invalidates pending reads; late completion after page-show cannot create a view', async () => {
  const gate = deferred(); let started = false;
  const app = await serverApp(url => url.endsWith('/detections.geojson') ? (started = true, { ok: true, json: () => gate.promise }) : null);
  const pending = app.openClip(0); await until(() => started); app.events.get('pagehide')(); await pending;
  await app.events.get('pageshow')({ persisted: true }); gate.resolve(fc(101)); await turn();
  assert.equal(diag(app).views.active, 0); assert.equal(app.groups[2].getLayers().length, 0); assert.equal(app.groups[1].getLayers().length, 0);
});
test('page hide disposes ready editing handles and page-show restores the draft without fitting or replacing the basemap', async () => {
  const app = await setup(); await app.openClip(); const old = app.groups[2].getLayers()[0]; old.fire('click'); app.element('#bRej').onclick(); await app.element('#bEdit').onclick();
  app.map.position = [24, 54]; app.map.zoom = 19; const before = app.snapshot(); app.events.get('pagehide')();
  assert.equal(old.editing.active, false); assert.deepEqual(Object.keys(old.handlers), []); assert.equal(diag(app).views.active, 0);
  await app.events.get('pageshow')({ persisted: true });
  assert.equal(app.snapshot().fits, before.fits); assert.equal(app.tiles.length, 1); assert.deepEqual(app.map.position, [24, 54]);
  assert.equal(app.groups[2].getLayers()[0].feature.properties.status, 'rejected'); assert.equal(diag(app).views.imageLeases, 1);
});
test('late edit/draw library completion cannot attach an editor or drawing tool to a replacement view', async () => {
  const app = await setup({ selected: true }); await app.openClip(0); const old = app.groups[2].getLayers()[0]; old.fire('click');
  const gate = deferred(); let enabled = 0; app.context.GVEngine.ensureLibrary = () => gate.promise;
  app.context.L.Draw.Rectangle = function () { this.enable = () => enabled++; this.disable = () => {}; };
  const editing = app.element('#bEdit').onclick(), drawing = app.element('#annRect').onclick(); await app.openClip(1);
  gate.resolve(); await editing; await drawing; assert.equal(enabled, 0); assert.equal(old.editing.active, false); assert.equal(diag(app).views.editing, false);
});
test('rebuilding detection layers while editing captures geometry and retires old editor/click handles', async () => {
  const app = await setup(); await app.openClip(); const old = app.groups[2].getLayers()[0]; old.fire('click'); await app.element('#bEdit').onclick();
  const geometry = JSON.parse(JSON.stringify(old.feature.geometry)); geometry.coordinates[0][0][0] += 0.001; old.toGeoJSON = () => ({ ...old.feature, geometry });
  app.element('#acceptAll').onclick(); assert.equal(old.editing.active, false); assert.deepEqual(Object.keys(old.handlers), []);
  const replacement = app.groups[2].getLayers()[0]; assert.notEqual(replacement, old); assert.deepEqual(JSON.parse(JSON.stringify(replacement.feature.geometry)), geometry);
});
test('saving an older server clip cannot clear the replacement draft or post the replacement features', async () => {
  const gate = deferred(); let posted;
  const app = await serverApp((url, options) => {
    if (url.endsWith('/api/annotations') && options.method === 'POST') { posted = JSON.parse(options.body); return gate.promise; }
    if (url.endsWith('/detections.geojson')) return response(fc(url.includes('2026-10-22') ? 100 : 101));
  });
  await app.openClip(0); app.groups[2].getLayers()[0].fire('click'); app.element('#bAcc').onclick(); const saved = app.element('#saveAnn').onclick(); await until(() => posted);
  await app.openClip(1); app.groups[2].getLayers()[0].fire('click'); app.element('#bRej').onclick(); gate.resolve({ ok: true }); await saved;
  assert.equal(posted.features[0].properties.release, 101); assert.equal(app.groups[2].getLayers()[0].feature.properties.status, 'rejected');
  let warning = false; app.events.get('beforeunload')({ preventDefault() { warning = true; } }); assert.equal(warning, true);
});
test('download URL leases outlive clip replacement and revoke only after their own delayed cleanup', async () => {
  const app = await setup({ selected: true }); await app.openClip(0); app.element('#expAoi').onclick();
  const download = app.urlEvents.filter(e => e.type === 'create').at(-1).url; await app.openClip(1);
  assert.equal(diag(app).downloadLeases, 1); assert.ok(!app.urlEvents.some(e => e.type === 'revoke' && e.url === download));
  const [id, timer] = [...app.timers].find(([, timer]) => timer.ms === 10000); app.timers.delete(id); timer.callback();
  assert.equal(diag(app).downloadLeases, 0); assert.equal(app.urlEvents.filter(e => e.type === 'revoke' && e.url === download).length, 1);
});
test('reordered result-job responses and detached table rows cannot select a stale clip', async () => {
  const gate = deferred(); let signal;
  const app = await serverApp((url, options) => {
    if (url.endsWith('/api/jobs/older')) { signal = options.signal; return { ok: true, json: () => gate.promise }; }
    if (url.endsWith('/api/jobs/newer')) return response({ params: {}, results: [{ ...rows[1], aoi: 'Newest job' }] });
  });
  const detached = app.element('#resTable tbody').querySelectorAll('tr[data-i]')[0];
  app.element('#jobSel').value = 'older'; const first = app.element('#jobSel').onchange(); await until(() => signal);
  app.element('#jobSel').value = 'newer'; await app.element('#jobSel').onchange();
  gate.resolve({ params: {}, results: [{ ...rows[0], aoi: 'Old job' }] }); await first;
  assert.equal(signal.aborted, true); assert.match(app.element('#resTable tbody').innerHTML, /Newest job/); assert.doesNotMatch(app.element('#resTable tbody').innerHTML, /Old job/);
  const before = app.snapshot(); await detached.onclick(); assert.deepEqual(app.snapshot(), before);
});
test('deleting a job during a delayed persisted-clip read cancels the view and cannot resurrect its image or draft', async t => {
  const gate = deferred(); let repository, waiting = false;
  const app = await setup({ indexedDB: new IDBFactory(), beforeBoot: context => {
    context.confirm = () => true; const create = context.GVStorage.create;
    context.GVStorage.create = options => {
      const db = repository = create(options), clip = db.clip;
      db.clip = async (...args) => { const value = await clip(...args); waiting = true; await gate.promise; return value; }; return db;
    };
  } }); t.after(() => repository.close());
  const job = await app.element('#runBtn').onclick(), opening = app.openClip(0); await until(() => waiting);
  app.element('#jobSel').value = job.id; await app.element('#deleteJob').onclick(); await opening;
  gate.resolve(); await turn(); assert.equal(diag(app).views.active, 0); assert.equal(diag(app).views.imageLeases, 0); assert.equal(app.groups[2].getLayers().length, 0);
  assert.equal((await repository.restore()).jobs.length, 0); assert.equal(await repository.draft(job.results[0].storeId), undefined);
});
test('before-unload captures an in-progress vertex edit at full precision and warns until its draft is safe', async () => {
  const app = await setup(), job = await app.element('#runBtn').onclick(); job.exported = true; await app.openClip();
  const layer = app.groups[2].getLayers()[0]; layer.fire('click'); await app.element('#bEdit').onclick();
  const raw = JSON.stringify(job.results[0].fc), geometry = JSON.parse(JSON.stringify(layer.feature.geometry)); geometry.coordinates[0][0][0] += 0.000000012345;
  let precision; layer.toGeoJSON = value => { precision = value; return { ...layer.feature, geometry }; };
  let warning = false; app.events.get('beforeunload')({ preventDefault() { warning = true; } });
  assert.equal(warning, true); assert.equal(precision, false); assert.equal(layer.editing.active, false);
  assert.equal(JSON.stringify(job.results[0].fc), raw); assert.deepEqual(JSON.parse(JSON.stringify(job.results[0].draftFC.features[0].geometry)), geometry);
});
test('opening and finishing an editor without changing geometry does not mark a prediction corrected', async () => {
  const app = await setup({ selected: true }), job = await app.element('#runBtn').onclick(); await app.openClip();
  const layer = app.groups[2].getLayers()[0]; layer.fire('click'); await app.element('#bEdit').onclick(); await app.openClip(1);
  assert.equal(job.results[0].draftFC.features[0].properties.status, 'predicted');
});
