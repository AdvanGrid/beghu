import { query } from '@solidjs/router';
import type { Facets } from '../../server/bindings/Facets';
import type { Count } from '../../server/bindings/Count';
import type { IssuePage } from '../../server/bindings/IssuePage';
import type { IssueRow } from '../../server/bindings/IssueRow';
import type { IssueDetail } from '../../server/bindings/IssueDetail';
import type { Label } from '../../server/bindings/Label';
import type { Changed } from '../../server/bindings/Changed';
import type { TreeNode } from '../../server/bindings/TreeNode';
import type { TreePage } from '../../server/bindings/TreePage';
import type { RelItem } from '../../server/bindings/RelItem';
import type { Rels } from '../../server/bindings/Rels';
import type { RepoMeta } from '../../server/bindings/RepoMeta';
import type { Op } from '../../server/bindings/Op';
import type { Comment } from '../../server/bindings/Comment';
import type { CreateReq } from '../../server/bindings/CreateReq';
import type { Created } from '../../server/bindings/Created';
import { MULTI, type View } from './view';

export type { Facets, Count, IssuePage, IssueRow, IssueDetail, Label, Changed, TreeNode, TreePage, RelItem, Rels, RepoMeta, Op, Comment, CreateReq, Created };

// PROTOTYPE knob: extra latency on list and facet reads, set from the switcher bar, so the pending
// pulse can be felt without a shaped link.
export let lag = Number(sessionStorage.getItem('proto-lag') ?? 0);
export const setLag = (ms: number) => {
  lag = ms;
  sessionStorage.setItem('proto-lag', String(ms));
};
const delay = () => (lag ? new Promise((r) => setTimeout(r, lag)) : Promise.resolve());

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export function viewParams(view: View): URLSearchParams {
  const p = new URLSearchParams({ state: view.state, kind: view.kind, sort: view.sort });
  for (const k of MULTI) for (const v of view[k]) p.append(k, v);
  if (view.q) p.set('q', view.q);
  return p;
}

/** Not a router query: facets load beside the list and never hold it up. */
export const fetchFacets = (view: View) => delay().then(() => fetch(`/api/facets?${viewParams(view)}`)).then(json<Facets>);

export const getIssues = query((view: View, offset: number, limit: number) => {
  const p = viewParams(view);
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  return delay()
    .then(() => fetch(`/api/issues?${p}`))
    .then(json<IssuePage>);
}, 'issues');

/** The detail with its response size: `bytes` as JSON, `wire` as transferred (compressed). */
export type Detail = IssueDetail & { bytes: number; wire: number };

export async function fetchIssue(id: number): Promise<Detail> {
  const url = `/api/issues/${id}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const text = await r.text();
  const entry = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
  return { ...JSON.parse(text), bytes: text.length, wire: entry?.encodedBodySize ?? 0 };
}

export const getIssue = query((id: number) => fetchIssue(id), 'issue');

export const fetchComments = (id: number, offset: number, limit: number) =>
  fetch(`/api/issues/${id}/comments?offset=${offset}&limit=${limit}`).then(json<Comment[]>);

export const getRepos = query(() => fetch('/api/repos').then(json<RepoMeta[]>), 'repos');

export const lookup = (q: string) => fetch(`/api/lookup?q=${encodeURIComponent(q)}`).then(json<RelItem[]>);

// PROTOTYPE knob: how GitHub answers writes, set from the switcher bar.
export type Fail = '' | '422' | '409' | 'down';
export let fail: Fail = (sessionStorage.getItem('proto-fail') as Fail) ?? '';
export const setFail = (f: Fail) => {
  fail = f;
  sessionStorage.setItem('proto-fail', f);
};

export class WriteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function write<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(fail ? { 'x-proto-fail': fail } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new WriteError(r.status, await r.text());
  return (r.headers.get('content-type')?.includes('json') ? r.json() : undefined) as T;
}

export const sendOp = (id: number, op_id: string, op: Op) => write<void>(`/api/issues/${id}/ops`, { op_id, op });
export const createIssue = (req: CreateReq) => write<Created>('/api/issues', req);

export const addLabel = (id: number, name: string) =>
  fetch(`/api/issues/${id}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
  });

/** Tree reads: the roots of a view (paged) or one node's children; `deep` adds every visible
 * descendant: `path` only what leads to a match, `all` everything. Plain fetches: the tree keeps its own state. */
export function fetchTree(view: View, o: { parent?: number; deep?: 'path' | 'all'; offset?: number; limit?: number }) {
  const p = viewParams(view);
  if (o.parent !== undefined) p.set('parent', String(o.parent));
  if (o.deep) p.set('deep_mode', o.deep);
  p.set('offset', String(o.offset ?? 0));
  p.set('limit', String(o.limit ?? 100));
  return delay()
    .then(() => fetch(`/api/tree?${p}`))
    .then(json<TreePage>);
}
