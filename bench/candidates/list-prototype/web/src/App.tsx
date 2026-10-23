// PROTOTYPE for "Prototype the issue detail" (beghu #54), on top of the list prototype (#52).
// Throwaway. The list is #52's winner, variant C; ?variant= and the floating bar now switch the
// issue detail's layout (A side panel, B full page, C drawer). This shell owns the list's data
// (view, rows, facets, live updates, the pending pulse).
import { createMemo, createSignal, createEffect, onSettled, type Element } from 'solid-js';
import { revalidate, useLocation, useMatch, useSearchParams } from '@solidjs/router';
import { fetchFacets, getIssues, type Changed, type Facets, type IssueRow } from './api';
import { fromSearch, sameView, toSearch, type View } from './view';
import { VariantC } from './variants/C';
import { Switcher } from './Switcher';
import { Toasts } from './detail/toasts';
import { shell } from './shell';

const PAGE = 100;

export type Ctx = {
  view: () => View;
  /** A user-started change of view. Starts the 200 ms pending timer. */
  go: (v: View, opts?: { replace?: boolean }) => void;
  rows: () => IssueRow[];
  serverMs: () => number | undefined;
  facets: () => Facets | undefined;
  loadMore: () => void;
  /** The element that pulses while a user-started load runs past 200 ms. */
  pulseTarget: (el: HTMLElement) => void;
  /** The query string, for row hrefs that keep the view. */
  search: () => string;
  openId: () => number | undefined;
  /** The new-issue form is open. */
  creating: () => boolean;
  layout: () => 'A' | 'B' | 'C';
  detail: Element;
  /** List or tree (?tree=1). */
  tree: () => boolean;
  setTree: (on: boolean) => void;
  /** Ends the pending pulse; the tree calls it when its own load lands. */
  settle: () => void;
  /** Bumped on every live push, so the tree can refetch what it shows. */
  live: () => number;
};

export const VARIANTS = [
  { key: 'A', name: 'Side panel: list and detail side by side' },
  { key: 'B', name: 'Full page: the detail replaces the list' },
  { key: 'C', name: 'Drawer over the list, expands to a page' },
] as const;

/** The view in the address bar right now, for refilling a search box on back/forward (the router's
 * copy can lag a popstate). */
export function viewFromLocation(): View {
  const p = new URLSearchParams(location.search);
  const o: Record<string, string | string[]> = {};
  for (const k of new Set(p.keys())) {
    const all = p.getAll(k);
    o[k] = ['label', 'assignee', 'repo', 'milestone', 'author', 'no', 'is'].includes(k) ? all : all[0];
  }
  return fromSearch(o);
}

export function App(props: { children?: Element }) {
  const [search, setSearch] = useSearchParams();
  const view = createMemo<View>(() => fromSearch(search), { equals: sameView });
  const location = useLocation();
  const open = useMatch(() => '/issues/:id');
  const creating = useMatch(() => '/new');

  // Pending pulse: only for user-started loads, only past 200 ms, and the old rows stay. Driven
  // straight on the element so a held transition can't delay it.
  let pulseEl: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = 0;
  const settle = () => {
    clearTimeout(timer);
    waiting = 0;
    pulseEl?.classList.remove('pulse');
  };

  let want = PAGE;
  let exhausted = false;
  let shown: View | undefined;
  let lastMs: number | undefined;
  const [page, setPage] = createSignal<{ rows: IssueRow[]; ms?: number }>(() => {
    const v = view();
    if (v !== shown) {
      shown = v;
      want = PAGE;
      exhausted = false;
    }
    return getIssues(v, 0, want).then((p) => {
      if (p.rows.length < want) exhausted = true;
      lastMs = p.ms;
      if (v === shown && search.tree !== '1') settle();
      return { rows: p.rows, ms: p.ms };
    });
  });
  const rows = () => page().rows;

  let loadingMore = false;
  async function loadMore() {
    const have = page().rows;
    if (loadingMore || exhausted) return;
    loadingMore = true;
    const key = view();
    const more = await getIssues(key, have.length, PAGE).finally(() => (loadingMore = false));
    if (key !== view()) return;
    if (more.rows.length < PAGE) exhausted = true;
    setPage({ rows: [...have, ...more.rows], ms: more.ms });
  }

  // Facets load beside the list and never hold it up; a stale response is dropped.
  const [facets, setFacets] = createSignal<Facets | undefined>(undefined);
  let facetSeq = 0;
  const loadFacets = (v: View) => {
    const n = ++facetSeq;
    fetchFacets(v).then((f) => n === facetSeq && setFacets(f));
  };
  createEffect(view, (v) => loadFacets(v));

  const go: Ctx['go'] = (v, opts) => {
    if (sameView(v, view())) return;
    waiting++;
    clearTimeout(timer);
    timer = setTimeout(() => waiting && pulseEl?.classList.add('pulse'), 200);
    setSearch(toSearch(v), { replace: opts?.replace });
  };

  const variant = () => VARIANTS.find((v) => v.key === search.variant) ?? VARIANTS[0];

  const [live, setLive] = createSignal(0);
  onSettled(() => {
    const events = new EventSource('/events');
    events.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as Changed;
      want = Math.max(PAGE, page().rows.length);
      revalidate(getIssues.key);
      loadFacets(view());
      setLive(live() + 1);
      window.dispatchEvent(new CustomEvent('issues-changed', { detail: ids }));
    };
    return () => events.close();
  });

  const ctx: Ctx = {
    view,
    go,
    rows,
    serverMs: () => (page(), lastMs),
    facets,
    loadMore,
    pulseTarget: (el) => (pulseEl = el),
    search: () => location.search,
    openId: () => (open() ? Number(open()!.params.id) : undefined),
    creating: () => !!creating(),
    layout: () => variant().key,
    tree: () => search.tree === '1',
    setTree: (on) => setSearch({ tree: on ? '1' : undefined }),
    settle,
    live,
    get detail() {
      return props.children;
    },
  };

  shell.rows = rows;

  return (
    <>
      <VariantC ctx={ctx} />
      <Toasts />
      <Switcher />
    </>
  );
}
