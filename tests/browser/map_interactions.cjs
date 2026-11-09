/* Optional real-Leaflet check: node tests/browser/map_interactions.cjs
 * Requires desktop Chrome (GMD_BROWSER_BIN can override its path) and network access.
 * Uses an isolated profile and substitutes local app.js/engine.js responses in the
 * public page. It does not publish code, test deployment parity, or run inference.
 * Add --deployed to use the real served sources and verify their bytes before testing.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const base = "https://tri-ctrl.github.io/GeoMap-Detector/";
const deployed = process.argv.includes("--deployed");
const selection = process.argv.includes("--selection");
const detectionClick = process.argv.includes("--detection-click");
const root = path.resolve(__dirname, "../..");
const appSource = fs.readFileSync(path.join(root, "frontend/app.js"), "utf8");
const engineSource = fs.readFileSync(path.join(root, "frontend/engine.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const storageSource = fs.readFileSync(path.join(root, "frontend/storage.js"), "utf8");
const streamingSource = fs.readFileSync(path.join(root, "frontend/streaming.js"), "utf8");
const comparisonSource = fs.readFileSync(path.join(root, "frontend/comparison.js"), "utf8");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geomap-gmd003-"));
const browserBin = process.env.GMD_BROWSER_BIN || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(candidate => fs.existsSync(candidate));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const instrumentation = `(() => {
  const counts = { tileLayers: 0, tileUrls: 0, fits: 0, geoJSON: 0, annotationReads: 0, annotationFetches: 0, detectionFetches: 0 };
  window.__gmd003 = { counts };
  if (window.GVStorage) {
    const create = GVStorage.create;
    GVStorage.create = (...args) => (__gmd003.repository = create(...args));
  }
  const wrap = (object, key, counter) => {
    const original = object[key];
    object[key] = function(...args) { counts[counter]++; if (counter === 'fits') __gmd003.map = this; return original.apply(this, args); };
  };
  wrap(L, 'tileLayer', 'tileLayers'); wrap(L.TileLayer.prototype, 'setUrl', 'tileUrls');
  wrap(L.Map.prototype, 'fitBounds', 'fits');
  const geoJSON = L.geoJSON;
  L.geoJSON = function(...args) {
    counts.geoJSON++;
    const group = geoJSON.apply(this, args);
    group.eachLayer(layer => { if (layer.feature?.id === 'manual_gmd003') __gmd003.detection = layer; });
    return group;
  };
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function(key) { if (key === 'gv_ann') counts.annotationReads++; return getItem.call(this, key); };
  const fetch = window.fetch;
  window.fetch = function(url, ...args) {
    if (String(url).endsWith('/api/annotations')) counts.annotationFetches++;
    if (String(url).endsWith('/detections.geojson')) counts.detectionFetches++;
    return fetch.call(this, url, ...args);
  };
})();\n`;

let chrome, socket, watchdog;
(async () => {
  assert.ok(browserBin, "Chrome not found; set GMD_BROWSER_BIN to its executable");
  chrome = spawn(browserBin, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--window-size=1440,1000",
    `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  watchdog = setTimeout(() => { chrome.kill(); socket?.close(); }, 180000);
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 20000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on("data", chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0, sessionId;
  const pending = new Map(), errors = [], overrides = new Set(), servedScripts = new Map();
  const send = (method, params = {}, session) => new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => { pending.delete(request); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
    pending.set(request, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: request, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const page = (method, params) => send(method, params, sessionId);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === "Network.responseReceived") {
      const file = new URL(message.params.response.url).pathname.split("/").pop();
      if (["app.js", "engine.js"].includes(file)) servedScripts.set(file, message.params.requestId);
    } else if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const file = request.url === base ? "index.html" : new URL(request.url).pathname.split("/").pop();
      const content = file === "app.js" ? instrumentation + appSource : file === "engine.js" ? engineSource : file === "comparison.js" ? comparisonSource : file === "storage.js" ? storageSource : file === "streaming.js" ? streamingSource : htmlSource;
      overrides.add(file);
      page("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: file === "index.html" ? "text/html" : "application/javascript" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(content).toString("base64") }).catch(error => errors.push(error.message));
    }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await Promise.all([page("Page.enable"), page("Runtime.enable"), page("Network.enable")]);
  if (!deployed) await page("Fetch.enable", { patterns: [{ urlPattern: base }, { urlPattern: base + "app.js*" }, { urlPattern: base + "engine.js*" }, { urlPattern: base + "comparison.js*" }, { urlPattern: base + "storage.js*" }, { urlPattern: base + "streaming.js*" }] });
  const evaluate = async expression => {
    const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).catch(error => {
      throw new Error(error.message + " while evaluating: " + expression.slice(0, 180));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(200); }
    throw new Error("Browser condition timed out: " + expression);
  };
  const counts = () => evaluate("({ ...__gmd003.counts })");
  const difference = (before, after) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
  await page("Page.navigate", { url: base });
  await until("Boolean(window.GVEngine && document.querySelectorAll('#relList [data-r]').length > 1 && document.querySelector('.leaflet-tile-loaded'))");
  if (deployed) {
    for (const [file, expected] of [["app.js", appSource], ["engine.js", engineSource]]) {
      assert.ok(servedScripts.has(file), file + " must be served by the page");
      const response = await page("Network.getResponseBody", { requestId: servedScripts.get(file) });
      const actual = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
      assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex"), file + " must match local source");
    }
    await evaluate(instrumentation);
  }
  assert.deepEqual([...overrides].sort(), deployed ? [] : ["app.js", "comparison.js", "engine.js", "index.html", "storage.js"]);
  console.log(deployed ? "Loaded actual deployed Leaflet/Draw and verified source bytes; no overrides." : "Loaded real Leaflet/Draw with local source overrides in an isolated profile.");
  const initial = await counts();
  await evaluate("(() => { for (let i = 0; i < 5; i++) document.querySelector('#relList .active').click(); })()");
  const unchangedRelease = difference(initial, await counts());
  assert.ok(Object.values(unchangedRelease).every(count => count === 0), JSON.stringify(unchangedRelease));
  await evaluate("(() => { const input = document.querySelector('#relList [data-c]'); input.checked = true; input.dispatchEvent(new Event('change')); document.querySelectorAll('#relList [data-r]')[1].click(); })()");
  const changedRelease = difference(initial, await counts());
  assert.equal(changedRelease.tileLayers, 0); assert.equal(changedRelease.tileUrls, 1); assert.equal(changedRelease.fits, 0);
  assert.equal(await evaluate("document.querySelector('#relList [data-c]').checked"), true);
  await evaluate("document.querySelector('#relList [data-r]').click()");
  await evaluate(`(() => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Review_small' }, geometry: { type: 'Polygon', coordinates: [[[55.36,25.25],[55.362,25.25],[55.362,25.252],[55.36,25.252],[55.36,25.25]]] } }] };
    if (${selection}) fc.features.push({ ...fc.features[0], properties: { name: 'Do_not_run' },
      geometry: { type:'Polygon', coordinates:fc.features[0].geometry.coordinates.map(ring => ring.map(([x,y]) => [x+0.02,y])) } });
    const files = new DataTransfer(); files.items.add(new File([JSON.stringify(fc)], 'review.geojson', { type: 'application/geo+json' }));
    const input = document.querySelector('#fileIn'); input.files = files.files; input.dispatchEvent(new Event('change'));
    document.querySelector('#detectOn').checked = false; document.querySelector('#tifOn').checked = false;
  })()`);
  // AOI import now preserves the current view. Navigation is an explicit user
  // action, and also exposes the real map instance to the existing fit spy.
  await until("Boolean(document.querySelector('#aoiList [data-aoi-zoom]'))");
  await evaluate("document.querySelector('#aoiList [data-aoi-zoom]').click()");
  let runSelection, childPanel;
  if (selection) {
    await until("document.querySelector('#runN').textContent === '2'");
    await evaluate("document.querySelector('[data-tab=det]').click(); document.querySelector('#runAoiBtn').click()");
    await until("!document.querySelector('#runAoiPanel').hidden");
    childPanel = await evaluate(`(() => {
      const panel=document.querySelector('#runAoiPanel'), button=document.querySelector('#runAoiBtn'), run=document.querySelector('#runBtn');
      return { focused:document.activeElement.id, inlineSelector:document.querySelector('#tab-det #runAoiList')!==null,
        adjacent:button.parentElement===run.parentElement, columns:[...panel.querySelectorAll('th')].map(node=>node.textContent),
        withinSidebar:Boolean(panel.closest('aside.panel')), normalControlsHidden:getComputedStyle(document.querySelector('#tab-det')).display==='none',
        noModal:!document.querySelector('dialog:modal') };
    })()`);
    assert.equal(childPanel.focused,'runAoiSearch'); assert.equal(childPanel.inlineSelector,false); assert.equal(childPanel.adjacent,true);
    assert.equal(childPanel.withinSidebar,true); assert.equal(childPanel.normalControlsHidden,true); assert.equal(childPanel.noModal,true);
    assert.deepEqual(childPanel.columns,['Process','AOI name','Map']);
    const layout = () => evaluate(`(() => {
      const panel=document.querySelector('#runAoiPanel').getBoundingClientRect(), sidebar=document.querySelector('aside.panel').getBoundingClientRect(),
        map=document.querySelector('#map'), view=map.getBoundingClientRect();
      return {width:panel.width,height:panel.height,withinSidebar:panel.left>=sidebar.left&&panel.right<=sidebar.right+1&&panel.bottom<=sidebar.bottom+1,
        mapUncovered:panel.right<=view.left+1||panel.top>=view.bottom-1,
        mapHit:map.contains(document.elementFromPoint(view.left+view.width/2,view.top+view.height/2)),mapHeight:view.height};
    })()`);
    childPanel.desktop = await layout(); assert.equal(childPanel.desktop.withinSidebar,true);
    assert.equal(childPanel.desktop.mapUncovered,true); assert.equal(childPanel.desktop.mapHit,true);
    const desktop = await page('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(os.tmpdir(),'geomap-gmd022-panel-desktop.png'),Buffer.from(desktop.data,'base64'));
    await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await until("__gmd003.map.getSize().x === __gmd003.map.getContainer().clientWidth");
    childPanel.mobile = await layout(); assert.equal(childPanel.mobile.withinSidebar,true);
    assert.equal(childPanel.mobile.mapUncovered,true); assert.equal(childPanel.mobile.mapHit,true); assert.ok(childPanel.mobile.mapHeight>0);
    const mobile = await page('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(os.tmpdir(),'geomap-gmd022-panel-mobile.png'),Buffer.from(mobile.data,'base64'));
    await page('Emulation.clearDeviceMetricsOverride');
    await until("__gmd003.map.getSize().x === __gmd003.map.getContainer().clientWidth");
    await until("!__gmd003.map._animatingZoom && !__gmd003.map._panAnim?._inProgress");
    const zoomBefore = await evaluate("__gmd003.map.getZoom()");
    const zoomControl = await evaluate("(() => {const r=document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    await page('Input.dispatchMouseEvent',{type:'mousePressed',...zoomControl,button:'left',clickCount:1});
    await page('Input.dispatchMouseEvent',{type:'mouseReleased',...zoomControl,button:'left',clickCount:1});
    await until(`__gmd003.map.getZoom()===${zoomBefore+1} && !__gmd003.map._animatingZoom`);
    assert.equal(await evaluate("document.querySelector('#runAoiPanel').hidden"),false);
    const pan = await evaluate("(() => {const r=document.querySelector('#map').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,lng:__gmd003.map.getCenter().lng};})()");
    await page('Input.dispatchMouseEvent',{type:'mousePressed',x:pan.x,y:pan.y,button:'left',clickCount:1});
    await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:pan.x+70,y:pan.y,button:'left',buttons:1});
    await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:pan.x+70,y:pan.y,button:'left',clickCount:1});
    await until(`Math.abs(__gmd003.map.getCenter().lng-${pan.lng})>0.00001 && !__gmd003.map._panAnim?._inProgress`);
    assert.equal(await evaluate("document.querySelector('#runAoiPanel').hidden"),false);
    childPanel.mapControlsInteractive=true; childPanel.mapDragInteractive=true;
    await evaluate("(() => {const search=document.querySelector('#runAoiSearch'); search.value='DO_NOT';search.dispatchEvent(new Event('input'));})()");
    assert.equal(await evaluate("document.querySelectorAll('#runAoiList [data-run-aoi]').length"),1);
    assert.equal(await evaluate("document.querySelector('#runAoiList [data-run-aoi]').dataset.runAoi"),'1');
    await evaluate("document.querySelector('#runAoiList [data-run-zoom]').click()");
    await until("!document.querySelector('#runAoiPanel').hidden && !__gmd003.map._animatingZoom && !__gmd003.map._panAnim?._inProgress && Math.abs(__gmd003.map.getCenter().lng-55.381)<0.002");
    childPanel.zoom = await evaluate("({centre:[__gmd003.map.getCenter().lng,__gmd003.map.getCenter().lat],selected:document.querySelector('#runN').textContent,focus:document.activeElement.id,active:document.querySelector('#aoiList .active .t').textContent,staysOpen:!document.querySelector('#runAoiPanel').hidden,search:document.querySelector('#runAoiSearch').value})");
    assert.equal(childPanel.zoom.active,'Do_not_run'); assert.ok(Math.abs(childPanel.zoom.centre[0]-55.381)<0.002,JSON.stringify(childPanel.zoom));
    assert.equal(childPanel.zoom.selected,'2'); assert.equal(childPanel.zoom.focus,'map'); assert.equal(childPanel.zoom.staysOpen,true);
    assert.equal(childPanel.zoom.search,'DO_NOT');
    await evaluate("document.querySelector('#runAoiNone').click()");
    assert.equal(await evaluate("document.querySelector('#runBtn').disabled"), true);
    await evaluate("(() => {const search=document.querySelector('#runAoiSearch'); search.value='not found';search.dispatchEvent(new Event('input'));})()");
    assert.equal(await evaluate("document.querySelectorAll('#runAoiList [data-run-aoi]').length"),0);
    await evaluate("(() => {const search=document.querySelector('#runAoiSearch'); search.value='review';search.dispatchEvent(new Event('input'));})()");
    await evaluate("document.querySelector('#runAoiList input').click()");
    runSelection = { imported:2, selectedAtStart:Number(await evaluate("document.querySelector('#runN').textContent")) };
    assert.equal(runSelection.imported, 2); assert.equal(runSelection.selectedAtStart, 1);
    await evaluate("(() => {const search=document.querySelector('#runAoiSearch'); search.value='';search.dispatchEvent(new Event('input'));})()");
    await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await page('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until("document.querySelector('#runAoiPanel').hidden");
    childPanel.escapeFocus = await evaluate("document.activeElement.id"); assert.equal(childPanel.escapeFocus,'runAoiBtn');
    await evaluate("document.querySelector('#runAoiBtn').click();document.querySelector('#runAoiDone').click()");
  }
  await until("document.querySelector('#runN').textContent === '1'");
  await evaluate("document.querySelector('#runBtn').click()");
  if (selection) {
    await evaluate("document.querySelector('#runAoiBtn').click();document.querySelector('#runAoiAll').click();document.querySelector('#runAoiDone').click()");
    runSelection.runningButtonDisabled = await evaluate("document.querySelector('#runBtn').disabled");
    assert.equal(runSelection.runningButtonDisabled, false);
  }
  await until("/Finished:|ERROR:/.test(document.querySelector('#jobLog').textContent)");
  const jobLog = await evaluate("document.querySelector('#jobLog').textContent");
  assert.ok(!jobLog.includes("ERROR:"), jobLog);
  if (selection) {
    assert.match(jobLog, /\[1\/1\] Review_small/); assert.doesNotMatch(jobLog, /Do_not_run/);
    assert.match(jobLog, /across 1 AOI\/date clips/);
    runSelection.excludedAoiProcessed = false; runSelection.jobClips = 1;
    assert.equal(await evaluate("document.querySelector('#runN').textContent"), '2');
  }
  await evaluate(`(async () => {
    const release = (await GVEngine.getReleases())[0].release;
    const features = [{
      type: 'Feature', id: 'manual_gmd003', geometry: { type: 'Polygon', coordinates: [[[55.3605,25.2505],[55.361,25.2505],[55.361,25.251],[55.3605,25.251],[55.3605,25.2505]]] },
      properties: { class: 'aircraft', status: 'manual', release, aoi_id: 'Review_small',
        ...(${detectionClick} ? {confidence:'0.91',centroid:['55.36075','25.25075']} : {centroid:[55.36075,25.25075]}) }
    }];
    const jobId=document.querySelector('#jobSel').value;
    if (__gmd003.repository) {
      const saved=await __gmd003.repository.restore(),job=saved.jobs.find(j=>j.id===jobId),clip=job.results[0];
      await __gmd003.repository.saveReviews(clip.storeId,jobId,clip.aoiId,features);
    } else if(window.GVStorage) {
      // Deployed mode runs instrumentation after boot. Seed only this isolated
      // test profile through native IndexedDB, using the same scoped schema.
      const database=await new Promise((resolve,reject)=>{const r=indexedDB.open(GVStorage.NAME);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const rows=await new Promise(resolve=>{const r=database.transaction('results').objectStore('results').index('jobId').getAll(jobId);r.onsuccess=()=>resolve(r.result)});
      await new Promise((resolve,reject)=>{const tx=database.transaction('reviews','readwrite');features.forEach((feature,i)=>tx.objectStore('reviews').put({id:rows[0].storeId+':'+i,scope:rows[0].storeId,jobId,feature}));tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});database.close();
    } else localStorage.setItem('gv_ann',JSON.stringify({type:'FeatureCollection',features}));
    document.querySelector('#resTable tbody tr[data-i]').click();
  })()`);
  await until("Boolean(__gmd003.detection && document.querySelector('.leaflet-image-layer'))");
  // The deliberate clip fit can still be animating when its data is ready.
  // Set the test viewport only after that animation, independently of toggles.
  await until("!__gmd003.detection._map._animatingZoom && !__gmd003.detection._map._panAnim?._inProgress");
  let detectionPointer;
  if (detectionClick) {
    // AOI redraws used to move their SVG paths in front of detections. Use a
    // real pointer event here; layer.fire('click') bypasses DOM hit testing.
    await evaluate("document.querySelector('#aoiList .item').click()");
    // Leaflet can schedule the fit animation on the next frame; let it start
    // before waiting for it to finish and establishing the click viewport.
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await until("!__gmd003.detection._map._animatingZoom && !__gmd003.detection._map._panAnim?._inProgress");
    await evaluate("(()=>{__gmd003.detection._map.setView([25.25075,55.36075],20,{animate:false});})()");
    await until("!__gmd003.detection._map._animatingZoom && !__gmd003.detection._map._panAnim?._inProgress");
    detectionPointer = await evaluate(`(() => {
      const layer=__gmd003.detection,map=layer._map,point=map.latLngToContainerPoint(layer.getBounds().getCenter()),box=map.getContainer().getBoundingClientRect();
      const x=point.x+box.left,y=point.y+box.top;return {x,y,zoomBefore:map.getZoom(),fitsBefore:__gmd003.counts.fits,hitDetection:document.elementFromPoint(x,y)===layer.getElement()};
    })()`);
    await page('Input.dispatchMouseEvent',{type:'mousePressed',x:detectionPointer.x,y:detectionPointer.y,button:'left',clickCount:1});
    await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:detectionPointer.x,y:detectionPointer.y,button:'left',clickCount:1});
    await sleep(500);
    Object.assign(detectionPointer,await evaluate("({zoomAfter:__gmd003.detection._map.getZoom(),fitsAfter:__gmd003.counts.fits,infoShown:document.querySelector('#tab-ann').classList.contains('on')&&Boolean(document.querySelector('#selClass')),card:document.querySelector('#selCard').textContent})"));
    fs.writeFileSync(path.join(os.tmpdir(),'geomap-detection-click.json'),JSON.stringify(detectionPointer,null,2)+'\n');
    console.log('Real detection pointer check: '+JSON.stringify(detectionPointer));
    assert.equal(detectionPointer.hitDetection,true,'The detection must receive the click above AOI overlays');
    assert.equal(detectionPointer.infoShown,true);assert.equal(detectionPointer.zoomAfter,detectionPointer.zoomBefore);
    assert.equal(detectionPointer.fitsAfter,detectionPointer.fitsBefore);
    assert.match(detectionPointer.card,/0\.91/); assert.match(detectionPointer.card,/25\.25075, 55\.36075/);
  }
  await evaluate(`(async () => {
    const layer = __gmd003.detection;
    layer.fire('click', { originalEvent: new MouseEvent('click') });
    const select = document.querySelector('#selClass'); select.value = 'ship'; select.dispatchEvent(new Event('change'));
    await document.querySelector('#bEdit').onclick();
    layer.setLatLngs([layer.getLatLngs()[0].map(point => [point.lat + 0.00001, point.lng])]);
    layer.editing.updateMarkers();
    layer._map.setView([25.251,55.361], 18, { animate: false });
  })()`);
  await until("!__gmd003.detection._map._animatingZoom && !__gmd003.detection._map._panAnim?._inProgress");
  const viewState = () => evaluate(`(() => {
    const layer = __gmd003.detection, map = layer._map;
    return { layer: L.stamp(layer), editing: layer.editing.enabled(), markers: document.querySelectorAll('.leaflet-editing-icon').length,
      className: layer.feature.properties.class, status: layer.feature.properties.status, points: JSON.stringify(layer.getLatLngs()),
      center: [map.getCenter().lat,map.getCenter().lng], zoom: map.getZoom(), card: document.querySelector('#selCard').innerHTML };
  })()`);
  const beforeView = await viewState(), beforeToggle = await counts();
  assert.equal(beforeView.editing, true); assert.equal(beforeView.className, "ship"); assert.ok(beforeView.markers > 0);
  await evaluate("(() => { for (let i = 0; i < 5; i++) { const input = document.querySelector('#showImg'); input.checked = !input.checked; input.dispatchEvent(new Event('change')); } })()");
  await sleep(300);
  const imageToggle = difference(beforeToggle, await counts());
  assert.ok(Object.values(imageToggle).every(count => count === 0), JSON.stringify(imageToggle));
  assert.deepEqual(await viewState(), beforeView);
  assert.equal(await evaluate("document.querySelectorAll('.leaflet-image-layer').length"), 0);
  await evaluate("(() => { const input = document.querySelector('#showImg'); input.checked = true; input.dispatchEvent(new Event('change')); })()");
  assert.equal(await evaluate("document.querySelectorAll('.leaflet-image-layer').length"), 1);
  assert.deepEqual(await viewState(), beforeView);
  assert.deepEqual(errors, []);
  const results = { checkedAt: new Date().toISOString(), mode: deployed ? "Deployed sources, no overrides" : "Local app/engine overrides; not a deployed-source check",
    browser: await evaluate("navigator.userAgent"), appSha256: createHash("sha256").update(appSource).digest("hex"),
    unchangedRelease, changedRelease, imageToggle, editingPreserved: true, runtimeErrors: errors, jobLog,
    ...(selection ? {runSelection, childPanel} : {}), ...(detectionClick ? {detectionPointer} : {}) };
  const output = process.env.GMD_RESULTS_PATH || path.join(os.tmpdir(), selection ? "geomap-gmd022-panel-results.json" : "geomap-gmd003-results.json");
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2)); console.log("Saved browser evidence: " + output);
  await send("Browser.close");
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog); socket?.close();
  if (chrome && chrome.exitCode === null) {
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); chrome.once("exit", () => { clearTimeout(timer); resolve(); }); chrome.kill(); });
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
