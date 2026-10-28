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
// The look is Markdown style B (spec #86; prototyped in #68): GitHub-sized headings in their
// level's colour after a split-line level mark, alerts as tinted callouts with an icon and title,
// coloured bullets and list numbers, code blocks with a header bar (./code.ts, which also
// highlights them), a ↗ after links off GitHub, mention pills and zebra tables. Every colour is a
// token (./tokens.stylex.ts), and icons come from one sprite (./icons.ts). Images, attachments,
// video and file chips are ./media.ts's: every image loads through beghu, sized before it does.
import * as stylex from "@stylexjs/stylex";
import { issueState, STATE_LABEL } from "../bits";
import { matchSpans, type Term } from "../highlight";
import { colors, fonts } from "../tokens.stylex";
import type { Md, MdAttrs, MdNode } from "./ast";
import { codeBlock, highlight, inBlock } from "./code";
import { icon, type IconName } from "./icons";
import { issueLink, linkHref, safeUrl, teamUrl, userUrl, type Links } from "./links";
import { attachment, fileChip, image, isFile, mediaSrc } from "./media";
import { md as tone } from "./tokens.stylex";

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
  // Made by ./media.ts, which keeps `alt` and sizes it from `width` and `height`.
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

type Alert = "note" | "tip" | "important" | "warning" | "caution";

const ALERT_ICON: Record<Alert, IconName> = { note: "info", tip: "bulb", important: "report", warning: "alert", caution: "stop" };

const str = (v: string | number | undefined) => (v === undefined ? undefined : String(v));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: stylex.StyleXStyles | false, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.className = stylex.props(style).className ?? "";
  e.append(...kids);
  return e;
}

/** Where a node goes: its parent, that parent's depth and list nesting, and the node after it. */
type Place = { parent: Node; depth: number; lists: number; next: MdNode | undefined };

/**
 * An element as made: what goes in the parent, what its children go in (often the same), and
 * anything that follows it.
 */
type Made = { outer: HTMLElement; into: HTMLElement; after?: Node };

/** The nodes `md` renders to, for one post, its links resolved against `links`, `terms` marked. */
export function renderMd(md: Md, links: Links, terms: Term[] = []): Node[] {
  const host = document.createDocumentFragment();
  // Nodes still to place, each with where it goes; the top of the stack is next, so siblings go
  // on in reverse.
  const todo: { n: MdNode; at: Place }[] = [];
  const push = (kids: MdNode[], parent: Node, depth: number, lists: number) => {
    for (let i = kids.length - 1; i >= 0; i--) todo.push({ n: kids[i]!, at: { parent, depth, lists, next: kids[i + 1] } });
  };
  // Code blocks to colour once the walk is done, with their labels.
  const blocks: [HTMLElement, string][] = [];
  push(md, host, 0, 0);
  for (let next = todo.pop(); next; next = todo.pop()) {
    const { n, at } = next;
    if (typeof n === "string") {
      (at.parent as ParentNode).append(...marked(n, terms));
      continue;
    }
    if (!Array.isArray(n) || typeof n[0] !== "string") continue;
    const [tag, attrs, ...kids] = n;
    const a: MdAttrs = attrs || {};
    if (tag === "ref") {
      const r = ref(a, links);
      if (r) at.parent.appendChild(r);
      continue;
    }
    // An element the walker doesn't make, or one past MAX_DEPTH, still shows what's inside it.
    const made = at.depth < MAX_DEPTH ? element(tag, a, kids, at, links) : undefined;
    if (made) {
      at.parent.appendChild(made.outer);
      if (made.after) at.parent.appendChild(made.after);
      const label = made.into.dataset.lang;
      if (tag === "code" && label && at.parent.nodeName === "PRE") blocks.push([made.into, label]);
    }
    const lists = tag === "ul" || tag === "ol" ? at.lists + 1 : at.lists;
    push(kids, made?.into ?? at.parent, made ? at.depth + 1 : at.depth, lists);
  }
  for (const [code, label] of blocks) highlight(code, label);
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

/** The language a `code` element's class names (`language-rust`), if any. */
function langOf(a: MdAttrs): string | undefined {
  return /(?:^|\s)language-(\S+)/.exec(str(a.class) ?? "")?.[1];
}

/** Whether a task-list item: its first child is the checkbox. */
function isTask(kids: MdNode[]): boolean {
  const first = kids[0];
  return Array.isArray(first) && first[0] === "input";
}

/** The text of a node's children, as written: a link's, to name a file chip. */
function textOf(kids: MdNode[]): string {
  return kids.map((k) => (typeof k === "string" ? k : textOf(k.slice(2) as MdNode[]))).join("");
}

function element(tag: string, a: MdAttrs, kids: MdNode[], at: Place, links: Links): Made | undefined {
  if (tag === "media") {
    const m = attachment(a, at.parent, links, (e) => copy(e, a, []));
    return { outer: m, into: document.createElement("span") };
  }
  if (tag === "img") {
    const m = image(a, at.parent, links, (e) => copy(e, a, []));
    return { outer: m, into: m };
  }
  if (tag === "a") {
    const href = safeUrl(str(a.href) ?? "");
    // A file attachment: a chip to GitHub, named by the link. What's inside the link goes nowhere.
    if (href !== undefined && isFile(href)) return { outer: fileChip(href, textOf(kids)), into: document.createElement("span") };
  }
  const keep = Object.hasOwn(TAGS, tag) ? TAGS[tag]! : undefined;
  if (keep === undefined) return undefined;
  if (tag === "input") {
    const box = checkbox(a, at.parent.nodeName === "LI");
    return { outer: box, into: box };
  }
  if (tag === "pre") {
    // A fenced block's language is on the code inside it.
    const code = kids[0];
    const label = Array.isArray(code) && code[0] === "code" ? langOf(code[1] || {}) : undefined;
    const { box, pre } = codeBlock(label);
    copy(pre, a, keep);
    return { outer: box, into: pre };
  }
  const e = document.createElement(tag);
  copy(e, a, keep);
  let into: HTMLElement = e;
  let after: Node | undefined;
  const cls = str(a.class) ?? "";
  const styles: stylex.StyleXStyles[] = [byTag[tag]];
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // The level mark: a fixed-width line cut into as many segments as the level, then the
      // text, which so starts at the same place whatever the level.
      const level = Number(tag[1]);
      const mark = el("span", s.levelMark);
      mark.setAttribute("aria-hidden", "true");
      for (let i = 0; i < level; i++) mark.append(el("span", s.segment));
      into = el("span", s.headingText);
      e.append(mark, into);
      styles.push(s.heading);
      break;
    }
    case "a": {
      const raw = safeUrl(str(a.href) ?? "", { fragment: true, mail: true });
      if (raw !== undefined) {
        const { href, inApp, comment } = linkHref(links, raw);
        e.setAttribute("href", href);
        if (inApp) e.setAttribute("noscroll", "");
        else if (!href.startsWith("#")) {
          outward(e);
          if (offGitHub(href) && !arrowed(kids, at.next) && !onlyImages(kids)) {
            // A decoration: hidden from screen readers, which hear the link as one already.
            after = el("span", s.away, "↗");
            (after as HTMLElement).setAttribute("aria-hidden", "true");
            (after as HTMLElement).dataset.perf = "away";
          }
        }
        if (comment !== undefined) toComment(e, comment);
      }
      break;
    }
    case "source": {
      // Through beghu, as every image.
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
      // A fenced block's text (./code.ts colours it by this language), or inline code.
      const lang = langOf(a);
      if (lang) e.dataset.lang = lang;
      if (at.parent.nodeName === "PRE") styles[0] = inBlock;
      break;
    }
    case "div": {
      const kind = /markdown-alert-(\w+)/.exec(cls)?.[1];
      if (kind && ALERTS.has(kind)) {
        e.dataset.alert = kind;
        styles.push(s.alert, alertTone[kind as Alert]);
      }
      break;
    }
    case "p": {
      // An alert's title: its icon, in the alert's colour.
      const kind = (at.parent as HTMLElement).dataset?.alert as Alert | undefined;
      if (/\bmarkdown-alert-title\b/.test(cls) && kind && ALERTS.has(kind)) {
        styles.push(s.alertTitle, titleTone[kind]);
        e.append(icon(ALERT_ICON[kind]));
      }
      break;
    }
    case "ul":
      // Bullets alternate ● and ○ by how deep the list sits.
      styles.push(at.lists % 2 === 0 ? s.disc : s.circle);
      break;
    case "li":
      // A task-list item: its checkbox stands in for the bullet, and a done one is muted.
      if (isTask(kids)) {
        const box = (kids[0] as [string, MdAttrs | 0])[1] || {};
        styles.push(s.task, "checked" in box && s.done);
      }
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
  return { outer: e, into, after };
}

/** Copies the attributes `tag` keeps from `a` onto `e`. */
function copy(e: HTMLElement, a: MdAttrs, keep: string[]): void {
  for (const k of [...GENERIC, ...keep]) {
    const v = str(a[k]);
    if (v !== undefined) e.setAttribute(k, v);
  }
}

/** A task-list checkbox (`inItem`, standing in for the bullet), or any checkbox in a post: read-only. */
function checkbox(a: MdAttrs, inItem: boolean): HTMLInputElement {
  const box = el("input", inItem ? s.taskBox : s.input);
  box.type = "checkbox";
  box.disabled = true;
  box.checked = "checked" in a;
  return box;
}

/** Whether `href` leaves GitHub (and beghu): a web page anywhere else. */
function offGitHub(href: string): boolean {
  return /^https?:\/\//i.test(href) && !/^https?:\/\/(?:[\w-]+\.)*github\.com(?:[/?#:]|$)/i.test(href);
}

/** An arrow ending a link's text, or one just after the link: the author's own. */
const ARROW_END = /[↗↪➚]\s*$/;
const ARROW_AFTER = /^\s?[↗↪➚]/;

/** Whether the author already marked a link as going out: an arrow ending its text, or just after it. */
function arrowed(kids: MdNode[], next: MdNode | undefined): boolean {
  const last = kids.at(-1);
  return (typeof last === "string" && ARROW_END.test(last)) || (typeof next === "string" && ARROW_AFTER.test(next));
}

/** Whether a link shows only images: a badge, which takes no arrow. */
function onlyImages(kids: MdNode[]): boolean {
  return kids.length > 0 && kids.every((k) => (typeof k === "string" ? k.trim() === "" : k[0] === "img" || k[0] === "picture"));
}

/** `srcset` with every candidate's URL re-checked (beghu's own routes only), or undefined if any fails. */
function srcset(raw: string): string | undefined {
  const out: string[] = [];
  for (const candidate of raw.split(",")) {
    const [url, ...size] = candidate.trim().split(/\s+/);
    const safe = mediaSrc(url);
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
  if (typeof a.u === "string") return mention(`@${a.u}`, userUrl(a.u));
  if (typeof a.t === "string") {
    const url = teamUrl(a.t);
    return url === undefined ? undefined : mention(`@${a.t}`, url);
  }
  if (typeof a.o !== "string" || typeof a.r !== "string" || typeof a.n !== "number") return undefined;
  const link = issueLink(links, a.o, a.r, a.n, typeof a.c === "number" ? a.c : undefined);
  if (!link.inApp) {
    // Outside the mirror: to GitHub, marked ↗ (a decoration, as after an off-GitHub link).
    const arrow = el("span", false, " ↗");
    arrow.setAttribute("aria-hidden", "true");
    const e = el("a", [s.ref, s.refOut], link.label, arrow);
    e.setAttribute("href", link.href);
    e.title = "Opens on GitHub";
    outward(e);
    e.dataset.ref = "out";
    return e;
  }
  const state = issueState(link.target);
  const e = el("a", [s.ref, stateTone[state]], icon(state, s.refIcon), link.label);
  e.setAttribute("href", link.href);
  e.setAttribute("noscroll", "");
  if (typeof a.c === "number") toComment(e, a.c);
  e.title = `${link.target.title} · ${STATE_LABEL[state]}`;
  e.dataset.ref = state;
  return e;
}

/** A user or team: a pill that opens on GitHub. */
function mention(label: string, href: string): HTMLElement {
  const e = el("a", s.mention, label);
  e.setAttribute("href", href);
  e.title = "Opens on GitHub";
  e.dataset.ref = "mention";
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

/** Block elements end flush with their post (or list item, cell, alert…) when they come last. */
const LAST = { default: "0.7em", ":last-child": 0 };

const s = stylex.create({
  a: {
    textDecoration: { default: "none", ":hover": "underline" },
    color: tone.link,
  },
  blockquote: {
    marginInline: 0,
    borderInlineStartColor: tone.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    color: tone.quote,
    paddingInlineStart: 12,
    marginBottom: LAST,
    marginTop: 0,
  },
  code: {
    borderRadius: 4,
    paddingBlock: "0.15em",
    paddingInline: "0.35em",
    backgroundColor: tone.codeBg,
    color: tone.codeFg,
    fontFamily: fonts.mono,
    fontSize: "0.88em",
  },
  dd: { marginInlineStart: 16 },
  del: { color: tone.muted },
  details: {
    borderColor: tone.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 10,
    marginBottom: LAST,
  },
  dl: { marginBottom: LAST, marginTop: 0, },
  dt: { fontWeight: 600 },
  figure: { marginInline: 0, marginBottom: LAST, marginTop: 0, },
  h1: {
    color: tone.h1,
    fontSize: "1.45em",
    borderBottomColor: tone.h1Rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 2,
    paddingBottom: "0.25em",
  },
  h2: {
    color: tone.h2,
    fontSize: "1.25em",
    borderBottomColor: tone.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBottom: "0.2em",
  },
  h3: { color: tone.h3, fontSize: "1.1em" },
  h4: { color: tone.h4, fontSize: "1em" },
  h5: { color: tone.h5, fontSize: "0.93em" },
  h6: {
    color: tone.h6,
    fontSize: "0.87em",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  hr: {
    borderWidth: 0,
    marginBlock: 16,
    backgroundColor: tone.line,
    height: 1,
  },
  input: { marginBlock: 0, marginInlineEnd: 6, verticalAlign: "middle" },
  kbd: {
    borderColor: tone.line,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 1,
    paddingInline: 5,
    backgroundColor: tone.codeHead,
    fontFamily: fonts.mono,
    fontSize: "0.85em",
  },
  // Bullets and numbers in the list colour.
  li: {
    marginBlock: "0.1em",
    "::marker": { color: tone.bullet },
  },
  ol: { paddingInlineStart: "1.5em", marginBottom: LAST, marginTop: 0, },
  p: { marginBottom: LAST, marginTop: 0, },
  strong: { fontWeight: 650 },
  summary: {
    paddingBlock: 2,
    color: tone.muted,
    cursor: "pointer",
    fontWeight: 550,
  },
  table: {
    borderCollapse: "collapse",
    display: "block",
    fontSize: "0.95em",
    borderTopColor: tone.tableLine,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    marginBottom: LAST,
    overflowX: "auto",
  },
  td: {
    paddingBlock: 4,
    paddingInline: 10,
    verticalAlign: "top",
    borderBottomColor: tone.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  th: {
    paddingBlock: 4,
    paddingInline: 10,
    fontWeight: 600,
    textAlign: "start",
    verticalAlign: "top",
    borderBottomColor: tone.tableLine,
    borderBottomStyle: "solid",
    borderBottomWidth: 2,
  },
  // Zebra rows: :nth-child counts within the row's own thead or tbody, so the header's row is
  // never tinted and a body's tint starts at its second row.
  tr: {
    backgroundColor: { default: null, ":nth-child(even)": tone.zebra },
  },
  tt: { fontFamily: fonts.mono },
  ul: { paddingInlineStart: "1.5em", marginBottom: LAST, marginTop: 0, },
  // Beyond one class per tag.
  // A search's match in the text.
  match: { borderRadius: 2, backgroundColor: colors.mark, color: "inherit" },
  heading: {
    gap: 8,
    alignItems: "baseline",
    display: "flex",
    fontWeight: 650,
    lineHeight: 1.3,
    marginBottom: "0.5em",
    marginTop: { default: "1.1em", ":first-child": 0 },
  },
  // A heading's level: 42.5 × 5 px, in as many segments as the level (h1 a line, h6 six dots).
  levelMark: {
    gap: 2.5,
    alignSelf: "center",
    display: "inline-flex",
    flexShrink: 0,
    width: 42.5,
  },
  segment: {
    borderRadius: 2.5,
    backgroundColor: "currentColor",
    flexBasis: 0,
    flexGrow: 1,
    height: 5,
  },
  headingText: {
    display: "flow-root",
    flexGrow: 1,
    minWidth: 0,
  },
  disc: { listStyleType: "disc" },
  circle: { listStyleType: "circle" },
  // A task item's checkbox sits where its bullet would, so its text lines up with other items'
  // however the item is laid out (one line, or paragraphs).
  task: { listStyleType: "none", position: "relative" },
  taskBox: {
    margin: 0,
    insetInlineStart: "-1.4em",
    position: "absolute",
    top: "0.3em",
  },
  done: { color: tone.muted },
  center: { textAlign: "center" },
  right: { fontVariantNumeric: "tabular-nums", textAlign: "end" },
  alert: {
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 8,
    paddingInline: 12,
    marginBottom: LAST,
  },
  alertTitle: {
    gap: 6,
    alignItems: "center",
    display: "flex",
    fontWeight: 600,
    marginBottom: "0.25em",
  },
  footnotes: {
    color: tone.muted,
    fontSize: "0.9em",
    borderTopColor: tone.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    marginTop: 16,
    paddingTop: 6,
  },
  footnotesTitle: { marginBlock: 0, fontSize: "1em", fontWeight: 600, marginBottom: 2 },
  // The ↗ after an off-GitHub link, unless its author wrote one.
  away: {
    color: tone.muted,
    fontSize: "0.8em",
    marginInlineStart: 1,
  },
  mention: {
    borderRadius: 4,
    paddingInline: 3,
    textDecoration: "none",
    backgroundColor: tone.mentionBg,
    color: colors.fg,
    fontWeight: 600,
  },
  ref: {
    textDecoration: { default: "none", ":hover": "underline" },
    fontWeight: 550,
    whiteSpace: "nowrap",
  },
  refOut: { color: tone.link, fontWeight: 400 },
  refIcon: { marginInlineEnd: 3, height: "0.95em", width: "0.95em" },
});

/** Each tag's own style: every element the walker makes gets one, if it has one. */
const byTag: Record<string, stylex.StyleXStyles> = {
  a: s.a,
  blockquote: s.blockquote,
  code: s.code,
  dd: s.dd,
  del: s.del,
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
  kbd: s.kbd,
  li: s.li,
  ol: s.ol,
  p: s.p,
  s: s.del,
  strike: s.del,
  strong: s.strong,
  b: s.strong,
  summary: s.summary,
  table: s.table,
  td: s.td,
  th: s.th,
  tr: s.tr,
  tt: s.tt,
  ul: s.ul,
};

const alertTone = stylex.create({
  note: { borderColor: tone.noteBorder, backgroundColor: tone.noteBg, },
  tip: { borderColor: tone.tipBorder, backgroundColor: tone.tipBg, },
  important: { borderColor: tone.importantBorder, backgroundColor: tone.importantBg, },
  warning: { borderColor: tone.warningBorder, backgroundColor: tone.warningBg, },
  caution: { borderColor: tone.cautionBorder, backgroundColor: tone.cautionBg, },
});

const titleTone = stylex.create({
  note: { color: tone.note },
  tip: { color: tone.tip },
  important: { color: tone.important },
  warning: { color: tone.warning },
  caution: { color: tone.caution },
});

const stateTone = stylex.create({
  open: { color: tone.refOpen },
  done: { color: tone.refDone },
  notPlanned: { color: tone.refNotPlanned },
});
