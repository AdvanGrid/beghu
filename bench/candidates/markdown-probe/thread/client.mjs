// Times JSON.parse + AST walk + layout + next frame for each thread in data/threads/, in Chromium
// at 1x and 6x CDP CPU throttle, rendering all comments or (k = 10, 20) first + newest k.
// Also records JS heap (after GC, page holding the parsed thread and the DOM) and DOM elements.
// Usage: node client.mjs [filter-regex]   -> data/client.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/tomsj/dev/beghu/bench/node_modules/playwright');
const dist = new URL('./web/dist/', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const u = q.url.split('?')[0]; const f = path.join(dist, u === '/' ? 'index.html' : u); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(fs.readFileSync(f)); }).listen(0);
await new Promise((r) => srv.on('listening', r));
const filt = new RegExp(process.argv[2] ?? '.');
const files = fs.readdirSync('data/threads').filter((f) => filt.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const browser = await chromium.launch({ channel: 'chromium' });
const outPath = process.env.NOCSS ? 'data/client-nocss.json' : process.env.CV ? 'data/client-cv.json' : 'data/client.json';
const results = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath)) : {};
console.log(`chromium ${browser.version()}`);
for (const rate of [1, 6]) {
  for (const f of files) {
    const txt = fs.readFileSync(`data/threads/${f}`, 'utf8');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`http://127.0.0.1:${srv.address().port}/${process.env.NOCSS ? '?nocss' : process.env.CV ? '?cv' : ''}`);
    await page.waitForFunction(() => window.ready);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.evaluate((t) => { window.TXT = t; }, txt);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = (await cdp.send('Performance.getMetrics')).metrics; return Object.fromEntries(m.filter((x) => ['JSHeapUsedSize', 'Nodes'].includes(x.name)).map((x) => [x.name, x.value])); };
    for (const k of (process.env.KS ?? '0,10,20').split(',').map(Number)) {
      const big = txt.length > 1.5e6;
      const reps = rate === 6 ? (big ? 3 : 7) : (big ? 5 : 9);
      await page.evaluate((k) => window.go(k), k); // warm-up
      const xs = [];
      for (let i = 0; i < reps; i++) xs.push(await page.evaluate((k) => window.go(k), k));
      const h1 = await heap();
      await page.evaluate(() => window.clear());
      const h0 = await heap();
      const r = { parse: med(xs.map((x) => x[0])), sync: med(xs.map((x) => x[1])), frame: med(xs.map((x) => x[2])), frame_max: Math.max(...xs.map((x) => x[2])), elements: xs[0][3], walk: med(xs.map((x) => x[4])), heap_mb: (h1.JSHeapUsedSize - h0.JSHeapUsedSize) / 1048576, dom_nodes: h1.Nodes - h0.Nodes, reps };
      const key = `${f.replace('.json', '')}|${rate}x|k${k}`;
      results[key] = r;
      console.log(key, JSON.stringify(r));
      fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
    }
    await page.close();
  }
}
await browser.close(); srv.close();
