/* Validate the effective Compose configuration without logging credentials. */
const {deploymentConfig}=require('./write_ingestion_config.cjs');
function checkRuntime(config,publicUrl){
  const origin=deploymentConfig(publicUrl).api_url;
  if(!origin||new URL(origin).pathname!=='/')throw new Error('Set INGESTION_API_URL to the HTTPS gateway origin');
  const env=service=>config.services?.[service]?.environment||{};
  const api=env('upload-api'),airflow=env('airflow-scheduler');
  if(api.S3_PUBLIC_ENDPOINT!==origin||env('web').S3_PROXY_HOST!==new URL(origin).host)
    throw new Error('The S3 signing origin and gateway Host must match INGESTION_API_URL');
  const secrets=[
    ['PostgreSQL password',env('postgres').POSTGRES_PASSWORD,20],
    ['S3 secret',api.S3_SECRET_KEY,20],
    ['Airflow password',airflow.AIRFLOW_API_PASSWORD,20],
    ['Airflow web secret',airflow.AIRFLOW__WEBSERVER__SECRET_KEY,32]
  ];
  for(const [name,value,min] of secrets)if(typeof value!=='string'||value.length<min||value.startsWith('geomap-local'))
    throw new Error(`${name} must be configured with a generated deployment credential`);
  if(!/^[A-Za-z0-9_-]+$/.test(env('postgres').POSTGRES_PASSWORD))
    throw new Error('Use a URL-safe PostgreSQL password (letters, numbers, _ and -)');
  if(!api.S3_ACCESS_KEY||api.S3_ACCESS_KEY==='geomap-local')throw new Error('Configure the deployment S3 access key');
  if(!/^[A-Za-z0-9_-]{43}=$/.test(airflow.AIRFLOW__CORE__FERNET_KEY||''))
    throw new Error('Configure a 32-byte URL-safe base64 Airflow Fernet key');
  return {origin};
}
module.exports={checkRuntime};
if(require.main===module){
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>input+=data);
  process.stdin.on('end',()=>{try{checkRuntime(JSON.parse(input),process.env.INGESTION_API_URL);console.log('Remote runtime configuration validated');}catch(error){console.error(error.message);process.exitCode=1;}});
}
