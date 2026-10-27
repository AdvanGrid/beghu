// The Markdown walker: the server's compact AST (./ast.ts) to plain DOM. It's the browser's own
// allowlist, behind the server's sanitiser: it creates only the tags below, copies only their
// listed attributes, re-checks every URL's scheme, and puts a StyleX class on each element. It
// never parses HTML or Markdown: text goes in as text nodes. References become links through the
// link resolver (./links.ts). Task-list checkboxes are read-only. A search's words are marked in
// the text (../highlight.ts), node by node: a phrase that spans inline nodes isn't marked.
//
// It walks with a stack of its own, never by recursion, and nests elements at most MAX_DEPTH deep
// (as the server does): an element past that is left out and what's inside it goes to the deepest
// one kept. However deep an AST comes, it renders.
//
// This is the plain, readable look; Markdown style B (#99) restyles it.
import * as stylex from "@stylexjs/stylex";
import { issueState, STATE_LABEL, type IssueState } from "../bits";
import { matchSpans, type Term } from "../highlight";
import { colors, fonts } from "../tokens.stylex";
import type { Md, MdAttrs, MdNode } from "./ast";
import { issueLink, linkHref, safeUrl, teamUrl, userUrl, type Links } from "./links";

/** How deep elements nest at most: crates/md-ast's MAX_DEPTH. */
const MAX_DEPTH = 100;

/** Attributes any element may keep. */
const GENERIC = ["id", "title", "lang", "dir"];

/** The elements the walker creates, with the attributes each keeps beyond GENERIC. */
const TAGS: Record<string, string[]> = {
  a: ["name", "aria-label"],
  abbr: [],
  b: [],
  bdo: [],
  blockquote: [],
  br: [],
  caption: [],
  cite: [],
  code: [],
  dd: [],
  del: [],
  details: ["open"],
  dfn: [],
  div: [],
  dl: [],
  dt: [],
  em: [],
  figcaption: [],
  figure: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  i: [],
  img: ["alt", "width", "height"],
  input: [],
  ins: [],
  kbd: [],
  li: [],
  mark: [],
  ol: ["start", "type"],
  p: [],
  picture: [],
  pre: [],
  q: [],
  rp: [],
  rt: [],
  ruby: [],
  s: [],
  samp: [],
  section: [],
  small: [],
  source: ["media", "type", "width", "height"],
  span: [],
  strike: [],
  strong: [],
  sub: [],
  summary: [],
  sup: [],
  table: [],
  tbody: [],
  td: ["colspan", "rowspan"],
  tfoot: [],
  th: ["colspan", "rowspan"],
  thead: [],
  time: ["datetime"],
  tr: [],
  tt: [],
  ul: [],
  var: [],
  wbr: [],
};

const ALERTS = new Set(["note", "tip", "important", "warning", "caution"]);

const str = (v: string | number | undefined) => (v === undefined ? undefined : String(v));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: stylex.StyleXStyles | false, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.className = stylex.props(style).className ?? "";
  e.append(...kids);
  return e;
}

/** The nodes `md` renders to, for one post, its links resolved against `links`, `terms` marked. */
export function renderMd(md: Md, links: Links, terms: Term[] = []): Node[] {
  const host = document.createDocumentFragment();
  // Nodes still to place, each with the parent it goes in and that parent's depth; the top of the
  // stack is next, so siblings go on in reverse.
  const todo: { n: MdNode; parent: Node; depth: number }[] = [];
  const push = (kids: MdNode[], parent: Node, depth: number) => {
    for (let i = kids.length - 1; i >= 0; i--) todo.push({ n: kids[i]!, parent, depth });
  };
  push(md, host, 0);
  for (let next = todo.pop(); next; next = todo.pop()) {
    const { n, parent, depth } = next;
    if (typeof n === "string") {
      (parent as ParentNode).append(...marked(n, terms));
      continue;
    }
    if (!Array.isArray(n) || typeof n[0] !== "string") continue;
    const [tag, at, ...kids] = n;
    const a: MdAttrs = at || {};
    if (tag === "ref") {
      const r = ref(a, links);
      if (r) parent.appendChild(r);
      continue;
    }
    // An element the walker doesn't make, or one past MAX_DEPTH, still shows what's inside it.
    const e = depth < MAX_DEPTH ? element(tag, a, links) : undefined;
    // A task-list item: its checkbox stands in for the bullet.
    if (e && tag === "li" && Array.isArray(kids[0]) && kids[0][0] === "input") e.className = stylex.props(byTag.li, s.task).className ?? "";
    if (e) parent.appendChild(e);
    push(kids, e ?? parent, e ? depth + 1 : depth);
  }
  return [...host.childNodes];
}

/**
 * A post's text, as DOM, with the spans the search's `terms` match marked: the one place the
 * walker turns the author's text into nodes (labels it writes itself, such as a reference's,
 * don't come here). The detail marks an issue's title with it too.
 */
export function marked(t: string, terms: Term[]): Node[] {
  const spans = matchSpans(t, terms);
  if (spans.length === 0) return [document.createTextNode(t)];
  const out: Node[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    if (start > at) out.push(document.createTextNode(t.slice(at, start)));
    const m = el("mark", s.match, t.slice(start, end));
    m.dataset.perf = "match";
    out.push(m);
    at = end;
  }
  if (at < t.length) out.push(document.createTextNode(t.slice(at)));
  return out;
}

function element(tag: string, a: MdAttrs, links: Links): HTMLElement | undefined {
  const keep = Object.hasOwn(TAGS, tag) ? TAGS[tag]! : undefined;
  if (keep === undefined) return undefined;
  if (tag === "input") return checkbox(a);
  const e = document.createElement(tag);
  for (const k of [...GENERIC, ...keep]) {
    const v = str(a[k]);
    if (v !== undefined) e.setAttribute(k, v);
  }
  const cls = str(a.class) ?? "";
  const styles: stylex.StyleXStyles[] = [byTag[tag]];
  switch (tag) {
    case "a": {
      const raw = safeUrl(str(a.href) ?? "", { fragment: true, mail: true });
      if (raw !== undefined) {
        const { href, inApp, comment } = linkHref(links, raw);
        e.setAttribute("href", href);
        if (inApp) e.setAttribute("noscroll", "");
        else if (!href.startsWith("#")) outward(e);
        if (comment !== undefined) toComment(e, comment);
      }
      break;
    }
    case "img": {
      // TODO(#100): images load straight from their hosts, which see the viewer's IP, until the
      // image proxy routes them through beghu.
      const src = safeUrl(str(a.src) ?? "");
      if (src !== undefined) e.setAttribute("src", src);
      e.setAttribute("loading", "lazy");
      e.setAttribute("referrerpolicy", "no-referrer");
      if (a.align === "left") styles.push(s.floatLeft);
      if (a.align === "right") styles.push(s.floatRight);
      break;
    }
    case "source": {
      // TODO(#100): as for img, straight from the image's host.
      const set = srcset(str(a.srcset) ?? "");
      if (set !== undefined) e.setAttribute("srcset", set);
      break;
    }
    case "blockquote":
    case "q":
    case "del":
    case "ins": {
      const cite = safeUrl(str(a.cite) ?? "");
      if (cite !== undefined) e.setAttribute("cite", cite);
      break;
    }
    case "code": {
      // For highlighting (#99): the fence's language.
      const lang = /(?:^|\s)language-(\S+)/.exec(cls)?.[1];
      if (lang) e.dataset.lang = lang;
      break;
    }
    case "div": {
      const kind = /markdown-alert-(\w+)/.exec(cls)?.[1];
      if (kind && ALERTS.has(kind)) {
        e.dataset.alert = kind;
        styles.push(s.alert, alertTone[kind as keyof typeof alertTone]);
      }
      break;
    }
    case "p":
      if (/\bmarkdown-alert-title\b/.test(cls)) styles.push(s.alertTitle);
      break;
    case "section":
      if ("data-footnotes" in a) {
        e.dataset.footnotes = "";
        styles.push(s.footnotes);
        e.prepend(el("h2", s.footnotesTitle, "Footnotes"));
      }
      break;
    case "td":
    case "th":
      if (a.align === "center") styles.push(s.center);
      if (a.align === "right") styles.push(s.right);
      break;
  }
  e.className = stylex.props(styles).className ?? "";
  return e;
}

/** A task-list checkbox, or any checkbox in a post: read-only. */
function checkbox(a: MdAttrs): HTMLInputElement {
  const box = el("input", s.input);
  box.type = "checkbox";
  box.disabled = true;
  box.checked = "checked" in a;
  return box;
}

/** `srcset` with every candidate's URL re-checked, or undefined if any fails. */
function srcset(raw: string): string | undefined {
  const out: string[] = [];
  for (const candidate of raw.split(",")) {
    const [url, ...size] = candidate.trim().split(/\s+/);
    const safe = safeUrl(url ?? "");
    if (safe === undefined) return undefined;
    out.push([safe, ...size].join(" "));
  }
  return out.join(", ");
}

/** A link that leaves beghu: a new tab, telling the target nothing. */
function outward(a: HTMLElement): void {
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
}

/** A `ref` node as a link. */
function ref(a: MdAttrs, links: Links): HTMLElement | undefined {
  if (typeof a.u === "string") return toGitHub(s.mention, `@${a.u}`, userUrl(a.u));
  if (typeof a.t === "string") {
    const url = teamUrl(a.t);
    return url === undefined ? undefined : toGitHub(s.mention, `@${a.t}`, url);
  }
  if (typeof a.o !== "string" || typeof a.r !== "string" || typeof a.n !== "number") return undefined;
  const link = issueLink(links, a.o, a.r, a.n, typeof a.c === "number" ? a.c : undefined);
  if (!link.inApp) {
    const e = toGitHub(s.ref, link.label, link.href);
    e.dataset.ref = "out";
    return e;
  }
  const state = issueState(link.target);
  const e = el("a", s.ref, stateIcon(state), link.label);
  e.setAttribute("href", link.href);
  e.setAttribute("noscroll", "");
  if (typeof a.c === "number") toComment(e, a.c);
  e.title = `${link.target.title} · ${STATE_LABEL[state]}`;
  e.dataset.ref = state;
  return e;
}

/** A reference that opens on GitHub, as every user, team and reference outside the mirror does. */
function toGitHub(style: stylex.StyleXStyles, label: string, href: string): HTMLElement {
  const e = el("a", style, `${label} ↗`);
  e.setAttribute("href", href);
  e.title = "Opens on GitHub";
  outward(e);
  return e;
}

/**
 * A link to a comment: when the comment is on the page (the open issue's, loaded), a click
 * scrolls to it instead of opening its issue.
 */
function toComment(a: HTMLElement, comment: number): void {
  a.addEventListener("click", (ev) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const shown = document.querySelector(`[data-comment-id="${comment}"]`);
    // TODO: a comment not on the page (another issue's, or one on a page of the thread not
    // loaded yet) opens its issue at the top; it could load the comment's page and scroll there.
    if (!shown) return;
    ev.preventDefault();
    shown.scrollIntoView({ block: "start" });
  });
}

const SVG = "http://www.w3.org/2000/svg";

/** The state icon (bits.tsx's StateIcon, as plain DOM), in the state's colour. */
function stateIcon(state: IssueState): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const shape = (name: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" })) svg.setAttribute(k, v);
  svg.setAttribute("class", stylex.props(s.icon, stateTone[state]).className ?? "");
  const line = { fill: "none", stroke: "currentColor", "stroke-width": "1.5" };
  shape("circle", { cx: "8", cy: "8", r: "6.25", ...line });
  if (state === "open") shape("circle", { cx: "8", cy: "8", r: "1.5", fill: "currentColor" });
  if (state === "done") shape("path", { d: "M5.2 8.2 7.1 10l3.7-4", ...line });
  if (state === "notPlanned") shape("path", { d: "M3.8 12.2 12.2 3.8", ...line });
  return svg;
}

const s = stylex.create({
  a: { color: colors.accent },
  blockquote: {
    marginBlock: 0,
    marginInline: 0,
    paddingInline: 12,
    borderInlineStartColor: colors.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    color: colors.muted,
    marginBottom: 12,
  },
  code: {
    borderRadius: 4,
    paddingBlock: 1,
    paddingInline: 4,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: "0.9em",
  },
  dd: { marginInlineStart: 16 },
  details: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 6,
    paddingInline: 10,
    marginBottom: 12,
  },
  dl: { marginBlock: 0, marginBottom: 12 },
  dt: { fontWeight: 600 },
  figure: { marginBlock: 0, marginInline: 0, marginBottom: 12, },
  h1: { marginBlock: 0, fontSize: "1.6em", borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, marginBottom: 12, paddingBottom: 4, },
  h2: { marginBlock: 0, fontSize: "1.35em", borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, marginBottom: 12, paddingBottom: 4, },
  h3: { marginBlock: 0, fontSize: "1.15em", marginBottom: 10, },
  h4: { marginBlock: 0, fontSize: "1em", marginBottom: 8, },
  h5: { marginBlock: 0, fontSize: "0.9em", marginBottom: 8, },
  h6: { marginBlock: 0, color: colors.muted, fontSize: "0.85em", marginBottom: 8, },
  hr: { borderWidth: 0, marginBlock: 16, backgroundColor: colors.line, height: 1, },
  img: { verticalAlign: "middle", maxWidth: "100%", },
  input: { marginBlock: 0, marginInlineEnd: 6, verticalAlign: "middle" },
  kbd: {
    borderColor: colors.line,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 1,
    paddingInline: 5,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: "0.85em",
  },
  li: { marginBlock: 2 },
  ol: { marginBlock: 0, paddingInlineStart: 24, marginBottom: 12, },
  p: { marginBlock: 0, marginBottom: 12 },
  pre: {
    padding: 10,
    borderRadius: 6,
    marginBlock: 0,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: 13,
    whiteSpace: "pre",
    marginBottom: 12,
    overflowX: "auto",
  },
  summary: { color: colors.muted, cursor: "pointer" },
  table: { borderCollapse: "collapse", display: "block", marginBottom: 12, overflowX: "auto", },
  td: { borderColor: colors.line, borderStyle: "solid", borderWidth: 1, paddingBlock: 4, paddingInline: 10, },
  th: { borderColor: colors.line, borderStyle: "solid", borderWidth: 1, paddingBlock: 4, paddingInline: 10, fontWeight: 600, },
  tt: { fontFamily: fonts.mono },
  ul: { marginBlock: 0, paddingInlineStart: 24, marginBottom: 12, },
  // Beyond one class per tag.
  // A search's match in the text.
  match: { borderRadius: 2, backgroundColor: colors.mark, color: "inherit" },
  task: { listStyleType: "none", marginInlineStart: -18 },
  floatLeft: { float: "left", marginInlineEnd: 8 },
  floatRight: { float: "right", marginInlineStart: 8 },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  alert: {
    paddingBlock: 8,
    paddingInline: 12,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    marginBottom: 12,
  },
  alertTitle: { fontWeight: 600 },
  footnotes: {
    color: colors.muted,
    fontSize: "0.9em",
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    marginTop: 16,
    paddingTop: 8,
  },
  footnotesTitle: { marginBlock: 0, fontSize: "1em", marginBottom: 8, },
  mention: { textDecoration: "none", color: colors.fg, fontWeight: 600, },
  ref: { color: colors.accent, whiteSpace: "nowrap" },
  icon: { marginInlineEnd: 2, verticalAlign: "-2px" },
});

/** Each tag's own style: every element the walker makes gets one, if it has one. */
const byTag: Record<string, stylex.StyleXStyles> = {
  a: s.a,
  blockquote: s.blockquote,
  code: s.code,
  dd: s.dd,
  details: s.details,
  dl: s.dl,
  dt: s.dt,
  figure: s.figure,
  h1: s.h1,
  h2: s.h2,
  h3: s.h3,
  h4: s.h4,
  h5: s.h5,
  h6: s.h6,
  hr: s.hr,
  img: s.img,
  kbd: s.kbd,
  li: s.li,
  ol: s.ol,
  p: s.p,
  pre: s.pre,
  summary: s.summary,
  table: s.table,
  td: s.td,
  th: s.th,
  tt: s.tt,
  ul: s.ul,
};

const alertTone = stylex.create({
  note: { borderInlineStartColor: colors.accent },
  tip: { borderInlineStartColor: colors.open },
  important: { borderInlineStartColor: colors.done },
  warning: { borderInlineStartColor: colors.unowned },
  caution: { borderInlineStartColor: colors.danger },
});

const stateTone = stylex.create({
  open: { color: colors.open },
  done: { color: colors.done },
  notPlanned: { color: colors.notPlanned },
});
