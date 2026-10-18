// The reconnect scenario by hand, with the worker throttled to --cpu: logs the worker's marks and
// messages relative to the start of a 5 s outage, during which 100 webhooks land.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { titleEdited } from '../../fixture/github-shape.mjs';
const url = process.argv[2];
const cpu = Number(process.argv[process.argv.indexOf('--cpu') + 1] || 1);
const db = new DatabaseSync(new URL('../../data/mirror-20k.db', import.meta.url).pathname, { readOnly: true });
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
await ctx.addInitScript((cpu) => {
  window.__bench = { cpuRate: cpu };
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        const m = e.data;
        window.__log?.(m.mark ? `mark ${m.mark}` : m.page ? `page ${m.id} rows ${m.page.rows.length} total ${m.page.total}` : JSON.stringify(m).slice(0, 80));
      });
    }
  };
}, cpu);
let t0 = 0;
await ctx.exposeFunction('__log', (s) => console.log(String(t0 ? Date.now() - t0 : '-').padStart(6), s));
const ready = (p, n) => p.waitForFunction((n) => performance.getEntriesByName(`bench:${n}`).length, n, { timeout: 120000 });
const p0 = await ctx.newPage();
await p0.goto(url); await ready(p0, 'cache-warm'); await p0.close();
console.log('--- warm visit');
const p = await ctx.newPage();
t0 = Date.now();
await p.goto(url); await ready(p, 'cache-ready'); await ready(p, 'sync-caught-up');
console.log('--- outage');
t0 = Date.now();
await fetch(`${url}/bench/outage?ms=5000`, { method: 'POST' });
const ids = await p.$$eval('[data-bench=row]', (rows) => rows.map((r) => Number(r.dataset.id)));
let last;
for (let n = 1; n <= 100; n++) {
  last = `Probe edit ${n} ${Math.random().toString(36).slice(2, 8)}`;
  const { event, payload } = titleEdited(db, ids[n % ids.length], last, new Date(Date.parse('2026-10-10T00:00:00Z') + n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), 1000);
  await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event }, body: JSON.stringify(payload) });
}
console.log(String(Date.now() - t0).padStart(6), 'webhooks posted');
await p.waitForFunction((t) => [...document.querySelectorAll('[data-bench=title]')].some((e) => e.textContent === t), last, { timeout: 60000 });
console.log(String(Date.now() - t0).padStart(6), 'last edit shown');
await b.close();
