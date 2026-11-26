const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { stampEngine } = require("../scripts/write_build_info.cjs");
const { verifyDeployment, SOURCE_FILES } = require("../scripts/check_deployment.cjs");

async function fixture(t, change = () => {}) {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "geomap-deploy-test-"));
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  const revision = "a".repeat(40), digest = data => createHash("sha256").update(data).digest("hex");
  const runtime={version:1,assets:[{file:'gdal3.js',bytes:3},{file:'gdal3WebAssembly.wasm',bytes:4},{file:'gdal3WebAssembly.data',bytes:5}]};
  const bodies = new Map(SOURCE_FILES.map(file => [file, file === "engine.js" ? 'const BUILD_REVISION = "development"; // GMD_BUILD_REVISION\n' : file==='file-runtime.json'?JSON.stringify(runtime):"source: " + file]));
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
  bodies.set("engine.js", stampEngine(bodies.get("engine.js"), revision));
  const build = { version: 1, revision, builtAt: new Date().toISOString(), runtime: { name: "onnxruntime-web", version: "1.20.1" },
    files: { ...Object.fromEntries([...bodies].map(([file, body]) => [file, digest(body)])), "models/models.json": digest(JSON.stringify(manifest)) },
    models: manifest.map(model => ({ file: model.file, sha256: "b".repeat(64), bytes: 11003776, imgsz: 1024, classes: 2 })) };
  const state = { bodies, manifest, build, status: 200, contentType: "application/octet-stream", bytes: "11003776", calls: [] };
  change(state);
  const fetchImpl = async (url, options) => {
    assert.ok(url.href.startsWith("https://example.test/GeoMap-Detector/"));
    const file = url.pathname.slice("/GeoMap-Detector/".length);
    // HEAD length must describe the model bytes, not a compressed transfer size.
    assert.equal(options.headers["Accept-Encoding"], "identity");
    state.calls.push({ file, method: options.method });
    if(file.startsWith('vendor/ingestion/')){const asset=runtime.assets.find(a=>file.endsWith('/'+a.file));return new Response(null,{status:state.browserStatus||200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(state.browserBytes??asset.bytes)}});}
    if (file === "models/models.json") return new Response(JSON.stringify(state.manifest));
    if (file === "build-info.json") return state.build === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(state.build));
    if (options.method === "HEAD") return new Response(null, { status: state.status, headers: {
      "Content-Type": state.contentType, "Content-Length": state.bytes,
    } });
    assert.ok(state.bodies.has(file), "Unexpected asset: " + file);
    return new Response(state.bodies.get(file));
  };
  return { options: { url: "https://example.test/GeoMap-Detector/", sourceRoot, revision, fetchImpl }, state };
}

test("published source matches and both generated models are checked under the project path", async t => {
  const { options, state } = await fixture(t);
  const result = await verifyDeployment(options);
  assert.equal(result.revision, "a".repeat(40)); assert.equal(result.files.length, SOURCE_FILES.length); assert.equal(result.models.length, 2);
  assert.deepEqual(state.calls.filter(call => call.method === "HEAD").map(call => call.file).sort(),
    ["models/yolo11n-obb.onnx", "models/yolo11s-obb.onnx"]);
});
test("stale JavaScript fails the source comparison", async t => {
  const { options } = await fixture(t, state => state.bodies.set("app.js", "old app"));
  await assert.rejects(verifyDeployment(options), /app\.js: deployed content differs/);
});
test("Pages publishing verifies the configured remote ingestion API", async t => {
  const {options,state}=await fixture(t);
  options.ingestionApiUrl="https://files.example.test";
  state.bodies.set("ingestion-config.json",JSON.stringify({mode:'remote',api_url:options.ingestionApiUrl}));
  assert.equal((await verifyDeployment(options)).ingestion.api_url,options.ingestionApiUrl);
  state.bodies.set("ingestion-config.json",JSON.stringify({api_url:""}));
  await assert.rejects(verifyDeployment(options),/remote API differs/);
});
test('Pages browser mode verifies GIS runtimes without requiring a health API',async t=>{
 const {options,state}=await fixture(t);options.ingestionApiUrl='';state.bodies.set('ingestion-config.json',JSON.stringify({mode:'browser',api_url:''}));
 assert.equal((await verifyDeployment(options)).ingestion.mode,'browser');assert.equal(state.calls.filter(c=>c.file.startsWith('vendor/ingestion/')).length,3);
 state.browserStatus=404;await assert.rejects(verifyDeployment(options),/HTTP 404/);
});
test('wrong browser mode or truncated GIS assets cannot pass Pages verification',async t=>{
 const {options,state}=await fixture(t);options.ingestionApiUrl='';state.bodies.set('ingestion-config.json',JSON.stringify({mode:'remote',api_url:''}));await assert.rejects(verifyDeployment(options),/processing mode differs/);
 state.bodies.set('ingestion-config.json',JSON.stringify({mode:'browser',api_url:''}));state.browserBytes=1;await assert.rejects(verifyDeployment(options),/wrong size/);
});
test("a stale processing worker cannot pass the published source guard", async t => {
  const { options } = await fixture(t, state => state.bodies.set("processing-worker.js", "old worker"));
  await assert.rejects(verifyDeployment(options), /processing-worker\.js: deployed content differs/);
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
test("a build manifest for another revision or mismatched source cannot pass deployment verification", async t => {
  for (const mutate of [state => { state.build.revision = "b".repeat(40); }, state => { state.build.files["app.js"] = "c".repeat(64); }]) {
    const { options } = await fixture(t, mutate);
    await assert.rejects(verifyDeployment(options), /build-info\.json:.*revision|build-info\.json:.*digest/);
  }
});
test("invalid runtime or model provenance cannot pass despite healthy binary URLs", async t => {
  for (const mutate of [state => { state.build.runtime.version = "other"; }, state => { state.build.models[0].sha256 = "invalid"; }, state => { state.build.models[0].bytes++; }]) {
    const { options } = await fixture(t, mutate);
    await assert.rejects(verifyDeployment(options), /build-info\.json/);
  }
});
test("checking without an explicit revision uses the selected public artifact and still verifies source bytes", async t => {
  const { options } = await fixture(t); options.revision = null;
  assert.equal((await verifyDeployment(options)).revision, "a".repeat(40));
});
test("legacy unstamped artifacts remain checkable without a build manifest when no revision is requested", async t => {
  const { options, state } = await fixture(t); options.revision = null; state.build = null;
  state.bodies.set('engine.js', await fs.readFile(path.join(options.sourceRoot,'engine.js'),'utf8'));
  const result = await verifyDeployment(options); assert.equal(result.revision,null); assert.equal(result.build,null);
});
test("an invalid public artifact revision cannot silently downgrade to an unstamped source check", async t => {
  const { options } = await fixture(t,state=>{state.build.revision='invalid'}); options.revision = null;
  await assert.rejects(verifyDeployment(options),/invalid artifact revision/);
});
