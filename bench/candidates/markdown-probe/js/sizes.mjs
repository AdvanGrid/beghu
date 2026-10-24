// Sizes of one thread's comments as markdown, sanitised comrak HTML, GitHub body_html, compact AST
// and verbose hast JSON; raw and gzip -9 / brotli; and how many comments fit the prototype's
// 12,000-byte comment budget (first + newest that fit) in each form.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import hljs from 'highlight.js';
import { compact } from './compact.mjs';

const threads = [...JSON.parse(fs.readFileSync('github/data/corpus.json', 'utf8')), ...JSON.parse(fs.readFileSync('data/fixture-thread.json', 'utf8'))];
const docs = threads.flatMap((t) => [t.body ?? '', ...t.comments.map((c) => c.body ?? '')]);
fs.writeFileSync('data/docs.json', JSON.stringify(docs));
const html = JSON.parse(execFileSync('rs/target/release/markdown-probe', ['render', 'data/docs.json'], { maxBuffer: 1 << 28 }).toString());
fs.writeFileSync('data/comrak-html.json', JSON.stringify(html));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const hl = (h) => h.replace(/<code class="language-([\w+-]+)">([\s\S]*?)<\/code>/g, (m, l, c) => hljs.getLanguage(l) ? `<code class="language-${l}">${hljs.highlight(unesc(c), { language: l, ignoreIllegals: true }).value}</code>` : m);
const strip = (n) => { delete n.position; n.children?.forEach(strip); return n; };
const hast = (md) => strip(toHast(fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), { allowDangerousHtml: true }));

let k = 0;
const forms = { md: [], html: [], 'html+hl': [], ast: [], 'ast+hl': [], hast: [], gh: [] };
for (const t of threads) {
  const items = [{ body: t.body ?? '', body_html: t.body_html }, ...t.comments];
  t.f = Object.fromEntries(Object.keys(forms).map((f) => [f, []]));
  for (const c of items) {
    const h = html[k++];
    const v = { md: c.body ?? '', html: h, 'html+hl': hl(h), ast: compact(h), 'ast+hl': compact(hl(h)), hast: hast(c.body ?? ''), gh: c.body_html };
    for (const f in v) t.f[f].push(v[f]);
  }
}
const gz = (s) => zlib.gzipSync(s, { level: 9 }).length;
const br = (s) => zlib.brotliCompressSync(s).length;
const enc = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
const BUDGET = 12000;
const fit = (sizes) => { // first + newest that fit, same rule as list-prototype main.rs
  let used = sizes[1] ?? 0, n = 1; // [0] is the body; comments are 1..
  for (let i = sizes.length - 1; i > 1 && used + sizes[i] <= BUDGET; i--) { used += sizes[i]; n++; }
  return n;
};
const rows = [];
for (const t of threads) {
  for (const f of Object.keys(forms)) {
    if (f === 'gh' && t.repo === 'fixture') continue;
    const all = '[' + t.f[f].map(enc).join(',') + ']';
    const sizes = t.f[f].map((v) => enc(v).length + 80);
    const n = fit(sizes);
    const kept = [t.f[f][0], t.f[f][1], ...t.f[f].slice(t.f[f].length - (n - 1))].filter((x) => x !== undefined);
    const resp = '[' + kept.map(enc).join(',') + ']';
    rows.push({ thread: `${t.repo}#${t.number}`, form: f, comments: t.f[f].length - 1, raw: all.length, gz: gz(all), br: br(all), fit: Math.min(n, t.f[f].length - 1), resp_raw: resp.length, resp_gz: gz(resp) });
  }
}
console.log('thread | form | comments | all raw | all gz | all br | comments in 12 KB budget | budgeted response raw / gz');
for (const r of rows) console.log(`${r.thread} | ${r.form} | ${r.comments} | ${r.raw} | ${r.gz} | ${r.br} | ${r.fit} | ${r.resp_raw} / ${r.resp_gz}`);
// totals over the six real threads
const tot = {};
for (const r of rows.filter((r) => r.thread !== `fixture#${threads.at(-1).number}`)) { tot[r.form] ??= { raw: 0, gz: 0, br: 0 }; tot[r.form].raw += r.raw; tot[r.form].gz += r.gz; tot[r.form].br += r.br; }
console.log('\nTOTAL real threads (sum of per-thread arrays):');
for (const [f, v] of Object.entries(tot)) console.log(`${f}: raw ${v.raw} (${(v.raw / tot.md.raw).toFixed(2)}x md), gz ${v.gz} (${(v.gz / tot.md.gz).toFixed(2)}x), br ${v.br}`);
fs.writeFileSync('data/threads-forms.json', JSON.stringify(threads.map((t) => ({ id: `${t.repo}#${t.number}`, md: t.f.md, html: t.f.html, ast: t.f.ast, gh: t.f.gh }))));
