const assert=require('node:assert/strict'),test=require('node:test');
const {checkRuntime}=require('../scripts/check_ingestion_runtime.cjs');
const origin='https://files.example.test';
function fixture(){return {services:{
  'upload-api':{environment:{S3_PUBLIC_ENDPOINT:origin,S3_ACCESS_KEY:'deployment-key',S3_SECRET_KEY:'random-s3-credential-of-32-characters'}},
  web:{environment:{S3_PROXY_HOST:'files.example.test'}},
  postgres:{environment:{POSTGRES_PASSWORD:'url_safe_random_password_32_characters'}},
  'airflow-scheduler':{environment:{AIRFLOW_API_PASSWORD:'random-airflow-password-32-characters',AIRFLOW__WEBSERVER__SECRET_KEY:'random-web-secret-of-32-characters',AIRFLOW__CORE__FERNET_KEY:Buffer.alloc(32,42).toString('base64url')+'='}}
}};}
test('remote deployment validates the gateway signing origin before connecting',()=>{
  assert.equal(checkRuntime(fixture(),origin).origin,origin);
  for(const url of ['', 'http://localhost:8095','https://files.example.test/prefix'])assert.throws(()=>checkRuntime(fixture(),url));
  const value=fixture();value.services.web.environment.S3_PROXY_HOST='localhost';assert.throws(()=>checkRuntime(value,origin),/signing origin/);
});
test('remote deployment rejects local and malformed database credentials without disclosing them',()=>{
  const value=fixture();value.services.postgres.environment.POSTGRES_PASSWORD='geomap-local-db';
  assert.throws(()=>checkRuntime(value,origin),error=>!error.message.includes('geomap-local-db'));
  value.services.postgres.environment.POSTGRES_PASSWORD='special:@/password-of-32-characters';assert.throws(()=>checkRuntime(value,origin),/URL-safe/);
});
test('remote deployment requires persistent Airflow encryption and authentication secrets',()=>{
  for(const key of ['AIRFLOW_API_PASSWORD','AIRFLOW__WEBSERVER__SECRET_KEY','AIRFLOW__CORE__FERNET_KEY']){
    const value=fixture();delete value.services['airflow-scheduler'].environment[key];assert.throws(()=>checkRuntime(value,origin));
  }
});
