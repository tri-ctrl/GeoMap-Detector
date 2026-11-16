/* GMD-014: unmodified Pages sources with real Leaflet/IndexedDB and controlled
 * network responses. No CDN, imagery service or model weights are required.
 * node tests/browser/startup-offline.cjs [--output report.json]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..'), prefix = '/GeoMap-Detector/';
const files = ['index.html', 'engine.js', 'map-view.js', 'processing.js', 'comparison.js', 'storage.js', 'app.js', 'streaming.js', 'processing-worker.js'];
const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file))]));
const config = { 101: { itemTitle: 'World Imagery (Wayback 2026-10-29)' }, 100: { itemTitle: 'World Imagery (Wayback 2026-10-22)' } };
const tile = Buffer.from('R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64');
const result = { checkedAt: new Date().toISOString(), mode: 'Local unmodified source under Pages project path; not deployed parity',
  sources: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])),
  method: { samplesPerCondition: 5, httpCacheDisabled: true, network: 'Offline deterministic fixtures; configuration held until app/cache readiness assertions finish',
    firstTile: 'First loaded synthetic tile, not full map completion or live imagery latency',
    lifecycle: 'Synthetic persisted pagehide/pageshow events; native fetch cancellation, Leaflet and IndexedDB',
    claims: 'Regression checks and controlled timings only; no live-network speedup, memory-leak or detection-quality claim' }, samples: [] };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || 'index.html' : '';
  let body = sources[file], type = file.endsWith('.html') ? 'text/html' : 'application/javascript';
  if (file === 'models/models.json') { body = '[]'; type = 'application/json'; }
  if (!body) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body);
});
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await withChrome(async ({ page, evaluate, until, errors, on }) => {
      const origin = 'http://127.0.0.1:' + server.address().port, url = origin + prefix;
      const held = [], scripts = [], fixtureErrors = [];
      const fulfill = (requestId, value, status = 200, type = 'application/json') => page('Fetch.fulfillRequest', { requestId, responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(value).toString('base64') });
      on('Fetch.requestPaused', event => {
        (async () => {
          const { requestId, request } = event, address = request.url;
          if (address.includes('waybackconfig.json')) { held.push(requestId); return; }
          if (address.startsWith(origin)) return page('Fetch.continueRequest', { requestId });
          if (/leaflet@1\.9\.4\/dist\/leaflet\.(js|css)$/.test(address)) {
            const file = address.split('/').at(-1);
            return fulfill(requestId, fs.readFileSync(require.resolve('leaflet/dist/' + file)), 200, file.endsWith('css') ? 'text/css' : 'application/javascript');
          }
          if (/leaflet\.draw\.(js|css)$/.test(address)) {
            const file = address.split('/').at(-1);
            return fulfill(requestId, fs.readFileSync(require.resolve('leaflet-draw/dist/' + file)), 200, file.endsWith('css') ? 'text/css' : 'application/javascript');
          }
          if (event.resourceType === 'Image') return fulfill(requestId, tile, 200, 'image/gif');
          if (event.resourceType === 'Stylesheet') return fulfill(requestId, '', 200, 'text/css');
          throw new Error('Unexpected external startup request: ' + address);
        })().catch(error => { fixtureErrors.push(error.message); page('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {}); });
      });
      on('Network.requestWillBeSent', event => { if (event.type === 'Script') scripts.push(event.request.url); });
      await page('Network.setCacheDisabled', { cacheDisabled: true });
      await page('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await page('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__startupId=Math.random();
        if(location.pathname===${JSON.stringify(prefix)} && location.search.includes('cold=1')) {
          localStorage.setItem('gv_selRel','[100]');
          localStorage.setItem('gv_aois',JSON.stringify([{type:'Feature',properties:{name:'Startup AOI'},geometry:{type:'Polygon',coordinates:[[[55.36,25.25],[55.37,25.25],[55.37,25.26],[55.36,25.25]]]}}]));
        }` });
      const ready = "window.GVApp&&GVEngine.diagnostics().startup.appReady!=null&&document.querySelector('#storageStatus').textContent.startsWith('Saved')";
      const tileReady = "GVEngine.diagnostics().startup.mapFirstTile!=null";
      const settled = "!GVEngine.releaseCacheInfo().refreshing&&GVEngine.diagnostics().operations.requests===0&&GVEngine.diagnostics().operations.pendingReads===0";
      const snapshot = () => evaluate(`({diagnostics:GVEngine.diagnostics(),viewed:document.querySelector('#hudRel').textContent,
        checked:[...document.querySelectorAll('#relList [data-c]:checked')].map(e=>+e.dataset.c),
        rows:document.querySelectorAll('#relList [data-r]').length,status:document.querySelector('#releaseStatus').textContent,
        tiles:document.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length,
        fcpMs:performance.getEntriesByName('first-contentful-paint')[0]?.startTime})`);
      const noOptional = async () => {
        assert.deepEqual(await evaluate('({ort:typeof ort,zip:typeof JSZip,fflate:typeof fflate,draw:Boolean(L.Draw),cesium:typeof Cesium,proj4:typeof proj4})'),
          { ort: 'undefined', zip: 'undefined', fflate: 'undefined', draw: false, cesium: 'undefined', proj4: 'undefined' });
      };
      for (let pair = 0; pair < 5; pair++) for (const cold of [true, false]) {
        console.log(`GMD-014 startup ${pair + 1}/5 ${cold ? 'cold' : 'warm'}`);
        await page('Page.navigate', { url: 'about:blank' }); await until("location.href==='about:blank'");
        if (cold) await page('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' });
        const prior = await evaluate('window.__startupId'), startScripts = scripts.length, startConfigs = held.length;
        await page('Page.navigate', { url: url + (cold ? '?cold=1' : '') });
        await until(`window.__startupId!==${JSON.stringify(prior)}&&(${ready})&&GVEngine.releaseCacheInfo().refreshing`);
        if (!cold) {
          await until(tileReady);
          assert.equal((await snapshot()).diagnostics.metadata.source, 'cache');
        } else assert.equal((await snapshot()).rows, 0);
        await noOptional(); assert.equal(held.length, startConfigs + 1);
        await fulfill(held.at(-1), JSON.stringify(config)); await until(`(${settled})&&(${tileReady})`);
        const sample = await snapshot(); assert.equal(sample.rows, 2); assert.deepEqual(sample.checked, [100]);
        const requested = scripts.slice(startScripts);
        assert.equal(requested.length, 7, 'Leaflet and six local startup modules');
        assert.ok(!requested.some(address => /ort\.webgpu|leaflet\.draw|fflate|jszip|Cesium|proj4/.test(address)));
        result.samples.push({ pair: pair + 1, cache: cold ? 'cold' : 'warm', scripts: requested.map(address => address.replace(origin, '')), ...sample });
      }
      // Preserve viewed/checked dates through failed refresh, retry and recovery.
      await evaluate("document.querySelector('#relList [data-r=\"100\"]').click();document.querySelector('#relRefresh').click()");
      await until('GVEngine.releaseCacheInfo().refreshing');
      await fulfill(held.at(-1), '{}', 503); await until(settled);
      result.failedRefresh = await snapshot(); assert.match(result.failedRefresh.status, /Refresh failed/);
      assert.equal(result.failedRefresh.viewed, '2026-10-22'); assert.deepEqual(result.failedRefresh.checked, [100]);
      const requestsBeforeHide = held.length;
      await evaluate("document.querySelector('#relRefresh').click()"); await until('GVEngine.releaseCacheInfo().refreshing');
      await evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
      await until(`document.querySelector('#storageStatus').textContent.startsWith('Saved')&&GVEngine.releaseCacheInfo().refreshing`);
      assert.equal(held.length, requestsBeforeHide + 2, 'page-show starts a fresh configuration request');
      await fulfill(held.at(-1), JSON.stringify({ 102: { itemTitle: 'Wayback 2026-11-05' }, ...config })); await until(settled);
      result.recovered = await snapshot(); assert.equal(result.recovered.rows, 3);
      assert.equal(result.recovered.viewed, '2026-10-22'); assert.deepEqual(result.recovered.checked, [100]); assert.equal(result.recovered.tiles, 1);
      // Live Esri imagery can start even with no saved Wayback catalogue.
      await evaluate("localStorage.removeItem('gv_wayback_releases_v1');localStorage.setItem('gv_mapDisplay',JSON.stringify({basemap:'imagery',coordinates:'EPSG:4326'}))");
      const prior = await evaluate('window.__startupId');
      await page('Page.navigate', { url }); await until(`window.__startupId!==${JSON.stringify(prior)}&&(${ready})&&(${tileReady})&&GVEngine.releaseCacheInfo().refreshing`);
      result.liveBeforeMetadata = await snapshot(); assert.equal(result.liveBeforeMetadata.rows, 0); await noOptional();
      const liveDate = result.liveBeforeMetadata.viewed;
      await fulfill(held.at(-1), JSON.stringify(config)); await until(settled);
      assert.equal((await snapshot()).viewed, liveDate);
      await evaluate("document.querySelector('#drawPoly').click()"); await until("Boolean(L.Draw&&document.querySelector('.leaflet-draw-tooltip'))");
      assert.equal(scripts.filter(address => address.endsWith('/leaflet.draw.js')).length, 1);
      await evaluate("dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
      await until(settled); result.finalOperations = await evaluate('GVEngine.diagnostics().operations');
      assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []); result.runtimeErrors = errors;
      result.browser = await evaluate('navigator.userAgent');
      result.summary = Object.fromEntries(['cold', 'warm'].map(cache => {
        const samples = result.samples.filter(sample => sample.cache === cache);
        return [cache, { medianAppReadyMs: median(samples.map(sample => sample.diagnostics.startup.appReady)),
          medianMetadataReadyMs: median(samples.map(sample => sample.diagnostics.startup.metadataReady)),
          medianFirstSyntheticTileMs: median(samples.map(sample => sample.diagnostics.startup.mapFirstTile)), scripts: samples[0].scripts.length }];
      }));
    });
    const output = process.argv.indexOf('--output');
    if (output >= 0) fs.writeFileSync(process.argv[output + 1], JSON.stringify(result, null, 2) + '\n');
    console.log('GMD-014: five cold/warm pairs, lazy drawing, cached/failed/retried metadata, page lifecycle and live-basemap independence passed.');
    console.log(JSON.stringify(result.summary));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
