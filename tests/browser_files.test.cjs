const assert=require('node:assert/strict'),test=require('node:test'),{IDBFactory}=require('fake-indexeddb');
const {create,MAX_FILE}=require('../frontend/browser-files.js');
const {normalize,csv,czml}=require('../frontend/file-geometry.js');
const extensions=require('../frontend/file-formats.json').extensions;
const fc={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'DXB'},geometry:{type:'Point',coordinates:[55.36,25.25]}}]};
const layers=()=>[{name:'points',kind:'vector',bbox:[55.36,25.25,55.36,25.25],feature_count:1,artifacts:[{role:'data',blob:new Blob([JSON.stringify(fc)],{type:'application/geo+json'}),media_type:'application/geo+json'}]}];
async function fixture(t,process=async()=>layers(),options={}){const indexedDB=new IDBFactory(),api=await create({indexedDB,extensions,process,...options});t.after(()=>api.close());return {indexedDB,api};}
const file=()=>new File([JSON.stringify(fc)],'points.geojson');
test('browser files need no health HTTP service and persist folders, layers and originals across connections',async t=>{
 const {api,indexedDB}=await fixture(t);assert.equal((await api.request('/api/ingestion/health')).mode,'browser');
 const folder=await api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),name:'GIS',parent_id:null}});
 const row=await api.add(file(),{folder_id:folder.id});assert.equal(row.status,'completed');
 const other=await create({indexedDB,extensions,process:async()=>layers()});t.after(()=>other.close());
 assert.equal((await other.request('/api/directories')).items[0].name,'GIS');
 assert.equal((await other.request('/api/uploads?folder=root')).items.length,0);
 const restored=(await other.request('/api/uploads?folder='+folder.id)).items[0];assert.equal(restored.id,row.id);
 assert.deepEqual(JSON.parse(await(await other.readArtifact(restored,restored.processed_files[0],'data')).text()),fc);
 assert.deepEqual(JSON.parse(await(await other.readSource(row.id)).text()),fc);
});
test('failed and cancelled processing preserve originals without committing partial layers',async t=>{
 let attempt=0;const {api}=await fixture(t,async()=>{if(!attempt++)throw Error('Invalid coordinates');return layers();});
 await assert.rejects(api.add(file()),/Invalid coordinates/);const row=(await api.request('/api/uploads')).items[0];assert.equal(row.status,'failed');assert.equal(row.processed_files.length,0);assert.ok((await api.readSource(row.id)).size);
 const result=await api.request('/api/uploads/'+row.id+'/retry',{method:'POST'});assert.equal(result.attempt,2);assert.equal(result.status,'completed');
 await assert.rejects(api.readArtifact({...row,attempt:1},result.processed_files[0],'data'),/replaced/);
});
test('stopping a worker preserves a retryable record and drains its ownership',async t=>{
 let started;const ready=new Promise(resolve=>started=resolve);const {api}=await fixture(t,(_file,{signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true});}));
 const pending=api.add(file());await ready;api.suspend();await assert.rejects(pending,{name:'AbortError'});
 const row=(await api.request('/api/uploads')).items[0];assert.equal(row.status,'failed');assert.match(row.error,/stopped/);assert.ok((await api.readSource(row.id)).size);
});
test('expired processing recovers in another connection and an obsolete result cannot overwrite its retry',async t=>{
 let start,finish;const started=new Promise(resolve=>start=resolve),gate=new Promise(resolve=>finish=resolve);
 const {api,indexedDB}=await fixture(t,async()=>{start();return gate;},{locks:null});const pending=api.add(file());await started;
 const other=await create({indexedDB,extensions,process:async()=>layers(),locks:null});t.after(()=>other.close());
 const now=Date.now;try{Date.now=()=>now()+300000;await other.request('/api/ingestion/health');}finally{Date.now=now;}
 const row=(await other.request('/api/uploads')).items[0];assert.equal(row.status,'failed');assert.match(row.error,/interrupted/);
 const latest=await other.request('/api/uploads/'+row.id+'/retry',{method:'POST'});finish(layers());await assert.rejects(pending,{name:'AbortError'});
 assert.equal((await other.request('/api/uploads/'+latest.id)).attempt,2);assert.equal((await other.request('/api/uploads/'+latest.id)).status,'completed');
});
test('removing a browser copy releases originals/artifacts and leaves other files intact',async t=>{
 const {api}=await fixture(t),a=await api.add(file()),b=await api.add(file());await api.remove(a.id);
 await assert.rejects(api.readSource(a.id),/no longer/);assert.equal((await api.request('/api/uploads')).items.length,1);
 assert.equal((await api.request('/api/uploads/'+b.id)).status,'completed');
});
test('unlocated formats are saved with explicit location state and original download',async t=>{
 const {api}=await fixture(t,async input=>[{name:input.name,kind:'package',bbox:null,message:'Native decoder required',artifacts:[{role:'data',blob:input,media_type:'application/octet-stream'}]}]);
 const result=await api.add(new File(['native bytes'],'data.ecw'));assert.equal(result.status,'stored');assert.equal(result.processed_files[0].bbox,null);assert.match(result.processed_files[0].message,/Native decoder/);
});
test('directories enforce uniqueness, depth and valid moves in the same transaction',async t=>{
 const {api}=await fixture(t),id=crypto.randomUUID();await api.request('/api/directories',{method:'POST',body:{id,name:'GIS'}});
 await assert.rejects(api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),name:'gis'}}),/already exists/);
 await assert.rejects(api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),name:'../unsafe'}}),/names/);
 let parent=id;for(let i=0;i<11;i++){parent=(await api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),name:'Child',parent_id:parent}})).id;}
 await assert.rejects(api.request('/api/directories',{method:'POST',body:{id:crypto.randomUUID(),name:'Too deep',parent_id:parent}}),/12 levels/);
 const row=await api.add(file());await api.request('/api/uploads/'+row.id+'/directory',{method:'PATCH',body:{folder_id:id}});assert.equal((await api.request('/api/uploads?folder='+id)).items.length,1);
 await assert.rejects(api.request('/api/uploads/'+row.id+'/directory',{method:'PATCH',body:{folder_id:'missing'}}),/not found/);
 assert.equal((await api.request('/api/uploads?folder='+id)).items.length,1);
});
test('file size and extension admission fail before creating catalog rows',async t=>{
 const {api}=await fixture(t);await assert.rejects(api.add(new File(['x'],'bad.exe')),/extension/);
 const part=new Uint8Array(1024);const large=new File(Array(129*1024).fill(part),'large.tif');assert.ok(large.size>MAX_FILE);await assert.rejects(api.add(large),/128 MiB/);
 assert.equal((await api.request('/api/uploads')).items.length,0);
});
test('geometry normalization retains generic layers and rejects invalid coordinates and topology',()=>{
 assert.deepEqual(normalize(fc).bbox,[55.36,25.25,55.36,25.25]);
 assert.throws(()=>normalize({type:'Point',coordinates:[200,0]}),/longitude/);
 assert.throws(()=>normalize({type:'Point',coordinates:[1,2,Infinity]}),/longitude/);
 assert.throws(()=>normalize({type:'Polygon',coordinates:[[[0,0],[1,0],[0,1]]]}),/too few/);
 assert.throws(()=>normalize({type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[2,2]]]}),/closed/);
 const data=normalize({type:'GeometryCollection',geometries:[{type:'LineString',coordinates:[[0,0],[1,1]]},{type:'Point',coordinates:[2,3]}]});assert.deepEqual(data.bbox,[0,0,2,3]);
});
test('CSV handles quoted commas/newlines and rejects missing/nonfinite coordinates',()=>{
 const result=csv('name,lat,lon\r\n"DXB, terminal\nA",25.25,55.36\r\n');assert.equal(result.fc.features[0].properties.name,'DXB, terminal\nA');
 assert.throws(()=>csv('lat,lon\n,55'),/row 2/);assert.throws(()=>csv('lat,lon\nInfinity,55'),/row 2/);assert.throws(()=>csv('lat,lon\n999,55'),/longitude/);
});
test('CZML cartographic snapshots produce map geometry without inventing locations',()=>{
 assert.deepEqual(czml([{id:'document',version:'1.0'},{id:'point',position:{cartographicDegrees:[55,25,30]}}]).bbox,[55,25,55,25]);assert.throws(()=>czml([{id:'document',version:'1.0'}]),/no supported/);
});
