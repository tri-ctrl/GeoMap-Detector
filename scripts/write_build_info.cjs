/* Public, deterministic artifact provenance. No environment dump or ML imports. */
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SOURCE_FILES = ['index.html', 'app.js', 'engine.js', 'map-view.js', 'uploads.js', 'processing.js', 'processing-worker.js', 'comparison.js', 'storage.js', 'streaming.js', 'sample_aois/uae_airports_ports.geojson'];
const digest = data => createHash('sha256').update(data).digest('hex');
function stampEngine(source, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Build revision must be a full Git SHA');
  const pattern = /const BUILD_REVISION = "(?:development|[a-f0-9]{40})"; \/\/ GMD_BUILD_REVISION/g;
  if ([...source.matchAll(pattern)].length !== 1) throw new Error('Engine revision marker is missing or ambiguous');
  return source.replace(pattern, `const BUILD_REVISION = "${revision}"; // GMD_BUILD_REVISION`);
}
async function writeBuildInfo({ sourceRoot = path.resolve(__dirname, '../frontend'), revision, builtAt = new Date().toISOString() }) {
  if (!Number.isFinite(Date.parse(builtAt)) || new Date(builtAt).toISOString() !== builtAt) throw new Error('Invalid build timestamp');
  const enginePath = path.join(sourceRoot, 'engine.js'), engine = stampEngine(await fs.readFile(enginePath, 'utf8'), revision);
  const entries = JSON.parse(await fs.readFile(path.join(sourceRoot, 'models/models.json'), 'utf8'));
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) throw new Error('Invalid model manifest');
  const seen = new Set(), models = [];
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || !/^[\w.-]+\.onnx$/.test(entry.file) || seen.has(entry.file)
      || !Number.isSafeInteger(entry.imgsz) || entry.imgsz < 1 || !Array.isArray(entry.names) || !entry.names.length || !entry.names.every(name => typeof name === 'string' && name.length)) throw new Error('Invalid model entry');
    seen.add(entry.file);
    const file = path.join(sourceRoot, 'models', entry.file), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1) throw new Error('Missing or empty model: ' + entry.file);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    models.push({ file: entry.file, bytes: stat.size, sha256: hash.digest('hex'), imgsz: entry.imgsz, classes: entry.names.length });
  }
  const files = {};
  for (const file of SOURCE_FILES) files[file] = digest(file === 'engine.js' ? engine : await fs.readFile(path.join(sourceRoot, file)));
  files['models/models.json'] = digest(await fs.readFile(path.join(sourceRoot, 'models/models.json')));
  const info = { version: 1, revision, builtAt, runtime: { name: 'onnxruntime-web', version: '1.20.1' }, files, models };
  // Validate every input before modifying the artifact; source checkout revision
  // and wall-clock build timestamp are distinct. Repeating this step is idempotent.
  await fs.writeFile(enginePath, engine);
  await fs.writeFile(path.join(sourceRoot, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  return info;
}
module.exports = { SOURCE_FILES, stampEngine, writeBuildInfo };
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--revision', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/write_build_info.cjs --revision SHA [--out frontend]');
    options[args[i] === '--out' ? 'sourceRoot' : 'revision'] = args[i + 1];
  }
  writeBuildInfo(options).then(info => console.log(`Build ${info.revision}: ${info.models.length} model fingerprints`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
