/* Actual pinned ORT 1.20.1 + nano/small in a classic processing worker.
 * node --use-system-ca tests/browser/worker-runtime.cjs [--wasm|--gpu-failure] [--live-imagery] [--output path]
 * Live model/runtime assets; deterministic imagery, unchanged 1024px windows.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { withChrome } = require('./chrome.cjs');
const root = path.resolve(__dirname, '../..'), forceWasm = process.argv.includes('--wasm'), failGpu = process.argv.includes('--gpu-failure'), profileMode = process.argv.includes('--profile'), liveImagery = process.argv.includes('--live-imagery') || profileMode;
const files = ['engine.js', 'map-view.js', 'streaming.js', 'processing.js', 'processing-worker.js', 'storage.js'];
const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file), 'utf8')]));
const results = { checkedAt: new Date().toISOString(), forcedWasm: forceWasm, failGpu, liveImagery, mode: 'Local project path, actual pinned runtime and published nano/small weights; '+(liveImagery ? 'live DXB imagery' : 'deterministic image fixture'),
  sources: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])) };
const providerFixture = forceWasm ? "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" : failGpu
  ? "Object.defineProperty(navigator,'gpu',{configurable:true,value:{requestAdapter:async()=>null}});" : '';
const fixture = profileMode ? `${providerFixture}
const fetchOriginal=globalThis.fetch.bind(globalThis);
globalThis.fetch=(url,options)=>String(url).includes('wayback.maptiles.arcgis.com')||String(url).includes('waybackconfig.json')
  ?fetchOriginal(new URL('provider?url='+encodeURIComponent(String(url)),location.href),options):fetchOriginal(url,options);
` : liveImagery ? providerFixture : `
${providerFixture}
const fetchOriginal=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(url,options)=>{
 if(String(url).includes('/tilemap/')){const [r,z,top,left,width,height]=String(url).split('/tilemap/')[1].split('/').map(Number);return new Response(JSON.stringify({valid:true,location:{top,left,width,height},data:Array(width*height).fill(1)}))}
 if(String(url).includes('/MapServer/tile/')){const c=new OffscreenCanvas(256,256),g=c.getContext('2d');try{g.fillStyle='#304050';g.fillRect(0,0,256,256);g.fillStyle='#dedede';g.fillRect(72,88,130,20);g.fillRect(125,50,20,100);return new Response(await c.convertToBlob())}finally{c.width=c.height=1}}
 return fetchOriginal(url,options);
};
`;
const captured = new Map(), providerOwner = new AbortController(); let providerBytes = 0;
const server = http.createServer(async (request, response) => {
  try {
  const file = new URL(request.url, 'http://local').pathname.replace('/GeoMap-Detector/', '');
  if (profileMode && file === 'provider') {
    const url = new URL(request.url, 'http://local').searchParams.get('url'), target = new URL(url);
    if (target.protocol !== 'https:' || !['wayback.maptiles.arcgis.com', 's3-us-west-2.amazonaws.com'].includes(target.hostname)) throw Error('Unexpected capture target');
    if (!captured.has(url)) {
      if (captured.size >= 256) throw Error('Provider capture entry limit exceeded');
      const promise = (async()=>{const remote=await fetch(url,{signal:AbortSignal.any([providerOwner.signal,AbortSignal.timeout(30000)])}),bytes=Buffer.from(await remote.arrayBuffer());
        providerBytes+=bytes.length;if(providerBytes>16*1048576)throw Error('Provider capture byte limit exceeded');
        return{status:remote.status,type:remote.headers.get('content-type')||'application/octet-stream',bytes};})();
      captured.set(url,promise);
    }
    const data = await captured.get(url); response.writeHead(data.status, { 'Content-Type': data.type }); response.end(data.bytes); return;
  }
  let body, type = 'application/javascript';
  if (file === '') { type = 'text/html'; body = '<!doctype html><script src="fflate.js"></script>' + ['engine.js', 'streaming.js', 'storage.js', 'processing.js'].map(f=>'<script src="'+f+'"></script>').join(''); }
  else if (file === 'fflate.js') body = fs.readFileSync(path.resolve(path.dirname(require.resolve('fflate')), '../umd/index.js'));
  else if (sources[file]) body = sources[file] + (file === 'engine.js' ? '\n' + fixture : '');
  else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body);
  } catch(error) { response.writeHead(502, { 'Content-Type':'application/json' }); response.end(JSON.stringify({error:error.message})); }
});
(async () => {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  try {
    await withChrome(async ({ page, evaluate, until, errors }) => {
      await page('Page.navigate', { url: 'http://127.0.0.1:'+server.address().port+'/GeoMap-Detector/' });
      await until('Boolean(window.GVProcessing)');
      results.browser = await evaluate('navigator.userAgent');
      if (profileMode) {
        await require('./inference-cases.cjs')({ evaluate, errors, results, forceWasm, failGpu });
        results.capturedProvider = { method: 'Test-only bounded same-origin provider proxy; identical captured bytes reused across models/modes; no production CORS claim', bytes: providerBytes,
          responses: await Promise.all([...captured].map(async([url,promise])=>{const d=await promise;return{url,status:d.status,bytes:d.bytes.length,sha256:createHash('sha256').update(d.bytes).digest('hex')}})) };
        return;
      }
      results.runs = await evaluate(`(async()=>{
        const repo=GVStorage.create({name:'gmd-worker-runtime'});await repo.open();const runs=[];
        const feature={type:'Feature',properties:{name:'Runtime'},geometry:{type:'Polygon',coordinates:[[[55.36,25.25],[55.362,25.25],[55.362,25.252],[55.36,25.252],[55.36,25.25]]]}};
        const release=${liveImagery ? "(await GVEngine.getReleases()).find(r=>r.date==='2026-10-29')" : "{release:101,date:'2026-10-29'}"};
        for(const name of ['n','s']){
          const spec={key:'yolo11'+name,url:'https://tri-ctrl.github.io/GeoMap-Detector/models/yolo11'+name+'-obb.onnx',imgsz:1024,names:GVEngine.DOTA_NAMES};
          const reasons=[],controller=new AbortController(),runner=await GVProcessing.create({jobId:spec.key,signal:controller.signal,store:repo,onFallback:r=>reasons.push(r)});
          if(runner.context!=='worker')throw Error('Expected a real worker: '+reasons.join(';'));
          try {
            const start=performance.now(),model=await runner.loadModel(spec),loaded=performance.now();
            const output=await runner.processClip(feature,release,{zoom:18,bounded:true,geotiff:true,clipId:spec.key+':0',classes:['aircraft','ship'],conf:.3});
            const reference=await GVEngine.models.acquire(spec);let original;
            try{original=await GVEngine.processClip(feature,release,{jobId:spec.key,clipId:spec.key+':0',zoom:18,bounded:true,geotiff:true,model:reference.model,classes:['aircraft','ship'],conf:.3})}finally{await reference.release()}
            const predictions=JSON.stringify(output.fc)===JSON.stringify(original.fc);
            const world=output.blobs.pgw===original.blobs.pgw;
            await GVStreaming.discardArtifact(output.artifactSpool,repo);await GVStreaming.discardArtifact(original.blobs.png.spool);
            runs.push({model:spec.key,modelFingerprint:model.fingerprint,provider:model.provider,release,loadMs:loaded-start,clipMs:output.timings.totalMs,predictions,world,total:output.total,size:output.size,timings:output.timings});
          } finally {await runner.close()}
        }
        await repo.close();return runs;
      })()`, 240000);
      for (const run of results.runs) { assert.match(run.modelFingerprint,/^sha256:[a-f0-9]{64}$/); assert.equal(run.predictions,true); assert.equal(run.world,true); assert.equal(run.provider,forceWasm||failGpu?'wasm':'webgpu'); if(liveImagery)assert.ok(run.total>0,'Live fixture must exercise nonempty predictions'); }
      results.cleanup = await evaluate('GVProcessing.diagnostics()');
      assert.equal(results.cleanup.active,0); assert.equal(results.cleanup.created,results.cleanup.terminated); assert.equal(results.cleanup.pendingStorage,0); assert.equal(results.cleanup.last.models.leased,0);
      assert.equal(results.cleanup.last.runtime.configuredVersion,'1.20.1'); assert.equal(results.cleanup.last.runtime.loaded,true);
      assert.equal(results.cleanup.last.telemetry.active,0);
      assert.deepEqual(errors,[]);
    });
    const out=process.argv.indexOf('--output');if(out>=0)fs.writeFileSync(path.resolve(process.argv[out+1]),JSON.stringify(results,null,2)+'\n');
    console.log(JSON.stringify(results,null,2));
  } finally {providerOwner.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
