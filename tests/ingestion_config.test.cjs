const assert=require('node:assert/strict'),test=require('node:test');
const {deploymentConfig}=require('../scripts/write_ingestion_config.cjs');
test('Pages ingestion configuration accepts remote HTTPS without embedding credentials',()=>{
 assert.equal(deploymentConfig('https://upload.example.test/').api_url,'https://upload.example.test');
 assert.equal(deploymentConfig('').api_url,'');
 for(const url of ['http://upload.example.test','https://user:password@example.test','https://localhost','https://example.test?token=secret'])assert.throws(()=>deploymentConfig(url));
});
