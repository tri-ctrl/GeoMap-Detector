const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const T=require('../frontend/tiff-codec.js');
// GeoTIFF's browser source uses FileReader; Node can read the same Blob bytes directly.
async function decoder(){const G=await import('geotiff');return {...G,fromBlob:async file=>G.fromArrayBuffer(await file.arrayBuffer())};}
const jpeg=()=>new File([fs.readFileSync(path.join(__dirname,'fixtures/jpeg-tiff/gray-gcps.tif'))],'gcp.tif');
test('JPEG bridge preserves the original, full GCP metadata and decoded grayscale values',async()=>{
 const G=await decoder(),file=jpeg(),original=Buffer.from(await file.arrayBuffer());
 const old=await G.fromBlob(file),image=await old.getImage(),points=await image.fileDirectory.loadValue('ModelTiepoint'),keys=await image.fileDirectory.loadValue('GeoKeyDirectory'),pixels=await image.readRasters({interleave:true,pool:null});
 const converted=await T.compatible(file,{loadDecoder:async()=>G}),out=await G.fromBlob(converted),decoded=await out.getImage();
 assert.equal((await T.inspect(converted)).compression,1);assert.equal(decoded.fileDirectory.hasTag('TileOffsets'),false);
 assert.deepEqual(await decoded.fileDirectory.loadValue('ModelTiepoint'),points);assert.ok(points.length*8>1000);
 assert.deepEqual(await decoded.fileDirectory.loadValue('GeoKeyDirectory'),keys);
 assert.deepEqual(await decoded.readRasters({interleave:true,pool:null}),pixels);assert.deepEqual(Buffer.from(await file.arrayBuffer()),original);
 await old.close();await out.close();
});
test('YCbCr JPEG bridge produces RGB while preserving affine georeferencing',async()=>{
 const G=await decoder(),file=new File([fs.readFileSync(path.join(__dirname,'fixtures/jpeg-tiff/rgb-affine.tif'))],'rgb.tif');
 const original=await G.fromBlob(file),image=await original.getImage(),expected=await image.readRGB({interleave:true,pool:null});
 const converted=await T.compatible(file,{loadDecoder:async()=>G}),output=await G.fromBlob(converted),view=await output.getImage(),info=await T.inspect(converted);
 assert.equal(info.samples,3);assert.equal(info.photometric,2);assert.deepEqual(Array.from(await view.readRGB({interleave:true,pool:null})),Array.from(expected));
 for(const tag of ['ModelTiepoint','ModelPixelScale','GeoKeyDirectory'])assert.deepEqual(await view.fileDirectory.loadValue(tag),await image.fileDirectory.loadValue(tag));
 await original.close();await output.close();
});
function header({big=false,little=true,width=2,height=2,compression=7}={}){
 const count=7,entrySize=big?20:12,countSize=big?8:2,offset=big?16:8,body=new Uint8Array(offset+countSize+count*entrySize+(big?8:4)),v=new DataView(body.buffer);
 body[0]=body[1]=little?73:77;v.setUint16(2,big?43:42,little);
 if(big){v.setUint16(4,8,little);v.setBigUint64(8,BigInt(offset),little);v.setBigUint64(offset,BigInt(count),little);}else{v.setUint32(4,offset,little);v.setUint16(offset,count,little);}
 [[256,4,width],[257,4,height],[258,3,8],[259,3,compression],[262,3,1],[277,3,1],[284,3,1]].forEach(([tag,type,value],i)=>{const at=offset+countSize+i*entrySize;v.setUint16(at,tag,little);v.setUint16(at+2,type,little);if(big)v.setBigUint64(at+4,1n,little);else v.setUint32(at+4,1,little);const p=at+(big?12:8);type===3?v.setUint16(p,value,little):v.setUint32(p,value,little);});
 return new File([body],'test.tif');
}
for(const big of [false,true])for(const little of [false,true])test(`TIFF layout ${big?'BigTIFF':'classic'} ${little?'little':'big'} endian preserves offsets without fabricating location`,async()=>{
 const file=header({big,little}),info=await T.inspect(file),output=T.wrap(file,info,new Uint8Array([10,20,30,40]));
 const parsed=await T.inspect(output);assert.equal(parsed.big,big);assert.equal(parsed.little,little);assert.equal(parsed.compression,1);assert.equal(parsed.width,2);
 assert.equal(parsed.entries.some(e=>e.tag===34735||e.tag===33922||e.tag===33550),false);
 const G=await decoder(),tiff=await G.fromBlob(output),image=await tiff.getImage();assert.deepEqual(Array.from(await image.readRasters({interleave:true})),[10,20,30,40]);await tiff.close();
});
test('uncompressed TIFF does not load the JPEG decoder',async()=>{
 const file=header({compression:1});let loaded=false;assert.equal(await T.compatible(file,{loadDecoder:async()=>{loaded=true;}}),file);assert.equal(loaded,false);
});
test('decoder load errors are retryable and an unreadable image releases its source',async()=>{
 await assert.rejects(T.compatible(jpeg(),{loadDecoder:async()=>{throw Error('network unavailable');}}),/Reload the page and retry/);
 let closed=false;await assert.rejects(T.compatible(jpeg(),{loadDecoder:async()=>({fromBlob:async()=>({getImage:async()=>{throw Error('unreadable JPEG');},close:async()=>{closed=true;}})})}),/unreadable JPEG/);assert.equal(closed,true);
});
test('JPEG dimensions and invalid directories fail before decoder allocation',async()=>{
 let loaded=false;await assert.rejects(T.compatible(header({width:100000,height:100000}),{loadDecoder:async()=>{loaded=true;}}),/64 MiB/);assert.equal(loaded,false);
 const file=header(),data=new Uint8Array(await file.arrayBuffer());new DataView(data.buffer).setUint32(4,0xfffffff0,true);await assert.rejects(T.inspect(new File([data],'bad.tif')),/outside/);
 await assert.rejects(T.inspect(new File(['not tiff'],'bad.tif')),/Invalid TIFF/);
 await assert.rejects(T.compatible(header({compression:6}),{loadDecoder:async()=>{loaded=true;}}),/Old-style JPEG/);
});
