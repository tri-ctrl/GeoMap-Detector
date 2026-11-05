const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(__dirname, "../frontend/engine.js"), "utf8"), context);
const { uniqueAois } = context.GVEngine;
const sample = JSON.parse(readFileSync(path.join(__dirname, "../frontend/sample_aois/uae_airports_ports.geojson"), "utf8")).features;

test("loading the UAE sample twice schedules six distinct AOIs", () => {
  const imported = uniqueAois(sample.concat(JSON.parse(JSON.stringify(sample))));
  assert.equal(imported.length, 6);
  assert.deepEqual(Array.from(imported, f => f.properties.name), ["DXB", "SHJ", "AUH", "DWC", "JEA_PORT", "RASHID_PORT"]);
});

test("previously saved duplicate AOIs are removed when restored", () => {
  const saved = JSON.stringify(sample.concat(sample));
  assert.equal(uniqueAois(JSON.parse(saved)).length, 6);
});

test("distinct AOI names, polygons, and metadata are preserved", () => {
  const original = sample[0];
  const renamed = JSON.parse(JSON.stringify(original));
  renamed.properties.name = "DXB review area";
  const resized = JSON.parse(JSON.stringify(original));
  resized.geometry.coordinates[0][1][0] += 0.01;
  const tagged = JSON.parse(JSON.stringify(original));
  tagged.properties.notes = "Separate survey";
  assert.equal(uniqueAois([original, renamed, resized, tagged]).length, 4);
});
