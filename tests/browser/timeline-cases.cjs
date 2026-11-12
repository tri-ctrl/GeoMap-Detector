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
    __story.transitions=[];const animate=Element.prototype.animate;Element.prototype.animate=function(frames,timing){if(this.classList.contains('leaflet-gmd-timeline-a-pane')||this.classList.contains('leaflet-gmd-timeline-b-pane'))__story.transitions.push({effect:frames[0].clip?'wipe':'fade',duration:timing.duration});return animate.call(this,frames,timing)};
    const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);__story.urls++;__story.live.add(url);__story.peakURLs=Math.max(__story.peakURLs,__story.live.size);return url};
    URL.revokeObjectURL=function(url){__story.revoked++;__story.live.delete(url);return revoke.call(this,url)};
    const preview=GVCompare.preview;GVCompare.preview=async(...args)=>{__story.previews++;__story.peakPreviews=Math.max(__story.peakPreviews,++__story.activePreviews);try{return await preview(...args)}finally{__story.activePreviews--}};
    const show=GVCompare.Timeline.prototype.showFrame;GVCompare.Timeline.prototype.showFrame=function(...args){window.__storyView=this;return show.apply(this,args)};
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
    divider:getComputedStyle(document.querySelector('[data-compare-handle]')).display,layers:__storyView.layers.length,images:document.querySelectorAll('.leaflet-gmd-timeline-a-pane img,.leaflet-gmd-timeline-b-pane img').length,fits:__storyFits})`);
  assert.equal(result.open.frames,6);assert.match(result.open.label,/2016-04-20/);assert.match(result.open.settings,/models.*not verified changes/);
  assert.equal(result.open.divider,'none');assert.equal(result.open.layers,3);assert.equal(result.open.images,1);
  // Await Leaflet's intentional initial fit animation before setting a baseline.
  await new Promise(resolve=>setTimeout(resolve,400));
  await evaluate("void __storyView.map.setView(__storyView.map.getCenter(),18,{animate:false})");
  const position = () => evaluate('({center:[__storyView.map.getCenter().lat,__storyView.map.getCenter().lng],zoom:__storyView.map.getZoom(),fits:__storyFits})');
  result.viewport = await position();
  result.player = await evaluate(`(()=>{const p=document.querySelector('#timelinePlayer').getBoundingClientRect(),m=document.querySelector('#map').getBoundingClientRect();return {centerOffset:(p.left+p.width/2)-(m.left+m.width/2),bottomGap:m.bottom-p.bottom,width:p.width,mapWidth:m.width,inside:p.left>=m.left&&p.right<=m.right&&p.top>=m.top,sidebarPlayer:!!document.querySelector('aside #timelineSlider')}})()`);
  assert.ok(Math.abs(result.player.centerOffset)<1);assert.ok(result.player.bottomGap>=20&&result.player.bottomGap<=40);assert.equal(result.player.inside,true);assert.equal(result.player.sidebarPlayer,false);
  await evaluate("for(const value of [1,3,2,5]){const slider=document.querySelector('#timelineSlider');slider.value=value;slider.dispatchEvent(new Event('input'))}");
  await until("GVApp.diagnostics().timeline.index===5&&!GVApp.diagnostics().timeline.loading");
  assert.deepEqual(await position(), result.viewport);
  result.newest = await evaluate(`(async()=>{
    const image=document.querySelector('.leaflet-gmd-timeline-a-pane img,.leaflet-gmd-timeline-b-pane img'),canvas=new OffscreenCanvas(1,1),g=canvas.getContext('2d');
    g.drawImage(image,0,0,1,1);const pixel=[...g.getImageData(0,0,1,1).data];canvas.width=canvas.height=1;
    return {label:document.querySelector('#timelineCurrent').textContent,frame:__storyView.layers[2].toGeoJSON().features[0].properties.frame,pixel,previewCalls:__story.previews,liveURLs:__story.live.size};
  })()`);
  assert.match(result.newest.label,/2026-10-29.*Small/);assert.equal(result.newest.frame,'2026-10-29');assert.deepEqual(result.newest.pixel,[208,32,32,255]);
  assert.equal(result.newest.previewCalls,2);assert.equal(result.newest.liveURLs,1);
  assert.equal(await evaluate("__story.transitions.some(t=>t.effect==='fade')"),true);
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
  // The sample is a separate UI animation; it never loads or changes a frame.
  await evaluate("document.querySelector('#timelineSettingsToggle').click();document.querySelector('#timelineEffect').value='wipe';document.querySelector('#timelineEffect').dispatchEvent(new Event('change'));document.querySelector('#timelineDuration').value='900';document.querySelector('#timelineDuration').dispatchEvent(new Event('change'));document.querySelector('#timelinePreview').click()");
  await until('GVApp.diagnostics().timelineEffects.sampleAnimations===2');
  result.sample = await evaluate("({index:GVApp.diagnostics().timeline.index,animations:GVApp.diagnostics().timelineEffects.sampleAnimations,keyframes:document.querySelector('#timelineSampleAfter').getAnimations()[0].effect.getKeyframes().map(f=>f.clip)})");
  assert.equal(result.sample.index,1);assert.match(result.sample.keyframes[0],/^rect/);
  await until('GVApp.diagnostics().timelineEffects.sampleAnimations===0&&!GVApp.diagnostics().timelineEffects.sampleTimer');
  await evaluate("document.querySelector('#timelineSettingsClose').click();document.querySelector('#timelineSlider').value=3;document.querySelector('#timelineSlider').dispatchEvent(new Event('input'))");
  await until('GVApp.diagnostics().timelineEffects.transitioning');
  result.wipe = await evaluate('({frames:__storyView.frames.length,urls:__storyView.urls.length,animations:__storyView.transition.animations.length,keyframes:__storyView.transition.animations[0].effect.getKeyframes().map(f=>f.clip)})');
  assert.equal(result.wipe.frames,2);assert.equal(result.wipe.urls,2);assert.equal(result.wipe.animations,2);assert.match(result.wipe.keyframes[0],/^rect/);
  await until('GVApp.diagnostics().timeline.index===3&&!GVApp.diagnostics().timeline.loading');
  assert.deepEqual(await position(),result.viewport);
  const desktop=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'gmd031-timeline-desktop.png'),Buffer.from(desktop.data,'base64'));
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  result.mobile = await evaluate("(()=>{const p=document.querySelector('#timelinePlayer').getBoundingClientRect(),m=document.querySelector('#map').getBoundingClientRect();return {viewport:innerWidth,width:document.documentElement.scrollWidth,slider:document.querySelector('#timelineSlider').getBoundingClientRect().width,player:p.width,map:m.width,centerOffset:p.left+p.width/2-m.left-m.width/2,inside:p.left>=m.left&&p.right<=m.right&&p.top>=m.top&&p.bottom<=m.bottom,trend:getComputedStyle(document.querySelector('#trendSec')).display}})()");
  assert.ok(result.mobile.width<=result.mobile.viewport);assert.ok(result.mobile.slider>0&&result.mobile.slider<=result.mobile.player);assert.ok(Math.abs(result.mobile.centerOffset)<1);assert.equal(result.mobile.inside,true);
  assert.equal(result.mobile.trend,'none');
  // Exercise keyboard range navigation through the native input control.
  await evaluate("document.querySelector('#timelineSlider').focus()");await page('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});await page('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  await until("GVApp.diagnostics().timeline.index===5&&!GVApp.diagnostics().timeline.loading");
  const screenshot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'gmd031-timeline-mobile.png'),Buffer.from(screenshot.data,'base64'));
  const beforeSettings=await position(),button=await evaluate("(()=>{const r=document.querySelector('#timelineSettingsToggle').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
  await page('Input.dispatchMouseEvent',{type:'mousePressed',...button,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...button,button:'left',clickCount:1});
  assert.equal(await evaluate("document.querySelector('#timelineSettings').hidden"),false);assert.deepEqual(await position(),beforeSettings);
  result.mobileSettings = await evaluate("(()=>{const p=document.querySelector('#timelineSettings').getBoundingClientRect(),m=document.querySelector('#map').getBoundingClientRect();return {top:p.top,mapTop:m.top,bottom:p.bottom,mapBottom:m.bottom,centerOffset:p.left+p.width/2-m.left-m.width/2,scrollable:p.height<document.querySelector('#timelineSettings').scrollHeight}})()");
  assert.ok(result.mobileSettings.top>=result.mobileSettings.mapTop);assert.ok(result.mobileSettings.bottom<=result.mobileSettings.mapBottom);
  assert.ok(Math.abs(result.mobileSettings.centerOffset)<1);
  await evaluate("document.querySelector('#timelineEffect').focus()");await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await evaluate("document.querySelector('#timelineSettings').hidden&&document.querySelector('#resultView').value==='timeline'"),true);
  await evaluate("document.querySelector('#timelineSettingsToggle').click();document.querySelector('#timelineEffect').value='none';document.querySelector('#timelineEffect').dispatchEvent(new Event('change'));document.querySelector('#timelineSettingsClose').click()");
  const beforeInstant=await evaluate('__story.transitions.length');
  await evaluate("document.querySelector('#timelineSlider').value=0;document.querySelector('#timelineSlider').dispatchEvent(new Event('input'))");
  await until('GVApp.diagnostics().timeline.index===0&&!GVApp.diagnostics().timeline.loading');
  result.instant=await evaluate("({starts:__story.transitions.length,disabled:document.querySelector('#timelineDuration').disabled,frames:__storyView.frames.length})");
  assert.equal(result.instant.starts,beforeInstant);assert.equal(result.instant.disabled,true);assert.equal(result.instant.frames,1);
  await evaluate("document.querySelector('#timelineSettingsToggle').click();document.querySelector('#timelineEffect').value='wipe';document.querySelector('#timelineEffect').dispatchEvent(new Event('change'))");
  await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until("document.querySelector('#timelineDuration').disabled&&document.querySelector('#timelinePreview').disabled");
  result.reducedMotion=await evaluate("({disabled:document.querySelector('#timelinePreview').disabled,note:document.querySelector('#timelineMotionNote').textContent})");
  await evaluate("document.querySelector('#timelineSettingsClose').click();document.querySelector('#timelineSlider').value=1;document.querySelector('#timelineSlider').dispatchEvent(new Event('input'))");
  await until('GVApp.diagnostics().timeline.index===1&&!GVApp.diagnostics().timeline.loading');
  assert.equal(await evaluate('__story.transitions.length'),beforeInstant);
  await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page('Emulation.setDeviceMetricsOverride',{width:640,height:400,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('#timelineOpen').click()");
  await until('GVApp.diagnostics().timeline.index===0&&!GVApp.diagnostics().timeline.loading');
  await evaluate("document.querySelector('#timelineSettingsToggle').click()");
  result.compact=await evaluate("(()=>{const m=document.querySelector('#map').getBoundingClientRect(),p=document.querySelector('#timelinePlayer').getBoundingClientRect(),s=document.querySelector('#timelineSettings').getBoundingClientRect();return {mapHeight:m.height,playerHeight:p.height,playerInside:p.top>=m.top&&p.bottom<=m.bottom,settingsInside:s.top>=m.top&&s.bottom<=m.bottom,zoom:__storyView.map.getZoom()}})()");
  assert.equal(result.compact.playerInside,true);assert.equal(result.compact.settingsInside,true);assert.ok(Number.isFinite(result.compact.zoom));
  await evaluate("document.querySelector('#timelineSettingsClose').click()");
  await evaluate("document.querySelector('#timelineSlider').value=2;document.querySelector('#timelineSlider').dispatchEvent(new Event('input'))");
  await until('GVApp.diagnostics().timelineEffects.transitioning');
  await evaluate("document.querySelector('#compareExit').click()");
  result.cleanup = await evaluate(`({created:__story.urls,revoked:__story.revoked,live:__story.live.size,peakURLs:__story.peakURLs,peakPreviews:__story.peakPreviews,layers:__storyView.layers.length,pending:__storyView.pending.size,timeline:GVApp.diagnostics().timeline,effects:GVApp.diagnostics().timelineEffects,transitionStarts:__story.transitions.length,allocations:GVEngine.allocations.diagnostics(),rowPayloads:GVApp.diagnostics().comparisonRowPayloads})`);
  assert.equal(result.cleanup.live,0);assert.equal(result.cleanup.created,result.cleanup.revoked);assert.equal(result.cleanup.peakURLs,2);assert.equal(result.cleanup.peakPreviews,1);
  assert.equal(result.cleanup.layers,0);assert.equal(result.cleanup.pending,0);assert.equal(result.cleanup.allocations.reservedBytes,0);assert.equal(result.cleanup.allocations.liveCanvasBytes,0);
  assert.equal(result.cleanup.timeline.frames,0);assert.equal(result.cleanup.timeline.timer,false);assert.equal(result.cleanup.rowPayloads,0);
  assert.equal(result.cleanup.effects.sampleAnimations,0);assert.equal(result.cleanup.effects.sampleTimer,false);assert.equal(result.cleanup.effects.transitioning,false);
  assert.deepEqual(errors,[]);
  console.log('Native map player: bottom-center desktop/mobile layout, fade/wipe/sample/reduced-motion, chronological playback, raw pixels, keyboard/rapid seeks and bounded transition cleanup pass.');
};
