const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { setup: appSetup, aoi, turn } = require('./helpers/app.cjs');
const source = fs.readFileSync(path.join(__dirname, '../frontend/engine.js'), 'utf8');
const toLL = (x, y) => [x / (256 * 2 ** 18) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * 2 ** 18)))) * 180 / Math.PI];
const geometry = (width = 400) => {
  const x = 171383 * 256 + 16, y = 112057 * 256 + 16;
  return { type: 'Polygon', coordinates: [[toLL(x, y), toLL(x + width, y), toLL(x + width, y + 128), toLL(x, y + 128), toLL(x, y)]] };
};
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const tilemap = (url, value = 1, maxWidth = Infinity) => {
  const [release, zoom, top, left, width, height] = url.split('/tilemap/')[1].split('/').map(Number);
  const loc = { left, top, width: Math.min(width, maxWidth), height };
  return { location: loc, valid: true, data: Array.from({ length: loc.width * height }, (_, i) => typeof value === 'function' ? value(left + i % loc.width, top + Math.floor(i / loc.width), zoom, release) : value) };
};
function engineSetup({ metadata = url => tilemap(url), image = async () => new Response('image'), decode, draw, encode, cache, fakeTimers = false } = {}) {
  const calls = [], canvases = [], bitmaps = [], timers = new Map();
  const context = vm.createContext({ Blob, AbortController, DOMException, Uint8Array,
    setTimeout: fakeTimers ? (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; } : setTimeout,
    clearTimeout: fakeTimers ? id => timers.delete(id) : clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return url.includes('/tilemap/') ? json(await metadata(url, options)) : image(url, options); },
    createImageBitmap: async blob => {
      if (decode) await decode(blob);
      const bitmap = { closed: 0, close() { this.closed++; } }; bitmaps.push(bitmap); return bitmap;
    },
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
      getContext() { return { drawImage: (...args) => draw?.(...args), beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillRect() {}, stroke() {} }; }
      async convertToBlob() { if (encode) await encode(); return new Blob(['encoded']); }
    },
    ...(cache ? { caches: { open: async () => cache } } : {}),
  });
  vm.runInContext(source, context);
  return { engine: context.GVEngine, context, calls, canvases, bitmaps, timers };
}
const assertFreed = fixture => { assert.ok(fixture.canvases.every(canvas => canvas.width === 1 && canvas.height === 1)); assert.ok(fixture.bitmaps.every(bitmap => bitmap.closed === 1)); };

test('absent coverage over the full processing footprint allocates no canvas and requests no images', async () => {
  const f = engineSetup({ metadata: url => tilemap(url, 0, 1) });
  await assert.rejects(f.engine.buildRaster(geometry(), 388), error => {
    assert.equal(error.code, 'NO_IMAGERY'); assert.equal(error.zoom, 18); assert.equal(error.coverage.unavailable, 2);
    assert.equal(error.coverage.checks, 2); assert.match(error.message, /explicitly lower Imagery zoom/); return true;
  });
  assert.equal(f.canvases.length, 0); assert.equal(f.calls.length, 2);
});
test('clipped tilemap rectangles leave remaining cells unknown until their own validated lookup', async () => {
  const f = engineSetup({ metadata: url => tilemap(url, x => x % 2, 1) });
  const raster = await f.engine.buildRaster(geometry(), 388);
  assert.equal(raster.coverage.status, 'partial'); assert.equal(raster.missing, 1);
  assert.equal(raster.coverage.checks, 2); assert.equal(f.calls.filter(call => !call.url.includes('/tilemap/')).length, 1);
  assert.equal(raster.w, 400); assert.equal(raster.h, 128); assert.equal(raster.zoom, 18);
  assert.ok(f.bitmaps.every(bitmap => bitmap.closed === 1)); raster.canvas.width = raster.canvas.height = 1;
});
test('tilemaps clipped in both dimensions cover the footprint without gaps or double counting', async () => {
  const f = engineSetup({ metadata: url => {
    const value = tilemap(url, 0, 1); value.location.height = 1; value.data = [0]; return value;
  } });
  const value = await f.engine.checkCoverage(388, 18, { left: 10, top: 20, width: 3, height: 3 });
  assert.equal(value.status, 'unavailable'); assert.equal(value.unavailable, 9); assert.equal(value.checks, 9);
});
test('coverage uses effective processing zoom after the existing tile cap selects it', async () => {
  const f = engineSetup({ metadata: url => tilemap(url, 0) });
  await assert.rejects(f.engine.buildRaster(geometry(), 388, 18, { maxTiles: 1 }), error => error.code === 'NO_IMAGERY' && error.zoom < 18);
  assert.ok(f.calls.every(call => !call.url.includes('/388/18/')));
});
test('malformed, invalid and failed tilemaps stay unknown; valid image requests can still succeed', async () => {
  for (const metadata of [() => ({}), url => ({ ...tilemap(url, 0), valid: false }), () => { throw new TypeError('Network blocked'); }]) {
    const f = engineSetup({ metadata });
    const raster = await f.engine.buildRaster(geometry(), 388);
    assert.equal(raster.coverage.status, 'full'); assert.equal(raster.coverage.unknown, 2);
    assert.equal(raster.missing, 0); raster.canvas.width = raster.canvas.height = 1;
    assertFreed(f);
  }
});
test('CORS-hidden failures stay distinct from confirmed absence and have bounded retries', async () => {
  const f = engineSetup({ metadata: () => ({}), image: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(f.engine.buildRaster(geometry(), 388), error => {
    assert.equal(error.code, 'IMAGERY_FETCH_FAILED'); assert.equal(error.failures.TILE_NETWORK, 2);
    assert.match(error.message, /not confirmed absent/); return true;
  });
  assert.equal(f.calls.filter(call => !call.url.includes('/tilemap/')).length, 4); assertFreed(f);
});
test('HTTP absence, server failure and decode errors retain separate diagnostic codes', async () => {
  for (const [status, code, count] of [[404, 'TILE_UNAVAILABLE', 2], [503, 'TILE_HTTP', 4]]) {
    const f = engineSetup({ image: async () => new Response('error', { status }) });
    await assert.rejects(f.engine.buildRaster(geometry(), 388), error => error.failures[code] === 2);
    assert.equal(f.calls.filter(call => !call.url.includes('/tilemap/')).length, count); assertFreed(f);
  }
  const f = engineSetup({ decode: async () => { throw new Error('bad image'); } });
  await assert.rejects(f.engine.buildRaster(geometry(), 388), error => error.failures.TILE_DECODE === 2); assertFreed(f);
});
test('tile request timeouts are bounded and release all request timers', async () => {
  const f = engineSetup({ fakeTimers: true, image: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
  const running = f.engine.buildRaster(geometry(128), 388);
  const rejection = assert.rejects(running, error => error.failures.TILE_TIMEOUT === 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    await turn(); const timer = [...f.timers.values()].find(timer => timer.ms === 10000);
    assert.ok(timer); timer.fn();
  }
  await rejection; assert.equal(f.timers.size, 0); assertFreed(f);
});
test('raster deadline aborts and drains in-flight siblings before freeing the canvas', async () => {
  let active = 0;
  const f = engineSetup({ fakeTimers: true, image: (url, { signal }) => new Promise((resolve, reject) => {
    active++; signal.addEventListener('abort', () => { active--; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }) });
  const running = f.engine.buildRaster(geometry(), 388), rejection = assert.rejects(running, { code: 'IMAGERY_TIMEOUT' });
  await turn(); assert.equal(active, 2);
  [...f.timers.values()].find(timer => timer.ms === 120000).fn();
  await rejection; assert.equal(active, 0); assert.equal(f.timers.size, 0); assertFreed(f);
});
test('pre-abort allocates nothing; cancellation during cached tiles closes decoded bitmaps and stops the queue', async () => {
  const controller = new AbortController(); controller.abort(); const f = engineSetup();
  await assert.rejects(f.engine.buildRaster(geometry(), 388, 18, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0); assert.equal(f.canvases.length, 0);
  const active = new AbortController(); let reads = 0;
  const cached = engineSetup({ cache: { match: async () => { reads++; return new Response('cached'); } }, decode: async () => active.abort() });
  await assert.rejects(cached.engine.buildRaster(geometry(), 388, 18, { signal: active.signal, concurrency: 1 }), { name: 'AbortError' });
  assert.equal(reads, 1); assertFreed(cached);
});
test('bad cache entries are evicted and retried from the network', async () => {
  let deleted = 0;
  const f = engineSetup({ cache: { match: async () => new Response('broken'), delete: async () => { deleted++; return true; }, put: async () => {} },
    decode: async blob => { if (await blob.text() === 'broken') throw new Error('bad cached image'); } });
  const raster = await f.engine.buildRaster(geometry(), 388);
  assert.equal(deleted, 2); assert.equal(raster.missing, 0); raster.canvas.width = raster.canvas.height = 1; assertFreed(f);
});
test('drawing and encoding failures close bitmaps and release processing/preview canvases', async () => {
  const f = engineSetup({ draw: () => { throw new Error('draw failed'); } });
  await assert.rejects(f.engine.buildRaster(geometry(), 388), /draw failed/); assertFreed(f);
  const failing = engineSetup({ encode: () => { throw new Error('encode failed'); } });
  await assert.rejects(failing.engine.processClip({ ...aoi, geometry: geometry() }, { release: 388, date: '2016-04-20' }, { geotiff: false }), /encode failed/);
  assertFreed(failing);
  let encodes = 0;
  const preview = engineSetup({ encode: () => { if (++encodes === 2) throw new Error('preview failed'); } });
  await assert.rejects(preview.engine.processClip({ ...aoi, geometry: geometry() }, { release: 388, date: '2016-04-20' }, { geotiff: false }), /preview failed/);
  assert.equal(preview.canvases.length, 2); assertFreed(preview);
});

async function runJob({ fail, partial = false, cancel = false } = {}) {
  let exported; const processed = [];
  const releases = [103, 102, 101].map((release, i) => ({ release, date: ['2026-10-29', '2016-04-20', '2025-03-27'][i] }));
  const app = await appSetup({ beforeBoot: context => {
    context.GVEngine.getReleases = async () => releases;
    const original = context.GVEngine.processClip;
    context.GVEngine.processClip = async (feature, release, options) => {
      processed.push(release.release);
      if (cancel && release.release === 102) throw new DOMException('Cancelled', 'AbortError');
      if (fail?.(release)) throw Object.assign(new Error('No imagery coverage at z18; choose a newer date or explicitly lower Imagery zoom.'), { code: 'NO_IMAGERY', zoom: 18 });
      const value = await original(feature, release, options); value.missing = partial ? 1 : 0;
      return value;
    };
    context.GVEngine.exportJobZip = async job => { exported = job; return new Blob(['archive']); };
  } });
  app.context.document.querySelectorAll('[name=relMode]')[2].checked = true;
  for (const box of app.element('#relList').querySelectorAll('[data-c]')) { box.checked = true; box.onchange(); }
  await app.element('#runBtn').onclick(); await turn(); await app.element('#expZip').onclick();
  return { app, exported, processed };
}
test('a failed middle date preserves earlier results, continues later clips and exposes/export outcomes', async () => {
  const { app, exported, processed } = await runJob({ fail: release => release.release === 102 });
  assert.deepEqual(processed, [103, 102, 101]); assert.equal(exported.status, 'partial');
  assert.deepEqual(Array.from(exported.results, r => r.release), [103, 101]);
  assert.deepEqual(Array.from(exported.outcomes, r => r.status), ['completed', 'unavailable', 'completed']);
  assert.match(app.element('#jobLog').textContent, /Finished \(partial\)/);
  assert.match(app.element('#jobOutcomes').innerHTML, /2016-04-20.*unavailable/s); assert.equal(app.element('#jobOutcomes').hidden, false);
  assert.equal(app.element('#resTable tbody').querySelectorAll('tr[data-i]').length, 2);
});
test('all unavailable dates produce an error summary without false zero-object result rows', async () => {
  const { app, exported } = await runJob({ fail: () => true });
  assert.equal(exported.status, 'error'); assert.equal(exported.results.length, 0); assert.equal(exported.outcomes.length, 3);
  assert.equal(app.element('#resTable tbody').querySelectorAll('tr[data-i]').length, 0);
  assert.match(app.element('#jobOutcomes').innerHTML, /no detection count/);
});
test('cancellation is terminal and partial imagery remains explicit instead of complete', async () => {
  const { exported, processed } = await runJob({ cancel: true });
  assert.deepEqual(processed, [103, 102]); assert.equal(exported.status, 'cancelled');
  assert.deepEqual(Array.from(exported.outcomes, r => r.status), ['completed', 'cancelled', 'not_run']);
  const partial = await runJob({ partial: true }); assert.equal(partial.exported.status, 'partial');
  assert.ok(partial.exported.outcomes.every(outcome => outcome.status === 'partial'));
  assert.match(partial.app.element('#resTable tbody').innerHTML, /Incomplete imagery/);
});
test('ZIP summary records unavailable dates separately and preserves the completed image/georeferencing', async () => {
  const f = engineSetup(); const files = new Map();
  f.context.JSZip = class {
    constructor(prefix = '') { this.prefix = prefix; }
    folder(name) { return new f.context.JSZip(this.prefix + name + '/'); }
    file(name, value) { files.set(this.prefix + name, value); }
    async generateAsync() { return new Blob(['zip']); }
  };
  const result = await f.engine.processClip({ ...aoi, geometry: geometry() }, { release: 103, date: '2026-10-29' }, { geotiff: false });
  const outcomes = [{ date: '2026-10-29', status: 'completed' }, { date: '2016-04-20', status: 'unavailable', code: 'NO_IMAGERY' }];
  await f.engine.exportJobZip({ id: 'job', status: 'partial', params: { zoom: 18 }, aois: [aoi], results: [result], outcomes });
  const summary = JSON.parse(files.get('job/summary.json'));
  assert.equal(summary.status, 'partial'); assert.deepEqual(summary.outcomes, outcomes); assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].coverage.status, 'full'); assert.equal(summary.results[0].zoom, 18);
  assert.equal(files.get('job/Review/2026-10-29/image.png'), result.blobs.png);
  const world = files.get('job/Review/2026-10-29/image.pgw').trim().split('\n').map(Number);
  assert.equal(world[0], 2 * 20037508.342789244 / (256 * 2 ** 18)); assert.equal(world[3], -world[0]); assertFreed(f);
});
test('training export refuses incomplete imagery instead of generating negative examples from holes', async () => {
  const f = engineSetup({ metadata: url => tilemap(url, x => x % 2) });
  f.context.JSZip = class { folder() { return this; } file() { assert.fail('No training samples should be written'); } };
  const annotation = { ...aoi, geometry: geometry(), properties: { status: 'verified', class: 'ship', release: 388, zoom: 18 } };
  await assert.rejects(f.engine.exportDataset({ type: 'FeatureCollection', features: [annotation] }), { code: 'INCOMPLETE_TRAINING_IMAGERY' });
  assertFreed(f);
});
