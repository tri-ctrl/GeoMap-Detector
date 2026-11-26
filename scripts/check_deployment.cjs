/* Verify published source bytes and generated model URLs without ML dependencies. */
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { SOURCE_FILES, stampEngine } = require("./write_build_info.cjs");

const DEFAULT_MODELS = ["yolo11n-obb.onnx", "yolo11s-obb.onnx"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function verifyDeployment({ url, sourceRoot = path.resolve(__dirname, "../frontend"), revision = null, fetchImpl = fetch, ingestionApiUrl }) {
  const base = new URL(url);
  if (!["http:", "https:"].includes(base.protocol) || !base.pathname.endsWith("/") || base.search || base.hash)
    throw new Error("The deployment URL must be an HTTP(S) directory URL ending in /, without query or fragment");
  async function request(file, method = "GET") {
    let response;
    try {
      response = await fetchImpl(new URL(file, base), { method, cache: "no-cache",
        headers: { "Cache-Control": "no-cache", "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw new Error(`${file}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}`);
    }
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return response;
  }
  let build = null;
  if (!revision) {
    try {
      build = await (await request("build-info.json")).json();
      if (!/^[a-f0-9]{40}$/.test(build?.revision)) throw new Error("build-info.json: invalid artifact revision");
      revision = build.revision;
    }
    catch (error) { if (error.message !== "build-info.json: HTTP 404") throw error; }
  }
  const files = await Promise.all(SOURCE_FILES.map(async file => {
    let expected = await readFile(path.join(sourceRoot, file));
    if (revision && file === "engine.js") expected = Buffer.from(stampEngine(expected.toString("utf8"), revision));
    const response = await request(file);
    const actual = new Uint8Array(await response.arrayBuffer());
    if (digest(actual) !== digest(expected)) throw new Error(`${file}: deployed content differs from the checked-out source`);
    return { file, bytes: actual.byteLength, sha256: digest(actual) };
  }));
  // This manifest is generated/restored during the build; the checked-in placeholder
  // is intentionally not used for a byte comparison or as the list of shipped models.
  const manifestResponse = await request("models/models.json"), manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("The published model manifest is empty or invalid");
  for (const file of DEFAULT_MODELS) {
    if (!manifest.some(entry => entry && entry.file === file)) throw new Error(`The published model manifest is missing ${file}`);
  }
  const models = await Promise.all(manifest.map(async entry => {
    if (!entry || typeof entry.file !== "string" || !/^[\w.-]+\.onnx$/.test(entry.file))
      throw new Error("The published manifest contains an invalid model filename");
    if (!Array.isArray(entry.names) || !entry.names.length || !entry.names.every(name => typeof name === "string" && name.length))
      throw new Error(`${entry.file}: class names are missing or invalid`);
    if (!Number.isInteger(entry.imgsz) || entry.imgsz < 1) throw new Error(`${entry.file}: input size is invalid`);
    const response = await request("models/" + entry.file, "HEAD");
    if ((response.headers.get("content-type") || "").toLowerCase().includes("text/html"))
      throw new Error(`${entry.file}: the model URL returns HTML`);
    const bytes = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${entry.file}: model size is empty or unavailable`);
    if (Number.isFinite(entry.size_mb) && Math.abs(bytes / 1e6 - entry.size_mb) > 0.051)
      throw new Error(`${entry.file}: downloaded size ${bytes} bytes differs from the published ${entry.size_mb} MB`);
    return { file: entry.file, bytes, imgsz: entry.imgsz, classes: entry.names.length };
  }));
  if (revision) {
    build ||= await (await request("build-info.json")).json();
    if (build?.version !== 1 || build.revision !== revision || typeof build.builtAt !== "string" || !Number.isFinite(Date.parse(build.builtAt))
      || build.runtime?.name !== "onnxruntime-web" || build.runtime.version !== "1.20.1" || !Array.isArray(build.models) || build.models.length !== models.length)
      throw new Error("build-info.json: revision/runtime/model provenance differs from the selected artifact");
    for (const file of files) if (build.files?.[file.file] !== file.sha256) throw new Error(`build-info.json: ${file.file} digest differs from published source`);
    if (build.files?.["models/models.json"] !== digest(manifestBytes)) throw new Error("build-info.json: model manifest digest differs");
    for (const model of models) {
      const recorded = build.models.find(entry => entry.file === model.file);
      if (!recorded || recorded.bytes !== model.bytes || recorded.imgsz !== model.imgsz || recorded.classes !== model.classes || !/^[a-f0-9]{64}$/.test(recorded.sha256))
        throw new Error(`build-info.json: ${model.file} provenance differs`);
    }
  }
  let ingestion = null;
  if (ingestionApiUrl !== undefined) {
    const expected = require("./write_ingestion_config.cjs").deploymentConfig(ingestionApiUrl);
    ingestion = await (await request("ingestion-config.json")).json();
    if (ingestion?.api_url !== expected.api_url) throw new Error("ingestion-config.json: remote API differs from this deployment's configuration");
    if (ingestion?.mode !== expected.mode) throw new Error("ingestion-config.json: file processing mode differs from this deployment's configuration");
    if(ingestion.mode==='browser'){
      const runtime=JSON.parse(await readFile(path.join(sourceRoot,'file-runtime.json'),'utf8'));
      if(!Array.isArray(runtime.assets)||runtime.assets.length<3)throw new Error('file-runtime.json: browser runtime assets are missing');
      for(const asset of runtime.assets){
        if(!/^[\w.-]+$/.test(asset.file)||asset.file==='..')throw new Error('Invalid browser runtime asset path');
        const response=await request('vendor/ingestion/'+asset.file,'HEAD');
        if((response.headers.get('content-type')||'').includes('text/html')||Number(response.headers.get('content-length'))!==asset.bytes)throw new Error('Browser ingestion asset unavailable or has wrong size: '+asset.file);
      }
    }
  }
  return { checkedAt: new Date().toISOString(), url: base.href, revision, files, models, build, ingestion };
}

async function main() {
  const args = process.argv.slice(2), options = { ingestionApiUrl: process.env.INGESTION_API_URL };
  for (let i = 0; i < args.length; i += 2) {
    if (!["--url", "--revision"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Usage: node scripts/check_deployment.cjs --url https://host/project/ [--revision SHA]");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.url) throw new Error("--url is required");
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { console.log(JSON.stringify(await verifyDeployment(options), null, 2)); return; }
    catch (error) {
      if (attempt === 5) throw error;
      console.error(`Deployment check ${attempt}/5: ${error.message}; retrying in 2 seconds`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

module.exports = { verifyDeployment, SOURCE_FILES };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
