const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withChrome(run) {
  const executable = process.env.GMD_BROWSER_BIN || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(file => fs.existsSync(file));
  assert.ok(executable, "Chrome not found; set GMD_BROWSER_BIN");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geomap-browser-"));
  const chrome = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--window-size=1440,1000",
    `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  const pending = new Map();
  const watchdog = setTimeout(() => { chrome.kill(); socket?.close(); }, 300000);
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 20000);
      chrome.once("error", error => { clearTimeout(timer); reject(error); });
      chrome.stderr.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0, sessionId;
    const listeners = new Map(), errors = [];
    const send = (method, params = {}, session, timeout = 30000) => new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { pending.delete(request); reject(new Error(`CDP timed out: ${method}`)); }, timeout);
      pending.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params, ...(session ? { sessionId: session } : {}) }));
    });
    const page = (method, params, timeout) => send(method, params, sessionId, timeout);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
      } else {
        if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        for (const listener of listeners.get(message.method) || []) listener(message.params);
      }
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await Promise.all([page("Page.enable"), page("Runtime.enable"), page("Network.enable")]);
    const evaluate = async (expression, timeout = 30000) => {
      const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeout);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (expression, timeout = 45000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(200); }
      throw new Error("Browser condition timed out: " + expression);
    };
    await run({ page, evaluate, until, errors, on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    } });
    await send("Browser.close");
  } finally {
    clearTimeout(watchdog); socket?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser session closed")); }
    if (chrome.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000); chrome.once("exit", () => { clearTimeout(timer); resolve(); }); chrome.kill();
    });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
module.exports = { withChrome };
