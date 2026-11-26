/* Public deployment URL only. Credentials never belong in this file. */
const fs=require('node:fs/promises'),path=require('node:path');
function deploymentConfig(value='') {
  value=value.trim();if(!value)return {api_url:''};
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    throw new Error('INGESTION_API_URL must be a public HTTPS URL without credentials, query or fragment');
  return {api_url:url.href.replace(/\/+$/,'')};
}
async function writeConfig({value=process.env.INGESTION_API_URL||'',output=path.resolve(__dirname,'../frontend/ingestion-config.json')}={}){
  const config=deploymentConfig(value);await fs.writeFile(output,JSON.stringify(config,null,2)+'\n');return config;
}
module.exports={deploymentConfig,writeConfig};
if(require.main===module)writeConfig().then(config=>console.log(config.api_url?'Remote ingestion API configured':'Same-origin ingestion API configured')).catch(error=>{console.error(error.message);process.exitCode=1;});
