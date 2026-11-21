/* Native rendering/storage/worker checks, with deterministic tiles/model facade.
 * Optional wall-clock experiment is a scoped instrumentation cost measurement.
 */
const assert = require('node:assert/strict');
module.exports = async ({ evaluate, page, until, errors, result, benchmark }) => {
  await until("GVEngine.build.info().status==='matched'");
  result.diagnostics = await evaluate(`(async()=>{
    const E=GVEngine,feature=__feature(__shape(400,128)),release={release:101,date:'2026-10-29'},spec={key:'url:nano.onnx',names:['plane'],imgsz:1024};
    feature._gmd_id='gmd020-fixture';const repo=GVStorage.create({name:'gmd020-native'});await repo.open();
    const runner=await GVProcessing.create({jobId:'gmd020-worker',store:repo}),records=[];
    let output,reference,lease;
    try {
      await runner.loadModel(spec);lease=await E.models.acquire(spec);
      const options={bounded:true,png:false,geotiff:false,zoom:18,jobId:'gmd020-worker',clipId:'gmd020-clip'};
      output=await runner.processClip(feature,release,options);reference=await E.processClip(feature,release,{...options,model:lease.model});
      if(JSON.stringify(output.fc)!==JSON.stringify(reference.fc)||output.blobs.pgw!==reference.blobs.pgw)throw Error('Worker/main output changed');
    }finally{await lease?.release();await runner.close();await repo.close()}
    const worker=E.telemetry.snapshot(),foreign=worker.events.filter(e=>e.contextKind==='worker');
    if(!foreign.some(e=>e.name==='clip'&&e.type==='end')||!foreign.some(e=>e.name==='inference'&&e.type==='end'))throw Error('Worker telemetry missing');
    const contexts=[...new Set(foreign.map(e=>e.contextId))];
    const oldFetch=window.fetch;window.fetch=async(url,options)=>String(url)==='build-info.json'?new Response(JSON.stringify({...E.build.info().artifact,revision:'b'.repeat(40)})):oldFetch(url,options);
    try{await E.build.load({refresh:true});if(E.build.info().status!=='mismatch')throw Error('Stale manifest not detected')}finally{window.fetch=oldFetch}
    await E.build.load({refresh:true});if(E.build.info().status!=='matched')throw Error('Manifest recovery failed');
    const cancelled=new AbortController();cancelled.abort();try{await E.processClip(feature,release,{signal:cancelled.signal,bounded:true})}catch{}
    try{await E.processClip({...feature,geometry:{type:'Polygon',coordinates:[]}},release,{bounded:true})}catch{}
    const terminals=E.telemetry.snapshot().events.filter(e=>e.name==='clip'&&e.type==='end').map(e=>e.status);
    if(!terminals.includes('cancelled')||!terminals.includes('error'))throw Error('Missing terminal outcomes');
    const counters=E.telemetry.snapshot().counters;
    if(!(counters['tile.cacheHits']>0||counters['tile.cacheMisses']>0)||!(counters['tile.encodedBytes']>0))throw Error('Missing tile byte/cache attribution');
    if(${Boolean(benchmark)}){
      const model={...__model,key:'fixture',provider:'fixture'},times={disabled:[],enabled:[]};let expected=null;
      try{
        for(let i=-2;i<9;i++)for(const enabled of i%2?[true,false]:[false,true]){
          E.telemetry.setEnabled(enabled);const start=performance.now();
          const r=await E.processClip(feature,release,{model,bounded:true,zoom:18,png:false,geotiff:false,jobId:'gmd020-bench',clipId:'fixed'}),ms=performance.now()-start;
          const signature=JSON.stringify(r.fc)+r.blobs.pgw;if(expected===null)expected=signature;if(expected!==signature)throw Error('Instrumentation changed predictions/world file');
          if(i>=0)times[enabled?'enabled':'disabled'].push(ms);
        }
      }finally{E.telemetry.setEnabled(true)}
      const q=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1],summary={};
      for(const mode of ['enabled','disabled'])summary[mode]={medianMs:q(times[mode],.5),p95Ms:q(times[mode],.95),samplesMs:times[mode]};
      records.push({method:'Same realm, two warmups/mode and nine alternating full bounded-clip repetitions/mode; fixed 60ms model facade, synthetic cached tiles; GMD-017 profiling present in both',summary,
        overheadPercent:100*(summary.enabled.medianMs/summary.disabled.medianMs-1),outputsIdentical:true});
    }
    for(let i=0;i<500;i++)E.telemetry.start('clip',{jobId:'bounded'}).end();
    const bounded=E.telemetry.snapshot();if(bounded.events.length!==bounded.limit||bounded.active.length)throw Error('Trace not bounded/settled');
    const report=GVApp.diagnosticReport(),body=JSON.stringify(report);if(body.includes('coordinates')||body.includes('FeatureCollection'))throw Error('Payload retained');
    const create=URL.createObjectURL;URL.createObjectURL=blob=>{if(blob.type==='application/json')window.__diagnosticBlob=blob;return create(blob)};
    document.querySelector('#downloadDiagnostics').click();URL.createObjectURL=create;
    window.__downloadedDiagnostic=JSON.parse(await __diagnosticBlob.text());delete window.__diagnosticBlob;
    return{build:E.build.info(),workerContexts:contexts,workerClockOrigins:[...new Set(foreign.map(e=>e.timeOrigin))],terminals,worker:GVProcessing.diagnostics(),
      counters,benchmark:records,bounded:{limit:bounded.limit,events:bounded.events.length,dropped:bounded.droppedEvents,active:bounded.active.length},
      download:{version:__downloadedDiagnostic.version,events:__downloadedDiagnostic.telemetry.events.length,leases:GVApp.diagnostics().downloadLeases},
      allocations:E.allocations.diagnostics(),operations:E.operations.diagnostics()};
  })()`, 180000);
  const d=result.diagnostics;
  assert.equal(d.build.status,'matched'); assert.equal(d.build.executingRevision,'a'.repeat(40));
  assert.equal(d.worker.active,0); assert.equal(d.worker.created,d.worker.terminated); assert.equal(d.worker.pendingStorage,0);
  assert.equal(d.worker.last.telemetry.context.revision,'a'.repeat(40)); assert.equal(d.worker.last.telemetry.active,0);
  assert.equal(d.bounded.events,d.bounded.limit); assert.equal(d.bounded.active,0);
  assert.ok(d.allocations.activeOperations.every(owner=>owner.kind==='download'));
  assert.equal(d.operations.active.length,0); assert.equal(d.download.version,1); assert.equal(d.download.leases,1);
  if(benchmark)assert.ok(d.benchmark[0].overheadPercent<5,'Instrumentation exceeds declared local 5% median gate');
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  await until('GVApp.diagnostics().downloadLeases===0');
  result.diagnostics.afterHide=await evaluate('({downloads:GVApp.diagnostics().downloadLeases,active:GVEngine.telemetry.snapshot().active.length,reservedBytes:GVEngine.allocations.diagnostics().reservedBytes})');
  assert.equal(result.diagnostics.afterHide.active,0); assert.deepEqual(errors,[]);
  assert.equal(result.diagnostics.afterHide.reservedBytes,0);
  console.log('Native diagnostics: build mismatch/recovery, worker clocks, terminal outcomes, bounded scalar download and ownership pass.');
};
