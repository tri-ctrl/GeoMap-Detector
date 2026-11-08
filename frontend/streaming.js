/* Bounded native encoders and archive sinks. Loaded on first processing/export
 * use; no DOM, file picker or worker assumptions. Storage owns durable chunks.
 */
(function (global) {
"use strict";
const CHUNK = 262144, PART = 16 * 1024 * 1024, MAX_QUEUE = 1048576;
const memory = new Map(); let memoryBytes = 0;
const stats = { pendingBytes: 0, peakPendingBytes: 0, bytesWritten: 0, chunksWritten: 0, activeWriters: 0, cleanupFailures: 0 };
const engine = () => global.GVEngine, check = signal => engine().operations.check(signal), pause = signal => engine().operations.yield(signal);
const fail = (code, message) => Object.assign(new Error(message), { code });
const utf8 = text => global.fflate.strToU8(text);
async function bytes(value) { return value instanceof Uint8Array ? value : value?.arrayBuffer ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value); }
async function createSpool(options = {}) {
  check(options.signal);
  if (options.store?.state().available && options.store.state().writable) return options.store.createSpool(options);
  const id = global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const records = new Map(), maxBytes = Math.min(options.maxBytes || 32 * 1024 * 1024, 32 * 1024 * 1024);
  const spool = { id, maxChunkBytes: MAX_QUEUE, persistent: false,
    async put(file, sequence, value) {
      check(options.signal); const data = await bytes(value);
      if (data.length > MAX_QUEUE || memoryBytes + data.length > maxBytes) throw fail("SPOOL_LIMIT", "Session-only imagery/output exceeds its bounded storage. Enable IndexedDB or use a smaller AOI.");
      const key = file + ":" + sequence; memoryBytes -= records.get(key)?.length || 0;
      records.set(key, data.slice()); memoryBytes += data.length;
    },
    async get(file, sequence) { const value = records.get(file + ":" + sequence); if (!value) throw fail("MISSING_CHUNK", "An image/output chunk is missing"); return value; },
    async removeFile(file) { for (const [key, value] of records) if (key.startsWith(file + ":")) { records.delete(key); memoryBytes -= value.length; } },
    async dispose() { for (const value of records.values()) memoryBytes -= value.length; records.clear(); memory.delete(id); },
    state: () => ({ id, bytes: [...records.values()].reduce((n, value) => n + value.length, 0), maxBytes }),
  };
  memory.set(id, spool); return spool;
}
async function discard(spool) { try { await spool?.dispose(); } catch (error) { stats.cleanupFailures++; throw error; } }
async function* source(value, { store, signal } = {}) {
  check(signal);
  if (typeof value === "string") {
    // Encode bounded substrings without splitting a UTF-16 surrogate pair.
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 65536);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      check(signal); yield utf8(value.slice(offset, end)); offset = end;
    }
  } else if (value?.gmdArtifact === 1) {
    if (!Number.isSafeInteger(value.size) || value.size < 0 || !Number.isSafeInteger(value.chunks) || value.chunks < 0 || value.chunks > 1000000)
      throw fail("INVALID_ARTIFACT", "Invalid chunked image/output metadata");
    let length = 0;
    for (let i = 0; i < value.chunks; i++) {
      check(signal);
      const chunk = memory.has(value.spool) ? await memory.get(value.spool).get(value.file, i) : await store?.readArtifactChunk(value, i);
      if (!chunk || (chunk.size ?? chunk.byteLength) > MAX_QUEUE) throw fail("MISSING_CHUNK", "A saved image/output chunk is missing or oversized");
      const data = await bytes(chunk); length += data.length; check(signal); yield data;
    }
    if (length !== value.size) throw fail("INVALID_ARTIFACT", "Saved image/output byte count does not match its manifest");
  } else if (value?.slice && typeof value.size === "number") {
    for (let offset = 0; offset < value.size; offset += CHUNK) { check(signal); const data = await bytes(value.slice(offset, offset + CHUNK)); check(signal); yield data; }
  } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const data = await bytes(value); for (let offset = 0; offset < data.length; offset += CHUNK) { check(signal); yield data.subarray(offset, offset + CHUNK); }
  } else if (value?.[Symbol.asyncIterator] || value?.[Symbol.iterator]) {
    for await (const input of value) {
      check(signal);
      if (typeof input === "string") { yield* source(input, { signal }); continue; }
      const data = await bytes(input);
      for (let offset = 0; offset < data.length; offset += CHUNK) { check(signal); yield data.subarray(offset, offset + CHUNK); }
    }
  } else if (value != null) {
    const data = await bytes(value); for (let offset = 0; offset < data.length; offset += CHUNK) { check(signal); yield data.subarray(offset, offset + CHUNK); }
  }
}
function sink(spool, file, type, { signal, chunkBytes = CHUNK } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK) throw fail("INVALID_BUFFER", "Invalid output chunk size");
  let buffer = new Uint8Array(chunkBytes), used = 0, size = 0, chunks = 0, closed = false, writing = false;
  async function flush() {
    if (!used) return;
    const data = buffer.subarray(0, used); check(signal); await spool.put(file, chunks++, data); check(signal);
    stats.bytesWritten += used; stats.chunksWritten++; used = 0;
  }
  return {
    async write(input) {
      if (closed || writing) throw fail("WRITER_STATE", "Output requires sequential awaited writes");
      writing = true;
      try {
        const data = await bytes(input); check(signal);
        for (let offset = 0; offset < data.length;) {
          const count = Math.min(buffer.length - used, data.length - offset); buffer.set(data.subarray(offset, offset + count), used);
          used += count; offset += count; size += count; if (used === buffer.length) await flush();
        }
      } finally { writing = false; }
    },
    async close() { check(signal); if (closed || writing) throw fail("WRITER_STATE", "Output is already closed or writing"); await flush(); closed = true; buffer = null; return { gmdArtifact: 1, spool: spool.id, file, type, size, chunks }; },
    async abort() { if (closed) return; closed = true; buffer = null; await spool.removeFile(file); },
  };
}
function queue() {
  let pending = [], held = 0;
  return {
    push(value) {
      held += value.length; stats.pendingBytes += value.length; stats.peakPendingBytes = Math.max(stats.peakPendingBytes, stats.pendingBytes);
      if (held > MAX_QUEUE) throw fail("ENCODER_QUEUE_LIMIT", "Encoder exceeded its bounded output queue"); pending.push(value);
    },
    async drain(write, signal) {
      for (const value of pending) { check(signal); await write(value); stats.pendingBytes -= value.length; held -= value.length; }
      pending = [];
    },
    clear() { stats.pendingBytes -= held; held = 0; pending = []; },
  };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(data, crc = 0xffffffff) { for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ crc >>> 8; return crc >>> 0; }
function pngChunk(name, data) {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer); view.setUint32(0, data.length);
  result.set(utf8(name), 4); result.set(data, 8); view.setUint32(result.length - 4, (crc32(result.subarray(4, result.length - 4)) ^ 0xffffffff) >>> 0); return result;
}
function rowCount(width) {
  if (!Number.isSafeInteger(width) || width < 1 || width * 4 + 1 > CHUNK) throw fail("NATIVE_ROW_LIMIT", "One native image row exceeds the bounded writer. Split this very wide AOI.");
  return Math.max(1, Math.min(64, Math.floor(CHUNK / (width * 4 + 1))));
}
async function png(raster, output, { signal } = {}) {
  const { w, h } = raster, rows = rowCount(w), pending = queue();
  if (!Number.isSafeInteger(h) || h < 1 || w > 0x7fffffff || h > 0x7fffffff) throw fail("PNG_SIZE_LIMIT", "Native PNG dimensions exceed the format limit");
  stats.activeWriters++;
  try {
    await output.write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, w); view.setUint32(4, h); header[8] = 8; header[9] = 6;
    await output.write(pngChunk("IHDR", header));
    const compressor = new global.fflate.Zlib({ level: 6 }, data => pending.push(data));
    for (let y = 0; y < h; y += rows) {
      check(signal); const count = Math.min(rows, h - y), pixels = await raster.readPixels(0, y, w, count); check(signal);
      if (pixels.length !== w * count * 4) throw fail("INVALID_ROWS", "Native PNG source returned an invalid RGBA row buffer");
      const filtered = new Uint8Array(count * (w * 4 + 1));
      for (let i = 0; i < count; i++) filtered.set(pixels.subarray(i * w * 4, (i + 1) * w * 4), i * (w * 4 + 1) + 1);
      compressor.push(filtered, y + count === h);
      await pending.drain(data => output.write(pngChunk("IDAT", data)), signal); await pause(signal);
    }
    await output.write(pngChunk("IEND", new Uint8Array(0))); return await output.close();
  } finally { pending.clear(); stats.activeWriters--; }
}
async function tiff(raster, output, spool, { signal } = {}) {
  const { w, h, res, x0, y0 } = raster, rows = rowCount(w), lengths = [], offsets = []; let total = 8;
  if (!Number.isFinite(res) || res <= 0 || !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isSafeInteger(h) || h < 1 || h > 0xffffffff) throw fail("INVALID_TIFF", "Invalid native GeoTIFF dimensions or transform");
  stats.activeWriters++;
  try {
    for (let y = 0; y < h; y += rows) {
      check(signal); const count = Math.min(rows, h - y), pixels = await raster.readPixels(0, y, w, count); check(signal);
      if (pixels.length !== w * count * 4) throw fail("INVALID_ROWS", "Native TIFF source returned an invalid RGBA row buffer");
      const encoded = global.fflate.zlibSync(pixels, { level: 6 });
      if (lengths.length >= 20000 || total + encoded.length > 0xffffffff) throw fail("TIFF_SIZE_LIMIT", "Classic TIFF strip metadata or 32-bit offsets exceed the bounded writer. Split this output.");
      offsets.push(total); total += encoded.length; lengths.push(encoded.length);
      await spool.put("tiff-strips", lengths.length - 1, encoded); await pause(signal);
    }
    const ifd = total + total % 2, tags = [
      [256, 4, [w]], [257, 4, [h]], [258, 3, [8, 8, 8, 8]], [259, 3, [8]], [262, 3, [2]], [273, 4, offsets],
      [277, 3, [4]], [278, 4, [rows]], [279, 4, lengths], [284, 3, [1]], [338, 3, [2]], [339, 3, [1, 1, 1, 1]],
      [33550, 12, [res, res, 0]], [33922, 12, [0, 0, 0, x0, y0, 0]], [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857]],
    ];
    const sizes = { 3: 2, 4: 4, 12: 8 }; let end = ifd + 2 + 12 * tags.length + 4;
    const extra = tags.map(([, type, values]) => { const length = sizes[type] * values.length; if (length <= 4) return null; const offset = end; end += length + length % 2; return offset; });
    if (end > 0xffffffff || end - ifd > MAX_QUEUE) throw fail("TIFF_SIZE_LIMIT", "Classic TIFF directory exceeds its offset/buffer limit");
    const header = new Uint8Array(8), head = new DataView(header.buffer); head.setUint16(0, 0x4949); head.setUint16(2, 42, true); head.setUint32(4, ifd, true); await output.write(header);
    for (let i = 0; i < lengths.length; i++) { check(signal); await output.write(await spool.get("tiff-strips", i)); }
    if (total % 2) await output.write(new Uint8Array(1));
    const tail = new Uint8Array(end - ifd), view = new DataView(tail.buffer); view.setUint16(0, tags.length, true);
    const put = (offset, type, value) => type === 3 ? view.setUint16(offset, value, true) : type === 4 ? view.setUint32(offset, value, true) : view.setFloat64(offset, value, true);
    tags.forEach(([tag, type, values], i) => {
      const entry = 2 + i * 12; view.setUint16(entry, tag, true); view.setUint16(entry + 2, type, true); view.setUint32(entry + 4, values.length, true);
      if (extra[i] != null) view.setUint32(entry + 8, extra[i], true);
      values.forEach((value, k) => put((extra[i] == null ? entry + 8 : extra[i] - ifd) + k * sizes[type], type, value));
    });
    await output.write(tail); const result = await output.close(); await spool.removeFile("tiff-strips"); return result;
  } finally { stats.activeWriters--; }
}
function zip(output, { signal, maxBytes = 0xffffffff } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffffffff) throw fail("ZIP_SIZE_LIMIT", "Invalid Classic ZIP byte limit");
  const pending = queue(); let files = 0, metadata = 0, size = 0, failure, closed = false;
  const archive = new global.fflate.Zip((error, data) => { if (error) failure = error; else pending.push(data); }); stats.activeWriters++;
  const drain = () => pending.drain(async data => {
    if (size + data.length > maxBytes) throw fail("ZIP_SIZE_LIMIT", "Classic ZIP exceeds its byte limit (at most 4 GiB). Export individual clips instead.");
    size += data.length; await output.write(data);
  }, signal);
  return {
    async add(name, inputs, { compress = false } = {}) {
      check(signal);
      if (closed || !name || name.startsWith("/") || name.split("/").some(piece => piece === "..") || utf8(name).length > 1024) throw fail("ZIP_PATH", "Invalid archive path");
      metadata += utf8(name).length + 64;
      if (++files > 4096 || metadata > CHUNK) throw fail("ZIP_METADATA_LIMIT", "Archive directory exceeds its bounded metadata limit. Export individual clips.");
      const file = compress ? new global.fflate.ZipDeflate(name, { level: 1 }) : new global.fflate.ZipPassThrough(name);
      archive.add(file); await drain(); let inputBytes = 0;
      for await (const chunk of source(inputs, { signal })) { check(signal); inputBytes += chunk.length; if (inputBytes > maxBytes) throw fail("ZIP_SIZE_LIMIT", "One uncompressed file exceeds the Classic ZIP byte limit. Export smaller clips."); file.push(chunk); if (failure) throw failure; await drain(); await pause(signal); }
      file.push(new Uint8Array(0), true); if (failure) throw failure; await drain();
    },
    async close() { check(signal); archive.end(); if (failure) throw failure; await drain(); const result = await output.close(); closed = true; stats.activeWriters--; return result; },
    async abort() { if (!closed) { closed = true; archive.terminate(); pending.clear(); stats.activeWriters--; await output.abort?.(); } },
  };
}
function output(spool, { name, signal, destination, partBytes = PART } = {}) {
  if (destination) {
    let closed = false;
    return { write: async data => { check(signal); await destination.write(data); check(signal); },
      close: async () => { check(signal); await destination.close(); closed = true; return { saved: true, name }; },
      abort: async () => { if (!closed) { closed = true; await destination.abort?.(); } } };
  }
  if (!Number.isSafeInteger(partBytes) || partBytes < CHUNK || partBytes > PART) throw fail("PART_LIMIT", "Invalid bounded download part size");
  const parts = []; let current = sink(spool, "part-0", "application/octet-stream", { signal }), size = 0, closed = false, crc = 0xffffffff;
  async function finish() { const part = await current.close(); if (part.size) parts.push({ ...part, crc32: (crc ^ 0xffffffff) >>> 0, name: name + "." + String(parts.length + 1).padStart(3, "0") }); }
  return {
    async write(input) {
      const data = await bytes(input);
      for (let offset = 0; offset < data.length;) {
        if (size === partBytes) { await finish(); current = sink(spool, "part-" + parts.length, "application/octet-stream", { signal }); size = 0; crc = 0xffffffff; }
        const count = Math.min(partBytes - size, data.length - offset), chunk = data.subarray(offset, offset + count); crc = crc32(chunk, crc); await current.write(chunk); offset += count; size += count;
      }
    },
    async close() { check(signal); await finish(); closed = true; return { name, parts, spool: spool.id, bytes: parts.reduce((n, part) => n + part.size, 0) }; },
    abort: async () => { if (!closed) { closed = true; await current.abort(); } },
  };
}
async function materialize(artifact, { store, signal, maxBytes = PART } = {}) {
  if (artifact.size > maxBytes) throw fail("PART_LIMIT", "Artifact exceeds the bounded download part limit");
  const chunks = []; for await (const chunk of source(artifact, { store, signal })) chunks.push(chunk);
  check(signal); return new Blob(chunks, { type: artifact.type || "application/octet-stream" });
}
async function* collection(features, properties = {}) {
  yield JSON.stringify({ type: "FeatureCollection", ...properties }).slice(0, -1) + ',"features":[';
  let first = true; for await (const feature of features) { yield (first ? "" : ",") + JSON.stringify(feature); first = false; } yield "]}";
}
// Integrate even-odd polygon coverage over each boundary pixel in global image
// coordinates. Canvas clips diagonal edges differently for different target
// sizes; this deterministic area mask is independent of block/window boundaries.
function masker(rings) {
  const edges = rings.flatMap(ring => ring.slice(1).map((point, i) => {
    const a = ring[i], b = point; return { a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
  }));
  const at = (edge, y) => edge.a[0] + (y - edge.a[1]) * (edge.b[0] - edge.a[0]) / (edge.b[1] - edge.a[1]);
  const crossings = (active, y) => active.filter(e => e.a[1] > y !== e.b[1] > y).map(e => at(e, y)).sort((a, b) => a - b);
  function coverage(active, x, y) {
    const local = active.filter(e => e.maxX >= x && e.minX <= x + 1);
    if (local.length > 64) throw fail("MASK_COMPLEXITY_LIMIT", "Too many polygon edges cross one pixel. Simplify or split this AOI without changing its intended area.");
    const cuts = [y, y + 1];
    for (const e of local) {
      for (const p of [e.a, e.b]) if (p[1] > y && p[1] < y + 1) cuts.push(p[1]);
      if (e.b[0] !== e.a[0]) for (const border of [x, x + 1]) {
        const t = (border - e.a[0]) / (e.b[0] - e.a[0]), v = e.a[1] + t * (e.b[1] - e.a[1]);
        if (t > 0 && t < 1 && v > y && v < y + 1) cuts.push(v);
      }
    }
    for (let i = 0; i < local.length; i++) for (let j = i + 1; j < local.length; j++) {
      const a = local[i].a, b = local[i].b, c = local[j].a, d = local[j].b;
      const ax = b[0] - a[0], ay = b[1] - a[1], bx = d[0] - c[0], by = d[1] - c[1], det = ax * by - ay * bx;
      if (!det) continue;
      const t = ((c[0] - a[0]) * by - (c[1] - a[1]) * bx) / det, u = ((c[0] - a[0]) * ay - (c[1] - a[1]) * ax) / det;
      const px = a[0] + t * ax, py = a[1] + t * ay;
      if (t > 0 && t < 1 && u > 0 && u < 1 && px > x && px < x + 1 && py > y && py < y + 1) cuts.push(py);
    }
    cuts.sort((a, b) => a - b); let area = 0;
    for (let i = 1; i < cuts.length; i++) {
      const height = cuts[i] - cuts[i - 1]; if (height <= 0) continue;
      const spans = crossings(active, (cuts[i] + cuts[i - 1]) / 2); let width = 0;
      for (let j = 1; j < spans.length; j += 2) width += Math.max(0, Math.min(x + 1, spans[j]) - Math.max(x, spans[j - 1]));
      area += width * height;
    }
    return Math.max(0, Math.min(255, Math.round(area * 255)));
  }
  return async function apply(data, left, top, width, height, signal) {
    let lastYield = Date.now();
    for (let row = 0; row < height; row++) {
      check(signal); const y = top + row, active = edges.filter(e => e.maxY >= y && e.minY <= y + 1);
      const boundary = new Uint8Array(width), spans = crossings(active, y + .5);
      for (const e of active) {
        if (e.maxX < left || e.minX > left + width) continue;
        const a = e.a[1] === e.b[1] ? e.minX : at(e, Math.max(y, e.minY)), b = e.a[1] === e.b[1] ? e.maxX : at(e, Math.min(y + 1, e.maxY));
        const start = Math.max(0, Math.floor(Math.min(a, b)) - left - 1), end = Math.min(width, Math.ceil(Math.max(a, b)) - left + 1);
        boundary.fill(1, start, end);
      }
      let index = 0;
      for (let col = 0; col < width; col++) {
        const x = left + col; while (index < spans.length && spans[index] < x + .5) index++;
        const alpha = boundary[col] ? coverage(active, x, y) : index % 2 ? 255 : 0, offset = (row * width + col) * 4, originalAlpha = data[offset + 3];
        if (alpha === 255) continue;
        const outAlpha = Math.round(originalAlpha * alpha / 255);
        for (let c = 0; c < 3; c++) { const premult = Math.round(Math.round(data[offset + c] * originalAlpha / 255) * alpha / 255); data[offset + c] = outAlpha ? Math.round(premult * 255 / outAlpha) : 0; }
        data[offset + 3] = outAlpha;
      }
      if (Date.now() - lastYield >= 8) { await pause(signal); lastYield = Date.now(); }
    }
    check(signal); return data;
  };
}
global.GVStreaming = { CHUNK, PART, MAX_QUEUE, createSpool, discard, source, sink, png, tiff, zip, output, materialize, collection,
  masker,
  diagnostics: () => ({ ...stats, memorySpools: memory.size, memoryBytes }),
  async discardArtifact(id, store) { if (memory.has(id)) await discard(memory.get(id)); else await store?.discardSpool(id); },
};
})(typeof window !== "undefined" ? window : globalThis);
