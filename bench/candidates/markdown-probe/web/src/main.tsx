// Throwaway render probe (beghu #59). window.run(mode, thread) renders one thread's comments in a
// fresh root and resolves with ms from start to the frame after layout.
// thread = { md: string[], html: string[], ast: any[][] }  (html is sanitised server HTML)
import { render, Dynamic } from '@solidjs/web';
import { For } from 'solid-js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import hljs from 'highlight.js/lib/core';
import ts from 'highlight.js/lib/languages/typescript';
import js from 'highlight.js/lib/languages/javascript';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
for (const [n, l] of Object.entries({ typescript: ts, javascript: js, rust, json, bash, sql, css, xml, yaml, diff })) hljs.registerLanguage(n, l as any);
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' }); hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['rs'], { languageName: 'rust' }); hljs.registerAliases(['sh', 'shell', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' }); hljs.registerAliases(['yml'], { languageName: 'yaml' });
// After render: colour every code.language-x the way the #54 prototype does (innerHTML of hljs output).
function colour(root: Element) {
  let n = 0;
  for (const el of root.querySelectorAll('pre > code[class^="language-"]')) {
    const l = el.className.split(' ')[0].slice(9);
    if (!hljs.getLanguage(l)) continue;
    el.innerHTML = hljs.highlight(el.textContent!, { language: l, ignoreIllegals: true }).value; n++;
  }
  return n;
}

// Stands in for stylex.attrs(styles.x): a precomputed class per tag (StyleX compiles to this).
const CLS: Record<string, string> = { p: 'x1 x2', a: 'x3', code: 'x4 x5', pre: 'x6 x7 x8', li: 'x9', ul: 'x10', ol: 'x10', blockquote: 'x11 x12', table: 'x13', td: 'x14', th: 'x14 x15', img: 'x16', h1: 'x17', h2: 'x17', h3: 'x17' };

const SAFE_ATTR = new Set(['href', 'src', 'alt', 'title', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'align', 'id', 'class', 'width', 'height', 'start', 'open', 'lang']);
// compact AST -> DOM directly (static content needs no reactivity). Attrs are an allowlist.
function dom(n: any): Node {
  if (typeof n === 'string') return document.createTextNode(n);
  const [tag, at, ...kids] = n;
  const el = document.createElement(tag);
  if (at) for (const k in at) if (SAFE_ATTR.has(k) && (k !== 'class' || (tag === 'code' && at[k].startsWith('language-')))) el.setAttribute(k, at[k]);
  const c = CLS[tag]; if (c) el.className = (el.className ? el.className + ' ' : '') + c;
  for (const k of kids) el.appendChild(dom(k));
  return el;
}
// compact AST -> Solid components via <Dynamic>.
function SNode(p: { n: any }): any {
  const n = p.n;
  if (typeof n === 'string') return n;
  const [tag, at, ...kids] = n;
  const props: any = { component: tag, class: CLS[tag] };
  if (at) for (const k in at) if (SAFE_ATTR.has(k) && k !== 'class') props[k] = at[k];
  return <Dynamic {...props}>{kids.map((k: any) => <SNode n={k} />)}</Dynamic>;
}
// hast -> compact (for the client mdast path)
function hc(n: any): any {
  if (n.type === 'text') return n.value;
  if (n.type === 'element') { const at: any = {}; for (const k in n.properties) { const v = n.properties[k]; at[k === 'className' ? 'class' : k] = Array.isArray(v) ? v.join(' ') : v === true ? '' : String(v); } return [n.tagName, at, ...n.children.map(hc).filter((x: any) => x !== null)]; }
  if (n.type === 'root') return n.children.map(hc).filter((x: any) => x !== null);
  return null;
}
const mdOpts = { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: true };

const MODES: Record<string, (t: any) => any> = {
  html: (t) => <For each={t.html}>{(h: any) => <div class="comment" innerHTML={h} />}</For>,
  'ast-dom': (t) => <For each={t.ast}>{(a: any) => <div class="comment">{a.map(dom)}</div>}</For>,
  'ast-solid': (t) => <For each={t.ast}>{(a: any) => <div class="comment">{a.map((n: any) => <SNode n={n} />)}</div>}</For>,
  'md-micromark': (t) => <For each={t.md}>{(m: any) => <div class="comment" innerHTML={DOMPurify.sanitize(micromark(m, mdOpts))} />}</For>,
  'md-marked': (t) => <For each={t.md}>{(m: any) => <div class="comment" innerHTML={DOMPurify.sanitize(marked.parse(m, { gfm: true }) as string)} />}</For>,
  'md-mdast': (t) => <For each={t.md}>{(m: any) => <div class="comment">{hc(toHast(fromMarkdown(m, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))).map(dom)}</div>}</For>,
};

let dispose: (() => void) | undefined;
let colourAfter = false;
(window as any).run = (mode: string, thread: any, hl = false) =>
  new Promise<number>((res) => {
    dispose?.(); colourAfter = hl;
    const app = document.getElementById('app')!;
    app.textContent = '';
    const t0 = performance.now();
    dispose = render(() => MODES[mode](thread), app);
    void app.offsetHeight; // force style + layout in the measured span
    const t1 = performance.now();
    let hlMs = 0, blocks = 0;
    if (colourAfter) { blocks = colour(app); void app.offsetHeight; hlMs = performance.now() - t1; }
    requestAnimationFrame(() => setTimeout(() => res([performance.now() - t0, t1 - t0, hlMs, blocks] as any), 0));
  });
(window as any).ready = true;
