/* Native IndexedDB + real Leaflet/ZIP, deterministic tiny raster fixtures.
 * No network, model inference, throughput or detection-quality claim.
 * node tests/browser/persistence.cjs [--lifecycle] [--output docs/gmd-008-verification.json]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..');
const lifecycle = process.argv.includes('--lifecycle');
const files = ['index.html', 'engine.js', 'comparison.js', 'storage.js', 'streaming.js', 'app.js'];
const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file), 'utf8')]));
const results = { checkedAt: new Date().toISOString(), mode: 'Local source, native Chromium IndexedDB; deterministic raster/model fixtures; no publication or inference claim',
  sources: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])) };
const aoi = { type: 'Feature', id: 'external-aoi-id', properties: { name: 'Persistence', unknown: { preserved: true } },
  geometry: { type: 'Polygon', coordinates: [[[55.36, 25.25], [55.362, 25.25], [55.362, 25.252], [55.36, 25.252], [55.36, 25.25]]] } };
const fixture = String.raw`
window.__calls=[]; window.__repoReady=performance.now();
Object.assign(GVEngine,{
  getReleases:async()=>[{release:101,date:'2026-10-29'},{release:100,date:'2025-03-27'}],
  TILE_URL:()=> 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  loadModel:async spec=>({key:spec.key,provider:'fixture',imgsz:1024,names:spec.names}),
  processClip:async(feature,release,options)=>{
    __calls.push({release:release.release,model:options.model?.key});
    if(sessionStorage.getItem('hold')==='yes'&&release.release===100) await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Interrupted','AbortError')),{once:true}));
    if(options.signal.aborted)throw new DOMException('Interrupted','AbortError');
    const canvas=new OffscreenCanvas(32,16),ctx=canvas.getContext('2d');ctx.fillStyle='#405060';ctx.fillRect(0,0,32,16);
    const png=await canvas.convertToBlob({type:'image/png'});canvas.width=canvas.height=1;
    const object={type:'Feature',id:'same-external-prediction-id',geometry:JSON.parse(JSON.stringify(feature.geometry)),properties:{class:'aircraft',status:'predicted',confidence:0.91,centroid:[55.361,25.251],aoi_id:'Persistence',release:release.release}};
    return {aoi:'Persistence',aoi_id:'Persistence',aoiFeature:feature,release:release.release,date:release.date,zoom:18,bounds:[55.36,25.25,55.362,25.252],size:[32,16],total:1,counts:{aircraft:1},fc:{type:'FeatureCollection',features:[object]},blobs:{png,tif:new Blob(['native-tiff-fixture']),preview:png,pgw:'1\n0\n0\n-1\n10\n20'}};
  }
});
`;
const server = http.createServer((request, response) => {
  const file = new URL(request.url, 'http://local').pathname.slice(1) || 'index.html';
  let body, type = 'application/javascript';
  if (file === 'index.html') {
    type = 'text/html'; body = sources[file].replace('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', '/leaflet.js')
      .replace('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', '/leaflet.css').replace(/<link\b[^>]*href="https:\/\/[^\"]*"[^>]*>/g, '')
      .replace('<script src="engine.js">', '<script src="fflate.js"></script><script src="jszip.js"></script><script src="engine.js">');
  } else if (file === 'leaflet.js' || file === 'leaflet.css') {
    type = file.endsWith('.css') ? 'text/css' : type; body = fs.readFileSync(require.resolve('leaflet/dist/' + file));
  } else if (file === 'jszip.js') body = fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'));
  else if (file === 'fflate.js') body = fs.readFileSync(path.resolve(path.dirname(require.resolve('fflate')), '../umd/index.js'));
  else if (file === 'leaflet-draw.js') body = fs.readFileSync(require.resolve('leaflet-draw/dist/leaflet.draw.js'));
  else if (file === 'engine.js') body = sources[file].replace('https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js', '/leaflet-draw.js') + '\n' + fixture;
  else if (file === 'storage.js') body = sources[file] + '\nconst createRepo=GVStorage.create;GVStorage.create=options=>{const repo=createRepo(options);window.__repo ||= repo;return repo};';
  else if (file === 'app.js') body = 'const makeMap=L.map;L.map=(...args)=>(window.__map=makeMap(...args));\n' + sources[file];
  else if (sources[file]) body = sources[file];
  else if (file === 'models/models.json') { type = 'application/json'; body = JSON.stringify(['alpha', 'beta'].map(key => ({ file: key + '.onnx', label: key, names: ['plane'], imgsz: 1024 }))); }
  else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body);
});
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    await withChrome(async ({ page, evaluate, until, errors, on }) => {
      on('Page.javascriptDialogOpening', ({ type }) => page('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
      await page('Page.setDownloadBehavior', { behavior: 'deny' });
      await page('Page.addScriptToEvaluateOnNewDocument', { source: `
        if(!sessionStorage.getItem('seeded')){localStorage.setItem('gv_aois',JSON.stringify([${JSON.stringify(aoi)}]));localStorage.setItem('gv_ann',JSON.stringify({type:'FeatureCollection',features:[{...${JSON.stringify(aoi)},id:'legacy-review',properties:{class:'ship',status:'verified',release:101}}]}));sessionStorage.setItem('seeded','yes')}
        window.__urls={created:0,revoked:0};const makeURL=URL.createObjectURL.bind(URL),dropURL=URL.revokeObjectURL.bind(URL);
        URL.createObjectURL=b=>{__urls.created++;return makeURL(b)};URL.revokeObjectURL=u=>{__urls.revoked++;return dropURL(u)};
      ` });
      await page('Page.navigate', { url });
      const ready = async () => {
        try { await until("window.__repo&&document.querySelector('#storageStatus').textContent.startsWith('Saved')&&document.querySelector('#model').options.length===2"); }
        catch (error) { console.error(await evaluate("({status:document.querySelector('#storageStatus')?.textContent,model:document.querySelector('#model')?.innerHTML,repo:Boolean(window.__repo),engine:Boolean(window.GVEngine)})"), errors); throw error; }
      };
      const reloadDocument = async () => {
        const previous = await evaluate('performance.timeOrigin'); await page('Page.reload');
        for (let i = 0; i < 500; i++) {
          try { if (await evaluate(`performance.timeOrigin!==${previous}&&document.readyState==='complete'`)) return; } catch {}
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('New document did not finish reloading');
      };
      await ready(); results.browser = await evaluate('navigator.userAgent');
      console.log('Native database opened; legacy records migrated.');
      results.startup = await evaluate('({ms:performance.now()-__repoReady,reads:__repo.state().reads})');
      await evaluate(`(() => {
        sessionStorage.setItem('hold','yes');document.querySelector('[data-tab=det]').click();document.querySelector('#detectOn').checked=true;
        document.querySelector('[name=relMode][value=selected]').checked=true;
        document.querySelectorAll('#relList [data-c]').forEach(box=>{box.checked=true;box.onchange()});document.querySelector('#runBtn').click();
      })()`);
      await until('__calls.length===2');
      const firstId = await evaluate("document.querySelector('[data-queued-job]').dataset.queuedJob");
      await evaluate(`document.querySelector('#model').value='url:beta.onnx';document.querySelector('#model').onchange();document.querySelector('[name=relMode][value=latest]').checked=true;document.querySelector('#runBtn').click()`);
      await until("document.querySelector('#queueStatus').textContent.includes('1/10 queued')&&document.querySelector('#storageStatus').textContent.startsWith('Saved')");
      results.beforeReload = await evaluate(`__repo.restore().then(s=>({jobs:s.jobs.map(j=>({id:j.id,status:j.status,clips:j.results.length})),queue:s.queue}))`);
      console.log('First clip committed; interrupted queue is ready for reload.');
      // Reading a catalog is safe; restore itself normalizes interrupted status.
      await evaluate("sessionStorage.removeItem('hold')"); await reloadDocument(); await ready();
      results.recovery = await evaluate(`__repo.restore().then(s=>({jobs:s.jobs.map(j=>({status:j.status,clips:j.results.length})),calls:__calls,reads:__repo.state().reads,status:document.querySelector('#queueStatus').textContent}))`);
      assert.equal(results.recovery.calls.length, 0); assert.match(results.recovery.status, /Paused · 2\/10 queued/);
      assert.equal(results.recovery.reads.artifacts, undefined); assert.equal(results.recovery.jobs[0].clips, 1);
      await evaluate("document.querySelector('#resumeQueue').click()");
      await until("document.querySelector('#queueStatus').textContent==='Idle · 0/10 queued'&&document.querySelector('#storageStatus').textContent.startsWith('Saved')");
      results.resumed = await evaluate('__calls'); assert.deepEqual(results.resumed, [{ release: 100, model: 'url:alpha.onnx' }, { release: 101, model: 'url:beta.onnx' }]);
      await evaluate(`document.querySelector('[data-job-results="${firstId}"]').click()`);
      await until("document.querySelectorAll('#resTable tbody tr[data-i]').length===2");
      await evaluate("document.querySelector('#resTable tbody tr[data-i]').click()"); await until("document.querySelector('#annStats').textContent==='0/1 reviewed'");
      await evaluate("document.querySelector('#acceptAll').click();document.querySelector('#saveAnn').click()");
      await until("document.querySelector('#storageStatus').textContent.startsWith('Saved')");
      results.reviews = await evaluate(`__repo.restore().then(async s=>{const id=s.jobs[0].results[0].storeId,c=await __repo.clip(id);return {raw:c.fc.features[0].properties.status,draft:c.draftFC.features[0].properties.status,legacy:localStorage.getItem('gv_ann'),saved:(await __repo.reviews()).features.length,clipId:id,commit:__repo.state().lastCommitMs}})`);
      assert.equal(results.reviews.raw, 'predicted'); assert.equal(results.reviews.draft, 'verified'); assert.equal(results.reviews.saved, 2);
      await reloadDocument(); await ready();
      await evaluate(`document.querySelector('#jobSel').value='${firstId}';document.querySelector('#jobSel').onchange()`);
      await until("document.querySelectorAll('#resTable tbody tr[data-i]').length===2");
      await evaluate("document.querySelector('#resTable tbody tr[data-i]').click()"); await until("document.querySelector('#annStats').textContent==='1/1 reviewed'");
      results.afterDraftReload = await evaluate("({stats:document.querySelector('#annStats').textContent,urls:{...__urls},reads:__repo.state().reads})");
      await evaluate("document.querySelectorAll('#resTable tbody tr[data-i]')[1].click()"); await until("document.querySelector('#annStats').textContent==='0/1 reviewed'");
      results.imageOwnership = await evaluate('__urls'); assert.equal(results.imageOwnership.created, 2); assert.equal(results.imageOwnership.revoked, 1);
      if (lifecycle) {
        results.lazyDrawing = await evaluate('({loadedBeforeEdit:!!L.Draw,existingPolygons:Object.values(__map._layers).filter(layer=>layer instanceof L.Polygon&&layer.options.pane===\'gmd-detections\').length})');
        assert.equal(results.lazyDrawing.loadedBeforeEdit, false); assert.equal(results.lazyDrawing.existingPolygons, 1);
        await evaluate(`(() => {
          __map.stop();__map.setView([25.251,55.361],18,{animate:false});window.__retired=Object.values(__map._layers).find(layer=>layer instanceof L.Polygon&&layer.options.pane==='gmd-detections');
          __retired.fire('click',{originalEvent:new MouseEvent('click')});
        })()`);
        await evaluate("document.querySelector('#bEdit').onclick()");
        await until("!!document.querySelector('.leaflet-editing-icon')");
        const marker = await evaluate(`(() => {const marker=__retired.editing._verticesHandlers[0]._markers[0],rect=marker.getElement().getBoundingClientRect();window.__beforeDrag=JSON.stringify(__retired.toGeoJSON(false).geometry);return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
        await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...marker, button: 'left', clickCount: 1 });
        await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: marker.x + 12, y: marker.y + 9, button: 'left', buttons: 1 });
        await until('JSON.stringify(__retired.toGeoJSON(false).geometry)!==__beforeDrag');
        await evaluate("window.__editedGeometry=JSON.stringify(__retired.toGeoJSON(false).geometry);document.querySelector('#resTable tbody tr[data-i]').click()");
        await until("GVApp.diagnostics().views.scope.endsWith(':clip:0')&&document.querySelector('#annStats').textContent==='1/1 reviewed'");
        await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: marker.x + 12, y: marker.y + 9, button: 'left', clickCount: 1 });
        results.dragSwitch = await evaluate("({disabled:!__retired.editing.enabled(),detached:!__retired._map,events:Object.keys(__retired._events||{}),markers:document.querySelectorAll('.leaflet-editing-icon').length,selected:GVApp.diagnostics().views.selected,activeDrag:!!L.Draggable._dragging})");
        assert.equal(results.dragSwitch.disabled, true); assert.equal(results.dragSwitch.detached, true); assert.equal(results.dragSwitch.markers, 0); assert.equal(results.dragSwitch.selected, false); assert.equal(results.dragSwitch.activeDrag, false); assert.deepEqual(results.dragSwitch.events, []);
        const measurements = [];
        for (let cycle = 0; cycle < 20; cycle++) {
          const index = cycle % 2, scope = firstId + ':clip:' + index;
          const started = Date.now(); await evaluate(`document.querySelectorAll('#resTable tbody tr[data-i]')[${index}].click()`);
          await until(`GVApp.diagnostics().views.scope==='${scope}'&&!GVApp.diagnostics().views.loading&&!!document.querySelector('.leaflet-image-layer')`);
          await evaluate("document.querySelector('#showImg').checked=false;document.querySelector('#showImg').onchange()");
          assert.equal(await evaluate('GVApp.diagnostics().views.imageLeases'), 0);
          await evaluate("document.querySelector('#showImg').checked=true;document.querySelector('#showImg').onchange()");
          measurements.push(await evaluate(`({ms:${Date.now() - started},...GVApp.diagnostics().views,rowPayloads:GVApp.diagnostics().rowPayloads,markers:document.querySelectorAll('.leaflet-editing-icon').length,obsoleteMapListeners:Object.values(__map._events).flat().filter(e=>e.ctx instanceof L.Layer&&e.ctx._map===null).length})`));
        }
        assert.ok(measurements.every(m=>m.active===1&&m.created-m.disposed===1&&m.imageLeases===1&&m.rowPayloads<=1&&m.markers===0&&m.obsoleteMapListeners===0));
        const ordered = measurements.map(m=>m.ms).sort((a,b)=>a-b);
        results.switches = { count: measurements.length, medianMs: ordered[10], maxMs: ordered.at(-1), last: measurements.at(-1), measurement: 'UI/poll end-to-end on tiny local fixtures; not production latency or a memory/leak benchmark' };
        await until("document.querySelector('#storageStatus').textContent.startsWith('Saved')");
        results.editedDraft = await evaluate(`__repo.restore().then(async s=>{const clip=s.jobs[0].results[1],stored=await __repo.clip(clip.storeId);return {draftMatches:JSON.stringify(stored.draftFC.features[0].geometry)===__editedGeometry,rawUnchanged:JSON.stringify(stored.fc.features[0].geometry)===__beforeDrag}})`);
        assert.equal(results.editedDraft.draftMatches, true); assert.equal(results.editedDraft.rawUnchanged, true);
        await evaluate(`(() => {
          const read=window.__readClipOriginal=__repo.clip.bind(__repo);window.__releaseRead=null;window.__waitingRead=false;
          __repo.clip=async(id,...args)=>{const value=await read(id,...args);if(id==='${firstId}:clip:0'){__waitingRead=true;await new Promise(resolve=>__releaseRead=resolve)}return value};
          document.querySelector('#resTable tbody tr[data-i]').click();
        })()`);
        await until('__waitingRead'); await evaluate("document.querySelectorAll('#resTable tbody tr[data-i]')[1].click()");
        await until("GVApp.diagnostics().views.scope.endsWith(':clip:1')&&!GVApp.diagnostics().views.loading");
        await evaluate('__releaseRead()'); await until('GVApp.diagnostics().views.staleReads>0');
        results.reorderedRead = await evaluate('GVApp.diagnostics().views'); assert.ok(results.reorderedRead.scope.endsWith(':clip:1'));
        // Release the test gate for subsequent native ZIP/export checks.
        await evaluate('__repo.clip=__readClipOriginal');
        console.log('GMD-004: real vertex drag, twenty view switches, URL release and stale-read rejection passed.');
      }
      // Native ZIP consumes lazily loaded originals and the stored draft.
      results.export = await evaluate(`(async()=>{const s=await __repo.restore(),j=s.jobs.find(j=>j.id==='${firstId}'),blob=await GVEngine.exportJobZip(j,{readResult:r=>__repo.clip(r.storeId)}),zip=await JSZip.loadAsync(blob),prefix=j.id+'/Persistence/2026-10-29/';const png=await zip.file(prefix+'image.png').async('blob'),bitmap=await createImageBitmap(png),dimensions=[bitmap.width,bitmap.height];bitmap.close();return {files:Object.keys(zip.files),dimensions,pgw:await zip.file(prefix+'image.pgw').async('string'),tiff:await zip.file(prefix+'image.tif').async('string'),status:JSON.parse(await zip.file(prefix+'detections.geojson').async('string')).features[0].properties.status}})()`);
      assert.deepEqual(results.export.dimensions, [32, 16]); assert.equal(results.export.pgw, '1\n0\n0\n-1\n10\n20'); assert.equal(results.export.tiff, 'native-tiff-fixture'); assert.equal(results.export.status, 'verified');
      results.collidingExport = await evaluate(`(async()=>{const s=await __repo.restore(),r=await __repo.clip(s.jobs[0].results[0].storeId),other={...r,storeId:'different-aoi-clip',aoiFeature:{...r.aoiFeature,_gmd_id:'different-aoi'}};const j={...s.jobs[0],results:[r,other]},zip=await JSZip.loadAsync(await GVEngine.exportJobZip(j)),summary=JSON.parse(await zip.file(j.id+'/summary.json').async('string'));return {images:Object.keys(zip.files).filter(f=>f.endsWith('/image.png')).length,paths:summary.results.map(r=>r.path)}})()`);
      assert.equal(results.collidingExport.images, 2); assert.equal(new Set(results.collidingExport.paths).size, 2);
      // A second live connection cannot acquire the workspace's Web Lock.
      results.secondTab = await evaluate('(async()=>{const other=GVStorage.create();const state=await other.open();let blocked=false;try{await other.saveAois([])}catch(e){blocked=e.name===\'ReadOnlyError\'}await other.close();return {writable:state.writable,blocked}})()');
      assert.deepEqual(results.secondTab, { writable: false, blocked: true });
      results.quotaRollback = await evaluate(`(async()=>{
        const s=await __repo.restore(),j=s.jobs[0],r=await __repo.clip(j.results[0].storeId),before=j.results.length;
        r.storeId='abort-probe';const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='artifacts')throw new DOMException('Fixture quota exhaustion','QuotaExceededError');return put.apply(this,args)};
        let error;try{await __repo.saveClip(j,r)}catch(e){error=e.name}finally{IDBObjectStore.prototype.put=put}
        const after=(await __repo.restore()).jobs.find(x=>x.id===j.id).results.length;let missing=false;try{await __repo.clip('abort-probe')}catch{missing=true}return {error,before,after,missing}
      })()`);
      assert.equal(results.quotaRollback.error, 'QuotaExceededError'); assert.equal(results.quotaRollback.before, results.quotaRollback.after); assert.equal(results.quotaRollback.missing, true);
      results.deletion = await evaluate(`(async()=>{const before=(await __repo.reviews()).features.length;${lifecycle ? "await document.querySelector('#deleteJob').onclick()" : "await __repo.deleteJob('" + firstId + "')"};const s=await __repo.restore();let missing=false;try{await __repo.clip('${results.reviews.clipId}')}catch{missing=true}return {jobs:s.jobs.length,before,after:(await __repo.reviews()).features.length,missing}})()`);
      assert.deepEqual(results.deletion, { jobs: 1, before: 2, after: 2, missing: true });
      if (lifecycle) { results.deletedView = await evaluate('GVApp.diagnostics()'); assert.equal(results.deletedView.views.active, 0); assert.equal(results.deletedView.views.imageLeases, 0); assert.equal(results.deletedView.views.selected, false); }
      if (process.argv.includes('--queue-recovery')) {
        const before=await evaluate(`(async()=>{const s=await __repo.restore(),template=s.jobs[0];for(const [id,status]of [['recover-cancelled','cancelled'],['recover-1','queued'],['recover-2','queued'],['recover-3','queued']])await __repo.saveJob({...template,id,status,createdAt:Date.now(),progress:0,log:[],plan:null,outcomes:[],modelSpec:null,params:{...template.params,detect:false},releaseSource:[{release:101,date:'2026-10-29'}]});return{jobs:s.jobs.length,reviews:(await __repo.reviews()).features.length}})()`);
        await reloadDocument();await ready();await until("document.querySelector('#jobSel').options.length===5");
        results.queueRecovery=await evaluate("({calls:__calls.length,state:GVApp.diagnostics().queue,status:document.querySelector('#queueStatus').textContent,hint:document.querySelector('#queueHint').textContent,resumeVisible:!document.querySelector('#resumeQueue').hidden})");
        assert.equal(results.queueRecovery.calls,0);assert.equal(results.queueRecovery.state.waiting,3);assert.equal(results.queueRecovery.state.state,'paused');assert.match(results.queueRecovery.hint,/Resume queue/);assert.equal(results.queueRecovery.resumeVisible,true);
        await evaluate("(async()=>{document.querySelector('#jobSel').value='recover-cancelled';document.querySelector('#jobSel').onchange();await document.querySelector('#deleteJob').onclick()})()");
        assert.equal(await evaluate('__calls.length'),0);
        await evaluate("(()=>{window.__queueActive=0;window.__queueMax=0;const process=GVEngine.processClip;GVEngine.processClip=async(...args)=>{__queueMax=Math.max(__queueMax,++__queueActive);try{return await process(...args)}finally{__queueActive--}};document.querySelector('#resumeQueue').click()})()");
        await until("GVApp.diagnostics().queue.waiting===0&&!GVApp.diagnostics().queue.activeId&&document.querySelector('#storageStatus').textContent.startsWith('Saved')");
        results.queueRecovery.after=await evaluate("__repo.restore().then(async s=>({calls:__calls.length,maxActive:__queueMax,jobs:s.jobs.map(j=>({id:j.id,status:j.status})),queued:s.queue.length,reviews:(await __repo.reviews()).features.length}))");
        assert.equal(results.queueRecovery.after.calls,3);assert.equal(results.queueRecovery.after.maxActive,1);assert.equal(results.queueRecovery.after.jobs.length,before.jobs+3);assert.ok(results.queueRecovery.after.jobs.every(j=>j.status==='done'));assert.equal(results.queueRecovery.after.reviews,before.reviews);
        await evaluate("Promise.all(['recover-1','recover-2','recover-3'].map(id=>__repo.deleteJob(id)))");
        console.log('Three saved queued jobs stay explicitly paused, survive cancelled-job deletion, then resume sequentially with reviews intact.');
      }
      await evaluate("window.__otherDocument=document.createElement('iframe');__otherDocument.src='/';document.body.append(__otherDocument)");
      await until("__otherDocument.contentDocument?.querySelector('#storageStatus')?.textContent.startsWith('Read only')");
      results.otherDocument = await evaluate("({status:__otherDocument.contentDocument.querySelector('#storageStatus').textContent,runDisabled:__otherDocument.contentDocument.querySelector('#runBtn').disabled})");
      assert.equal(results.otherDocument.runDisabled, true); await evaluate('__otherDocument.remove()');
      const blocked = await page('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window,'indexedDB',{configurable:true,get(){throw new DOMException('Fixture disabled storage','SecurityError')}})" });
      await reloadDocument();
      await until("document.querySelector('#storageStatus').textContent.startsWith('Session only')&&document.querySelector('#model').options.length===2");
      results.disabledStorage = await evaluate("({status:document.querySelector('#storageStatus').textContent,map:!!document.querySelector('.leaflet-container'),runEnabled:!document.querySelector('#runBtn').disabled})");
      assert.equal(results.disabledStorage.runEnabled, true);
      await page('Page.removeScriptToEvaluateOnNewDocument', { identifier: blocked.identifier }); await reloadDocument(); await ready();
      results.upgradeRollback = await evaluate(`(async()=>{
        let error;await new Promise(resolve=>{const r=indexedDB.open(GVStorage.NAME,GVStorage.VERSION+1);r.onupgradeneeded=()=>{r.result.createObjectStore('aborted-upgrade');r.transaction.abort()};r.onerror=()=>{error=r.error.name;resolve()}});
        return {error,status:document.querySelector('#storageStatus').textContent}
      })()`);
      assert.equal(results.upgradeRollback.error, 'AbortError'); assert.match(results.upgradeRollback.status, /Reload this tab/);
      await reloadDocument(); await ready();
      results.afterUpgradeRollback = await evaluate('__repo.restore().then(s=>({jobs:s.jobs.length,reviews:s.jobs.length&&__repo.state().available}))');
      assert.equal(results.afterUpgradeRollback.jobs, 1);
      results.newerSchema = await evaluate(`(async()=>{
        await new Promise(resolve=>{const r=indexedDB.open(GVStorage.NAME,GVStorage.VERSION+1);r.onsuccess=()=>{r.result.close();resolve()}});
        const previous=GVStorage.create();let error;try{await previous.open()}catch(e){error=e.name}
        const db=await new Promise(resolve=>{const r=indexedDB.open(GVStorage.NAME);r.onsuccess=()=>resolve(r.result)});
        const version=db.version;db.close();return {error,version}
      })()`);
      assert.deepEqual(results.newerSchema, { error: 'VersionError', version: 3 });
      results.exceptions = errors; assert.deepEqual(errors, []);
      const outputIndex = process.argv.indexOf('--output'); if (outputIndex >= 0) fs.writeFileSync(path.resolve(root, process.argv[outputIndex + 1]), JSON.stringify(results, null, 2) + '\n');
      console.log(JSON.stringify(results, null, 2));
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
