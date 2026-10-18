// Typed fetch helpers. The types come from the Rust structs via ts-rs (server/bindings).
import type { Facets } from '../../server/bindings/Facets';
import type { IssueRow } from '../../server/bindings/IssueRow';
import type { IssueDetail } from '../../server/bindings/IssueDetail';
import type { Label } from '../../server/bindings/Label';
import type { Changed } from '../../server/bindings/Changed';
import type { Page } from '../../server/bindings/Page';
import type { Snapshot } from '../../server/bindings/Snapshot';
import type { CacheRow } from '../../server/bindings/CacheRow';
import type { Written } from '../../server/bindings/Written';

export type { Facets, IssueRow, IssueDetail, Label, Changed, Page, Snapshot, CacheRow, Written };

export type View = { state: 'open' | 'closed'; labels: string[]; assignees: string[]; q: string };

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const getFacets = () => fetch('/api/facets').then(json<Facets>);

export function issuesUrl(view: View, offset: number, limit: number) {
  const p = new URLSearchParams({ state: view.state, offset: String(offset), limit: String(limit) });
  for (const l of view.labels) p.append('label', l);
  for (const a of view.assignees) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  return `/api/issues?${p}`;
}

export const getIssues = (view: View, offset: number, limit: number) => fetch(issuesUrl(view, offset, limit)).then(json<Page>);

export const getIssue = (id: number) => fetch(`/api/issues/${id}`).then(json<IssueDetail>);

export const addLabel = (id: number, name: string) =>
  fetch(`/api/issues/${id}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(json<Written>);
