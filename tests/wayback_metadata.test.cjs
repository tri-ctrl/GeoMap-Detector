const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "../frontend/engine.js"), "utf8");
const key = "gv_wayback_releases_v1";
const entries = [{ release: 101, date: "2026-10-29", title: "World Imagery (Wayback 2026-10-29)" }];
const config = { 101: { itemTitle: entries[0].title } };
function setup({ cached, fetchImpl = async () => new Response(JSON.stringify(config)), unavailable = false } = {}) {
  const saved = new Map([["gv_aois", "preserved AOIs"], ["gv_ann", "preserved reviews"]]);
  if (cached) saved.set(key, typeof cached === "string" ? cached : JSON.stringify(cached));
  const calls = [];
  const context = vm.createContext({ AbortController, DOMException, setTimeout, clearTimeout,
    fetch: (...args) => { calls.push(args); return fetchImpl(...args); },
    localStorage: { getItem: name => { if (unavailable) throw new Error("storage disabled"); return saved.get(name); },
      setItem: (name, value) => { if (unavailable) throw new Error("quota"); saved.set(name, value); } },
  });
  vm.runInContext(source, context);
  return { engine: context.GVEngine, saved, calls };
}
const cache = () => ({ version: 1, fetchedAt: Date.now() - 86400000, releases: entries });

test("validated saved metadata is returned without waiting for a network request", async () => {
  const { engine, calls } = setup({ cached: cache(), fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.equal((await engine.getReleases())[0].release, 101);
  assert.equal(calls.length, 0); assert.equal(engine.releaseCacheInfo().source, "cache");
});
test("refresh is deduplicated, validated and persisted separately from user records", async () => {
  let resolve;
  const { engine, saved, calls } = setup({ cached: cache(), fetchImpl: () => new Promise(ok => { resolve = ok; }) });
  await engine.getReleases();
  const first = engine.getReleases({ refresh: true }), second = engine.getReleases({ refresh: true });
  assert.equal(calls.length, 1); assert.equal(engine.releaseCacheInfo().refreshing, true);
  assert.equal((await engine.getReleases())[0].release, 101);
  resolve(new Response(JSON.stringify({ 102: { itemTitle: "World Imagery (Wayback 2026-11-05)" }, ...config })));
  assert.equal((await first)[0].release, 102); assert.equal((await second)[0].release, 102);
  assert.equal(JSON.parse(saved.get(key)).releases[0].release, 102);
  assert.equal(saved.get("gv_aois"), "preserved AOIs"); assert.equal(saved.get("gv_ann"), "preserved reviews");
  assert.equal(engine.releaseCacheInfo().refreshing, false);
});
test("failed and invalid refreshes preserve the last valid list and cache; retry works", async () => {
  let mode = "http";
  const { engine, saved } = setup({ cached: cache(), fetchImpl: async () => mode === "http"
    ? new Response("failed", { status: 503 }) : new Response(JSON.stringify(mode === "invalid" ? { broken: {} } : config)) });
  await engine.getReleases(); const original = saved.get(key);
  for (mode of ["http", "invalid"]) {
    await assert.rejects(engine.getReleases({ refresh: true }));
    assert.equal((await engine.getReleases())[0].release, 101); assert.equal(saved.get(key), original);
    assert.ok(engine.releaseCacheInfo().error); assert.equal(engine.releaseCacheInfo().refreshing, false);
  }
  mode = "ok"; await engine.getReleases({ refresh: true }); assert.equal(engine.releaseCacheInfo().error, null);
});
test("corrupt, oversized, incompatible and malformed saved metadata cannot replace network metadata", async () => {
  for (const cached of ["{", " ".repeat(1000001), { ...cache(), version: 2 }, { ...cache(), fetchedAt: -1 },
    { ...cache(), releases: [] }, { ...cache(), releases: entries.concat(entries) },
    { ...cache(), releases: [{ ...entries[0], date: "2026-02-31" }] }]) {
    const { engine, calls } = setup({ cached });
    assert.equal((await engine.getReleases())[0].release, 101); assert.equal(calls.length, 1);
    assert.equal(engine.releaseCacheInfo().source, "network");
  }
});
test("unavailable local storage does not prevent valid network metadata", async () => {
  const { engine } = setup({ unavailable: true });
  assert.equal((await engine.getReleases())[0].release, 101);
});
test("page-owned metadata cancellation terminates its request and permits a retry", async () => {
  let cancelled = false, attempts = 0;
  const { engine } = setup({ fetchImpl: (_url, { signal }) => ++attempts > 1 ? Promise.resolve(new Response(JSON.stringify(config))) : new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
  }) });
  const pending = engine.getReleases(); engine.cancelReleaseRefresh();
  await assert.rejects(pending, { name: "AbortError" }); assert.ok(cancelled);
  assert.equal(engine.releaseCacheInfo().refreshing, false);
  assert.equal((await engine.getReleases())[0].release, 101); assert.equal(attempts, 2);
});
test("local lookup cancellation stops further requests", async () => {
  const controller = new AbortController(); let tiles = 0;
  const { engine } = setup({ cached: { ...cache(), releases: entries.concat({ release: 100, date: "2026-10-22", title: "older" }) },
    fetchImpl: async () => { tiles++; controller.abort(); return new Response(JSON.stringify({ data: [1], select: [101] })); } });
  await assert.rejects(engine.localChanges(55, 25, 17, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(tiles, 1);
});
test("local lookup follows effective-release jumps without inventing intermediate updates", async () => {
  const queried = [];
  const { engine } = setup({ cached: { ...cache(), releases: entries.concat(
    { release: 100, date: "2026-10-22", title: "older" }, { release: 99, date: "2026-10-15", title: "oldest" }) },
    fetchImpl: async url => { queried.push(url); return new Response(JSON.stringify({ data: [1], select: [url.includes('/101/') ? 100 : 99] })); } });
  assert.deepEqual(Array.from(await engine.localChanges(55, 25), entry => entry.release), [100, 99]);
  assert.equal(queried.length, 2); assert.ok(queried[0].includes('/101/')); assert.ok(queried[1].includes('/99/'));
});
test("a failed local lookup cannot silently return partial historical hits", async () => {
  const { engine } = setup({ cached: cache(), fetchImpl: async () => new Response("failed", { status: 500 }) });
  await assert.rejects(engine.localChanges(55, 25), /HTTP 500/);
});
test("malformed local tile metadata is rejected rather than marked as a valid update", async () => {
  for (const value of [{}, { data: "invalid" }, { data: [2] }]) {
    const { engine } = setup({ cached: cache(), fetchImpl: async () => new Response(JSON.stringify(value)) });
    await assert.rejects(engine.localChanges(55, 25), /Invalid Wayback/);
  }
});
