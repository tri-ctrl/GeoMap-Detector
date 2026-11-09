const assert = require('node:assert/strict');
const fs = require('node:fs');
module.exports = async ({ page, evaluate, until, errors, result }) => {
  result.mode = 'Local source; real Leaflet/Draw mouse gestures and native AOI persistence; no inference';
  await evaluate(fs.readFileSync(require.resolve('leaflet-draw/dist/leaflet.draw.js'), 'utf8'));
  await evaluate(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(require.resolve('leaflet-draw/dist/leaflet.draw.css'),'utf8'))};document.head.append(style)})()`);
  await evaluate(`(() => {
    const fit=L.Map.prototype.fitBounds;window.__viewportFits=0;L.Map.prototype.fitBounds=function(...args){__viewportFits++;window.__viewportMap=this;return fit.apply(this,args)};
    document.querySelector('#aoiList [data-aoi-zoom]').click();__viewportMap.setView([25.25,55.36],18,{animate:false});
  })()`);
  const view = () => evaluate('({center:[__viewportMap.getCenter().lat,__viewportMap.getCenter().lng],zoom:__viewportMap.getZoom(),fits:__viewportFits})');
  result.before = await view();
  await evaluate(`(() => {const feature={type:'Feature',properties:{name:'Distant'},geometry:{type:'Polygon',coordinates:[[[35,20],[35.1,20],[35.1,20.1],[35,20.1],[35,20]]]}};
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(feature)],'distant.geojson'));const input=document.querySelector('#fileIn');input.files=transfer.files;input.dispatchEvent(new Event('change'))})()`);
  await until("document.querySelector('#runN').textContent==='2'");result.import = await view();assert.deepEqual(result.import,result.before);
  const box = await evaluate("(()=>{const r=document.querySelector('#map').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()");
  const points = [[.4,.4],[.65,.4],[.6,.65]].map(([x,y])=>({x:box.left+box.width*x,y:box.top+box.height*y}));
  // Leaflet.Draw suppresses new vertices for 50ms after a click. Use human-paced
  // gestures rather than sending an entire polygon inside that debounce period.
  const click = async point => { await page('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await page('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await new Promise(resolve=>setTimeout(resolve,100)); };
  await evaluate("document.querySelector('#drawPoly').click()");await until("Boolean(document.querySelector('.leaflet-draw-tooltip'))");
  for(const point of [...points,points[0]])await click(point);
  await until("document.querySelector('#runN').textContent==='3'");result.polygon = await view();assert.deepEqual(result.polygon,result.before);
  await evaluate("document.querySelector('#drawRect').click()");await until("Boolean(document.querySelector('.leaflet-draw-tooltip'))");
  await page('Input.dispatchMouseEvent',{type:'mouseMoved',...points[0]});await page('Input.dispatchMouseEvent',{type:'mousePressed',...points[0],button:'left',clickCount:1});
  await page('Input.dispatchMouseEvent',{type:'mouseMoved',...points[2],button:'left',buttons:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...points[2],button:'left',clickCount:1});
  await until("document.querySelector('#runN').textContent==='4'");result.rectangle=await view();assert.deepEqual(result.rectangle,result.before);
  await click({x:(points[0].x+points[2].x)/2,y:(points[0].y+points[2].y)/2});result.mapClick=await view();assert.deepEqual(result.mapClick,result.before);
  await evaluate("document.querySelector('#aoiList .item').click()");result.listClick=await view();assert.deepEqual(result.listClick,result.before);
  await evaluate("document.querySelectorAll('#aoiList [data-aoi-zoom]')[1].click()");result.explicitZoom=await view();
  assert.equal(result.explicitZoom.fits,result.before.fits+1);assert.ok(Math.abs(result.explicitZoom.center[1]-35.05)<.001);
  await until("document.querySelector('#storageStatus').textContent.startsWith('Saved')");result.persistedAOIs=await evaluate('__repo.restore().then(r=>r.aois.length)');assert.equal(result.persistedAOIs,4);assert.deepEqual(errors,[]);
  console.log('Native polygon/rectangle drawing, import and map/list selection preserve center/zoom; explicit Zoom navigates and all four AOIs persist.');
};
