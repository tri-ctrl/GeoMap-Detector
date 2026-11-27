/* Copy pinned, unmodified browser runtimes. Pages serves these lazily, on demand. */
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
async function prepare({root=ROOT,writeManifest=false}={}){
 const target=path.join(root,'frontend/vendor/ingestion');await fs.mkdir(target,{recursive:true});
 const entries=[...['gdal3.js','gdal3WebAssembly.wasm','gdal3WebAssembly.data'].map(name=>['gdal3.js/dist/package/'+name,name]),['gdal3.js/LICENSE','GDAL-LICENSE'],['fflate/umd/index.js','fflate.js'],['fflate/LICENSE','FFLATE-LICENSE'],['geotiff/dist-browser/geotiff.js','geotiff.js'],['geotiff/LICENSE','GEOTIFF-LICENSE']];
 const assets=[];
 for(const [source,name] of entries){const data=await fs.readFile(path.join(root,'node_modules',source));await fs.writeFile(path.join(target,name),data);assets.push({file:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
 const manifest={version:1,gdal:'2.8.1',fflate:'0.8.3',geotiff:'3.0.5',source:'https://github.com/bugra9/gdal3.js',assets};
 const manifestPath=path.join(root,'frontend/file-runtime.json');
 if(writeManifest)await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 else if(JSON.stringify(JSON.parse(await fs.readFile(manifestPath,'utf8')))!==JSON.stringify(manifest))throw Error('Browser GIS runtime fingerprints changed; review the dependency update and regenerate frontend/file-runtime.json.');
 await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
module.exports={prepare};
if(require.main===module)prepare({writeManifest:process.argv.includes('--write-manifest')}).then(value=>console.log('Prepared browser ingestion assets:',value.assets.reduce((n,a)=>n+a.bytes,0),'bytes')).catch(error=>{console.error(error.message);process.exitCode=1;});
