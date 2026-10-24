// Highlighter throughput on the corpus's fenced blocks in the ten #54 languages (Node, best of 5).
import fs from 'node:fs';
import { hl as hljs } from './out/hljs10.js';
import { hl as shiki } from './out/shiki10.js';
import { hl as prism } from './out/prism10.js';
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const html = JSON.parse(fs.readFileSync('data/comrak-html.json', 'utf8')).join('\n');
const alias = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', rs: 'rust', sh: 'bash', shell: 'bash', console: 'bash', yml: 'yaml', html: 'xml' };
const ok = new Set(['typescript', 'javascript', 'rust', 'json', 'bash', 'sql', 'css', 'xml', 'yaml', 'diff']);
const blocks = [...html.matchAll(/<code class="language-([\w+-]+)">([\s\S]*?)<\/code>/g)].map((m) => [alias[m[1]] ?? m[1], unesc(m[2])]).filter(([l]) => ok.has(l));
const all = [...html.matchAll(/<code class="language-([\w+-]+)">/g)].map((m) => m[1]);
const cnt = {}; for (const l of all) cnt[l] = (cnt[l] ?? 0) + 1;
console.log('fenced blocks by info string:', JSON.stringify(cnt));
const bytes = blocks.reduce((a, b) => a + b[1].length, 0);
console.log(`${blocks.length} blocks in the ten languages, ${(bytes / 1024).toFixed(1)} KB`);
const prismName = { xml: 'markup' };
for (const [n, f] of [['highlight.js', (c, l) => hljs(c, l)], ['shiki (JS regex engine)', (c, l) => shiki(c, l === 'xml' ? 'html' : l)], ['prism', (c, l) => prism(c, prismName[l] ?? l)]]) {
  let best = 1e9; for (let i = 0; i < 5; i++) { const t = performance.now(); for (const [l, c] of blocks) f(c, l); best = Math.min(best, performance.now() - t); }
  console.log(`${n.padEnd(24)} ${best.toFixed(1)} ms (${(bytes / best / 1000).toFixed(2)} MB/s)`);
}
