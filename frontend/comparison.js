/* Read-only, georeferenced result comparison. No inference or export resizing. */
(function (global) {
"use strict";
const abortError = () => new DOMException("Comparison cancelled", "AbortError");
const check = signal => { if (signal?.aborted) throw abortError(); };
const geometryKey = feature => feature?.geometry ? JSON.stringify(feature.geometry) : null;
function modelName(params = {}) { return params.detect === false ? "Imagery only" : params.model || "Unknown model"; }
function validatePair(records, mode) {
  if (records.length !== 2) return { error: "Select two clips in the table to compare." };
  const [a, b] = records;
  if (!a.geometry || a.geometry !== b.geometry) return { error: "Choose two clips with the same AOI geometry." };
  if (mode === "dates") {
    if (!a.date || !b.date || a.date === b.date) return { error: "Choose two different imagery dates." };
    if (a.model !== b.model || (a.modelKey && b.modelKey && a.modelKey !== b.modelKey)) return { error: "Choose the same model to compare dates." };
    const pair = [...records].sort((x, y) => x.date.localeCompare(y.date));
    return { pair, roles: ["Older", "Newer"] };
  }
  if (a.release !== b.release || a.date !== b.date) return { error: "Choose the same imagery release to compare models." };
  if (!a.modelKey || !b.modelKey || a.model === "Unknown model" || b.model === "Unknown model" || a.model === "Imagery only" || b.model === "Imagery only")
    return { error: "Model comparison needs two clips with recorded detection models." };
  if (a.modelKey === b.modelKey) return { error: "Choose two different models." };
  if (a.zoom !== b.zoom) return { error: "Use matching imagery zoom levels to compare models." };
  return { pair: records, roles: ["Model A", "Model B"] };
}
function settingsNote(a, b) {
  const differences = [];
  if (a.zoom !== b.zoom) differences.push("imagery zoom");
  if (a.params.conf !== b.params.conf) differences.push("confidence threshold");
  if (JSON.stringify([...(a.params.classes || [])].sort()) !== JSON.stringify([...(b.params.classes || [])].sort())) differences.push("object classes");
  if (a.params.imgsz && b.params.imgsz && a.params.imgsz !== b.params.imgsz) differences.push("model input size");
  if (a.missing || b.missing) differences.push("missing imagery tiles");
  return differences.length ? "Runs differ in " + differences.join(", ") + ". Counts alone do not establish model accuracy or real-world change." : "Model predictions · matching recorded settings. Counts are not verified changes.";
}
async function preview(blob, size, signal) {
  check(signal);
  let bitmap, canvas;
  try {
    const scale = size?.length === 2 ? Math.min(1, 2048 / Math.max(...size)) : null;
    bitmap = await createImageBitmap(blob, scale ? { resizeWidth: Math.max(1, Math.round(size[0] * scale)), resizeHeight: Math.max(1, Math.round(size[1] * scale)), resizeQuality: "high" } : {});
    check(signal);
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio)), height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const image = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not prepare comparison image")), "image/png"));
    check(signal); return { blob: image, size: [width, height] };
  } finally { bitmap?.close(); if (canvas) canvas.width = canvas.height = 1; }
}

class Swipe {
  constructor(map, element, leaflet = global.L) {
    this.map = map; this.element = element; this.L = leaflet; this.position = 50;
    this.layers = []; this.urls = []; this.pending = new Set(); this.active = false;
    // Two empty panes are map-owned and reused. Every pair owns its renderers,
    // image/vector layers, load timers and object URLs, all released by stop().
    this.panes = ["gmd-compare-left", "gmd-compare-right"].map((name, index) => {
      const pane = map.getPane(name) || map.createPane(name);
      pane.style.zIndex = String(450 + index); pane.style.pointerEvents = "none";
      return { name, pane };
    });
    this.handle = element.querySelector("[data-compare-handle]");
    this.clip = () => {
      if (!this.active) return;
      const size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint([size.x, size.y]);
      const x = nw.x + size.x * this.position / 100;
      this.panes[0].pane.style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
      this.panes[1].pane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
      element.style.setProperty("--compare-x", `${this.position}%`);
      this.handle.setAttribute("aria-valuenow", String(Math.round(this.position)));
    };
    this.pointer = event => {
      if (!this.active) return;
      const bounds = map.getContainer().getBoundingClientRect();
      this.setPosition((event.clientX - bounds.left) / bounds.width * 100);
    };
    this.down = event => { if (!this.active) return; event.preventDefault(); this.dragging = event.pointerId; this.handle.setPointerCapture(event.pointerId); this.pointer(event); };
    this.move = event => { if (event.pointerId === this.dragging) this.pointer(event); };
    this.up = event => { if (event.pointerId === this.dragging) { this.handle.releasePointerCapture(event.pointerId); this.dragging = null; } };
    this.key = event => {
      const values = { ArrowLeft: this.position - 2, ArrowRight: this.position + 2, Home: 0, End: 100 };
      if (this.active && event.key in values) { event.preventDefault(); event.stopPropagation(); this.setPosition(values[event.key]); }
    };
    for (const [name, listener] of [["pointerdown", this.down], ["pointermove", this.move], ["pointerup", this.up], ["pointercancel", this.up], ["keydown", this.key]]) this.handle.addEventListener(name, listener);
  }
  setPosition(value) { this.position = Math.max(0, Math.min(100, Number(value))); this.clip(); }
  async show(sides, style) {
    this.stop(); this.active = true; this.element.hidden = false;
    this.map.on("move zoom resize viewreset", this.clip);
    try {
      const loads = sides.map((side, index) => {
        const url = URL.createObjectURL(side.preview.blob); this.urls.push(url);
        const pane = this.panes[index].name;
        const image = this.L.imageOverlay(url, side.bounds, { pane, interactive: false });
        const ready = new Promise((resolve, reject) => {
          let timer;
          const finish = error => {
            clearTimeout(timer); image.off("load", loaded); image.off("error", failed); this.pending.delete(cancel);
            error ? reject(error) : resolve();
          };
          const loaded = () => finish(), failed = () => finish(new Error("Could not display a comparison image")), cancel = () => finish(abortError());
          this.pending.add(cancel); image.on("load", loaded); image.on("error", failed);
          timer = setTimeout(() => finish(new Error("Comparison image timed out")), 15000);
        });
        this.layers.push(image); image.addTo(this.map);
        const renderer = this.L.svg({ pane }); this.layers.push(renderer);
        const vectors = this.L.geoJSON(side.fc, { pane, renderer, interactive: false, style });
        this.layers.push(vectors); vectors.addTo(this.map);
        return ready;
      });
      this.clip(); await Promise.all(loads);
    } catch (error) { this.stop(); throw error; }
  }
  stop() {
    this.active = false; this.map.off("move zoom resize viewreset", this.clip);
    for (const cancel of [...this.pending]) cancel();
    for (const layer of this.layers.reverse()) this.map.removeLayer(layer);
    this.layers = []; for (const url of this.urls) URL.revokeObjectURL(url); this.urls = [];
    for (const { pane } of this.panes) pane.style.clip = "";
    if (this.dragging != null) { if (this.handle.hasPointerCapture(this.dragging)) this.handle.releasePointerCapture(this.dragging); this.dragging = null; }
    this.element.hidden = true;
  }
  destroy() {
    this.stop();
    for (const [name, listener] of [["pointerdown", this.down], ["pointermove", this.move], ["pointerup", this.up], ["pointercancel", this.up], ["keydown", this.key]]) this.handle.removeEventListener(name, listener);
  }
}
global.GVCompare = { geometryKey, modelName, validatePair, settingsNote, preview, Swipe };
})(typeof window !== "undefined" ? window : globalThis);
