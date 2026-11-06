const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {setup,aoi,turn} = require('./helpers/app.cjs');
const source=fs.readFileSync(path.join(__dirname,'../frontend/comparison.js'),'utf8');
const context=vm.createContext({DOMException});vm.runInContext(source,context);
const C=context.GVCompare;
const record=(values={})=>({geometry:'polygon',date:'2026-10-29',release:101,model:'Nano',modelKey:'nano',zoom:18,params:{conf:0.3,classes:['ship']},...values});
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok});return{promise,resolve}};
test('date pairs are chronological regardless of checkbox order; mismatched AOIs/models/dates are actionable',()=>{
  const a=record(),b=record({date:'2025-01-01',release:100});
  assert.equal(C.validatePair([a,b],'dates').pair[0],b);
  for(const pair of [[a],[a,record()],[a,record({date:b.date,geometry:'other'})],[a,record({date:b.date,model:'Small'})]]) assert.ok(C.validatePair(pair,'dates').error);
});
test('model comparison requires same release/AOI/zoom and two recorded distinct detection models',()=>{
  const a=record(),b=record({model:'Small',modelKey:'small'});assert.ok(C.validatePair([a,b],'models').pair);
  for(const fields of [{modelKey:'nano'},{release:100},{zoom:17},{modelKey:null},{model:'Imagery only'}]) assert.ok(C.validatePair([a,{...b,...fields}],'models').error);
  assert.match(C.settingsNote(a,record({params:{conf:0.5,classes:['plane']}})),/confidence.*classes/);
});
async function browserApp({pendingPreview}={}){
  const views=[],processed=[];
  const app=await setup({selected:true,fetchHook:url=>url.endsWith('models/models.json')?{ok:true,json:async()=>[
    {file:'nano.onnx',label:'YOLO nano',imgsz:1024,names:['plane']},{file:'small.onnx',label:'YOLO small',imgsz:1024,names:['plane']}]}:null,
    beforeBoot:context=>{
      context.GVEngine.loadModel=async spec=>({provider:'wasm',imgsz:1024,key:spec.key});
      const original=context.GVEngine.processClip;
      context.GVEngine.processClip=async(feature,release,options)=>{const value=await original(feature,release,options);processed.push(value);return value};
      context.GVCompare.preview=pendingPreview?()=>pendingPreview.promise:async()=>({blob:new Blob(['preview']),size:[100,100]});
      context.GVCompare.Swipe=class{constructor(){views.push(this)}async show(sides){this.sides=sides;this.active=true}stop(){this.active=false}destroy(){this.destroyed=true}};
    }});
  app.element('#detectOn').checked=true;
  await app.element('#runBtn').onclick();await turn();
  app.element('#model').value='url:small.onnx';await app.element('#runBtn').onclick();await turn();
  return{app,views,processed};
}
function compareBoxes(app){return app.element('#resTable tbody').querySelectorAll('[data-compare-row]')}
async function enter(app,mode='dates'){
  app.element('#resultView').value='compare';app.element('#compareKind').value=mode;app.element('#resultView').onchange();await turn();
}
async function pick(app,index){const checkbox=compareBoxes(app)[index];checkbox.checked=true;checkbox.onchange();await turn()}
test('Results shows model names; rapid model runs have distinct IDs and two selected rows produce older-left/newer-right',async()=>{
  const{app,views}=await browserApp();
  assert.match(app.element('#resTable tbody').innerHTML,/YOLO small/);
  assert.equal(app.element('#jobSel').options.length,2);
  await enter(app);assert.equal(compareBoxes(app).length,4);
  assert.match(app.element('#resTable tbody').innerHTML,/YOLO nano/);
  await pick(app,0);await pick(app,1);
  assert.equal(views[0].active,true);
  assert.match(app.element('#compareLeftLabel').textContent,/Older.*2026-10-22/);
  assert.match(app.element('#compareRightLabel').textContent,/Newer.*2026-10-29/);
  app.element('#compareExit').onclick();assert.equal(views[0].active,false);
});
test('same-date model runs compare across jobs; source predictions stay unchanged by annotation edits',async()=>{
  const{app,views,processed}=await browserApp();await app.openClip(0);
  const selected=app.groups[2].getLayers()[0];selected.fire('click');app.element('#bAcc').onclick();
  assert.equal(processed[2].fc.features[0].properties.status,'predicted');
  assert.equal(processed[2].draftFC.features[0].properties.status,'verified');
  await app.element('#bEdit').onclick();const previousPosition=app.map.position,previousZoom=app.map.zoom;
  await enter(app,'models');await pick(app,0);await pick(app,2);
  assert.equal(views[0].sides[1].fc.features[0].properties.status,'predicted');
  assert.match(app.element('#compareLeftLabel').textContent,/Model A.*YOLO nano/);
  assert.match(app.element('#compareRightLabel').textContent,/Model B.*YOLO small/);
  app.element('#compareExit').onclick();assert.equal(selected.editing.active,true);
  assert.equal(app.map.zoom,previousZoom);assert.deepEqual(app.map.position,previousPosition);
});
test('late image preparation after exit cannot replace the normal map',async()=>{
  const pending=deferred(),{app,views}=await browserApp({pendingPreview:pending});
  await enter(app);await pick(app,0);await pick(app,1);app.element('#compareExit').onclick();
  pending.resolve({blob:new Blob(['preview']),size:[100,100]});await turn();await turn();
  assert.equal(views.length,0);assert.equal(app.element('#resultView').value,'review');
});
test('server results expose recorded models and fetch only selected images/detections',async()=>{
  const detail=id=>({id,params:{model:id==='first'?'nano.pt':'small.pt',detect:true},results:[{
    aoi:'Review',aoi_id:'Review',date:'2026-10-29',release:101,path:'Review/2026-10-29',bounds:[55.36,25.25,55.37,25.26],zoom:18,counts:{aircraft:1},total:1}]});
  const views=[],app=await setup({server:true,fetchHook:url=>{
    let value;
    if(url.endsWith('/api/jobs'))value=[{id:'first'},{id:'second'}];
    else if(url.endsWith('/api/jobs/first'))value=detail('first');else if(url.endsWith('/api/jobs/second'))value=detail('second');
    else if(url.endsWith('/aoi.geojson'))value=aoi;
    else if(url.endsWith('/detections.geojson'))value={type:'FeatureCollection',features:[]};
    else if(url.endsWith('/image.png'))return{ok:true,blob:async()=>new Blob(['image'])};
    if(value)return{ok:true,json:async()=>value};
  },beforeBoot:context=>{
    context.GVCompare.preview=async()=>({blob:new Blob(['preview']),size:[100,100]});
    context.GVCompare.Swipe=class{constructor(){views.push(this)}async show(sides){this.sides=sides}stop(){}};
  }});
  await enter(app,'models');assert.equal(compareBoxes(app).length,2);
  assert.equal(app.requests.filter(request=>request.url.endsWith('/image.png')).length,0);
  await pick(app,0);await pick(app,1);assert.equal(views[0].sides.length,2);
  assert.equal(app.requests.filter(request=>request.url.endsWith('/image.png')).length,2);
  app.element('#compareExit').onclick();
});

function swipeFixture({loads=true}={}){
  const urls=[],revoked=[],layers=new Set(),panes=new Map(),handlers=new Map(),handleEvents=new Map();
  const handle={addEventListener:(name,fn)=>handleEvents.set(name,fn),removeEventListener:name=>handleEvents.delete(name),setAttribute(name,value){this[name]=value},setPointerCapture(){},hasPointerCapture:()=>false};
  const element={hidden:true,style:{setProperty(name,value){this[name]=value}},querySelector:()=>handle};
  const map={getPane:name=>panes.get(name),createPane:name=>{const pane={style:{}};panes.set(name,pane);return pane},
    getSize:()=>({x:1000,y:600}),containerPointToLayerPoint:([x,y])=>({x:x-100,y:y-50}),
    on:(names,fn)=>handlers.set(names,fn),off:names=>handlers.delete(names),getContainer:()=>({getBoundingClientRect:()=>({left:0,width:1000})}),removeLayer:layer=>layers.delete(layer)};
  const images=[];
  const layer=()=>({events:new Map(),on(name,fn){this.events.set(name,fn);return this},off(name){this.events.delete(name);return this},addTo(){layers.add(this);if(this.image&&loads)queueMicrotask(()=>this.events.get('load')?.());return this}});
  const L={imageOverlay:()=>{const image=layer();image.image=true;images.push(image);return image},svg:layer,geoJSON:layer};
  const context=vm.createContext({DOMException,setTimeout,clearTimeout,URL:{createObjectURL:()=>{const url='blob:'+urls.length;urls.push(url);return url},revokeObjectURL:url=>revoked.push(url)}});
  vm.runInContext(source,context);const swipe=new context.GVCompare.Swipe(map,element,L);
  const sides=[0,1].map(()=>({preview:{blob:{}},bounds:[],fc:{}}));
  return{swipe,sides,panes,images,handle,handleEvents,layers,handlers,urls,revoked,element};
}
test('swipe clips imagery and vectors in map coordinates, supports keys and releases all per-pair resources',async()=>{
  const f=swipeFixture();await f.swipe.show(f.sides,()=>({}));
  assert.equal(f.panes.get('gmd-compare-left').style.clip,'rect(-50px, 400px, 550px, -100px)');
  f.handleEvents.get('keydown')({key:'End',preventDefault(){},stopPropagation(){}});
  assert.equal(f.handle['aria-valuenow'],'100');assert.equal(f.element.style['--compare-x'],'100%');
  f.swipe.stop();assert.equal(f.layers.size,0);assert.equal(f.handlers.size,0);
  assert.deepEqual(f.revoked,f.urls);assert.equal(f.element.hidden,true);
  f.swipe.destroy();assert.equal(f.handleEvents.size,0);assert.equal(f.panes.size,2);
});
test('rapid replacement cancels old image loads without disposing the newer pair',async()=>{
  const f=swipeFixture({loads:false}),old=f.swipe.show(f.sides,()=>({}));
  const rejection=assert.rejects(old,{name:'AbortError'});
  const current=f.swipe.show(f.sides,()=>({}));
  f.images.slice(-2).forEach(image=>image.events.get('load')());await current;await rejection;
  assert.equal(f.swipe.active,true);assert.equal(f.layers.size,6);f.swipe.destroy();
  assert.equal(f.revoked.length,4);
});
