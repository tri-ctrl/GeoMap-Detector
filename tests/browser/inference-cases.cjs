/* Real model A/B with fixed provider/image bytes. This is baseline equivalence,
 * not a labelled accuracy or device-independent speedup benchmark.
 */
const assert = require('node:assert/strict');
module.exports = async ({ evaluate, errors, results, forceWasm, failGpu }) => {
  results.inferenceExperiment = { gates: { exactOrderedGeoJSON: true, identicalNativeDimensionsAndWorldFile: true,
    expectedClassNonempty: true, repetitions: 3, warmupsPerMode: 1, numericSettingsUnchanged: true }, samples: [] };
  const release = await evaluate(`(async()=>{
    const releases=await GVEngine.getReleases(),release=releases.find(r=>r.date==='2026-10-29')||releases[0];
    window.__inferenceRelease=release;return release;
  })()`);
  results.inferenceExperiment.release = release;
  for (const name of ['n', 's']) {
    await evaluate(`(async()=>{
      const E=GVEngine,repo=GVStorage.create({name:'gmd017-inference'});await repo.open();
      const spec={key:'yolo11${name}',url:'https://tri-ctrl.github.io/GeoMap-Detector/models/yolo11${name}-obb.onnx',imgsz:1024,names:E.DOTA_NAMES};
      const controller=new AbortController(),runner=await GVProcessing.create({jobId:'gmd017:'+spec.key,signal:controller.signal,store:repo});
      if(runner.context!=='worker')throw Error('Expected dedicated inference worker');
      const started=performance.now(),model=await runner.loadModel(spec);
      window.__inferenceProbe={repo,runner,model,spec,loadMs:performance.now()-started};
    })()`, 120000);
    try {
      for (const scene of [
        { name: 'DXB-aircraft', wanted: 'aircraft', bounds: [55.36, 25.25, 55.362, 25.252] },
        { name: 'Rashid-ships', wanted: 'ship', bounds: [55.268, 25.268, 55.281, 25.277] },
      ]) {
        console.log(`Profiling yolo11${name} ${scene.name} on ${forceWasm ? 'WASM' : 'WebGPU'}…`);
        const sample = await evaluate(`(async()=>{
          const {repo,runner,model,spec,loadMs}=__inferenceProbe,scene=${JSON.stringify(scene)},[a,b,c,d]=scene.bounds;
          const feature={type:'Feature',_gmd_id:'fixture:'+scene.name,properties:{name:scene.name},geometry:{type:'Polygon',coordinates:[[[a,b],[c,b],[c,d],[a,d],[a,b]]]}};
          const records=[];let expected=null,world=null,size=null,display=null,counts=null;
          const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
          for(let i=-1;i<3;i++)for(const mode of i%2?['indexed','scan']:['scan','indexed']){
            const start=performance.now(),output=await runner.processClip(feature,__inferenceRelease,{zoom:18,bounded:true,png:false,geotiff:false,nmsMode:mode,clipId:spec.key+':'+scene.name});
            const elapsedMs=performance.now()-start,signature=JSON.stringify(output.fc),image=await hash(output.blobs.display),p=output.timings.inference;
            if(expected===null){expected=signature;world=output.blobs.pgw;size=JSON.stringify(output.size);display=image;counts=output.counts}
            if(signature!==expected||world!==output.blobs.pgw||size!==JSON.stringify(output.size)||image!==display)throw Error('Baseline/indexed output changed');
            if(p.nmsMode!==mode||p.status!=='complete'||p.inferredWindows<1||p.disposalErrors)throw Error('Incomplete inference profile');
            if(i>=0)records.push({mode,repetition:i+1,elapsedMs,timings:output.timings});
          }
          const q=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1],summary={};
          for(const mode of ['scan','indexed']){
            const selected=records.filter(r=>r.mode===mode),median={};
            for(const field of ['totalMs','modelCallMs','rasterReadMs','normalizeMs','decodeMs','chipNmsMs','globalNmsMs','disposeMs'])median[field]=q(selected.map(r=>r.timings.inference[field]),.5);
            summary[mode]={median,p95InferenceMs:q(selected.map(r=>r.timings.inference.totalMs),.95),medianClipMs:q(selected.map(r=>r.elapsedMs),.5)};
          }
          return{scene:scene.name,expectedClass:scene.wanted,model:spec.key,modelFingerprint:model.fingerprint,provider:model.provider,modelLoadMs:loadMs,
            exactOrderedGeoJSON:true,displayHash:display,world,size:JSON.parse(size),counts,reference:JSON.parse(expected),records,summary};
        })()`, 240000);
        assert.equal(sample.provider, forceWasm || failGpu ? 'wasm' : 'webgpu');
        assert.match(sample.modelFingerprint, /^sha256:[a-f0-9]{64}$/);
        assert.ok(sample.counts[scene.wanted] > 0, `${name}/${scene.name} must exercise ${scene.wanted}`);
        for (const r of sample.records) {
          const p = r.timings.inference;
          assert.equal(p.inputBufferBytes, 3 * 1024 * 1024 * 4); assert.ok(p.selectedOutputBytes > 0);
          assert.ok((p.chipNms.peakIndexEstimateBytes || 0) <= p.nmsBudgetBytes);
          assert.ok(p.globalNms.peakIndexEstimateBytes <= p.nmsBudgetBytes);
        }
        results.inferenceExperiment.samples.push(sample);
      }
    } finally {
      const cleanup = await evaluate(`(async()=>{const p=__inferenceProbe;await p.runner.close();await p.repo.close();delete window.__inferenceProbe;return GVProcessing.diagnostics()})()`);
      assert.equal(cleanup.active, 0); assert.equal(cleanup.created, cleanup.terminated); assert.equal(cleanup.pendingStorage, 0);
      assert.equal(cleanup.last.models.leased, 0); assert.equal(cleanup.last.suppression.activeIndexEstimateBytes, 0); assert.equal(cleanup.last.inference.active, 0);
      results.cleanup = cleanup;
    }
  }
  assert.deepEqual(errors, []);
};
