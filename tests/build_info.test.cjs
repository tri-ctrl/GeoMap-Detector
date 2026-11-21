const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { writeBuildInfo, stampEngine, SOURCE_FILES } = require('../scripts/write_build_info.cjs');
const { verifyDeployment } = require('../scripts/check_deployment.cjs');
const revision = 'a'.repeat(40), builtAt = '2026-11-21T00:00:00.000Z', digest = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gmd020-build-')); t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  for (const name of SOURCE_FILES) { const file = path.join(sourceRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, name === 'engine.js' ? 'const BUILD_REVISION = "development"; // GMD_BUILD_REVISION\n' : 'source '+name); }
  await fs.mkdir(path.join(sourceRoot, 'models'));
  const models = ['yolo11n-obb.onnx', 'yolo11s-obb.onnx'].map(file => ({ file, imgsz: 1024, names: ['plane', 'ship'] }));
  for (const { file } of models) await fs.writeFile(path.join(sourceRoot, 'models', file), 'model bytes '+file);
  await fs.writeFile(path.join(sourceRoot, 'models/models.json'), JSON.stringify(models));
  return { options: { sourceRoot, revision, builtAt }, models };
}
test('fresh and cached packaging publish identical model/source fingerprints without changing model bytes', async t => {
  const { options } = await fixture(t), first = await writeBuildInfo(options), second = await writeBuildInfo(options);
  assert.deepEqual(first, second); assert.equal(first.revision, revision); assert.equal(first.builtAt, builtAt);
  for (const model of first.models) { const bytes = await fs.readFile(path.join(options.sourceRoot, 'models', model.file)); assert.equal(model.sha256, digest(bytes)); assert.equal(model.bytes, bytes.length); }
  for (const [file, expected] of Object.entries(first.files)) assert.equal(digest(await fs.readFile(path.join(options.sourceRoot, file))), expected);
  assert.ok((await fs.readFile(path.join(options.sourceRoot, 'engine.js'), 'utf8')).includes(revision));
});
test('invalid revision/time, missing models and path escapes fail before modifying the artifact', async t => {
  const { options, models } = await fixture(t), engine = path.join(options.sourceRoot, 'engine.js'), original = await fs.readFile(engine, 'utf8');
  for (const values of [{ revision: 'short' }, { revision: 'x'.repeat(40) }, { builtAt: 'yesterday' }]) await assert.rejects(writeBuildInfo({ ...options, ...values }));
  await fs.writeFile(path.join(options.sourceRoot, 'models/models.json'), JSON.stringify([{ ...models[0], file: '../escape.onnx' }])); await assert.rejects(writeBuildInfo(options), /Invalid model/);
  await fs.writeFile(path.join(options.sourceRoot, 'models/models.json'), JSON.stringify([{ ...models[0], file: 'missing.onnx' }])); await assert.rejects(writeBuildInfo(options));
  assert.equal(await fs.readFile(engine, 'utf8'), original);
});
test('engine stamp rejects absent/ambiguous markers and leaves other source bytes untouched', () => {
  const original = '// source\nconst BUILD_REVISION = "development"; // GMD_BUILD_REVISION\nconst other="unchanged";\n';
  assert.equal(stampEngine(original, revision).replace(revision, 'development'), original);
  assert.throws(() => stampEngine('no marker', revision), /missing or ambiguous/);
  assert.throws(() => stampEngine(original + original, revision), /missing or ambiguous/);
});
test('public CLI emits only declared source/model provenance with a separate build timestamp', async t => {
  const { options } = await fixture(t);
  execFileSync(process.execPath, [require.resolve('../scripts/write_build_info.cjs'), '--revision', revision, '--out', options.sourceRoot], { env: { ...process.env, GMD_PRIVATE_TEST_SECRET: 'do-not-publish' } });
  const info = JSON.parse(await fs.readFile(path.join(options.sourceRoot, 'build-info.json'), 'utf8'));
  assert.ok(!JSON.stringify(info).includes('do-not-publish')); assert.deepEqual(Object.keys(info).sort(), ['builtAt','files','models','revision','runtime','version']);
});
test('the actual generated fresh/cache artifact passes the project-subpath deployment guard', async t => {
  const { options } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const expected = await writeBuildInfo(options);
    const result = await verifyDeployment({ url: 'https://example.test/GeoMap-Detector/', sourceRoot: options.sourceRoot, revision,
      fetchImpl: async (url, request) => {
        const filename = path.join(options.sourceRoot, url.pathname.slice('/GeoMap-Detector/'.length));
        if (request.method === 'HEAD') return new Response(null, { headers: { 'content-length': String((await fs.stat(filename)).size), 'content-type': 'application/octet-stream' } });
        return new Response(await fs.readFile(filename));
      } });
    assert.deepEqual(result.build, expected); assert.equal(result.models.length, 2);
  }
});
