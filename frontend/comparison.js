/* Read-only, georeferenced result comparison. No inference or export resizing. */
(function (global) {
"use strict";
const abortError = () => new DOMException("Comparison cancelled", "AbortError");
const check = signal => { if (signal?.aborted) throw abortError(); };
const geometryKey = feature => feature?.geometry ? JSON.stringify(feature.geometry) : null;
function modelName(params = {}) { return params.detect === false ? "Imagery only" : params.model || "Unknown model"; }
function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(value)) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function creationTime(record = {}, job = {}) {
  for (const value of [record.createdAt, record.created_at, job.createdAt, job.created_at]) {
    const time = timestamp(value); if (time !== null) return time;
  }
  return typeof job.started === "number" ? timestamp(job.started * 1000) : null;
}
function newestFirst(records) {
  return [...records].sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity)
    || String(b.job).localeCompare(String(a.job)) || (b.sourceIndex || 0) - (a.sourceIndex || 0) || String(a.key).localeCompare(String(b.key)));
}
function validDate(date) { return typeof date === "string" && /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date; }
function validateTimeline(records) {
  if (records.length < 2) return { error: "Select at least two clips to open a timeline." };
  if (!records[0].geometry || records.some(r => r.geometry !== records[0].geometry)) return { error: "Choose clips with the same AOI geometry for the timeline." };
  if (records.some(r => !validDate(r.date))) return { error: "Timeline clips need recorded imagery dates." };
  if (new Set(records.map(r => r.date)).size < 2) return { error: "Choose at least two different imagery dates for the timeline." };
  return { frames: [...records].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? -Infinity) - (b.createdAt ?? -Infinity) || String(a.key).localeCompare(String(b.key))) };
}
function timelineNote(frames) {
  const first = frames[0], differences = new Set();
  for (const frame of frames.slice(1)) {
    if (frame.model !== first.model || frame.modelKey !== first.modelKey) differences.add("models");
    if (frame.zoom !== first.zoom) differences.add("imagery zoom");
    if (frame.params.conf !== first.params.conf) differences.add("confidence thresholds");
    if (JSON.stringify([...(frame.params.classes || [])].sort()) !== JSON.stringify([...(first.params.classes || [])].sort())) differences.add("object classes");
    if ((frame.maskVersion || "canvas-v1") !== (first.maskVersion || "canvas-v1")) differences.add("AOI edge masks");
  }
  if (frames.some(frame => frame.missing)) differences.add("missing imagery tiles");
  return (differences.size ? "Selected runs differ in " + [...differences].join(", ") + ". " : "") + "Counts are model predictions, not verified changes. Same-date runs are shown separately.";
}
function validatePair(records, mode) {
  if (records.length !== 2) return { error: "Select two clips in the table to compare." };
  const [a, b] = records;
  if (!a.geometry || a.geometry !== b.geometry) return { error: "Choose two clips with the same AOI geometry." };
  if (mode === "dates") {
    if (!a.date || !b.date || a.date === b.date) return { error: "Choose two different imagery dates." };
    if (a.model === "Unknown model" && a.job !== b.job) return { error: "Choose runs with recorded model names." };
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
  if ((a.maskVersion || "canvas-v1") !== (b.maskVersion || "canvas-v1")) differences.push("AOI edge mask");
  if (a.missing || b.missing) differences.push("missing imagery tiles");
  return differences.length ? "Runs differ in " + differences.join(", ") + ". Counts alone do not establish model accuracy or real-world change." : "Model predictions · matching recorded settings. Counts are not verified changes.";
}
async function preview(blob, size, signal) {
  check(signal);
  const budget = global.GVEngine?.allocations;
  if (!budget) throw new Error("Comparison allocation policy is unavailable. Reload the page.");
  const limits = budget.limits();
  size = await budget.pngDimensions(blob);
  check(signal);
  const sourceBytes = budget.dimensions(size[0], size[1], limits, "Comparison source");
  // Cap the decoded comparison image explicitly; native exports stay intact.
  const scale = Math.min(1, 2048 / Math.max(...size)), targetWidth = Math.max(1, Math.round(size[0] * scale)), targetHeight = Math.max(1, Math.round(size[1] * scale));
  // Resized decoding may use native-size scratch space inside the browser.
  const rgba = budget.dimensions(targetWidth, targetHeight, limits, "Comparison preview"), lease = budget.reserve("Comparison preview", sourceBytes + rgba * 3 + 65536, limits);
  let bitmap, canvas;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: "high" });
    check(signal);
    if (bitmap.width !== targetWidth || bitmap.height !== targetHeight) throw new Error("Browser did not honor the bounded comparison decode size.");
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio)), height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas = budget.makeCanvas(width, height, lease);
    const context = canvas.getContext("2d"); if (!context) throw new Error("Could not create comparison canvas");
    context.drawImage(bitmap, 0, 0, width, height);
    const image = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not prepare comparison image")), "image/png"));
    check(signal); return { blob: image, size: [width, height] };
  } finally { bitmap?.close(); budget.releaseCanvas(canvas); lease.release(); }
}

function playbackSettings(value = {}) {
  return { effect: ["fade", "wipe", "none"].includes(value?.effect) ? value.effect : "fade",
    duration: [200, 450, 900].includes(Number(value?.duration)) ? Number(value.duration) : 450,
    interval: [1000, 2000, 4000].includes(Number(value?.interval)) ? Number(value.interval) : 2000 };
}
function transitionKeyframes(effect, { top, right, bottom, left }) {
  const full = `rect(${top}px, ${right}px, ${bottom}px, ${left}px)`;
  return effect === "wipe" ? { incoming: [{ clip: `rect(${top}px, ${left}px, ${bottom}px, ${left}px)` }, { clip: full }],
    outgoing: [{ clip: full }, { clip: `rect(${top}px, ${right}px, ${bottom}px, ${right}px)` }] }
    : { incoming: [{ opacity: 0 }, { opacity: 1 }], outgoing: [{ opacity: 1 }, { opacity: 0 }] };
}
// Timeline display owns at most the current and incoming frame. Two empty
// map-owned panes are reused; only a transition retains the outgoing frame.
class Timeline {
  constructor(map, element, leaflet = global.L) {
    this.map = map; this.element = element; this.L = leaflet;
    this.frames = []; this.pending = new Set(); this.generation = 0; this.active = false;
    this.current = null; this.transition = null;
    this.panes = ["gmd-timeline-a", "gmd-timeline-b"].map((name, index) => {
      const pane = map.getPane(name) || map.createPane(name);
      pane.style.zIndex = String(450 + index); pane.style.pointerEvents = "none";
      return { name, pane };
    });
    this.clip = () => {
      if (!this.active) return;
      // Finish a visual transition when the viewport changes. Leaflet continues
      // moving the actual georeferenced layers; no screen-space drift is added.
      this.finishTransition();
      const { top, right, bottom, left } = this.viewport();
      for (const { pane } of this.panes) pane.style.clip = `rect(${top}px, ${right}px, ${bottom}px, ${left}px)`;
    };
  }
  get layers() { return this.frames.flatMap(frame => frame.layers); }
  get urls() { return this.frames.flatMap(frame => frame.url ? [frame.url] : []); }
  viewport() {
    const size = this.map.getSize(), nw = this.map.containerPointToLayerPoint([0, 0]), se = this.map.containerPointToLayerPoint([size.x, size.y]);
    return { top: nw.y, right: se.x, bottom: se.y, left: nw.x };
  }
  releaseFrame(frame) {
    if (!frame || frame.released) return;
    frame.released = true; frame.cancel?.();
    for (const layer of [...frame.layers].reverse()) this.map.removeLayer(layer);
    frame.layers = []; if (frame.url) URL.revokeObjectURL(frame.url); frame.url = null;
    this.frames = this.frames.filter(value => value !== frame);
  }
  finishTransition(commit = true) {
    const owner = this.transition; if (!owner) return;
    this.transition = null; clearTimeout(owner.timer);
    for (const animation of owner.animations) animation.cancel();
    if (commit) {
      this.current = owner.incoming; this.releaseFrame(owner.outgoing);
      this.panes[owner.incoming.index].pane.style.opacity = "1";
      const { top, right, bottom, left } = this.viewport();
      this.panes[owner.incoming.index].pane.style.clip = `rect(${top}px, ${right}px, ${bottom}px, ${left}px)`;
    }
    owner.resolve();
  }
  async showFrame(side, style, options = {}) {
    const generation = ++this.generation;
    this.finishTransition();
    for (const cancel of [...this.pending]) cancel();
    for (const frame of [...this.frames]) if (frame !== this.current) this.releaseFrame(frame);
    const previous = this.current, index = previous ? 1 - previous.index : 0;
    if (previous) this.panes[previous.index].pane.style.zIndex = "450";
    const frame = { index, layers: [], url: null }, target = this.panes[index]; this.frames.push(frame);
    this.active = true; this.element.hidden = false;
    this.map.off("movestart zoomstart move zoom resize viewreset", this.clip);
    this.map.on("movestart zoomstart move zoom resize viewreset", this.clip); this.clip();
    target.pane.style.opacity = "0"; target.pane.style.zIndex = "452";
    try {
      frame.url = URL.createObjectURL(side.preview.blob);
      const image = this.L.imageOverlay(frame.url, side.bounds, { pane: target.name, interactive: false });
      const ready = new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = error => {
          if (settled) return; settled = true;
          clearTimeout(timer); image.off("load", loaded); image.off("error", failed); this.pending.delete(cancel); frame.cancel = null;
          error ? reject(error) : resolve();
        };
        const loaded = () => finish(), failed = () => finish(new Error("Could not display a history image")), cancel = () => finish(abortError());
        frame.cancel = cancel; this.pending.add(cancel); image.on("load", loaded); image.on("error", failed);
        timer = setTimeout(() => finish(new Error("History image timed out")), 15000);
      });
      // Attach a rejection observer before constructors/addTo can throw.
      ready.catch(() => {});
      frame.layers.push(image); image.addTo(this.map);
      const renderer = this.L.svg({ pane: target.name }); frame.layers.push(renderer);
      const vectors = this.L.geoJSON(side.fc, { pane: target.name, renderer, interactive: false, style });
      frame.layers.push(vectors); vectors.addTo(this.map);
      await ready;
      if (generation !== this.generation) throw abortError();
      target.pane.style.opacity = "1";
      const settings = playbackSettings(options), reduced = global.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (previous && settings.effect !== "none" && !reduced && target.pane.animate) {
        const keyframes = transitionKeyframes(settings.effect, this.viewport());
        await new Promise(resolve => {
          const owner = this.transition = { incoming: frame, outgoing: previous, animations: [], resolve, timer: null };
          try {
            const timing = { duration: settings.duration, easing: "ease-in-out", fill: "both" };
            owner.animations.push(target.pane.animate(keyframes.incoming, timing));
            owner.animations.push(this.panes[previous.index].pane.animate(keyframes.outgoing, timing));
            Promise.allSettled(owner.animations.map(animation => animation.finished)).then(() => { if (this.transition === owner) this.finishTransition(); });
            owner.timer = setTimeout(() => { if (this.transition === owner) this.finishTransition(); }, settings.duration + 100);
          } catch { Promise.allSettled(owner.animations.map(animation => animation.finished)); this.finishTransition(); }
        });
      } else { this.current = frame; this.releaseFrame(previous); }
      if (generation !== this.generation) throw abortError();
    } catch (error) {
      if (generation === this.generation) {
        this.finishTransition(false); this.releaseFrame(frame); this.current = previous;
        if (previous) { this.panes[previous.index].pane.style.opacity = "1"; this.clip(); }
        else this.stop();
      }
      throw error;
    }
  }
  stop() {
    ++this.generation; this.active = false; this.map.off("movestart zoomstart move zoom resize viewreset", this.clip);
    this.finishTransition(false);
    for (const cancel of [...this.pending]) cancel();
    for (const frame of [...this.frames]) this.releaseFrame(frame);
    this.current = null;
    for (const { pane } of this.panes) { pane.style.clip = ""; pane.style.opacity = ""; }
    this.element.hidden = true;
  }
  destroy() { this.stop(); }
}

class Swipe {
  constructor(map, element, leaflet = global.L) {
    this.map = map; this.element = element; this.L = leaflet; this.position = 50;
    this.layers = []; this.urls = []; this.pending = new Set(); this.active = false; this.generation = 0;
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
  async showFrame(side, style) { this.setPosition(100); return this.show([side], style); }
  async show(sides, style) {
    this.stop(); const generation = this.generation; this.active = true; this.element.hidden = false;
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
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
  }
  stop() {
    ++this.generation;
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
global.GVCompare = { geometryKey, modelName, creationTime, newestFirst, validDate, validateTimeline, timelineNote, validatePair, settingsNote, preview, playbackSettings, transitionKeyframes, Timeline, Swipe };
})(typeof window !== "undefined" ? window : globalThis);
