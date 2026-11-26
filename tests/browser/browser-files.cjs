/* Static Pages project path: real IndexedDB, disposable GIS workers and Cesium. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.argv.includes('--scene'))process.argv.push('--scene');
const {withChrome}=require('./chrome.cjs');
const root=path.resolve(__dirname,'../..'),prefix='/GeoMap-Detector/',apiRequests=[],held=[];let holdRuntime=false;
const mime=file=>file.endsWith('.js')?'application/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.json')?'application/json':file.endsWith('.html')?'text/html':'application/octet-stream';
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://local');if(url.pathname.startsWith('/api/'))apiRequests.push(url.pathname);
 if(!url.pathname.startsWith(prefix)){res.writeHead(404);return res.end();}
 const name=decodeURIComponent(url.pathname.slice(prefix.length))||'index.html';if(name==='ingestion-config.json'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({mode:'browser',api_url:''}));}
 if(holdRuntime&&name.includes('gdal3WebAssembly.')){held.push(res);return;}
 const file=name.startsWith('vendor/Cesium/')?path.resolve(root,'node_modules/cesium/Build/Cesium',name.slice('vendor/Cesium/'.length)):path.resolve(root,'frontend',name);
 if(!file.startsWith(root+'/frontend/')&&!file.startsWith(root+'/node_modules/cesium/Build/Cesium/')){res.writeHead(404);return res.end();}
 fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'Content-Type':mime(file),'Cache-Control':'no-cache'});res.end(error?'missing':data);});
});
function geotiff(){
 const b=Buffer.alloc(1024);b.write('II');b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);
 const tags=[[256,4,[2]],[257,4,[2]],[258,3,[8,8,8]],[259,3,[1]],[262,3,[2]],[273,4,[0]],[277,3,[3]],[278,4,[2]],[279,4,[12]],[284,3,[1]],[33550,12,[.01,.01,0]],[33922,12,[0,0,0,55.35,25.26,0]],[34735,3,[1,1,0,3,1024,0,1,2,1025,0,1,1,2048,0,1,4326]]];
 b.writeUInt16LE(tags.length,8);let next=8+2+12*tags.length+4;
 for(let i=0;i<tags.length;i++){const [tag,type,values]=tags[i],off=10+i*12,size=type===3?2:type===4?4:8;b.writeUInt16LE(tag,off);b.writeUInt16LE(type,off+2);b.writeUInt32LE(values.length,off+4);let target=off+8;if(values.length*size>4){next=Math.ceil(next/8)*8;target=next;b.writeUInt32LE(target,off+8);next+=values.length*size;}values.forEach((value,n)=>type===3?b.writeUInt16LE(value,target+n*size):type===4?b.writeUInt32LE(value,target+n*size):b.writeDoubleLE(value,target+n*size));}
 const strip=10+tags.findIndex(t=>t[0]===273)*12+8;b.writeUInt32LE(next,strip);Buffer.from([230,10,20,20,230,10,10,20,230,200,200,30]).copy(b,next);return b.subarray(0,next+12);
}
function shapeZip(){
 const shape=Buffer.alloc(128),index=Buffer.alloc(108);for(const b of [shape,index]){b.writeInt32BE(9994,0);b.writeInt32BE(b.length/2,24);b.writeInt32LE(1000,28);b.writeInt32LE(1,32);b.writeDoubleLE(55.36,36);b.writeDoubleLE(25.25,44);b.writeDoubleLE(55.36,52);b.writeDoubleLE(25.25,60);}shape.writeInt32BE(1,100);shape.writeInt32BE(10,104);shape.writeInt32LE(1,108);shape.writeDoubleLE(55.36,112);shape.writeDoubleLE(25.25,120);index.writeInt32BE(50,100);index.writeInt32BE(10,104);
 const dbf=Buffer.alloc(77);dbf[0]=3;dbf.writeUInt32LE(1,4);dbf.writeUInt16LE(65,8);dbf.writeUInt16LE(11,10);dbf.write('name',32);dbf[43]=67;dbf[48]=10;dbf[64]=13;dbf.write(' DXB       ',65);dbf[76]=26;
 const wkt='GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
 return require('fflate').zipSync({'folder/points.shp':shape,'folder/points.shx':index,'folder/points.dbf':dbf,'folder/points.prj':Buffer.from(wkt)});
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await withChrome(async({page,evaluate,until,on,errors})=>{
  const origin='http://127.0.0.1:'+server.address().port,url=origin+prefix,requests=[],fixtures=[];
  const fulfill=(id,body,type)=>page('Fetch.fulfillRequest',{requestId:id,responseCode:200,responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:'*'}],body:Buffer.from(body).toString('base64')});
  on('Fetch.requestPaused',event=>{(async()=>{const address=event.request.url;
   if(address.startsWith(origin))return page('Fetch.continueRequest',{requestId:event.requestId});
   if(address.includes('waybackconfig.json'))return fulfill(event.requestId,JSON.stringify({101:{itemTitle:'World Imagery (Wayback 2026-10-29)'}}),'application/json');
   const match=address.match(/leaflet@1\.9\.4\/dist\/(leaflet\.(?:js|css))$/);if(match)return fulfill(event.requestId,fs.readFileSync(require.resolve('leaflet/dist/'+match[1])),mime(match[1]));
   if(address.includes('/cesium@1.147.0/Build/Cesium/')){const name=address.split('/Build/Cesium/')[1];return fulfill(event.requestId,fs.readFileSync(path.join(root,'node_modules/cesium/Build/Cesium',name)),mime(name));}
   if(event.resourceType==='Image'||address.includes('/MapServer/tile/'))return fulfill(event.requestId,Buffer.from('R0lGODlhAQABAP///wAAACwAAAAAAQABAAACAkQBADs=','base64'),'image/gif');
   if(event.resourceType==='Stylesheet')return fulfill(event.requestId,'','text/css');
   throw Error('Unexpected fixture request '+address);
  })().catch(error=>{fixtures.push(error.message);page('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'}).catch(()=>{});});});
  on('Network.requestWillBeSent',event=>requests.push(event.request.url));
  await page('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await page('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'CESIUM_BASE_URL',{configurable:true,get:()=>${JSON.stringify(url+'vendor/Cesium/')},set:()=>{}});`});
  await page('Page.navigate',{url});await until('window.GVApp&&GVEngine.diagnostics().startup.appReady!=null');
  const initialRequests=requests.length;assert.equal(requests.some(v=>v.includes('gdal3')),false);
  await evaluate("document.querySelector('[data-tab=files]').click()");await until("document.querySelector('#filesStatus').textContent.startsWith('Saved in this browser')");
  assert.equal(await evaluate('document.querySelector("#uploadStart").textContent'),'Add and process');
  const aoiCount=await evaluate('document.querySelector("#aoiList").children.length');
  await evaluate("document.querySelector('#directoryName').value='Browser GIS';document.querySelector('#directoryNew').click()");await until("Array.from(document.querySelectorAll('#directoryChildren button')).some(b=>b.textContent.includes('Browser GIS'))");
  await evaluate("Array.from(document.querySelectorAll('#directoryChildren button')).find(b=>b.textContent.includes('Browser GIS')).click()");
  const row=name=>`Array.from(document.querySelectorAll('[data-upload]')).find(r=>r.querySelector('strong')?.textContent===${JSON.stringify(name)})`;
  async function select(name,bytes,type='application/octet-stream'){
   await evaluate(`(()=>{const data=new DataTransfer(),input=document.querySelector('#uploadFile');data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:${JSON.stringify(type)}}));input.files=data.files;input.dispatchEvent(new Event('change'));document.querySelector('#uploadStart').click()})()`);
  }
  async function add(name,bytes,type){await select(name,bytes,type);await until(`Boolean((${row(name)})?.querySelector('[data-action=download], [data-action=retry]'))`,180000);assert.equal(await evaluate(`Boolean((${row(name)}).querySelector('[data-action=download]'))`),true,await evaluate(`(${row(name)}).textContent`));return row(name);}
  const fc={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Point'},geometry:{type:'Point',coordinates:[55.36,25.25]}},{type:'Feature',properties:{name:'Line'},geometry:{type:'LineString',coordinates:[[55.35,25.24],[55.37,25.26]]}},{type:'Feature',properties:{name:'Polygon'},geometry:{type:'Polygon',coordinates:[[[55.35,25.24],[55.37,25.24],[55.37,25.26],[55.35,25.24]]]}}]};
  const vector=await add('browser-vector.geojson',JSON.stringify(fc),'application/geo+json');assert.equal(requests.some(v=>v.includes('gdal3')),false);
  await evaluate(`(${vector}).querySelector('[data-toggle]').click()`);await until("GVApp.diagnostics().mapDisplay.mode==='3d'&&GVApp.diagnostics().mapDisplay.scene.fileEntities===3",60000);
  const zipped=await add('browser-shape.zip',shapeZip());await evaluate(`(${zipped}).querySelector('[data-toggle]').click()`);await until('GVApp.diagnostics().mapDisplay.scene.fileEntities===4');await evaluate(`(${zipped}).querySelector('[data-action=remove-file]').click()`);await until('GVApp.diagnostics().mapDisplay.scene.fileEntities===3');
  const unsafe=require('fflate').zipSync({'../escape.geojson':Buffer.from(JSON.stringify(fc))});await select('unsafe.zip',unsafe);await until(`Boolean((${row('unsafe.zip')})?.querySelector('[data-action=retry]'))`);assert.match(await evaluate(`(${row('unsafe.zip')}).textContent`),/unsafe file path/);await evaluate(`(${row('unsafe.zip')}).querySelector('[data-action=remove-file]').click()`);await until(`!(${row('unsafe.zip')})`);
  holdRuntime=true;await select('browser-raster.tif',geotiff(),'image/tiff');await until("document.querySelector('#uploadStatus').textContent.includes('Loading GIS tools')");await evaluate("document.querySelector('#uploadPause').click()");
  await until(`Boolean((${row('browser-raster.tif')})?.querySelector('[data-action=retry]'))`);holdRuntime=false;for(const response of held.splice(0))response.destroy();
  await evaluate(`(${row('browser-raster.tif')}).querySelector('[data-action=retry]').click()`);await until(`Boolean((${row('browser-raster.tif')})?.querySelector('[data-action=download]'))`,180000);
  await evaluate(`(${row('browser-raster.tif')}).querySelector('[data-toggle]').click()`);await until('GVApp.diagnostics().mapDisplay.scene.fileRasters===1&&GVApp.diagnostics().mapDisplay.scene.fileVectors===1');
  assert.equal(await evaluate('GVApp.diagnostics().mapDisplay.scene.fileEntities'),3);
  const layerCount=await evaluate('GVApp.diagnostics().directory.loaded');assert.equal(layerCount,2);
  await evaluate("document.querySelector('#filesClearMap').click()");await until('GVApp.diagnostics().mapDisplay.scene.fileLayers===0');
  const record=await evaluate("GVApp.diagnostics().mapDisplay.scene");assert.equal(record.urlsCreated,record.urlsRevoked);
  await add('requires-native.ecw','original ECW bytes');assert.equal(await evaluate(`Boolean((${row('requires-native.ecw')}).querySelector('[data-toggle]'))`),false);assert.match(await evaluate(`(${row('requires-native.ecw')}).textContent`),/native decoder/);
  await select('invalid.csv','lat,lon\n999,55\n','text/csv');await until(`Boolean((${row('invalid.csv')})?.querySelector('[data-action=retry]'))`);assert.match(await evaluate(`(${row('invalid.csv')}).textContent`),/longitude/);
  const saved=await evaluate('document.querySelectorAll("[data-upload]").length');assert.equal(saved,4);
  const completedWorkers=await evaluate('GVApp.diagnostics().directory.workers');assert.equal(completedWorkers.active,0);assert.ok(completedWorkers.created>=7);assert.equal(completedWorkers.created,completedWorkers.terminated);
  await evaluate(`(${row('browser-vector.geojson')}).querySelector('[data-action=globe]').click();(${row('browser-raster.tif')}).querySelector('[data-action=globe]').click()`);await until('GVApp.diagnostics().mapDisplay.scene.fileRasters===1&&GVApp.diagnostics().mapDisplay.scene.fileVectors===1');
  if(process.env.GMD_BROWSER_FILES_DESKTOP_SCREENSHOT){const image=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.GMD_BROWSER_FILES_DESKTOP_SCREENSHOT,Buffer.from(image.data,'base64'));}
  await page('Page.reload',{});await until("document.querySelector('#filesStatus')?.textContent.startsWith('Saved in this browser')");await until('document.querySelectorAll("[data-upload]").length===4');
  await until('GVApp.diagnostics().directory.loaded===2',60000);
  await evaluate("document.querySelector('#map3dToggle').click()");await until('GVApp.diagnostics().mapDisplay.scene.fileEntities===3&&GVApp.diagnostics().mapDisplay.scene.fileRasters===1',60000);
  assert.equal(await evaluate('document.querySelector("#aoiList").children.length'),aoiCount);
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  if(process.env.GMD_BROWSER_FILES_SCREENSHOT){const image=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.GMD_BROWSER_FILES_SCREENSHOT,Buffer.from(image.data,'base64'));}
  await evaluate(`(${row('requires-native.ecw')}).querySelector('[data-action=remove-file]').click()`);await until('document.querySelectorAll("[data-upload]").length===3');
  const worker=await evaluate('GVApp.diagnostics().directory.workers');assert.equal(worker.active,0);assert.equal(worker.created,worker.terminated);
  assert.equal(apiRequests.some(v=>/ingestion|uploads|directories/.test(v)),false);assert.deepEqual(errors,[]);assert.deepEqual(fixtures,[]);
  console.log(JSON.stringify({ok:true,mode:'static browser',projectPath:prefix,filesPersisted:saved,vectorEntities:3,raster:true,zippedShapefile:true,unsafeArchive:true,layers:layerCount,cancelAndRetry:true,unsupportedOriginalPreserved:true,invalidCsv:true,reload:true,restoredLayers:true,delete:true,aoiUnchanged:true,nativeIndexedDB:true,workers:completedWorkers,workersAfterReload:worker,apiRequests:apiRequests.filter(v=>/ingestion|uploads|directories/.test(v)),runtimeErrors:errors,initialRequests}));
 });}finally{server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
