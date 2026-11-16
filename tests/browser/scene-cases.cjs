/* Native Esri controls + real Cesium/Proj4/Leaflet in an isolated profile.
 * Tiles are deterministic; service availability is verified separately.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
module.exports = async ({ page, evaluate, until, errors, on, result }) => {
  result.scene = {};
  const probe = result.scene;
  const live = process.argv.includes('--live-esri'); result.liveEsri = live;
  probe.startup = await evaluate("({cesium:Boolean(window.Cesium),proj4:Boolean(window.proj4),resources:performance.getEntriesByType('resource').map(r=>r.name),map:GVApp.diagnostics().mapDisplay})");
  assert.equal(probe.startup.cesium,false);assert.equal(probe.startup.proj4,false);
  const png = await evaluate("(()=>{const c=document.createElement('canvas');c.width=c.height=256;const g=c.getContext('2d');g.fillStyle='#305a96';g.fillRect(0,0,256,256);return c.toDataURL().split(',')[1]})()");
  on('Fetch.requestPaused', ({ requestId, request }) => {
    const terrain = request.url.includes('elevation3d.arcgis.com');
    page('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:terrain?'application/json':'image/png'},{name:'Access-Control-Allow-Origin',value:'*'}],body:terrain?Buffer.from(JSON.stringify({error:{code:499,message:'Fixture terrain unavailable'}})).toString('base64'):png}).catch(error=>errors.push(error.message));
  });
  if (!live) await page('Fetch.enable',{patterns:[{urlPattern:'https://server.arcgisonline.com/*'},{urlPattern:'https://elevation3d.arcgis.com/*'}]});
  await evaluate(`(() => {
    const ensure=GVEngine.ensureLibrary;GVEngine.ensureLibrary=async(name,...args)=>{await ensure(name,...args);
      if(name==='cesium'&&!window.__sceneWrapped){__sceneWrapped=true;const Native=Cesium,Viewer=new Proxy(Native.Viewer,{construct(Target,args){return window.__sceneViewer=new Target(...args)}});window.Cesium=new Proxy(Native,{get:(target,key)=>key==='Viewer'?Viewer:Reflect.get(target,key)})}};
    document.querySelector('#mapOptionsToggle').click();
    const base=document.querySelector('#mapBasemap');base.value='imagery';base.dispatchEvent(new Event('change'));
  })()`);
  probe.liveBase = await evaluate("({url:[...Object.values(__sceneMap._layers)].find(l=>l instanceof L.TileLayer)._url,position:__sceneMap.getCenter(),zoom:__sceneMap.getZoom(),map:GVApp.diagnostics().mapDisplay})");
  assert.match(probe.liveBase.url,/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/);
  await evaluate("document.querySelector('[data-tab=det]').click();document.querySelector('#runBtn').click()");
  await until("document.querySelector('#queueStatus').textContent==='Idle · 0/10 queued'&&document.querySelector('#resTable tbody tr[data-i]')");
  await evaluate("document.querySelector('#resTable tbody tr[data-i]').click()");
  await until("GVApp.diagnostics().views.active===1&&!GVApp.diagnostics().views.loading&&GVApp.diagnostics().views.imageLayers===1");
  probe.before = await evaluate("({position:__sceneMap.getCenter(),zoom:__sceneMap.getZoom(),map:GVApp.diagnostics().mapDisplay,memory:GVApp.diagnostics().memory})");
  assert.equal(probe.before.map.basemap,'wayback','Opening a dated clip restores its Wayback background');
  await evaluate("document.querySelector('#map3dToggle').click()");
  try { await until("GVApp.diagnostics().mapDisplay.mode==='3d'",45000); }
  catch(error) { throw Error(error.message+'; '+await evaluate("document.querySelector('#mapModeStatus').textContent")); }
  try { await until("GVApp.diagnostics().mapDisplay.scene.frames>=1&&__sceneViewer.entities.values.length>=2"); }
  catch(error) { throw Error(error.message+'; '+JSON.stringify(await evaluate("({scene:GVApp.diagnostics().mapDisplay,text:document.querySelector('#map3d').textContent})"))+'; '+errors.join('; ')); }
  probe.open = await evaluate("({scene:GVApp.diagnostics().mapDisplay.scene,crs:GVApp.diagnostics().mapDisplay.projection,gl:__sceneViewer.scene.context.webgl2,entities:__sceneViewer.entities.values.map(e=>e.id),memory:GVApp.diagnostics().memory})");
  assert.equal(probe.open.gl,true);assert.equal(probe.open.scene.image,true);assert.ok(probe.open.entities.includes('detection:0:0'));
  // Exercise the real tiled URL shape in both modes. The legacy Wayback fixture
  // is a repeated 1px data URI, not a 256px Cesium imagery service.
  await evaluate("document.querySelector('#mapBasemap').value='imagery';document.querySelector('#mapBasemap').dispatchEvent(new Event('change'))");
  // The custom display provider must use Web Mercator, otherwise its rows drift
  // relative to detections as the footprint gets larger.
  probe.imageProjection = await evaluate("__sceneViewer.imageryLayers.get(1).imageryProvider.tilingScheme.projection instanceof Cesium.WebMercatorProjection");
  assert.equal(probe.imageProjection,true);
  await evaluate("document.querySelector('#showImg').checked=false;document.querySelector('#showImg').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('GVApp.diagnostics().mapDisplay.scene.image'),false);
  await evaluate("document.querySelector('#showImg').checked=true;document.querySelector('#showImg').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('GVApp.diagnostics().mapDisplay.scene.image'),true);
  await evaluate("document.querySelector('#mapCoordinateCRS').value='EPSG:32640';document.querySelector('#mapCoordinateCRS').dispatchEvent(new Event('change'))");
  await until("Boolean(window.proj4)&&document.querySelector('#hudXY').textContent.includes('40N')");
  probe.coordinates = await evaluate("({text:document.querySelector('#hudXY').textContent,title:document.querySelector('#hudXY').title,projection:GVApp.diagnostics().mapDisplay.projection})");
  assert.equal(probe.coordinates.title,'EPSG:32640');assert.equal(probe.coordinates.projection,'EPSG:3857');
  await evaluate("document.querySelector('#mapTerrain').value='esri';document.querySelector('#mapTerrain').dispatchEvent(new Event('change'))");
  await until(live ? "document.querySelector('#mapModeStatus').textContent.includes('terrain enabled')" : "document.querySelector('#mapModeStatus').textContent.includes('elevation unavailable')");
  if (live) probe.terrain = await evaluate("(async()=>{const points=await Cesium.sampleTerrain(__sceneViewer.terrainProvider,6,[Cesium.Cartographic.fromDegrees(55.36,25.25)],true);return{height:points[0].height,provider:__sceneViewer.terrainProvider instanceof Cesium.ArcGISTiledElevationTerrainProvider}})()",45000);
  if (live) { assert.equal(probe.terrain.provider,true);assert.ok(Number.isFinite(probe.terrain.height)); }
  assert.equal(await evaluate("GVApp.diagnostics().mapDisplay.mode"),'3d');
  await evaluate("document.querySelector('#mapTerrain').value='ellipsoid';document.querySelector('#mapTerrain').dispatchEvent(new Event('change'))");
  await until('__sceneViewer.scene.globe.tilesLoaded');
  // Select an actual rendered polygon with a native pointer event.
  await until(`(()=>{const v=__sceneViewer,C=Cesium,e=v.entities.getById('detection:0:0');if(!e)return false;
    const center=C.Ellipsoid.WGS84.scaleToGeodeticSurface(C.BoundingSphere.fromPoints(e.polygon.hierarchy.getValue().positions).center);
    const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,center);return p&&v.scene.pick(p)?.id?.id==='detection:0:0'})()`);
  const point = await evaluate(`(()=>{
    const v=__sceneViewer,C=Cesium,e=v.entities.getById('detection:0:0'),points=e.polygon.hierarchy.getValue().positions;
    const center=C.Ellipsoid.WGS84.scaleToGeodeticSurface(C.BoundingSphere.fromPoints(points).center);
    const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,center),r=v.canvas.getBoundingClientRect();return{x:p.x+r.left,y:p.y+r.top};
  })()`);
  await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
  await page('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  try { await until("document.querySelector('#selCard').textContent.includes('aircraft')",10000); }
  catch(error) { throw Error(error.message+'; '+JSON.stringify(await evaluate(`(()=>{const v=__sceneViewer,C=Cesium,e=v.entities.getById('detection:0:0'),center=C.Ellipsoid.WGS84.scaleToGeodeticSurface(C.BoundingSphere.fromPoints(e.polygon.hierarchy.getValue().positions).center),p=C.SceneTransforms.worldToWindowCoordinates(v.scene,center);return{point:${JSON.stringify(point)},currentPoint:p,canvas:v.canvas.getBoundingClientRect().toJSON(),hit:v.scene.pick(p)?.id?.id,target:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,500),map:GVApp.diagnostics().mapDisplay,status:document.querySelector('#mapModeStatus').textContent,selected:document.querySelector('#selCard').textContent}})()`))+'; '+errors.join('; ')); }
  probe.picking = await evaluate("({text:document.querySelector('#selCard').textContent,mode:GVApp.diagnostics().mapDisplay.mode})");
  assert.equal(probe.picking.mode,'3d');
  await evaluate("document.querySelector('#mapOptionsToggle').click()");
  const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'gmd-esri-globe.png'),Buffer.from(shot.data,'base64'));
  await evaluate("document.querySelector('#bEdit').click()");
  await until("GVApp.diagnostics().mapDisplay.mode==='2d'&&GVApp.diagnostics().views.editing");
  probe.editReturn = await evaluate("({position:__sceneMap.getCenter(),zoom:__sceneMap.getZoom(),scene:GVApp.diagnostics().mapDisplay.scene,destroyed:__sceneViewer.isDestroyed()})");
  assert.equal(probe.editReturn.destroyed,true);assert.deepEqual(probe.editReturn.position,probe.before.position);assert.equal(probe.editReturn.zoom,probe.before.zoom);
  for (let i=0;i<3;i++) { await evaluate("document.querySelector('#map3dToggle').click()");await until("GVApp.diagnostics().mapDisplay.mode==='3d'");await evaluate("document.querySelector('#map2d').click()"); }
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("if(document.querySelector('#mapOptionsPanel').hidden)document.querySelector('#mapOptionsToggle').click()");
  probe.mobile = await evaluate("({viewport:innerWidth,width:document.documentElement.scrollWidth,panel:document.querySelector('#mapOptionsPanel').getBoundingClientRect().toJSON(),search:document.querySelector('#mapSearch').getBoundingClientRect().toJSON(),controls:document.querySelector('#mapOptions').getBoundingClientRect().toJSON()})");
  assert.ok(probe.mobile.width<=probe.mobile.viewport);assert.ok(probe.mobile.panel.left>=0);assert.ok(probe.mobile.panel.right<=probe.mobile.viewport);
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  probe.final = await evaluate("({scene:GVApp.diagnostics().mapDisplay.scene,mode:GVApp.diagnostics().mapDisplay.mode,memory:GVApp.diagnostics().memory,canvases:document.querySelectorAll('#map3d canvas').length,webglErrors:window.__sceneErrors||[]})");
  assert.equal(probe.final.scene.created,probe.final.scene.destroyed);assert.equal(probe.final.scene.urlsCreated,probe.final.scene.urlsRevoked);
  assert.equal(probe.final.scene.active,false);assert.equal(probe.final.canvases,0);
  assert.equal(Object.keys(probe.final.memory.protected).some(key=>key.startsWith('3d-')||key==='display:3d-image'),false);
  assert.deepEqual(errors,[]);
};
