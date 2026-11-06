const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "../frontend/engine.js"), "utf8");
function setup() {
  const scripts = [], timers = new Set();
  const context = vm.createContext({ document: {
    createElement: () => ({ remove() { this.removed = true; } }), head: { append: script => scripts.push(script) },
  }, setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: timer => timers.delete(timer) });
  vm.runInContext(source, context);
  return { context, engine: context.GVEngine, scripts, timers };
}
test("map-only engine initialization requests no optional scripts", () => {
  const { scripts } = setup(); assert.equal(scripts.length, 0);
  const html = readFileSync(path.join(__dirname, "../frontend/index.html"), "utf8");
  const scriptsInHtml = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(!scriptsInHtml.some(url => /onnxruntime|leaflet\.draw|fflate|jszip/i.test(url)));
});
test("concurrent first use shares a loader and configures pinned ORT before consumers continue", async () => {
  const { context, engine, scripts, timers } = setup();
  const first = engine.ensureLibrary("ort"), second = engine.ensureLibrary("ort");
  assert.equal(first, second); assert.equal(scripts.length, 1);
  context.ort = { InferenceSession: {}, env: { wasm: {} } }; scripts[0].onload();
  await first;
  assert.equal(context.ort.env.wasm.numThreads, 1);
  assert.match(context.ort.env.wasm.wasmPaths, /onnxruntime-web@1\.20\.1\/dist\/$/);
  await engine.ensureLibrary("ort"); assert.equal(scripts.length, 1); assert.equal(timers.size, 0);
});
test("CDN errors and missing globals remove failed loaders so a later action can retry", async () => {
  const { context, engine, scripts, timers } = setup();
  const first = engine.ensureLibrary("zip"); scripts[0].onerror(); await assert.rejects(first, /Could not load.*Try again/);
  assert.ok(scripts[0].removed);
  const second = engine.ensureLibrary("zip"); scripts[1].onload(); await assert.rejects(second, /did not initialize/);
  const third = engine.ensureLibrary("zip"); context.JSZip = function () {}; scripts[2].onload(); await third;
  assert.equal(timers.size, 0); assert.equal(scripts.length, 3);
});
test("a stalled dependency times out, releases its handles and permits retry", async () => {
  const { engine, scripts, timers } = setup();
  const pending = engine.ensureLibrary("draw"); [...timers][0]();
  await assert.rejects(pending, /Timed out loading/);
  assert.ok(scripts[0].removed); assert.equal(timers.size, 0);
});
test("a processing worker can load pinned runtime assets without a window", async () => {
  const loaded = [], context = vm.createContext({});
  context.importScripts = url => { loaded.push(url); context.fflate = { zlibSync() {} }; };
  vm.runInContext(source, context); await context.GVEngine.ensureLibrary("fflate");
  assert.match(loaded[0], /fflate@0\.8\.2/);
});
