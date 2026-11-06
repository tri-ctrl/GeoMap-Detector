/* Read-only deployed-site acceptance: node tests/browser/deployment.cjs
 * No source/response overrides. Uses isolated storage and real ONNX weights.
 * Requires Chrome, network access and enough memory for one model at a time.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { verifyDeployment } = require("../../scripts/check_deployment.cjs");
const { withChrome } = require("./chrome.cjs");
const base = process.env.GMD_SITE_URL || "https://tri-ctrl.github.io/GeoMap-Detector/";

(async () => {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim();
  const parity = await verifyDeployment({ url: base, revision });
  const results = { mode: "Deployed sources, no overrides", parity };
  console.log("Published source bytes and generated model URLs match expectations.");
  await withChrome(async ({ page, evaluate, until, errors, on }) => {
    const scripts = new Map();
    on("Network.responseReceived", ({ requestId, response }) => {
      const file = new URL(response.url).pathname.split("/").pop();
      if (["app.js", "engine.js"].includes(file)) scripts.set(file, requestId);
    });
    await page("Network.setCacheDisabled", { cacheDisabled: true });
    await page("Page.navigate", { url: base });
    await until("Boolean(window.GVEngine && document.querySelector('#model')?.options.length >= 2 && document.querySelector('#relList [data-r]'))");
    results.executedScripts = [];
    for (const file of ["app.js", "engine.js"]) {
      assert.ok(scripts.has(file), file + " must be loaded by the page");
      const response = await page("Network.getResponseBody", { requestId: scripts.get(file) });
      const body = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
      const sha256 = createHash("sha256").update(body).digest("hex");
      assert.equal(sha256, parity.files.find(entry => entry.file === file).sha256);
      results.executedScripts.push({ file, sha256 });
    }
    // Storage belongs to this temporary profile. A sentinel proves that restoring
    // duplicate AOIs does not clear existing reviewed annotations.
    const seed = await evaluate(`(async () => {
      const sample = (await (await fetch('sample_aois/uae_airports_ports.geojson')).json()).features;
      const annotations = JSON.stringify({ type: 'FeatureCollection', features: [{ ...sample[0], id: 'gmd002-saved-review', properties: { ...sample[0].properties, status: 'verified', class: 'aircraft' } }] });
      localStorage.setItem('gv_aois', JSON.stringify(sample.concat(sample)));
      localStorage.setItem('gv_ann', annotations);
      return { annotations, names: sample.map(feature => feature.properties.name) };
    })()`);
    await page("Page.reload", { ignoreCache: true });
    await until("document.querySelector('#runN')?.textContent === '6' && Boolean(document.querySelector('#loadSample').onclick)");
    for (let i = 0; i < 2; i++) {
      await evaluate("document.querySelector('#loadSample').onclick()");
      await until("document.querySelector('.toast')?.textContent.includes('duplicate')");
      assert.equal(await evaluate("Number(document.querySelector('#runN').textContent)"), 6);
      assert.equal(await evaluate("localStorage.getItem('gv_ann')"), seed.annotations);
    }
    await evaluate(`(async () => {
      const sample = (await (await fetch('sample_aois/uae_airports_ports.geojson')).json()).features[0];
      const renamed = structuredClone(sample); renamed.properties.name += '_distinct';
      const resized = structuredClone(sample); resized.geometry.coordinates[0][1][0] += 0.001;
      const files = new DataTransfer(); files.items.add(new File([JSON.stringify({ type: 'FeatureCollection', features: [renamed, resized] })], 'distinct.geojson', { type: 'application/geo+json' }));
      const input = document.querySelector('#fileIn'); input.files = files.files; input.dispatchEvent(new Event('change'));
    })()`);
    await until("document.querySelector('#runN').textContent === '8'");
    results.aois = { restored: 6, afterTwoSampleLoads: 6, distinctPreserved: 8,
      annotationsPreserved: await evaluate("localStorage.getItem('gv_ann')") === seed.annotations };
    assert.ok(results.aois.annotationsPreserved);
    // Count only model fetches; repeated loadModel calls must reuse the loaded session.
    await evaluate(`(() => {
      window.__modelFetches = 0;
      const original = window.fetch;
      window.fetch = function(url, ...args) { if (/\\.onnx(?:[?#]|$)/.test(String(url))) __modelFetches++; return original.call(this, url, ...args); };
    })()`);
    results.modelFailures = await evaluate(`(async () => {
      const failures = [];
      for (const url of ['models/__gmd002_missing.onnx', './']) {
        try { await GVEngine.loadModel({ key: 'gmd002:error:' + url, url }); failures.push({ url, unexpectedlyLoaded: true }); }
        catch (error) { failures.push({ url, message: error.message }); }
      }
      return failures;
    })()`);
    assert.match(results.modelFailures[0].message, /__gmd002_missing\.onnx.*HTTP 404/);
    assert.match(results.modelFailures[1].message, /HTML page instead of ONNX model/);
    results.browser = await evaluate("navigator.userAgent");
    results.webgpuAdapterAvailable = await evaluate("(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()))()");
    results.models = [];
    for (const file of parity.models.map(model => model.file)) {
      for (const forceWasm of [false, true]) {
        console.log(`Running one real chip: ${file}, ${forceWasm ? "forced WASM" : "automatic provider"}`);
        const smoke = await evaluate(`(async () => {
          const entry = (await (await fetch('models/models.json', { cache: 'no-cache' })).json()).find(model => model.file === ${JSON.stringify(file)});
          const spec = { key: 'gmd002:' + ${JSON.stringify(file)} + ':' + ${forceWasm}, url: 'models/' + entry.file, names: entry.names, imgsz: entry.imgsz };
          const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
          let model;
          const fetchesBefore = __modelFetches;
          try {
            if (${forceWasm}) Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
            model = await GVEngine.loadModel(spec);
          } finally {
            if (${forceWasm}) { if (original) Object.defineProperty(navigator, 'gpu', original); else delete navigator.gpu; }
          }
          const input = new ort.Tensor('float32', new Float32Array(3 * model.imgsz * model.imgsz), [1,3,model.imgsz,model.imgsz]);
          let outputs;
          try {
            outputs = await model.session.run({ [model.session.inputNames[0]]: input });
            const output = outputs[model.session.outputNames[0]];
            const finite = output.data.every(Number.isFinite);
            const detections = GVEngine.decode(output, model.names, 0.3, null).length;
            const fetched = __modelFetches;
            const same = await GVEngine.loadModel(spec);
            return { file: entry.file, provider: model.provider, forcedWasm: ${forceWasm}, dimensions: output.dims,
              classes: model.names.length, finite, detections, coldFetches: fetched - fetchesBefore,
              warmFetches: __modelFetches - fetched, sameSession: same.session === model.session };
          } finally {
            Object.values(outputs || {}).forEach(tensor => tensor.dispose?.()); input.dispose?.(); await model.session.release();
          }
        })()`, 120000);
        assert.equal(smoke.finite, true); assert.equal(smoke.coldFetches, 1); assert.equal(smoke.warmFetches, 0); assert.equal(smoke.sameSession, true);
        assert.equal(smoke.dimensions[0], 1); assert.equal(smoke.dimensions[1], smoke.classes + 5); assert.ok(smoke.dimensions[2] > 0);
        if (forceWasm) assert.equal(smoke.provider, "wasm");
        else if (results.webgpuAdapterAvailable) assert.equal(smoke.provider, "webgpu", "Available WebGPU should initialize successfully");
        results.models.push(smoke);
      }
    }
    assert.deepEqual(errors, []); results.runtimeErrors = errors;
  });
  results.checkedAt = new Date().toISOString();
  const output = process.env.GMD_RESULTS_PATH || path.join(os.tmpdir(), "geomap-gmd002-results.json");
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2)); console.log("Saved deployed evidence: " + output);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
