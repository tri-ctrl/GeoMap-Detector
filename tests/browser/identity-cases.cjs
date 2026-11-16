/* Native v2 compatibility, explicit legacy recovery and cross-job isolation. */
const assert = require('node:assert/strict');
module.exports = async ({ evaluate, until, reloadDocument, ready, results, firstId }) => {
  const before = await evaluate(`__repo.restore().then(async s=>{const j=s.jobs.find(j=>j.id===${JSON.stringify(firstId)}),a=await __repo.clip(j.results[0].storeId,{images:false});
    const second=s.jobs.find(k=>k.id!==j.id&&k.results.length);return{ids:j.results.map(r=>r.storeId),raw:JSON.stringify(a.fc),legacy:JSON.stringify((await __repo.legacyReviews({includeResolved:true}))[0].feature),
      otherId:second.results[0].storeId,otherRaw:JSON.stringify((await __repo.clip(second.results[0].storeId,{images:false})).fc)}})`);
  const pick = async index => {
    await evaluate(`document.querySelectorAll('#resTable tbody tr[data-i]')[${index}].click()`);
    await until(`GVApp.diagnostics().views.scope===${JSON.stringify(before.ids[index])}&&!GVApp.diagnostics().views.loading`);
    await evaluate("void Object.values(__map._layers).find(l=>l instanceof L.Polygon&&l.options.pane==='gmd-detections').fire('click',{originalEvent:new MouseEvent('click')})");
  };
  await pick(1);
  await evaluate("document.querySelector('#legacyPanel').open=true;document.querySelector('#legacyLoad').click()");
  await until("GVApp.diagnostics().identity.legacyRows===1&&!GVApp.diagnostics().identity.legacyOperation");
  await evaluate("document.querySelector('#legacyLink').click()");
  await until("document.querySelector('#legacyStatus').textContent.includes('imagery releases')&&!GVApp.diagnostics().identity.legacyOperation");
  assert.match(await evaluate("document.querySelector('#storageStatus').textContent"), /^Saved/);
  await pick(0);
  await evaluate("document.querySelector('#legacyLink').click()");
  await until("document.querySelector('#legacyStatus').textContent.includes('Linked and saved')&&!GVApp.diagnostics().identity.legacyOperation");
  const linked = await evaluate(`(async()=>{const a=await __repo.clip(${JSON.stringify(before.ids[0])},{images:false}),original=(await __repo.legacyReviews({includeResolved:true}))[0];
    return {raw:JSON.stringify(a.fc),draftClass:a.draftFC.features[0].properties.class,scope:a.draftFC.features[0].properties.gmd_clip_id,
      original:JSON.stringify(original.feature),verified:!!original.resolution.verifiedAt,unresolved:(await __repo.legacyReviews()).length,
      scopedReviews:(await __repo.reviews(${JSON.stringify(before.ids[0])})).features.length,
      otherRaw:JSON.stringify((await __repo.clip(${JSON.stringify(before.otherId)},{images:false})).fc)}})()`);
  assert.equal(linked.raw, before.raw); assert.equal(linked.otherRaw, before.otherRaw); assert.equal(linked.original, before.legacy);
  assert.equal(linked.draftClass, 'ship'); assert.equal(linked.scope, before.ids[0]); assert.equal(linked.verified, true);
  assert.equal(linked.unresolved, 0); assert.equal(linked.scopedReviews, 1);
  await evaluate("document.querySelector('#legacyPanel').open=false");
  await until('GVApp.diagnostics().identity.legacyRows===0');
  assert.equal(await evaluate("GVApp.diagnostics().memory.protected.legacyReviews||0"), 0);
  await reloadDocument(); await ready();
  const reopened = await evaluate(`__repo.clip(${JSON.stringify(before.ids[0])},{images:false}).then(c=>({raw:JSON.stringify(c.fc),draftClass:c.draftFC.features[0].properties.class}))`);
  assert.equal(reopened.raw, before.raw); assert.equal(reopened.draftClass, 'ship');
  // Restore selection for the driver's deletion/cleanup checks.
  await evaluate(`document.querySelector('#jobSel').value=${JSON.stringify(firstId)};document.querySelector('#jobSel').onchange()`);
  await until("document.querySelectorAll('#resTable tbody tr[data-i]').length===2"); await pick(0);
  results.identity = { method: 'Native DOM/Leaflet/IndexedDB; deterministic predictions, no inference claim', linked, reopened,
    cleanup: await evaluate('GVApp.diagnostics().identity') };
  console.log('GMD-016: native legacy link, retryable mismatch, raw prediction preservation, cross-job isolation and reload passed.');
};
