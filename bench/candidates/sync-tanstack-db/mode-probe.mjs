// One tab on a fresh profile, then a returning one: marks, stored records, worker errors and the
// worker's requests, for checking the on-demand and progressive variants by hand.
//
//   node candidates/sync-tanstack-db/mode-probe.mjs <url> [--cpu N] [--wait ms] [--webhooks N]
//
// --webhooks posts the fixture feed's first N deliveries --after ms (default 500) into the first
// visit.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:8080';
const arg = (name, d) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : d);
const cpu = arg('--cpu', 1);
const wait = arg('--wait', 8000);
const after = arg('--after', 500);
const feed = readFileSync(new URL('../../data/webhooks-20k.jsonl', import.meta.url), 'utf8').trim().split('\n').slice(0, arg('--webhooks', 0)).map((l) => JSON.parse(l));
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext();
const records = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('beghu-cache'); r.onsuccess = () => { const q = r.result.transaction('responses').objectStore('responses').count(); q.onsuccess = () => res(q.result); }; }));
for (const visit of ['first', 'returning']) {
  const p = await ctx.newPage();
  const t0 = Date.now();
  p.on('console', (m) => m.type() !== 'log' && console.log(visit, 'console', m.type(), m.text()));
  p.on('pageerror', (e) => console.log(visit, 'error', e.message));
  p.on('request', (r) => r.url().includes('/api/') && !r.url().includes('/api/issues/') && console.log(visit, Date.now() - t0, r.method(), r.url().replace(url, '')));
  await p.addInitScript((rate) => (window.__bench = { cpuRate: rate }), cpu);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await p.goto(url);
  if (visit === 'first' && feed.length) {
    await p.waitForTimeout(after);
    for (const e of feed) await fetch(`${url}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': e.event }, body: JSON.stringify(e.payload) });
    console.log(visit, Date.now() - t0, 'webhooks posted');
  }
  await p.waitForTimeout(wait);
  console.log(visit, 'marks', await p.evaluate(() => performance.getEntriesByType('mark').filter((m) => m.name.startsWith('bench:')).map((m) => `${m.name.slice(6)}@${Math.round(m.startTime)}`).join(' ')));
  console.log(visit, 'records', await records(p));
  await p.close();
}
await b.close();
