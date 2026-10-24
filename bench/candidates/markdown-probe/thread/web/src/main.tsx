// Throwaway thread-size probe. window.go(k) parses window.TXT (the detail response as the server
// sends it, already decompressed) and renders it: all comments, or (k > 0) the first plus the newest
// k with a "N hidden" row in between. Resolves with [parse, parse+walk+layout, frame] ms from t0,
// the element count and the walk (DOM creation) ms alone.
import { render } from '@solidjs/web';
import { For } from 'solid-js';

const CLS: Record<string, string> = { p: 'x1 x2', a: 'x3', code: 'x4 x5', pre: 'x6 x7 x8', li: 'x9', ul: 'x10', ol: 'x10', blockquote: 'x11 x12', table: 'x13', td: 'x14', th: 'x14 x15', img: 'x16', h1: 'x17', h2: 'x17', h3: 'x17', h4: 'x17' };
const SAFE_ATTR = new Set(['href', 'src', 'alt', 'title', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'align', 'id', 'class', 'width', 'height', 'start', 'open', 'lang']);
// The ~0.6 KB walker from markdown-rendering.md: compact AST -> DOM, allowlisted tags/attrs.
function dom(n: any): Node {
  if (typeof n === 'string') return document.createTextNode(n);
  const [tag, at, ...kids] = n;
  const el = document.createElement(tag);
  if (at) for (const k in at) if (SAFE_ATTR.has(k) && (k !== 'class' || (tag === 'code' && at[k].startsWith('language-')))) el.setAttribute(k, at[k]);
  const c = CLS[tag]; if (c) el.className = (el.className ? el.className + ' ' : '') + c;
  for (const k of kids) el.appendChild(dom(k));
  return el;
}
const Comment = (p: { c: any }) => (
  <div class="comment">
    <div class="meta">{p.c.author} commented {p.c.created_at}</div>
    <div>{p.c.body.map(dom)}</div>
  </div>
);
const Thread = (p: { d: any[]; k: number }) => {
  const d = p.d, k = p.k;
  if (!k || d.length <= k + 1) return <For each={d}>{(c: any) => <Comment c={c} />}</For>;
  const tail = d.slice(d.length - k);
  return <>
    <Comment c={d[0]} />
    <div class="more">{d.length - 1 - k} hidden comments</div>
    <For each={tail}>{(c: any) => <Comment c={c} />}</For>
  </>;
};

let dispose: (() => void) | undefined;
const w = window as any;
w.clear = () => { dispose?.(); dispose = undefined; w.KEEP = undefined; document.getElementById('app')!.textContent = ''; };
w.go = (k = 0) => new Promise((res) => {
  w.clear();
  const app = document.getElementById('app')!;
  const t0 = performance.now();
  const d = JSON.parse(w.TXT);
  const t1 = performance.now();
  w.KEEP = d; // the page holds the whole parsed thread, as a detail route would
  dispose = render(() => <Thread d={d} k={k} />, app);
  const tw = performance.now();
  void app.offsetHeight; // style + layout inside the measured span
  const t2 = performance.now();
  requestAnimationFrame(() => setTimeout(() => res([t1 - t0, t2 - t0, performance.now() - t0, app.getElementsByTagName('*').length, tw - t1]), 0));
});
if (location.search.includes('nocss')) document.querySelector('style')!.remove(); // sensitivity check: no stylesheet
if (location.search.includes('cv')) document.head.insertAdjacentHTML('beforeend', '<style>.comment { content-visibility: auto; contain-intrinsic-size: auto 240px; }</style>'); // variant: skip layout of off-screen comments
w.ready = true;
