/* One job owns this classic worker. No DOM, database connection or proxy worker.
 * The page owns spool writes; awaited RPC keeps transferred chunks bounded.
 */
"use strict";
importScripts("engine.js", "streaming.js");
const VERSION = 1, E = self.GVEngine;
let jobId = null, active = null, lease = null, rpcSequence = 0;
const reads = new Map();
const errorRecord = error => ({ name: error.name, message: error.message, code: error.code,
  coverage: error.coverage, estimate: error.estimate, zoom: error.zoom, cleanupErrors: error.cleanupErrors });
const send = (type, id, payload, transfer = []) => self.postMessage({ v: VERSION, jobId, id, type, payload }, transfer);
function rpc(owner, method, args, transfer = []) {
  const request = ++rpcSequence;
  return new Promise((resolve, reject) => {
    reads.set(request, { resolve, reject, id: owner.id });
    send("storage", owner.id, { request, method, args }, transfer);
  });
}
function storage(owner) {
  return { state: () => ({ available: true, writable: true }), async createSpool(options) {
    const info = await rpc(owner, "create", { maxBytes: options.maxBytes });
    return { ...info,
      async put(file, sequence, value) {
        owner.controller.signal.throwIfAborted();
        // The encoder may reuse its input. Transfer a private bounded copy only.
        const data = ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
          : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(await value.arrayBuffer());
        if (data.byteLength > info.maxChunkBytes) throw Object.assign(new Error("Worker chunk exceeds its transfer limit"), { code: "INVALID_BUFFER" });
        await rpc(owner, "put", { spool: info.id, file, sequence, data }, [data.buffer]);
      },
      get: (file, sequence) => rpc(owner, "get", { spool: info.id, file, sequence }),
      removeFile: file => rpc(owner, "removeFile", { spool: info.id, file }),
      dispose: () => rpc(owner, "dispose", { spool: info.id }),
    };
  } };
}
function diagnostics() { return { models: E.models.diagnostics(), allocations: E.allocations.diagnostics(), operations: E.operations.diagnostics(), streaming: self.GVStreaming.diagnostics(), pendingStorage: reads.size }; }
self.onmessage = async ({ data: message }) => {
  if (message?.v !== VERSION) return;
  if (message.type === "storage-result") {
    const request = reads.get(message.payload?.request);
    if (!request || message.id !== request.id || message.jobId !== jobId) return;
    reads.delete(message.payload.request);
    if (message.payload.error) request.reject(Object.assign(new Error(message.payload.error.message), message.payload.error));
    else request.resolve(message.payload.value);
    return;
  }
  if (message.type === "cancel") {
    if (message.jobId === jobId && active?.id === message.id) active.controller.abort();
    return;
  }
  if (!jobId && ["load", "close"].includes(message.type)) jobId = message.jobId;
  if (message.jobId !== jobId || active || !["load", "clip", "close"].includes(message.type)) return;
  const owner = active = { id: message.id, controller: new AbortController() };
  try {
    let result;
    if (message.type === "load") {
      if (lease) throw new Error("This worker already owns a model");
      if (message.payload.spec) lease = await E.models.acquire({ ...message.payload.spec, signal: owner.controller.signal });
      result = lease ? { provider: lease.model.provider, imgsz: lease.model.imgsz, key: lease.model.key, fingerprint: lease.model.fingerprint } : null;
    } else if (message.type === "clip") {
      let lastProgress = -Infinity;
      const progress = (kind, value) => {
        const time = performance.now();
        if (kind === "onProgress" && value !== 1 && time - lastProgress < 32) return;
        lastProgress = time; send("progress", owner.id, { kind, value });
      };
      const options = message.payload.options;
      result = await E.processClip(message.payload.aoi, message.payload.release, { ...options,
        model: lease ? { ...lease.model, names: options.names || lease.model.names } : null,
        signal: owner.controller.signal, store: storage(owner),
        onProgress: value => progress("onProgress", value), onEstimate: value => progress("onEstimate", value),
        onCoverage: value => progress("onCoverage", value), onWaiting: () => progress("onWaiting"),
      });
      // processClip checks cancellation after all native/encoding work drains.
    } else {
      await lease?.release(); lease = null; result = null;
    }
    send("result", owner.id, { result, diagnostics: diagnostics() });
  } catch (error) { send("error", owner.id, { error: errorRecord(error), diagnostics: diagnostics() }); }
  finally { active = null; }
};
self.postMessage({ v: VERSION, type: "ready", payload: { supported: typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function" } });
