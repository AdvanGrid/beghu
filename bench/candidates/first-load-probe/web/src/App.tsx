import { createMemo, createSignal, Errored, For, Loading, onSettled, type Element } from 'solid-js';
import { revalidate, useLocation, useMatch, useSearchParams } from '@solidjs/router';
import { createVirtualizer } from './virtual';
import { getFacets, getIssue, getIssues, type Changed, type IssueRow, type View } from './api';

const PAGE = 100;
const ROW_HEIGHT = 36;

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export function App(props: { children?: Element }) {
  const facets = createMemo(() => getFacets());
  // The view is the query string: ?state=closed&label=a&label=b&assignee=x&q=dark. Every navigation
  // (opening an issue too) hands out a new query object, so the view only changes by value.
  const [search, setSearch] = useSearchParams();
  const view = createMemo<View>(
    () => ({
      state: search.state === 'closed' ? 'closed' : 'open',
      labels: list(search.label),
      assignees: list(search.assignee),
      q: typeof search.q === 'string' ? search.q : '',
    }),
    { equals: sameView },
  );
  const location = useLocation();
  const open = useMatch(() => '/issues/:id');

  // The list is an async writable memo over the query: a new view or a live change (revalidate)
  // re-asks the server for the rows already shown (at least a page), and loadMore appends pages by
  // writing to it.
  let want = PAGE;
  let exhausted = false;
  let shown: View | undefined;
  const [rows, setRows] = createSignal<IssueRow[]>(() => {
    const v = view();
    if (v !== shown) {
      shown = v;
      want = PAGE;
      exhausted = false;
    }
    return getIssues(v, 0, want);
  });
  let loadingMore = false;

  async function loadMore() {
    const have = rows();
    if (loadingMore || exhausted) return;
    loadingMore = true;
    const key = view();
    const more = await getIssues(key, have.length, PAGE).finally(() => (loadingMore = false));
    if (key !== view()) return;
    if (more.length < PAGE) exhausted = true;
    setRows([...have, ...more]);
  }

  const toggle = (key: 'label' | 'assignee', value: string) => {
    const cur = list(search[key]);
    setSearch({ [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] });
  };

  onSettled(() => {
    const events = new EventSource('/events');
    events.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as Changed;
      want = Math.max(PAGE, rows().length);
      revalidate(getIssues.key);
      const id = Number(open()?.params.id);
      if (ids.includes(id)) revalidate(getIssue.keyFor(id));
    };
    return () => events.close();
  });

  return (
    <div class="app">
      <header>
        <div class="group">
          <For each={['open', 'closed'] as const}>
            {(s) => (
              <button
                data-bench="filter-state"
                data-value={s}
                aria-pressed={view().state === s ? 'true' : 'false'}
                onClick={() => setSearch({ state: s === 'open' ? undefined : s })}
              >
                {s}
              </button>
            )}
          </For>
          {/* Not bound to view().q: the URL lags the input while a navigation settles, and writing
              it back would drop keys typed in between. */}
          <input
            ref={(el) => (el.value = view().q)}
            data-bench="search"
            type="search"
            placeholder="Search titles"
            autocomplete="off"
            onInput={(e) => setSearch({ q: e.currentTarget.value || undefined }, { replace: true })}
          />
        </div>
        <Loading>
          <div class="group">
            <For each={facets().labels}>
              {(l) => (
                <button data-bench="filter-label" data-value={l} aria-pressed={view().labels.includes(l) ? 'true' : 'false'} onClick={() => toggle('label', l)}>
                  {l}
                </button>
              )}
            </For>
          </div>
          <div class="group">
            <For each={facets().assignees}>
              {(a) => (
                <button data-bench="filter-assignee" data-value={a} aria-pressed={view().assignees.includes(a) ? 'true' : 'false'} onClick={() => toggle('assignee', a)}>
                  @{a}
                </button>
              )}
            </For>
          </div>
        </Loading>
      </header>
      <main>
        <Loading fallback={<div class="list" data-bench="list" />}>
          <IssueList rows={rows()} search={location.search} onNearEnd={loadMore} />
        </Loading>
        <aside>
          <Errored fallback={(err) => <p>Couldn't load the issue: {String(err())}</p>}>
            <Loading>{props.children}</Loading>
          </Errored>
        </aside>
      </main>
    </div>
  );
}

function IssueList(props: { rows: IssueRow[]; search: string; onNearEnd: () => void }) {
  let scroller!: HTMLDivElement;
  const virtualizer = createVirtualizer({
    count: () => props.rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const visible = createMemo(() => {
    const items = virtualizer.getVirtualItems();
    const first = items[0]?.index ?? 0;
    return { first, rows: props.rows.slice(first, first + items.length) };
  });

  return (
    <div
      ref={scroller}
      class="list"
      data-bench="list"
      data-bench-ready=""
      data-bench-empty={props.rows.length === 0 ? '' : undefined}
      onScroll={() => {
        const items = virtualizer.getVirtualItems();
        const last = items[items.length - 1];
        if (last && last.index > props.rows.length - 40) props.onNearEnd();
      }}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {/* One translated wrapper around rows in normal flow, keyed by the row objects from the
            list memo. A row that stays in the window keeps its DOM node and isn't touched. Rows are
            plain anchors; the router's delegated listener handles the click, keeping the filter. */}
        <div class="window" style={{ transform: `translateY(${visible().first * ROW_HEIGHT}px)` }}>
          <For each={visible().rows}>
            {(r) => (
              <a class="row" data-bench="row" data-id={r.id} href={`/issues/${r.id}${props.search}`} noscroll>
                <span class="repo">
                  {r.repo}#{r.number}
                </span>
                <span class="title" data-bench="title">
                  {r.title}
                </span>
                <span class="meta">{r.labels.map((l) => l.name).join(' ')}</span>
              </a>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
