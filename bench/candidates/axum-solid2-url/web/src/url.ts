// The URL without a router: the view is the query string (?state=closed&label=a&label=b&assignee=x
// &q=dark), the open issue is the path (/issues/:id). Rows are plain anchors; one delegated click
// listener turns an unmodified left click into a pushState, and anything else (middle click, ctrl,
// open in new tab) stays a normal link.
import type { View } from './api';

export type Route = { view: View; id: number | undefined };

export function readUrl(): Route {
  const p = new URLSearchParams(location.search);
  const m = /^\/issues\/(\d+)$/.exec(location.pathname);
  return {
    view: { state: p.get('state') === 'closed' ? 'closed' : 'open', labels: p.getAll('label'), assignees: p.getAll('assignee'), q: p.get('q') ?? '' },
    id: m ? Number(m[1]) : undefined,
  };
}

export function searchOf(view: View) {
  const p = new URLSearchParams();
  if (view.state !== 'open') p.set('state', view.state);
  for (const l of view.labels) p.append('label', l);
  for (const a of view.assignees) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const hrefOf = (r: Route) => `${r.id === undefined ? '/' : `/issues/${r.id}`}${searchOf(r.view)}`;

export function writeUrl(r: Route, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', hrefOf(r));
}

/** The issue id an unmodified primary click on a row anchor navigates to, else undefined. */
export function clickedIssue(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-id]');
  return a ? Number(a.dataset.id) : undefined;
}
