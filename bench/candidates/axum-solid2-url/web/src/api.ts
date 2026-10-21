// Typed fetch helpers. The types come from the Rust structs via ts-rs (server/bindings).
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

export const getFacets = () => fetch('/api/facets').then(json<Facets>);

export function getIssues(view: View, offset: number, limit: number) {
  const p = new URLSearchParams({ state: view.state, offset: String(offset), limit: String(limit) });
  for (const l of view.labels) p.append('label', l);
  for (const a of view.assignees) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  return fetch(`/api/issues?${p}`).then(json<IssueRow[]>);
}

// A hover or tap preload and the click that follows share one fetch for up to 5 s. A live change
// passes fresh, so it never reads a preload.
const preloaded = new Map<number, { at: number; issue: Promise<IssueDetail> }>();
export function getIssue(id: number, fresh = false) {
  const hit = preloaded.get(id);
  if (!fresh && hit && performance.now() - hit.at < 5000) return hit.issue;
  const issue = fetch(`/api/issues/${id}`).then(json<IssueDetail>);
  preloaded.set(id, { at: performance.now(), issue });
  issue.catch(() => preloaded.delete(id));
  return issue;
}

export const addLabel = (id: number, name: string) =>
  fetch(`/api/issues/${id}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
  });
