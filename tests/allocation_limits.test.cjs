const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const fflate = require('fflate');
const { setup, turn } = require('./helpers/app.cjs');
const source = name => fs.readFileSync(path.join(__dirname, '../frontend', name + '.js'), 'utf8');
const ll = (x, y, z = 18) => [x / (256 * 2 ** z) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * 2 ** z)))) * 180 / Math.PI];
function geometry(w = 400, h = 128) {
  const x = 171383 * 256 + 16, y = 112057 * 256 + 16;
  return { type: 'Polygon', coordinates: [[ll(x, y), ll(x + w, y), ll(x + w, y + h), ll(x, y + h), ll(x, y)]] };
}
const feature = geometry => ({ type: 'Feature', properties: { name: 'Limits', class: 'ship', status: 'verified', release: 101, zoom: 18 }, geometry });
const release = { release: 101, date: '2026-10-29' };
function fixture({ contextFailure = false, canvasFailure = false, encodeFailure = false, encode, zip } = {}) {
  const canvases = [], bitmaps = [], requests = [];
  const context = vm.createContext({ Blob, Response, DOMException, AbortController, setTimeout, clearTimeout, fflate,
    fetch: async url => {
      requests.push(url);
      if (url.includes('/tilemap/')) {
        const [release, zoom, top, left, width, height] = url.split('/tilemap/')[1].split('/').map(Number);
        return new Response(JSON.stringify({ valid: true, location: { top, left, width, height }, data: Array(width * height).fill(1) }));
      }
      return new Response('tile');
    },
    createImageBitmap: async (blob, options) => { const bitmap = { ...options, width: options?.resizeWidth, height: options?.resizeHeight, closed: 0, close() { this.closed++; } }; bitmaps.push(bitmap); return bitmap; },
    OffscreenCanvas: class {
      constructor(width, height) { if (canvasFailure) throw Error('allocation failed'); this.width = width; this.height = height; canvases.push(this); }
      getContext() { return contextFailure ? null : { drawImage() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; }
      async convertToBlob() { if (encodeFailure) throw Error('encoding failed'); return encode ? encode(this) : new Blob(['image']); }
    }, ...(zip ? { JSZip: zip } : {}),
  });
  vm.runInContext(source('engine'), context); vm.runInContext(source('comparison'), context);
  const engine = context.GVEngine, budget = engine.allocations;
  return { context, engine, budget, canvases, bitmaps, requests, freed() {
    const stats = budget.diagnostics(); assert.equal(stats.liveCanvasBytes, 0); assert.equal(stats.reservedBytes, 0); assert.equal(stats.activeOperations.length, 0);
    assert.ok(canvases.every(c => c.width === 1 && c.height === 1)); assert.ok(bitmaps.every(b => b.closed === 1));
  } };
}
function png(w, h) {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(w, 16); bytes.writeUInt32BE(h, 20); return new Blob([bytes]);
}
test('pure estimator matches actual snapped pixels for rectangles, holes and MultiPolygons', async () => {
  const shapes = [geometry(), { ...geometry(), coordinates: [...geometry().coordinates, geometry(20, 20).coordinates[0]] },
    { type: 'MultiPolygon', coordinates: [geometry().coordinates, geometry(200, 64).coordinates] }];
  for (const shape of shapes) {
    const f = fixture(), plan = f.engine.estimateRaster(shape, 18, { mode: 'raster' });
    assert.equal(f.canvases.length, 0); assert.equal(f.requests.length, 0);
    const r = await f.engine.buildRaster(shape, 101, 18);
    assert.equal(r.w, plan.width); assert.equal(r.h, plan.height); assert.equal(r.tiles, plan.tiles); assert.equal(r.zoom, plan.zoom);
    assert.ok(f.budget.diagnostics().peakCanvasBytes <= plan.estimatedBytes);
    r.release(); r.release(); f.freed();
  }
});
test('invalid geometry, dimensions, options and limits are rejected before requests or canvases', async () => {
  const f = fixture();
  for (const shape of [geometry(0), { type: 'Polygon', coordinates: [] }, { type: 'Polygon', coordinates: [[[0, 90], [1, 90], [1, 91], [0, 90]]] },
    { type: 'Polygon', coordinates: [[[NaN, 0], [1, 0], [1, 1], [NaN, 0]]] }, { ...geometry(), coordinates: [geometry().coordinates[0].slice(0, -1)] }])
    await assert.rejects(f.engine.buildRaster(shape, 101), { code: 'INVALID_AOI' });
  for (const zoom of [NaN, Infinity, 9, 20, 18.5]) await assert.rejects(f.engine.buildRaster(geometry(), 101, zoom), { code: 'INVALID_ZOOM' });
  for (const options of [{ maxTiles: 0 }, { concurrency: 0 }, { concurrency: 65 }, { limits: { maxPixels: NaN } }])
    await assert.rejects(f.engine.buildRaster(geometry(), 101, 18, options), { code: 'INVALID_LIMIT' });
  for (const [w, h] of [[0, 1], [1, Infinity], [NaN, 1], [1.5, 2], [Number.MAX_SAFE_INTEGER, 2]]) assert.throws(() => f.budget.dimensions(w, h), { code: 'INVALID_DIMENSIONS' });
  assert.equal(f.requests.length, 0); assert.equal(f.canvases.length, 0); f.freed();
});
test('zoom-floor tile cap, long-thin sides, pixel caps and imagery-only working limits cannot be bypassed', async () => {
  const f = fixture(), world = { type: 'Polygon', coordinates: [[[-179, -80], [179, -80], [179, 80], [-179, 80], [-179, -80]]] };
  await assert.rejects(f.engine.buildRaster(world, 101, 18, { maxTiles: 1 }), error => error.code === 'TILE_LIMIT' && error.zoom === 10 && error.requestedZoom === 18);
  await assert.rejects(f.engine.processClip(feature(geometry(9000, 2)), release, { geotiff: false }), { code: 'RASTER_LIMIT' });
  await assert.rejects(f.engine.processClip(feature(geometry()), release, { limits: { maxPixels: 1000 } }), { code: 'RASTER_LIMIT' });
  await assert.rejects(f.engine.processClip(feature(geometry()), release, { geotiff: false, limits: { maxEstimatedBytes: 1000 } }), { code: 'MEMORY_LIMIT' });
  assert.equal(f.requests.length, 0); assert.equal(f.canvases.length, 0); f.freed();
});
test('tile-cap zoom reduction remains visible; memory rejection never lowers zoom further', () => {
  const f = fixture(), shape = geometry();
  const reduced = f.engine.estimateRaster(shape, 18, { maxTiles: 1 });
  assert.ok(reduced.zoom < reduced.requestedZoom); assert.equal(reduced.tiles, 1);
  const blocked = f.engine.estimateRaster(shape, 18, { limits: { maxEstimatedBytes: 1 } });
  assert.equal(blocked.zoom, 18); assert.equal(blocked.allowed, false);
  assert.ok(blocked.violations.some(v => v.code === 'MEMORY_LIMIT'));
});
test('one processing slot, two auxiliary slots and aggregate byte reservations release idempotently', () => {
  const f = fixture(), limits = { maxEstimatedBytes: 1000 };
  const processing = f.budget.reserve('processing', 600, limits, true);
  assert.throws(() => f.budget.reserve('second', 1, limits, true), { code: 'RESOURCE_BUSY' });
  assert.throws(() => f.budget.reserve('helper', 401, limits), { code: 'MEMORY_LIMIT' });
  const helper = f.budget.reserve('helper', 200, limits), other = f.budget.reserve('other', 200, limits);
  assert.throws(() => f.budget.reserve('third helper', 1, limits), { code: 'RESOURCE_BUSY' });
  assert.throws(() => helper.resize(201), { code: 'MEMORY_LIMIT' });
  processing.release(); processing.release(); helper.release(); other.release(); f.freed();
});
test('constructor, context, encoding, compression and cancellation failures close canvas owners', async () => {
  for (const options of [{ canvasFailure: true }, { contextFailure: true }, { encodeFailure: true }]) {
    const f = fixture(options); await assert.rejects(f.engine.processClip(feature(geometry()), release, { geotiff: false })); f.freed();
  }
  const f = fixture(); f.context.fflate = { zlibSync() { throw Error('compression failed'); } };
  await assert.rejects(f.engine.processClip(feature(geometry()), release), /compression failed/); f.freed();
  const controller = new AbortController(), cancelled = fixture({ encode: async () => { controller.abort(); return new Blob(['image']); } });
  await assert.rejects(cancelled.engine.processClip(feature(geometry()), release, { signal: controller.signal, geotiff: false }), { name: 'AbortError' }); cancelled.freed();
});
test('HTML canvas fallback applies the same limits and releases null-encoding failures', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), Canvas = f.context.OffscreenCanvas; delete f.context.OffscreenCanvas;
    f.context.document = { createElement: name => {
      assert.equal(name, 'canvas'); const canvas = new Canvas(300, 150);
      canvas.convertToBlob = undefined; canvas.toBlob = callback => callback(fail ? null : new Blob(['image'])); return canvas;
    } };
    const pending = f.engine.processClip(feature(geometry()), release, { geotiff: false });
    if (fail) await assert.rejects(pending, { code: 'CANVAS_ENCODING' });
    else { const clip = await pending; assert.deepEqual(Array.from(clip.size), [400, 128]); }
    f.freed();
  }
});
test('clip encoders preserve native dimensions, zoom and transforms, and skinny previews stay positive', async () => {
  for (const [w, h] of [[400, 128], [8000, 1]]) {
    const f = fixture(), plan = f.engine.estimateRaster(geometry(w, h));
    const r = await f.engine.processClip(feature(geometry(w, h)), release);
    assert.deepEqual(Array.from(r.size), [plan.width, plan.height]); assert.equal(r.requestedZoom, 18); assert.equal(r.zoom, 18);
    assert.equal(Number(r.blobs.pgw.split('\n')[0]), plan.res); assert.ok(r.blobs.tif.size > 0);
    assert.ok(f.canvases[1]); f.freed();
  }
});
test('model input/tensor and training preflight limits fail before pixel buffers or dependencies', async () => {
  const f = fixture();
  await assert.rejects(f.engine.processClip(feature(geometry()), release, { geotiff: false, model: { imgsz: 16384 } }), { code: 'RASTER_LIMIT' });
  await assert.rejects(f.engine.processClip(feature(geometry()), release, { model: { imgsz: 0 } }), { code: 'INVALID_DIMENSIONS' });
  await assert.rejects(f.engine.detect({ w: 400, h: 128 }, { imgsz: 1024 }, { limits: { maxEstimatedBytes: 1024 } }), { code: 'MEMORY_LIMIT' });
  // A tiny custom input must not create millions of materialized windows.
  await assert.rejects(f.engine.processClip(feature(geometry(8000, 1000)), release, { model: { imgsz: 1 }, geotiff: false }), { code: 'MEMORY_LIMIT' });
  await assert.rejects(f.engine.exportDataset({ features: [feature(geometry())] }, { limits: { maxEstimatedBytes: 1000 } }), { code: 'MEMORY_LIMIT' });
  assert.equal(f.requests.length, 0); assert.equal(f.canvases.length, 0); f.freed();
});
test('training chips and mosaics close even if JPEG encoding or ZIP generation fails', async () => {
  class Zip { folder() { return this; } file() {} async generateAsync() { throw Error('zip failed'); } }
  for (const options of [{ encodeFailure: true }, {}]) {
    const f = fixture({ ...options, zip: Zip });
    await assert.rejects(f.engine.exportDataset({ features: [feature(geometry(20, 20))] }), /failed/);
    assert.ok(f.canvases.length >= 2); f.freed();
  }
});
test('GeoTIFF validates rows, dimensions and georeferencing before allocating output buffers', () => {
  const f = fixture(), geo = { res: 0.5, x0: 100, y0: 200 }; let rows = 0;
  const read = () => { rows++; return new Uint8Array(16); };
  assert.throws(() => f.engine.writeGeoTIFF(9000, 1, read, geo), { code: 'RASTER_LIMIT' });
  assert.throws(() => f.engine.writeGeoTIFF(2, 2, read, { ...geo, res: NaN }), { code: 'INVALID_TIFF' });
  assert.equal(rows, 0);
  assert.throws(() => f.engine.writeGeoTIFF(2, 2, () => new Uint8Array(1), geo), { code: 'INVALID_TIFF' }); f.freed();
});
test('comparison reads legacy PNG dimensions, ignores untrusted size metadata and bounds decode before allocation', async () => {
  const f = fixture(), result = await f.context.GVCompare.preview(png(400, 128), undefined);
  assert.deepEqual(Array.from(result.size), [400, 128]); f.freed();
  await f.context.GVCompare.preview(png(400, 128), [999999, 999999]); f.freed();
  const before = f.bitmaps.length;
  await assert.rejects(f.context.GVCompare.preview(png(9000, 1)), { code: 'RASTER_LIMIT' });
  await assert.rejects(f.context.GVCompare.preview(new Blob(['bad'])), { code: 'INVALID_IMAGE' });
  f.budget.configure({ maxEstimatedBytes: 1024 });
  await assert.rejects(f.context.GVCompare.preview(png(400, 128)), { code: 'MEMORY_LIMIT' });
  assert.equal(f.bitmaps.length, before); f.freed();
});
test('comparison closes mismatched decode sizes and cancellation results', async () => {
  const f = fixture(); f.context.createImageBitmap = async () => { const b = { width: 9000, height: 1, closed: 0, close() { this.closed++; } }; f.bitmaps.push(b); return b; };
  await assert.rejects(f.context.GVCompare.preview(png(400, 128)), /decode size/); f.freed();
  const controller = new AbortController(), other = fixture({ encode: async () => { controller.abort(); return new Blob(['image']); } });
  await assert.rejects(other.context.GVCompare.preview(png(400, 128), undefined, controller.signal), { name: 'AbortError' }); other.freed();
});
test('ZIP owner remains reserved until asynchronous generation settles and refuses oversized retained inputs', async () => {
  let finish;
  class Zip { folder() { return this; } file() {} generateAsync() { return new Promise(resolve => { finish = resolve; }); } }
  const f = fixture({ zip: Zip }), pending = f.engine.exportJobZip({ id: 'test', results: [], aois: [] });
  await turn(); assert.equal(f.budget.diagnostics().activeOperations.length, 1); finish(new Blob(['zip'])); await pending; f.freed();
  const r = { aoi_id: 'a', release: 101, fc: { features: [] }, aoiFeature: {}, blobs: { png: new Blob([Buffer.alloc(100000)]), preview: new Blob(['preview']), pgw: 'world' } };
  await assert.rejects(f.engine.exportJobZip({ id: 'test', results: [r], aois: [] }, { limits: { maxEstimatedBytes: 100000 } }), { code: 'MEMORY_LIMIT' }); f.freed();
});
test('Detect preflight disables invalid submissions, restores Run after adjustment and freezes queued limits', async () => {
  const app = await setup(), { element, context } = app; let received;
  const previous = context.GVEngine.processClip;
  context.GVEngine.processClip = async (...args) => { received = args[2].limits; return previous(...args); };
  element('#rasterMemory').value = '1'; element('#rasterMemory').onchange();
  assert.equal(element('#runBtn').disabled, true); assert.match(element('#allocationPreflight').innerHTML, /exceed/);
  assert.equal(await element('#runBtn').onclick(), undefined);
  element('#rasterMemory').value = '128'; element('#rasterMemory').onchange();
  assert.equal(element('#runBtn').disabled, false);
  const pending = element('#runBtn').onclick(); element('#rasterMemory').value = '64'; element('#rasterMemory').onchange();
  const job = await pending;
  assert.equal(received.maxEstimatedBytes, 128 * 1048576); assert.equal(job.params.allocationLimits.maxEstimatedBytes, 128 * 1048576);
  assert.equal(job.status, 'done');
  element('#rasterSide').value = ''; element('#rasterSide').onchange(); assert.equal(element('#runBtn').disabled, true);
});
test('dataset owns the execution slot while new browser jobs wait, then drains the queue', async () => {
  const app = await setup(); let finish, clips = 0;
  app.context.GVEngine.exportDataset = async () => new Promise(resolve => { finish = resolve; });
  const original = app.context.GVEngine.processClip;
  app.context.GVEngine.processClip = async (...args) => { clips++; return original(...args); };
  const dataset = app.element('#dsBtn').onclick(); await turn();
  const pending = app.element('#runBtn').onclick(); await turn();
  assert.equal(clips, 0); assert.match(app.element('#queueStatus').textContent, /Building dataset.*1\/10 queued/);
  finish({ blob: new Blob(['zip']), chips: 1, classes: ['ship'] }); await dataset; await pending;
  assert.equal(clips, 1); assert.match(app.element('#queueStatus').textContent, /Idle/);
});
