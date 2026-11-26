/* Directory Files: real upload/ingestion and native Cesium raster/vector layers. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
if(!process.argv.includes('--scene'))process.argv.push('--scene');
const {withChrome}=require('./chrome.cjs');
const url=process.env.GMD_UPLOAD_URL||'http://localhost:8095/';
withChrome(async({page,evaluate,until,errors,on})=>{
  for(const name of ['index.html','app.js','uploads.js','map-view.js']){
    const response=await fetch(new URL(name,url));assert.equal(response.status,200);
    assert.equal(await response.text(),fs.readFileSync(path.join(__dirname,'../../frontend',name),'utf8'),`current ${name}`);
  }
  const requests=[];on('Network.requestWillBeSent',event=>requests.push(event.request.url));
  await page('Page.navigate',{url});
  await until('window.GVApp && document.querySelector("#storageStatus").textContent.includes("Saved on this device")');
  const aoiBefore=await evaluate('document.querySelector("#aoiList").children.length');
  assert.equal(requests.some(value=>value.includes('/uploads.js')||value.includes('/api/directories')),false);
  await evaluate(`(()=>{const ensure=GVEngine.ensureLibrary;GVEngine.ensureLibrary=async(name,...args)=>{await ensure(name,...args);if(name==='cesium'&&!window.__directoryWrapped){__directoryWrapped=true;const native=Cesium,viewer=new Proxy(native.Viewer,{construct(Target,args){return window.__directoryViewer=new Target(...args)}});window.Cesium=new Proxy(native,{get:(target,key)=>key==='Viewer'?viewer:Reflect.get(target,key)})}};document.querySelector('[data-tab=files]').click();document.querySelector('[data-tab=files]').click()})()`);
  await until('document.querySelector("#filesStatus").textContent.startsWith("Connected")');
  assert.equal(await evaluate('Boolean(document.querySelector("#filesApi")||document.querySelector("#filesConnect")||document.querySelector("[data-action=aois]"))'),false);
  assert.equal(await evaluate('document.querySelector("#uploadFile").accept.includes(".ecw") && document.querySelector("#uploadFile").accept.includes(".mp4")'),true);
  const folderName='Native directory '+Date.now();
  await evaluate(`document.querySelector('#directoryName').value=${JSON.stringify(folderName)};document.querySelector('#directoryNew').click()`);
  const folderButton=`Array.from(document.querySelectorAll('#directoryChildren [data-directory]')).find(button=>button.textContent.includes(${JSON.stringify(folderName)}))`;
  await until(`Boolean(${folderButton})`);
  const folderId=await evaluate(`(${folderButton}).dataset.directory`);
  await evaluate(`(${folderButton}).click()`);
  await until(`document.querySelector('#uploadDirectory').textContent.includes(${JSON.stringify(folderName)})`);
  const upload=async(name,encoded,type)=>{
    await evaluate(`(()=>{const data=new DataTransfer(),input=document.querySelector('#uploadFile');data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:${JSON.stringify(type)}}));input.files=data.files;input.dispatchEvent(new Event('change'));document.querySelector('#uploadStart').click()})()`);
    await until('document.querySelector("#uploadStatus").textContent.startsWith("Upload complete")',60000);
    const row=`Array.from(document.querySelectorAll('[data-upload]')).find(row=>row.textContent.includes(${JSON.stringify(name)}))`;
    await until(`Boolean((${row})?.querySelector('[data-action=download]'))`,240000);
    return row;
  };
  const name='native-vector-'+Date.now()+'.geojson',fc={type:'FeatureCollection',features:[
    {type:'Feature',properties:{name:'File point'},geometry:{type:'Point',coordinates:[55.36,25.25]}},
    {type:'Feature',properties:{name:'File line'},geometry:{type:'LineString',coordinates:[[55.35,25.24],[55.37,25.26]]}},
    {type:'Feature',properties:{name:'File polygon'},geometry:{type:'Polygon',coordinates:[[[55.35,25.24],[55.37,25.24],[55.37,25.26],[55.35,25.24]]]}}
  ]};
  const row=await upload(name,Buffer.from(JSON.stringify(fc)).toString('base64'),'application/geo+json');
  // Controlled base tiles avoid provider-network timing; uploaded layer bytes are real.
  const png=await evaluate("(()=>{const c=document.createElement('canvas');c.width=c.height=256;const g=c.getContext('2d');g.fillStyle='#244d65';g.fillRect(0,0,256,256);return c.toDataURL().split(',')[1]})()");
  on('Fetch.requestPaused',({requestId})=>{page('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Access-Control-Allow-Origin',value:'*'}],body:png}).catch(error=>errors.push(error.message));});
  await page('Fetch.enable',{patterns:[{urlPattern:'https://server.arcgisonline.com/*'}]});
  await evaluate("document.querySelector('#mapBasemap').value='imagery';document.querySelector('#mapBasemap').dispatchEvent(new Event('change'))");
  await evaluate(`(${row}).querySelector('[data-action=globe]').click()`);
  await until("GVApp.diagnostics().mapDisplay.mode==='3d' && GVApp.diagnostics().mapDisplay.scene.fileEntities===3",60000);
  assert.equal(await evaluate('document.querySelector("#aoiList").children.length'),aoiBefore);
  assert.equal(await evaluate('__directoryViewer.dataSources.length'),1);
  let raster=false;
  if(process.env.GMD_UPLOAD_RASTER){
    const rasterName='native-raster-'+Date.now()+'.tif',rasterRow=await upload(rasterName,fs.readFileSync(process.env.GMD_UPLOAD_RASTER).toString('base64'),'image/tiff');
    await evaluate(`(${rasterRow}).querySelector('[data-toggle]').click()`);
    await until('GVApp.diagnostics().mapDisplay.scene.fileRasters===1 && GVApp.diagnostics().mapDisplay.scene.fileVectors===1');
    const projection=await evaluate('__directoryViewer.imageryLayers.get(1).imageryProvider.tilingScheme.projection instanceof Cesium.WebMercatorProjection');assert.equal(projection,true);
    await evaluate("(()=>{const layer=Array.from(document.querySelectorAll('#directoryActive [data-layer]')).find(node=>node.textContent.includes('raster'));const opacity=layer.querySelector('[data-opacity]');opacity.value='35';opacity.dispatchEvent(new Event('change'))})()");
    assert.equal(await evaluate('__directoryViewer.imageryLayers.get(1).alpha'),.35);
    raster=true;
  }
  await evaluate("(()=>{const node=Array.from(document.querySelectorAll('#directoryActive [data-layer]')).find(node=>node.textContent.includes('vector'));node.querySelector('[data-visible]').click()})()");
  assert.equal(await evaluate('__directoryViewer.dataSources.get(0).show'),false);
  await evaluate("document.querySelector('[data-tab=aoi]').click();document.querySelector('[data-tab=files]').click()");
  assert.equal(await evaluate('GVApp.diagnostics().mapDisplay.mode'),'3d');
  await evaluate("document.querySelector('#map2d').click()");
  await until("GVApp.diagnostics().mapDisplay.mode==='2d'");
  if(raster)await until("Array.from(document.querySelectorAll('.leaflet-image-layer')).some(image=>image.complete&&image.naturalWidth>0)");
  await evaluate("document.querySelector('#map3dToggle').click()");
  await until("GVApp.diagnostics().mapDisplay.mode==='3d' && GVApp.diagnostics().mapDisplay.scene.fileVectors===1");
  if(raster)assert.equal(await evaluate('GVApp.diagnostics().mapDisplay.scene.fileRasters'),1);
  await evaluate("Array.from(document.querySelectorAll('#directoryActive [data-layer]')).find(node=>node.textContent.includes('vector')).querySelector('[data-visible]').click()");
  await until(`(()=>{const v=__directoryViewer,C=Cesium,e=v.dataSources.get(0)?.entities.values.find(e=>e.point);if(!e)return false;const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,e.position.getValue(v.clock.currentTime));return p&&v.scene.pick(p)?.id?.properties?.kind?.getValue()==='file'})()`,45000);
  const scene=await evaluate('GVApp.diagnostics().mapDisplay.scene');
  if(process.env.GMD_UPLOAD_DESKTOP_SCREENSHOT){const image=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.GMD_UPLOAD_DESKTOP_SCREENSHOT,Buffer.from(image.data,'base64'));}
  await evaluate("document.querySelector('#filesClearMap').click()");
  await until('GVApp.diagnostics().mapDisplay.scene.fileLayers===0 && GVApp.diagnostics().directory.loaded===0');
  const clean=await evaluate('GVApp.diagnostics().mapDisplay.scene');assert.equal(clean.urlsCreated,clean.urlsRevoked);
  const picture='native-photo-'+Date.now()+'.png',photoRow=await upload(picture,png,'image/png');
  assert.equal(await evaluate(`Boolean((${photoRow}).querySelector('[data-toggle]'))`),false);
  assert.match(await evaluate(`(${photoRow}).textContent`),/No map location/);
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  if(process.env.GMD_UPLOAD_SCREENSHOT){const image=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.GMD_UPLOAD_SCREENSHOT,Buffer.from(image.data,'base64'));}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,directory:folderId,vectorFile:name,raster,unlocatedImage:true,noConnectControl:true,aoiCountUnchanged:true,lazy:true,multipleLayers:scene.fileLayers,globeEntities:scene.fileEntities,gpuFilePick:true,mercatorPreview:raster,hideOpacityAndModeSwitch:true,cleanResources:clean.urlsCreated===clean.urlsRevoked,runtimeErrors:errors},null,2));
}).catch(error=>{console.error(error);process.exitCode=1;});
