const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const fflate = require('fflate');
const JSZip = require('jszip');
const { IDBFactory } = require('fake-indexeddb');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ durable = false, indexedDB = new IDBFactory() } = {}) {
  const context = vm.createContext({ Blob, Response, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView, DOMException, AbortController,
    setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, fflate, indexedDB });
  for (const name of ['engine', 'storage', 'streaming']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/' + name + '.js'), 'utf8'), context);
  const repo = durable ? context.GVStorage.create({ indexedDB, locks: null }) : null;
  if (repo) await repo.open();
  return { context, engine: context.GVEngine, io: context.GVStreaming, repo };
}
function raster(w = 71, h = 97) {
  const rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? (i % 17 ? 255 : 0) : i * 71 % 256);
  return { w, h, res: 0.5, x0: 123, y0: 456, rgba,
    async readPixels(x, y, width, height) { assert.equal(x, 0); assert.equal(width, w); return rgba.slice(y * w * 4, (y + height) * w * 4); } };
}
async function buffer(io, artifact, repo) { return Buffer.from(await (await io.materialize(artifact, { store: repo })).arrayBuffer()); }
function parsePNG(data) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const idats = []; let width, height;
  for (let offset = 8; offset < data.length;) {
    const size = data.readUInt32BE(offset), name = data.toString('ascii', offset + 4, offset + 8), payload = data.subarray(offset + 8, offset + 8 + size);
    if (name === 'IHDR') { width = payload.readUInt32BE(0); height = payload.readUInt32BE(4); }
    if (name === 'IDAT') idats.push(payload);
    assert.equal(zlib.crc32(data.subarray(offset + 4, offset + 8 + size)), data.readUInt32BE(offset + size + 8));
    offset += size + 12;
  }
  const filtered = zlib.inflateSync(Buffer.concat(idats)), pixels = [];
  for (let y = 0; y < height; y++) { assert.equal(filtered[y * (width * 4 + 1)], 0); pixels.push(filtered.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))); }
  return { width, height, rgba: Buffer.concat(pixels) };
}
function parseTIFF(data) {
  assert.equal(data.toString('ascii', 0, 2), 'II'); assert.equal(data.readUInt16LE(2), 42);
  const offset = data.readUInt32LE(4), tags = {};
  for (let i = 0; i < data.readUInt16LE(offset); i++) {
    const entry = offset + 2 + i * 12, tag = data.readUInt16LE(entry), type = data.readUInt16LE(entry + 2), count = data.readUInt32LE(entry + 4), bytes = { 3: 2, 4: 4, 12: 8 }[type];
    const start = count * bytes <= 4 ? entry + 8 : data.readUInt32LE(entry + 8);
    tags[tag] = Array.from({ length: count }, (_, j) => type === 3 ? data.readUInt16LE(start + j * bytes) : type === 4 ? data.readUInt32LE(start + j * bytes) : data.readDoubleLE(start + j * bytes));
  }
  return { tags, rgba: Buffer.concat(tags[273].map((offset, i) => zlib.inflateSync(data.subarray(offset, offset + tags[279][i])))) };
}
test('PNG row encoder produces independent CRC-valid lossless RGBA pixels without a canvas', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), r = raster();
  const artifact = await io.png(r, io.sink(spool, 'png', 'image/png'));
  const decoded = parsePNG(await buffer(io, artifact));
  assert.equal(decoded.width, r.w); assert.equal(decoded.height, r.h); assert.deepEqual(decoded.rgba, Buffer.from(r.rgba));
  await spool.dispose(); assert.equal(io.diagnostics().memoryBytes, 0); assert.equal(io.diagnostics().activeWriters, 0);
});
test('TIFF strip spooling preserves every pixel, dimensions, alpha and EPSG/pixel-corner transform', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), r = raster();
  const artifact = await io.tiff(r, io.sink(spool, 'tif', 'image/tiff'), spool);
  const decoded = parseTIFF(await buffer(io, artifact));
  assert.deepEqual(decoded.rgba, Buffer.from(r.rgba)); assert.deepEqual(decoded.tags[256], [r.w]); assert.deepEqual(decoded.tags[257], [r.h]);
  assert.deepEqual(decoded.tags[33550], [r.res, r.res, 0]); assert.deepEqual(decoded.tags[33922], [0, 0, 0, r.x0, r.y0, 0]); assert.equal(decoded.tags[34735].at(-1), 3857);
  await assert.rejects(spool.get('tiff-strips', 0), /missing/); await spool.dispose();
});
test('stalled native sinks pause row production and output queues remain bounded', async () => {
  const { io } = await fixture(); let produced = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const r = raster(1000, 300); r.readPixels = async (x, y, w, h) => { produced++; return new Uint8Array(w * h * 4); };
  let writes = 0;
  const pending = io.png(r, { async write() { writes++; await gate; }, async close() { return 'done'; } });
  await turn(); assert.equal(writes, 1); assert.equal(produced, 0); release(); assert.equal(await pending, 'done');
  assert.ok(io.diagnostics().peakPendingBytes <= io.MAX_QUEUE); assert.equal(io.diagnostics().pendingBytes, 0);
});
test('native cancellation after a pending row/write acknowledges without later writes', async () => {
  const { io } = await fixture(), controller = new AbortController(); let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), r = raster();
  r.readPixels = async (x, y, w, h) => { await gate; return new Uint8Array(w * h * 4); };
  const pending = io.png(r, { async write() { writes++; }, async close() {} }, { signal: controller.signal });
  await turn(); controller.abort(); release(); await assert.rejects(pending, { name: 'AbortError' });
  const count = writes; await turn(); assert.equal(writes, count); assert.equal(io.diagnostics().activeWriters, 0); assert.equal(io.diagnostics().pendingBytes, 0);
});
test('PNG/TIFF source failure, invalid rows and row/format limits do not leave active writers', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), r = raster();
  for (const encode of ['png', 'tiff']) {
    await assert.rejects(io[encode]({ ...r, readPixels: async () => new Uint8Array(1) }, io.sink(spool, encode, 'image/' + encode), spool), /invalid RGBA/);
    await assert.rejects(io[encode]({ ...r, w: 1000000 }, io.sink(spool, encode, 'image/' + encode), spool), { code: 'NATIVE_ROW_LIMIT' });
  }
  assert.equal(io.diagnostics().activeWriters, 0); await spool.dispose();
});
test('streamed ZIP stores existing imagery, compresses text and preserves Unicode paths/CRCs', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), writer = io.zip(io.sink(spool, 'zip', 'application/zip'));
  const image = Uint8Array.from({ length: 12345 }, (_, n) => n % 251), text = 'feature,\"🛰️\"\n'.repeat(500);
  await writer.add('clip/image.png', io.source(image)); await writer.add('clip/名字.geojson', text, { compress: true });
  const archive = await buffer(io, await writer.close()), decoded = await JSZip.loadAsync(archive, { checkCRC32: true });
  assert.deepEqual(await decoded.file('clip/image.png').async('nodebuffer'), Buffer.from(image));
  assert.equal(await decoded.file('clip/名字.geojson').async('string'), text);
  assert.equal(decoded.file('clip/image.png')._data.compression.magic, '\x00\x00');
  assert.equal(decoded.file('clip/名字.geojson')._data.compression.magic, '\x08\x00');
  assert.equal(io.diagnostics().activeWriters, 0); await spool.dispose();
});
test('split fallback parts respect byte limits and reassemble the exact valid ZIP', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), limit = io.CHUNK;
  const output = io.output(spool, { name: 'job.zip', partBytes: limit }), writer = io.zip(output);
  const image = Uint8Array.from({ length: limit * 2 + 19 }, (_, n) => n % 251);
  await writer.add('clip/image.png', io.source(image)); const result = await writer.close();
  assert.ok(result.parts.length >= 3); assert.ok(result.parts.every(part => part.size <= limit));
  const buffers = []; for (const part of result.parts) buffers.push(await buffer(io, part));
  const decoded = await JSZip.loadAsync(Buffer.concat(buffers), { checkCRC32: true }); assert.deepEqual(await decoded.file('clip/image.png').async('nodebuffer'), Buffer.from(image));
  await spool.dispose();
});
test('file destinations apply backpressure, close once, and abort a failed close/write', async () => {
  const { io } = await fixture(); let release, closed = 0, aborted = 0, produced = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const destination = { async write() { produced++; await gate; }, async close() { closed++; throw Error('disk full'); }, async abort() { aborted++; } };
  const writer = io.zip(io.output(null, { name: 'file.zip', destination }));
  const add = writer.add('file.txt', 'abc', { compress: true });
  for (let i = 0; i < 100 && !produced; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(produced, 1); release(); await add;
  await assert.rejects(writer.close(), /disk full/); await writer.abort(); assert.equal(closed, 1); assert.equal(aborted, 1); assert.equal(io.diagnostics().activeWriters, 0);
});
test('chunked artifact staging commits atomically, reloads lazily and job deletion removes chunks', async () => {
  const f = await fixture({ durable: true }), { io, repo } = f, job = { id: 'job', createdAt: 1, status: 'running', params: {}, aois: [], results: [] };
  const spool = await io.createSpool({ store: repo, jobId: 'job', clipId: 'clip' }), writer = io.sink(spool, 'png', 'image/png');
  await writer.write(new Uint8Array(400000).fill(7)); const artifact = await writer.close();
  const result = { storeId: 'clip', order: 0, artifactSpool: spool.id, fc: { type: 'FeatureCollection', features: [] }, blobs: { png: artifact, display: new Blob(['display']) } };
  job.results.push(result); await repo.saveClip(job, result);
  const catalog = await repo.restore(), saved = await repo.clip('clip');
  assert.equal(catalog.jobs[0].results[0].blobs, undefined); assert.equal(saved.blobs.png.gmdArtifact, 1);
  assert.equal((await buffer(io, saved.blobs.png, repo)).length, 400000);
  const db = await new Promise(resolve => { const request = f.context.indexedDB.open('geomap-detector'); request.onsuccess = () => resolve(request.result); });
  const committed = await new Promise(resolve => { const request = db.transaction('artifacts').objectStore('artifacts').get('spool:' + spool.id); request.onsuccess = () => resolve(request.result); });
  assert.equal(committed.value.state, 'committed'); db.close();
  await repo.deleteJob('job'); await assert.rejects(io.materialize(artifact, { store: repo }), /incomplete/); await repo.close();
});
test('failed output writes keep prior results and remove only their staging owner', async () => {
  const { io, repo } = await fixture({ durable: true });
  const original = await io.createSpool({ store: repo, jobId: 'job', clipId: 'first' }); await original.put('png', 0, new Uint8Array([1]));
  const failed = await io.createSpool({ store: repo, jobId: 'job', clipId: 'failed', maxBytes: 2 });
  await assert.rejects(failed.put('png', 0, new Uint8Array(3)), { name: 'SpoolLimitError' }); await failed.dispose();
  assert.deepEqual(Array.from(await original.get('png', 0)), [1]); await original.dispose(); await repo.close();
});
test('concurrent acquisition writes reserve their temporary-storage budget before transactions complete', async () => {
  const {repo}=await fixture({durable:true}),spool=await repo.createSpool({maxBytes:3});
  const writes=await Promise.allSettled([spool.put('raw',0,new Uint8Array([1,2])),spool.put('raw',1,new Uint8Array([3,4]))]);
  assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes.find(r=>r.status==='rejected').reason.name,'SpoolLimitError');assert.equal(spool.state().bytes,2);
  await assert.rejects(repo.createSpool({maxBytes:NaN}),{name:'SpoolLimitError'});await spool.dispose();await repo.close();
});
test('aborted chunk writes drain and discard their owner; corrupted manifests cannot silently truncate', async () => {
  const { io, repo } = await fixture({ durable: true }), controller = new AbortController();
  const spool = await io.createSpool({ store: repo, signal: controller.signal }); await spool.put('png', 0, new Uint8Array([1])); controller.abort();
  await assert.rejects(spool.put('png', 1, new Uint8Array([2])), { name: 'AbortError' }); await spool.dispose();
  const other = await io.createSpool({ store: repo }); await other.put('png', 0, new Uint8Array([1]));
  await assert.rejects(io.materialize({ gmdArtifact: 1, spool: other.id, file: 'png', chunks: 1, size: 2 }, { store: repo }), /byte count/);
  await other.dispose(); await repo.close();
});
test('FeatureCollection streaming preserves fields/order without a whole-job feature array', async () => {
  const { io } = await fixture(); async function* features() { yield { id: 'one' }; yield { id: 'two' }; }
  const chunks = []; for await (const chunk of io.source(io.collection(features(), { properties: { epsg: 3857 } }))) chunks.push(Buffer.from(chunk));
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { type: 'FeatureCollection', properties: { epsg: 3857 }, features: [{ id: 'one' }, { id: 'two' }] });
});
test('deterministic pixel-area masks preserve half-pixel coverage, holes and even-odd overlaps', async () => {
  const { io } = await fixture(), data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  const rect = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], hole = [[1, 1], [3, 1], [1, 3], [1, 1]];
  await io.masker([rect, hole])(data, 0, 0, 4, 4);
  assert.equal(data[(1 * 4 + 1) * 4 + 3], 0); assert.equal(data[(1 * 4 + 2) * 4 + 3], 128); assert.equal(data[(2 * 4 + 2) * 4 + 3], 255);
  const overlap = new Uint8ClampedArray(64).fill(255); await io.masker([rect, rect])(overlap, 0, 0, 4, 4); assert.ok(overlap.every(value => value === 0));
});
test('pixel masks are byte-identical across block sizes, offsets and diagonally crossing rings', async () => {
  const { io } = await fixture(), width = 64, height = 48;
  const rings = [[[-3, -2], [63, 3], [49, 47], [-3, -2]], [[8, 8], [32, 15], [13, 35], [8, 8]]];
  const whole = new Uint8ClampedArray(width * height * 4).fill(255), output = new Uint8ClampedArray(whole.length), mask = io.masker(rings);
  await mask(whole, 0, 0, width, height);
  for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) {
    const tile = new Uint8ClampedArray(16 * 16 * 4).fill(255); await mask(tile, x, y, 16, 16);
    for (let row = 0; row < 16; row++) output.set(tile.subarray(row * 64, (row + 1) * 64), ((y + row) * width + x) * 4);
  }
  assert.deepEqual(output, whole);
});
test('Classic ZIP guards both compressed output and uncompressed entry lengths before overflow', async () => {
  const { io } = await fixture(), spool = await io.createSpool(), writer = io.zip(io.sink(spool, 'zip', 'application/zip'), { maxBytes: 512 });
  await assert.rejects(writer.add('large.txt', 'a'.repeat(513), { compress: true }), { code: 'ZIP_SIZE_LIMIT' }); await writer.abort(); await spool.dispose(); assert.equal(io.diagnostics().activeWriters, 0);
});
test('version-1 IndexedDB records/Blobs upgrade intact and older clients cannot write version 2', async () => {
  const indexedDB = new IDBFactory(), old = await new Promise((resolve, reject) => {
    const request = indexedDB.open('geomap-detector', 1);
    request.onupgradeneeded = () => {
      for (const [name, indexes] of Object.entries({ meta: {}, aois: {}, jobs: {}, queue: {}, models: {}, weights: {},
        results: { jobId: 'jobId', aoiId: 'aoiId' }, predictions: { jobId: 'jobId' }, artifacts: { clipId: 'clipId', jobId: 'jobId' }, drafts: { jobId: 'jobId' }, reviews: { scope: 'scope', jobId: 'jobId', aoiId: 'aoiId' } })) {
        const store = request.result.createObjectStore(name, { keyPath: 'id' }); for (const [index, field] of Object.entries(indexes)) store.createIndex(index, field);
      }
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const original = new Blob(['native legacy PNG bytes']);
  await new Promise(resolve => {
    const tx = old.transaction(['jobs', 'results', 'predictions', 'artifacts', 'reviews'], 'readwrite');
    tx.objectStore('jobs').put({ id: 'legacy', createdAt: 1, status: 'done', params: { model: 'unchanged' } });
    tx.objectStore('results').put({ id: 'clip', storeId: 'clip', jobId: 'legacy', order: 0, unknown: { retained: true } });
    tx.objectStore('predictions').put({ id: 'clip', jobId: 'legacy', fc: { type: 'FeatureCollection', features: [{ id: 'original' }] } });
    tx.objectStore('artifacts').put({ id: 'clip:png', clipId: 'clip', jobId: 'legacy', kind: 'png', value: original });
    tx.objectStore('reviews').put({ id: 'review', scope: 'clip', feature: { id: 'review' } }); tx.oncomplete = resolve;
  }); old.close();
  const f = await fixture({ durable: true, indexedDB }), saved = await f.repo.clip('clip');
  assert.equal(await saved.blobs.png.text(), await original.text()); assert.equal(saved.fc.features[0].id, 'original'); assert.equal(saved.unknown.retained, true);
  assert.equal((await f.repo.reviews('clip')).features[0].id, 'review'); assert.equal((await f.repo.restore()).jobs[0].params.model, 'unchanged');
  await assert.rejects(new Promise((resolve, reject) => { const r = indexedDB.open('geomap-detector', 1); r.onerror = () => reject(r.error); r.onsuccess = () => resolve(); }), { name: 'VersionError' });
  await f.repo.close();
});
test('first processing use sweeps an interrupted prior owner while keeping committed artifacts', async () => {
  const indexedDB = new IDBFactory(), first = await fixture({ durable: true, indexedDB });
  const orphan = await first.repo.createSpool({ jobId: 'job', clipId: 'orphan' }); await orphan.put('raw', 0, new Uint8Array([9]));
  const saved = await first.repo.createSpool({ jobId: 'job', clipId: 'saved' }); await saved.put('png', 0, new Uint8Array([1]));
  const artifact = { gmdArtifact: 1, spool: saved.id, file: 'png', chunks: 1, size: 1 };
  await first.repo.saveClip({ id: 'job', status: 'done', createdAt: 1 }, { storeId: 'saved', artifactSpool: saved.id, fc: { features: [] }, blobs: { png: artifact } });
  await first.repo.close(); const second = await fixture({ durable: true, indexedDB });
  const before = second.repo.state().reads.artifacts || 0; await second.repo.restore(); assert.equal(second.repo.state().reads.artifacts || 0, before);
  const next = await second.repo.createSpool({ jobId: 'next', clipId: 'next' });
  await assert.rejects(second.repo.readArtifactChunk({ ...artifact, spool: orphan.id, file: 'raw' }, 0), /incomplete/);
  assert.deepEqual(Array.from(await second.repo.readArtifactChunk(artifact, 0)), [1]); await next.dispose(); await second.repo.close();
});
test('a staging ownership mismatch rolls back the result transaction without deleting user data', async () => {
  const { repo } = await fixture({ durable: true }), staged = await repo.createSpool({ jobId: 'one', clipId: 'clip' });
  await assert.rejects(repo.saveClip({ id: 'another', status: 'done', createdAt: 1 }, { storeId: 'clip', artifactSpool: staged.id, fc: { features: [] }, blobs: {} }), /owner does not match/);
  assert.equal((await repo.restore()).jobs.length, 0); await staged.dispose(); await repo.close();
});
test('completed session artifacts remain readable after their processing signal closes', async () => {
  const { io } = await fixture(), controller = new AbortController(), spool = await io.createSpool({ signal: controller.signal });
  const output = io.sink(spool, 'png', 'image/png', { signal: controller.signal }); await output.write(new Uint8Array([1, 2, 3])); const artifact = await output.close();
  controller.abort(); assert.deepEqual(await buffer(io, artifact), Buffer.from([1, 2, 3])); await spool.dispose(); assert.equal(io.diagnostics().memoryBytes, 0);
});
test('job ZIP streams original root, collision paths, selected clips, features and quoted CSV fields', async () => {
  const { engine, repo } = await fixture({ durable: true });
  const clips = [0, 1].map(i => ({ storeId: 'clip-' + i, aoi: 'AOI', aoi_id: 'AOI', date: '2026-10-29', release: 101,
    fc: { type: 'FeatureCollection', features: [{ id: 'id-' + i, properties: { class: 'ship', aoi_name: 'A,"B"\r\nC', centroid: [55, 25] } }] },
    blobs: { png: new Blob(['original bytes']), pgw: '1\n0\n0\n-1\n2\n3\n' }, aoiFeature: { type: 'Feature', properties: {} } }));
  const job = { id: 'job.123', results: clips, aois: [], params: {}, status: 'done' }; let reads = 0;
  const output = await engine.exportJobZip(job, { streaming: true, store: repo, clipId: 'clip-1', readResult: async r => { reads++; return r; } });
  const archive = await JSZip.loadAsync(await output.arrayBuffer(), { checkCRC32: true }), prefix = job.id + '/AOI/2026-10-29__clip_1/';
  assert.ok(archive.file(prefix + 'image.png')); assert.equal(archive.file(prefix + 'image.png')._data.compression.magic, '\x00\x00');
  assert.deepEqual(JSON.parse(await archive.file(job.id + '/all_detections.geojson').async('string')).features, clips[1].fc.features);
  assert.equal(JSON.parse(await archive.file(job.id + '/summary.json').async('string')).results[0].path, 'AOI/2026-10-29__clip_1'); assert.equal(reads, 2);
  const csv = await engine.exportCSV(job, { store: repo }); assert.ok((await csv.text()).includes('"A,""B""\r\nC"')); await repo.close();
  assert.equal(engine.allocations.diagnostics().reservedBytes, 0);
});
test('downloaded combine script checks parts and preserves pre-existing output/partial files', async () => {
  const { setup } = require('./helpers/app.cjs'), { spawnSync } = require('node:child_process'), os = require('node:os');
  const app = await setup(); app.element('#exportCombine').onclick();
  const script = await app.urlEvents.find(e => e.type === 'create').blob.text(), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gmd-parts-'));
  try {
    const zip = new JSZip(); zip.file('hello.txt', 'world'); const archive = await zip.generateAsync({ type: 'nodebuffer' }), midpoint = Math.floor(archive.length / 2);
    const parts = [archive.subarray(0, midpoint), archive.subarray(midpoint)].map((data, i) => ({ name: 'job.zip.' + i, size: data.length, crc32: zlib.crc32(data) }));
    parts.forEach((part, i) => fs.writeFileSync(path.join(folder, part.name), i ? archive.subarray(midpoint) : archive.subarray(0, midpoint)));
    fs.writeFileSync(path.join(folder, 'job.zip.parts.json'), JSON.stringify({ name: 'job.zip', size: archive.length, parts })); fs.writeFileSync(path.join(folder, 'combine.py'), script);
    const run = () => spawnSync('python3', ['combine.py'], { cwd: folder, encoding: 'utf8' });
    const success = run(); assert.equal(success.status, 0, success.stderr); assert.deepEqual(fs.readFileSync(path.join(folder, 'job.zip')), archive);
    assert.notEqual(run().status, 0); assert.deepEqual(fs.readFileSync(path.join(folder, 'job.zip')), archive); fs.unlinkSync(path.join(folder, 'job.zip'));
    fs.writeFileSync(path.join(folder, 'job.zip.partial'), 'keep'); assert.notEqual(run().status, 0); assert.equal(fs.readFileSync(path.join(folder, 'job.zip.partial'), 'utf8'), 'keep'); fs.unlinkSync(path.join(folder, 'job.zip.partial'));
    fs.writeFileSync(path.join(folder, parts[0].name), Buffer.alloc(parts[0].size)); const corrupt = run(); assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /checksum/);
    assert.equal(fs.existsSync(path.join(folder, 'job.zip')), false); assert.equal(fs.existsSync(path.join(folder, 'job.zip.partial')), false);
    fs.unlinkSync(path.join(folder, parts[1].name)); assert.notEqual(run().status, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
