const assert = require("node:assert/strict");
const test = require("node:test");
const { setup, aoi, releases, turn } = require("./helpers/app.cjs");
const other = { ...aoi, properties: { name: "Other" } };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };

test("multiple AOI update badges are separate from the viewed release and checked processing dates", async () => {
  const app = await setup({ selected: true, localChanges: async () => releases });
  app.selectAoi(0); await app.element("#relLocal").onclick();
  assert.equal((app.element("#relList").innerHTML.match(/Imagery update near Review/g) || []).length, 2);
  assert.equal(app.releaseRows().filter(row => row.classList.contains("active")).length, 1);
  assert.equal(app.element("#relList").querySelectorAll("[data-c]").filter(row => row.checked).length, 2);
  assert.match(app.element("#localChangeStatus").textContent, /2 historical imagery updates near Review.*centre tile/);
  assert.equal(app.tiles.length, 1); assert.equal(app.tiles[0].updates.length, 0);
});
test("switching AOIs aborts lookup and rejects a late response without changing map date or checkboxes", async () => {
  const pending = deferred(); let signal;
  const app = await setup({ aois: [aoi, other], selected: true, localChanges: (_x, _y, _z, options) => { signal = options.signal; return pending.promise; } });
  app.selectAoi(0); const lookup = app.element("#relLocal").onclick(); app.selectAoi(1);
  assert.ok(signal.aborted); assert.equal(app.element("#relLocal").disabled, false);
  pending.resolve(releases); await lookup;
  assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
  assert.equal(app.element("#hudRel").textContent, releases[0].date);
  assert.equal(app.element("#relList").querySelectorAll("[data-c]").filter(row => row.checked).length, 2);
});
test("out-of-order lookup completion cannot overwrite newer AOI hits or its busy state", async () => {
  const first = deferred(), second = deferred(); let n = 0;
  const app = await setup({ aois: [aoi, other], localChanges: () => (++n === 1 ? first : second).promise });
  app.selectAoi(0); const old = app.element("#relLocal").onclick();
  app.selectAoi(1); const current = app.element("#relLocal").onclick();
  first.resolve(releases); await old; assert.equal(app.element("#relLocal").disabled, true);
  second.resolve([releases[1]]); await current;
  assert.match(app.element("#relList").innerHTML, /Imagery update near Other/);
  assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near Review/);
});
test("removing or clearing an AOI invalidates its update history", async () => {
  for (const action of [app => app.element("#clearAoi").onclick(), app => app.element("#aoiList").querySelectorAll("[data-del]")[0].onclick()]) {
    const app = await setup({ localChanges: async () => releases });
    app.selectAoi(0); await app.element("#relLocal").onclick(); action(app);
    assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
    assert.equal(app.element("#relLocal").disabled, false);
  }
});
test("changed geometry invalidates hits when AOI state is rendered again", async () => {
  const app = await setup({ localChanges: async () => releases });
  app.selectAoi(0); await app.element("#relLocal").onclick();
  app.groups[0].getLayers()[0].getLayers()[0].feature.geometry.coordinates[0][0][0] += 0.01;
  app.selectAoi(0); assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
});
test("failed local lookup clears previous badges and presents a retryable error", async () => {
  let fail = false;
  const app = await setup({ localChanges: async () => { if (fail) throw new Error("HTTP 503"); return releases; } });
  app.selectAoi(0); await app.element("#relLocal").onclick(); fail = true; await app.element("#relLocal").onclick();
  assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
  assert.match(app.element("#localChangeStatus").textContent, /HTTP 503.*Try again/);
  assert.equal(app.element("#relLocal").disabled, false);
});
test("cached metadata starts the map while refresh is pending and refresh preserves user's viewed/checked releases", async () => {
  const pending = deferred();
  const app = await setup({ selected: true, getReleases: options => options?.refresh ? pending.promise : Promise.resolve(releases),
    beforeBoot: context => { context.GVEngine.releaseCacheInfo = () => ({ source: "cache", fetchedAt: Date.now() - 86400000 }); } });
  assert.equal(app.tiles.length, 1); app.clickRelease(100);
  pending.resolve([{ release: 102, date: "2026-11-05" }, ...releases]); await turn();
  assert.equal(app.element("#hudRel").textContent, releases[1].date);
  assert.equal(app.tiles[0].updates.length, 1); assert.equal(app.tiles.length, 1);
  assert.equal(app.element("#relList").querySelectorAll("[data-c]").filter(row => row.checked).length, 2);
});
test("a slow optional server health check cannot delay basemap initialization", async () => {
  const health = deferred();
  const app = await setup({ server: true, fetchHook: url => url.endsWith("/api/health") ? health.promise : null });
  assert.equal(app.tiles.length, 1);
  health.resolve({ ok: true, json: async () => ({ detector: true }) }); await turn();
});
test("editing a polygon created before lazy drawing loads attaches its editor and survives loader retry", async () => {
  const app = await setup({ drawLoaded: false }); await app.openClip();
  const selected = app.groups[2].getLayers()[0]; selected.fire("click"); delete selected.editing;
  const first = app.element("#bEdit").onclick(); app.context.document.head.children.at(-1).onerror(); await first;
  assert.equal(selected.editing, undefined);
  const second = app.element("#bEdit").onclick();
  app.context.L.Draw = { Polygon: function () {} };
  app.context.L.Edit = { Poly: function () { this.enable = () => { this.active = true; }; } };
  app.context.document.head.children.at(-1).onload(); await second;
  assert.ok(selected.editing.active);
});
test("page hide aborts an owned lookup and page-show recovery restores metadata without replacing the layer", async () => {
  const pending = deferred(); let signal;
  const app = await setup({ localChanges: (_x,_y,_z,options) => { signal = options.signal; return pending.promise; } });
  app.selectAoi(0); const lookup = app.element("#relLocal").onclick(); app.events.get("pagehide")();
  assert.ok(signal.aborted); pending.resolve(releases); await lookup;
  assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
  app.events.get("pageshow")({ persisted: true }); await turn();
  assert.equal(app.tiles.length, 1); assert.equal(app.element("#hudRel").textContent, releases[0].date);
});
test("the optional server lookup also cancels and cannot apply another AOI's late response", async () => {
  const pending = deferred(); let signal;
  const app = await setup({ server: true, aois: [aoi, other], fetchHook: (url,options) => {
    if (url.endsWith('/api/releases/local')) { signal = options.signal; return pending.promise; }
  } });
  app.selectAoi(0); const lookup = app.element("#relLocal").onclick(); app.selectAoi(1); assert.ok(signal.aborted);
  pending.resolve({ ok:true, json:async () => releases }); await lookup;
  assert.doesNotMatch(app.element("#relList").innerHTML, /Imagery update near/);
});
