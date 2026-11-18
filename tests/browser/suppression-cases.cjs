/* Same-realm native CPU benchmark and deterministic regression checks. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
module.exports = async ({ evaluate, errors, result }) => {
  const fixture = fs.readFileSync(require.resolve('../helpers/nms-fixtures.cjs'), 'utf8');
  await evaluate(`(()=>{const module={exports:{}};${fixture}\nwindow.__nmsReference=module.exports})()`);
  result.suppression = await evaluate(`(async()=>{
    const E=GVEngine,R=__nmsReference,samples=[];
    const q=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
    for(const scene of R.workloads())for(const useMin of [false,true]){
      const expected=R.scan(scene.dets,.45,useMin).map(d=>d.id).join('|'),times={scan:[],indexed:[]};
      for(let i=-3;i<9;i++)for(const mode of i%2?['indexed','scan']:['scan','indexed']){
        const start=performance.now(),out=mode==='scan'?R.scan(scene.dets,.45,useMin):E.nms(scene.dets,.45,useMin),ms=performance.now()-start;
        if(out.map(d=>d.id).join('|')!==expected)throw Error('Ordered suppression changed');if(i>=0)times[mode].push(ms);
      }
      const profile={};E.nms(scene.dets,.45,useMin,{profile});
      const asyncProfile={},out=await E.suppression.runAsync(scene.dets,.45,useMin,undefined,{profile:asyncProfile});
      if(out.map(d=>d.id).join('|')!==expected)throw Error('Async suppression changed');
      samples.push({name:scene.name,policy:useMin?'IoMin':'IoU',input:scene.dets.length,exactOrderedOutput:true,profile,asyncProfile,
        scan:{medianMs:q(times.scan,.5),p95Ms:q(times.scan,.95),samplesMs:times.scan},indexed:{medianMs:q(times.indexed,.5),p95Ms:q(times.indexed,.95),samplesMs:times.indexed}});
    }
    return{method:'Same renderer/context, three warmups and nine alternating repetitions; synthetic CPU suppression only',samples,cleanup:E.suppression.diagnostics()};
  })()`, 180000);
  for (const sample of result.suppression.samples) {
    assert.ok(sample.profile.peakIndexEstimateBytes <= 2 * 1048576);
    if (sample.name === 'sparse-global-3000') assert.ok(sample.profile.bboxTests < sample.input * (sample.input - 1) / 8);
  }
  assert.equal(result.suppression.cleanup.active, 0); assert.equal(result.suppression.cleanup.activeIndexEstimateBytes, 0);
  assert.deepEqual(errors, []);
  console.log('Native suppression: exact ordered scan/indexed/async outputs, bounded scratch, sparse comparison reduction and cleanup pass.');
};
