/* Frozen pre-GMD-017 scan and deterministic workloads. Keep the reference
 * independent of the production broad phase and its profiling implementation.
 * No imports so the same fixture can execute in native Chrome.
 */
const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; } return s / 2; };
function clip(subject, clipPoly) {
  let out = subject;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const [ax, ay] = clipPoly[i], [bx, by] = clipPoly[(i + 1) % clipPoly.length];
    const inside = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
    const cross = (p, q) => { const [x1, y1] = p, [x2, y2] = q, dx = x2 - x1, dy = y2 - y1;
      const t = ((ax - x1) * (by - ay) - (ay - y1) * (bx - ax)) / (dx * (by - ay) - dy * (bx - ax)); return [x1 + t * dx, y1 + t * dy]; };
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      if (inside(q)) { if (!inside(p)) out.push(cross(p, q)); out.push(q); } else if (inside(p)) out.push(cross(p, q));
    }
  }
  return out;
}
const interArea = (p, q) => { const c = clip(p, q); return c.length > 2 ? Math.abs(area(c)) : 0; };
function scan(dets, thr, useMin) {
  const keep = [], byCls = {};
  dets.forEach(d => (byCls[d.cls] = byCls[d.cls] || []).push(d));
  for (const g of Object.values(byCls)) {
    g.sort((a, b) => b.conf - a.conf);
    const kept = [];
    for (const d of g) {
      let ok = true;
      for (const k of kept) {
        if (d.bb[0] > k.bb[2] || k.bb[0] > d.bb[2] || d.bb[1] > k.bb[3] || k.bb[1] > d.bb[3]) continue;
        const inter = interArea(d.poly, k.poly);
        const den = useMin ? Math.min(d.area, k.area) : d.area + k.area - inter;
        if (inter / Math.max(den, 1e-9) > thr) { ok = false; break; }
      }
      if (ok) kept.push(d);
    }
    keep.push(...kept);
  }
  return keep;
}
function box(id, x, y, width = 12, height = 8, angle = 0, cls = 'aircraft', conf = .9) {
  const c = Math.cos(angle), s = Math.sin(angle), u = [width / 2 * c, width / 2 * s], v = [-height / 2 * s, height / 2 * c];
  let poly = [[x + u[0] + v[0], y + u[1] + v[1]], [x + u[0] - v[0], y + u[1] - v[1]],
    [x - u[0] - v[0], y - u[1] - v[1]], [x - u[0] + v[0], y - u[1] + v[1]]];
  if (area(poly) < 0) poly = poly.reverse();
  return { id, cls, conf, poly, area: Math.abs(area(poly)), bb: [Math.min(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1])), Math.max(...poly.map(p => p[0])), Math.max(...poly.map(p => p[1]))] };
}
function random(seed = 17) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function workloads() {
  const sparse = n => Array.from({ length: n }, (_, i) => box(i, i % 100 * 80, Math.floor(i / 100) * 80, 20, 12, i % 7 * .1));
  return [
    { name: 'tiny-32', dets: sparse(32) },
    { name: 'sparse-192', dets: sparse(192) },
    { name: 'sparse-global-3000', dets: sparse(3000) },
    { name: 'chip-3000', dets: Array.from({ length: 3000 }, (_, i) => box(i, i % 150 * 6, Math.floor(i / 150) * 6, 2, 2)) },
    { name: 'dense-suppressed-3000', dets: Array.from({ length: 3000 }, (_, i) => box(i, (i % 50) * 60 + (i % 3) * .1, (i % 50) * 20, 40, 15, .3)) },
    { name: 'parallel-retained-512', dets: Array.from({ length: 512 }, (_, i) => box(i, -Math.sin(.7) * i * .6, Math.cos(.7) * i * .6, 512, .25, .7)) },
    { name: 'giant-plus-small-1601', dets: [box('giant', 4000, 1000, 1e7, 1e7, 0, 'aircraft', 1), ...sparse(1600)] },
    { name: 'custom-and-ties-1200', dets: Array.from({ length: 1200 }, (_, i) => box(i, i % 100 * 30, Math.floor(i / 100) * 30, 12, 8, .2, ['ship', 'solar_array', '0'][i % 3], i % 5 ? .9 : .7)) },
  ];
}
module.exports = { scan, box, random, workloads };
