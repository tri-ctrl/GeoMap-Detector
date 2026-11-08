const assert = require('node:assert/strict');
const test = require('node:test');
const { setup, releases, turn } = require('./helpers/app.cjs');
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const buttons = (app, kind) => app.element('#jobQueue').querySelectorAll(`[data-job-${kind}]`);
const button = (app, kind, id) => buttons(app, kind).find(item => item.dataset['job' + kind[0].toUpperCase() + kind.slice(1)] === id);
const ids = app => app.element('#jobQueue').querySelectorAll('[data-queued-job]').map(item => item.dataset.queuedJob);
function model(app, name) { app.element('#model').value = 'url:' + name + '.onnx'; app.element('#model').onchange(); }
function dates(app, mode, selected = []) {
  app.context.document.querySelectorAll('[name=relMode]').find(item => item.value === mode).checked = true;
  for (const box of app.element('#relList').querySelectorAll('[data-c]')) { box.checked = selected.includes(+box.dataset.c); box.onchange(); }
}
async function queueApp({ onModel, onClip, localChanges, getReleases } = {}) {
  const loads = [], clips = [], manifest = ['alpha', 'beta'].map(name => ({ file: name + '.onnx', label: 'Model ' + name, names: ['plane'], imgsz: 1024 }));
  const app = await setup({ localChanges, getReleases, fetchHook: url => url.endsWith('models/models.json') ? { ok: true, json: async () => manifest } : null,
    beforeBoot: context => {
      const original = context.GVEngine.processClip;
      context.GVEngine.loadModel = async spec => {
        loads.push(spec); await onModel?.(spec, loads.length); return { key: spec.key, provider: 'wasm', imgsz: 1024, names: spec.names };
      };
      context.GVEngine.processClip = async (feature, release, options) => {
        clips.push({ feature, release, options }); await onClip?.(feature, release, options, clips.length);
        return { ...await original(feature, release, options), aoi: feature.properties.name };
      };
    } });
  app.element('#detectOn').checked = true; model(app, 'alpha');
  return { app, loads, clips, manifest };
}
test('FIFO jobs load and process one model at a time; settings and metadata are captured before waiting', async () => {
  const gate = deferred(); let catalogue = releases;
  const f = await queueApp({ onModel: async (spec, n) => { if (n === 1) await gate.promise; }, getReleases: async () => catalogue });
  const { app } = f; app.element('#tifOn').checked = false;
  const first = app.element('#runBtn').onclick(); await turn(); const firstId = ids(app)[0];
  model(app, 'beta'); dates(app, 'selected', [100]);
  app.element('#zoom').value = '17'; app.element('#conf').value = '0.6'; app.element('#maxTiles').value = '75'; app.element('#tifOn').checked = true;
  for (const checkbox of app.context.document.querySelectorAll('#classChips input')) { checkbox.checked = checkbox.value === 'ship'; checkbox.onchange(); }
  const second = app.element('#runBtn').onclick(); await turn();
  assert.equal(f.loads.length, 1); assert.equal(f.clips.length, 0); assert.match(app.element('#queueStatus').textContent, /1 running · 1\/10 queued/);
  const secondId = ids(app).find(id => id !== firstId);
  assert.ok(button(app, 'cancel', secondId)); assert.match(app.element('#jobLog').textContent, /Queued: Model beta/);
  // Change every next-run setting again while both captured jobs still wait.
  app.element('#tifOn').checked = false; app.element('#zoom').value = '19'; dates(app, 'latest');
  f.manifest[1].names[0] = 'changed after submission';
  catalogue = [{ release: 102, date: '2026-11-05' }, ...releases]; await app.element('#relRefresh').onclick();
  const polygon = app.groups[0].getLayers()[0].getLayers()[0].feature; polygon.properties.name = 'Renamed later'; polygon.geometry.coordinates[0][0][0] = 54;
  gate.resolve(); const a = await first, b = await second; await turn();
  assert.deepEqual(f.loads.map(spec => spec.key), ['url:alpha.onnx', 'url:beta.onnx']);
  assert.deepEqual(f.clips.map(clip => clip.release.release), [101, 100]);
  assert.deepEqual(f.clips.map(clip => clip.options.model.names[0]), ['plane', 'plane']);
  assert.equal(f.clips[0].options.geotiff, false); assert.equal(f.clips[0].options.zoom, 18);
  assert.equal(f.clips[1].options.geotiff, true); assert.equal(f.clips[1].options.zoom, 17);
  assert.equal(f.clips[1].options.conf, 0.6); assert.equal(f.clips[1].options.maxTiles, 75);
  assert.deepEqual(Array.from(f.clips[1].options.classes), ['ship']);
  assert.deepEqual(f.clips.map(clip => clip.feature.properties.name), ['Review', 'Review']);
  assert.equal(f.clips[1].feature.geometry.coordinates[0][0][0], 55.36);
  assert.equal(a.status, 'done'); assert.equal(b.status, 'done');
  for (const job of [a, b]) { assert.equal(job.controller, null); assert.equal(job.modelSpec, null); assert.equal(job.releaseSource, null); assert.equal(job.fingerprint, null); }
});
test('cancelling a queued job allocates no model or clip and does not cancel the active job', async () => {
  const gate = deferred(), f = await queueApp({ onModel: async (spec, n) => { if (n === 1) await gate.promise; } });
  const first = f.app.element('#runBtn').onclick(); await turn();
  model(f.app, 'beta'); const waiting = f.app.element('#runBtn').onclick(); await turn();
  const queuedId = ids(f.app)[1]; button(f.app, 'cancel', queuedId).onclick();
  const cancelled = await waiting; assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.modelSpec, null); assert.equal(cancelled.releaseSource, null); assert.equal(f.loads.length, 1); assert.equal(f.loads[0].signal.aborted, false);
  gate.resolve(); const done = await first; assert.equal(done.status, 'done'); assert.equal(f.clips.length, 1);
});
test('cancellation holds the execution slot until active processing drains, then starts the next job', async () => {
  const cleanup = deferred(), events = [];
  const f = await queueApp({ onClip: async (feature, release, options, n) => {
    if (n !== 1) { events.push('beta started'); return; }
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', async () => {
      await cleanup.promise; events.push('alpha cleaned'); reject(new DOMException('Cancelled', 'AbortError'));
    }, { once: true }));
  } });
  const first = f.app.element('#runBtn').onclick(); await turn(); const firstId = ids(f.app)[0];
  model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick(); await turn();
  button(f.app, 'cancel', firstId).onclick(); await turn();
  assert.equal(f.loads.length, 1); assert.match(f.app.element('#jobQueue').innerHTML, /cancelling/);
  cleanup.resolve(); assert.equal((await first).status, 'cancelled'); const b = await second;
  assert.deepEqual(events, ['alpha cleaned', 'beta started']); assert.equal(b.status, 'done'); assert.equal(f.loads[1].signal.aborted, false);
});
test('a failed model or unavailable job cannot stop the queue', async () => {
  for (const failure of ['model', 'imagery']) {
    const gate = deferred(), f = await queueApp({
      onModel: async (spec, n) => { if (n === 1) { await gate.promise; if (failure === 'model') throw new Error('Model failed'); } },
      onClip: async (feature, release, options, n) => { if (n === 1 && failure === 'imagery') throw Object.assign(new Error('No imagery'), { code: 'NO_IMAGERY' }); },
    });
    const first = f.app.element('#runBtn').onclick(); await turn(); model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick();
    gate.resolve(); assert.equal((await first).status, 'error'); const b = await second; assert.equal(b.status, 'done'); assert.equal(b.results.length, 1);
  }
});
test('progress selection and cancellation target their job without replacing the next-run model', async () => {
  const gate = deferred(), f = await queueApp({ onClip: async (feature, release, options, n) => { if (n === 1) await gate.promise; } });
  const first = f.app.element('#runBtn').onclick(); await turn(); const firstId = ids(f.app)[0];
  model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick(); await turn();
  f.clips[0].options.onProgress(0.6);
  assert.match(f.app.element('#jobLog').textContent, /Queued: Model beta/); assert.equal(f.app.element('#prog').style.width, '0%');
  button(f.app, 'log', firstId).onclick(); assert.equal(f.app.element('#model').value, 'url:beta.onnx');
  assert.equal(f.app.element('#prog').style.width, '60%'); assert.match(f.app.element('#jobLog').textContent, /Loading model Model alpha/);
  f.app.element('#cancelBtn').onclick(); gate.resolve(); assert.equal((await first).status, 'cancelled'); assert.equal((await second).status, 'done');
});
test('identical active submissions are deduplicated and only ten jobs may wait', async () => {
  const gate = deferred(), f = await queueApp({ onModel: async (spec, n) => { if (n === 1) await gate.promise; } });
  const pending = [f.app.element('#runBtn').onclick()]; await turn();
  await f.app.element('#runBtn').onclick(); assert.equal(ids(f.app).length, 1);
  for (let i = 0; i < 10; i++) { f.app.element('#conf').value = String(0.31 + i / 100); pending.push(f.app.element('#runBtn').onclick()); }
  assert.equal(ids(f.app).length, 11); assert.equal(f.app.element('#runBtn').disabled, true);
  f.app.element('#conf').value = '0.8'; await f.app.element('#runBtn').onclick(); assert.equal(ids(f.app).length, 11); assert.equal(f.loads.length, 1);
  button(f.app, 'cancel', ids(f.app)[1]).onclick(); assert.equal(f.app.element('#runBtn').disabled, false);
  gate.resolve(); const jobs = await Promise.all(pending); assert.equal(jobs.filter(job => job.status === 'done').length, 10);
});
test('local-change planning uses the captured catalogue and the active job signal', async () => {
  const gate = deferred(), lookups = []; let catalogue = releases;
  const f = await queueApp({ getReleases: async () => catalogue, onModel: async (spec, n) => { if (n === 1) await gate.promise; },
    localChanges: async (lon, lat, zoom, options) => { lookups.push(options); return options.releases.slice(0, 1); } });
  dates(f.app, 'local'); const first = f.app.element('#runBtn').onclick(); await turn(); model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick();
  catalogue = [{ release: 102, date: '2026-11-05' }, ...releases]; await f.app.element('#relRefresh').onclick();
  assert.equal(lookups.length, 0); gate.resolve(); await first; await second;
  assert.deepEqual(lookups.map(options => options.releases[0].release), [101, 101]); assert.ok(lookups.every(options => options.signal instanceof AbortSignal));
});
test('finishing queued jobs preserves an open clip, edited geometry and the selected result job', async () => {
  const gate = deferred(), f = await queueApp({ onClip: async (feature, release, options, n) => { if (n === 2) await gate.promise; } });
  const original = await f.app.element('#runBtn').onclick(); await turn(); await f.app.openClip();
  const selected = f.app.groups[2].getLayers()[0]; selected.fire('click'); await f.app.element('#bEdit').onclick();
  f.app.map.position = [24, 54]; const before = f.app.snapshot(), card = f.app.element('#selCard').innerHTML;
  const first = f.app.element('#runBtn').onclick(); await turn(); model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick();
  gate.resolve(); await first; const b = await second; await turn();
  assert.equal(f.app.groups[2].getLayers()[0], selected); assert.equal(selected.editing.active, true);
  assert.deepEqual(f.app.map.position, [24, 54]); assert.equal(f.app.snapshot().fits, before.fits);
  assert.equal(f.app.element('#selCard').innerHTML, card); assert.equal(f.app.element('#jobSel').value, original.id);
  button(f.app, 'results', b.id).onclick(); await turn(); assert.equal(f.app.element('#jobSel').value, b.id);
});
test('job completion does not navigate away after the user changes tabs', async () => {
  const gate = deferred(), f = await queueApp({ onModel: async () => gate.promise });
  const running = f.app.element('#runBtn').onclick();
  f.app.context.document.querySelectorAll('.rail [data-tab]').find(item => item.dataset.tab === 'img').onclick();
  gate.resolve(); await running; assert.equal(f.app.element('#tab-img').classList.contains('on'), true);
});
test('page hide cancels waiting/running jobs and page-show recovery cannot start a cancelled queue entry', async () => {
  const gate = deferred(), f = await queueApp({ onModel: async (spec, n) => { if (n === 1) await gate.promise; } });
  const first = f.app.element('#runBtn').onclick(); await turn(); model(f.app, 'beta'); const second = f.app.element('#runBtn').onclick();
  f.app.events.get('pagehide')(); gate.resolve(); assert.equal((await first).status, 'cancelled'); assert.equal((await second).status, 'cancelled');
  assert.equal(f.loads.length, 1); assert.equal(f.clips.length, 0);
  f.app.events.get('pageshow')({ persisted: true }); await turn(); assert.equal(f.loads.length, 1);
  assert.equal((await f.app.element('#runBtn').onclick()).status, 'done');
});
