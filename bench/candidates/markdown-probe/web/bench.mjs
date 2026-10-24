// Times window.run(mode, thread) in Chromium at 1x and 6x CDP CPU throttle. Each sample is a fresh
// render of the thread (previous root disposed). Usage: node web/bench.mjs [iterations]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/tomsj/dev/beghu/bench/node_modules/playwright');
const N = +(process.argv[2] ?? 15);
const dist = new URL('./dist/', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const f = path.join(dist, q.url === '/' ? 'index.html' : q.url); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(fs.readFileSync(f)); }).listen(0);
await new Promise((r) => srv.on('listening', r));
const all = JSON.parse(fs.readFileSync(new URL('../data/threads-forms.json', import.meta.url)));
const BUDGET = 12000;
const sel = [];
for (const id of ['rust-lang/rust#38356', 'vitejs/vite#11468']) {
  const t = all.find((x) => x.id === id);
  // budgeted view: body + first comment + newest that fit 12,000 bytes of markdown JSON (as the prototype)
  const sz = t.md.map((m) => JSON.stringify(m).length + 80);
  let used = sz[1], from = t.md.length;
  while (from > 2 && used + sz[from - 1] <= BUDGET) used += sz[--from];
  const idx = [0, 1, ...Array.from({ length: t.md.length - from }, (_, i) => from + i)];
  const pick = (k) => idx.map((i) => t[k][i]);
  sel.push({ name: `${id} budgeted (${idx.length} items)`, t: { md: pick('md'), html: pick('html'), ast: pick('ast') } });
  sel.push({ name: `${id} all (${t.md.length} items)`, t: { md: t.md, html: t.html, ast: t.ast } });
}
const browser = await chromium.launch({ channel: 'chromium' });
const modes = process.env.MODES ? process.env.MODES.split(',') : ['html', 'ast-dom', 'ast-solid', 'md-micromark', 'md-marked', 'md-mdast', 'ast-dom+hl'];
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`chromium ${browser.version()}, ${N} iterations, ms (p50 / p95)`);
for (const rate of [1, 6]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.ready);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  for (const s of sel) {
    await page.evaluate((j) => { window.T = JSON.parse(j); }, JSON.stringify(s.t));
    const line = [];
    for (const m of modes) {
      const [mode, hl] = m.split('+');
      const go = () => page.evaluate(([m, hl]) => window.run(m, window.T, !!hl).then((r) => r, (e) => 'ERR ' + String(e && e.stack || e)), [mode, hl]);
      for (let i = 0; i < 2; i++) { const v = await go(); if (typeof v === 'string') { console.log(v); process.exit(1); } } // warm-up
      const xs = [], ys = [], hs = []; let blocks = 0;
      for (let i = 0; i < N; i++) { const [frame, sync, h, b] = await go(); xs.push(frame); ys.push(sync); hs.push(h); blocks = b; }
      line.push(`${m}: sync ${q(ys, 0.5).toFixed(1)}/${q(ys, 0.95).toFixed(1)}, frame ${q(xs, 0.5).toFixed(1)}/${q(xs, 0.95).toFixed(1)}` + (hl ? `, hljs ${q(hs, 0.5).toFixed(1)}/${q(hs, 0.95).toFixed(1)} (${blocks} blocks)` : ''));
    }
    console.log(`${rate}x | ${s.name}\n   ${line.join('\n   ')}`);
  }
  await page.close();
}
await browser.close(); srv.close();
