const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { setup, aoi, turn } = require('./helpers/app.cjs');
const context = vm.createContext({ DOMException });
vm.runInContext(fs.readFileSync(require.resolve('../frontend/comparison.js'), 'utf8'), context);
const C = context.GVCompare;
const row = (date, createdAt, extra = {}) => ({ key: date + createdAt, geometry: 'aoi', date, createdAt, job: 'job', params: {}, model: 'Nano', ...extra });
test('creation sorting uses clip time, legacy run time and explicit server time; unknown dates stay last without mutating data', () => {
  assert.equal(C.creationTime({ createdAt: 300 }, { createdAt: 200 }), 300);
  assert.equal(C.creationTime({}, { createdAt: 200 }), 200);
  assert.equal(C.creationTime({ created_at: '2026-11-11T12:00:00Z' }), Date.parse('2026-11-11T12:00:00Z'));
  assert.equal(C.creationTime({}, { started: 200 }), 200000);
  assert.equal(C.creationTime({ createdAt: 1e25 }, { createdAt: 200 }), 200);
  assert.equal(C.creationTime({}, { updatedAt: 500 }), null);
  const rows = [row('2026-01-01', 100), row('2020-01-01', 300), row('2026-11-01', null), row('2025-01-01', 200)];
  assert.deepEqual(Array.from(C.newestFirst(rows), r => r.createdAt), [300, 200, 100, null]);
  assert.equal(rows[0].createdAt, 100);
});
test('timeline validates AOI geometry and real dates; orders imagery chronologically with separate same-date runs', () => {
  const rows = [row('2026-10-29', 300), row('2025-03-27', 200), row('2025-03-27', 100)];
  assert.deepEqual(Array.from(C.validateTimeline(rows).frames, r => r.createdAt), [100, 200, 300]);
  for (const invalid of [[], [rows[0]], [rows[0], row('2025-03-27', 1, { geometry: 'other' })], [rows[0], row('2026-02-30', 1)], [rows[0], row('2026-10-29', 1)]]) assert.ok(C.validateTimeline(invalid).error);
  assert.match(C.timelineNote([rows[0], { ...rows[1], model: 'Small', missing: 1, params: { conf: 0.8 } }]), /models.*confidence.*missing imagery tiles.*not verified changes/);
});
test('playback preferences validate effects and bounded durations without accepting corrupt saved values', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(C.playbackSettings({effect:'wipe',duration:'900',interval:'4000'}))),{effect:'wipe',duration:900,interval:4000});
  for(const value of [null,{}, {effect:'move objects',duration:100000,interval:-1}]) assert.deepEqual(JSON.parse(JSON.stringify(C.playbackSettings(value))),{effect:'fade',duration:450,interval:2000});
});
const releases = [{ release: 101, date: '2026-10-29' }, { release: 100, date: '2025-03-27' }, { release: 99, date: '2016-04-20' }];
async function fixture({ preview, aois = [aoi], indexedDB, savedMap } = {}) {
  const views = [], processed = [], reads = [];
  let repo;
  savedMap ||= new Map([['gv_aois', JSON.stringify(aois)], ['gv_relMode', JSON.stringify('selected')], ['gv_selRel', JSON.stringify([101, 100, 99])]]);
  const app = await setup({ aois, indexedDB, savedMap, getReleases: async () => releases, beforeBoot: ctx => {
    const create = ctx.GVStorage.create;
    ctx.GVStorage.create = options => { repo = create(options); const clip = repo.clip; repo.clip = (...args) => { reads.push(args); return clip(...args); }; return repo; };
    const process = ctx.GVEngine.processClip;
    ctx.GVEngine.processClip = async (...args) => { const result = await process(...args); processed.push(result); return result; };
    ctx.GVCompare.preview = preview || (async () => ({ blob: new Blob(['preview']), size: [100, 100] }));
    ctx.GVCompare.Timeline = ctx.GVCompare.Swipe = class {
      constructor() { views.push(this); this.frames = []; }
      async showFrame(asset) { this.frames.push(asset); this.active = true; }
      async show(sides) { this.sides = sides; this.active = true; }
      stop() { this.active = false; }
      destroy() { this.stop(); this.destroyed = true; }
    };
  } });
  return { app, views, processed, reads, repo };
}
const boxes = app => app.element('#resTable tbody').querySelectorAll('[data-compare-row]');
async function enter(app) { app.element('#resultView').value = 'timeline'; app.element('#resultView').onchange(); await turn(); }
function pick(app, index, checked = true) { const box = boxes(app)[index]; box.checked = checked; box.onchange(); }
async function start(f) { await f.app.element('#runBtn').onclick(); await enter(f.app); pick(f.app, 0); f.app.element('#timelineSelectAOI').onclick(); await f.app.element('#timelineOpen').onclick(); }
async function fireTimer(app, ms) { const entry = [...app.timers].find(([, timer]) => timer.ms === ms); assert.ok(entry, 'Owned timer exists: ' + ms); app.timers.delete(entry[0]); await entry[1].callback(); await turn(); }
test('many results open oldest first, keep viewport during steps, use immutable predictions and restore editing on exit', async () => {
  const f = await fixture(), { app } = f;
  await app.element('#runBtn').onclick(); await app.openClip(0);
  const selected = app.groups[2].getLayers()[0]; selected.fire('click'); app.element('#bAcc').onclick(); await app.element('#bEdit').onclick();
  const position = [...app.map.position], zoom = app.map.zoom;
  await enter(app); assert.equal(app.element('#timelineControls').hidden, false); assert.equal(app.element('#compareKindRow').hidden, true);
  assert.equal(app.element('#timelinePlayer').hidden,false);assert.equal(app.element('.mapwrap').classList.contains('timeline-open'),true);
  pick(app, 0); app.element('#timelineSelectAOI').onclick();
  assert.equal(boxes(app).filter(box => box.checked).length, 3); assert.equal(app.element('#timelineOpen').disabled, false);
  await app.element('#timelineOpen').onclick(); assert.equal(app.context.GVApp.diagnostics().timeline.index, 0);
  assert.match(app.element('#timelineCurrent').textContent, /2016-04-20.*1 objects/);
  const fits = app.snapshot().fits; app.map.setView([25.26, 55.37], 20);
  await app.element('#timelineNext').onclick(); await app.element('#timelineNext').onclick();
  assert.equal(app.snapshot().fits, fits); assert.equal(app.map.zoom, 20);
  assert.deepEqual(app.map.position, [25.26, 55.37]);
  assert.equal(f.views[0].frames.at(-1).fc.features[0].properties.status, 'predicted');
  assert.equal(f.processed[0].draftFC.features[0].properties.status, 'verified');
  assert.equal(app.context.GVApp.diagnostics().comparisonRowPayloads, 0);
  app.element('#compareExit').onclick(); assert.equal(selected.editing.active, true);
  assert.equal(app.element('#timelinePlayer').hidden,true);assert.equal(app.element('.mapwrap').classList.contains('timeline-open'),false);
  assert.deepEqual(app.map.position, position); assert.equal(app.map.zoom, zoom); assert.equal(f.views[0].active, false);
});
test('map playback settings persist valid preferences and close cleanly without changing the selected history', async () => {
  const f=await fixture(),{app}=f;await start(f);
  app.element('#timelinePlay').onclick();app.element('#timelineSettingsToggle').onclick();
  assert.equal(app.element('#timelineSettings').hidden,false);assert.equal(app.context.GVApp.diagnostics().timeline.playing,false);
  app.element('#timelineEffect').value='wipe';app.element('#timelineEffect').onchange();
  app.element('#timelineDuration').value='900';app.element('#timelineDuration').onchange();
  app.element('#timelineSpeed').value='4000';app.element('#timelineSpeed').onchange();
  assert.deepEqual(JSON.parse(app.saved.get('gv_timelinePlayback')),{effect:'wipe',duration:900,interval:4000});
  app.element('#timelineSettingsClose').onclick();assert.equal(app.element('#timelineSettings').hidden,true);
  assert.equal(app.context.GVApp.diagnostics().timeline.frames,3);assert.equal(app.context.GVApp.diagnostics().timeline.index,0);
  app.element('#compareExit').onclick();assert.equal(app.context.GVApp.diagnostics().timelineEffects.sampleAnimations,0);
});
test('a timeline selection is restricted to one geometry; clear releases the selection', async () => {
  const other = structuredClone(aoi); other.properties.name = 'Other'; other.geometry.coordinates[0].forEach(point => { point[0] += 0.001; });
  const f = await fixture({ aois: [aoi, other] }); await f.app.element('#runBtn').onclick(); await enter(f.app);
  pick(f.app, 0); assert.equal(boxes(f.app).filter(box => box.disabled).length, 3);
  f.app.element('#timelineSelectAOI').onclick(); assert.equal(boxes(f.app).filter(box => box.checked).length, 3);
  f.app.element('#compareClear').onclick(); assert.equal(boxes(f.app).filter(box => box.disabled).length, 0);
  assert.equal(f.app.element('#timelineOpen').disabled, true);
});
test('playback advances sequentially, stops at the newest frame, supports replay and pauses when hidden', async () => {
  const f = await fixture(), { app } = f; await start(f);
  app.element('#timelineSpeed').value = '1000'; app.element('#timelinePlay').onclick();
  await fireTimer(app, 1000); await turn(); assert.equal(app.context.GVApp.diagnostics().timeline.index, 1);
  await fireTimer(app, 1000); await turn();
  assert.equal(app.context.GVApp.diagnostics().timeline.index, 2); assert.equal(app.context.GVApp.diagnostics().timeline.playing, false);
  await app.element('#timelinePlay').onclick(); assert.equal(app.context.GVApp.diagnostics().timeline.index, 0);
  app.context.document.hidden = true; app.documentEvents.get('visibilitychange')();
  assert.equal(app.context.GVApp.diagnostics().timeline.timer, false);
  assert.equal(app.context.GVApp.diagnostics().timeline.playing, false); app.element('#compareExit').onclick();
});
test('rapid slider seeks coalesce and frame preparation drains before replacement; exit rejects late images', async () => {
  let release, calls = 0, active = 0, peak = 0, gate = false;
  const f = await fixture({ preview: async () => { calls++; peak = Math.max(peak, ++active); if (gate) await new Promise(resolve => { release = resolve; }); active--; return { blob: new Blob(['preview']), size: [100, 100] }; } });
  await start(f); gate = true;
  const pending = f.app.element('#timelineNext').onclick(); await turn();
  for (const index of [0, 1, 2]) { f.app.element('#timelineSlider').value = index; f.app.element('#timelineSlider').oninput(); }
  await fireTimer(f.app, 80); assert.equal(calls, 2);
  gate = false; release(); await pending; await turn(); await turn();
  assert.equal(calls, 3); assert.equal(peak, 1); assert.equal(f.app.context.GVApp.diagnostics().timeline.index, 2);
  gate = true; const late = f.app.element('#timelinePrev').onclick(); await turn(); f.app.element('#compareExit').onclick();
  release(); await late; assert.equal(f.views[0].active, false); assert.equal(f.app.context.GVApp.diagnostics().timeline.frames, 0);
});
test('seeking during initial loading fits only the first frame that actually becomes visible', async () => {
  let release, calls = 0;
  const f = await fixture({ preview: async () => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return { blob: new Blob(['preview']), size: [100, 100] }; } });
  await f.app.element('#runBtn').onclick(); await enter(f.app); pick(f.app, 0); f.app.element('#timelineSelectAOI').onclick();
  const fits = f.app.snapshot().fits, opening = f.app.element('#timelineOpen').onclick(); await turn();
  f.app.element('#timelineSlider').value = 2; f.app.element('#timelineSlider').oninput(); await fireTimer(f.app, 80);
  release(); await opening; await turn(); await turn();
  assert.equal(f.app.context.GVApp.diagnostics().timeline.index, 2); assert.equal(f.app.snapshot().fits, fits + 1);
  assert.equal(f.views[0].frames.length, 1); f.app.element('#compareExit').onclick();
});
test('failed frame pauses without replacing a good frame; retry and page-hide cleanup remain available', async () => {
  let fail = false;
  const f = await fixture({ preview: async () => { if (fail) throw Error('Unavailable artifact'); return { blob: new Blob(['preview']), size: [100, 100] }; } });
  await start(f); fail = true; await f.app.element('#timelineNext').onclick();
  assert.match(f.app.element('#compareHint').textContent, /Unavailable artifact.*retry/); assert.equal(f.app.context.GVApp.diagnostics().timeline.index, 0);
  fail = false; await f.app.element('#timelineNext').onclick(); assert.equal(f.app.context.GVApp.diagnostics().timeline.index, 1);
  f.app.element('#timelinePlay').onclick(); f.app.events.get('pagehide')(); await turn();
  assert.equal(f.views[0].destroyed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.app.context.GVApp.diagnostics().timeline)), { frames: 0, index: -1, playing: false, loading: false, timer: false, seek: false });
});
test('a timed-out native read drains before retry and cannot render its late result', async () => {
  let release, block = false;
  const f = await fixture({ preview: async () => { if (block) await new Promise(resolve => { release = resolve; }); return { blob: new Blob(['preview']), size: [100, 100] }; } });
  await start(f); block = true;
  const pending = f.app.element('#timelineNext').onclick(); await turn();
  await fireTimer(f.app, 45000); release(); await pending;
  assert.equal(f.views[0].frames.length, 1); assert.equal(f.app.context.GVApp.diagnostics().timeline.loading, false);
  // A custom decoder can resolve after cancellation; the owner still rejects it.
  assert.match(f.app.element('#compareHint').textContent, /timed out.*retry/);
  block = false; await f.app.element('#timelineNext').onclick(); assert.equal(f.views[0].frames.length, 2);
  f.app.element('#compareExit').onclick();
});
test('switching timeline and swipe modes preserves the original annotation editor and clears playback', async () => {
  const f = await fixture(), { app } = f; await app.element('#runBtn').onclick(); await app.openClip(0);
  const layer = app.groups[2].getLayers()[0]; layer.fire('click'); await app.element('#bEdit').onclick();
  await enter(app); pick(app, 0); app.element('#timelineSelectAOI').onclick(); await app.element('#timelineOpen').onclick(); app.element('#timelinePlay').onclick();
  app.element('#resultView').value = 'compare'; app.element('#resultView').onchange(); await turn();
  assert.equal(app.context.GVApp.diagnostics().timeline.timer, false); assert.equal(app.element('#timelineControls').hidden, true);
  pick(app, 0); pick(app, 1); await turn(); app.element('#compareExit').onclick();
  assert.equal(layer.editing.active, true); assert.equal(f.views[0].active, false);
});
test('saved clip creation dates survive reload and catalogs read no artifacts until a timeline frame is selected', async t => {
  const { IDBFactory } = require('fake-indexeddb'), indexedDB = new IDBFactory();
  let f = await fixture({ indexedDB }); t.after(() => f.repo.close());
  const job = await f.app.element('#runBtn').onclick(); const created = Array.from(job.results, r => r.createdAt);
  assert.ok(created.every(Number.isFinite)); const savedMap = f.app.saved; await f.repo.close();
  f = await fixture({ indexedDB, savedMap }); await enter(f.app);
  assert.equal(f.reads.length, 0); assert.equal(f.repo.state().reads.artifacts, undefined);
  pick(f.app, 0); f.app.element('#timelineSelectAOI').onclick(); await f.app.element('#timelineOpen').onclick();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0][1].draft, false);
  const restored = await f.repo.restore(); assert.deepEqual(Array.from(restored.jobs[0].results, r => r.createdAt), created);
  f.app.element('#compareExit').onclick();
});
