import { query } from '@solidjs/router';

// Typed fetch helpers, wrapped in the router's `query` so a hover or tap preload and the route's
// own read share one fetch, and `revalidate(key)` re-runs every reader. The types come from the Rust structs via ts-rs (server/bindings).
import type { Facets } from '../../server/bindings/Facets';
import type { IssueRow } from '../../server/bindings/IssueRow';
import type { IssueDetail } from '../../server/bindings/IssueDetail';
import type { Label } from '../../server/bindings/Label';
import type { Changed } from '../../server/bindings/Changed';

export type { Facets, IssueRow, IssueDetail, Label, Changed };

export type View = { state: 'open' | 'closed'; labels: string[]; assignees: string[]; q: string };

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const getFacets = query(() => fetch('/api/facets').then(json<Facets>), 'facets');

export const getIssues = query((view: View, offset: number, limit: number) => {
  const p = new URLSearchParams({ state: view.state, offset: String(offset), limit: String(limit) });
  for (const l of view.labels) p.append('label', l);
  for (const a of view.assignees) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  return fetch(`/api/issues?${p}`).then(json<IssueRow[]>);
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
