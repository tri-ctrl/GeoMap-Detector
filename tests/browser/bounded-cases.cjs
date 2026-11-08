/* Native integration cases invoked by allocation.cjs --bounded [--quick]. */
const assert = require('node:assert/strict');
const JSZip = require('jszip');
module.exports = async function boundedCases({ page, evaluate, until, errors, result, samples, quick }) {
  result.mode = 'Local native Chromium, bounded blocks/chunked IndexedDB/native writers; deterministic tiles and model outputs';
  await evaluate(`(() => {
    window.__ownedCanvases=[];window.__ownedBitmaps=[];window.__inputHashes=[];
    const Canvas=OffscreenCanvas;window.OffscreenCanvas=new Proxy(Canvas,{construct(C,args){const canvas=new C(...args);__ownedCanvases.push({canvas,initial:args});return canvas}});
    const make=createImageBitmap;window.createImageBitmap=async(...args)=>{const bitmap=await make(...args),close=bitmap.close.bind(bitmap),record={closed:0};bitmap.close=()=>{record.closed++;close()};__ownedBitmaps.push(record);return bitmap};
    ort.Tensor=class{constructor(type,data,dims){this.data=data;this.dims=dims}dispose(){this.data=null}};
    __model.session.run=async feeds=>{
      const hash=await crypto.subtle.digest('SHA-256',feeds.images.data);__inputHashes.push(Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join(''));
      const index=__inputHashes.length-1,positions=GVEngine.windows(__qualityHeight||128,__qualityWidth||400,1024,256),[x,y]=positions[index];
      const objects=[[800,300,50,12,.92,.2],[900,700,70,16,.85,-.15]].filter(o=>o[0]>=x&&o[0]<x+1024&&o[1]>=y&&o[1]<y+1024);
      const n=objects.length,data=new Float32Array(6*n);objects.forEach((o,i)=>{data[i]=o[0]-x;data[n+i]=o[1]-y;for(let c=2;c<6;c++)data[c*n+i]=o[c]});
      return {output:{dims:[1,6,n],data,dispose(){this.data=null}}};
    };
  })()`);
  result.quality = await evaluate(`(async()=>{
    const E=GVEngine,IO=window.GVStreaming||(await E.ensureLibrary('streaming'),window.GVStreaming);
    const decode=async blob=>{const bitmap=await createImageBitmap(blob),c=new OffscreenCanvas(bitmap.width,bitmap.height),g=c.getContext('2d');g.drawImage(bitmap,0,0);const pixels=g.getImageData(0,0,c.width,c.height).data;bitmap.close();c.width=c.height=1;return pixels};
    const cases=[],base=__shape(1700,1300),x=171383*256+16,y=112057*256+16;
    const hole=[__ll(x+200,y+150),__ll(x+400,y+150),__ll(x+350,y+450),__ll(x+200,y+150)];
    const square=[__ll(x+200,y+150),__ll(x+400,y+150),__ll(x+400,y+450),__ll(x+200,y+450),__ll(x+200,y+150)];
    const shapes=[base,{...base,coordinates:[...base.coordinates,square]},
      {type:'MultiPolygon',coordinates:[__shape(900,1300).coordinates,[[__ll(x+1000,y+50),__ll(x+1700,y+50),__ll(x+1700,y+1200),__ll(x+1000,y+1200),__ll(x+1000,y+50)]]]},
      {...base,coordinates:[...base.coordinates,hole]},
      {type:'MultiPolygon',coordinates:[__shape(900,1300).coordinates,[[__ll(x+1000,y+50),__ll(x+1700,y+200),__ll(x+1600,y+1200),__ll(x+1000,y+50)]]]},__shape(8191,4)];
    for(let i=0;i<shapes.length;i++){
      const geometry=shapes[i],plan=E.estimateRaster(geometry,18,{bounded:true,modelSize:1024});__qualityWidth=plan.width;__qualityHeight=plan.height;__inputHashes=[];
      const original=await E.processClip(__feature(geometry),{release:101,date:'2026-10-29'},{model:__model,geotiff:false});
      const oldHashes=__inputHashes.slice(),expected=await decode(original.blobs.png);__inputHashes=[];
      const reference=await E.processClip(__feature(geometry),{release:101,date:'2026-10-29'},{model:__model,geotiff:false,maskVersion:'area-evenodd-v1'});
      const hashes=__inputHashes.slice(),canonical=await decode(reference.blobs.png);__inputHashes=[];
      const bounded=await E.processClip(__feature(geometry),{release:101,date:'2026-10-29'},{bounded:true,forceBlocks:true,model:__model,store:__repo,jobId:'quality',clipId:'quality-'+i});
      const actualBlob=await IO.materialize(bounded.blobs.png,{store:__repo}),actual=await decode(actualBlob);
      const rings=(geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates).flat().map(ring=>ring.map(([lon,lat])=>{const [mx,my]=E.merc(lon,lat);return[(mx-(plan.gx0*plan.res-20037508.342789244))/plan.res,((20037508.342789244-plan.gy0*plan.res)-my)/plan.res]}));
      let different=0,canonicalDifferences=0,examples=[],maxAlphaDelta=0,maxPremultDelta=0,opaqueDifferences=0,changedPixels=0,maxEdgeDistance=0;
      for(let j=0;j<canonical.length;j++)if(canonical[j]!==actual[j])canonicalDifferences++;
      for(let p=0;p<expected.length;p+=4){let changed=false;maxAlphaDelta=Math.max(maxAlphaDelta,Math.abs(expected[p+3]-actual[p+3]));
        for(let c=0;c<4;c++){const j=p+c;if(expected[j]!==actual[j]){different++;changed=true;if(expected[p+3]===255&&actual[p+3]===255)opaqueDifferences++;if(examples.length<12)examples.push({x:Math.floor(j/4)%plan.width,y:Math.floor(j/4/plan.width),channel:j%4,old:expected[j],actual:actual[j]})};if(c<3)maxPremultDelta=Math.max(maxPremultDelta,Math.abs(expected[j]*expected[p+3]/255-actual[j]*actual[p+3]/255));}
        if(changed){changedPixels++;const px=p/4%plan.width+.5,py=Math.floor(p/4/plan.width)+.5;let distance=Infinity;for(const ring of rings)for(let j=1;j<ring.length;j++){const [ax,ay]=ring[j-1],[bx,by]=ring[j],dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy||1)));distance=Math.min(distance,Math.hypot(px-ax-t*dx,py-ay-t*dy));}maxEdgeDistance=Math.max(maxEdgeDistance,distance);}}
      cases.push({kind:['rectangle','hole','multi','diagonal-hole','diagonal-multi','thin'][i],size:bounded.size,inputHashes:__inputHashes.slice(),referenceHashes:hashes,originalHashes:oldHashes,different,canonicalDifferences,
        examples,maxAlphaDelta,maxPremultDelta,opaqueDifferences,changedPixels,maxEdgeDistance,comparedBytes:expected.length,referenceFeatures:reference.fc.features,features:bounded.fc.features,cache:bounded.allocation.cache});
      await __repo.discardSpool(bounded.artifactSpool);
    }
    return cases;
  })()`, 180000);
  for (const q of result.quality) {
    if(q.different)console.log(JSON.stringify({kind:q.kind,different:q.different,examples:q.examples,maxAlphaDelta:q.maxAlphaDelta,maxPremultDelta:q.maxPremultDelta,opaqueDifferences:q.opaqueDifferences,changedPixels:q.changedPixels,hashesEqual:JSON.stringify(q.inputHashes)===JSON.stringify(q.referenceHashes)}));
    assert.equal(q.canonicalDifferences,0,q.kind+' canonical native pixels');assert.deepEqual(q.inputHashes,q.referenceHashes,q.kind+' model input hashes');
    if (!q.kind.startsWith('diagonal')) assert.equal(q.different, 0, q.kind + ' original native pixels');
    else { assert.equal(q.opaqueDifferences,0);assert.ok(q.maxAlphaDelta<=16);assert.ok(q.maxPremultDelta<=16);assert.ok(q.maxEdgeDistance<=1); }
    assert.deepEqual(q.features, q.referenceFeatures, q.kind + ' seam predictions'); assert.ok(q.cache.peakCachedBytes <= q.cache.cacheLimit);
  }
  console.log('Axis-aligned rectangle/hole/MultiPolygon pixels and model inputs match exactly; diagonal AA stays within declared edge-only tolerances. Seam/global suppression matches exactly.');
  result.cancelInference = await evaluate(`(async()=>{
    const old=__model.session.run,controller=new AbortController();let finish,entered;
    const ready=new Promise(resolve=>entered=resolve);__model.session.run=async()=>{entered();return new Promise(resolve=>finish=resolve)};
    const running=GVEngine.processClip(__feature(__shape()),{release:101,date:'2026-10-29'},{bounded:true,model:__model,store:__repo,jobId:'cancel',clipId:'cancel',signal:controller.signal});
    await ready;const start=performance.now();controller.abort();let settled=false;running.catch(()=>settled=true);await new Promise(resolve=>setTimeout(resolve,20));const waited=!settled;
    let disposed=0;finish({output:{dims:[1,6,0],data:new Float32Array(0),dispose(){disposed++}}});let code;
    try{await running}catch(error){code=error.name}__model.session.run=old;
    return {code,waited,disposed,afterInferenceMs:performance.now()-start,operations:GVEngine.operations.diagnostics(),allocations:GVEngine.allocations.diagnostics()};
  })()`, 60000);
  assert.equal(result.cancelInference.code, 'AbortError'); assert.equal(result.cancelInference.waited, true); assert.equal(result.cancelInference.disposed, 1);
  assert.equal(result.cancelInference.allocations.reservedBytes, 0); assert.equal(result.cancelInference.operations.active.length, 0); assert.equal(result.cancelInference.operations.tensors, 0);
  console.log('Cancellation drains the in-flight inference, disposes its output and releases operation/canvas owners.');
  result.samples = [];
  if (!quick) for (const sample of samples) {
    const measured = await evaluate(`(async()=>{
      const E=GVEngine,feature=${JSON.stringify(sample)},before=__ownedCanvases.length,start=performance.now(),requests=__tileRequests;
      const plan=E.estimateRaster(feature.geometry,18,{bounded:true,modelSize:0});
      const clip=await E.processClip(feature,{release:101,date:'2026-10-29'},{bounded:true,store:__repo,jobId:'sample',clipId:'sample-'+feature.properties.name});
      const first=await __repo.readArtifactChunk(clip.blobs.png,0),header=first instanceof Blob?new Uint8Array(await first.arrayBuffer()):first;
      const view=new DataView(header.buffer,header.byteOffset,header.byteLength),canvases=__ownedCanvases.slice(before);
      const output={aoi:feature.properties.name,ms:performance.now()-start,size:clip.size,estimatedSize:[plan.width,plan.height],zoom:clip.zoom,requestedZoom:clip.requestedZoom,
        pngSize:[view.getUint32(16),view.getUint32(20)],pngBytes:clip.blobs.png.size,tiffBytes:clip.blobs.tif.size,estimatedWorkingBytes:plan.estimatedBytes,
        cache:clip.allocation.cache,requests:__tileRequests-requests,canvasCount:canvases.length,maxCanvasSide:Math.max(...canvases.flatMap(c=>c.initial)),
        allCanvasesReleased:canvases.every(c=>c.canvas.width===1&&c.canvas.height===1),allocations:E.allocations.diagnostics(),io:GVStreaming.diagnostics()};
      await __repo.discardSpool(clip.artifactSpool);return output;
    })()`, 180000);
    assert.deepEqual(measured.size, measured.estimatedSize); assert.deepEqual(measured.pngSize, measured.size); assert.equal(measured.allCanvasesReleased, true);
    assert.ok(measured.maxCanvasSide <= 2048); assert.ok(measured.cache.peakCachedBytes <= measured.cache.cacheLimit); assert.equal(measured.allocations.reservedBytes, 0);
    result.samples.push(measured); console.log(`${measured.aoi}: ${measured.size.join('×')} native pixels, max canvas side ${measured.maxCanvasSide}, ${measured.ms.toFixed(0)}ms (synthetic tiles).`);
  }
  result.ui = await evaluate(`(async()=>{
    const q=id=>document.querySelector('#'+id);q('detectOn').checked=false;q('pngOn').checked=true;q('tifOn').checked=true;
    q('rasterMemory').value='128';q('rasterMemory').dispatchEvent(new Event('change'));
    const job=window.__boundedJob=await q('runBtn').onclick(),saved=await __repo.clip(job.results[0].storeId);
    document.querySelector('[data-tab=res]').click();await new Promise(resolve=>setTimeout(resolve,30));
    const row=document.querySelector('#resTable tbody tr[data-i]');await row.onclick();
    return {status:job.status,size:saved.size,displaySize:saved.displaySize,pngDescriptor:saved.blobs.png.gmdArtifact,tiffDescriptor:saved.blobs.tif.gmdArtifact,
      storedOwner:saved.artifactSpool,mapImage:document.querySelector('.leaflet-image-layer')?.src,diagnostics:GVApp.diagnostics()};
  })()`, 60000);
  assert.equal(result.ui.status, 'done'); assert.equal(result.ui.pngDescriptor, 1); assert.equal(result.ui.tiffDescriptor, 1); assert.ok(result.ui.mapImage.startsWith('blob:'));
  result.file = await evaluate(`(async()=>{
    const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('gmd-test.zip',{create:true}),destination=await handle.createWritable();
    const result=await GVEngine.exportJobZip(__boundedJob,{streaming:true,store:__repo,destination,readResult:r=>__repo.clip(r.storeId)});
    const file=await handle.getFile(),data=Array.from(new Uint8Array(await file.arrayBuffer()));await root.removeEntry('gmd-test.zip');return{saved:result.saved,data};
  })()`, 60000);
  assert.equal(result.file.saved, true); const zip = await JSZip.loadAsync(Buffer.from(result.file.data), { checkCRC32: true }); delete result.file.data;
  const pngEntry = Object.values(zip.files).find(f => f.name.endsWith('/image.png')); assert.ok(pngEntry); assert.equal(pngEntry._data.compression.magic, '\x00\x00');
  result.file.entries = Object.keys(zip.files); result.file.pngBytes = pngEntry._data.uncompressedSize;
  console.log('Native UI commits chunked results, opens a bounded map image, and streams a CRC-valid ZIP through an actual OPFS file destination.');
  result.dataset = await evaluate(`(async()=>{
    const feature=__feature(__shape(20,10));feature.properties={class:'ship',status:'accepted',release:101,zoom:18};
    const fc={type:'FeatureCollection',features:[feature]},old=await GVEngine.exportDataset(fc),bounded=await GVEngine.exportDataset(fc,{streaming:true,store:__repo});
    const read=async blob=>{const zip=await JSZip.loadAsync(blob),files=Object.keys(zip.files).filter(name=>!zip.files[name].dir).sort(),entries={};
      for(const name of files){if(name.endsWith('.jpg')){const bitmap=await createImageBitmap(await zip.file(name).async('blob'));entries[name]=[bitmap.width,bitmap.height];bitmap.close()}else entries[name]=await zip.file(name).async('string')};return entries};
    return{chips:bounded.chips,classes:bounded.classes,old:await read(old.blob),bounded:await read(bounded.blob)};
  })()`,60000);
  assert.equal(result.dataset.chips,1);assert.deepEqual(result.dataset.classes,['ship']);assert.deepEqual(result.dataset.bounded,result.dataset.old);
  result.formats = await evaluate(`(async()=>{
    const clip=await GVEngine.processClip(__feature(__shape()),{release:101,date:'2026-10-29'},{bounded:true,png:false,geotiff:true,store:__repo,jobId:'formats',clipId:'formats'});
    const keys=Object.keys(clip.blobs);await __repo.discardSpool(clip.artifactSpool);return{keys,size:clip.size};
  })()`);
  assert.equal(result.formats.keys.includes('png'),false);assert.equal(result.formats.keys.includes('tif'),true);assert.equal(result.formats.keys.includes('display'),true);
  result.failure = await evaluate(`(async()=>{
    const create=__repo.createSpool,checks=[];
    for(const target of ['raw','png','tiff-strips']){
      __repo.createSpool=async options=>{const spool=await create(options),put=spool.put;spool.put=async(file,...args)=>{if(file===target)throw Error('injected '+target+' write failure');return put(file,...args)};return spool};
      let message;try{await GVEngine.processClip(__feature(__shape(2100,400)),{release:101,date:'2026-10-29'},{bounded:true,store:__repo,jobId:'failure',clipId:target})}catch(error){message=error.message}
      checks.push({target,message,allocations:GVEngine.allocations.diagnostics(),operations:GVEngine.operations.diagnostics(),io:GVStreaming.diagnostics()});
    }__repo.createSpool=create;return checks;
  })()`,60000);
  for(const failure of result.failure){assert.match(failure.message,/injected/);assert.equal(failure.allocations.reservedBytes,0);assert.equal(failure.operations.active.length,0);assert.equal(failure.io.activeWriters,0)}
  result.parts = await evaluate(`(async()=>{
    const r=await __repo.clip(__boundedJob.results[0].storeId),job={...__boundedJob,id:'parts.job',results:[{...r,blobs:{...r.blobs,png:new Blob([new Uint8Array(800000).fill(73)])}}]};
    const output=await GVEngine.exportJobZip(job,{streaming:true,store:__repo,partBytes:262144}),parts=[];
    for(const part of output.parts){const blob=await GVEngine.exportPart(part,{store:__repo});parts.push({size:blob.size,data:Array.from(new Uint8Array(await blob.arrayBuffer()))})}
    await GVStreaming.discardArtifact(output.spool,__repo);return{parts,bytes:output.bytes};
  })()`,60000);
  assert.ok(result.parts.parts.length>=3);assert.ok(result.parts.parts.every(p=>p.size<=262144));
  const reassembled=await JSZip.loadAsync(Buffer.concat(result.parts.parts.map(p=>Buffer.from(p.data))),{checkCRC32:true});
  assert.equal(Object.values(reassembled.files).find(f=>f.name.endsWith('/image.png'))._data.uncompressedSize,800000);
  for(const part of result.parts.parts)delete part.data;
  console.log('Bounded dataset labels/chip dimensions match the legacy writer; optional formats, injected spool failures and split ZIP reassembly pass.');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  result.narrow = await evaluate('({viewport:innerWidth,width:document.documentElement.scrollWidth})'); assert.ok(result.narrow.width <= result.narrow.viewport);
  result.final = await evaluate('({operations:GVEngine.operations.diagnostics(),allocations:GVEngine.allocations.diagnostics(),io:GVStreaming.diagnostics(),allBitmapsClosed:__ownedBitmaps.every(b=>b.closed===1)})');
  assert.equal(result.final.operations.active.length, 0); assert.equal(result.final.allocations.reservedBytes, 0); assert.equal(result.final.io.activeWriters, 0); assert.equal(result.final.allBitmapsClosed, true);
  assert.equal(errors.length, 0, errors.join('\n'));
  const jobId=await evaluate('__boundedJob.id');await page('Page.reload');
  await until("window.GVApp&&document.querySelector('#storageStatus').textContent.startsWith('Saved')&&document.querySelector('#jobSel').options.length>0");
  await evaluate(`document.querySelector('#jobSel').value=${JSON.stringify(jobId)};document.querySelector('#jobSel').dispatchEvent(new Event('change'));document.querySelector('[data-tab=res]').click()`);
  await until("Boolean(document.querySelector('#resTable tbody tr[data-i]'))");
  result.reload=await evaluate(`(async()=>{await document.querySelector('#resTable tbody tr[data-i]').onclick();const record=(await __repo.restore()).jobs.find(j=>j.id===${JSON.stringify(jobId)}),saved=await __repo.clip(record.results[0].storeId);return{pngDescriptor:saved.blobs.png.gmdArtifact,mapImage:document.querySelector('.leaflet-image-layer')?.src}})()`);
  assert.equal(result.reload.pngDescriptor,1);assert.ok(result.reload.mapImage.startsWith('blob:'));assert.equal(errors.length,0,errors.join('\n'));
};
