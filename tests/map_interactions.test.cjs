const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
const engineSource = readFileSync(path.join(__dirname, "../frontend/engine.js"), "utf8");
const releases = [{ release: 101, date: "2026-10-29" }, { release: 100, date: "2026-10-22" }];
const aoi = { type: "Feature", properties: { name: "Review" }, geometry: {
  type: "Polygon", coordinates: [[[55.36, 25.25], [55.37, 25.25], [55.37, 25.26], [55.36, 25.25]]],
} };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Exercise the complete, unmodified app through its UI handlers. Only DOM,
// Leaflet, network and clip processing are substituted for deterministic tests.
async function setup({ server = false, selected = false, showImage = true } = {}) {
  const elements = new Map(), groups = [], tiles = [], requests = [];
  const metrics = { fits: 0, geoJSON: 0, annotationReads: 0, removedTiles: 0 };
  class Element {
    constructor(properties = {}) {
      this.dataset = {}; this.style = {}; this.value = ""; this.options = [];
      this.textContent = ""; this.children = []; this._checked = false;
      this._html = ""; this.queries = new Map(); this.classes = new Set();
      this.classList = {
        add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        contains: name => this.classes.has(name),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      };
      Object.assign(this, properties);
    }
    get checked() { return this._checked; }
    set checked(value) {
      if (value && this.radioGroup) this.radioGroup.forEach(radio => { radio._checked = false; });
      this._checked = value;
    }
    get innerHTML() { return this._html; }
    set innerHTML(html) {
      this._html = html; this.queries.clear();
      this.options = [...html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(match => ({
        value: (match[1].match(/value=["']([^"']*)["']/) || [null, match[2]])[1],
      }));
      if (this.options.length && !this.options.some(option => option.value === this.value)) this.value = this.options[0].value;
    }
    querySelectorAll(selector) {
      if (!this.queries.has(selector)) {
        const attribute = selector.match(/\[data-([a-z]+)\]/);
        const children = attribute ? [...this._html.matchAll(new RegExp(`<[^>]+\\bdata-${attribute[1]}="([^"]*)"[^>]*>`, "g"))].map(match => {
          const child = new Element({ dataset: { [attribute[1]]: match[1] }, checked: /\bchecked\b/.test(match[0]) });
          const classes = (match[0].match(/class="([^"]*)"/) || [null, ""])[1];
          classes.split(/\s+/).forEach(name => child.classes.add(name));
          return child;
        }) : [];
        this.queries.set(selector, children);
      }
      return this.queries.get(selector);
    }
    append(child) { this.children.push(child); }
    addEventListener() {}
    setAttribute() {}
    remove() {}
  }
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const tabs = ["aoi", "img", "det", "res", "ann", "trn", "exp"];
  const radioGroup = values => {
    const group = values.map(value => new Element({ value }));
    group.forEach(radio => { radio.radioGroup = group; }); group[0].checked = true;
    return group;
  };
  const modes = radioGroup(["latest", "local", "selected"]), engines = radioGroup(["browser", "server"]);
  const lists = {
    ".rail [data-tab]": tabs.map(tab => new Element({ dataset: { tab } })),
    ".tab": tabs.map(tab => Object.assign(element("#tab-" + tab), { id: "tab-" + tab })),
    "[name=relMode]": modes, "[name=engine]": engines,
  };
  const document = {
    querySelector: element,
    querySelectorAll: selector => selector === "#resTable tr" ? element("#resTable tbody").querySelectorAll("tr[data-i]") : lists[selector] || [],
    createElement: () => new Element(), addEventListener() {},
    documentElement: new Element(), body: new Element(), head: new Element(),
  };
  Object.entries({ "#zoom": "18", "#conf": "0.3", "#maxTiles": "1200", "#bufKm": "3" }).forEach(([key, value]) => { element(key).value = value; });
  element("#showImg").checked = showImage;
  const saved = new Map([["gv_aois", JSON.stringify([aoi])]]);
  if (server) { saved.set("gv_api", JSON.stringify("/server")); saved.set("gv_engine", JSON.stringify("server")); }
  if (selected) { saved.set("gv_relMode", JSON.stringify("selected")); saved.set("gv_selRel", JSON.stringify([101, 100])); }
  const center = { lat: 25.25, lng: 55.36, distanceTo: () => 1000 };
  const bounds = { pad() { return this; }, getCenter: () => center,
    getNorthWest: () => center, getNorthEast: () => center, getSouthWest: () => center };
  class Layer {
    constructor(feature) {
      this.feature = feature; this.handlers = {};
      this.editing = { active: false, enable() { this.active = true; }, disable() { this.active = false; } };
    }
    addTo(group) { group.addLayer(this); return this; }
    on(event, handler) { this.handlers[event] = handler; return this; }
    fire(event) { this.handlers[event]({ originalEvent: {} }); }
    bindTooltip() { return this; }
    getBounds() { return bounds; }
    toGeoJSON() { return this.feature; }
    setStyle(style) { this.style = style; return this; }
  }
  class Group extends Layer {
    constructor() { super(); this.layers = []; }
    addLayer(layer) { this.layers.push(layer); return this; }
    clearLayers() { this.layers = []; return this; }
    removeLayer(layer) { this.layers = this.layers.filter(item => item !== layer); }
    getLayers() { return this.layers; }
    eachLayer(fn) { this.layers.forEach(fn); return this; }
  }
  const map = new Group();
  map.setView = (position, zoom) => { map.position = position; map.zoom = zoom; return map; };
  map.getZoom = () => map.zoom;
  map.fitBounds = () => { metrics.fits++; return map; };
  map.removeLayer = layer => { if (tiles.includes(layer)) metrics.removedTiles++; };
  const makeGroup = () => { const group = new Group(); groups.push(group); return group; };
  const L = {
    map: () => map, featureGroup: makeGroup, layerGroup: makeGroup,
    tileLayer: (url, options) => {
      const layer = new Layer(); layer.url = url; layer.options = options; layer.updates = [];
      layer.setUrl = next => { layer.url = next; layer.updates.push(next); return layer; };
      layer.bringToBack = () => layer; tiles.push(layer); return layer;
    },
    imageOverlay: (url, imageBounds) => Object.assign(new Layer(), { url, bounds: imageBounds }),
    geoJSON: (data, options = {}) => {
      metrics.geoJSON++;
      const group = new Group();
      for (const feature of data.type === "FeatureCollection" ? data.features : [data]) {
        const layer = new Layer(feature); options.onEachFeature?.(feature, layer); group.addLayer(layer);
      }
      return group;
    },
    Draw: { Event: { CREATED: "created" } }, DomEvent: { stopPropagation() {} },
  };
  const featureCollection = release => ({ type: "FeatureCollection", features: [{
    type: "Feature", id: "detection-" + release, geometry: JSON.parse(JSON.stringify(aoi.geometry)),
    properties: { class: "aircraft", confidence: 0.9, status: "predicted", release, aoi_id: "Review" },
  }] });
  const result = release => ({ aoi: "Review", aoi_id: "Review", release: release.release, date: release.date,
    path: "Review/" + release.date, bounds: [55.36, 25.25, 55.37, 25.26], counts: { aircraft: 1 }, total: 1,
    zoom: 18, size: [100, 100], fc: featureCollection(release.release), blobs: { png: new Blob(["test image"]) } });
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    let value;
    if (url.endsWith("/api/health")) value = { ok: true, detector: true };
    else if (url.endsWith("models/models.json")) value = [];
    else if (url.endsWith("/api/models")) value = { models: ["model.pt"], default: "model.pt" };
    else if (url.endsWith("/api/jobs") && options.method === "POST") value = { job_id: "server_job" };
    else if (url.endsWith("/api/jobs")) value = [{ id: "server_job", status: "done" }];
    else if (url.endsWith("/api/jobs/server_job")) value = { status: "done", progress: 1, log: [], results: [result(releases[0])] };
    else if (url.endsWith("/detections.geojson")) value = featureCollection(101);
    else if (url.endsWith("/api/annotations")) value = { type: "FeatureCollection", features: [] };
    else throw new Error("Unexpected request: " + url);
    return { ok: true, json: async () => value };
  };
  let nextUrl = 0;
  const context = vm.createContext({ document, L, fetch, Blob, AbortController, AbortSignal,
    location: { hostname: "test.github.io" }, setTimeout: () => 0,
    localStorage: { getItem: key => { if (key === "gv_ann") metrics.annotationReads++; return saved.get(key) ?? null; }, setItem: (key, value) => saved.set(key, value) },
    URL: { createObjectURL: () => "blob:test-" + ++nextUrl, revokeObjectURL() {} }, addEventListener() {},
  });
  context.window = context; context.self = context;
  vm.runInContext(engineSource, context);
  context.GVEngine.getReleases = async () => releases;
  context.GVEngine.processClip = async (_aoi, release) => result(release);
  vm.runInContext(appSource, context);
  await turn();
  const releaseRows = () => element("#relList").querySelectorAll("[data-r]");
  const clickRelease = release => releaseRows().find(row => row.dataset.r === String(release)).onclick({ target: { matches: () => false } });
  const snapshot = () => ({ ...metrics, tiles: tiles.length, urlUpdates: tiles.reduce((n, layer) => n + layer.updates.length, 0),
    requests: requests.length, annotations: requests.filter(request => request.url.endsWith("/api/annotations")).length });
  async function openClip(index = 0) {
    if (!element("#resTable tbody").querySelectorAll("tr[data-i]").length) { await element("#runBtn").onclick(); await turn(); }
    const rows = element("#resTable tbody").querySelectorAll("tr[data-i]");
    assert.ok(rows[index], "Job should populate the result table");
    await rows[index].onclick();
  }
  const toggle = checked => { element("#showImg").checked = checked; element("#showImg").onchange(); };
  return { element, tiles, groups, map, saved, requests, releaseRows, clickRelease, snapshot, openClip, toggle };
}

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
  app.element("#bEdit").onclick();
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
