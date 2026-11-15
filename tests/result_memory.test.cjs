const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {IDBFactory}=require('fake-indexeddb');
const {setup,turn}=require('./helpers/app.cjs');
const context=vm.createContext({Blob,ArrayBuffer});vm.runInContext(fs.readFileSync(require.resolve('../frontend/storage.js'),'utf8'),context);
const {createMemory,estimateBytes}=context.GVStorage,M=1048576;
const plain=value=>JSON.parse(JSON.stringify(value));
test('retention estimates count shared Blobs once and manifest metadata separately from stored chunk bytes',()=>{
  const blob=new Blob(['12345']),shared={a:blob,b:blob};shared.cycle=shared;
  assert.ok(estimateBytes(shared)<200);assert.ok(estimateBytes({fc:'x'.repeat(1000)})>2000);
  assert.ok(estimateBytes({fc:'x'.repeat(1000)},{skip:['fc']})<100);
  assert.ok(estimateBytes({gmdArtifact:1,size:300*M,file:'png',spool:'disk'})<500);
});
test('LRU eviction releases inactive entries while protecting every active lease',()=>{
  const cache=createMemory({limitBytes:M}),a=cache.insert('a',{id:'a'},{bytes:400000,job:'first'});a.release();
  const b=cache.insert('b',{id:'b'},{bytes:400000,job:'other'}),c=cache.insert('c',{id:'c'},{bytes:400000,job:'other'});
  assert.equal(cache.acquire('a'),null);assert.equal(cache.state().evictions,1);assert.equal(cache.state().pinnedBytes,800000);
  assert.throws(()=>cache.insert('big',{}, {bytes:900000}),{code:'RESULT_MEMORY_LIMIT'});assert.equal(b.value.id,'b');
  b.release();c.release();assert.ok(cache.state().totalBytes<=M);assert.ok(cache.clear()>0);assert.equal(cache.state().totalBytes,0);
});
test('dirty/session protection may exceed a lowered budget and remains visible until explicitly released',()=>{
  const cache=createMemory({limitBytes:4*M});cache.protect('unsaved',2*M);cache.configure(M);
  assert.equal(cache.state().overBudgetBytes,M);assert.equal(cache.state().pinnedBytes,2*M);cache.clear();
  assert.throws(()=>cache.ensure(1),{code:'RESULT_MEMORY_LIMIT'});cache.protect('unsaved',0);cache.ensure(1);
  const release=cache.reserve('display',500000);assert.equal(cache.state().protectedBytes,500000);release();release();assert.equal(cache.state().protectedBytes,0);
});
test('job-scoped invalidation cannot transfer a deleted reader or evict another job',()=>{
  const cache=createMemory({limitBytes:M}),a=cache.insert('a',{id:'a'},{job:'a',bytes:100}),b=cache.insert('b',{id:'b'},{job:'b',bytes:100});
  b.release();cache.clear('a');assert.equal(cache.acquire('a'),null);assert.throws(()=>cache.insert('a',{}, {bytes:100}),{code:'RESULT_MEMORY_LIMIT'});
  a.release();assert.equal(a.value,null);assert.equal(cache.state().entries,1);const hit=cache.acquire('b');assert.equal(hit.value.id,'b');hit.release();
});
async function until(check){for(let i=0;i<1500;i++){if(check())return;await turn()}assert.fail('State did not settle')}
async function fixture({indexedDB=new IDBFactory(),savedMap,beforeBoot}={}){
  let repo;
  const app=await setup({indexedDB,savedMap,selected:!savedMap,beforeBoot:ctx=>{
    const create=ctx.GVStorage.create;ctx.GVStorage.create=options=>(repo=create(options));beforeBoot?.(ctx,()=>repo);
  }});return{app,repo,indexedDB};
}
test('saved clip views read only their display artifact, reuse immutable raw cache and reload fresh drafts',async t=>{
  const f=await fixture();t.after(()=>f.repo.close());const job=await f.app.element('#runBtn').onclick();
  const png=job.results[0].storeId;const source=await f.repo.clip(png);assert.ok(source.blobs.png);assert.ok(source.artifactBytes>0);
  const display=await f.repo.clip(png,{images:'display',draft:false});assert.deepEqual(Object.keys(display.blobs),['png']);
  await f.app.openClip(0);const selected=f.app.groups[2].getLayers()[0];selected.fire('click');f.app.element('#bAcc').onclick();
  await until(()=>f.app.element('#storageStatus').textContent.startsWith('Saved'));
  await f.app.openClip(1);const before=f.repo.state().reads.predictions;await f.app.openClip(0);
  assert.equal(f.repo.state().reads.predictions,before);assert.ok(f.app.context.GVApp.diagnostics().memory.hits>0);
  assert.equal(f.app.groups[2].getLayers()[0].feature.properties.status,'verified');assert.equal((await f.repo.clip(png)).fc.features[0].properties.status,'predicted');
  assert.ok(f.app.context.GVApp.diagnostics().memory.storedArtifactBytes>0);
});
test('small retained budgets evict saved raw payloads; revisiting reads the original prediction again',async t=>{
  const f=await fixture({beforeBoot:ctx=>{const process=ctx.GVEngine.processClip;ctx.GVEngine.processClip=async(...args)=>{const r=await process(...args);r.fc.features[0].properties.large='x'.repeat(180000);return r}}});t.after(()=>f.repo.close());
  await f.app.element('#runBtn').onclick();f.app.element('#resultMemoryLimit').value=1;f.app.element('#resultMemoryLimit').onchange();
  await f.app.openClip(0);await f.app.openClip(1);assert.ok(f.app.context.GVApp.diagnostics().memory.evictions>0);
  const reads=f.repo.state().reads.predictions;await f.app.openClip(0);assert.equal(f.repo.state().reads.predictions,reads+1);
  const memory=f.app.context.GVApp.diagnostics().memory;assert.ok(memory.totalBytes<=memory.limitBytes);assert.equal(memory.pins,1);
  f.app.element('#clearResultCache').onclick();assert.equal(f.app.context.GVApp.diagnostics().memory.pins,1);assert.equal(f.app.groups[2].getLayers().length,1);
});
test('committing a partial clip releases native source payloads even while its private draft and display are open',async t=>{
  let captured,release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture({beforeBoot:ctx=>{const create=ctx.GVStorage.create;ctx.GVStorage.create=options=>{const db=create(options),save=db.saveClip;db.saveClip=async(job,r)=>{captured ||= r;await gate;return save(job,r)};return db}}});t.after(()=>f.repo.close());
  const running=f.app.element('#runBtn').onclick();await until(()=>captured);
  await f.app.element('#jobRefresh').onclick();await f.app.openClip(0);f.app.groups[2].getLayers()[0].fire('click');f.app.element('#bAcc').onclick();
  release();const job=await running;await until(()=>f.app.element('#storageStatus').textContent.startsWith('Saved'));
  assert.equal(captured.fc,undefined);assert.equal(captured.blobs,undefined);assert.ok(f.app.context.GVApp.diagnostics().memory.vectorEstimateBytes>0);
  assert.equal(f.app.context.GVApp.diagnostics().views.imageLeases,1);assert.equal(f.app.groups[2].getLayers()[0].feature.properties.status,'verified');
  assert.equal((await f.repo.clip(job.results[0].storeId)).fc.features[0].properties.status,'predicted');
});
test('a session result over budget stays exportable and pauses before computing another clip; raising the limit resumes without recomputing it',async()=>{
  let calls=0;
  const app=await setup({selected:true,beforeBoot:ctx=>{const process=ctx.GVEngine.processClip;ctx.GVEngine.processClip=async(...args)=>{calls++;const r=await process(...args);r.blobs.png=new Blob([new Uint8Array(1200000)]);return r}}});
  app.element('#resultMemoryLimit').value=1;app.element('#resultMemoryLimit').onchange();
  const job=await app.element('#runBtn').onclick();assert.equal(job.status,'interrupted');assert.equal(job.results.length,1);assert.equal(calls,1);
  assert.ok(job.results[0].fc&&job.results[0].blobs.png);assert.ok(app.context.GVApp.diagnostics().memory.overBudgetBytes>0);
  assert.match(app.element('#queueHint').textContent,/result-memory limit/);
  app.element('#resultMemoryLimit').value=8;app.element('#resultMemoryLimit').onchange();app.element('#resumeQueue').onclick();
  await until(()=>job.status==='done');assert.equal(calls,2);assert.equal(job.results.length,2);app.events.get('pagehide')();
});
test('failed deletion preserves cache/views; retry removes that job while saved training reviews and unrelated results survive',async t=>{
  let fail=true;const f=await fixture({beforeBoot:(ctx,getRepo)=>{ctx.confirm=()=>true;const create=ctx.GVStorage.create;ctx.GVStorage.create=options=>{const db=create(options),remove=db.deleteJob;db.deleteJob=id=>fail?Promise.reject(Error('Storage busy')):remove(id);return db}}});t.after(()=>f.repo.close());
  const first=await f.app.element('#runBtn').onclick();await f.app.openClip(0);f.app.groups[2].getLayers()[0].fire('click');f.app.element('#bAcc').onclick();await f.app.element('#saveAnn').onclick();
  const second=await f.app.element('#runBtn').onclick();f.app.element('#jobSel').value=first.id;await f.app.element('#jobSel').onchange();await f.app.openClip(0);
  await f.app.element('#deleteJob').onclick();assert.equal(f.app.context.GVApp.diagnostics().views.active,1);assert.equal(f.app.context.GVApp.diagnostics().memory.pins,1);
  fail=false;await f.app.element('#deleteJob').onclick();assert.equal(f.app.context.GVApp.diagnostics().memory.pins,0);
  assert.equal(f.app.context.GVApp.diagnostics().views.active,0);const saved=await f.repo.restore();assert.equal(saved.jobs.length,1);assert.equal(saved.jobs[0].id,second.id);
  assert.equal((await f.repo.reviews()).features.length,1);assert.equal(await f.repo.draft(first.results[0].storeId),undefined);
});
