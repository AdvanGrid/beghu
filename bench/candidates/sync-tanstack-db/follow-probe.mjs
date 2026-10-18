// Where a following tab's time goes on a webhook edit: logs its worker messages with timestamps.
import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(() => {
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      const pm = this.postMessage.bind(this);
      this.postMessage = (m, ...r) => (window.__log?.('->', JSON.stringify(m).slice(0, 100)), pm(m, ...r));
      this.addEventListener('message', (e) => window.__log?.('<-', JSON.stringify(e.data.page ? { id: e.data.id, rows: e.data.page.rows.length } : e.data).slice(0, 100)));
    }
  };
});
const ready = (p) => p.waitForFunction(() => performance.getEntriesByName('bench:cache-ready').length, null, { timeout: 30000 });
const p1 = await ctx.newPage();
await p1.goto(url); await ready(p1);
const p2 = await ctx.newPage();
await p2.goto(url); await ready(p2);
await new Promise((r) => setTimeout(r, 2000));
let t0;
await p2.exposeFunction('__log', (...a) => t0 && console.log('p2', Date.now() - t0, ...a));
for (let k = 0; k < 4; k++) {
  const id = await p2.$eval(`[data-bench=row]:nth-child(${k + 3})`, (r) => r.dataset.id);
  const title = 'Follow ' + Date.now();
  const { DatabaseSync } = await import('node:sqlite');
  const { titleEdited } = await import('../../fixture/github-shape.mjs');
  const db = new DatabaseSync(new URL('../../data/mirror-20k.db', import.meta.url).pathname, { readOnly: true });
  const { event, payload } = titleEdited(db, Number(id), title, `2026-10-0${6 + k}T00:00:00Z`, 1000);
  t0 = Date.now();
  await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event }, body: JSON.stringify(payload) });
  await p2.waitForFunction((t) => [...document.querySelectorAll('[data-bench=title]')].some((e) => e.textContent === t), title, { timeout: 10000 });
  console.log('p2 saw edit', Date.now() - t0);
  t0 = 0;
  await new Promise((r) => setTimeout(r, 500));
}
await b.close();
