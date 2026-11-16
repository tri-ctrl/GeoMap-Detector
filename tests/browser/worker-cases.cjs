/* Real classic workers, OffscreenCanvas, IndexedDB and map input. The offline
 * model deliberately blocks its own context for 60 ms per inference window.
 * This tests responsiveness/ownership; it does not measure detector accuracy.
 */
const assert = require('node:assert/strict');
module.exports = async ({ page, evaluate, until, errors, result }) => {
  const processing = evaluate(`(async()=>{
    await GVEngine.ensureLibrary('streaming');
    const output={},feature=__feature(__shape(2300,1100)),release={release:101,date:'2026-10-29'};
    const options={zoom:18,bounded:true,geotiff:true,classes:['aircraft'],conf:.3,jobId:'worker-check',clipId:'worker-check:clip:0'};
    const spec={key:'fixture',names:['plane'],imgsz:1024};
    const main=await GVEngine.processClip(feature,release,{...options,model:await GVEngine.loadModel(spec)});
    const reasons=[],controller=new AbortController(),runner=await GVProcessing.create({jobId:options.jobId,signal:controller.signal,store:__repo,onFallback:reason=>reasons.push(reason)});
    if(runner.context!=='worker')throw Error('Expected a real processing worker: '+reasons.join(';'));
    await runner.loadModel(spec);
    window.__inputSamples=[];window.__mapInputs=0;
    document.querySelector('#map').addEventListener('pointerdown',()=>{__mapInputs++;__inputSamples.push(performance.now()-__inputSent)});
    window.__processing=true;
    const measures=[],observer=new PerformanceObserver(list=>measures.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));observer.observe({type:'longtask'});
    const start=performance.now();
    const processing=runner.processClip(feature,release,{...options,onProgress:f=>{window.__workerProgress=f}});
    window.__nativeProcessing=processing;
    const worker=await processing;const end=performance.now();window.__processing=false;
    await runner.close();await new Promise(r=>setTimeout(r,50));observer.disconnect();
    output.equalPredictions=JSON.stringify(worker.fc)===JSON.stringify(main.fc);
    output.equalTransform=worker.blobs.pgw===main.blobs.pgw;
    async function data(value,store){return new Uint8Array(await (await GVStreaming.materialize(value,{store})).arrayBuffer())}
    const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(b=>b.toString(16).padStart(2,'0')).join('');
    output.native={};for(const file of ['png','tif'])output.native[file]={main:await hash(await data(main.blobs[file])),worker:await hash(await data(worker.blobs[file],__repo))};
    const bitmapA=await createImageBitmap(main.blobs.display),bitmapB=await createImageBitmap(worker.blobs.display);
    const pixels=async bitmap=>{const c=new OffscreenCanvas(bitmap.width,bitmap.height),g=c.getContext('2d');try{g.drawImage(bitmap,0,0);return await hash(g.getImageData(0,0,c.width,c.height).data)}finally{c.width=c.height=1;bitmap.close()}};
    output.displayHashes=[await pixels(bitmapA),await pixels(bitmapB)];
    await GVStreaming.discardArtifact(main.blobs.png.spool);
    await GVStreaming.discardArtifact(worker.artifactSpool,__repo);
    output.durationMs=end-start;output.longTasks=measures.filter(e=>e.start>=start&&e.start<=end);output.inputSamples=__inputSamples;output.mapInputs=__mapInputs;
    output.processing=GVProcessing.diagnostics();output.allocations=GVEngine.allocations.diagnostics();
    return output;
  })()`);
  await until('window.__processing===true');
  for (let i = 0; i < 12; i++) {
    if (!await evaluate('window.__processing')) break;
    await evaluate('window.__inputSent=performance.now()');
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: 850, y: 400, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 850, y: 400, button: 'left', clickCount: 1 });
  }
  result.worker = await processing;
  assert.ok(result.worker.mapInputs >= 3, 'Real map input must be delivered during worker processing');
  const samples = [...result.worker.inputSamples].sort((a,b)=>a-b);
  result.worker.inputP95Ms = samples[Math.ceil(samples.length*.95)-1];
  assert.ok(result.worker.inputP95Ms < 100, 'Controlled fixture input p95 must stay below 100ms');
  assert.equal(result.worker.longTasks.length, 0, 'No UI tasks >=50ms during the controlled worker clip');
  assert.equal(result.worker.equalPredictions, true);
  assert.equal(result.worker.equalTransform, true);
  assert.deepEqual(result.worker.displayHashes[0], result.worker.displayHashes[1]);
  for (const value of Object.values(result.worker.native)) assert.equal(value.main, value.worker);
  assert.equal(result.worker.processing.active, 0);
  assert.equal(result.worker.processing.created, result.worker.processing.terminated);
  assert.equal(result.worker.processing.last.models.leased, 0);
  assert.equal(result.worker.processing.last.allocations.activeOperations.length, 0);
  assert.equal(result.worker.processing.pendingStorage, 0);
  assert.equal(result.worker.allocations.activeOperations.length, 0);
  result.worker.cancel = await evaluate(`(async()=>{
    const controller=new AbortController(),runner=await GVProcessing.create({jobId:'cancel-check',signal:controller.signal,store:__repo});
    await runner.loadModel({key:'fixture',names:['plane'],imgsz:1024});
    let error;
    try{await runner.processClip(__feature(__shape(1600,1200)),{release:101,date:'2026-10-29'},{zoom:18,bounded:true,geotiff:true,clipId:'cancel-clip',onProgress:f=>{if(f>.4)controller.abort()}})}catch(e){error=e.name}
    await runner.close();
    return {error,processing:GVProcessing.diagnostics(),reserved:GVEngine.allocations.diagnostics().reservedBytes,session:GVStreaming.diagnostics()};
  })()`);
  assert.equal(result.worker.cancel.error, 'AbortError');
  assert.equal(result.worker.cancel.reserved, 0);
  assert.equal(result.worker.cancel.processing.pendingStorage, 0);
  assert.equal(result.worker.cancel.processing.active, 0);
  result.worker.session = await evaluate(`(async()=>{
    const runner=await GVProcessing.create({jobId:'session-check'});await runner.loadModel({key:'fixture',names:['plane'],imgsz:1024});
    const output=await runner.processClip(__feature(__shape()),{release:101,date:'2026-10-29'},{zoom:18,bounded:true,geotiff:true,clipId:'session:0'});
    await runner.close();
    const png=await GVStreaming.materialize(output.blobs.png),tiff=await GVStreaming.materialize(output.blobs.tif);
    await GVStreaming.discardArtifact(output.blobs.png.spool);
    return {png:png.size,tiff:tiff.size,memory:GVStreaming.diagnostics().memoryBytes};
  })()`);
  assert.ok(result.worker.session.png > 0); assert.ok(result.worker.session.tiff > 0); assert.equal(result.worker.session.memory, 0);
  result.worker.crash = await evaluate(`(async()=>{
    const NativeWorker=Worker;let first=true;
    window.Worker=class extends NativeWorker{constructor(url){if(first){first=false;url=new URL(url);url.searchParams.set('crash','1')}super(url)}};
    const runner=await GVProcessing.create({jobId:'crash-check',store:__repo});
    let error;
    try{await runner.loadModel({key:'fixture',names:['plane'],imgsz:1024});await runner.processClip(__feature(__shape(1600,1200)),{release:101,date:'2026-10-29'},{zoom:18,bounded:true,clipId:'crash:0'})}catch(e){error=e.code}finally{await runner.close();window.Worker=NativeWorker}
    const restart=await GVProcessing.create({jobId:'restart-check',store:__repo});await restart.loadModel(null);await restart.close();
    return {error,processing:GVProcessing.diagnostics(),reserved:GVEngine.allocations.diagnostics().reservedBytes};
  })()`);
  assert.equal(result.worker.crash.error, 'WORKER_CRASH'); assert.equal(result.worker.crash.reserved, 0);
  assert.equal(result.worker.crash.processing.active, 0); assert.equal(result.worker.crash.processing.pendingStorage, 0);
  assert.equal(result.worker.crash.processing.created, result.worker.crash.processing.terminated);
  // Full application job submission must use the worker and commit its staged
  // artifacts before the queue releases the job/session/context.
  await evaluate(`document.querySelector('[data-tab=det]').click();document.querySelector('#runBtn').click()`);
  await until("GVApp.diagnostics().processing.created>=6&&document.querySelector('#queueStatus').textContent==='Idle · 0/10 queued'");
  result.worker.app = await evaluate("({log:document.querySelector('#jobLog').textContent,processing:GVApp.diagnostics().processing})");
  assert.match(result.worker.app.log, /Finished: 1 objects/);
  assert.match(result.worker.app.log, /dedicated worker/);
  assert.equal(result.worker.app.processing.active, 0);
  result.worker.staging = await evaluate(`(async()=>{
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(GVStorage.NAME);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
    try{return await new Promise((resolve,reject)=>{const q=db.transaction('artifacts').objectStore('artifacts').index('clipId').count('gmd-staging');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)})}finally{db.close()}
  })()`);
  assert.equal(result.worker.staging, 0, 'Success, cancellation and crash must leave no uncommitted spool');
  await evaluate(`(() => {
    const create=GVProcessing.create;let hidden=false;
    GVProcessing.create=async options=>{
      const runner=await create(options),process=runner.processClip;
      runner.processClip=(aoi,release,options)=>process(aoi,release,{...options,onProgress:f=>{
        options.onProgress?.(f);
        if(f>.4&&!hidden){hidden=true;GVProcessing.create=create;window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))}
      }});
      return runner;
    };
    document.querySelector('[data-tab=det]').click();document.querySelector('#runBtn').click();
  })()`);
  await until("GVProcessing.diagnostics().created>=7&&GVProcessing.diagnostics().active===0&&GVApp.diagnostics().queue.state==='suspended'");
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await until("!document.querySelector('#resumeQueue').hidden&&!document.querySelector('#resumeQueue').disabled");
  await evaluate("document.querySelector('#resumeQueue').click()");
  await until("GVProcessing.diagnostics().created>=8&&document.querySelector('#queueStatus').textContent==='Idle · 0/10 queued'");
  result.worker.recovery = await evaluate("({log:document.querySelector('#jobLog').textContent,processing:GVProcessing.diagnostics()})");
  assert.equal(result.worker.recovery.processing.active, 0);
  assert.equal(result.worker.recovery.processing.created, result.worker.recovery.processing.terminated);
  assert.deepEqual(errors, []);
};
