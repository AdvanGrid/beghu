// PROTOTYPE (beghu #68). The compact-AST walker from "Markdown rendering for bodies and comments"
// (#59), grown the decorations the three styles need: heading level marks, alert icons, code
// headers, link icons, resolved #refs and @mentions, task lists, a lightbox on images. It builds
// DOM directly; the server's AST is [tag, attrs | 0, ...kids] with text as strings.
// Classes here are plain CSS scoped by .md-A/.md-B/.md-C (md.css); v1 puts StyleX classes on
// each tag instead.
import { withHljs } from '../detail/code';
import { icon, type IconMode } from './icons';

export type Opts = {
  variant: 'A' | 'B' | 'C';
  /** Round 3: how heading levels read (B base). N numbers sections, L wraps them for a ladder. */
  heads?: string;
  icons: IconMode;
  /** The thread's repo: a bare #n means this repo. */
  repo: string;
};

// Repos in the viewer's mirror. A thread's own repo always counts as synced.
const SYNCED = new Set(['tomsjansons/beghu']);
const FIXTURE_BASE = 3000000000;
const FIXTURE_MAX = 62539;

const ATTR = new Set(['href', 'src', 'alt', 'title', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'start', 'open', 'id']);

// GitHub's linguist colours, for the dot in a code header.
const LANG_DOT: Record<string, string> = {
  rust: '#dea584', rs: '#dea584', ts: '#3178c6', typescript: '#3178c6', tsx: '#3178c6', js: '#f1e05a', javascript: '#f1e05a', jsx: '#f1e05a',
  python: '#3572a5', py: '#3572a5', lua: '#000080', bash: '#89e051', sh: '#89e051', shell: '#89e051', console: '#89e051', zsh: '#89e051',
  json: '#cbcb41', yaml: '#cb171e', yml: '#cb171e', toml: '#9c4221', diff: '#41b883', css: '#663399', html: '#e34c26', xml: '#0060ac',
  sql: '#e38c00', go: '#00add8', c: '#555555', cpp: '#f34b7d', zig: '#ec915c', swift: '#f05138', java: '#b07219', kotlin: '#a97bff',
};
const LANG_NAME: Record<string, string> = { ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', js: 'JavaScript', javascript: 'JavaScript', rs: 'Rust', rust: 'Rust', py: 'Python', python: 'Python', sh: 'Shell', bash: 'Bash', console: 'Console', yml: 'YAML', yaml: 'YAML', json: 'JSON', diff: 'Diff', lua: 'Lua', zig: 'Zig', sql: 'SQL', toml: 'TOML', css: 'CSS', html: 'HTML', xml: 'XML', go: 'Go', c: 'C', cpp: 'C++' };

const ALERT_ICON: Record<string, string> = { note: 'info', tip: 'bulb', important: 'report', warning: 'alert', caution: 'stop' };

// Fake parts of the `refs` map beside the AST (#64): state and title per reference.
const TITLES = ['Filter bar loses focus after a live push', 'Reconnect replays stale deltas', 'Tree view hides closed children', 'Comment box eats Ctrl+Enter', 'Sweep misses label renames', 'Detail panel flickers on hover preload'];
function refState(n: number): 'open' | 'done' | 'np' {
  return n % 7 === 0 ? 'done' : n % 11 === 0 ? 'np' : 'open';
}

function el(tag: string, cls?: string, kids?: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (kids) for (const k of kids) e.append(k);
  return e;
}

function text(n: any): string {
  if (typeof n === 'string') return n;
  let s = '';
  for (let i = 2; i < n.length; i++) s += text(n[i]);
  return s;
}

const REF = /(?<![\w/.-])(?:([A-Za-z\d][\w.-]*\/[\w.-]+))?#(\d+)\b|(?<![\w`])@([A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?(?:\/[\w.-]+)?)/g;
const GH_ISSUE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/;

export function render(ast: any[], o: Opts): DocumentFragment {
  const frag = document.createDocumentFragment();
  // Levels relative to the document's top heading (a comment that starts at ### treats it as
  // its first level), for numbering and the ladder.
  let top = 7;
  for (const n of ast) { const m = Array.isArray(n) && /^h([1-6])$/.exec(n[0]); if (m) top = Math.min(top, +m[1]); }
  const ctx: Ctx = { o, listDepth: 0, inLink: false, inCode: false, top, num: [0, 0, 0, 0, 0, 0] };
  if (o.variant === 'C' || o.heads === 'L') {
    // C: each heading opens a section that runs to the next heading of the same or a higher
    // level, so a rail can mark how far it reaches.
    const stack: { level: number; box: Node }[] = [{ level: 0, box: frag }];
    for (const n of ast) {
      const m = Array.isArray(n) && /^h([1-6])$/.exec(n[0]);
      if (m) {
        const level = +m[1];
        while (stack.at(-1)!.level >= level) stack.pop();
        const sec = el('section', `md-sec md-sec${level}`);
        stack.at(-1)!.box.appendChild(sec);
        stack.push({ level, box: sec });
      }
      stack.at(-1)!.box.appendChild(node(n, ctx));
    }
  } else for (const n of ast) frag.appendChild(node(n, ctx));
  return frag;
}

/** Round 4: every pip variant renders the same six ticks; CSS shapes them. */
export const PIPS = new Set(['P', 'Q', 'S', 'D', 'G', 'M', 'E']);

type Ctx = { o: Opts; listDepth: number; inLink: boolean; inCode: boolean; top: number; num: number[] };

function kids(e: Node, n: any[], ctx: Ctx, from = 2) {
  for (let i = from; i < n.length; i++) {
    const c = n[i];
    const out = node(c, ctx);
    // A link the author already followed with ↗ doesn't get a second one from the style.
    if (Array.isArray(c) && c[0] === 'a' && typeof n[i + 1] === 'string' && /^\s?[↗↪➚]/.test(n[i + 1]) && out instanceof HTMLElement) out.dataset.arrow = 'authored';
    e.appendChild(out);
  }
}

function node(n: any, ctx: Ctx): Node {
  if (typeof n === 'string') return ctx.inLink || ctx.inCode ? document.createTextNode(n) : refs(n, ctx);
  const [tag, at] = n as [string, Record<string, string> | 0];
  const a = at || {};
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = tag[1];
      const h = el(tag, `md-h md-${tag}`);
      const rel = +level - ctx.top; // 0 = the document's top level
      h.dataset.rel = String(rel);
      h.append(el('span', 'md-hi', [level]));
      if (ctx.o.heads === 'N') {
        ctx.num[rel]++;
        for (let i = rel + 1; i < 6; i++) ctx.num[i] = 0;
        h.append(el('span', 'md-hn', [ctx.num.slice(0, rel + 1).map((x) => x || 1).join('.')]));
      }
      if (PIPS.has(ctx.o.heads ?? '')) {
        const pips = el('span', 'md-pips');
        for (let i = 1; i <= 6; i++) pips.append(el('i', i <= +level ? 'on' : ''));
        h.append(pips);
      }
      const t = el('span', 'md-ht');
      kids(t, n, ctx);
      h.append(t);
      return h;
    }
    case 'div': {
      const m = /markdown-alert-(\w+)/.exec(a.class ?? '');
      if (!m) break;
      const kind = m[1];
      const box = el('div', `md-alert md-alert-${kind}`);
      for (let i = 2; i < n.length; i++) {
        const c = n[i];
        if (Array.isArray(c) && c[0] === 'p' && c[1] && c[1].class === 'markdown-alert-title') {
          const t = el('p', 'md-alert-title', [icon(ALERT_ICON[kind] ?? 'info', ctx.o.icons)]);
          kids(t, c, ctx);
          box.append(t);
        } else box.append(node(c, ctx));
      }
      return box;
    }
    case 'pre': {
      const code = n[2];
      const lang = Array.isArray(code) && code[1] && code[1].class ? String(code[1].class).replace(/^language-/, '').toLowerCase() : '';
      const src = text(code);
      const wrap = el('div', `md-code ${lang ? '' : 'md-code-plain'}`);
      if (lang) {
        const head = el('div', 'md-code-head');
        const dot = el('span', 'md-lang-dot');
        dot.style.background = LANG_DOT[lang] ?? 'var(--md-muted)';
        head.append(icon('code', ctx.o.icons), dot, el('span', 'md-lang', [LANG_NAME[lang] ?? lang]));
        wrap.append(head);
      }
      const c = el('code');
      c.textContent = src.replace(/\n$/, '');
      wrap.append(el('pre', undefined, [c]));
      if (lang)
        withHljs((h) => {
          if (h.getLanguage(lang)) c.innerHTML = h.highlight(c.textContent!, { language: lang, ignoreIllegals: true }).value;
        });
      return wrap;
    }
    case 'code': {
      const c = el('code', 'md-ic');
      const was = ctx.inCode;
      ctx.inCode = true;
      kids(c, n, ctx);
      ctx.inCode = was;
      return c;
    }
    case 'ul': case 'ol': {
      const l = el(tag, `md-list md-d${ctx.listDepth % 4}`);
      if (a.start) l.setAttribute('start', a.start);
      ctx.listDepth++;
      kids(l, n, ctx);
      ctx.listDepth--;
      if (n.slice(2).some((li: any) => Array.isArray(li) && Array.isArray(li[2]) && li[2][0] === 'input')) l.classList.add('md-tasks');
      return l;
    }
    case 'li': {
      const li = el('li');
      if (a.id) li.id = a.id;
      const first = n[2];
      if (Array.isArray(first) && first[0] === 'input') {
        li.className = `md-task ${'checked' in (first[1] || {}) ? 'done' : ''}`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true; // read-only (#64)
        box.checked = 'checked' in (first[1] || {});
        li.append(box);
        const rest = el('span');
        kids(rest, n, ctx, 3);
        li.append(rest);
        return li;
      }
      kids(li, n, ctx);
      return li;
    }
    case 'a':
      return link(n, a, ctx);
    case 'img': {
      const img = document.createElement('img');
      img.className = 'md-img';
      img.loading = 'lazy';
      img.src = a.src ?? '';
      img.alt = a.alt ?? '';
      // Authored sizes win over the stylesheet's height: auto, as on GitHub (bots size their badges
      // this way), and align="left|right" floats like GitHub's.
      if (a.width) img.style.width = /%$/.test(a.width) ? a.width : `${parseInt(a.width)}px`;
      if (a.height) img.style.height = /%$/.test(a.height) ? a.height : `${parseInt(a.height)}px`;
      if (a.width && !a.height) img.style.height = 'auto';
      if (a.height && !a.width) img.style.width = 'auto';
      if (a.align === 'right' || a.align === 'left') img.classList.add(`md-float-${a.align}`);
      if (!ctx.inLink) img.addEventListener('click', () => lightbox(img.src, img.alt));
      img.addEventListener('error', () => img.replaceWith(el('a', 'md-img-fail', [icon('image', ctx.o.icons), img.alt || 'Image failed to load'])), { once: true });
      return img;
    }
    case 'table': {
      const wrap = el('div', 'md-table');
      const t = el('table');
      kids(t, n, ctx);
      wrap.append(t);
      return wrap;
    }
    case 'th': case 'td': {
      const c = el(tag);
      if (a.align) c.dataset.align = a.align;
      if (a.colspan) c.setAttribute('colspan', a.colspan);
      kids(c, n, ctx);
      return c;
    }
    case 'blockquote': {
      const q = el('blockquote', 'md-quote');
      kids(q, n, ctx);
      return q;
    }
    case 'details': {
      const d = el('details', 'md-details');
      if ('open' in a) d.setAttribute('open', '');
      kids(d, n, ctx);
      return d;
    }
    case 'section':
      if ((a.class ?? '').includes('footnotes')) {
        const s = el('section', 'md-fn');
        s.append(el('div', 'md-fn-title', ['Footnotes']));
        kids(s, n, ctx);
        return s;
      }
      break;
    case 'input':
      // A checkbox outside a task item: keep it read-only.
      {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = 'checked' in a;
        return box;
      }
  }
  const e = document.createElement(tag);
  for (const k in a) if (ATTR.has(k)) e.setAttribute(k, a[k]);
  kids(e, n, ctx);
  return e;
}

function link(n: any, a: Record<string, string>, ctx: Ctx): Node {
  const href = a.href ?? '';
  const label = text(n);
  // Footnote refs and backrefs stay plain anchors.
  if (href.startsWith('#')) {
    const e = el('a', a.class?.includes('backref') ? 'md-fn-back' : 'md-fn-ref');
    e.setAttribute('href', href);
    if (a.id) e.id = a.id;
    e.append(label);
    return e;
  }
  // A bare GitHub issue URL reads as a reference, as GitHub shows it.
  const gh = GH_ISSUE.exec(href);
  if (gh && (label === href || label.startsWith('https://github.com/'))) return ref(gh[1], +gh[2], ctx, true);
  const e = el('a', 'md-a') as HTMLAnchorElement;
  e.setAttribute('href', href);
  e.target = '_blank';
  e.rel = 'noopener noreferrer';
  const hasImg = n.slice(2).some((k: any) => Array.isArray(k) && k[0] === 'img');
  const kind = hasImg ? 'image' : /^https?:\/\/(www\.)?github\.com\//.test(href) ? 'github' : /^mailto:/.test(href) ? 'mail' : 'globe';
  e.dataset.kind = kind;
  if (!hasImg) e.append(icon(kind, ctx.o.icons, 'md-li'));
  const was = ctx.inLink;
  ctx.inLink = true;
  kids(e, n, ctx);
  ctx.inLink = was;
  return e;
}

/** #n, owner/repo#n and @user inside a text node. */
function refs(s: string, ctx: Ctx): Node {
  REF.lastIndex = 0;
  if (!REF.test(s)) return document.createTextNode(s);
  REF.lastIndex = 0;
  const f = document.createDocumentFragment();
  let last = 0;
  for (let m; (m = REF.exec(s)); ) {
    if (m.index > last) f.append(s.slice(last, m.index));
    if (m[3]) {
      const e = el('a', 'md-mention', ['@' + m[3]]) as HTMLAnchorElement;
      e.setAttribute('href', `https://github.com/${m[3].includes('/') ? 'orgs/' + m[3].replace('/', '/teams/') : m[3]}`);
      e.target = '_blank';
      f.append(e);
    } else f.append(ref(m[1] ?? ctx.o.repo, +m[2], ctx, !!m[1]));
    last = REF.lastIndex;
  }
  if (last < s.length) f.append(s.slice(last));
  return f;
}

function ref(repo: string, num: number, ctx: Ctx, showRepo: boolean): Node {
  const synced = (SYNCED.has(repo) || repo === ctx.o.repo) && num <= FIXTURE_MAX;
  const label = `${showRepo && repo !== ctx.o.repo ? repo : ''}#${num}`;
  if (!synced) {
    // Not in the viewer's mirror (another repo, or a number we don't have): straight to GitHub.
    const e = el('a', 'md-ref md-ref-out', [label]) as HTMLAnchorElement;
    e.setAttribute('href', `https://github.com/${repo}/issues/${num}`);
    e.target = '_blank';
    e.title = SYNCED.has(repo) || repo === ctx.o.repo ? 'Not in your mirror: opens on GitHub' : `${repo} isn't synced: opens on GitHub`;
    return e;
  }
  const st = refState(num);
  const e = el('a', `md-ref md-ref-${st}`, [icon(st === 'open' ? 'issue-open' : st === 'done' ? 'issue-done' : 'issue-np', ctx.o.icons, 'md-ri'), label]);
  e.setAttribute('href', `/issues/${FIXTURE_BASE + num}`);
  e.title = `${TITLES[num % TITLES.length]} · ${st === 'open' ? 'Open' : st === 'done' ? 'Closed' : 'Closed as not planned'}`;
  return e;
}

let box: HTMLElement | undefined;
function lightbox(src: string, alt: string) {
  box?.remove();
  box = el('div', 'md-lightbox');
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  box.append(img);
  if (alt) box.append(el('div', 'md-lightbox-cap', [alt]));
  const close = () => {
    box?.remove();
    box = undefined;
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  box.addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  document.body.append(box);
}
