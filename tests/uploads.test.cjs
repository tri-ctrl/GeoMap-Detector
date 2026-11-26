const assert = require('node:assert/strict');
const { test } = require('node:test');
const { uploadFile, fingerprint, client } = require('../frontend/uploads.js');

function fixture(size, saved = []) {
  const file = new File([new Uint8Array(size)], 'map.geojson', { lastModified: 123 });
  const session = { id: 'test-id', part_size: 4 };
  const signs = [], completions = [];
  const api = { request: async (path, options = {}) => {
    if (path.endsWith('/parts')) return { parts: saved };
    if (path.endsWith('/complete')) { completions.push(options.body); return { status: 'queued' }; }
    const number = Number(path.split('/').pop()); signs.push(number); return { url: `part:${number}` };
  } };
  return { file, session, signs, completions, api, signal: new AbortController().signal, wait: async () => {} };
}

for (const size of [1, 4, 5, 8, 9]) test(`multipart preserves every byte at size ${size}`, async () => {
  const f = fixture(size), sent = [];
  await uploadFile({ ...f, sendPart: async (url, blob) => { sent.push(blob.size); return url; } });
  assert.equal(sent.reduce((a, b) => a + b, 0), size);
  assert.deepEqual(f.completions[0].parts.map(p => p.part_number), Array.from({ length: Math.ceil(size / 4) }, (_, i) => i + 1));
});

test('resume skips verified stored parts and replaces incorrectly sized parts', async () => {
  const f = fixture(9, [{ part_number: 1, etag: 'saved', size: 4 }, { part_number: 2, etag: 'wrong', size: 2 }]);
  await uploadFile({ ...f, sendPart: async url => url });
  assert.deepEqual(f.signs.sort(), [2, 3]);
  assert.equal(f.completions[0].parts[0].etag, 'saved');
});

test('bounded parallel upload waits for retries and sorts out-of-order ETags', async () => {
  const f = fixture(33), attempts = new Map();
  let active = 0, maximum = 0;
  await uploadFile({ ...f, sendPart: async url => {
    const n = Number(url.split(':')[1]); attempts.set(n, (attempts.get(n) || 0) + 1);
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, n === 1 ? 15 : 1)); active--;
    if (n === 2 && attempts.get(n) === 1) throw new Error('expired signature');
    return `etag-${n}`;
  } });
  assert.equal(maximum, 3); assert.equal(attempts.get(2), 2);
  assert.deepEqual(f.completions[0].parts.map(p => p.etag), Array.from({ length: 9 }, (_, i) => `etag-${i + 1}`));
});

test('permanent part failure aborts siblings and never completes the object', async () => {
  const f = fixture(20); let inflight = 0;
  await assert.rejects(uploadFile({ ...f, sendPart: async (_url, _blob, signal) => {
    inflight++; await new Promise(resolve => setTimeout(resolve, 1)); inflight--;
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    throw new Error('failed');
  } }), /failed/);
  assert.equal(inflight, 0); assert.equal(f.completions.length, 0);
});

test('pausing rejects without sending completion', async () => {
  const f = fixture(12), owner = new AbortController();
  await assert.rejects(uploadFile({ ...f, signal: owner.signal, sendPart: async () => { owner.abort(); throw new DOMException('paused', 'AbortError'); } }), { name: 'AbortError' });
  assert.equal(f.completions.length, 0);
});

test('fingerprint is stable and distinguishes filename, mtime and content', async () => {
  const file = new File(['map data'], 'map.geojson', { lastModified: 1 });
  assert.equal(await fingerprint(file), await fingerprint(file));
  assert.notEqual(await fingerprint(file), await fingerprint(new File(['map data'], 'map.geojson', { lastModified: 2 })));
  assert.notEqual(await fingerprint(file), await fingerprint(new File(['changed!'], 'map.geojson', { lastModified: 1 })));
});

test('API errors preserve actionable text and status without treating HTML as JSON', async () => {
  const api = client('http://localhost:8095/', async () => ({ ok: false, status: 409, json: async () => ({ detail: 'Upload cancelled' }) }));
  await assert.rejects(api.request('/test'), error => error.status === 409 && error.message === 'Upload cancelled');
  assert.throws(() => client('javascript:bad'), /HTTP/);
});
