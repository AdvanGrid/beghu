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
import { MULTI, type View } from './view';

export type { Facets, Count, IssuePage, IssueRow, IssueDetail, Label, Changed, TreeNode, TreePage };

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

export const getIssue = query((id: number) => fetch(`/api/issues/${id}`).then(json<IssueDetail>), 'issue');

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
