const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
module.exports=async({page,browser,evaluate,until,errors,on,result})=>{
  result.mode='Local Chromium, native IndexedDB/PNG/TIFF/ZIP, retained-result budget and 20 open/delete cycles; fixed fixture inference';
  await page('Performance.enable');
  const sample=async label=>{
    // Wait out transient toasts before comparing retained DOM/listener counts.
    await until("document.querySelectorAll('.toast').length===0");
    await page('HeapProfiler.collectGarbage');
    const metrics=await page('Performance.getMetrics'),dom=await page('Memory.getDOMCounters');
    const value={label,heapBytes:metrics.metrics.find(m=>m.name==='JSHeapUsedSize').value,...dom};
    try{
      const info=await browser('SystemInfo.getProcessInfo'),pids=info.processInfo.filter(p=>['browser','renderer','GPU'].includes(p.type)).map(p=>p.id);
      const rows=execFileSync('ps',['-o','pid=,rss=','-p',pids.join(',')],{encoding:'utf8'}).trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));
      value.processRSSBytes=rows.reduce((n,row)=>n+row[1]*1024,0);value.processes=rows.map(row=>row[0]);
    }catch(error){value.processRSSUnavailable=error.message.slice(0,180)}
    return value;
  };
  result.seed=await evaluate(`(async()=>{
    const aoi=__feature(__shape(4096,1024)),clip=await GVEngine.processClip(aoi,{release:101,date:'2026-10-29'},{bounded:false,model:__model,classes:['aircraft'],geotiff:true});
    if(!clip.fc.features.length)throw Error('Fixed fixture needs predictions');clip.fc.features[0].properties.note='x'.repeat(90000);
    for(let i=0;i<8;i++){
      const job={id:'browser_memory_'+i,createdAt:Date.now()+i,status:'done',progress:1,log:[],outcomes:[],aois:[aoi],params:{model:'Fixture',detect:true},results:[]};
      const r={...clip,fc:structuredClone(clip.fc),storeId:job.id+':clip:0',order:0,aoiFeature:aoi,createdAt:job.createdAt};job.results=[r];await __repo.saveClip(job,r);
    }
    const feature=structuredClone(clip.fc.features[0]);feature.properties.status='verified';await __repo.saveReviews('browser_memory_0:clip:0','browser_memory_0',null,[feature]);
    return{jobs:8,size:clip.size,pngBytes:clip.blobs.png.size,tiffBytes:clip.blobs.tif.size,world:clip.blobs.pgw,objects:clip.total};
  })()`);
  // Mercator round-trips can expand the snapped rectangle by one source row.
  assert.equal(result.seed.size[0],4096);assert.ok(result.seed.size[1]>=1024&&result.seed.size[1]<=1025);
  const origin=await evaluate('performance.timeOrigin');await page('Page.reload');
  await until(`performance.timeOrigin!==${origin}&&window.GVApp&&document.querySelector('#storageStatus').textContent.startsWith('Saved')&&document.querySelector('#jobSel').options.length===8`);
  await page('Performance.enable');
  await evaluate(`(()=>{
    window.__memoryURLs={created:0,revoked:0,live:new Set()};const make=URL.createObjectURL,drop=URL.revokeObjectURL;
    URL.createObjectURL=function(blob){const url=make.call(this,blob);__memoryURLs.created++;__memoryURLs.live.add(url);return url};URL.revokeObjectURL=function(url){__memoryURLs.revoked++;__memoryURLs.live.delete(url);return drop.call(this,url)};
    const makeMap=L.map;document.querySelector('[data-tab=res]').click();document.querySelector('#resultDisplaySide').value='512';document.querySelector('#resultDisplaySide').onchange();
    document.querySelector('#resultMemoryLimit').value='1';document.querySelector('#resultMemoryLimit').onchange();
  })()`);
  const open=async id=>{
    await evaluate(`document.querySelector('#jobSel').value=${JSON.stringify(id)};document.querySelector('#jobSel').onchange()`);
    await until("document.querySelectorAll('#resTable tbody tr[data-i]').length===1");
    await evaluate("document.querySelector('#resTable tbody tr[data-i]').click()");
    try{await until("GVApp.diagnostics().views.active===1&&!GVApp.diagnostics().views.loading&&GVApp.diagnostics().views.imageLeases===1")}
    catch(error){console.error(await evaluate("({context:document.querySelector('#annCtx').textContent,memory:GVApp.diagnostics().memory})"));throw error}
  };
  result.startup=await evaluate('({reads:__repo.state().reads,memory:GVApp.diagnostics().memory})');assert.equal(result.startup.reads.artifacts,undefined);
  await open('browser_memory_0');
  result.display=await evaluate(`(async()=>{
    const image=document.querySelector('#map img.leaflet-image-layer'),r=await fetch(image.src),blob=await r.blob(),size=await GVEngine.allocations.pngDimensions(blob);
    return{size,status:document.querySelector('#annStats')?.textContent||document.querySelector('#annCtx').textContent,memory:GVApp.diagnostics().memory,rawStatus:(await __repo.clip('browser_memory_0:clip:0',{images:false,draft:false})).fc.features[0].properties.status};
  })()`);
  assert.deepEqual(result.display.size,[512,128]);assert.equal(result.display.rawStatus,'predicted');
  assert.ok(result.display.memory.totalBytes<=1048576);assert.equal(result.display.memory.pins,1);
  const reads=await evaluate('__repo.state().reads.predictions');await open('browser_memory_0');
  assert.equal(await evaluate('__repo.state().reads.predictions'),reads);
  for(let i=1;i<8;i++)await open('browser_memory_'+i);
  const before=await evaluate('__repo.state().reads.predictions');await open('browser_memory_0');
  assert.equal(await evaluate('__repo.state().reads.predictions'),before+1);
  result.eviction=await evaluate('GVApp.diagnostics().memory');assert.ok(result.eviction.evictions>0);assert.ok(result.eviction.totalBytes<=result.eviction.limitBytes);
  result.export=await evaluate(`(async()=>{
    const state=await __repo.restore(),job=state.jobs.find(j=>j.id==='browser_memory_0'),raw=await __repo.clip(job.results[0].storeId),blob=await GVEngine.exportJobZip(job,{readResult:r=>__repo.clip(r.storeId)}),zip=await JSZip.loadAsync(blob);
    const png=await zip.file(job.id+'/Allocation/2026-10-29/image.png').async('uint8array'),tif=await zip.file(job.id+'/Allocation/2026-10-29/image.tif').async('uint8array');
    const original=new Uint8Array(await raw.blobs.png.arrayBuffer()),nativeTif=new Uint8Array(await raw.blobs.tif.arrayBuffer());
    return{size:await GVEngine.allocations.pngDimensions(new Blob([png])),samePNG:png.length===original.length&&png.every((b,i)=>b===original[i]),sameTIFF:tif.length===nativeTif.length&&tif.every((b,i)=>b===nativeTif[i]),world:await zip.file(job.id+'/Allocation/2026-10-29/image.pgw').async('string'),reviews:(await __repo.reviews()).features.length};
  })()`);
  assert.deepEqual(result.export.size,result.seed.size);assert.equal(result.export.samePNG,true);assert.equal(result.export.sameTIFF,true);assert.equal(result.export.world,result.seed.world);assert.equal(result.export.reviews,1);
  // Warm the repeat path before sampling. Every cycle inserts, opens and deletes
  // a distinct job; original jobs and the independent training review survive.
  await evaluate(`(()=>{document.querySelector('#detectOn').checked=false;GVEngine.processClip=async()=>{
    const r=await __repo.clip('browser_memory_7:clip:0',{images:'display',draft:false});return {...r,fc:structuredClone(r.fc)};
  }})()`);
  const cycle=async i=>{
    const id=await evaluate("document.querySelector('#runBtn').onclick().then(job=>{if(job.status!=='done')throw Error('Cycle job '+job.status);document.querySelector('#jobRefresh').click();return job.id})");
    await until(`!!document.querySelector('#jobSel option[value="${id}"]')`);await open(id);
    await evaluate("document.querySelector('#deleteJob').click()");
    await until(`!document.querySelector('#jobSel option[value="${id}"]')&&GVApp.diagnostics().views.active===0`);
    await evaluate("document.querySelector('#clearResultCache').click()");
    const state=await evaluate('GVApp.diagnostics()');assert.equal(state.memory.pins,0);assert.equal(state.memory.entries,0);assert.equal(state.memory.protectedBytes,state.memory.protected.catalog);
  };
  // Confirm the application's scoped deletion for each stress-fixture job.
  await evaluate('window.confirm=()=>true');
  for(let i=0;i<5;i++)await cycle('warm_'+i);
  result.samples=[await sample('after 5 warmup cycles')];
  for(let i=0;i<20;i++){await cycle(i);if((i+1)%5===0)result.samples.push(await sample('after '+(i+1)+' measured cycles'))}
  result.final=await evaluate('(async()=>({memory:GVApp.diagnostics().memory,views:GVApp.diagnostics().views,allocations:GVEngine.allocations.diagnostics(),urls:{created:__memoryURLs.created,revoked:__memoryURLs.revoked,live:__memoryURLs.live.size},jobs:(await __repo.restore()).jobs.length,reviews:(await __repo.reviews()).features.length}))()');
  assert.equal(result.final.jobs,8);assert.equal(result.final.reviews,1);assert.equal(result.final.urls.live,0);assert.equal(result.final.urls.created,result.final.urls.revoked);
  assert.equal(result.final.memory.cacheBytes,0);assert.equal(result.final.allocations.liveCanvasBytes,0);assert.equal(result.final.allocations.reservedBytes,0);
  result.heapGrowthBytes=result.samples.at(-1).heapBytes-result.samples[0].heapBytes;result.heapGrowthGateBytes=5*1048576;
  result.listenerGrowth=result.samples.at(-1).jsEventListeners-result.samples[0].jsEventListeners;
  result.nodeGrowth=result.samples.at(-1).nodes-result.samples[0].nodes;
  assert.ok(result.heapGrowthBytes<result.heapGrowthGateBytes,'Retained JS heap exceeds the declared tiny-fixture regression gate');assert.deepEqual(errors,[]);
  if(process.argv.includes('--inspect-memory')){
    try{
      const chunks=[];on('HeapProfiler.addHeapSnapshotChunk',event=>chunks.push(event.chunk));await page('HeapProfiler.enable');await page('HeapProfiler.takeHeapSnapshot',{reportProgress:false},60000);
      require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(),'gmd009-debug.heapsnapshot'),chunks.join(''));
      await page('DOM.enable');const detached=await page('DOM.getDetachedDomNodes');result.detachedDOM=detached.detachedNodes.map(item=>({name:item.treeNode.nodeName,attributes:item.treeNode.attributes,children:item.treeNode.childNodeCount,retained:item.retainedNodeIds}));
      const node=detached.detachedNodes[0]?.treeNode;
      if(node){const resolved=await page('DOM.resolveNode',{backendNodeId:node.backendNodeId});result.detachedHeapId=await page('HeapProfiler.getHeapObjectId',{objectId:resolved.object.objectId});await page('Runtime.releaseObject',{objectId:resolved.object.objectId});}
    }
    catch(error){result.detachedDOMError=error.message}
  }
  if(result.nodeGrowth>50)console.error(JSON.stringify({samples:result.samples,detachedHeapId:result.detachedHeapId,detachedDOMCount:result.detachedDOM?.length}));
  assert.ok(result.listenerGrowth<=2,'Repeated display cleanup retains DOM handlers');
  assert.ok(result.nodeGrowth<=50,'Repeated display cleanup retains DOM nodes');
  if(!result.detachedDOM){
    try{await page('DOM.enable');const detached=await page('DOM.getDetachedDomNodes');result.detachedDOM=detached.detachedNodes.map(item=>({name:item.treeNode.nodeName,attributes:item.treeNode.attributes}));}
    catch(error){result.detachedDOMError=error.message}
  }
  if(result.detachedDOM)assert.equal(result.detachedDOM.filter(node=>node.name==='IMG').length,0,'Detached image nodes remain after settled cleanup');
  result.measurementLimits='JS heap is sampled after explicit GC. Summed browser/renderer/GPU RSS, where available, includes retained runtime/native/browser pools; it is distinct from logical Blob/cache bytes and decoded RGBA estimates. This is not a sustained production/GPU leak or throughput benchmark.';
  console.log('Native retained-result budget: display-only reads, 512px legacy display, LRU rereads, exact native PNG/TIFF/world export, 20 measured open/delete cycles, preserved reviews and zero owned leases pass.');
};
