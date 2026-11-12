const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
module.exports = async ({ page, evaluate, until, errors, result }) => {
  result.mode = 'Local source; native IndexedDB, Leaflet, PNG decodes and timeline UI; synthetic images/predictions';
  result.seed = await evaluate(`(async()=>{
    const feature=(await __repo.restore()).aois[0],dates=['2026-10-29','2016-04-20','2025-03-27'];
    const clip=await GVEngine.processClip(feature,{release:101,date:dates[0]},{model:__model,classes:['aircraft'],geotiff:false});
    for(let j=0;j<2;j++){
      const job={id:'browser_timeline_'+j,createdAt:Date.UTC(2026,10,10+j),status:'done',progress:1,log:[],outcomes:[],aois:[feature],params:{model:j?'Small':'Nano',model_key:j?'small':'nano',classes:['aircraft'],conf:.3},results:[]};
      for(let i=0;i<dates.length;i++){
        const canvas=new OffscreenCanvas(64,64),g=canvas.getContext('2d');g.fillStyle=['#d02020','#20d020','#2020d0'][i];g.fillRect(0,0,64,64);const png=await canvas.convertToBlob();canvas.width=canvas.height=1;
        const r={...clip,fc:structuredClone(clip.fc),storeId:job.id+':'+i,order:i,aoiFeature:feature,date:dates[i],release:101+i,
          createdAt:job.createdAt+(i+1)*1000,blobs:{display:png,png}};
        r.fc.features[0].properties.frame=dates[i];job.results.push(r);await __repo.saveClip(job,r);
      }
    }
    return {jobs:2,clips:6,earliest:dates[1],latest:dates[0]};
  })()`);
  const origin = await evaluate('performance.timeOrigin'); await page('Page.reload');
  await until(`performance.timeOrigin!==${origin}&&window.GVApp&&document.querySelector('#storageStatus').textContent.startsWith('Saved')&&document.querySelector('#jobSel').options.length===2`);
  result.catalog = await evaluate(`(()=>{
    const fit=L.Map.prototype.fitBounds;window.__storyFits=0;L.Map.prototype.fitBounds=function(...args){__storyFits++;return fit.apply(this,args)};
    window.__story={urls:0,revoked:0,live:new Set(),peakURLs:0,previews:0,peakPreviews:0,activePreviews:0};
    const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);__story.urls++;__story.live.add(url);__story.peakURLs=Math.max(__story.peakURLs,__story.live.size);return url};
    URL.revokeObjectURL=function(url){__story.revoked++;__story.live.delete(url);return revoke.call(this,url)};
    const preview=GVCompare.preview;GVCompare.preview=async(...args)=>{__story.previews++;__story.peakPreviews=Math.max(__story.peakPreviews,++__story.activePreviews);try{return await preview(...args)}finally{__story.activePreviews--}};
    const show=GVCompare.Swipe.prototype.showFrame;GVCompare.Swipe.prototype.showFrame=function(...args){window.__storyView=this;return show.apply(this,args)};
    document.querySelector('[data-tab=res]').click();document.querySelector('#resultView').value='compare';document.querySelector('#resultView').dispatchEvent(new Event('change'));
    return {artifactReads:__repo.state().reads.artifacts||0};
  })()`);
  await until("document.querySelectorAll('[data-compare-row]').length===6&&!document.querySelector('#compareRefresh').disabled");
  result.order = await evaluate("[...document.querySelectorAll('#resTable tbody tr')].map(tr=>({date:tr.cells[2].textContent,created:tr.cells[3].textContent,model:tr.cells[4].textContent}))");
  assert.deepEqual(result.order.map(r=>r.model), ['Small','Small','Small','Nano','Nano','Nano']);
  assert.deepEqual(result.order.map(r=>r.created), result.order.map(r=>r.created).sort().reverse());
  assert.equal(await evaluate('__repo.state().reads.artifacts||0'),result.catalog.artifactReads);
  await evaluate("document.querySelector('#resultView').value='timeline';document.querySelector('#resultView').dispatchEvent(new Event('change'))");
  await until("document.querySelectorAll('[data-compare-row]').length===6&&!document.querySelector('#compareRefresh').disabled");
  await evaluate("document.querySelector('[data-compare-row]').click();document.querySelector('#timelineSelectAOI').click();document.querySelector('#timelineOpen').click()");
  await until("GVApp.diagnostics().timeline.index===0&&!GVApp.diagnostics().timeline.loading");
  result.open = await evaluate(`({label:document.querySelector('#timelineCurrent').textContent,settings:document.querySelector('#compareSettings').textContent,frames:GVApp.diagnostics().timeline.frames,
    divider:getComputedStyle(document.querySelector('[data-compare-handle]')).display,layers:__storyView.layers.length,images:document.querySelectorAll('.gmd-nonexistent,.leaflet-gmd-compare-left-pane img').length,fits:__storyFits})`);
  assert.equal(result.open.frames,6);assert.match(result.open.label,/2016-04-20/);assert.match(result.open.settings,/models.*not verified changes/);
  assert.equal(result.open.divider,'none');assert.equal(result.open.layers,3);assert.equal(result.open.images,1);
  // Await Leaflet's intentional initial fit animation before setting a baseline.
  await new Promise(resolve=>setTimeout(resolve,400));
  await evaluate("void __storyView.map.setView(__storyView.map.getCenter(),18,{animate:false})");
  const position = () => evaluate('({center:[__storyView.map.getCenter().lat,__storyView.map.getCenter().lng],zoom:__storyView.map.getZoom(),fits:__storyFits})');
  result.viewport = await position();
  await evaluate("for(const value of [1,3,2,5]){const slider=document.querySelector('#timelineSlider');slider.value=value;slider.dispatchEvent(new Event('input'))}");
  await until("GVApp.diagnostics().timeline.index===5&&!GVApp.diagnostics().timeline.loading");
  assert.deepEqual(await position(), result.viewport);
  result.newest = await evaluate(`(async()=>{
    const image=document.querySelector('.leaflet-gmd-compare-left-pane img'),canvas=new OffscreenCanvas(1,1),g=canvas.getContext('2d');
    g.drawImage(image,0,0,1,1);const pixel=[...g.getImageData(0,0,1,1).data];canvas.width=canvas.height=1;
    return {label:document.querySelector('#timelineCurrent').textContent,frame:__storyView.layers[2].toGeoJSON().features[0].properties.frame,pixel,previewCalls:__story.previews,liveURLs:__story.live.size};
  })()`);
  assert.match(result.newest.label,/2026-10-29.*Small/);assert.equal(result.newest.frame,'2026-10-29');assert.deepEqual(result.newest.pixel,[208,32,32,255]);
  assert.equal(result.newest.previewCalls,2);assert.equal(result.newest.liveURLs,1);
  await evaluate("document.querySelector('#timelineSpeed').value='1000';document.querySelector('#timelinePlay').click()");
  await until("GVApp.diagnostics().timeline.index===0&&GVApp.diagnostics().timeline.playing");
  await until("GVApp.diagnostics().timeline.index===5&&!GVApp.diagnostics().timeline.playing");
  assert.deepEqual(await position(),result.viewport);
  result.playback = await evaluate('({...GVApp.diagnostics().timeline,previewCalls:__story.previews})');
  // Repeated seek cycles exercise real ImageOverlay listeners/renderers/URLs.
  for(let cycle=0;cycle<10;cycle++){
    await evaluate(`document.querySelector('#timelineSlider').value=${cycle%2};document.querySelector('#timelineSlider').dispatchEvent(new Event('input'))`);
    await until(`GVApp.diagnostics().timeline.index===${cycle%2}&&!GVApp.diagnostics().timeline.loading`);
  }
  const desktop=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'gmd030-timeline-desktop.png'),Buffer.from(desktop.data,'base64'));
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  result.mobile = await evaluate("({viewport:innerWidth,width:document.documentElement.scrollWidth,slider:document.querySelector('#timelineSlider').getBoundingClientRect().width,panel:document.querySelector('aside.panel').getBoundingClientRect().width,trend:getComputedStyle(document.querySelector('#trendSec')).display})");
  assert.ok(result.mobile.width<=result.mobile.viewport);assert.ok(result.mobile.slider>0&&result.mobile.slider<=result.mobile.panel);
  assert.equal(result.mobile.trend,'none');
  // Exercise keyboard range navigation through the native input control.
  await evaluate("document.querySelector('#timelineSlider').focus()");await page('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});await page('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  await until("GVApp.diagnostics().timeline.index===5&&!GVApp.diagnostics().timeline.loading");
  const screenshot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'gmd030-timeline-mobile.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate("document.querySelector('#compareExit').click()");
  result.cleanup = await evaluate(`({created:__story.urls,revoked:__story.revoked,live:__story.live.size,peakURLs:__story.peakURLs,peakPreviews:__story.peakPreviews,layers:__storyView.layers.length,pending:__storyView.pending.size,timeline:GVApp.diagnostics().timeline,allocations:GVEngine.allocations.diagnostics(),rowPayloads:GVApp.diagnostics().comparisonRowPayloads})`);
  assert.equal(result.cleanup.live,0);assert.equal(result.cleanup.created,result.cleanup.revoked);assert.equal(result.cleanup.peakURLs,1);assert.equal(result.cleanup.peakPreviews,1);
  assert.equal(result.cleanup.layers,0);assert.equal(result.cleanup.pending,0);assert.equal(result.cleanup.allocations.reservedBytes,0);assert.equal(result.cleanup.allocations.liveCanvasBytes,0);
  assert.equal(result.cleanup.timeline.frames,0);assert.equal(result.cleanup.timeline.timer,false);assert.equal(result.cleanup.rowPayloads,0);
  assert.deepEqual(errors,[]);
  console.log('Native six-frame timeline: newest-created table, oldest-first playback, rapid/keyboard seeks, unchanged viewport, raw frame identity/pixels, 390px layout and balanced cleanup pass.');
};
