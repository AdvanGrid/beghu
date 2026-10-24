// Does colouring code blocks move text? Renders a thread (ast-dom), records every pre's box and the
// page height, colours with hljs spans styled colour-only, then with italic comments, and compares.
import { createRequire } from 'node:module';
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('/home/tomsj/dev/beghu/bench/node_modules/playwright');
const dist = new URL('./dist/', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const f = path.join(dist, q.url === '/' ? 'index.html' : q.url); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(fs.readFileSync(f)); }).listen(0);
await new Promise((r) => srv.on('listening', r));
const t = JSON.parse(fs.readFileSync(new URL('../data/threads-forms.json', import.meta.url))).find((x) => x.id === 'rust-lang/rust#38356');
const b = await chromium.launch({ channel: 'chromium' }); const p = await b.newPage();
await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForFunction(() => window.ready);
await p.evaluate((j) => { window.T = JSON.parse(j); }, JSON.stringify({ md: t.md, html: t.html, ast: t.ast }));
for (const css of ['', '.hljs-comment{font-style:italic}', '.hljs-keyword{font-weight:bold}']) {
  const r = await p.evaluate(async (css) => {
    document.head.querySelector('#s')?.remove();
    document.head.insertAdjacentHTML('beforeend', `<style id=s>pre{font:13px/1.5 ui-monospace,monospace} [class^=hljs-]{color:#c22} ${css}</style>`);
    const boxes = () => [...document.querySelectorAll('pre')].map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height, r.width, e.scrollWidth].join(','); }).join(';') + '|' + document.body.scrollHeight;
    await window.run('ast-dom', window.T, false); const before = boxes();
    await window.run('ast-dom', window.T, true); const after = boxes();
    return { same: before === after, pres: document.querySelectorAll('pre').length, spans: document.querySelectorAll('[class^=hljs-]').length };
  }, css);
  console.log(JSON.stringify(css || 'colour only'), r);
}
await b.close(); srv.close();
