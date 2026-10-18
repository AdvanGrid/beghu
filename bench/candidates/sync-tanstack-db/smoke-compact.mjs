// Checks compaction and dictionary-less deltas: 80 webhooks into a live tab, then a returning tab
// must show the same rows as the server and have compacted its records.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const url = process.argv[2];
const feed = readFileSync(new URL('../../data/webhooks-20k.jsonl', import.meta.url), 'utf8').trim().split('\n').slice(0, Number(process.argv[3] ?? 80)).map((l) => JSON.parse(l));
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
const ready = (p) => p.waitForFunction(() => performance.getEntriesByName('bench:cache-ready').length, null, { timeout: 30000 });
const records = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('beghu-cache'); r.onsuccess = () => { const q = r.result.transaction('responses').objectStore('responses').count(); q.onsuccess = () => res(q.result); }; }));
const p1 = await ctx.newPage();
await p1.goto(url);
await ready(p1);
await p1.waitForTimeout(500);
let bytes = 0;
for (const e of feed) await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': e.event }, body: JSON.stringify(e.payload) });
await p1.waitForTimeout(4000);
console.log('records after the webhooks and a compaction wait:', await records(p1));
const serverTop = (await (await fetch(`${url}/api/issues?state=open&offset=0&limit=100`)).json()).rows.map((r) => `${r.id}:${r.title}:${r.labels.map((l) => l.name).join(' ').split(' ').join('|')}`);
await p1.close();
const p2 = await ctx.newPage();
await p2.goto(url);
await ready(p2);
await p2.waitForTimeout(300);
const shown = await p2.$$eval('[data-bench=row]', (rows) => rows.map((r) => r.dataset.id + ':' + r.querySelector('[data-bench=title]').textContent + ':' + r.querySelector('.meta').textContent.split(' ').filter(Boolean).join('|')));
const n = Math.min(shown.length, 30);
const bad = shown.slice(0, n).flatMap((s, i) => (s !== serverTop[i] ? [[i, s, serverTop[i]]] : []));
console.log('returning tab rows match server:', bad.length === 0 ? `yes (${n})` : bad.slice(0, 3));
console.log('marks', await p2.evaluate(() => performance.getEntriesByType('mark').filter((m) => m.name.startsWith('bench:')).map((m) => `${m.name.slice(6)}@${Math.round(m.startTime)}`).join(' ')));
// a filter query from the cache vs the server
await p2.click('[data-bench=filter-label][data-value=bug]');
await p2.waitForTimeout(500);
const local = await p2.$$eval('[data-bench=row]', (rows) => rows.slice(0, 20).map((r) => r.dataset.id));
const srv = (await (await fetch(`${url}/api/issues?state=open&offset=0&limit=20&label=bug`)).json()).rows.map((r) => String(r.id));
console.log('bug filter matches server:', JSON.stringify(local) === JSON.stringify(srv));
await b.close();
