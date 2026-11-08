const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { setup, aoi, turn } = require('./helpers/app.cjs');
async function until(check) { for (let i = 0; i < 2000; i++) { if (check()) return; await turn(); } assert.fail('Application state did not settle'); }
const manifest = ['alpha', 'beta'].map(key => ({ file: key + '.onnx', label: key, names: ['plane'], imgsz: 1024 }));
async function appFixture({ indexedDB = new IDBFactory(), savedMap, beforeBoot, selected = false } = {}) {
  let repo;
  const app = await setup({ indexedDB, savedMap, selected,
    fetchHook: url => url.endsWith('models/models.json') ? { ok: true, json: async () => manifest } : null,
    beforeBoot: context => {
      const create = context.GVStorage.create; context.GVStorage.create = options => { repo = create(options); return repo; };
      context.GVEngine.loadModel = async spec => ({ key: spec.key, provider: 'wasm', imgsz: 1024, names: spec.names });
      beforeBoot?.(context, () => repo);
    } });
  await until(() => app.element('#model').options.length >= 2);
  return { app, repo, indexedDB };
}
test('full app reload restores AOIs, clips, drafts and saved reviews; opening reads only its clip and raw predictions stay unchanged', async t => {
  let f = await appFixture(); t.after(() => f.repo.close());
  const originalLegacy = f.app.saved.get('gv_aois');
  const job = await f.app.element('#runBtn').onclick(); assert.equal(job.status, 'done');
  assert.equal(job.results[0].fc, undefined); assert.equal(job.results[0].blobs, undefined);
  await f.app.openClip(); f.app.groups[2].getLayers()[0].fire('click'); f.app.element('#bAcc').onclick();
  await f.app.element('#saveAnn').onclick(); await until(() => f.app.element('#storageStatus').textContent.startsWith('Saved'));
  const key = job.results[0].storeId;
  assert.equal((await f.repo.clip(key)).fc.features[0].properties.status, 'predicted');
  assert.equal((await f.repo.clip(key)).draftFC.features[0].properties.status, 'verified');
  assert.equal(f.app.saved.get('gv_aois'), originalLegacy, 'Legacy backup is not rewritten');
  const idb = f.indexedDB, savedMap = f.app.saved; await f.repo.close(); f = await appFixture({ indexedDB: idb, savedMap });
  assert.equal(f.app.element('#runN').textContent, 1); assert.equal(f.repo.state().reads.artifacts, undefined);
  await f.app.openClip(); assert.equal(f.repo.state().reads.artifacts, 1);
  assert.equal(f.app.groups[2].getLayers()[0].feature.properties.status, 'verified');
  // An unsaved-to-training correction must survive, and win over older reviews.
  f.app.groups[2].getLayers()[0].fire('click'); f.app.element('#bRej').onclick();
  await until(() => f.app.element('#storageStatus').textContent.startsWith('Saved'));
  await f.app.openClip(); assert.equal(f.app.groups[2].getLayers()[0].feature.properties.status, 'rejected');
});
test('interrupted job and queued successor restore paused; Resume skips committed clips and preserves FIFO/model settings', async t => {
  let started = 0, f = await appFixture({ selected: true, beforeBoot: context => {
    const process = context.GVEngine.processClip;
    context.GVEngine.processClip = async (feature, release, options) => {
      if (++started === 2) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Page closed', 'AbortError')), { once: true }));
      return process(feature, release, options);
    };
  } });
  t.after(() => f.repo.close());
  f.app.element('#detectOn').checked = true;
  const running = f.app.element('#runBtn').onclick(); await until(() => started === 2);
  f.app.element('#model').value = 'url:beta.onnx'; f.app.element('#model').onchange();
  f.app.context.document.querySelectorAll('[name=relMode]').find(radio => radio.value === 'latest').checked = true;
  f.app.element('#runBtn').onclick(); await until(() => f.app.element('#queueStatus').textContent.includes('1/10 queued'));
  await until(() => f.app.element('#storageStatus').textContent.startsWith('Saved'));
  f.app.events.get('pagehide')(); await running; await until(() => !f.repo.state().available);
  const idb = f.indexedDB, savedMap = f.app.saved, processed = [];
  f = await appFixture({ indexedDB: idb, savedMap, beforeBoot: context => {
    const process = context.GVEngine.processClip;
    context.GVEngine.processClip = async (a, r, options) => { processed.push([r.release, options.model.key]); return process(a, r, options); };
  } });
  assert.equal(processed.length, 0); assert.match(f.app.element('#queueStatus').textContent, /2\/10 queued · paused/);
  f.app.element('#resumeQueue').onclick(); await until(() => /Idle · 0\/10 queued$/.test(f.app.element('#queueStatus').textContent));
  const saved = await f.repo.restore(); assert.deepEqual(processed, [[100, 'url:alpha.onnx'], [101, 'url:beta.onnx']]);
  assert.deepEqual(Array.from(saved.jobs, job => job.status), ['done', 'done']); assert.equal(saved.jobs[0].results.length, 2);
});
test('quota failure retains unsaved output, pauses queue, and Retry saving permits resume without recomputing the committed clip', async t => {
  let fail = true, calls = 0;
  const f = await appFixture({ beforeBoot: (context, repository) => {
    const create = context.GVStorage.create;
    context.GVStorage.create = options => {
      const db = create(options), save = db.saveClip;
      db.saveClip = async (...args) => { if (fail) throw new DOMException('Injected quota full', 'QuotaExceededError'); return save(...args); }; return db;
    };
    const process = context.GVEngine.processClip; context.GVEngine.processClip = (...args) => { calls++; return process(...args); };
  } }); t.after(() => f.repo.close());
  const job = await f.app.element('#runBtn').onclick(); assert.equal(job.status, 'interrupted');
  assert.ok(job.results[0].blobs.png); assert.match(f.app.element('#storageStatus').textContent, /Not saved/); assert.equal((await f.repo.restore()).jobs[0].results.length, 0);
  fail = false; await f.app.element('#storageRetry').onclick(); assert.equal(job.results[0].blobs, undefined);
  f.app.element('#resumeQueue').onclick(); await until(() => job.status === 'done');
  assert.equal(calls, 1); assert.equal((await f.repo.restore()).jobs[0].results.length, 1);
});
test('second tab is read only and cannot submit or change durable AOIs', async t => {
  const a = await appFixture(), b = await appFixture({ indexedDB: a.indexedDB, savedMap: a.app.saved });
  t.after(async () => { await b.repo.close(); await a.repo.close(); });
  assert.match(b.app.element('#storageStatus').textContent, /Read only/); assert.equal(b.app.element('#runBtn').disabled, true);
  await b.app.element('#runBtn').onclick(); b.app.element('#clearAoi').onclick();
  assert.equal((await a.repo.restore()).aois.length, 1); assert.equal((await a.repo.restore()).jobs.length, 0);
});
test('custom weights and captured names survive an interrupted model load and reload without re-upload', async t => {
  let loading = false, f = await appFixture({ beforeBoot: context => {
    context.localStorage.setItem('gv_dsClasses', JSON.stringify(['plane']));
    context.GVEngine.loadModel = async spec => { loading = true; await new Promise((resolve, reject) => spec.signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true })); };
  } }); t.after(() => f.repo.close());
  await f.app.element('#onnxIn').onchange({ target: { value: '', files: [{ name: 'custom.onnx', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }] } });
  f.app.element('#detectOn').checked = true; const first = f.app.element('#runBtn').onclick(); await until(() => loading);
  f.app.events.get('pagehide')(); await first; await until(() => !f.repo.state().available);
  const indexedDB = f.indexedDB, savedMap = f.app.saved, loads = [];
  f = await appFixture({ indexedDB, savedMap, beforeBoot: context => { context.GVEngine.loadModel = async spec => {
    loads.push({ bytes: Array.from(spec.buffer), names: Array.from(spec.names) }); return { provider: 'wasm', imgsz: 1024, names: spec.names };
  } } });
  f.app.element('#resumeQueue').onclick(); await until(() => loads.length === 1 && f.app.element('#queueStatus').textContent === 'Idle · 0/10 queued');
  assert.deepEqual(loads, [{ bytes: [1, 2, 3], names: ['plane'] }]);
});
test('saving after deleting the final reviewed object clears only that clip from the saved training set', async t => {
  const f = await appFixture(); t.after(() => f.repo.close()); await f.app.element('#runBtn').onclick();
  await f.app.openClip(); f.app.groups[2].getLayers()[0].fire('click'); f.app.element('#bAcc').onclick(); await f.app.element('#saveAnn').onclick();
  f.app.element('#bDel').onclick(); await f.app.element('#saveAnn').onclick();
  assert.equal((await f.repo.reviews()).features.length, 0);
  assert.equal((await f.repo.restore()).jobs[0].results[0].total, 1, 'Original prediction summary is immutable');
});
test('page-show recovery waits for active cleanup and shares one shutdown before reacquiring database ownership', async t => {
  let cleanup, started = false;
  const f = await appFixture({ beforeBoot: context => { context.GVEngine.processClip = async (a, r, options) => {
    started = true;
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { cleanup = () => reject(new DOMException('Suspended', 'AbortError')); }, { once: true }));
  }; } }); t.after(() => f.repo.close());
  const job = f.app.element('#runBtn').onclick(); await until(() => started);
  f.app.events.get('pagehide')(); const shown = f.app.events.get('pageshow')({ persisted: true });
  assert.equal(f.app.element('#runBtn').disabled, true); cleanup(); await job; await shown;
  assert.equal(f.repo.state().writable, true); assert.match(f.app.element('#queueStatus').textContent, /paused/);
  assert.doesNotMatch(f.app.element('#storageStatus').textContent, /Not saved|Read only/);
});
test('deleting an old job under quota frees its artifacts, replays another job safely and keeps saved reviews', async t => {
  let full = false;
  const f = await appFixture({ beforeBoot: context => {
    context.confirm = () => true;
    const create = context.GVStorage.create;
    context.GVStorage.create = options => {
      const db = create(options), save = db.saveClip, remove = db.deleteJob;
      db.saveClip = (...args) => full ? Promise.reject(new DOMException('Quota exhausted', 'QuotaExceededError')) : save(...args);
      db.deleteJob = async id => { await remove(id); full = false; }; return db;
    };
  } }); t.after(() => f.repo.close());
  const first = await f.app.element('#runBtn').onclick(); await f.app.openClip();
  f.app.groups[2].getLayers()[0].fire('click'); f.app.element('#bAcc').onclick(); await f.app.element('#saveAnn').onclick();
  full = true; const second = await f.app.element('#runBtn').onclick(); assert.equal(second.status, 'interrupted');
  f.app.element('#jobSel').value = first.id; f.app.element('#jobSel').onchange(); await f.app.element('#deleteJob').onclick();
  const saved = await f.repo.restore(); assert.equal(saved.jobs.length, 1); assert.equal(saved.jobs[0].id, second.id); assert.equal(saved.jobs[0].results.length, 1);
  assert.equal((await f.repo.reviews()).features.length, 1); assert.equal(await f.repo.draft(first.results[0].storeId), undefined);
  assert.equal(second.results[0].persisted, true); assert.doesNotMatch(f.app.element('#storageStatus').textContent, /Not saved/);
});
test('session-only edits remain exportable and warn on closing even after another clip is opened', async () => {
  const app = await setup({ selected: true }), job = await app.element('#runBtn').onclick();
  await app.openClip(0); app.groups[2].getLayers()[0].fire('click'); app.element('#bAcc').onclick(); await app.openClip(1);
  assert.equal(job.results[0].draftFC.features[0].properties.status, 'verified');
  let warned = false; app.events.get('beforeunload')({ preventDefault() { warned = true; } }); assert.equal(warned, true);
});
