// PROTOTYPE (beghu #52). The view: what the list shows, kept in the query string. Every variant
// reads and writes the same View; they differ only in how it's shown and edited.
import type { SearchParams, SetSearchParams } from '@solidjs/router';

export type View = {
  state: 'open' | 'closed' | 'all';
  kind: 'issue' | 'pr' | 'all';
  label: string[];
  assignee: string[];
  repo: string[];
  milestone: string[];
  author: string[];
  no: string[];
  is: string[];
  q: string;
  sort: 'updated' | 'created' | 'oldest' | 'comments';
};

export const MULTI = ['label', 'assignee', 'repo', 'milestone', 'author', 'no', 'is'] as const;
export type Multi = (typeof MULTI)[number];

export const EMPTY: View = {
  state: 'open',
  kind: 'issue',
  label: [],
  assignee: [],
  repo: [],
  milestone: [],
  author: [],
  no: [],
  is: [],
  q: '',
  sort: 'updated',
};

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const one = <T extends string>(v: string | string[] | undefined, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;

export function fromSearch(s: Partial<SearchParams>): View {
  return {
    state: one(s.state, ['open', 'closed', 'all'], 'open'),
    kind: one(s.kind, ['issue', 'pr', 'all'], 'issue'),
    label: list(s.label),
    assignee: list(s.assignee),
    repo: list(s.repo),
    milestone: list(s.milestone),
    author: list(s.author),
    no: list(s.no),
    is: list(s.is),
    q: typeof s.q === 'string' ? s.q : '',
    sort: one(s.sort, ['updated', 'created', 'oldest', 'comments'], 'updated'),
  };
}

/** Every key, so setSearch clears the ones the view leaves out. */
export function toSearch(v: View): SetSearchParams {
  return {
    state: v.state === 'open' ? undefined : v.state,
    kind: v.kind === 'issue' ? undefined : v.kind,
    label: v.label,
    assignee: v.assignee,
    repo: v.repo,
    milestone: v.milestone,
    author: v.author,
    no: v.no,
    is: v.is,
    q: v.q || undefined,
    sort: v.sort === 'updated' ? undefined : v.sort,
  };
}

export const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export function toggle(v: View, key: Multi, value: string): View {
  const cur = v[key];
  return { ...v, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] };
}

export const filterCount = (v: View) => MULTI.reduce((n, k) => n + v[k].length, 0) + (v.q ? 1 : 0);

// --- typed syntax: is:open label:bug label:"needs design" assignee:me repo:web no:assignee ----

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);

/** The view as typed syntax. is:open is written even though it's the default, so the box never
 * looks empty and clearing it means "every state", as on GitHub. Issues only is implied. */
export function format(v: View): string {
  const parts: string[] = [];
  if (v.state !== 'all') parts.push(`is:${v.state}`);
  if (v.kind === 'pr') parts.push('is:pr');
  if (v.kind === 'all') parts.push('type:any');
  for (const k of MULTI) {
    for (const x of v[k]) parts.push(k === 'is' ? `is:${x}` : `${k}:${quote(x)}`);
  }
  if (v.sort !== 'updated') parts.push(`sort:${v.sort}`);
  if (v.q) parts.push(v.q);
  return parts.join(' ');
}

export type Token = { key: string; value: string; start: number; end: number };

/** Splits typed syntax into key:value tokens and free text. `complete` is false for a token the
 * caret is still inside, so a half-typed `label:bu` doesn't filter. */
export function tokenize(text: string): { tokens: Token[]; free: string[] } {
  const tokens: Token[] = [];
  const free: string[] = [];
  const re = /(\w+):("([^"]*)"?|\S*)|("([^"]*)"?|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) tokens.push({ key: m[1].toLowerCase(), value: m[3] ?? m[2], start: m.index, end: m.index + m[0].length });
    else free.push(m[5] ?? m[4]);
  }
  return { tokens, free };
}

/** Parses typed syntax into a view. A token touching the end of the text while the user is still
 * typing (`live`) is left out until a space or Enter completes it. */
export function parse(text: string, live = false): View {
  const v: View = { ...EMPTY, state: 'all', kind: 'all', label: [], assignee: [], repo: [], milestone: [], author: [], no: [], is: [] };
  const { tokens, free } = tokenize(text);
  let sawState = false;
  let sawKind = false;
  for (const t of tokens) {
    if (live && t.end === text.length && !text.endsWith('"') ) continue;
    if (!t.value) continue;
    if (t.key === 'is' && (t.value === 'open' || t.value === 'closed')) {
      v.state = t.value;
      sawState = true;
    } else if (t.key === 'is' && (t.value === 'issue' || t.value === 'pr')) {
      v.kind = t.value;
      sawKind = true;
    } else if (t.key === 'type' && (t.value === 'any' || t.value === 'all')) {
      v.kind = 'all';
      sawKind = true;
    } else if (t.key === 'sort' && ['updated', 'created', 'oldest', 'comments'].includes(t.value)) {
      v.sort = t.value as View['sort'];
    } else if ((MULTI as readonly string[]).includes(t.key)) {
      v[t.key as Multi] = [...v[t.key as Multi], t.value];
    } else if (t.key === 'has' || t.key === 'no') {
      v.no = [...v.no, t.value];
    }
  }
  if (!sawState) v.state = 'all';
  if (!sawKind) v.kind = 'issue';
  v.q = free.join(' ');
  return v;
}

// --- display helpers ---------------------------------------------------------------------

const NOW = Date.now();
export function ago(iso: string): string {
  const s = Math.max(0, (NOW - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

export function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
