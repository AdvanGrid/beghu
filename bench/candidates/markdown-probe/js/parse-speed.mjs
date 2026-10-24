// Parse+render throughput of the JS libraries over every corpus doc (Node, unthrottled). Best of 5.
import fs from 'node:fs';
import { render as marked } from './entries/marked.js';
import { render as mdit } from './entries/markdown-it.js';
import { render as mm } from './entries/micromark-gfm.js';
import { render as mdast } from './entries/mdast-hast.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
const docs = JSON.parse(fs.readFileSync('data/docs.json', 'utf8'));
const bytes = docs.reduce((a, d) => a + d.length, 0);
const time = (name, f) => { let best = 1e9; for (let i = 0; i < 5; i++) { const t = performance.now(); for (const d of docs) f(d); best = Math.min(best, performance.now() - t); } console.log(`${name.padEnd(22)} ${best.toFixed(0)} ms for ${docs.length} docs, ${(bytes / 1024).toFixed(0)} KB (${(bytes / best / 1000).toFixed(2)} MB/s)`); };
time('marked', marked); time('markdown-it', mdit); time('micromark+gfm', mm); time('mdast+gfm -> hast', mdast);
const html = docs.map(mm);
const P = createDOMPurify(new JSDOM('').window);
let best = 1e9; for (let i = 0; i < 3; i++) { const t = performance.now(); for (const h of html) P.sanitize(h); best = Math.min(best, performance.now() - t); }
console.log(`DOMPurify (jsdom)      ${best.toFixed(0)} ms (jsdom is slower than a browser DOM)`);
