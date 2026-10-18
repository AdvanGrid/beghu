// Live-update latency through ./bench/shape, which delays SSE frames as well as requests (CDP's
// network emulation doesn't delay frames on an open stream). Start the candidate behind it with
// `./bench/serve sync-baseline --rtt 100`, then:
//
//   node candidates/sync-baseline/shaped-live.mjs http://127.0.0.1:8080 [--cpu 6] [--n 20] [--tabs 2]
//
// Each edit renames an issue near the top of the default view; the time is from the POST (sent
// to the unshaped server on port + 1, as GitHub's webhook would reach the server directly) to
// the frame the new title shows in every tab.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { titleEdited } from '../../fixture/github-shape.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const url = argv.find((a) => a.startsWith('http'));
const direct = url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
const cpu = Number(flag('cpu', 1));
const n = Number(flag('n', 20));
const tabs = Number(flag('tabs', 1));
const db = new DatabaseSync(new URL('../../data/mirror-20k.db', import.meta.url).pathname, { readOnly: true });
const top = db.prepare("SELECT id FROM items WHERE kind = 'issue' AND is_stub = 0 AND state = 'open' ORDER BY updated_at DESC, id DESC LIMIT 20").all().map((r) => r.id);

const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const pages = [];
for (let t = 0; t < tabs; t++) {
  const p = await ctx.newPage();
  await p.addInitScript((rate) => (window.__bench = { cpuRate: rate }), cpu);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await p.goto(url);
  await p.waitForFunction(() => performance.getEntriesByName('bench:cache-ready').length, null, { timeout: 60_000 });
  pages.push(p);
}
const role = await Promise.all(pages.map((p) => p.evaluate(() => (performance.getEntriesByName('bench:sync-leader').length ? 'leader' : 'follower'))));
const seen = Object.fromEntries(role.map((r) => [r, []]));
for (let i = 0; i < n; i++) {
  const title = `Shaped edit ${i} ${Math.random().toString(36).slice(2, 8)}`;
  const waits = pages.map((p) =>
    p.evaluate(
      (t) =>
        new Promise((resolve) => {
          const tick = () => {
            for (const el of document.querySelectorAll('[data-bench=row] [data-bench=title]')) if (el.textContent === t) return resolve(Date.now());
            requestAnimationFrame(tick);
          };
          tick();
        }),
      title,
    ),
  );
  const updatedAt = new Date(Date.parse('2026-10-20T00:00:00Z') + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { event, payload } = titleEdited(db, top[i % top.length], title, updatedAt, 1000);
  const t0 = Date.now();
  await fetch(`${direct}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event }, body: JSON.stringify(payload) });
  const at = await Promise.all(waits);
  at.forEach((t, k) => seen[role[k]].push(t - t0));
  await new Promise((r) => setTimeout(r, 300));
}
const pct = (v, p) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
for (const [r, v] of Object.entries(seen)) console.log(`${r}: n ${v.length} p50 ${pct(v, 50)} p95 ${pct(v, 95)} max ${Math.max(...v)} ms`);
await b.close();
