/* Verify published source bytes and generated model URLs without ML dependencies. */
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SOURCE_FILES = ["index.html", "app.js", "engine.js", "comparison.js", "storage.js", "streaming.js", "sample_aois/uae_airports_ports.geojson"];
const DEFAULT_MODELS = ["yolo11n-obb.onnx", "yolo11s-obb.onnx"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function verifyDeployment({ url, sourceRoot = path.resolve(__dirname, "../frontend"), revision = null, fetchImpl = fetch }) {
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
  const files = await Promise.all(SOURCE_FILES.map(async file => {
    const expected = await readFile(path.join(sourceRoot, file));
    const response = await request(file);
    const actual = new Uint8Array(await response.arrayBuffer());
    if (digest(actual) !== digest(expected)) throw new Error(`${file}: deployed content differs from the checked-out source`);
    return { file, bytes: actual.byteLength, sha256: digest(actual) };
  }));
  // This manifest is generated/restored during the build; the checked-in placeholder
  // is intentionally not used for a byte comparison or as the list of shipped models.
  const manifest = await (await request("models/models.json")).json();
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
  return { checkedAt: new Date().toISOString(), url: base.href, revision, files, models };
}

async function main() {
  const args = process.argv.slice(2), options = {};
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
