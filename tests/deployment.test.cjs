const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyDeployment, SOURCE_FILES } = require("../scripts/check_deployment.cjs");

async function fixture(t, change = () => {}) {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "geomap-deploy-test-"));
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  const bodies = new Map(SOURCE_FILES.map(file => [file, "source: " + file]));
  await Promise.all([...bodies].map(async ([file, body]) => {
    await fs.mkdir(path.dirname(path.join(sourceRoot, file)), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, file), body);
  }));
  // Generated manifests may contain more models than the checked-in placeholder.
  await fs.mkdir(path.join(sourceRoot, "models"));
  await fs.writeFile(path.join(sourceRoot, "models/models.json"), "[]");
  const manifest = ["yolo11n-obb.onnx", "yolo11s-obb.onnx"].map(file => ({
    file, names: ["plane", "ship"], imgsz: 1024, size_mb: 11,
  }));
  const state = { bodies, manifest, status: 200, contentType: "application/octet-stream", bytes: "11003776", calls: [] };
  change(state);
  const fetchImpl = async (url, options) => {
    assert.ok(url.href.startsWith("https://example.test/GeoMap-Detector/"));
    const file = url.pathname.slice("/GeoMap-Detector/".length);
    // HEAD length must describe the model bytes, not a compressed transfer size.
    assert.equal(options.headers["Accept-Encoding"], "identity");
    state.calls.push({ file, method: options.method });
    if (file === "models/models.json") return new Response(JSON.stringify(state.manifest));
    if (options.method === "HEAD") return new Response(null, { status: state.status, headers: {
      "Content-Type": state.contentType, "Content-Length": state.bytes,
    } });
    assert.ok(state.bodies.has(file), "Unexpected asset: " + file);
    return new Response(state.bodies.get(file));
  };
  return { options: { url: "https://example.test/GeoMap-Detector/", sourceRoot, revision: "test-sha", fetchImpl }, state };
}

test("published source matches and both generated models are checked under the project path", async t => {
  const { options, state } = await fixture(t);
  const result = await verifyDeployment(options);
  assert.equal(result.revision, "test-sha"); assert.equal(result.files.length, 4); assert.equal(result.models.length, 2);
  assert.deepEqual(state.calls.filter(call => call.method === "HEAD").map(call => call.file).sort(),
    ["models/yolo11n-obb.onnx", "models/yolo11s-obb.onnx"]);
});
test("stale JavaScript fails the source comparison", async t => {
  const { options } = await fixture(t, state => state.bodies.set("app.js", "old app"));
  await assert.rejects(verifyDeployment(options), /app\.js: deployed content differs/);
});
test("a missing small model entry fails even when nano exists", async t => {
  const { options } = await fixture(t, state => state.manifest.pop());
  await assert.rejects(verifyDeployment(options), /missing yolo11s-obb\.onnx/);
});
test("an unavailable model binary fails despite a valid dropdown manifest", async t => {
  const { options } = await fixture(t, state => { state.status = 404; });
  await assert.rejects(verifyDeployment(options), /HTTP 404/);
});
test("HTML fallback pages cannot pass as models", async t => {
  const { options } = await fixture(t, state => { state.contentType = "text/html"; });
  await assert.rejects(verifyDeployment(options), /model URL returns HTML/);
});
test("empty models and manifest size mismatches fail", async t => {
  for (const bytes of ["0", "123"]) {
    const { options } = await fixture(t, state => { state.bytes = bytes; });
    await assert.rejects(verifyDeployment(options), /model size is empty|downloaded size .* differs/);
  }
});
test("model paths cannot escape the published models directory", async t => {
  const { options } = await fixture(t, state => state.manifest.push({ file: "../weights.onnx", names: ["plane"], imgsz: 1024 }));
  await assert.rejects(verifyDeployment(options), /invalid model filename/);
});
