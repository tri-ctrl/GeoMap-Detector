/* Native Leaflet/input/geolocation, intercepted geocoder; --live-search also
 * checks public Esri CORS responses without persisting returned locations.
 * node tests/browser/allocation.cjs --search [--live-search] --output <path>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
module.exports = async ({ page, browser, evaluate, until, errors, on, result }) => {
  result.mode = 'Local source; real Leaflet, input, permission and geolocation APIs; deterministic Esri responses';
  const requests = []; let held;
  on('Fetch.requestPaused', ({ requestId, request }) => {
    const url = new URL(request.url), query = url.searchParams.get('text') || url.searchParams.get('SingleLine'); requests.push({ action: url.pathname.split('/').pop(), query });
    const fulfill = () => page('Fetch.fulfillRequest', { requestId, responseCode: query === 'Broken' ? 503 : 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(url.pathname.endsWith('/suggest') ? { suggestions: [{ text: 'Dubai International Airport', magicKey: 'airport' }] }
        : { candidates: query === 'Nowhere' ? [] : [{ address: 'Dubai International Airport', location: { x: 55.36, y: 25.25 }, extent: { xmin: 55.35, ymin: 25.24, xmax: 55.37, ymax: 25.26 } }] })).toString('base64') });
    if (query === 'Delayed') held = fulfill; else fulfill().catch(error => errors.push(error.message));
  });
  await page('Fetch.enable', { patterns: [{ urlPattern: 'https://geocode.arcgis.com/*' }] });
  await evaluate(`(() => {
    const setView=L.Map.prototype.setView;L.Map.prototype.setView=function(...args){window.__searchMap=this;return setView.apply(this,args)};
    const geo=navigator.geolocation,watch=geo.watchPosition.bind(geo),clear=geo.clearWatch.bind(geo);
    window.__searchGeo={requested:0,closed:0,active:new Set()};
    geo.watchPosition=(...args)=>{__searchGeo.requested++;const id=watch(...args);__searchGeo.active.add(id);return id};
    geo.clearWatch=id=>{__searchGeo.closed++;__searchGeo.active.delete(id);return clear(id)};
    window.__searchBefore={date:document.querySelector('#hudRel').textContent,aois:document.querySelector('#runN').textContent};
    document.querySelector('#mapSearchInput').focus();
  })()`);
  assert.equal(await evaluate("document.querySelector('#mapSearchPopup').hidden"), false); assert.equal(await evaluate('__searchGeo.requested'), 0); assert.equal(requests.length, 0);
  const enter = async () => { await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const type = text => evaluate(`(() => {const input=document.querySelector('#mapSearchInput');input.value=${JSON.stringify(text)};input.focus();input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await type('9.88544, 114.33005'); await enter();
  await until("Boolean(window.__searchMap&&document.querySelector('#mapSearchPopup').hidden)");
  result.coordinates = await evaluate("({center:[__searchMap.getCenter().lat,__searchMap.getCenter().lng],zoom:__searchMap.getZoom(),markers:document.querySelectorAll('.leaflet-gmd-search-pane path').length})");
  assert.ok(Math.abs(result.coordinates.center[0] - 9.88544) < 1e-7); assert.equal(result.coordinates.center[1], 114.33005); assert.equal(result.coordinates.markers, 1); assert.equal(requests.length, 0);
  await type('Dub'); await until("document.querySelector('#mapSearchOptions').textContent.includes('Dubai International Airport')");
  await evaluate("document.querySelectorAll('[data-place-index]')[1].click()");
  await until("document.querySelector('#mapSearchInput').value==='Dubai International Airport'&&document.querySelector('#mapSearchPopup').hidden");
  result.place = await evaluate("({visible:__searchMap.getBounds().contains([25.25,55.36]),markers:document.querySelectorAll('.leaflet-gmd-search-pane path').length,zoom:__searchMap.getZoom()})");
  assert.equal(result.place.visible, true); assert.equal(result.place.markers, 1);
  await type('Nowhere'); await enter(); await until("document.querySelector('#mapSearchStatus').textContent.includes('No places found')");
  await type('Broken'); await enter(); await until("document.querySelector('#mapSearchStatus').textContent.includes('HTTP 503')");
  await type('Delayed'); await enter(); await until("GVEngine.operations.diagnostics().requests>0");
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(held);
  await type('25.2, 55.3'); await enter(); await held().catch(() => {});
  await until("GVEngine.operations.diagnostics().requests===0");
  assert.equal(await evaluate('Number(__searchMap.getCenter().lat.toFixed(6))'), 25.2);
  await evaluate("document.querySelector('#mapSearchInput').focus();document.querySelector('#mapSearchInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  assert.equal(await evaluate("document.querySelector('#mapSearchPopup').hidden"), true);
  const origin = await evaluate('location.origin');
  await browser('Browser.grantPermissions', { origin, permissions: ['geolocation'] });
  await page('Emulation.setGeolocationOverride', { latitude: 25.265, longitude: 55.321, accuracy: 10 });
  await evaluate("document.querySelector('#mapSearchInput').blur();document.querySelector('#mapSearchInput').focus();document.querySelector('[data-place-index=\"0\"]').click()");
  await until("document.querySelector('#mapSearchInput').value==='25.265000, 55.321000'&&document.querySelector('#mapSearchPopup').hidden");
  result.location = await evaluate('({center:[__searchMap.getCenter().lat,__searchMap.getCenter().lng],requested:__searchGeo.requested,closed:__searchGeo.closed,active:__searchGeo.active.size})');
  assert.equal(result.location.requested, 1); assert.equal(result.location.closed, 1); assert.equal(result.location.active, 0);
  await browser('Browser.setPermission', { origin, permission: { name: 'geolocation' }, setting: 'denied' });
  await evaluate("document.querySelector('#mapSearchInput').blur();document.querySelector('#mapSearchInput').focus();document.querySelector('[data-place-index=\"0\"]').click()");
  await until("document.querySelector('#mapSearchStatus').textContent.includes('permission was denied')");
  result.denied = await evaluate('({requested:__searchGeo.requested,closed:__searchGeo.closed,active:__searchGeo.active.size})'); assert.equal(result.denied.active, 0); assert.equal(result.denied.closed, 2);
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await type('Dub'); await until("document.querySelector('#mapSearchOptions').textContent.includes('Dubai International Airport')");
  result.mobile = await evaluate(`(() => {const map=document.querySelector('.mapwrap').getBoundingClientRect(),box=document.querySelector('#mapSearch').getBoundingClientRect(),popup=document.querySelector('#mapSearchPopup').getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,inside:box.left>=map.left&&box.right<=map.right&&popup.bottom<=map.bottom,mapWidth:map.width,searchWidth:box.width}})()`);
  assert.equal(result.mobile.overflow, false); assert.equal(result.mobile.inside, true);
  const screenshot = await page('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(os.tmpdir(), 'geomap-map-search.png'), Buffer.from(screenshot.data, 'base64'));
  await page('Fetch.disable');
  if (process.argv.includes('--live-search')) {
    result.live = await evaluate(`(async()=>{const suggestions=await GVEngine.mapSearch.suggest('Dubai International Airport'),point=await GVEngine.mapSearch.find(suggestions[0].label,{magicKey:suggestions[0].magicKey});return{suggestions:suggestions.length,label:point.label,location:point.lat>24&&point.lat<26&&point.lon>54&&point.lon<57}})()`, 30000);
    assert.ok(result.live.suggestions > 0); assert.equal(result.live.location, true);
  }
  result.preserved = await evaluate("({before:__searchBefore,after:{date:document.querySelector('#hudRel').textContent,aois:document.querySelector('#runN').textContent}})"); assert.deepEqual(result.preserved.after, result.preserved.before);
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))"); await until('GVEngine.operations.diagnostics().active.length===0');
  result.cleanup = await evaluate("({operations:GVEngine.operations.diagnostics(),markers:document.querySelectorAll('.leaflet-gmd-search-pane path').length,watches:__searchGeo.active.size,popupHidden:document.querySelector('#mapSearchPopup').hidden})");
  assert.equal(result.cleanup.markers, 0); assert.equal(result.cleanup.watches, 0); assert.equal(result.cleanup.popupHidden, true); assert.equal(result.cleanup.operations.requests, 0); assert.deepEqual(errors, []);
  result.requests = requests; result.runtimeErrors = errors;
  console.log('Map search: coordinates, Esri suggestions, errors/stale requests, real geolocation permission/cleanup, map state and 390px layout pass.');
};
