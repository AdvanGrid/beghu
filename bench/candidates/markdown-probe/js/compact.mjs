// Compact AST: an element is [tag, attrs|0, ...children], text is a string. Built from HTML so
// it is renderer-agnostic (comrak's AST would serialise to the same shape). Whitespace-only text
// between block elements is dropped (it renders to nothing outside <pre>).
import { parseFragment } from 'parse5';
const BLOCK = new Set(['p','ul','ol','li','table','thead','tbody','tr','td','th','blockquote','div','pre','h1','h2','h3','h4','h5','h6','section','details','hr']);
function conv(n, inPre) {
  if (n.nodeName === '#text') return n.value;
  if (n.nodeName === '#comment') return null;
  const pre = inPre || n.nodeName === 'pre';
  const kids = [];
  for (const c of n.childNodes ?? []) {
    if (c.nodeName === '#text' && !pre && BLOCK.has(n.nodeName) && /^\s*$/.test(c.value)) continue;
    const v = conv(c, pre); if (v !== null) kids.push(v);
  }
  const at = n.attrs?.length ? Object.fromEntries(n.attrs.map((a) => [a.name, a.value])) : 0;
  return [n.nodeName, at, ...kids];
}
export function compact(html) {
  const f = parseFragment(html);
  const out = [];
  for (const c of f.childNodes) { if (c.nodeName === '#text' && /^\s*$/.test(c.value)) continue; const v = conv(c, false); if (v !== null) out.push(v); }
  return out;
}
