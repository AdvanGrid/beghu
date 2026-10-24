// Runs every GFM spec example through each JS renderer; writes ../spec/out-<name>.json (html per example).
import fs from 'node:fs';
import { marked } from 'marked';
import MarkdownIt from 'markdown-it';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
const tests = JSON.parse(fs.readFileSync('../spec/tests.json', 'utf8'));
const mdit = new MarkdownIt({ html: true, linkify: true });
const r = {
  marked: (s) => marked.parse(s, { gfm: true }),
  'markdown-it': (s) => mdit.render(s),
  micromark: (s) => micromark(s, { allowDangerousHtml: true, allowDangerousProtocol: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] }),
};
for (const [n, f] of Object.entries(r)) {
  const out = tests.map((t) => { try { return f(t.markdown); } catch (e) { return 'ERR ' + e; } });
  fs.writeFileSync(`../spec/out-${n}.json`, JSON.stringify(out));
}
