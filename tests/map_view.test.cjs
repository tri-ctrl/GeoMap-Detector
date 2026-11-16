const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const proj4 = require('proj4');
const { setup, turn } = require('./helpers/app.cjs');
const source = fs.readFileSync(path.join(__dirname, '../frontend/map-view.js'), 'utf8');
function moduleContext(extra = {}) {
  const context = vm.createContext({ AbortController, DOMException, proj4, ...extra });
  vm.runInContext(source, context); return context.GVMapView;
}

test('Esri satellite uses z/y/x; Wayback uses the captured release and invalid basemaps cannot inject a service', () => {
  const api = moduleContext(), release = { release: 43291, date: '2026-10-29' }, wayback = (id,z,y,x) => `https://wayback.test/tile/${id}/${z}/${y}/${x}`;
  assert.equal(api.basemap('imagery', null, wayback).url, 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  assert.equal(api.basemap('wayback', release, wayback).url, 'https://wayback.test/tile/43291/{z}/{y}/{x}');
  assert.equal(api.basemap('https://evil.test', release, wayback).id, 'wayback');
  assert.equal(api.basemap('wayback', null, wayback), null);
});

test('coordinate CRS handles Dubai, southern UTM, zone edges and Norway/Svalbard without changing source points', () => {
  const api = moduleContext(), point = { lng: 55.36, lat: 25.25 };
  const before = JSON.stringify(point), utm = api.coordinates(point, 'EPSG:32640');
  assert.ok(Math.abs(utm.x - 334830.0639033043) < .001); assert.ok(Math.abs(utm.y - 2793638.8915492385) < .001);
  assert.equal(JSON.stringify(point), before); assert.match(utm.text, /40N/);
  const central = api.coordinates({ lng:57,lat:0 }, 'UTM'); assert.ok(Math.abs(central.x - 500000) < 1e-6); assert.equal(central.y, 0);
  const south = api.coordinates({ lng:151.2,lat:-33.86 }, 'UTM'); assert.equal(south.code, 'EPSG:32756'); assert.ok(south.y>0);
  assert.equal(api.coordinates({ lng:180,lat:0 }, 'UTM').code, 'EPSG:32660');
  assert.equal(api.coordinates({ lng:6,lat:60 }, 'UTM').code, 'EPSG:32632');
  assert.equal(api.coordinates({ lng:20,lat:78 }, 'UTM').code, 'EPSG:32633');
  assert.match(api.coordinates({ lng:0,lat:89 }, 'UTM').text, /Outside UTM/);
  assert.match(api.coordinates({ lng:0,lat:25 }, 'EPSG:32640').text, /Outside/);
  assert.throws(() => api.coordinates({ lng:NaN,lat:0 }), /Invalid/);
  assert.throws(() => api.coordinates(point, 'EPSG:9999'), /Unsupported/);
});

test('switching Esri basemaps reuses the tile layer without moving the map, changing checked dates or hydrating clips', async () => {
  const app = await setup(); await app.openClip(); const selected = app.groups[2].getLayers()[0]; selected.fire('click');
  await app.element('#bEdit').onclick(); app.map.setView([24.5,54.5],18);
  const before = app.snapshot(), dates = app.releaseRows().map(row => row.dataset.r);
  for (const id of ['imagery','topographic','streets','dark','wayback']) { app.element('#mapBasemap').value = id; app.element('#mapBasemap').onchange(); }
  assert.equal(app.tiles.length, 1); assert.equal(app.snapshot().requests, before.requests); assert.equal(app.snapshot().fits,before.fits);
  assert.equal(app.snapshot().geoJSON,before.geoJSON); assert.deepEqual(app.map.position,[24.5,54.5]); assert.equal(app.map.zoom,18);
  assert.equal(selected.editing.active,true); assert.deepEqual(app.releaseRows().map(row=>row.dataset.r),dates);
  assert.equal(app.context.GVApp.diagnostics().views.selected,true);
});

test('choosing the same Wayback release after live imagery activates history; repeated selection remains idempotent', async () => {
  const app = await setup(); app.element('#mapBasemap').value='imagery'; app.element('#mapBasemap').onchange();
  assert.match(app.tiles[0].url,/World_Imagery/); app.clickRelease(101); const count=app.tiles[0].updates.length;
  assert.match(app.tiles[0].url,/\/101\//); assert.equal(app.element('#mapBasemap').value,'wayback');
  app.clickRelease(101); assert.equal(app.tiles[0].updates.length,count);
});

test('saved live basemap survives metadata startup and coordinate choices never rewrite entities or export CRS', async () => {
  const saved=new Map([['gv_mapDisplay',JSON.stringify({basemap:'imagery',coordinates:'EPSG:3857'})]]);
  const app=await setup({savedMap:saved}); assert.match(app.tiles[0].url,/World_Imagery/);
  const before=app.snapshot(); app.element('#mapCoordinateCRS').value='EPSG:4326'; await app.element('#mapCoordinateCRS').onchange();
  assert.deepEqual(app.snapshot(),before); assert.equal(app.context.GVApp.diagnostics().mapDisplay.projection,'EPSG:3857');
});

test('late 3D dependency loading cannot create a viewer after returning to 2D or hiding the page', async () => {
  let finish;const gate=new Promise(resolve=>finish=resolve);let created=0;
  const api=moduleContext(); const scene=api.createScene({container:{},load:()=>gate});
  const pending=scene.open({center:{lat:25,lng:55},zoom:12},{}); scene.close();
  finish({Viewer:class {constructor(){created++}}}); await assert.rejects(pending,{name:'AbortError'});
  assert.equal(created,0); assert.equal(scene.diagnostics().active,false); assert.equal(scene.diagnostics().loading,false);
});

test('a failed 3D script leaves map and saved data usable and a later action can retry', async () => {
  const app=await setup({beforeBoot:context=>{context.GVMapView.createScene=()=>({
    open:async()=>{throw new Error('3D asset unavailable')},close:()=>null,diagnostics:()=>({active:false}),sync(){}
  })}});
  const before=app.snapshot();await app.element('#map3dToggle').onclick();
  assert.equal(app.context.GVApp.diagnostics().mapDisplay.mode,'2d');assert.deepEqual(app.snapshot(),before);
  assert.match(app.element('#mapModeStatus').textContent,/3D unavailable/);
});

test('map settings stay over the map and Escape closes them without invoking annotation shortcuts', async () => {
  const app=await setup();app.element('#mapOptionsToggle').onclick();assert.equal(app.element('#mapOptionsPanel').hidden,false);
  let stopped=false;app.element('#mapOptions').onkeydown({key:'Escape',stopPropagation(){stopped=true}});
  assert.equal(stopped,true);assert.equal(app.element('#mapOptionsPanel').hidden,true);
  assert.equal(app.context.document.activeElement,app.element('#mapOptionsToggle'));
});

test('a saved live Esri map does not wait for Wayback metadata and an unavailable historical choice keeps its real label', async () => {
  const saved=new Map([['gv_mapDisplay',JSON.stringify({basemap:'imagery'})]]);
  const app=await setup({savedMap:saved,getReleases:()=>new Promise(()=>{})});
  assert.equal(app.tiles.length,1);assert.match(app.tiles[0].url,/World_Imagery/);
  app.element('#mapBasemap').value='wayback';app.element('#mapBasemap').onchange();
  assert.equal(app.element('#mapBasemap').value,'imagery');assert.match(app.element('#hudRel').textContent,/latest/);
});

test('derived elevation metadata requests cancel; abandoned availability does not cause an unhandled rejection or affect a new provider', async () => {
  const C = require('cesium'), controller = new AbortController(), signals = [];
  const api = moduleContext({GVEngine:{requestJSON:async(url,options)=>{signals.push(options.signal);throw new DOMException('Cancelled','AbortError')}}});
  const resource = api.terrainResource(C,'https://terrain.test/ImageServer/',{signal:controller.signal,onAvailabilityFailure(){assert.fail('A retired provider must not change the current scene')}});
  const metadata = resource.getDerivedResource({queryParameters:{f:'pjson'}});
  controller.abort();await assert.rejects(metadata.fetchJson(),{name:'AbortError'});
  const availability = resource.getDerivedResource({url:'tilemap/6/0/0/64/64'});
  const retired = await availability.fetchJson();assert.equal(retired.data.length,4096);assert.ok([...retired.data].every(value=>value===0));
  assert.ok(signals.every(signal=>signal===controller.signal));
});

test('a live elevation availability failure retires its owner before resolving its abandoned grid', async () => {
  const C=require('cesium'),controller=new AbortController();let retired=0;
  const api=moduleContext({GVEngine:{requestJSON:async()=>{throw Error('Offline')}}});
  const resource=api.terrainResource(C,'https://terrain.test/ImageServer/',{signal:controller.signal,onAvailabilityFailure(){retired++;controller.abort()}});
  const data=await resource.getDerivedResource({url:'tilemap/5/0/0/32/32'}).fetchJson();
  assert.equal(retired,1);assert.equal(controller.signal.aborted,true);assert.equal(data.data.length,1024);
});

test('a partially constructed WebGL viewer cannot leave canvases behind on failure', async () => {
  const container={children:[],replaceChildren(){this.children=[]}};
  const C={EllipsoidTerrainProvider:class{},Viewer:class{constructor(){container.children.push('canvas');throw Error('WebGL unavailable')}}};
  const api=moduleContext({Cesium:C}),scene=api.createScene({container,load:async()=>C});
  await assert.rejects(scene.open({center:{lat:25,lng:55},zoom:12},{}),/WebGL unavailable/);
  assert.deepEqual(container.children,[]);assert.equal(scene.diagnostics().active,false);assert.equal(scene.diagnostics().loading,false);
});

test('an asynchronous 3D renderer failure returns to the existing 2D view without losing its result', async () => {
  let fail;const app=await setup({beforeBoot:context=>{context.GVMapView.createScene=options=>{
    fail=options.onFailure;return{open:async()=>true,close:()=>null,sync(){},diagnostics:()=>({active:false})};
  }}});
  await app.openClip();const before=app.snapshot();await app.element('#map3dToggle').onclick();fail(Error('Context lost'));await turn();
  assert.equal(app.context.GVApp.diagnostics().mapDisplay.mode,'2d');assert.deepEqual(app.snapshot(),before);
  assert.equal(app.context.GVApp.diagnostics().views.active,1);assert.match(app.element('#mapModeStatus').textContent,/Context lost/);
});

test('HTTP-200 Esri service errors are reported before SDK parsing and malformed availability retires the provider', async () => {
  const C=require('cesium'),controller=new AbortController();let retired=0;
  const api=moduleContext({GVEngine:{requestJSON:async url=>url.includes('/tilemap/')?{data:[]}:{error:{code:499,message:'Token required'}}}});
  const resource=api.terrainResource(C,'https://terrain.test/ImageServer/',{signal:controller.signal,onAvailabilityFailure(){retired++;controller.abort()}});
  await assert.rejects(resource.fetchJson(),{name:'EsriServiceError',code:499,message:'Token required'});
  const result=await resource.getDerivedResource({url:'tilemap/5/0/0/32/32'}).fetchJson();
  assert.equal(retired,1);assert.equal(controller.signal.aborted,true);assert.equal(result.data.length,1024);
});
