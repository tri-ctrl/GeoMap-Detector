/* Real model non-regression gate, using one captured live release/provider.
 * GMD-006 numerical gates are declared here before running the experiment:
 * original Canvas -> deterministic area mask: identical class counts, maximum
 * corresponding corner change 0.5 native pixel, confidence change <= 0.005.
 * canonical whole -> bounded: <= 0.05 native pixel, confidence <= 0.0001.
 * This is equivalence to the existing detector, not labelled accuracy evidence.
 */
const assert = require('node:assert/strict');
module.exports = async ({ evaluate, results }) => {
  const models = await evaluate(`(async()=>{
    const E=GVEngine,IO=window.GVStreaming||(await E.ensureLibrary('streaming'),window.GVStreaming),catalog=await(await fetch('models/models.json')).json();
    const releases=await E.getReleases(),release=releases.find(r=>r.date===__queueProbe.clips[0].date);
    const rect=[[[55.36,25.25],[55.362,25.25],[55.362,25.252],[55.36,25.252],[55.36,25.25]]];
    const geometries=[{type:'Polygon',coordinates:rect},
      {type:'Polygon',coordinates:[[[55.36,25.25],[55.362,25.25015],[55.36185,25.252],[55.36,25.252],[55.36,25.25]]]},
      {type:'Polygon',coordinates:[...rect,[[55.3601,25.2501],[55.3603,25.2501],[55.36015,25.25035],[55.3601,25.2501]]]},
      {type:'MultiPolygon',coordinates:[rect,[[[55.36205,25.25],[55.36215,25.25],[55.3621,25.2501],[55.36205,25.25]]]]}];
    const largeRect=[[[55.354,25.245],[55.368,25.245],[55.368,25.256],[55.354,25.256],[55.354,25.245]]];
    const large=[{type:'Polygon',coordinates:largeRect},
      {type:'Polygon',coordinates:[[[55.354,25.245],[55.368,25.2454],[55.3675,25.256],[55.354,25.256],[55.354,25.245]]]},
      {type:'Polygon',coordinates:[...largeRect,[[55.3543,25.2453],[55.3548,25.2453],[55.3545,25.2458],[55.3543,25.2453]]]},
      {type:'MultiPolygon',coordinates:[[[[55.354,25.245],[55.3543,25.245],[55.3542,25.2455],[55.354,25.245]]],[[[55.3547,25.245],[55.368,25.2454],[55.3675,25.256],[55.3547,25.256],[55.3547,25.245]]]]}];
    geometries.push(...large);
    const repo=GVStorage.create({name:'gmd-quality',locks:null});await repo.open();window.__qualityContext={geometries,repo,release};
    return catalog.filter(m=>/yolo11[ns]-obb/.test(m.file));
  })()`,60000);
  const quality=[];
  for(const spec of models){
    await evaluate(`(async()=>{__qualityContext.model=await GVEngine.loadModel({key:'url:'+${JSON.stringify(spec.file)},url:'models/'+${JSON.stringify(spec.file)},names:${JSON.stringify(spec.names)},imgsz:${spec.imgsz}})})()`,120000);
    for(let i=0;i<8;i++){
      const sample=await evaluate(`(async()=>{
        const E=GVEngine,IO=GVStreaming,{geometries,repo,release,model}=__qualityContext,i=${i},spec=${JSON.stringify(spec)};
        const aoi={type:'Feature',properties:{name:'Quality_'+i},geometry:geometries[i]},options={zoom:18,model,classes:['aircraft','ship','helicopter'],conf:.3,geotiff:false};
        const plan=E.estimateRaster(aoi.geometry,18,{bounded:true,modelSize:model.imgsz});
        const start=performance.now(),original=await E.processClip(aoi,release,options),canonical=await E.processClip(aoi,release,{...options,maskVersion:plan.maskVersion}),bounded=await E.processClip(aoi,release,{...options,bounded:true,store:repo,jobId:'quality',clipId:spec.file+'-'+i});
        const sample={model:spec.file,provider:model.provider,geometry:(i>=4?'large-':'small-')+['rectangle','diagonal','hole','multi'][i%4],mask:plan.maskVersion,release:release.release,date:release.date,zoom:bounded.zoom,
          size:bounded.size,ms:performance.now()-start,original:original.fc.features,canonical:canonical.fc.features,bounded:bounded.fc.features};
        if(bounded.blobs.png?.spool)await IO.discardArtifact(bounded.blobs.png.spool,repo);
        return sample;
      })()`,120000);
      quality.push(sample);console.log(`${sample.provider} ${sample.model} ${sample.geometry}: ${sample.original.length} detections, ${(sample.ms/1000).toFixed(1)}s for three paths.`);
    }
  }
  await evaluate('__qualityContext.repo.close()');
  const pixel = (point, z) => { const size = 256 * 2 ** z, latitude = point[1] * Math.PI / 180; return [(point[0] + 180) / 360 * size, (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * size]; };
  function compare(reference, actual, zoom, cornerTolerance, confidenceTolerance) {
    assert.equal(actual.length, reference.length, 'Detection count changed'); const remaining = actual.slice(); let maxCorner = 0, maxConfidence = 0;
    for (const before of reference) {
      const a = before.geometry.coordinates[0].slice(0, -1).map(p => pixel(p, zoom)); let best = null;
      for (const candidate of remaining) {
        if (candidate.properties.class !== before.properties.class) continue;
        const points = candidate.geometry.coordinates[0].slice(0, -1).map(p => pixel(p, zoom)); let error = Infinity;
        for (const b of [points, points.slice().reverse()]) for (let shift = 0; shift < 4; shift++) error = Math.min(error, Math.max(...a.map((p, i) => Math.hypot(p[0] - b[(i + shift) % 4][0], p[1] - b[(i + shift) % 4][1]))));
        if (!best || error < best.error) best = { candidate, error };
      }
      assert.ok(best, 'Class changed'); assert.ok(best.error <= cornerTolerance, `Corner moved ${best.error}px (limit ${cornerTolerance}px)`);
      const score = Math.abs(before.properties.confidence - best.candidate.properties.confidence); assert.ok(score <= confidenceTolerance, `Confidence changed by ${score}`);
      maxCorner = Math.max(maxCorner, best.error); maxConfidence = Math.max(maxConfidence, score); remaining.splice(remaining.indexOf(best.candidate), 1);
    }
    return { count: reference.length, maxCornerPixels: maxCorner, maxConfidence };
  }
  for (const sample of quality) {
    assert.ok(sample.original.length > 0, sample.model + ' ' + sample.geometry + ' must exercise a real detection');
    try { sample.originalToCanonical = compare(sample.original, sample.canonical, sample.zoom, .5, .005);
      sample.canonicalToBounded = compare(sample.canonical, sample.bounded, sample.zoom, .05, .0001);
    } catch(error) { console.log(JSON.stringify(sample));throw Error(sample.model+' '+sample.geometry+': '+error.message); }
  }
  results.quality = { gates: { originalToCanonical: { cornerPixels: .5, confidence: .005 }, canonicalToBounded: { cornerPixels: .05, confidence: .0001 }, identicalClassesAndCounts: true }, samples: quality };
  console.log('Real nano/small predictions match the declared original/canonical/bounded quality gates for all four geometry fixtures.');
};
