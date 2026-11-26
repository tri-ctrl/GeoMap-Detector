/* Real local Compose upload/catalog/map check in an isolated browser profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withChrome } = require('./chrome.cjs');
const url = process.env.GMD_UPLOAD_URL || 'http://localhost:8095/';

withChrome(async ({ page, evaluate, until, errors, on }) => {
  for (const name of ['index.html', 'app.js', 'uploads.js']) {
    const response = await fetch(new URL(name, url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fs.readFileSync(path.join(__dirname, '../../frontend', name), 'utf8'), `Built web image serves current ${name}`);
  }
  const requests = [];
  on('Network.requestWillBeSent', event => requests.push(event.request.url));
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__uploadTestLayers = [];
    const interval = setInterval(() => {
      if (!window.L || window.__uploadMapInstrumented) return;
      window.__uploadMapInstrumented = true; clearInterval(interval);
      const add = L.Map.prototype.addLayer;
      L.Map.prototype.addLayer = function(layer) { window.__uploadTestLayers.push(layer); return add.call(this, layer); };
    }, 1);
  ` });
  await page('Page.navigate', { url });
  await until('window.GVApp && document.querySelector("#storageStatus").textContent.includes("Saved on this device")');
  assert.equal(requests.some(value => value.includes('/uploads.js') || value.includes('/api/uploads')), false, 'Files stays lazy during map startup');
  await evaluate('document.querySelector("[data-tab=files]").click()');
  await until('document.querySelector("#filesStatus").textContent.startsWith("Connected")');
  const name = `native-browser-${Date.now()}.geojson`;
  await evaluate(`(() => {
    const fc = {type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Native upload polygon'},geometry:{type:'Polygon',coordinates:[[[55.35,25.24],[55.37,25.24],[55.37,25.26],[55.35,25.24]]]}}]};
    const input = document.querySelector('#uploadFile'), data = new DataTransfer();
    data.items.add(new File([JSON.stringify(fc)], ${JSON.stringify(name)}, {type:'application/geo+json'}));
    input.files=data.files; input.dispatchEvent(new Event('change')); document.querySelector('#uploadStart').click();
  })()`);
  await until('document.querySelector("#uploadStatus").textContent.startsWith("Upload complete")', 60000);
  const row = `Array.from(document.querySelectorAll('[data-upload]')).find(row=>row.textContent.includes(${JSON.stringify(name)}))`;
  await until(`Boolean((${row})?.querySelector('[data-action=preview]'))`, 240000);
  await evaluate(`(${row}).querySelector('[data-action=preview]').click()`);
  await until(`window.__uploadTestLayers.some(layer=>layer.feature?.properties?.name==='Native upload polygon' && layer._map)`);
  await evaluate(`(${row}).querySelector('[data-action=aois]').click()`);
  await until(`document.querySelector('#aoiList').textContent.includes('Native upload polygon')`);
  const previewCount = await evaluate(`window.__uploadTestLayers.filter(layer=>layer.feature?.properties?.name==='Native upload polygon' && layer._map).length`);
  await evaluate(`document.querySelector('#filesClearMap').click()`);
  let rasterPreview = false;
  if (process.env.GMD_UPLOAD_RASTER) {
    const encoded = fs.readFileSync(process.env.GMD_UPLOAD_RASTER).toString('base64');
    const rasterName = `native-raster-${Date.now()}.tif`;
    await evaluate(`(() => {
      const data = new DataTransfer(), input = document.querySelector('#uploadFile');
      data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}), c=>c.charCodeAt(0))], ${JSON.stringify(rasterName)}, {type:'image/tiff'}));
      input.files=data.files; input.dispatchEvent(new Event('change')); document.querySelector('#uploadStart').click();
    })()`);
    await until('document.querySelector("#uploadStatus").textContent.startsWith("Upload complete")', 60000);
    const rasterRow = `Array.from(document.querySelectorAll('[data-upload]')).find(row=>row.textContent.includes(${JSON.stringify(rasterName)}))`;
    await until(`Boolean((${rasterRow})?.querySelector('[data-action=preview]'))`, 240000);
    await evaluate(`(${rasterRow}).querySelector('[data-action=preview]').click()`);
    await until(`Array.from(document.querySelectorAll('.leaflet-image-layer')).some(img=>img.src.startsWith('blob:') && img.complete && img.naturalWidth>0)`);
    rasterPreview = true;
    await evaluate(`document.querySelector('#filesClearMap').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.leaflet-image-layer').length`), 0);
  }
  await evaluate(`document.querySelector('[data-tab=aoi]').click()`);
  assert.equal(await evaluate('document.querySelector("#tab-aoi").classList.contains("on")'), true);
  if (process.env.GMD_UPLOAD_DESKTOP_SCREENSHOT) {
    await evaluate('document.querySelector("[data-tab=files]").click()');
    const shot = await page('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.GMD_UPLOAD_DESKTOP_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("[data-tab=files]").click()');
  await until('document.querySelector("#filesStatus").textContent.startsWith("Connected")');
  const dimensions = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})`);
  assert.ok(dimensions.scroll <= dimensions.width + 1, 'narrow view has no horizontal page overflow');
  if (process.env.GMD_UPLOAD_SCREENSHOT) {
    const shot = await page('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.GMD_UPLOAD_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, file: name, lazy: true, upload: true, catalog: true, previewCount,
    aois: true, rasterPreview, narrowViewport: dimensions, runtimeErrors: errors }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
