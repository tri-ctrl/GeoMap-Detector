const assert = require("node:assert/strict");
const test = require("node:test");
const { setup, turn } = require("./helpers/app.cjs");

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
