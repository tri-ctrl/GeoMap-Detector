/* JPEG-in-TIFF bridge. Append decoded strips while preserving source metadata offsets. */
(function(root){
'use strict';
const MAX_TAGS=4096,MAX_DECODED=64*1048576;
async function bytes(file,offset,size){if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>file.size)throw Error('TIFF metadata points outside the file.');return new Uint8Array(await file.slice(offset,offset+size).arrayBuffer());}
function uint64(view,offset,little){const value=view.getBigUint64(offset,little);if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('TIFF offset exceeds browser precision.');return Number(value);}
async function inspect(file){
 const header=await bytes(file,0,Math.min(16,file.size));if(header.length<8||!((header[0]===73&&header[1]===73)||(header[0]===77&&header[1]===77)))throw Error('Invalid TIFF header.');
 const little=header[0]===73,h=new DataView(header.buffer),magic=h.getUint16(2,little),big=magic===43;
 if(magic!==42&&!big)throw Error('Unsupported TIFF header.');
 if(big&&(header.length<16||h.getUint16(4,little)!==8||h.getUint16(6,little)!==0))throw Error('Invalid BigTIFF offset layout.');
 const offset=big?uint64(h,8,little):h.getUint32(4,little),countSize=big?8:2,entrySize=big?20:12,inline=big?8:4;
 const countBytes=await bytes(file,offset,countSize),cv=new DataView(countBytes.buffer),count=big?uint64(cv,0,little):cv.getUint16(0,little);
 if(count>MAX_TAGS)throw Error('TIFF metadata exceeds the browser tag limit.');
 const directory=await bytes(file,offset+countSize,count*entrySize),view=new DataView(directory.buffer),entries=[];
 for(let i=0;i<count;i++){const start=i*entrySize;entries.push({tag:view.getUint16(start,little),type:view.getUint16(start+2,little),count:big?uint64(view,start+4,little):view.getUint32(start+4,little),raw:directory.slice(start,start+entrySize)});}
 async function values(tag,defaults){const entry=entries.find(e=>e.tag===tag);if(!entry)return defaults;
  const size=({1:1,3:2,4:4,16:8})[entry.type];if(!size||entry.count>32)throw Error('Invalid TIFF sample/dimension metadata.');
  const entryView=new DataView(entry.raw.buffer),at=big?12:8;
  const data=entry.count*size<=inline?entry.raw.slice(at,at+entry.count*size):await bytes(file,big?uint64(entryView,at,little):entryView.getUint32(at,little),entry.count*size),v=new DataView(data.buffer);
  return Array.from({length:entry.count},(_,i)=>size===1?v.getUint8(i):size===2?v.getUint16(i*size,little):size===4?v.getUint32(i*size,little):uint64(v,i*size,little));
 }
 return {header,little,big,inline,countSize,entrySize,entries,compression:(await values(259,[1]))[0],width:(await values(256,[0]))[0],height:(await values(257,[0]))[0],samples:(await values(277,[1]))[0],bits:await values(258,[8]),sampleFormat:await values(339,[1]),photometric:(await values(262,[1]))[0]};
}
function checkSize(info,samples=info.samples){const size=info.width*info.height*samples;if(!Number.isSafeInteger(size)||info.width<1||info.height<1||samples<1||samples>4||size>MAX_DECODED)throw Error('Decoded JPEG TIFF exceeds the 64 MiB sample buffer limit.');return size;}
function wrap(file,info,pixels,{samples=info.samples,photometric=info.photometric}={}){
 const length=checkSize(info,samples);if(!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray)||pixels.length!==length)throw Error('JPEG TIFF decoder returned an invalid sample buffer.');
 const {little,big,entrySize,countSize,inline}=info,headerSize=big?16:8,newOffset=Math.ceil(file.size/8)*8;
 // Remove encoded tile/strip tables and overview chains; the bridge exposes one decoded image.
 const replaced=new Set([258,259,262,273,277,278,279,284,317,322,323,324,325,330,339,347,512,513,514,515,517,518,519,520,521,529,530,531,532]);
 if(samples!==info.samples||photometric!==info.photometric)replaced.add(338);
 const entries=info.entries.filter(e=>!replaced.has(e.tag)).map(e=>({...e}));
 const tag=(id,type,values)=>entries.push({tag:id,type,count:values.length,values});
 tag(258,3,Array(samples).fill(8));tag(259,3,[1]);tag(262,3,[photometric]);tag(273,big?16:4,[0]);tag(277,3,[samples]);tag(278,4,[info.height]);tag(279,big?16:4,[pixels.length]);tag(284,3,[1]);tag(339,3,Array(samples).fill(1));entries.sort((a,b)=>a.tag-b.tag);
 let extra=countSize+entries.length*entrySize+(big?8:4);
 for(const entry of entries)if(entry.values&&entry.values.length*({3:2,4:4,16:8})[entry.type]>inline){extra=Math.ceil(extra/8)*8;entry.valueOffset=extra;extra+=entry.values.length*({3:2,4:4,16:8})[entry.type];}
 const pixelOffset=Math.ceil((newOffset+extra)/8)*8;
 entries.find(e=>e.tag===273).values=[pixelOffset];
 if(!big&&pixelOffset+pixels.length>0xffffffff)throw Error('Decoded TIFF exceeds classic TIFF offsets.');
 const data=new Uint8Array(pixelOffset-newOffset),v=new DataView(data.buffer);
 if(big)v.setBigUint64(0,BigInt(entries.length),little);else v.setUint16(0,entries.length,little);
 entries.forEach((entry,i)=>{const start=countSize+i*entrySize;if(entry.raw){data.set(entry.raw,start);return;}
  v.setUint16(start,entry.tag,little);v.setUint16(start+2,entry.type,little);if(big)v.setBigUint64(start+4,BigInt(entry.count),little);else v.setUint32(start+4,entry.count,little);
  let target=start+(big?12:8);if(entry.valueOffset!==undefined){if(big)v.setBigUint64(target,BigInt(newOffset+entry.valueOffset),little);else v.setUint32(target,newOffset+entry.valueOffset,little);target=entry.valueOffset;}
  entry.values.forEach((value,n)=>entry.type===3?v.setUint16(target+n*2,value,little):entry.type===4?v.setUint32(target+n*4,value,little):v.setBigUint64(target+n*8,BigInt(value),little));
 });
 const header=info.header.slice(0,headerSize),hv=new DataView(header.buffer);if(big)hv.setBigUint64(8,BigInt(newOffset),little);else hv.setUint32(4,newOffset,little);
 // Preserve every original payload offset, including large GCP arrays and vendor metadata.
 // Only the copied header's first-IFD pointer changes; the saved original is untouched.
 return new File([header,file.slice(headerSize),new Uint8Array(newOffset-file.size),data,pixels],file.name,{type:'image/tiff'});
}
async function compatible(file,{loadDecoder,progress=()=>{}}){
 const info=await inspect(file);if(info.compression!==7){if(info.compression===6)throw Error('Old-style JPEG TIFF compression is not supported. Re-encode it with modern JPEG or Deflate.');return file;}
 checkSize(info);if(info.bits.some(n=>n!==8)||info.sampleFormat.some(n=>n!==1))throw Error('JPEG TIFF decoding requires 8-bit unsigned samples.');
 const color=[5,6,8].includes(info.photometric),samples=color?3:info.samples;checkSize(info,samples);
 if(![0,1,2,5,6,8].includes(info.photometric))throw Error('Unsupported JPEG TIFF color interpretation.');
 progress('Decoding JPEG-compressed TIFF tiles…',15);
 let codec;try{codec=await loadDecoder();}catch{throw Error('JPEG TIFF tools could not load. Reload the page and retry processing.');}
 const tiff=await codec.fromBlob(file);
 try{const image=await tiff.getImage(),pixels=color?await image.readRGB({interleave:true,pool:null}):await image.readRasters({interleave:true,pool:null});return wrap(file,info,pixels,{samples,photometric:color?2:info.photometric});}
 finally{await tiff.close?.();}
}
const api={inspect,checkSize,wrap,compatible,MAX_DECODED};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GVFileTIFF=api;
})(typeof self!=='undefined'?self:globalThis);
