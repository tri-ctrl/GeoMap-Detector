const assert = require("node:assert/strict");
const test = require("node:test");
const { setup, turn, aoi } = require("./helpers/app.cjs");

test("selecting the current release five times leaves the existing basemap untouched", async () => {
  const app = await setup(), initial = app.snapshot(), tile = app.tiles[0];
  for (let i = 0; i < 5; i++) app.clickRelease(101);
  assert.deepEqual(app.snapshot(), initial);
  assert.equal(app.tiles[0], tile);
  assert.equal(app.element("#hudRel").textContent, "2026-10-29");
  assert.equal(tile.options.maxNativeZoom, 19);
  assert.match(tile.options.attribution, /Esri/);
});

test("changing release updates the same tile layer once and preserves checkbox selection", async () => {
  const app = await setup();
  const checked = app.element("#relList").querySelectorAll("[data-c]")[0];
  checked.checked = true; checked.onchange();
  app.clickRelease(100);
  for (let i = 0; i < 5; i++) app.clickRelease(100);
  assert.equal(app.tiles.length, 1);
  assert.equal(app.tiles[0].updates.length, 1);
  assert.match(app.tiles[0].url, /\/100\//);
  assert.equal(app.snapshot().removedTiles, 0);
  assert.equal(app.snapshot().fits, 0);
  assert.equal(app.element("#hudRel").textContent, "2026-10-22");
  assert.ok(app.releaseRows().find(row => row.dataset.r === "100").classList.contains("active"));
  assert.equal(app.element("#relList").querySelectorAll("[data-c]")[0].checked, true);
  app.clickRelease(101);
  assert.equal(app.tiles[0].updates.length, 2);
  assert.match(app.tiles[0].url, /\/101\//);
});

test("browser image toggles preserve viewport, annotations, detection layers and active editing", async () => {
  const app = await setup(); await app.openClip();
  const layer = app.groups[2].getLayers()[0]; layer.fire("click");
  app.element("#selClass").value = "ship";
  app.element("#selClass").onchange({ target: app.element("#selClass") });
  await app.element("#bEdit").onclick();
  app.map.position = [24, 54]; app.map.zoom = 19;
  const initial = app.snapshot(), card = app.element("#selCard").innerHTML;
  for (let i = 0; i < 5; i++) app.toggle(i % 2 !== 0);
  await turn();
  assert.deepEqual(app.snapshot(), initial);
  assert.deepEqual(app.map.position, [24, 54]); assert.equal(app.map.zoom, 19);
  assert.equal(app.groups[2].getLayers()[0], layer);
  assert.equal(layer.feature.properties.class, "ship"); assert.equal(layer.editing.active, true);
  assert.equal(app.element("#selCard").innerHTML, card);
  assert.equal(app.groups[1].getLayers().length, 0);
  app.toggle(true);
  assert.equal(app.groups[1].getLayers().length, 1);
  assert.equal(app.groups[1].getLayers()[0].url, "blob:test-1");
});

test("server result toggles do not fetch annotations or detections again", async () => {
  const app = await setup({ server: true }); await app.openClip();
  const initial = app.snapshot();
  assert.equal(initial.annotations, 1);
  assert.equal(app.requests.filter(request => request.url.endsWith("/detections.geojson")).length, 1);
  assert.equal(app.groups[1].getLayers()[0].url, "/server/outputs/server_job/Review/2026-10-29/image.png");
  for (let i = 0; i < 5; i++) app.toggle(i % 2 !== 0);
  await turn(); assert.deepEqual(app.snapshot(), initial);
  app.toggle(true);
  assert.equal(app.groups[1].getLayers().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.groups[1].getLayers()[0].bounds)), [[25.25, 55.36], [25.26, 55.37]]);
});

test("opening a clip while imagery is hidden still opens its detections and fits once", async () => {
  const app = await setup({ showImage: false }); await app.openClip();
  assert.equal(app.groups[1].getLayers().length, 0);
  assert.equal(app.groups[2].getLayers().length, 1);
  assert.equal(app.snapshot().fits, 1);
  const initial = app.snapshot(); app.toggle(true);
  assert.equal(app.groups[1].getLayers().length, 1);
  assert.deepEqual(app.snapshot(), initial);
});

test("switching clips selects the new release and image without replacing the basemap", async () => {
  const app = await setup({ selected: true }); await app.openClip(0);
  const firstImage = app.groups[1].getLayers()[0].url;
  app.toggle(false); const initial = app.snapshot();
  await app.openClip(1);
  assert.equal(app.tiles.length, 1); assert.equal(app.tiles[0].updates.length, 1);
  assert.equal(app.element("#hudRel").textContent, "2026-10-22");
  assert.equal(app.snapshot().fits, initial.fits + 1);
  assert.equal(app.groups[1].getLayers().length, 0);
  assert.equal(app.groups[2].getLayers()[0].feature.properties.release, 100);
  app.toggle(true);
  assert.notEqual(app.groups[1].getLayers()[0].url, firstImage);
});

test("image visibility changes before a clip is open do not change map state", async () => {
  const app = await setup(), initial = app.snapshot();
  for (let i = 0; i < 5; i++) app.toggle(i % 2 !== 0);
  await turn(); assert.deepEqual(app.snapshot(), initial);
  assert.equal(app.groups[1].getLayers().length, 0);
});

const trendBars = app => app.element("#trend").querySelectorAll("[data-trend-i]");
async function runTrend(options = {}) {
  const app = await setup({ selected: true, ...options });
  await app.element("#runBtn").onclick(); await turn(); return app;
}
test("chronological chart bars open the matching original table row, imagery and detections", async () => {
  const app = await runTrend(), bars = trendBars(app), rows = app.element("#resTable tbody").querySelectorAll("tr[data-i]");
  assert.deepEqual(bars.map(bar => bar.dataset.trendI), ["1", "0"]);
  const initial = app.snapshot(); await bars[0].onclick();
  assert.equal(app.snapshot().fits, initial.fits + 1);
  assert.equal(app.element("#hudRel").textContent, "2026-10-22");
  assert.equal(app.groups[1].getLayers().length, 1);
  assert.equal(app.groups[2].getLayers()[0].feature.properties.release, 100);
  assert.equal(rows[1].classList.contains("sel"), true);
  assert.equal(rows[0].classList.contains("sel"), false);
  assert.equal(bars[0].attributes["aria-pressed"], "true");
  await rows[0].onclick();
  assert.equal(bars[1].classList.contains("selected"), true);
  assert.equal(bars[0].classList.contains("selected"), false);
  assert.equal(bars[0].attributes["aria-pressed"], "false");
});
test("bar hover descriptions contain model, total and per-class counts, escape labels and identify incomplete imagery", async () => {
  const app = await runTrend({ fetchHook: url => url.endsWith("models/models.json")
    ? { ok: true, json: async () => [{ file: "nano.onnx", label: "Nano & <OBB>", names: ["plane"], imgsz: 1024 }] } : null,
    beforeBoot: context => {
      context.document.querySelector("#detectOn").checked = true;
      context.GVEngine.loadModel = async () => ({ provider: "wasm", imgsz: 1024 });
      const process = context.GVEngine.processClip;
      context.GVEngine.processClip = async (...args) => ({ ...await process(...args),
        counts: { aircraft: 112, storage_tank: 3, ship: 9 }, total: 124, missing: 1 });
    } });
  const html = app.element("#trend").innerHTML;
  assert.match(html, /<title>Review · 2026-10-22\nNano &amp; &lt;OBB&gt;\nTotal: 124\n112 aircraft\n3 storage tank\n9 ship\nIncomplete imagery/);
  assert.doesNotMatch(html, /Nano & <OBB>/);
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /aria-label="Review · 2026-10-22; Nano &amp; &lt;OBB&gt;; Total: 124; 112 aircraft/);
});
test("bar keyboard activation uses the same clip loader and preserves hidden imagery", async () => {
  const app = await runTrend({ showImage: false }), bars = trendBars(app);
  let prevented = 0, stopped = 0;
  const press = key => ({ key, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  await bars[0].onkeydown(press("ArrowLeft")); assert.equal(app.snapshot().fits, 0);
  await bars[0].onkeydown(press("Enter"));
  assert.equal(app.groups[1].getLayers().length, 0); assert.equal(app.element("#hudRel").textContent, "2026-10-22");
  await bars[1].onkeydown(press(" "));
  assert.equal(app.element("#hudRel").textContent, "2026-10-29");
  assert.equal(app.snapshot().fits, 2); assert.equal(prevented, 2); assert.equal(stopped, 2);
});
test("bars stay tied to the correct AOI when groups have identical dates and special names", async () => {
  const app = await runTrend({ aois: [{ ...aoi, properties: { name: "__proto__" } }, { ...aoi, properties: { name: "Other" } }],
    beforeBoot: context => {
      const process = context.GVEngine.processClip;
      context.GVEngine.processClip = async (feature, ...args) => ({ ...await process(feature, ...args), aoi: feature.properties.name, aoi_id: context.GVEngine.slug(feature.properties.name) });
    } });
  const bars = trendBars(app); assert.deepEqual(bars.map(bar => bar.dataset.trendI), ["1", "0", "3", "2"]);
  await bars[2].onclick();
  const rows = app.element("#resTable tbody").querySelectorAll("tr[data-i]");
  assert.equal(rows[3].classList.contains("sel"), true); assert.equal(rows.filter(row => row.classList.contains("sel")).length, 1);
  assert.equal(app.element("#hudRel").textContent, "2026-10-22");
});
test("server chart navigation fetches the selected clip once and opens its annotations", async () => {
  const results = [101, 100].map(release => ({ aoi: "Review", aoi_id: "Review", release,
    date: release === 101 ? "2026-10-29" : "2026-10-22", path: "Review/" + release,
    bounds: [55.36, 25.25, 55.37, 25.26], counts: { aircraft: 1 }, total: 1 }));
  const app = await runTrend({ server: true, fetchHook: url => url.endsWith("/api/jobs/server_job")
    ? { ok: true, json: async () => ({ status: "done", progress: 1, log: [], results, params: { model: "nano.pt" } }) } : null });
  const initial = app.snapshot(); await trendBars(app)[0].onclick();
  assert.equal(app.groups[1].getLayers()[0].url, "/server/outputs/server_job/Review/100/image.png");
  assert.equal(app.requests.filter(request => request.url.endsWith("/Review/100/detections.geojson")).length, 1);
  assert.equal(app.snapshot().annotations, initial.annotations + 1); assert.equal(app.snapshot().fits, initial.fits + 1);
});
test("zero-object dates remain actionable and a single-date job clears the previous chart", async () => {
  const app = await runTrend({ beforeBoot: context => {
    const process = context.GVEngine.processClip;
    context.GVEngine.processClip = async (...args) => ({ ...await process(...args), counts: {}, total: 0 });
  } });
  assert.match(app.element("#trend").innerHTML, /<title>Review · 2026-10-22\nImagery only\nTotal: 0<\/title>/);
  await trendBars(app)[0].onclick(); assert.equal(app.element("#hudRel").textContent, "2026-10-22");
  app.context.document.querySelectorAll("[name=relMode]")[0].checked = true;
  await app.element("#runBtn").onclick(); await turn();
  assert.equal(app.element("#trendSec").hidden, true); assert.equal(app.element("#trend").innerHTML, "");
  assert.equal(trendBars(app).length, 0);
});
