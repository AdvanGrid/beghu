// Combines data/build.json (server, bytes) and data/client*.json into click -> paint estimates.
// Transfer model, from the request leaving the browser to the last response byte arriving:
//   warm:  cwnd already past the bandwidth-delay product: RTT + wire bytes / bandwidth
//   idle:  open connection whose cwnd was reset to initcwnd 10 (Linux tcp_slow_start_after_idle=1,
//          the default, after an idle longer than one RTO); slow start doubles cwnd per round
//   new:   idle + 2 RTT (TCP + TLS 1.3 handshakes)
// Wire bytes = brotli-4 body + 300 B of headers, framed as 1448-byte payloads in 1514-byte frames.
// Usage: node model.mjs  -> prints markdown tables; data/model.json
import fs from 'node:fs';
const { pools, rows } = JSON.parse(fs.readFileSync('data/build.json'));
const client = JSON.parse(fs.readFileSync('data/client.json'));
const cv = fs.existsSync('data/client-cv.json') ? JSON.parse(fs.readFileSync('data/client-cv.json')) : {};
const MSS = 1448, FRAME = 1514, INITCWND = 10, HDR = 300;
export function transfer(bytes, rttMs, mbps, mode) {
  const bps = mbps ? mbps * 1e6 : Infinity;
  const ser = (segs) => (segs * FRAME * 8) / bps * 1000;
  let segs = Math.ceil((bytes + HDR) / MSS);
  if (mode === 'warm') return rttMs + ser(segs);
  let t = rttMs, cwnd = INITCWND;
  while (segs > 0) {
    const burst = Math.min(cwnd, segs); const s = ser(burst); segs -= burst;
    if (segs === 0) { t += s; break; }
    if (s >= rttMs) { t += s + ser(segs); break; } // pipe full: the rest goes at line rate
    t += rttMs; cwnd *= 2;
  }
  return t + (mode === 'new' ? 2 * rttMs : 0);
}
// unique comments per class: past this, threads repeat comments and brotli's 4 MB window finds
// the repeats, so compressed bytes come from the ratio at the largest non-repeating N instead
const UNIQUE = { human: pools.human.n, agent: pools.agent.n, mix: 2 * Math.min(pools.human.n, pools.agent.n), kandev: Infinity };
const ratio = {};
for (const cls of ['human', 'agent', 'mix']) { const r = rows.filter((x) => x.cls === cls && x.n <= UNIQUE[cls]).at(-1); ratio[cls] = { br4: r.br4 / r.raw, gz6: r.gz6 / r.raw, br5: r.br5 / r.raw, from: r.n }; }
for (const r of rows) {
  const est = r.n > UNIQUE[r.cls];
  r.br4_est = est ? Math.round(r.raw * ratio[r.cls].br4) : r.br4;
  r.gz6_est = est ? Math.round(r.raw * ratio[r.cls].gz6) : r.gz6;
  r.repeats = est;
  for (const rate of ['1x', '6x']) for (const k of [0, 10, 20]) { const c = client[`${r.name}|${rate}|k${k}`]; if (c) r[`c_${rate}_k${k}`] = c; }
  for (const rate of ['1x', '6x']) { const c = cv[`${r.name}|${rate}|k0`]; if (c) r[`cv_${rate}`] = c; }
}
const NETS = [['near 20 ms, uncapped', 20, 0], ['20 ms, 50 Mbps', 20, 50], ['20 ms, 10 Mbps', 20, 10], ['100 ms, 50 Mbps', 100, 50], ['headline 100 ms, 10 Mbps', 100, 10]];
const fmt = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1));
const out = { ratio, nets: NETS, rows };

console.log('## transfer ms (idle / warm), brotli-4 body');
console.log('| thread | br4 KB | ' + NETS.map((n) => n[0]).join(' | ') + ' |');
for (const r of rows) console.log(`| ${r.name}${r.repeats ? '*' : ''} | ${(r.br4_est / 1024).toFixed(1)} | ` + NETS.map(([, rtt, bw]) => `${fmt(transfer(r.br4_est, rtt, bw, 'idle'))} / ${fmt(transfer(r.br4_est, rtt, bw, 'warm'))}`).join(' | ') + ' |');

// click -> paint = transfer(idle) + server (render + br4) + client frame (all comments, or k)
const total = (r, rtt, bw, rate, k, mode = 'idle', variant = 'c') => {
  const c = variant === 'cv' ? r[`cv_${rate}`] : r[`c_${rate}_k${k}`]; if (!c) return NaN;
  return transfer(r.br4_est, rtt, bw, mode) + r.srv_ms + r.br4_ms + c.frame;
};
// largest N whose estimate is <= budget. Bytes, server time and client time are each interpolated
// linearly in N between measured points, and the transfer model runs on the interpolated bytes, so
// the slow-start steps land where they really are rather than being smeared between points.
const maxN = (cls, f, budget = 200) => {
  const rs = rows.filter((x) => x.cls === cls).sort((a, b) => a.n - b.n);
  const lerp = (n, key) => { let i = rs.findIndex((r) => r.n >= n); if (i <= 0) i = 1; const a = rs[i - 1], b = rs[i]; const ya = key(a), yb = key(b); return ya + (yb - ya) * (n - a.n) / (b.n - a.n); };
  const virt = (n) => {
    const v = { n, br4_est: lerp(n, (r) => r.br4_est), srv_ms: lerp(n, (r) => r.srv_ms), br4_ms: lerp(n, (r) => r.br4_ms) };
    for (const key of Object.keys(rs[0]).filter((k) => k.startsWith('c_') || k.startsWith('cv_'))) v[key] = { frame: lerp(n, (r) => r[key]?.frame ?? NaN) };
    return v;
  };
  if (!(f(virt(rs[0].n)) <= budget)) return `<${rs[0].n}`;
  let best = rs[0].n;
  for (let n = rs[0].n; n <= rs.at(-1).n; n++) { if (f(virt(n)) <= budget) best = n; else break; }
  return best === rs.at(-1).n ? `≥${best}` : String(best);
};
out.maxN = {};
for (const [label, opts] of [['all comments', { k: 0 }], ['first + newest 10', { k: 10 }], ['first + newest 20', { k: 20 }], ['all, content-visibility:auto', { k: 0, variant: 'cv' }]]) {
  console.log(`\n## max N under 200 ms click -> paint, cold (idle cwnd), ${label}`);
  console.log('| class | ' + ['1x', '6x'].flatMap((rate) => [[`${rate} 20 ms uncapped`, 20, 0], [`${rate} 20 ms 10 Mbps`, 20, 10], [`${rate} headline 100 ms 10 Mbps`, 100, 10]].map((x) => x[0])).join(' | ') + ' | 1x preloaded | 6x preloaded |');
  for (const cls of ['human', 'agent', 'mix']) {
    const cells = [];
    for (const rate of ['1x', '6x']) for (const [rtt, bw] of [[20, 0], [20, 10], [100, 10]]) cells.push(maxN(cls, (r) => total(r, rtt, bw, rate, opts.k, 'idle', opts.variant)));
    for (const rate of ['1x', '6x']) cells.push(maxN(cls, (r) => { const c = opts.variant === 'cv' ? r[`cv_${rate}`] : r[`c_${rate}_k${opts.k}`]; return c ? c.frame : NaN; }));
    out.maxN[`${label}|${cls}`] = cells;
    console.log(`| ${cls} | ${cells.join(' | ')} |`);
  }
}
console.log('\n## max N where transfer alone (idle cwnd) stays under 200 ms');
console.log('| class | ' + NETS.map((n) => n[0]).join(' | ') + ' |');
for (const cls of ['human', 'agent', 'mix']) console.log(`| ${cls} | ` + NETS.map(([, rtt, bw]) => maxN(cls, (r) => transfer(r.br4_est, rtt, bw, 'idle'))).join(' | ') + ' |');
console.log('\n## max N where transfer + server stays under 200 ms (idle / warm), headline');
for (const cls of ['human', 'agent', 'mix']) console.log(`| ${cls} | ${maxN(cls, (r) => transfer(r.br4_est, 100, 10, 'idle') + r.srv_ms + r.br4_ms)} / ${maxN(cls, (r) => transfer(r.br4_est, 100, 10, 'warm') + r.srv_ms + r.br4_ms)} |`);
fs.writeFileSync('data/model.json', JSON.stringify(out, null, 1));
console.log('\n## max N where transfer alone stays under 200 ms, warm cwnd');
console.log('| class | ' + NETS.map((n) => n[0]).join(' | ') + ' |');
for (const cls of ['human', 'agent', 'mix']) console.log(`| ${cls} | ` + NETS.map(([, rtt, bw]) => maxN(cls, (r) => transfer(r.br4_est, rtt, bw, 'warm'))).join(' | ') + ' |');
for (const [label, k] of [['all', 0], ['first + newest 10', 10]]) {
  console.log(`\n## max N under 200 ms click -> paint, warm cwnd, ${label}`);
  for (const cls of ['human', 'agent', 'mix']) console.log(`| ${cls} | ` + ['1x', '6x'].flatMap((rate) => [[20, 0], [20, 10], [100, 10]].map(([rtt, bw]) => maxN(cls, (r) => total(r, rtt, bw, rate, k, 'warm')))).join(' | ') + ' |');
}
// per-N component table for the doc
console.log('\n## components per thread: md KB, raw KB, gz6 KB, br4 KB, server ms (render / br4), client frame 1x / 6x (all, k10, k20, cv), elements');
for (const r of rows) { const c = (rate, k) => r[`c_${rate}_k${k}`]?.frame; const f = (x) => (x == null ? '–' : Math.round(x)); console.log(`| ${r.name}${r.repeats ? '*' : ''} | ${(r.md / 1024).toFixed(0)} | ${(r.raw / 1024).toFixed(0)} | ${(r.gz6_est / 1024).toFixed(1)} | ${(r.br4_est / 1024).toFixed(1)} | ${r.srv_ms.toFixed(1)} / ${r.br4_ms.toFixed(1)} | ${f(c('1x', 0))} / ${f(c('6x', 0))} | ${f(c('1x', 10))} / ${f(c('6x', 10))} | ${f(c('1x', 20))} / ${f(c('6x', 20))} | ${f(r.cv_1x?.frame)} / ${f(r.cv_6x?.frame)} | ${r.c_1x_k0?.elements ?? '–'} | ${r.c_1x_k0 ? (r.c_1x_k0.parse).toFixed(1) + ' / ' + r.c_6x_k0.parse.toFixed(1) : '–'} | ${r.c_1x_k0 ? r.c_1x_k0.heap_mb.toFixed(1) : '–'} |`); }
console.log('\n## click -> paint ms, all comments, idle cwnd: 1x near / 1x headline / 6x near / 6x headline (warm-cwnd headline in brackets)');
for (const r of rows) { const g = (rtt, bw, rate, mode = 'idle') => Math.round(total(r, rtt, bw, rate, 0, mode)); console.log(`| ${r.name}${r.repeats ? '*' : ''} | ${g(20, 0, '1x')} | ${g(100, 10, '1x')} (${g(100, 10, '1x', 'warm')}) | ${g(20, 0, '6x')} | ${g(100, 10, '6x')} |`); }
