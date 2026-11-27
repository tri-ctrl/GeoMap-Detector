/* One disposable worker per browser ingestion. No file bytes leave this worker/device. */
'use strict';
importScripts('file-geometry.js','tiff-codec.js');
const MAX_FILE=128*1048576,MAX_VECTOR=20*1048576,MAX_EXPANDED=256*1048576;
const GDAL_VERSION='2.8.1',FFLATE_VERSION='0.8.3';
const GEOTIFF_VERSION='3.0.5';
let runtime,sequence=0,artifactBytes=0;
const progress=(message,value)=>postMessage({type:'progress',message,value});
const suffix=name=>'.'+name.split('.').at(-1).toLowerCase();
const stem=name=>name.replace(/\.[^.]+$/,'');
async function gdal(){
 if(!runtime){progress('Loading GIS tools for this browser…',20);importScripts('vendor/ingestion/gdal3.js?v='+GDAL_VERSION);self.onmessage=null;
  runtime=initGdalJs({path:new URL('vendor/ingestion/',location.href).href,paths:{wasm:'gdal3WebAssembly.wasm?v='+GDAL_VERSION,data:'gdal3WebAssembly.data?v='+GDAL_VERSION},useWorker:false,env:{GDAL_CACHEMAX:'64',GDAL_NUM_THREADS:'1'},logHandler:()=>{},errorHandler:()=>{}});}
 return runtime;
}
function blobArtifact(role,blob){artifactBytes+=blob.size;if(artifactBytes>256*1048576)throw Error('Processed files exceed the 256 MiB artifact limit.');return {role,blob,media_type:blob.type||'application/octet-stream',size:blob.size};}
function vector(name,result,message){const blob=new Blob([JSON.stringify(result.fc)],{type:'application/geo+json'});if(blob.size>MAX_VECTOR)throw Error('Normalized vector exceeds the 20 MiB browser processing limit.');return {name,kind:'vector',bbox:result.bbox,feature_count:result.feature_count,message,artifacts:[blobArtifact('data',blob)]};}
function asset(file,message){const ext=suffix(file.name),kind=['.png','.jpg','.jpeg'].includes(ext)?'image':['.mp4','.mpg','.mpeg'].includes(ext)?'video':['.pdf','.xlsx'].includes(ext)?'document':['.las','.laz'].includes(ext)?'pointcloud':'package';return {name:file.name,kind,bbox:null,message:message||'Original saved in this browser. No geographic coordinates were extracted.',artifacts:[blobArtifact('data',file)]};}
function bounds(points){const box=[Infinity,Infinity,-Infinity,-Infinity];for(const p of points){if(!p||!Number.isFinite(p[0])||!Number.isFinite(p[1]))throw Error('Raster has invalid geographic coordinates.');box[0]=Math.min(box[0],p[0]);box[1]=Math.min(box[1],p[1]);box[2]=Math.max(box[2],p[0]);box[3]=Math.max(box[3],p[1]);}return box;}
async function raster(G,dataset,name,info,opened){
 if(!info.projectionWkt)throw Error('Raster has no CRS. Add georeferencing before displaying it on the globe.');
 if(info.width*info.height*info.bandCount*8>512*1048576||info.bandCount>32)throw Error('Decoded raster exceeds the 512 MiB browser processing budget. Use native ingestion for this file.');
 const edge=[];for(let i=0;i<4;i++){const a=info.corners[i],b=info.corners[(i+1)%4];for(let t=0;t<=21;t++)edge.push([a[0]+(b[0]-a[0])*t/21,a[1]+(b[1]-a[1])*t/21]);}
 const box=bounds(await G.gdaltransform(edge,['-s_srs',info.projectionWkt,'-t_srs','EPSG:4326','-output_xy']));
 const [w,s,e,n]=box;if(w< -180||e>180||s< -85||n>85||w>=e||s>=n||e-w>180)throw Error('Raster footprint is outside supported Web Mercator bounds.');
 const merc=(lon,lat)=>[6378137*lon*Math.PI/180,6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
 const [x0,y0]=merc(w,s),[x1,y1]=merc(e,n),scale=2048/Math.max(x1-x0,y1-y0),width=Math.max(1,Math.round((x1-x0)*scale)),height=Math.max(1,Math.round((y1-y0)*scale));
 const detail=dataset.info||await G.gdalinfo(dataset),bands=detail.bands||[],alpha=bands.find(b=>b.colorInterpretation==='Alpha')?.band;
 const selected=info.bandCount>=3?[1,2,3]:[1];if(alpha&&!selected.includes(alpha))selected.push(alpha);
 const palette=bands[0]?.colorInterpretation==='Palette';
 const selection=['-of','VRT',...(palette?['-b','1','-expand','rgba']:selected.flatMap(b=>['-b',String(b)]))];
 const source=await G.gdal_translate(dataset,selection,'selected-'+sequence++);
 const virtual=(await G.open(source.local)).datasets[0];opened.push(virtual);
 progress('Reprojecting raster preview…',50);
 const warped=await G.gdalwarp(virtual,['-of','GTiff','-t_srs','EPSG:3857','-te',...[x0,y0,x1,y1].map(String),'-ts',String(width),String(height),'-r','bilinear','-dstalpha','-wm','64'],'preview-warp-'+sequence++);
 const projected=(await G.open(warped.local)).datasets[0];opened.push(projected);
 const nonByte=bands.some(b=>selected.includes(b.band)&&b.band!==alpha&&b.type!=='Byte');
 const png=await G.gdal_translate(projected,['-of','PNG','-ot','Byte',...(nonByte?['-scale']:[])],'preview-'+sequence++);
 const preview=new Blob([await G.getFileBytes(png)],{type:'image/png'});
 progress('Creating georeferenced raster output…',70);
 const output=await G.gdal_translate(dataset,['-of','COG','-co','COMPRESS=DEFLATE'],'layer-'+sequence++),bytes=await G.getFileBytes(output);
 if(bytes.length>MAX_FILE)throw Error('Converted raster exceeds the 128 MiB browser file limit.');
 return {name,kind:'raster',bbox:box,preview_crs:'EPSG:3857',artifacts:[blobArtifact('data',new Blob([bytes],{type:'image/tiff'})),blobArtifact('preview',preview)]};
}
async function spatial(file,siblings){
 let inputs=siblings||[new File([file],'input'+suffix(file.name))];
 if(!siblings&&['.tif','.tiff'].includes(suffix(file.name)))inputs=[await GVFileTIFF.compatible(inputs[0],{progress,loadDecoder:async()=>{importScripts('vendor/ingestion/geotiff.js?v='+GEOTIFF_VERSION);return GeoTIFF;}})];
 const G=await gdal(),opened=[];
 try{
  const result=await G.open(inputs),layers=[];if(result.datasets.length>20)throw Error('File contains more than 20 datasets.');
  for(const dataset of result.datasets){opened.push(dataset);const info=await G.getInfo(dataset);
   if(info.type==='raster'){
    let source=dataset,geometry=info;
    if(!geometry.projectionWkt){const detail=dataset.info||await G.gdalinfo(dataset),gcps=detail.gcps;
     if(gcps?.coordinateSystem?.wkt&&gcps.gcpList?.length>=3){
      if(gcps.gcpList.length>2048||gcps.gcpList.some(g=>![g.pixel,g.line,g.x,g.y].every(Number.isFinite)))throw Error('Raster ground control points exceed browser limits or contain invalid coordinates.');
      progress('Georeferencing raster from ground control points…',35);
      const warped=await G.gdalwarp(dataset,['-of','VRT','-t_srs','EPSG:4326','-tps','-dstalpha','-wm','64'],'georeferenced-'+sequence++);
      source=(await G.open(warped.local)).datasets[0];opened.push(source);geometry=await G.getInfo(source);
     }
    }
    layers.push(await raster(G,source,file.name,geometry,opened));continue;
   }
   if(info.layers.length>20||info.featureCount>100000)throw Error('Vector exceeds the 20-layer / 100,000-feature processing limit.');
   for(const layer of info.layers){if(layer.featureCount===0)continue;
    const spreadsheet=suffix(file.name)==='.xlsx';
    const output=await G.ogr2ogr(dataset,['-f','GeoJSON',...(spreadsheet?[]:['-t_srs','EPSG:4326']),'-limit','100001',layer.name],'vector-'+sequence++);
    const bytes=await G.getFileBytes(output);if(bytes.length>MAX_VECTOR)throw Error('Normalized vector exceeds the 20 MiB browser processing limit.');
    let data=JSON.parse(new TextDecoder().decode(bytes));
    if(spreadsheet&&!data.features.some(f=>f.geometry)){const features=[];for(const f of data.features){const p=f.properties||{},keys=Object.fromEntries(Object.keys(p).map(k=>[k.toLowerCase(),k]));if(p[keys.lat]!=null&&p[keys.lon]!=null&&String(p[keys.lat]).trim()&&String(p[keys.lon]).trim())features.push({type:'Feature',properties:p,geometry:{type:'Point',coordinates:[Number(p[keys.lon]),Number(p[keys.lat])]}});}if(!features.length)continue;data={type:'FeatureCollection',features};}
    layers.push(vector(info.layers.length>1?stem(file.name)+' · '+layer.name:stem(file.name),GVFileGeometry.normalize(data)));
   }
  }
  if(layers.length)return layers;
  if(suffix(file.name)==='.xlsx')return [asset(file,'Spreadsheet saved. No lat/lon columns were found for a map layer.')];
  throw Error('No geographic layers were found in this file.');
 }finally{for(const dataset of [...new Map(opened.map(d=>[d.pointer,d])).values()].reverse())await G.close(dataset);}
}
function safePath(name){const parts=name.split('/');if(!name||name.startsWith('/')||name.includes('\\')||parts.some(p=>['..','__proto__','constructor','prototype'].includes(p))||/^[a-z]:/i.test(name))throw Error('Archive contains an unsafe file path.');return name;}
function tar(bytes,budget){
 const files=[];for(let offset=0;offset+512<=bytes.length;){const header=bytes.subarray(offset,offset+512);if(header.every(v=>v===0))break;const str=(a,b)=>new TextDecoder().decode(header.subarray(a,b)).replace(/\0.*$/,'');let name=str(0,100);const prefix=str(345,500);if(prefix)name=prefix+'/'+name;safePath(name);const raw=str(124,136).trim();if(!/^[0-7]+$/.test(raw))throw Error('Invalid TAR size.');const size=parseInt(raw,8),type=str(156,157);if(!['','0','5'].includes(type))throw Error('TAR links and special entries are not supported.');if(offset+512+size>bytes.length)throw Error('Truncated TAR archive.');if(type!=='5'){budget.bytes+=size;budget.count++;if(budget.bytes>MAX_EXPANDED||budget.count>100)throw Error('Archive exceeds extraction limits.');files.push(new File([bytes.subarray(offset+512,offset+512+size)],name));}offset+=512+Math.ceil(size/512)*512;}return files;
}
async function archive(file,depth,budget){
 if(depth>=2)throw Error('Nested archive depth exceeds the browser limit.');
 const bytes=new Uint8Array(await file.arrayBuffer());let files;
 if(suffix(file.name)==='.tar')files=tar(bytes,budget);
 else{if(bytes[0]!==80||bytes[1]!==75){if(suffix(file.name).startsWith('.giq'))return [asset(file,'Application package saved. Native ingestion is required to interpret its contents.')];throw Error('Invalid ZIP archive.');}
  importScripts('vendor/ingestion/fflate.js?v='+FFLATE_VERSION);
  const entries=fflate.unzipSync(bytes,{filter:entry=>{safePath(entry.name);if(entry.name.endsWith('/'))return false;budget.bytes+=entry.originalSize;budget.count++;if(budget.count>100||budget.bytes>MAX_EXPANDED||entry.originalSize>Math.max(1,entry.size)*200)throw Error('Archive exceeds extraction limits.');return true;}});
  files=Object.entries(entries).map(([name,data])=>new File([data],name));
 }
 const outputs=[];
 for(const item of files){const ext=suffix(item.name);if(['.dbf','.prj','.shx','.cpg','.xml'].includes(ext))continue;
  if(!supported.includes(ext))continue;
  if(ext==='.json'){try{const value=JSON.parse(await item.text());if(!['Feature','FeatureCollection'].includes(value.type))continue;}catch{continue;}}
  const name=item.name.split('/').at(-1),clean=new File([item],name);
  if(ext==='.shp'){const base=item.name.slice(0,-4),siblings=files.filter(f=>f.name.slice(0,-4)===base&&['.shp','.shx','.prj','.dbf','.cpg'].includes(suffix(f.name))).map(f=>new File([f],'shape'+suffix(f.name)));outputs.push(...await spatial(clean,siblings));}
  else outputs.push(...await processFile(clean,depth+1,budget));
  if(outputs.length>20)throw Error('Archive contains more than 20 processable layers.');
 }
 return outputs.length?outputs:[asset(file,'Archive saved. No supported geographic layers were found.')];
}
let supported=[];
async function processFile(file,depth=0,budget={bytes:0,count:0}){
 const ext=suffix(file.name);
 if(['.zip','.kmz','.tar','.giq','.giqreport','.giqdrawing','.giqcategories'].includes(ext))return archive(file,depth,budget);
 if(['.png','.jpg','.jpeg','.mp4','.mpg','.mpeg','.pdf'].includes(ext))return [asset(file)];
 if(['.ecw','.jp2','.nc','.las','.laz','.dwg'].includes(ext))return [asset(file,'Original saved. This format needs a native decoder to create a map layer; browser conversion is unavailable.')];
 if(['.geojson','.json','.csv','.czml'].includes(ext)){
  if(file.size>MAX_VECTOR)throw Error('Text vector input exceeds the 20 MiB browser processing limit.');
  const text=await file.text();if(ext==='.csv')return [vector(stem(file.name),GVFileGeometry.csv(text))];
  const data=JSON.parse(text);if(ext==='.czml')return [vector(stem(file.name),GVFileGeometry.czml(data),'Static snapshot of CZML cartographic positions.')];
  if(!data.crs||/4326|CRS84/i.test(data.crs.properties?.name||''))return [vector(stem(file.name),GVFileGeometry.normalize(data))];
 }
 return spatial(file);
}
self.onmessage=async({data})=>{
 if(data?.type!=='process')return;self.onmessage=null;
 try{supported=data.extensions;if(!Array.isArray(supported)||!supported.includes(suffix(data.file.name)))throw Error('Unsupported file extension.');
  if(!data.file.size||data.file.size>MAX_FILE)throw Error('File must be between 1 byte and 128 MiB.');
  progress('Processing file in this browser…',10);
  const layers=await processFile(data.file);if(!layers.length||layers.length>20)throw Error('Processing must produce between 1 and 20 files.');
  postMessage({type:'result',layers});
 }catch(error){postMessage({type:'error',message:String(error?.message||error?.[0]?.message||'File processing failed.').slice(0,700)});}
};
