const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const C=require('cesium');const {createLayerStore}=require('../frontend/uploads.js');
const context=vm.createContext({Cesium:C});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../frontend/map-view.js'),'utf8'),context);
const M=context.GVMapView;
const fc={type:'FeatureCollection',features:[
 {type:'Feature',properties:{name:'Point'},geometry:{type:'Point',coordinates:[55,25]}},
 {type:'Feature',properties:{name:'Line'},geometry:{type:'LineString',coordinates:[[55,25],[55.1,25.1]]}},
 {type:'Feature',properties:{name:'Area'},geometry:{type:'Polygon',coordinates:[[[55,25],[55.1,25],[55.1,25.1],[55,25]]]}}
]};

test('uploaded vector conversion creates real Cesium points, lines and polygons with independent identities',()=>{
 const entities=M.fileEntities(C,{id:'upload:1:layer',name:'GIS data',fc,opacity:.5});
 assert.equal(entities.length,3);assert.ok(entities[0].point);assert.ok(entities[1].polyline);assert.ok(entities[2].polygon);
 assert.equal(entities[0].properties.kind,'file');assert.match(entities[2].id,/^file:upload:/);
 assert.equal(M.fileVectorSize(fc).vertices,7);
 assert.equal(entities[0].point.color.alpha,.5);
});

test('multipart and collection geometry retain parts without converting points or lines into AOIs',()=>{
 const geometries=M.fileGeometries({type:'GeometryCollection',geometries:[{type:'MultiPoint',coordinates:[[0,0],[1,1]]},{type:'MultiLineString',coordinates:[[[0,0],[1,1]]]}]});
 assert.deepEqual(Array.from(geometries,g=>g.type),['Point','Point','LineString']);
});

function fixture(){
 const active=new Set(),events=[];
 const map={hasLayer:layer=>active.has(layer),removeLayer:layer=>active.delete(layer)};
 const make=()=>({addTo(){active.add(this);return this;},setStyle(style){this.style=style;},setOpacity(value){this.opacity=value;}});
 return {active,events,store:createLayerStore({map,L:{geoJSON:make,imageOverlay:make,circleMarker:make},changed:()=>events.push('change')})};
}
const row={id:'upload',attempt:1},file={id:'layer',name:'vectors',kind:'vector',bbox:[55,25,55.1,25.1]};

test('multiple uploaded layers coexist and visibility/opacity/removal affect only their own layer',async()=>{
 const {store,active}=fixture();const a=await store.add(row,file,async()=>({fc}));
 const b=await store.add({...row,id:'other'},file,async()=>({fc}));assert.equal(active.size,2);
 store.visibility(a.id,false);assert.equal(active.size,1);assert.equal(store.entries.get(b.id).visible,true);
 store.opacity(b.id,.25);assert.equal(store.entries.get(b.id).leaflet.style.opacity,.25);
 store.remove(a.id);assert.equal(store.layers().length,1);store.clear();assert.equal(active.size,0);
});

test('a removed pending load cannot reappear, and exceeding the aggregate geometry budget releases the failed entry',async()=>{
 const {store,active}=fixture();let finish;const gate=new Promise(resolve=>finish=resolve);
 const pending=store.add(row,file,()=>gate);store.remove(store.layerId(row,file));finish({fc});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(active.size,0);
 const huge={type:'FeatureCollection',features:Array.from({length:10001},()=>fc.features[0])};
 await assert.rejects(store.add(row,file,async()=>({fc:huge})),/display budget/);
 assert.equal(store.entries.size,0);assert.equal(active.size,0);
});
