/* GMD-023: live coverage, a small real detection job and native ZIP outputs.
 * node --use-system-ca tests/browser/imagery.cjs
 * Requires Chrome/network. Overrides local source in a temporary browser profile;
 * does not publish anything or establish deployed parity/detection accuracy.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..'), base = 'https://tri-ctrl.github.io/GeoMap-Detector/';
const forceWasm = process.argv.includes('--wasm');
const names = ['index.html', 'app.js', 'engine.js', 'comparison.js'];
const sources = Object.fromEntries(names.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file), 'utf8')]));
const dxb = JSON.parse(fs.readFileSync(path.join(root, 'frontend/sample_aois/uae_airports_ports.geojson'))).features.find(feature => feature.properties.name === 'DXB');
const results = { checkedAt: new Date().toISOString(), mode: 'Local source overrides; live provider/model assets; not deployed verification',
  forcedProvider: forceWasm ? 'wasm' : null,
  sources: Object.fromEntries(names.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])),
  limitations: ['Coverage is a live snapshot for the repository sample DXB polygon.', 'Small-clip inference is a provider/encoding smoke test, not an accuracy benchmark.',
    'Resource counts verify this ownership path, not sustained JS/native/GPU memory or a general leak fix.'] };
(async () => {
  await withChrome(async ({ page, evaluate, until, errors, on }) => {
    results.browser = await evaluate('navigator.userAgent');
    const overrides = new Set(), requests = [];
    on('Network.requestWillBeSent', ({ request }) => { if (request.url.includes('/tilemap/') || request.url.includes('/MapServer/tile/')) requests.push(request.url); });
    on('Fetch.requestPaused', ({ requestId, request }) => {
      const file = request.url === base ? 'index.html' : new URL(request.url).pathname.split('/').pop();
      overrides.add(file);
      page('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [
        { name: 'Content-Type', value: file.endsWith('.html') ? 'text/html' : 'application/javascript' }, { name: 'Cache-Control', value: 'no-store' },
      ], body: Buffer.from(sources[file]).toString('base64') }).catch(error => errors.push(error.message));
    });
    await page('Fetch.enable', { patterns: names.map(file => ({ urlPattern: file === 'index.html' ? base : base + file + '*' })) });
    await page('Page.setDownloadBehavior', { behavior: 'deny' });
    if (forceWasm) await page('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
    await page('Page.navigate', { url: base });
    await until("Boolean(window.GVEngine && document.querySelectorAll('#relList [data-r]').length && document.querySelector('.leaflet-tile-loaded'))");
    assert.deepEqual([...overrides].sort(), [...names].sort());
    await evaluate(`(() => {
      window.__gmd023 = { canvases:[], bitmaps:[] };
      const Canvas = window.OffscreenCanvas;
      window.OffscreenCanvas = new Proxy(Canvas, { construct(Target, args) { const canvas = new Target(...args); __gmd023.canvases.push(canvas); return canvas; } });
      const create = window.createImageBitmap;
      window.createImageBitmap = async (...args) => { const bitmap=await create(...args), close=bitmap.close.bind(bitmap), record={closed:0};
        bitmap.close=()=>{record.closed++;close()};__gmd023.bitmaps.push(record);return bitmap; };
    })()`);
    const before = requests.length;
    results.absentRaster = await evaluate(`(async () => {
      const started=performance.now();
      try { const raster=await GVEngine.buildRaster(${JSON.stringify(dxb.geometry)},388,18);raster.canvas.width=raster.canvas.height=1;return {unexpectedSuccess:true}; }
      catch(error){return {code:error.code,message:error.message,zoom:error.zoom,coverage:error.coverage,ms:performance.now()-started,
        canvases:__gmd023.canvases.length,bitmaps:__gmd023.bitmaps.length};}
    })()`);
    results.absentRaster.requests = requests.slice(before);
    assert.equal(results.absentRaster.code, 'NO_IMAGERY'); assert.equal(results.absentRaster.coverage.unknown, 0);
    assert.equal(results.absentRaster.coverage.unavailable, results.absentRaster.coverage.total);
    assert.equal(results.absentRaster.canvases, 0); assert.equal(results.absentRaster.bitmaps, 0);
    assert.ok(results.absentRaster.requests.every(url => url.includes('/tilemap/')));
    console.log('DXB z18 absence verified: ' + JSON.stringify(results.absentRaster));
    results.coverageControls = await evaluate(`(async () => {
      const extent=z=>{ const [a,b]=GVEngine.lonlatToPixel(55.335,25.268,z),[c,d]=GVEngine.lonlatToPixel(55.385,25.237,z);
        const left=Math.floor(Math.floor(a)/256),top=Math.floor(Math.floor(b)/256);
        return {left,top,width:Math.floor((Math.ceil(c)-1)/256)-left+1,height:Math.floor((Math.ceil(d)-1)/256)-top+1}; };
      const records=[];for(const [release,zoom] of [[388,17],[43291,18]]){const {states,...coverage}=await GVEngine.checkCoverage(release,zoom,extent(zoom));records.push({release,zoom,...coverage});}return records;
    })()`);
    assert.ok(results.coverageControls.every(value => value.available > 0 && !value.unknown));
    console.log('Live coverage controls: ' + JSON.stringify(results.coverageControls));
    await evaluate(`(async () => {
      const releaseDates=['2026-10-29','2025-03-27','2016-04-20'], releases=await GVEngine.getReleases();
      for(const date of releaseDates){const release=releases.find(value=>value.date===date);if(!release)throw new Error('Release missing: '+date);
        const box=document.querySelector('#relList [data-c="'+release.release+'"]');box.checked=true;box.dispatchEvent(new Event('change'));}
      const fc={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'DXB_probe'},geometry:{type:'Polygon',coordinates:[[[55.36,25.25],[55.362,25.25],[55.362,25.252],[55.36,25.252],[55.36,25.25]]]}}]};
      const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(fc)],'dxb-probe.geojson'));
      const input=document.querySelector('#fileIn');input.files=transfer.files;input.dispatchEvent(new Event('change'));
      document.querySelector('[name=relMode][value=selected]').click();document.querySelector('[data-tab=det]').click();
      const model=document.querySelector('#model');const nano=[...model.options].find(value=>value.textContent.includes('nano'));if(!nano)throw new Error('Nano model missing');model.value=nano.value;
      document.querySelector('#detectOn').checked=true;document.querySelector('#tifOn').checked=true;
      const original=GVEngine.exportJobZip;GVEngine.exportJobZip=async(job,options)=>{__gmd023.job=job;return __gmd023.archive=await original(job,options)};
    })()`);
    await until("document.querySelector('#runN').textContent === '1'");
    await evaluate("document.querySelector('#runBtn').click()");
    await until("/Finished|ERROR:/.test(document.querySelector('#jobLog').textContent)", 120000);
    results.jobLog = await evaluate("document.querySelector('#jobLog').textContent");
    console.log(results.jobLog);
    assert.match(results.jobLog, /Model ready/); assert.match(results.jobLog, /Finished \(partial\)/);
    await evaluate("document.querySelector('#expZip').onclick()", 60000);
    results.job = await evaluate(`(async () => {
      const job=__gmd023.job,zip=await JSZip.loadAsync(__gmd023.archive),summary=JSON.parse(await zip.file(job.id+'/summary.json').async('string'));
      const images=[];
      for(const result of job.results){const folder=job.id+'/'+result.aoi_id+'/'+result.date+'/';
        const png=await createImageBitmap(await zip.file(folder+'image.png').async('blob'));images.push({date:result.date,size:[png.width,png.height],original:result.size,
          world:await zip.file(folder+'image.pgw').async('string'),tiffBytes:(await zip.file(folder+'image.tif').async('uint8array')).length});png.close();}
      return {status:job.status,provider:job.params.provider,summary,images,
        visible:!document.querySelector('#jobOutcomes').hidden,text:document.querySelector('#jobOutcomes').textContent,
        rows:document.querySelectorAll('#resTable tbody tr[data-i]').length,canvasSizes:__gmd023.canvases.map(canvas=>[canvas.width,canvas.height]),
        bitmaps:__gmd023.bitmaps.length,closed:__gmd023.bitmaps.filter(value=>value.closed===1).length};
    })()`);
    assert.equal(results.job.status, 'partial'); assert.equal(results.job.rows, 2); assert.equal(results.job.visible, true);
    if (forceWasm) assert.equal(results.job.provider, 'wasm');
    assert.equal(results.job.summary.outcomes.filter(value => value.status === 'unavailable').length, 1);
    assert.match(results.job.text, /2016-04-20/);
    for (const image of results.job.images) { assert.deepEqual(image.size, image.original); assert.ok(image.tiffBytes > 0); assert.equal(image.world.trim().split('\n').length, 6); }
    assert.ok(results.job.canvasSizes.every(([width, height]) => width === 1 && height === 1));
    assert.equal(results.job.bitmaps, results.job.closed);
    // GMD-024: chronological bars keep the original result-row identity. The
    // oldest successful clip here has zero detections and must still be usable.
    results.trend = await evaluate(`(() => {
      const bars=[...document.querySelectorAll('#trend [data-trend-i]')],oldest=bars[0];oldest.scrollIntoView({block:'center'});
      const rect=oldest.getBoundingClientRect();return {indices:bars.map(bar=>Number(bar.dataset.trendI)),
        titles:bars.map(bar=>bar.querySelector('title').textContent),point:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
    })()`);
    assert.deepEqual(results.trend.indices, [1, 0]);
    for (let index = 0; index < 2; index++) {
      const clip = results.job.summary.results[results.trend.indices[index]], title = results.trend.titles[index];
      assert.ok(title.includes(clip.date)); assert.ok(title.includes(results.job.summary.params.model));
      assert.ok(title.includes('Total: ' + clip.total));
      for (const [name, count] of Object.entries(clip.counts)) assert.ok(title.includes(count + ' ' + name.replace(/_/g, ' ')));
    }
    const beforeHover = requests.length;
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...results.trend.point });
    await until("Boolean(document.querySelector('#trend [data-trend-i]:hover'))");
    results.trend.hoverRequests = requests.length - beforeHover; assert.equal(results.trend.hoverRequests, 0);
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...results.trend.point, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...results.trend.point, button: 'left', clickCount: 1 });
    await until("document.querySelector('#annCtx').textContent.includes('2025-03-27') && Boolean(document.querySelector('#resTable tr.sel[data-i=\"1\"]'))");
    results.trend.mouseSelection = await evaluate("({pressed:document.querySelector('#trend [data-trend-i=\"1\"]').getAttribute('aria-pressed'),imagery:Boolean(document.querySelector('.leaflet-image-layer')),date:document.querySelector('#hudRel').textContent})");
    assert.equal(results.trend.mouseSelection.pressed, 'true'); assert.equal(results.trend.mouseSelection.imagery, true);
    assert.equal(results.trend.mouseSelection.date, '2025-03-27');
    await evaluate("document.querySelector('#trend [data-trend-i=\"0\"]').focus()");
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until("document.querySelector('#annCtx').textContent.includes('2026-10-29') && document.querySelector('#trend [data-trend-i=\"0\"]').getAttribute('aria-pressed')==='true'");
    results.trend.keyboardSelection = await evaluate("({row:Number(document.querySelector('#resTable tr.sel').dataset.i),date:document.querySelector('#hudRel').textContent})");
    assert.equal(results.trend.keyboardSelection.row, 0); assert.equal(results.trend.keyboardSelection.date, '2026-10-29');
    console.log('Chart hover, pointer and keyboard checks passed: ' + JSON.stringify(results.trend));
    await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    results.mobile = await evaluate(`(() => {const issues=document.querySelector('#jobOutcomes'),panel=document.querySelector('aside.panel');return {visible:!issues.hidden,
      fits:issues.getBoundingClientRect().width<=panel.getBoundingClientRect().width,bodyOverflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.equal(results.mobile.visible, true); assert.equal(results.mobile.fits, true); assert.equal(results.mobile.bodyOverflow, false);
    await evaluate("document.querySelector('#jobOutcomes').scrollIntoView({block:'end'})");
    const screenshot = await page('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(os.tmpdir(), `geomap-gmd023-mobile${forceWasm ? '-wasm' : ''}.png`), Buffer.from(screenshot.data, 'base64'));
    results.runtimeErrors = errors; assert.deepEqual(errors, []);
  });
  const output = process.env.GMD_RESULTS_PATH || path.join(os.tmpdir(), `geomap-gmd023-browser${forceWasm ? '-wasm' : ''}.json`);
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2)); console.log('Saved browser evidence: ' + output);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
