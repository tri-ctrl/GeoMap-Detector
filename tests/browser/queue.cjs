/* GMD-025: real nano/small jobs in a sequential browser queue.
 * node --use-system-ca tests/browser/queue.cjs [--wasm]
 * Local source overrides, live model/imagery assets and a temporary Chrome
 * profile; no publication, accuracy or sustained-memory claim.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..'), base = 'https://tri-ctrl.github.io/GeoMap-Detector/';
const forceWasm = process.argv.includes('--wasm'), files = ['index.html', 'app.js', 'engine.js', 'comparison.js'];
const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file), 'utf8')]));
const results = { checkedAt: new Date().toISOString(), mode: 'Local source overrides; live nano/small inference; not deployed verification',
  forcedProvider: forceWasm ? 'wasm' : null, sources: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])) };
(async () => {
  await withChrome(async ({ page, evaluate, until, errors, on }) => {
    results.browser = await evaluate('navigator.userAgent');
    on('Fetch.requestPaused', ({ requestId, request }) => {
      const file = request.url === base ? 'index.html' : new URL(request.url).pathname.split('/').pop();
      const code = file === 'app.js' ? "const originalMap=L.map;L.map=function(...args){return window.__queueMap=originalMap(...args)};\n" + sources[file] : sources[file];
      page('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: file.endsWith('.html') ? 'text/html' : 'application/javascript' }], body: Buffer.from(code).toString('base64') }).catch(error => errors.push(error.message));
    });
    await page('Fetch.enable', { patterns: files.map(file => ({ urlPattern: file === 'index.html' ? base : base + file + '*' })) });
    await page('Page.setDownloadBehavior', { behavior: 'deny' });
    if (forceWasm) await page('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined})" });
    await page('Page.navigate', { url: base });
    await until("Boolean(window.GVEngine&&document.querySelectorAll('#model option').length>=2&&document.querySelector('#relList [data-r]')&&document.querySelector('.leaflet-tile-loaded'))");
    console.log('Loaded local queue sources, real Leaflet and provider assets.');
    await evaluate(`(() => {
      const probe=window.__queueProbe={loads:[],clips:[],events:[],exported:[],active:0,maxActive:0,canvases:[],bitmaps:[]};
      const Canvas=OffscreenCanvas;window.OffscreenCanvas=new Proxy(Canvas,{construct(Target,args){const canvas=new Target(...args);probe.canvases.push(canvas);return canvas}});
      const bitmap=createImageBitmap;window.createImageBitmap=async(...args)=>{const value=await bitmap(...args),close=value.close.bind(value),record={closed:0};value.close=()=>{record.closed++;close()};probe.bitmaps.push(record);return value};
      const gate=new Promise(resolve=>probe.release=resolve),load=GVEngine.loadModel,process=GVEngine.processClip,archive=GVEngine.exportJobZip;
      GVEngine.loadModel=async spec=>{probe.loads.push(spec.key);probe.events.push('load '+spec.key);if(probe.loads.length===1)await gate;return load(spec)};
      GVEngine.processClip=async(aoi,release,options)=>{probe.active++;probe.maxActive=Math.max(probe.maxActive,probe.active);probe.events.push('start '+options.model.key);
        try{const result=await process(aoi,release,options);probe.clips.push({model:options.model.key,aoi:aoi.properties.name,date:release.date,zoom:result.zoom,tiff:Boolean(result.blobs.tif),size:result.size,total:result.total});return result}
        finally{probe.active--;probe.events.push('end '+options.model.key)}};
      GVEngine.exportJobZip=async(job,options)=>{const blob=await archive(job,options),zip=await JSZip.loadAsync(blob),summary=JSON.parse(await zip.file(job.id+'/summary.json').async('string'));
        probe.exported.push({summary,files:Object.keys(zip.files),runtimeReleased:job.controller===null&&job.modelSpec===null&&job.releaseSource===null});return blob};
      const fc={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Queue_probe'},geometry:{type:'Polygon',coordinates:[[[55.36,25.25],[55.362,25.25],[55.362,25.252],[55.36,25.252],[55.36,25.25]]]}}]};
      const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(fc)],'queue-probe.geojson'));const input=document.querySelector('#fileIn');input.files=transfer.files;input.dispatchEvent(new Event('change'));
      document.querySelector('[data-tab=det]').click();document.querySelector('[name=relMode][value=latest]').checked=true;
      const model=document.querySelector('#model');model.value=[...model.options].find(option=>option.textContent.includes('nano')).value;
      document.querySelector('#detectOn').checked=true;document.querySelector('#tifOn').checked=true;
    })()`);
    await until("document.querySelector('#runN').textContent==='1'");
    await evaluate("document.querySelector('#runBtn').click()");
    await until('__queueProbe.loads.length===1');
    results.firstId = await evaluate("document.querySelector('[data-queued-job]').dataset.queuedJob");
    await evaluate(`(() => {
      const model=document.querySelector('#model');model.value=[...model.options].find(option=>option.textContent.includes('small')).value;model.dispatchEvent(new Event('change'));
      document.querySelector('#conf').value='0.4';document.querySelector('#tifOn').checked=false;document.querySelector('#runBtn').click();
    })()`);
    await until("document.querySelector('#queueStatus').textContent.includes('1/10 queued')");
    results.secondId = await evaluate("document.querySelectorAll('[data-queued-job]')[1].dataset.queuedJob");
    await evaluate("document.querySelector('#conf').value='0.5';document.querySelector('#runBtn').click()");
    await until("document.querySelector('#queueStatus').textContent.includes('2/10 queued')");
    results.cancelledId = await evaluate("document.querySelectorAll('[data-queued-job]')[2].dataset.queuedJob");
    await evaluate("document.querySelector('#cancelBtn').click()");
    results.waiting = await evaluate("({loads:[...__queueProbe.loads],clips:__queueProbe.clips.length,canvases:__queueProbe.canvases.length,bitmaps:__queueProbe.bitmaps.length,status:document.querySelector('#queueStatus').textContent,cancelled:document.querySelector('#jobLog').textContent})");
    assert.equal(results.waiting.loads.length, 1); assert.equal(results.waiting.clips, 0); assert.equal(results.waiting.canvases, 0); assert.equal(results.waiting.bitmaps, 0);
    assert.match(results.waiting.status, /1\/10 queued/); assert.match(results.waiting.cancelled, /Removed from the queue/);
    console.log('Verified waiting jobs and queued cancellation before heavy allocation.');
    await evaluate("document.querySelector('#jobQueue').scrollIntoView({block:'end'})");
    results.waiting.queueHeight = await evaluate("document.querySelector('#jobQueue').getBoundingClientRect().height");
    assert.ok(results.waiting.queueHeight > 150, 'Queue cards must keep usable height inside the scrolling panel');
    const queueScreenshot = await page('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(os.tmpdir(), 'geomap-queue-desktop.png'), Buffer.from(queueScreenshot.data, 'base64'));
    // Subsequent configuration/view changes must not affect either submission.
    await evaluate(`(() => {
      document.querySelector('#zoom').value='19';document.querySelector('#tifOn').checked=true;document.querySelector('#conf').value='0.8';
      for(const checkbox of document.querySelectorAll('#classChips input')){checkbox.checked=checkbox.value==='ship';checkbox.dispatchEvent(new Event('change'))}
      document.querySelector('[data-tab=img]').click();document.querySelectorAll('#relList [data-r]')[1].click();__queueMap.panBy([40,0],{animate:false});
    })()`);
    results.beforeCompletion = await evaluate("({date:document.querySelector('#hudRel').textContent,zoom:__queueMap.getZoom(),centre:[__queueMap.getCenter().lat,__queueMap.getCenter().lng],tab:document.querySelector('.rail [aria-selected=true]').dataset.tab})");
    await evaluate('__queueProbe.release()');
    await until("__queueProbe.clips.length===2&&document.querySelector('#queueStatus').textContent==='Idle · 0/10 queued'", 180000);
    results.execution = await evaluate("({loads:__queueProbe.loads,clips:__queueProbe.clips,events:__queueProbe.events,maxActive:__queueProbe.maxActive})");
    assert.equal(results.execution.loads.length, 2); assert.equal(results.execution.maxActive, 1);
    assert.match(results.execution.loads[0], /yolo11n/); assert.match(results.execution.loads[1], /yolo11s/);
    assert.equal(results.execution.clips[0].tiff, true); assert.equal(results.execution.clips[1].tiff, false);
    assert.ok(results.execution.clips.every(clip => clip.zoom === 18 && clip.date === '2026-10-29'));
    results.afterCompletion = await evaluate("({date:document.querySelector('#hudRel').textContent,zoom:__queueMap.getZoom(),centre:[__queueMap.getCenter().lat,__queueMap.getCenter().lng],tab:document.querySelector('.rail [aria-selected=true]').dataset.tab})");
    assert.deepEqual(results.afterCompletion, results.beforeCompletion);
    for (const id of [results.firstId, results.secondId]) {
      await evaluate(`document.querySelector('[data-job-results="${id}"]').click()`);
      await until(`document.querySelector('#jobSel').value==='${id}'&&document.querySelectorAll('#resTable tbody tr[data-i]').length===1`);
      await evaluate("document.querySelector('#expZip').onclick()", 60000);
    }
    results.exports = await evaluate('__queueProbe.exported');
    assert.equal(results.exports.length, 2);
    for (const [index, entry] of results.exports.entries()) {
      assert.equal(entry.summary.status, 'done'); assert.equal(entry.summary.params.zoom, 18); assert.equal(entry.summary.params.conf, index ? 0.4 : 0.3);
      assert.deepEqual(entry.summary.params.classes, ['aircraft', 'ship', 'helicopter']); assert.equal(entry.runtimeReleased, true);
      assert.equal(entry.files.some(file => file.endsWith('/image.tif')), index === 0);
      assert.ok(entry.files.some(file => file.endsWith('/image.pgw')));
      if (forceWasm) assert.equal(entry.summary.params.provider, 'wasm');
    }
    await evaluate("document.querySelector('#resultView').value='compare';document.querySelector('#compareKind').value='models';document.querySelector('#resultView').dispatchEvent(new Event('change'))");
    await until("document.querySelectorAll('[data-compare-row]').length===2");
    await evaluate("document.querySelector('[data-compare-row=\"0\"]').click();document.querySelector('[data-compare-row=\"1\"]').click()");
    await until("!document.querySelector('#compareMap').hidden&&document.querySelector('#compareLeftLabel').textContent.includes('nano')&&document.querySelector('#compareRightLabel').textContent.includes('small')");
    results.comparison = await evaluate("({left:document.querySelector('#compareLeftLabel').textContent,right:document.querySelector('#compareRightLabel').textContent,settings:document.querySelector('#compareSettings').textContent})");
    await evaluate("document.querySelector('#compareExit').click();document.querySelector('[data-tab=det]').click();document.querySelector('#jobQueue').scrollIntoView({block:'center'})");
    await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('#jobQueue').scrollIntoView({block:'end'})");
    results.mobile = await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,cards:document.querySelectorAll('[data-queued-job]').length,body:document.querySelector('#jobQueue').getBoundingClientRect().width,panel:document.querySelector('aside.panel').getBoundingClientRect().width,queueHeight:document.querySelector('#jobQueue').getBoundingClientRect().height,cancelHidden:getComputedStyle(document.querySelector('#cancelBtn')).display==='none'})");
    assert.equal(results.mobile.overflow, false); assert.ok(results.mobile.body <= results.mobile.panel);
    assert.ok(results.mobile.queueHeight > 150); assert.equal(results.mobile.cancelHidden, true);
    const mobileScreenshot = await page('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(os.tmpdir(), 'geomap-queue-mobile.png'), Buffer.from(mobileScreenshot.data, 'base64'));
    results.resources = await evaluate("({canvases:__queueProbe.canvases.length,allCanvasesReleased:__queueProbe.canvases.every(canvas=>canvas.width===1&&canvas.height===1),bitmaps:__queueProbe.bitmaps.length,allBitmapsClosed:__queueProbe.bitmaps.every(value=>value.closed===1)})");
    assert.equal(results.resources.allCanvasesReleased, true); assert.equal(results.resources.allBitmapsClosed, true);
    results.runtimeErrors = errors; assert.deepEqual(errors, []);
    console.log('Queue, two-model inference, export and comparison checks passed.');
  });
  const output = process.env.GMD_RESULTS_PATH || path.join(os.tmpdir(), `geomap-queue${forceWasm ? '-wasm' : ''}.json`);
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n'); console.log(JSON.stringify(results, null, 2)); console.log('Evidence: ' + output);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
