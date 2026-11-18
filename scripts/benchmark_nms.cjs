/* Reproducible CPU-only benchmark; native browser and real-inference checks
 * are separate. Timings are observations, not portable CI pass thresholds.
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const source = fs.readFileSync(path.join(__dirname, '../frontend/engine.js'), 'utf8');
const context = vm.createContext({ performance, setTimeout, clearTimeout, module: { exports: {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../tests/helpers/nms-fixtures.cjs'), 'utf8'), context);
const reference = context.module.exports;
vm.runInContext(source, context);
const engine = context.GVEngine;
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
const report = { checkedAt: new Date().toISOString(), method: { warmups: 3, repetitions: 9, order: 'alternating scan/indexed',
  scope: 'Both functions and fixtures share one V8 context; Node CPU synthetic suppression only, not inference/accuracy, browser/GPU memory or end-to-end latency' },
  engineSha256: createHash('sha256').update(source).digest('hex'), environment: { node: process.version, platform: os.platform(), cpu: os.cpus()[0].model }, samples: [] };
for (const scene of reference.workloads()) for (const useMin of [false, true]) {
  const wanted = reference.scan(scene.dets, .45, useMin).map(d => d.id).join('|'), times = { scan: [], indexed: [] };
  let profile = {};
  for (let i = -3; i < 9; i++) for (const name of i % 2 ? ['indexed', 'scan'] : ['scan', 'indexed']) {
    profile = {}; const start = performance.now();
    const output = name === 'scan' ? reference.scan(scene.dets, .45, useMin) : engine.nms(scene.dets, .45, useMin, { profile });
    const elapsed = performance.now() - start;
    if (Array.from(output, d => d.id).join('|') !== wanted) throw Error('Suppression changed: ' + scene.name);
    if (i >= 0) times[name].push(elapsed);
  }
  const stats = {}; engine.nms(scene.dets, .45, useMin, { profile: stats });
  const scanMs = quantile(times.scan, .5), indexedMs = quantile(times.indexed, .5);
  report.samples.push({ name: scene.name, policy: useMin ? 'IoMin' : 'IoU', input: scene.dets.length, exactOrderedOutput: true,
    scan: { medianMs: scanMs, p95Ms: quantile(times.scan, .95), samplesMs: times.scan },
    indexed: { medianMs: indexedMs, p95Ms: quantile(times.indexed, .95), samplesMs: times.indexed }, ratio: indexedMs / scanMs, profile: stats });
  console.log(`${scene.name} ${useMin ? 'IoMin' : 'IoU'}: ${scanMs.toFixed(3)} → ${indexedMs.toFixed(3)} ms (${(indexedMs / scanMs).toFixed(2)}×)`);
}
const out = process.argv.indexOf('--output'); if (out >= 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2) + '\n');
