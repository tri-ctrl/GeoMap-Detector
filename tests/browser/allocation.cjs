/* Native Chromium allocation/encoding regression; deterministic tile/model
 * outputs. No live provider, accuracy, process-memory or deployment claim.
 * node tests/browser/allocation.cjs [--output docs/gmd-005-verification.json]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..'), names = ['index.html', 'engine.js', 'comparison.js', 'storage.js', 'streaming.js', 'app.js'];
const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(root, 'frontend', name), 'utf8')]));
const samples = JSON.parse(fs.readFileSync(path.join(root, 'frontend/sample_aois/uae_airports_ports.geojson'), 'utf8')).features;
const result = { checkedAt: new Date().toISOString(), mode: 'Local source, native Chromium; deterministic tiles and fixed inference outputs',
  sources: Object.fromEntries(names.map(name => [name, createHash('sha256').update(sources[name]).digest('hex')])),
  limitations: ['Owned canvas bytes and estimated reservations are not browser/process/GPU memory.', 'Not an accuracy benchmark, mobile-device calibration, sustained-memory test or deployed parity check.'] };
const fixture = String.raw`
window.__tileRequests=0;
const originalFetch=window.fetch.bind(window);let tile;
window.fetch=async(url,options)=>{
  if(String(url).includes('/tilemap/')){__tileRequests++;const [rel,z,top,left,width,height]=String(url).split('/tilemap/')[1].split('/').map(Number);
    return new Response(JSON.stringify({valid:true,location:{top,left,width,height},data:Array(width*height).fill(1)}));}
  if(String(url).includes('/MapServer/tile/')){__tileRequests++;
    if(window.__boundedFixture){const [ty,tx]=String(url).split('/').slice(-2).map(Number),canvas=new OffscreenCanvas(256,256),g=canvas.getContext('2d');
      try{g.fillStyle='rgb('+(tx%31+20)+','+(ty%31+80)+',150)';g.fillRect(0,0,256,256);g.fillStyle='rgb(220,40,20)';g.fillRect(80,40,90,170);return new Response(await canvas.convertToBlob());}finally{canvas.width=canvas.height=1;}}
    if(!tile){const canvas=new OffscreenCanvas(256,256),g=canvas.getContext('2d');g.fillStyle='rgb(40,90,150)';g.fillRect(0,0,256,256);tile=await canvas.convertToBlob();canvas.width=canvas.height=1;}return new Response(tile);}
  return originalFetch(url,options);
};
GVEngine.getReleases=async()=>[{release:101,date:'2026-10-29'}];
GVEngine.TILE_URL=()=> 'data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=';
GVEngine.markStartup=()=>{};
window.__ll=(x,y)=>[x/(256*2**18)*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/(256*2**18))))*180/Math.PI];
window.__shape=(w=400,h=128)=>{const x=171383*256+16,y=112057*256+16;return{type:'Polygon',coordinates:[[__ll(x,y),__ll(x+w,y),__ll(x+w,y+h),__ll(x,y+h),__ll(x,y)]]}};
window.__feature=geometry=>({type:'Feature',properties:{name:'Allocation'},geometry});
window.ort={Tensor:class{constructor(type,data,dims){this.data=data;this.dims=dims;}}};
window.__model={imgsz:1024,names:['plane'],session:{inputNames:['images'],outputNames:['output'],run:async feeds=>{
  if(feeds.images.dims.join(',')!=='1,3,1024,1024')throw Error('Input dimensions changed');
  return {output:{dims:[1,6,1],data:new Float32Array([48,48,20,12,.9,0])}};
}}};
localStorage.setItem('gv_aois',JSON.stringify([__feature(__shape())]));
`;
const server = http.createServer((request, response) => {
  const file = request.url.split('?')[0].slice(1) || 'index.html'; let body, type = 'application/javascript';
  if (file === 'index.html') {
    type = 'text/html'; body = sources[file].replace(/<link[^>]+href="https:[^"]*"[^>]*>/g, '')
      .replace('<title>', '<link rel="stylesheet" href="leaflet.css"><title>')
      .replace(/<script[^>]+src="https:[^"]*leaflet@1\.9\.4[^\"]*"[^>]*><\/script>/, '<script src="leaflet.js"></script>')
      .replace(/<script[^>]+src="https:[^\"]*"[^>]*><\/script>/g, '')
      .replace('<script src="engine.js">', '<script src="fflate.js"></script><script src="jszip.js"></script><script src="engine.js">');
  } else if (file === 'leaflet.js' || file === 'leaflet.css') { type = file.endsWith('.css') ? 'text/css' : type; body = fs.readFileSync(require.resolve('leaflet/dist/' + file)); }
  else if (file === 'fflate.js') body = fs.readFileSync(path.resolve(path.dirname(require.resolve('fflate')), '../umd/index.js'));
  else if (file === 'jszip.js') body = fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'));
  else if (file === 'engine.js') body = sources[file] + '\n' + fixture;
  else if (file === 'storage.js') body = sources[file] + '\nconst createRepo=GVStorage.create;GVStorage.create=options=>{const repo=createRepo(options);window.__repo=repo;return repo};';
  else if (sources[file]) body = sources[file];
  else if (file === 'models/models.json') { type = 'application/json'; body = JSON.stringify([{ file: 'nano.onnx', label: 'Fixture', names: ['plane'], imgsz: 1024 }]); }
  else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body);
});
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await withChrome(async ({ page, browser, evaluate, until, errors, on }) => {
      await page('Page.setDownloadBehavior', { behavior: 'deny' });
      if (process.argv.includes('--bounded')) await page('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__boundedFixture=true;' });
      await page('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
      await until("window.GVApp&&document.querySelector('#storageStatus').textContent.startsWith('Saved')&&document.querySelector('#model').options.length===1");
      result.browser = await evaluate('navigator.userAgent');
      if (process.argv.includes('--timeline')) {
        await require('./timeline-cases.cjs')({ page, evaluate, until, errors, result }); return;
      }
      if (process.argv.includes('--viewport')) {
        await require('./viewport-cases.cjs')({ page, evaluate, until, errors, result }); return;
      }
      if (process.argv.includes('--search')) {
        await require('./search-cases.cjs')({ page, browser, evaluate, until, errors, on, result }); return;
      }
      if (process.argv.includes('--bounded')) {
        await require('./bounded-cases.cjs')({ page, evaluate, until, errors, result, samples: process.argv.includes('--ci') ? samples.filter(s=>s.properties.name==='DXB') : samples, quick: process.argv.includes('--quick') }); return;
      }
      result.sampleEstimates = await evaluate(`(${JSON.stringify(samples)}).map(aoi=>{const p=GVEngine.estimateRaster(aoi.geometry,18,{modelSize:1024});return {aoi:aoi.properties.name,size:[p.width,p.height],tiles:p.tiles,zoom:p.zoom,estimatedBytes:p.estimatedBytes,allowed:p.allowed,codes:p.violations.map(v=>v.code)}})`);
      result.rejections = await evaluate(`(async()=>{
        const checks=[],before=GVEngine.allocations.diagnostics(),requests=__tileRequests;
        const cases=[['long-side',__shape(9000,2),{}],['pixels',__shape(),{limits:{maxPixels:1000}}],['memory',__shape(),{limits:{maxEstimatedBytes:1000}}],
          ['tensor',__shape(),{model:__model,limits:{maxEstimatedBytes:4*1048576}}],['floor',{type:'Polygon',coordinates:[[[-179,-80],[179,-80],[179,80],[-179,80],[-179,-80]]]},{maxTiles:1}]];
        for(const [name,geometry,options]of cases){try{await GVEngine.processClip(__feature(geometry),{release:101,date:'2026-10-29'},{geotiff:false,...options});throw Error('unexpected acceptance');}
          catch(error){checks.push({name,code:error.code,zoom:error.zoom})}}
        return {checks,created:GVEngine.allocations.diagnostics().canvasesCreated-before.canvasesCreated,requests:__tileRequests-requests};
      })()`);
      assert.deepEqual(result.rejections.checks.map(v => v.code), ['RASTER_LIMIT', 'RASTER_LIMIT', 'MEMORY_LIMIT', 'MEMORY_LIMIT', 'TILE_LIMIT']);
      assert.equal(result.rejections.created, 0); assert.equal(result.rejections.requests, 0);
      console.log('Oversized footprints rejected before tile requests, canvas creation and inference.');
      result.native = await evaluate(`(async()=>{
        const E=GVEngine,geometry=__shape(),x=171383*256+16,y=112057*256+16;
        geometry.coordinates.push([__ll(x+80,y+40),__ll(x+100,y+40),__ll(x+100,y+60),__ll(x+80,y+60),__ll(x+80,y+40)]);
        const estimate=E.estimateRaster(geometry,18,{modelSize:1024}),start=performance.now();
        const clip=window.__nativeClip=await E.processClip(__feature(geometry),{release:101,date:'2026-10-29'},{model:__model,classes:['aircraft']});
        const bitmap=await createImageBitmap(clip.blobs.png),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),g=canvas.getContext('2d');g.drawImage(bitmap,0,0);
        const png=g.getImageData(0,0,canvas.width,canvas.height).data,at=(px,py)=>Array.from(png.slice((py*canvas.width+px)*4,(py*canvas.width+px)*4+4));
        const solid=at(48,48),hole=at(90,50);bitmap.close();canvas.width=canvas.height=1;
        const data=await clip.blobs.tif.arrayBuffer(),view=new DataView(data),offset=view.getUint32(4,true),tags={};
        for(let i=0;i<view.getUint16(offset,true);i++){const e=offset+2+i*12,tag=view.getUint16(e,true),type=view.getUint16(e+2,true),count=view.getUint32(e+4,true),bytes=type===3?2:type===12?8:4;
          const base=count*bytes<=4?e+8:view.getUint32(e+8,true);tags[tag]=Array.from({length:count},(_,j)=>type===3?view.getUint16(base+j*bytes,true):type===12?view.getFloat64(base+j*bytes,true):view.getUint32(base+j*bytes,true));}
        let rows=0,different=0;
        for(let i=0;i<tags[273].length;i++){
          const encoded=new Blob([data.slice(tags[273][i],tags[273][i]+tags[279][i])]);
          const bytes=new Uint8Array(await new Response(encoded.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
          for(let j=0;j<bytes.length;j++)if(bytes[j]!==png[rows+j])different++;rows+=bytes.length;
        }
        const legacy=await GVCompare.preview(clip.blobs.png,undefined);
        const world=clip.blobs.pgw.split('\\n').slice(0,6).map(Number);
        const expectedGeo=[estimate.res,estimate.res,0];
        return {size:clip.size,estimatedSize:[estimate.width,estimate.height],requestedZoom:clip.requestedZoom,zoom:clip.zoom,
          counts:clip.counts,prediction:clip.fc.features[0],solid,hole,pixelsCompared:rows,different,tiffSize:[tags[256][0],tags[257][0]],
          scale:tags[33550],expectedGeo,tie:tags[33922],epsg:tags[34735].at(-1),world,legacySize:legacy.size,
          ms:performance.now()-start,estimateBytes:estimate.estimatedBytes,allocations:E.allocations.diagnostics()};
      })()`);
      const n = result.native;
      assert.deepEqual(n.size, n.estimatedSize); assert.deepEqual(n.size, n.tiffSize); assert.deepEqual(n.solid, [40, 90, 150, 255]); assert.equal(n.hole[3], 0);
      assert.equal(n.pixelsCompared, n.size[0] * n.size[1] * 4); assert.equal(n.different, 0); assert.equal(n.epsg, 3857);
      assert.deepEqual(n.scale, n.expectedGeo); assert.equal(n.world[0], n.scale[0]); assert.equal(n.world[3], -n.scale[1]);
      assert.equal(n.world[4], n.tie[3] + n.world[0] / 2); assert.equal(n.world[5], n.tie[4] + n.world[3] / 2);
      assert.deepEqual(n.counts, { aircraft: 1 }); assert.equal(n.prediction.properties.status, 'predicted'); assert.equal(n.requestedZoom, 18); assert.equal(n.zoom, 18);
      assert.equal(n.allocations.reservedBytes, 0); assert.equal(n.allocations.liveCanvasBytes, 0); assert.deepEqual(n.legacySize, n.size);
      console.log('Native PNG/TIFF pixels, holes, EPSG/world file, fixed predictions and legacy comparison verified.');
      result.ui = await evaluate(`(async()=>{
        const q=id=>document.querySelector('#'+id);q('detectOn').checked=false;q('rasterMemory').value='1';q('rasterMemory').dispatchEvent(new Event('change'));
        const blocked=q('runBtn').disabled,text=q('allocationPreflight').textContent;
        q('rasterMemory').value='64';q('rasterMemory').dispatchEvent(new Event('change'));
        const enabled=!q('runBtn').disabled;
        const job=await q('runBtn').onclick();
        return {blocked,text,enabled,status:job.status,limits:job.params.allocationLimits,summary:job.results.map(r=>({size:r.size,zoom:r.zoom,requestedZoom:r.requestedZoom}))};
      })()`);
      assert.equal(result.ui.blocked, true); assert.equal(result.ui.enabled, true); assert.equal(result.ui.status, 'done'); assert.equal(result.ui.limits.maxEstimatedBytes, 64 * 1048576);
      await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate("document.querySelector('[data-tab=det]').click()");
      result.narrow = await evaluate("({viewport:innerWidth,width:document.documentElement.scrollWidth,preflight:document.querySelector('#allocationPreflight').getBoundingClientRect().width})");
      assert.ok(result.narrow.width <= result.narrow.viewport);
      result.repeated = await evaluate(`(async()=>{const start=performance.now();for(let i=0;i<10;i++)await GVEngine.processClip(__feature(__shape()),{release:101,date:'2026-10-29'},{geotiff:false});return{cycles:10,ms:performance.now()-start,...GVEngine.allocations.diagnostics()}})()`);
      assert.equal(result.repeated.liveCanvasBytes, 0); assert.equal(result.repeated.reservedBytes, 0); assert.equal(result.repeated.canvasesCreated, result.repeated.canvasesReleased);
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('Preflight, frozen job limits, 390px layout and ten balanced native clip owners verified.');
    });
    const output = process.argv.indexOf('--output'); if (output >= 0) fs.writeFileSync(path.resolve(root, process.argv[output + 1]), JSON.stringify(result, null, 2) + '\n');
    if (!process.argv.includes('--quiet')) console.log(JSON.stringify(result, null, 2));
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
