const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../frontend/engine.js"), "utf8");
const spec = { key: "nano", url: "models/yolo11n-obb.onnx", imgsz: 1024, names: ["plane"] };
const modelBytes = new Uint8Array([8, 9, 18, 0]);

function setup({ fetchModel, gpu = false, failGpu = false } = {}) {
  const downloads = [], sessions = [];
  const context = vm.createContext({
    AbortController, DOMException,
    navigator: gpu ? { gpu: {} } : {},
    fetch: async (...args) => {
      downloads.push(args);
      return fetchModel ? fetchModel(...args) : new Response(modelBytes);
    },
    ort: { InferenceSession: { create: async (data, options) => {
      const provider = options.executionProviders[0];
      sessions.push({ data, provider });
      if (failGpu && provider === "webgpu") throw new Error("WebGPU unavailable");
      return { inputNames: ["images"], outputNames: ["output0"] };
    } } },
  });
  vm.runInContext(source, context);
  return { engine: context.GVEngine, downloads, sessions };
}

test("missing model reports its URL, HTTP status and recovery before creating a session; retry works", async () => {
  let available = false;
  const { engine, downloads, sessions } = setup({
    gpu: true,
    fetchModel: () => available ? new Response(modelBytes) : new Response("Not Found", { status: 404 }),
  });
  await assert.rejects(engine.loadModel(spec), error => {
    assert.match(error.message, /models\/yolo11n-obb\.onnx.*HTTP 404/);
    assert.match(error.message, /scripts\/export_onnx\.py/);
    assert.match(error.message, /GitHub Actions/);
    return true;
  });
  assert.equal(downloads.length, 1);
  assert.equal(sessions.length, 0);
  available = true;
  assert.equal((await engine.loadModel(spec)).provider, "webgpu");
  assert.equal(downloads.length, 2);
});

test("WebGPU fallback reuses downloaded bytes and the loaded model is cached", async () => {
  const { engine, downloads, sessions } = setup({ gpu: true, failGpu: true });
  const model = await engine.loadModel(spec);
  assert.equal(model.provider, "wasm");
  assert.equal(model.imgsz, 1024);
  assert.equal(model.names, spec.names);
  assert.deepEqual(sessions.map(s => s.provider), ["webgpu", "wasm"]);
  assert.deepEqual(Array.from(sessions[0].data), Array.from(modelBytes));
  assert.equal(sessions[0].data, sessions[1].data);
  assert.equal(await engine.loadModel(spec), model);
  assert.equal(downloads.length, 1);
});

test("a browser without WebGPU loads model bytes with WASM", async () => {
  const { engine, downloads, sessions } = setup();
  assert.equal((await engine.loadModel(spec)).provider, "wasm");
  assert.deepEqual(sessions.map(s => s.provider), ["wasm"]);
  assert.deepEqual(Array.from(sessions[0].data), Array.from(modelBytes));
  assert.equal(downloads.length, 1);
});

test("an HTML fallback page is rejected before ONNX parsing", async () => {
  const { engine, sessions } = setup({ fetchModel: () => new Response("<!doctype html>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }) });
  await assert.rejects(engine.loadModel(spec), /HTML page instead of ONNX model/);
  assert.equal(sessions.length, 0);
});

test("an empty model response is rejected before ONNX parsing", async () => {
  const { engine, sessions } = setup({ fetchModel: () => new Response(new Uint8Array()) });
  await assert.rejects(engine.loadModel(spec), /ONNX model .* is empty/);
  assert.equal(sessions.length, 0);
});

test("network failures identify the model URL", async () => {
  const { engine, sessions } = setup({ fetchModel: () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(engine.loadModel(spec), /Could not download ONNX model models\/yolo11n-obb\.onnx: Failed to fetch/);
  assert.equal(sessions.length, 0);
});

test("cancelling the model download preserves AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const { engine, downloads, sessions } = setup({ fetchModel: (_url, options) => {
    options.signal.throwIfAborted();
  } });
  await assert.rejects(engine.loadModel({ ...spec, signal: controller.signal }), { name: "AbortError" });
  assert.equal(downloads.length, 0);
  assert.equal(sessions.length, 0);
});

test("a user-supplied ONNX buffer loads without downloading a model", async () => {
  const { engine, downloads, sessions } = setup();
  await engine.loadModel({ ...spec, key: "custom", buffer: modelBytes });
  assert.equal(downloads.length, 0);
  assert.equal(sessions[0].data, modelBytes);
});
