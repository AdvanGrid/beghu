import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
const marks = (p) => p.evaluate(() => performance.getEntriesByType('mark').filter((m) => m.name.startsWith('bench:')).map((m) => `${m.name}@${Math.round(m.startTime)}`));
const p1 = await ctx.newPage();
const reqs = [];
p1.on('request', (r) => reqs.push(`${r.method()} ${r.url().replace(url, '')}`));
p1.on('console', (m) => console.log('p1 console', m.text()));
await p1.goto(url);
await p1.waitForFunction(() => performance.getEntriesByName('bench:cache-ready').length, null, { timeout: 30000 });
console.log('p1', await marks(p1));
const p2 = await ctx.newPage();
p2.on('request', (r) => r.method() === 'POST' && console.log('p2 POST', r.url()));
p2.on('console', (m) => console.log('p2 console', m.text()));
p2.on('pageerror', (e) => console.log('p2 pageerror', e.message));
await p2.goto(url);
await p2.waitForFunction(() => performance.getEntriesByName('bench:cache-ready').length, null, { timeout: 30000 });
console.log('p2', await marks(p2));
// a webhook edit: both tabs should show it
const id = await p2.$eval('[data-bench=row]:nth-child(5)', (r) => r.dataset.id);
const title = 'Smoke ' + Date.now();
const { DatabaseSync } = await import('node:sqlite');
const { titleEdited } = await import('../../fixture/github-shape.mjs');
const db = new DatabaseSync(new URL('../../data/mirror-20k.db', import.meta.url).pathname, { readOnly: true });
const { event, payload } = titleEdited(db, Number(id), title, '2026-10-05T00:00:00Z', 1000);
const t0 = Date.now();
await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event }, body: JSON.stringify(payload) });
for (const [n, p] of [['p1', p1], ['p2', p2]]) {
  await p.waitForFunction((t) => [...document.querySelectorAll('[data-bench=title]')].some((e) => e.textContent === t), title, { timeout: 10000 });
  console.log(n, 'saw edit after', Date.now() - t0, 'ms');
}
// write via worker from p2: does playwright see the POST?
await p2.click(`[data-bench=row][data-id="${id}"]`);
await p2.waitForSelector('[data-bench=detail] [data-bench=add-label]');
const name = await p2.$eval('[data-bench=detail] [data-bench=add-label]', (e) => e.dataset.value);
const resp = p2.waitForResponse((r) => r.request().method() !== 'GET', { timeout: 5000 }).then((r) => `seen ${r.status()}`).catch(() => 'NOT seen by page.waitForResponse');
await p2.click(`[data-bench=detail] [data-bench=add-label][data-value="${name}"]`);
console.log('write response', await resp);
await p1.waitForFunction(([i, n]) => document.querySelector(`[data-bench=row][data-id="${i}"] .meta`)?.textContent.includes(n), [id, name], { timeout: 10000 });
console.log('p1 row shows written label', name);
// rollback
await new Promise((r) => setTimeout(r, 1500));
await fetch(`${url}/bench/fail-writes?n=1`, { method: 'POST' });
console.log('before', await p2.$$eval('[data-bench=detail] [data-bench=label]', (es) => es.map((e) => e.dataset.value).join(',')));
const name2 = await p2.$eval('[data-bench=detail] [data-bench=add-label]', (e) => e.dataset.value);
await p2.click(`[data-bench=detail] [data-bench=add-label][data-value="${name2}"]`);
await p2.waitForSelector(`[data-bench=detail] [data-bench=label][data-value="${name2}"]`, { timeout: 2000 });
const rowHas = await p2.$eval(`[data-bench=row][data-id="${id}"] .meta`, (e, n) => e.textContent.includes(n), name2);
console.log('optimistic chip shown; row shows it too:', rowHas);
await p2.waitForSelector(`[data-bench=detail] [data-bench=label][data-value="${name2}"]`, { state: 'detached', timeout: 3000 });
const tr = Date.now();
await p2.waitForFunction(([i, n]) => !document.querySelector(`[data-bench=row][data-id="${i}"] .meta`)?.textContent.includes(n), [id, name2], { timeout: 3000 });
console.log('row rolled back too, within', Date.now() - tr, 'ms of the detail');
// leader handoff: close p1, edit again, p2 should see it
await p1.close();
const title2 = 'Smoke2 ' + Date.now();
const w2 = titleEdited(db, Number(id), title2, '2027-01-01T00:00:00Z', 1000);
await new Promise((r) => setTimeout(r, 300));
const t1 = Date.now();
await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': w2.event }, body: JSON.stringify(w2.payload) });
await p2.waitForFunction((t) => [...document.querySelectorAll('[data-bench=title]')].some((e) => e.textContent === t), title2, { timeout: 10000 });
console.log('p2 after handoff saw edit after', Date.now() - t1, 'ms', await marks(p2));
console.log('storage', await p2.evaluate(async () => JSON.stringify(await navigator.storage.estimate())));
console.log(reqs.slice(0, 20).join('\n'));
await b.close();
