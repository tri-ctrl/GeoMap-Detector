const assert = require("node:assert/strict");
const test = require("node:test");
const { setup, aoi, releases, turn } = require("./helpers/app.cjs");
const other = { ...aoi, properties: { name: "Other" } };
const boxes = app => app.element("#runAoiList").querySelectorAll("[data-run-aoi]");
function check(app, index, checked) { const checkbox = boxes(app)[index]; checkbox.checked = checked; checkbox.onchange(); }
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

test("existing AOIs default to checked; Detect count and empty-selection guard reflect the checked subset", async () => {
  const app = await setup({ aois: [aoi, other] });
  assert.equal(boxes(app).length, 2); assert.ok(boxes(app).every(checkbox => checkbox.checked));
  assert.equal(app.element("#runN").textContent, 2);
  check(app, 0, false); assert.equal(app.element("#runN").textContent, 1);
  assert.equal(app.element("#runAoiCount").textContent, "1 of 2 selected");
  app.element("#runAoiNone").onclick();
  assert.equal(app.element("#runN").textContent, 0); assert.equal(app.element("#runBtn").disabled, true);
  assert.match(app.element("#runAoiHint").textContent, /Select at least one/);
  const before = app.requests.length; await app.element("#runBtn").onclick();
  assert.equal(app.requests.length, before); assert.equal(app.element("#jobLog").textContent, "");
  app.element("#runAoiAll").onclick(); assert.equal(app.element("#runN").textContent, 2);
  assert.equal(app.element("#runBtn").disabled, false);
});
test("map AOI selection and Detect checkboxes operate independently without rebuilding map layers", async () => {
  const app = await setup({ aois: [aoi, other] });
  app.selectAoi(1); assert.equal(app.element("#runN").textContent, 2);
  const before = app.snapshot(); check(app, 1, false);
  assert.deepEqual(app.snapshot(), before); assert.equal(app.element("#runN").textContent, 1);
  app.selectAoi(1); assert.equal(boxes(app)[1].checked, false);
});
test("browser jobs and exported job AOIs contain only the checked subset", async () => {
  const processed = []; let exported;
  const app = await setup({ aois: [aoi, other], selected: true, beforeBoot: context => {
    const original = context.GVEngine.processClip;
    context.GVEngine.processClip = async (feature, release, options) => { processed.push({ name: feature.properties.name, release: release.release }); return original(feature, release, options); };
    context.GVEngine.exportJobZip = async job => { exported = job; return new Blob(["archive"]); };
  } });
  check(app, 1, false); await app.element("#runBtn").onclick(); await turn();
  assert.deepEqual(processed, releases.map(release => ({ name: "Review", release: release.release })));
  await app.element("#expZip").onclick();
  assert.deepEqual(Array.from(exported.aois, feature => feature.properties.name), ["Review"]);
  assert.match(app.element("#jobLog").textContent, /across 2 AOI\/date clips/);
});
test("server job payload includes only the checked AOIs and keeps date/model settings", async () => {
  let body;
  const app = await setup({ server: true, aois: [aoi, other], selected: true, fetchHook: (url, options) => {
    if (url.endsWith('/api/jobs') && options.method === 'POST') body = JSON.parse(options.body);
  } });
  check(app, 0, false); await app.element("#runBtn").onclick(); await turn();
  assert.deepEqual(body.aois.features.map(feature => feature.properties.name), ["Other"]);
  assert.equal(body.release_mode, "selected"); assert.deepEqual(body.releases, [101, 100]);
  assert.equal(body.zoom, 18); assert.equal(body.conf, 0.3); assert.equal(body.model, "model.pt");
});
test("run selection is frozen while another checked subset can be queued independently", async () => {
  const pending = deferred(), processed = [];
  const app = await setup({ aois: [aoi, other], beforeBoot: context => {
    const original = context.GVEngine.processClip;
    context.GVEngine.processClip = async (feature, release, options) => { processed.push(feature.properties.name); await pending.promise; return original(feature, release, options); };
  } });
  check(app, 1, false); const running = app.element("#runBtn").onclick();
  await turn(); assert.deepEqual(processed, ["Review"]);
  app.element("#runAoiAll").onclick(); assert.equal(app.element("#runBtn").disabled, false);
  const queued = app.element("#runBtn").onclick(); await turn(); assert.deepEqual(processed, ["Review"]);
  app.element("#runAoiNone").onclick(); pending.resolve(); await running; await queued;
  assert.deepEqual(processed, ["Review", "Review", "Other"]); assert.equal(app.element("#runBtn").disabled, true);
});
test("duplicate names, rename and deletion do not transfer checkbox selection to a different AOI", async () => {
  const changed = structuredClone(aoi); changed.geometry.coordinates[0][1][0] += 0.01;
  const app = await setup({ aois: [aoi, changed, other] }); check(app, 1, false);
  app.groups[0].getLayers()[0].getLayers()[0].feature.properties.name = "Renamed";
  app.selectAoi(0); assert.equal(boxes(app)[0].checked, true); assert.equal(boxes(app)[1].checked, false);
  app.element("#aoiList").querySelectorAll("[data-del]")[0].onclick();
  assert.equal(boxes(app).length, 2); assert.equal(boxes(app)[0].checked, false); assert.equal(boxes(app)[1].checked, true);
  assert.equal(app.element("#runN").textContent, 1);
});
test("new imports join an all-AOI selection but do not expand a chosen subset; duplicate imports keep choices", async () => {
  for (const subset of [false, true]) {
    const app = await setup({ aois: [aoi, other], fetchHook: url => url.endsWith('sample_aois/uae_airports_ports.geojson')
      ? { ok: true, json: async () => ({ type: "FeatureCollection", features: [aoi, { ...aoi, properties: { name: "New" } }] }) } : null });
    if (subset) check(app, 1, false);
    await app.element("#loadSample").onclick();
    assert.equal(boxes(app).length, 3); assert.equal(boxes(app)[2].checked, !subset);
    assert.equal(app.element("#runN").textContent, subset ? 1 : 3);
    await app.element("#loadSample").onclick(); assert.equal(boxes(app).length, 3);
    assert.equal(boxes(app)[1].checked, !subset);
  }
});
test("clearing AOIs removes run selections and a fresh import restores the default all selection", async () => {
  const app = await setup({ aois: [aoi], fetchHook: url => url.endsWith('sample_aois/uae_airports_ports.geojson')
    ? { ok: true, json: async () => ({ type: "FeatureCollection", features: [other] }) } : null });
  app.element("#clearAoi").onclick();
  assert.equal(boxes(app).length, 0); assert.equal(app.element("#runN").textContent, 0);
  assert.equal(app.element("#runBtn").disabled, true); assert.equal(app.element("#runAoiAll").disabled, true);
  await app.element("#loadSample").onclick(); assert.equal(boxes(app)[0].checked, true);
  assert.equal(app.element("#runN").textContent, 1);
});
test("AOIs button opens a child panel; Back, close and Escape retain checked choices", async () => {
  const app = await setup({ aois: [aoi, other] });
  app.element("#runAoiBtn").onclick(); assert.equal(app.element("#runAoiPanel").hidden, false);
  assert.equal(app.element("#tab-det").classList.contains('on'), false);
  assert.equal(app.context.document.activeElement, app.element("#runAoiSearch"));
  check(app, 1, false); app.element("#runAoiDone").onclick();
  assert.equal(app.element("#runAoiPanel").hidden, true);
  assert.equal(app.element("#tab-det").classList.contains('on'), true);
  assert.equal(app.element("#runAoiBtn").attributes['aria-expanded'], 'false');
  app.element("#runAoiBtn").onclick(); assert.equal(boxes(app)[1].checked, false);
  app.element("#runAoiClose").onclick(); assert.equal(app.element("#runAoiPanel").hidden, true);
  app.element("#runAoiBtn").onclick();
  let prevented = false;
  app.documentEvents.get('keydown')({ key:'Escape',preventDefault() { prevented = true; } });
  assert.equal(app.element("#runAoiPanel").hidden, true); assert.equal(app.element("#runN").textContent, 1);
  assert.ok(prevented); assert.equal(app.context.document.activeElement,app.element('#runAoiBtn'));
});
test("AOI name search filters without dropping hidden selections and controls target original rows", async () => {
  const app = await setup({ aois: [aoi, other] }); app.element("#runAoiBtn").onclick();
  app.element("#runAoiSearch").value = "  oThEr  "; app.element("#runAoiSearch").oninput();
  assert.equal(boxes(app).length, 1); assert.equal(boxes(app)[0].dataset.runAoi, '1');
  assert.equal(app.element("#runAoiMatches").textContent, "Showing 1 of 2 AOIs");
  check(app, 0, false); assert.equal(app.element("#runN").textContent, 1);
  app.element("#runAoiSearch").value = "no match"; app.element("#runAoiSearch").oninput();
  assert.equal(boxes(app).length, 0); assert.match(app.element("#runAoiList").innerHTML, /No AOIs match/);
  assert.equal(app.element("#runBtn").disabled, false);
  app.element("#runAoiAll").onclick(); assert.equal(app.element("#runN").textContent, 2);
  app.element("#runAoiSearch").value = ""; app.element("#runAoiSearch").oninput();
  assert.ok(boxes(app).every(checkbox => checkbox.checked));
});
test("Zoom targets the filtered AOI while keeping its child panel open and preserving processing choices", async () => {
  const app = await setup({ aois: [aoi, other] }); check(app, 1, false);
  app.element("#runAoiBtn").onclick(); app.element("#runAoiSearch").value = "Other"; app.element("#runAoiSearch").oninput();
  const before = app.snapshot(); app.element("#runAoiList").querySelectorAll("[data-run-zoom]")[0].onclick();
  assert.equal(app.snapshot().fits, before.fits + 1); assert.equal(app.tiles.length, before.tiles);
  assert.equal(app.element("#runAoiPanel").hidden, false); assert.equal(app.element("#runN").textContent, 1);
  assert.match(app.element("#aoiList").children[1].className, /active/);
  assert.equal(app.context.document.activeElement, app.element("#map"));
  assert.equal(boxes(app)[0].checked, false); assert.equal(app.element('#runAoiSearch').value,'Other');
});
test("annotation keyboard shortcuts stay inactive while the AOI child panel is open", async () => {
  const app = await setup(); await app.openClip();
  const selected = app.groups[2].getLayers()[0]; selected.fire("click");
  app.element("#runAoiBtn").onclick();
  const key = () => app.documentEvents.get("keydown")({ key: "a", target: { matches: () => false } });
  key(); assert.equal(selected.feature.properties.status, "predicted");
  app.element("#runAoiDone").onclick(); key(); assert.equal(selected.feature.properties.status, "verified");
});
test("navigating to another tab dismisses the child panel without changing processing choices", async () => {
  const app = await setup({ aois:[aoi,other] }); check(app,1,false);
  app.element('#runAoiBtn').onclick();
  app.context.document.querySelectorAll('.rail [data-tab]').find(button=>button.dataset.tab==='img').onclick();
  assert.equal(app.element('#runAoiPanel').hidden,true);
  assert.equal(app.element('#tab-det').classList.contains('on'),false);
  assert.equal(app.element('#tab-img').classList.contains('on'),true);
  assert.equal(app.element('#runN').textContent,1);
  app.element('#runAoiBtn').onclick(); assert.equal(boxes(app)[1].checked,false);
});
