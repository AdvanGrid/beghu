// The whole client side of "server sends a compact AST": walk it, create elements, attach classes.
const CLS = { p: 'x1 x2', a: 'x3', code: 'x4 x5', pre: 'x6 x7 x8', li: 'x9', ul: 'x10', ol: 'x10', blockquote: 'x11 x12', table: 'x13', td: 'x14', th: 'x14 x15', img: 'x16', h1: 'x17', h2: 'x17', h3: 'x17', h4: 'x17', hr: 'x18', del: 'x19', kbd: 'x20', details: 'x21', summary: 'x22', sup: 'x23', input: 'x24' };
const TAGS = new Set(['p','a','code','pre','li','ul','ol','blockquote','table','thead','tbody','tr','td','th','img','h1','h2','h3','h4','h5','h6','hr','br','em','strong','del','kbd','details','summary','sup','sub','input','div','span','section','picture','source']);
const ATTR = new Set(['href','src','alt','title','type','checked','disabled','colspan','rowspan','align','id','width','height','start','open']);
export function dom(n, link) {
  if (typeof n === 'string') return document.createTextNode(n);
  const [tag, at, ...kids] = n;
  if (tag === 'ref') return link(at); // {o,r,n} issue reference or {u} mention, resolved by the app
  if (!TAGS.has(tag)) return document.createTextNode('');
  const el = document.createElement(tag);
  if (at) for (const k in at) if (ATTR.has(k)) el.setAttribute(k, at[k]);
  if (at && at.t) el.className = 'tok-' + at.t; // highlight token kind
  if (CLS[tag]) el.className = CLS[tag];
  for (const k of kids) el.appendChild(dom(k, link));
  return el;
}
