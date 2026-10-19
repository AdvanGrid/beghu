// Usage: node candidates/proa/tools/cpu-profile.mjs against a native server on :8095 (see RESULTS.md).
import { chromium } from 'playwright';
const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
await p.goto('http://127.0.0.1:8095/'); await p.waitForSelector('[data-bench=list][data-bench-ready]'); await p.waitForTimeout(1000);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send("Profiler.start");
await p.click('[data-bench=filter-label][data-value=bug]'); await p.waitForTimeout(2000);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map(n => [n.id, n])); const self = new Map();
const dt = profile.timeDeltas; profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)));
const agg = new Map();
for (const [id, us] of self) { const n = byId.get(id); const f = n.callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`; agg.set(k, (agg.get(k) || 0) + us); }
const byFile = new Map(); for (const [id, us] of self) { const f = byId.get(id).callFrame; const k = f.url ? f.url.split('/').pop() : f.functionName; byFile.set(k, (byFile.get(k) || 0) + us); }
console.log('by file (ms):', [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)}`).join(' | '));
console.log([...agg].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${(v / 1000).toFixed(1)}ms ${k}`).join('\n'));
await b.close();
