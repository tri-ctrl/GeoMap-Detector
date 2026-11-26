/* Device-local Directory Files adapter. Metadata and blobs commit atomically. */
(function(root){
'use strict';
const scriptURL=root.document?.currentScript?.src||root.location?.href;
const MAX_FILE=128*1048576,MAX_STORAGE=512*1048576,MAX_FILES=1000;
const workers={created:0,active:0,terminated:0};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const aborted=()=>new DOMException('File processing stopped.','AbortError');
function processWorker(file,{signal,onProgress=()=>{},extensions}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(aborted());
  const worker=new Worker(new URL('file-worker.js',scriptURL));
  workers.created++;workers.active++;let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker.terminate();workers.terminated++;workers.active--;error?reject(error):resolve(value);};
  const cancel=()=>finish(aborted()),timer=setTimeout(()=>finish(Error('Browser processing timed out. Retry with a smaller file or use native ingestion.')),180000);
  signal?.addEventListener('abort',cancel,{once:true});
  worker.onerror=()=>finish(Error('File worker could not run. Reload and retry; the original file remains saved.'));
  worker.onmessageerror=()=>finish(Error('File worker returned an unreadable result.'));
  worker.onmessage=({data})=>{if(data?.type==='progress')onProgress(data.message,data.value);else if(data?.type==='result')finish(null,data.layers);else if(data?.type==='error')finish(Error(data.message));};
  try{worker.postMessage({type:'process',file,extensions});}catch(error){finish(error);}
 });
}
async function create({indexedDB=root.indexedDB,name='geomap-directory-files',extensions,process=processWorker,locks=root.navigator?.locks}={}){
 if(!indexedDB)throw Error('Browser file storage is unavailable. Enable site storage to use Directory Files.');
 if(!extensions){const response=await fetch(new URL('file-formats.json',scriptURL),{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('File format configuration could not be loaded. Reload and retry.');extensions=(await response.json()).extensions;}
 if(!Array.isArray(extensions)||!extensions.length)throw Error('Invalid file format configuration.');
 const owner=crypto.randomUUID(),active=new Map();let database;
 async function open(){
  if(!database)database=new Promise((resolve,reject)=>{
   const request=indexedDB.open(name,1);let blocked=false;
   request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('uploads',{keyPath:'id'});const folders=db.createObjectStore('folders',{keyPath:'id'});folders.createIndex('sibling',['parent_key','name_key'],{unique:true});const artifacts=db.createObjectStore('artifacts',{keyPath:'key'});artifacts.createIndex('upload','upload_id');db.createObjectStore('meta',{keyPath:'id'});};
   request.onerror=()=>{database=null;reject(Error('Could not open browser file storage: '+request.error?.message));};
   request.onblocked=()=>{blocked=true;database=null;reject(Error('Close other GeoMap tabs and reload to update file storage.'));};
   request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>{request.result.close();database=null;};resolve(request.result);};
  });
  return database;
 }
 async function tx(names,mode,run,signal){
  signal?.throwIfAborted();const db=await open();signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{const transaction=db.transaction(names,mode),stores=Object.fromEntries(names.map(n=>[n,transaction.objectStore(n)]));let result,error;
   const stop=()=>{error=aborted();try{transaction.abort();}catch{}};
   const abort=e=>{error=e;try{transaction.abort();}catch{}};
   const done=value=>{result=value;};
   signal?.addEventListener('abort',stop,{once:true});
   transaction.oncomplete=()=>{signal?.removeEventListener('abort',stop);resolve(result);};
   transaction.onabort=()=>{signal?.removeEventListener('abort',stop);reject(error||transaction.error||Error('Browser file transaction failed.'));};transaction.onerror=()=>{};
   try{run(stores,done,abort);}catch(e){abort(e);}
  });
 }
 const all=store=>tx([store],'readonly',(s,done)=>{s[store].getAll().onsuccess=e=>done(e.target.result);});
 async function row(id,signal){const value=await tx(['uploads'],'readonly',(s,done)=>{s.uploads.get(id).onsuccess=e=>done(e.target.result);},signal);if(!value)throw fail('File was not found in this browser.',404);return value;}
 async function markFailed(id,attempt,error){return tx(['uploads'],'readwrite',(s,done)=>{s.uploads.get(id).onsuccess=e=>{const item=e.target.result;if(item?.attempt===attempt&&item.processor_owner===owner&&item.status==='processing'){item.status='failed';item.error=String(error).slice(0,1000);delete item.processor_owner;s.uploads.put(item);done(item);}};});}
 async function recover(){
  for(const item of await all('uploads'))if(item.status==='processing'&&!active.has(item.id)){
   const interrupted=async lock=>{if(locks&&!lock)return;await tx(['uploads'],'readwrite',(s,done)=>{s.uploads.get(item.id).onsuccess=e=>{const current=e.target.result;if(current?.status==='processing'&&current.processor_owner===item.processor_owner){current.status='failed';current.error='Processing was interrupted. Retry using the original saved in this browser.';delete current.processor_owner;s.uploads.put(current);done(current);}};});};
   if(locks)await locks.request('geomap-directory-file:'+item.id,{ifAvailable:true},interrupted);
   else if(item.processing_until<Date.now())await interrupted(true);
  }
 }
 async function sourceBlob(id,signal){return tx(['artifacts'],'readonly',(s,done,abort)=>{s.artifacts.get('uploads/'+id+'/source').onsuccess=e=>{e.target.result?done(e.target.result.blob):abort(fail('Original file is no longer saved.',404));};},signal);}
 async function commit(item,layers,signal){
  if(!Array.isArray(layers)||!layers.length||layers.length>20)throw Error('Invalid processed file list.');
  const records=[],files=layers.map((layer,i)=>{
   if(!['vector','raster','image','video','document','pointcloud','package'].includes(layer.kind)||!Array.isArray(layer.artifacts))throw Error('Invalid processed layer.');
   const id='layer-'+i,artifacts=layer.artifacts.map((artifact,j)=>{if(!(artifact.blob instanceof Blob)||artifact.blob.size>MAX_FILE)throw Error('Invalid or oversized processed artifact.');const key=`processed/${item.id}/${item.attempt}/${id}/${j}`;records.push({key,upload_id:item.id,blob:artifact.blob});return {role:artifact.role,key,media_type:artifact.media_type,size:artifact.blob.size};});
   return {id,name:String(layer.name).slice(0,255),kind:layer.kind,bbox:layer.bbox||null,feature_count:layer.feature_count||null,message:layer.message||null,artifacts};
  });
  const bytes=records.reduce((n,r)=>n+r.blob.size,0);
  return tx(['uploads','artifacts','meta'],'readwrite',(s,done,abort)=>{
   s.uploads.get(item.id).onsuccess=e=>{const current=e.target.result;if(!current||current.attempt!==item.attempt||current.processor_owner!==owner){abort(aborted());return;}
    s.meta.get('usage').onsuccess=e=>{const usage=e.target.result||{id:'usage',bytes:0,files:0};if(usage.bytes+bytes>MAX_STORAGE){abort(fail('Browser file storage limit reached (512 MiB). Delete a saved copy and retry.'));return;}
     records.forEach(record=>s.artifacts.put(record));usage.bytes+=bytes;s.meta.put(usage);current.total_size+=bytes;current.processed_files=files;current.status=files.some(f=>f.bbox)?'completed':'stored';current.error=null;delete current.processor_owner;s.uploads.put(current);done(current);
    };
   };
  },signal);
 }
 async function execute(item,signal,onProgress){
  const run=async lock=>{if(locks&&!lock){await markFailed(item.id,item.attempt,'Another tab is processing this file. Retry when it finishes.');throw fail('This file is being processed in another tab.',409);}
   const controller=new AbortController(),token={controller},combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;active.set(item.id,token);
   try{combined.throwIfAborted();const blob=await sourceBlob(item.id,combined);const layers=await process(new File([blob],item.name,{type:blob.type}),{signal:combined,onProgress,extensions});combined.throwIfAborted();return await commit(item,layers,combined);}
   catch(error){await markFailed(item.id,item.attempt,error.name==='AbortError'?'Processing stopped. Retry using the saved original.':error.message);throw error;}
   finally{if(active.get(item.id)===token)active.delete(item.id);}
  };
  return locks?locks.request('geomap-directory-file:'+item.id,{ifAvailable:true},run):run(true);
 }
 async function add(file,{folder_id=null,signal,onProgress=()=>{}}={}){
  if(active.size)throw fail('Wait for the current file to finish processing.',409);
  if(!file.size||file.size>MAX_FILE)throw fail('Browser files must be between 1 byte and 128 MiB.');
  if(file.name.length>255||/[\\/\x00-\x1f]/.test(file.name)||!extensions.some(ext=>file.name.toLowerCase().endsWith(ext)))throw fail('Unsupported filename or extension.');
  const estimate=await root.navigator?.storage?.estimate?.();if(estimate?.quota&&file.size>estimate.quota-estimate.usage)throw fail('Not enough browser storage. Delete a saved copy or free space and retry.');
  const id=crypto.randomUUID(),item={id,name:file.name,size:file.size,total_size:file.size,folder_id,attempt:1,status:'processing',processed_files:[],error:null,created_at:new Date().toISOString(),processor_owner:owner,processing_until:Date.now()+210000};
  await tx(['uploads','folders','artifacts','meta'],'readwrite',(s,done,abort)=>{
   const write=()=>{s.meta.get('usage').onsuccess=e=>{const usage=e.target.result||{id:'usage',bytes:0,files:0};if(usage.files>=MAX_FILES||usage.bytes+file.size>MAX_STORAGE){abort(fail('Browser file limit reached (1,000 files / 512 MiB). Delete a saved copy first.'));return;}
    usage.bytes+=file.size;usage.files++;s.meta.put(usage);s.artifacts.put({key:'uploads/'+id+'/source',upload_id:id,blob:file});s.uploads.add(item);done(item);
   };};
   if(folder_id)s.folders.get(folder_id).onsuccess=e=>e.target.result?write():abort(fail('Directory no longer exists.',404));else write();
  },signal);
  onProgress('Original saved. Processing in this browser…',5);
  return execute(item,signal,onProgress);
 }
 async function retry(id,signal){
  if(active.size)throw fail('Wait for the current file to finish processing.',409);
  const item=await tx(['uploads'],'readwrite',(s,done,abort)=>{s.uploads.get(id).onsuccess=e=>{const item=e.target.result;if(!item){abort(fail('File not found.',404));return;}if(item.status!=='failed'){abort(fail('Only interrupted or failed files can be retried.',409));return;}item.attempt++;item.status='processing';item.error=null;item.processor_owner=owner;item.processing_until=Date.now()+210000;s.uploads.put(item);done(item);};},signal);
  return execute(item,signal,()=>{});
 }
 async function remove(id){
  if(active.has(id))throw fail('Stop processing before deleting the saved copy.',409);
  return tx(['uploads','artifacts','meta'],'readwrite',(s,done,abort)=>{s.uploads.get(id).onsuccess=e=>{const item=e.target.result;if(!item)return;if(item.status==='processing'){abort(fail('Stop processing before deleting the saved copy.',409));return;}
   s.artifacts.index('upload').openCursor(id).onsuccess=e=>{const cursor=e.target.result;if(cursor){cursor.delete();cursor.continue();}};
   s.uploads.delete(id);s.meta.get('usage').onsuccess=e=>{const usage=e.target.result||{id:'usage',bytes:0,files:0};usage.bytes=Math.max(0,usage.bytes-item.total_size);usage.files=Math.max(0,usage.files-1);s.meta.put(usage);done({ok:true});};
  };});
 }
 async function request(path,{method='GET',body,signal}={}){
  signal?.throwIfAborted();const url=new URL(path,'https://browser.invalid'),parts=url.pathname.split('/').filter(Boolean);
  if(path==='/api/ingestion/health'){await open();await recover();return {ok:true,mode:'browser',max_upload_bytes:MAX_FILE,extensions};}
  if(parts[1]==='directories'){
   if(method==='GET')return {items:await all('folders')};
   if(method==='POST'){
    const name=body.name?.trim().normalize('NFC');if(!name||name.length>80||/[\\/\x00-\x1f]/.test(name)||['.','..'].includes(name))throw fail('Directory names must be 1–80 characters without slashes.');
    return tx(['folders'],'readwrite',(s,done,abort)=>{s.folders.getAll().onsuccess=e=>{const folders=e.target.result,existing=folders.find(f=>f.id===body.id),parent=body.parent_id||null;if(existing){if(existing.name===name&&existing.parent_id===parent)done(existing);else abort(fail('Directory ID already exists.',409));return;}
     if(folders.length>=1000){abort(fail('Directory limit reached.',409));return;}if(parent&&!folders.some(f=>f.id===parent)){abort(fail('Parent directory was not found.',404));return;}
     let depth=1,id=parent;while(id){if(++depth>12){abort(fail('Directory nesting is limited to 12 levels.',409));return;}id=folders.find(f=>f.id===id)?.parent_id;}
     if(folders.some(f=>f.parent_id===parent&&f.name_key===name.toLowerCase())){abort(fail('A directory with that name already exists here.',409));return;}
     const value={id:body.id,name,parent_id:parent,parent_key:parent||'root',name_key:name.toLowerCase()};s.folders.add(value);done(value);
    };},signal);
   }
  }
  if(parts[1]==='uploads'){
   const id=parts[2];if(!id){const folder=url.searchParams.get('folder')||'root',query=(url.searchParams.get('q')||'').toLowerCase(),limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||25))),offset=Math.max(0,Number(url.searchParams.get('offset')||0));return {items:(await all('uploads')).filter(v=>(v.folder_id||'root')===folder&&v.name.toLowerCase().includes(query)).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(offset,offset+limit)};}
   if(parts[3]==='retry'&&method==='POST')return retry(id,signal);
   if(parts[3]==='directory'&&method==='PATCH')return tx(['uploads','folders'],'readwrite',(s,done,abort)=>{const move=()=>{s.uploads.get(id).onsuccess=e=>{const item=e.target.result;if(!item){abort(fail('File not found.',404));return;}item.folder_id=body.folder_id||null;s.uploads.put(item);done(item);};};if(body.folder_id)s.folders.get(body.folder_id).onsuccess=e=>e.target.result?move():abort(fail('Directory not found.',404));else move();},signal);
   if(method==='GET'&&!parts[3])return row(id,signal);
  }
  throw fail('Unknown browser file operation.',404);
 }
 return {base:'browser:v1',mode:'browser',request,add,remove,readSource:sourceBlob,diagnostics:()=>({active:active.size,workers:{...workers}}),
  async readArtifact(item,file,role,signal){const current=await row(item.id,signal);if(current.attempt!==item.attempt)throw fail('This processed layer was replaced. Refresh Files.',409);const artifact=current.processed_files.find(f=>f.id===file.id)?.artifacts.find(a=>a.role===role);if(!artifact)throw fail('Processed artifact not found.',404);return tx(['artifacts'],'readonly',(s,done,abort)=>{s.artifacts.get(artifact.key).onsuccess=e=>e.target.result?done(e.target.result.blob):abort(fail('Processed artifact no longer exists.',404));},signal);},
  suspend(){for(const value of active.values())value.controller.abort();},
  async close(){this.suspend();const db=await database;db?.close();database=null;}
 };
}
const exports={create,processWorker,MAX_FILE,MAX_STORAGE};if(typeof module!=='undefined'&&module.exports)module.exports=exports;else root.GVBrowserFiles=exports;
})(typeof window!=='undefined'?window:globalThis);
