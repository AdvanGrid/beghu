import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(() => {
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) { super(...a);
      const t0 = performance.now();
      const pm = this.postMessage.bind(this);
      this.postMessage = (m, ...r) => { if (!('fetch' in m)) console.log('->', Math.round(performance.now()), JSON.stringify(m).slice(0, 160)); return pm(m, ...r); };
      this.addEventListener('message', (e) => { const m = e.data; if (m.mark) return console.log('<- mark', m.mark); console.log('<-', Math.round(performance.now()), m.page ? `id ${m.id} rows ${m.page.rows.length} total ${m.page.total}` : JSON.stringify(m).slice(0, 120)); });
    }
  };
});
const p = await ctx.newPage();
p.on('console', (m) => console.log('console', m.text()));
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(url);
await p.waitForSelector('[data-bench=row]');
const t0 = Date.now();
const box = await p.locator('[data-bench=list]').boundingBox();
await p.mouse.move(box.x + box.width / 2, box.y + 100);
let last = -1;
while (Date.now() - t0 < 15000) {
  await p.mouse.wheel(0, 400);
  const s = await p.evaluate(() => ({ n: document.querySelector('[data-bench=list]')?.scrollHeight, label: document.querySelector('header')?.textContent?.match(/[\d,…]+ issues/)?.[0], ready: performance.getEntriesByName('bench:cache-ready').length }));
  if (s.n !== last) console.log(Date.now() - t0, JSON.stringify(s));
  last = s.n;
}
await b.close();
