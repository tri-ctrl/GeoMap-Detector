/* GMD-014: real Chrome, five cold/warm pairs for HEAD versus local source.
 * node --use-system-ca tests/browser/startup.cjs
 * Requires Chrome and network. Test server/profile are owned and closed here.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { withChrome } = require("./chrome.cjs");
const root = path.resolve(__dirname, "../.."), site = "https://tri-ctrl.github.io/GeoMap-Detector/";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const files = ["index.html", "app.js", "engine.js"];
const baseline = Object.fromEntries(files.map(file => [file, execFileSync("git", ["show", "HEAD:frontend/" + file], { cwd: root })]));
const candidate = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, "frontend", file))]));
const cacheKey = "gv_wayback_releases_v1";
const lookupOnly = process.argv.includes("--lookup-only");
const partialOutput = path.join(os.tmpdir(), "geomap-gmd014-partial.json");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = { mode: "Local static project paths; not deployed verification", checkedAt: new Date().toISOString(),
  baselineRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sources: Object.fromEntries(["baseline", "candidate"].map(mode => [mode, Object.fromEntries(files.map(file => [file, digest((mode === "baseline" ? baseline : candidate)[file])]))])),
  method: { viewport: [1440, 1000], httpCacheDisabled: true, samplesPerCondition: 5,
    cold: "Temporary profile localStorage cleared before navigation", warm: "Same profile after cold navigation; IndexedDB and tile cache unused",
    network: "Real CDN, Wayback configuration and tiles; local app/manifest responses; sequential samples without throttling",
    firstTile: "First observed loaded Leaflet tile; not full map completion", claims: "Compare medians/ranges; this is not a leak or accuracy benchmark" }, samples: [] };

(async () => {
  const manifestResponse = await fetch(site + "models/models.json"); assert.ok(manifestResponse.ok);
  const manifest = await manifestResponse.json(), assets = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean), mode = parts.shift();
      if (!["baseline", "candidate"].includes(mode)) { res.writeHead(404).end(); return; }
      const file = parts.join("/") || "index.html";
      let body, type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : "application/json";
      if (files.includes(file)) body = (mode === "baseline" ? baseline : candidate)[file];
      else if (file === "models/models.json") body = JSON.stringify(manifest);
      else if (/^models\/yolo11[ns]-obb\.onnx$/.test(file)) {
        if (!assets.has(file)) { const response = await fetch(site + file); assert.ok(response.ok); assets.set(file, Buffer.from(await response.arrayBuffer())); }
        body = assets.get(file); type = "application/octet-stream";
      } else if (file === "sample_aois/uae_airports_ports.geojson") body = fs.readFileSync(path.join(root, "frontend", file));
      else { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await withChrome(async ({ page, evaluate, until, errors, exceptions, on }) => {
      results.browser = await evaluate("navigator.userAgent");
      results.navigationDialogs = [];
      on("Page.javascriptDialogOpening", event => {
        results.navigationDialogs.push({ type: event.type, message: event.message });
        page("Page.handleJavaScriptDialog", { accept: true }).catch(error => errors.push(error.message));
      });
      await page("Network.setCacheDisabled", { cacheDisabled: true });
      await page("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        window.__startupProbe = { documentId: Math.random().toString(36), firstTile: null, longTasks: [] };
        new PerformanceObserver(list => list.getEntries().forEach(entry => __startupProbe.longTasks.push(entry.duration))).observe({ type: 'longtask', buffered: true });
        document.addEventListener('DOMContentLoaded', () => {
          const observer = new MutationObserver(() => {
            if (document.querySelector('.leaflet-tile-loaded')) { __startupProbe.firstTile = performance.now(); observer.disconnect(); }
          }); observer.observe(document.body, { subtree: true, attributes: true, childList: true });
        });
      })();` });
      async function navigate(mode, cold) {
        const previous = await evaluate("window.__startupProbe?.documentId || null");
        await page("Page.stopLoading");
        if (cold) {
          await page("Page.navigate", { url: "about:blank" });
          await until("location.href === 'about:blank'");
          await page("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage" });
          await page("Page.navigate", { url: `${origin}/${mode}/` });
        } else await page("Page.reload", { ignoreCache: true });
        await until(`Boolean(location.href === ${JSON.stringify(`${origin}/${mode}/`)} && window.__startupProbe?.documentId !== ${JSON.stringify(previous)} && window.GVEngine && __startupProbe.firstTile && document.querySelector('#model')?.options.length >= 2)`);
      }
      if (!lookupOnly && !process.argv.includes("--smoke-only")) for (let i = 0; i < 5; i++) {
        for (const mode of i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          for (const cold of [true, false]) {
            console.log(`Starting ${mode} ${cold ? "cold" : "warm"} ${i + 1}/5`);
            await navigate(mode, cold);
            const sample = await evaluate(`(() => {
              const resources = performance.getEntriesByType('resource'), scripts = resources.filter(entry => /\\.js(?:[?#]|$)/.test(entry.name));
              return { fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, firstTileMs: __startupProbe.firstTile,
                longestTaskMs: Math.max(0, ...__startupProbe.longTasks), scripts: scripts.map(entry => ({ url: entry.name.replace(location.origin, ''), bytes: entry.encodedBodySize })),
                diagnostics: GVEngine.diagnostics?.(), cachedReleaseList: Boolean(localStorage.getItem('${cacheKey}')) };
            })()`);
            if (mode === "candidate") assert.ok(!sample.scripts.some(entry => /ort\.webgpu|leaflet\.draw|fflate|jszip/i.test(entry.url)));
            results.samples.push({ mode, cache: cold ? "cold" : "warm", ...sample });
            fs.writeFileSync(partialOutput, JSON.stringify(results, null, 2) + "\n");
            console.log(`${mode} ${cold ? "cold" : "warm"} ${i + 1}/5: FCP ${Math.round(sample.fcpMs)}ms, first observed tile ${Math.round(sample.firstTileMs)}ms`);
          }
        }
      }
      await navigate("candidate", true);
      let optional = await evaluate("({ ort: typeof ort, zip: typeof JSZip, fflate: typeof fflate, drawing: Boolean(L.Draw) })");
      assert.deepEqual(optional, { ort: "undefined", zip: "undefined", fflate: "undefined", drawing: false });
      results.liveLookup = await evaluate(`(async () => {
        const sample = (await (await fetch('sample_aois/uae_airports_ports.geojson')).json()).features[0];
        const centre = L.geoJSON(sample).getBounds().getCenter(), started = performance.now();
        const hits = await GVEngine.localChanges(centre.lng, centre.lat, 17);
        return { aoi:sample.properties.name, count:hits.length, ms:performance.now()-started, releases:hits.map(({release,date})=>({release,date})) };
      })()`, 120000);
      assert.ok(results.liveLookup.count > 0);
      if (lookupOnly) { assert.deepEqual(errors, []); results.runtimeErrors = errors; return; }
      // Deterministic failure/race fixtures apply only after the real-network benchmark.
      let metadataFailure = true, lookupMode = "success", lookupRequests = 0, held;
      const firstTwo = await evaluate("(async () => (await GVEngine.getReleases()).slice(0, 2).map(entry => entry.release))()");
      on("Fetch.requestPaused", ({ requestId, request }) => {
        const fulfill = (status, value) => page("Fetch.fulfillRequest", { requestId, responseCode: status,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from(JSON.stringify(value)).toString("base64") });
        if (request.url.includes("waybackconfig.json")) {
          if (metadataFailure) fulfill(503, {}).catch(error => errors.push(error.message));
          else page("Fetch.continueRequest", { requestId }).catch(error => errors.push(error.message));
        } else if (lookupMode === "held") held = () => fulfill(200, { data: [1], select: [firstTwo[0]] });
        else if (lookupMode === "failure") fulfill(503, {}).catch(error => errors.push(error.message));
        else fulfill(200, lookupRequests++ < 2 ? { data: [1], select: [firstTwo[lookupRequests - 1]] } : { data: [0] }).catch(error => errors.push(error.message));
      });
      await page("Fetch.enable", { patterns: [{ urlPattern: "*waybackconfig.json*" }, { urlPattern: "*/tilemap/*" }] });
      const previous = await evaluate("__startupProbe.documentId");
      await page("Page.reload", { ignoreCache: true });
      await until(`window.__startupProbe?.documentId !== ${JSON.stringify(previous)} && document.querySelector('#releaseStatus')?.textContent.includes('Refresh failed') && Boolean(document.querySelector('.leaflet-tile-loaded'))`);
      results.failedRefresh = await evaluate("({ message: document.querySelector('#releaseStatus').textContent, diagnostics: GVEngine.diagnostics(), release: document.querySelector('#hudRel').textContent })");
      await evaluate(`(() => {
        const geometry = { type:'Polygon',coordinates:[[[55.36,25.25],[55.3615,25.25],[55.3615,25.251],[55.36,25.251],[55.36,25.25]]] };
        const features = ['Review_small','Other'].map(name => ({type:'Feature',properties:{name},geometry}));
        const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify({type:'FeatureCollection',features})], 'review.geojson'));
        const input = document.querySelector('#fileIn'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
      })()`);
      await until("document.querySelector('#runN').textContent === '2'");
      await evaluate("document.querySelectorAll('#aoiList .item')[0].click(); document.querySelector('#relLocal').click()");
      await until("document.querySelector('#localChangeStatus').textContent.startsWith('2 historical')");
      results.lookup = await evaluate("({ text: document.querySelector('#localChangeStatus').textContent, badges: [...document.querySelectorAll('#relList .s span')].map(node => node.textContent), active: document.querySelectorAll('#relList .active').length })");
      assert.equal(results.lookup.badges.length, 2); assert.equal(results.lookup.active, 1);
      lookupMode = "held"; await evaluate("document.querySelector('#relLocal').click()");
      await until("document.querySelector('#relLocal').disabled");
      const deadline = Date.now() + 10000; while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(held); await evaluate("document.querySelectorAll('#aoiList .item')[1].click()");
      // The browser aborts the old request, so it may no longer be fulfillable.
      await held().catch(() => {});
      assert.equal(await evaluate("document.querySelectorAll('#relList .s span').length"), 0);
      lookupMode = "failure"; await evaluate("document.querySelector('#relLocal').click()");
      await until("document.querySelector('#localChangeStatus').textContent.includes('HTTP 503')");
      results.staleLookupRejected = true;
      metadataFailure = false; await page("Fetch.disable");
      // First-use drawing, TIFF and ZIP operate against real pinned libraries.
      await evaluate("document.querySelector('#drawRect').click()");
      await until("Boolean(L.Draw?.Rectangle && document.querySelector('.leaflet-draw-tooltip'))");
      await page("Input.dispatchMouseEvent", { type: "mousePressed", x: 1050, y: 350, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1100, y: 400, button: "left", buttons: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1100, y: 400, button: "left", clickCount: 1 });
      await until("document.querySelector('#runN').textContent === '3'"); results.firstUseDrawing = true;
      results.artifacts = await evaluate(`(async () => {
        const feature = JSON.parse(localStorage.getItem('gv_aois'))[0], release = (await GVEngine.getReleases())[0];
        const result = await GVEngine.processClip(feature, release, { zoom:18, model:null, geotiff:true });
        const zipBefore = typeof JSZip;
        const archive = await GVEngine.exportJobZip({id:'gmd014',results:[result],params:{},aois:[feature]});
        const zip = await JSZip.loadAsync(archive);
        const tiff = new Uint8Array(await result.blobs.tif.arrayBuffer());
        return { size:result.size, tiffHeader:[...tiff.slice(0,4)], worldFileLines:result.blobs.pgw.trim().split('\\n').length,
          zipBefore, files:Object.keys(zip.files), ortBefore:typeof ort };
      })()`, 120000);
      assert.equal(results.artifacts.zipBefore, "undefined"); assert.equal(results.artifacts.ortBefore, "undefined");
      assert.deepEqual(results.artifacts.tiffHeader, [73,73,42,0]); assert.equal(results.artifacts.worldFileLines, 6);
      assert.ok(results.artifacts.files.some(file => file.endsWith("image.prj")));
      results.inference = [];
      for (const forceWasm of [false, true]) {
        const smoke = await evaluate(`(async () => {
          const entry = (await (await fetch('models/models.json')).json())[0], original = Object.getOwnPropertyDescriptor(navigator,'gpu');
          let model;
          try { if (${forceWasm}) Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});
            model = await GVEngine.loadModel({key:'gmd014:${forceWasm}',url:'models/'+entry.file,names:entry.names,imgsz:entry.imgsz});
          } finally { if (${forceWasm}) { if(original) Object.defineProperty(navigator,'gpu',original); else delete navigator.gpu; } }
          const input = new ort.Tensor('float32',new Float32Array(3*model.imgsz*model.imgsz),[1,3,model.imgsz,model.imgsz]); let outputs;
          try { outputs = await model.session.run({[model.session.inputNames[0]]:input}); const output = outputs[model.session.outputNames[0]];
            return {provider:model.provider,dimensions:output.dims,finite:output.data.every(Number.isFinite),wasmPaths:ort.env.wasm.wasmPaths,numThreads:ort.env.wasm.numThreads};
          } finally { Object.values(outputs||{}).forEach(tensor=>tensor.dispose?.()); input.dispose?.(); await model.session.release(); }
        })()`, 120000);
        assert.ok(smoke.finite); assert.equal(smoke.provider, forceWasm ? "wasm" : "webgpu"); results.inference.push(smoke);
      }
      results.browserExceptions = exceptions;
      results.environmentExceptions = exceptions.filter(entry => [entry.url, entry.context?.origin,
        ...(entry.stackTrace?.callFrames || []).map(frame => frame.url)].some(url => url?.startsWith('chrome-extension://')));
      const environmentMessages = new Set(results.environmentExceptions.map(entry => entry.exception?.description || entry.text));
      results.runtimeErrors = errors.filter(message => !environmentMessages.has(message));
      fs.writeFileSync(partialOutput, JSON.stringify(results, null, 2) + "\n");
      assert.deepEqual(results.runtimeErrors, []);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  results.summary = [];
  for (const mode of ["baseline", "candidate"]) for (const cache of ["cold", "warm"]) {
    const samples = results.samples.filter(sample => sample.mode === mode && sample.cache === cache);
    if (samples.length) results.summary.push({ mode, cache, n: samples.length, fcpMedianMs: median(samples.map(sample => sample.fcpMs)),
      firstTileMedianMs: median(samples.map(sample => sample.firstTileMs)), firstTileRangeMs: [Math.min(...samples.map(sample => sample.firstTileMs)), Math.max(...samples.map(sample => sample.firstTileMs))] });
  }
  const output = process.env.GMD_RESULTS_PATH || path.join(os.tmpdir(), lookupOnly ? "geomap-gmd014-lookup.json" : "geomap-gmd014-results.json");
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ summary: results.summary, checks: { lookup: results.lookup, staleLookupRejected: results.staleLookupRejected, drawing: results.firstUseDrawing, inference: results.inference }, output }, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
