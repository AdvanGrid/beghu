import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from 'solid-js';
import { createVirtualizer } from './virtual';
import { getFacets, getIssue, type IssueDetail, type IssueRow, type View } from './api';
import type { LazyPage } from './db';
import type { Source } from './sources';

const PAGE = 100;
const ROW_HEIGHT = 36;

export function App(props: { source: Source }) {
  const source = props.source;
  const facets = createMemo(getFacets);
  // The view is one immutable object, replaced on every change, so the list refetches whenever any
  // part changes. A store would pull Solid 2's store module into the bundle for four fields.
  const [view, setView] = createSignal<View>({ state: 'open', labels: [], assignees: [], q: '' });
  const viewKey = view;

  // The list is an async writable memo: a new view or a live change re-asks the source for the
  // rows already shown (at least a page), and loadMore appends pages by writing to it.
  let want = PAGE;
  const [liveTick, setLiveTick] = createSignal(0);
  const [page, setPage] = createSignal<LazyPage>(() => {
    liveTick();
    return source.query(viewKey(), 0, want);
  });
  // A total the worker counted after answering the page (see LazyPage).
  const [counted, setCounted] = createSignal<{ view: string; n: number }>();
  source.counted((view, n) => setCounted({ view, n }));
  const total = () => page().total ?? (counted()?.view === JSON.stringify(viewKey()) ? counted()!.n : null);
  let loadingMore = false;

  async function loadMore() {
    const have = page();
    const all = total();
    if (loadingMore || (all !== null && have.rows.length >= all)) return;
    loadingMore = true;
    const key = viewKey();
    const more = await Promise.resolve(source.query(key, have.rows.length, PAGE)).finally(() => (loadingMore = false));
    if (key !== viewKey() || !more.rows.length) return;
    setPage({ rows: [...have.rows, ...more.rows], total: have.total ?? more.total });
  }

  const resetPaging = () => {
    want = PAGE;
  };
  const toggle = (key: 'labels' | 'assignees', value: string) => {
    resetPaging();
    setView((v) => ({ ...v, [key]: v[key].includes(value) ? v[key].filter((x) => x !== value) : [...v[key], value] }));
  };

  const [openId, setOpenId] = createSignal<number>();
  const [detailTick, setDetailTick] = createSignal(0);
  // A writable async memo: the optimistic label is a plain write that lands at once, and a failed
  // write puts back what was shown before. Cheaper at 6× than an action over createOptimistic.
  const [detail, setDetail] = createSignal<IssueDetail | undefined>(() => {
    detailTick();
    const id = openId();
    return id === undefined ? undefined : getIssue(id);
  });

  onSettled(() =>
    source.live((ids, own) => {
      want = Math.max(PAGE, page().rows.length);
      setLiveTick((t) => t + 1);
      const open = openId();
      if (!own && open !== undefined && ids.includes(open)) setDetailTick((t) => t + 1);
    }),
  );

  async function addLabelTo(d: IssueDetail, name: string) {
    const label = d.repo_labels.find((l) => l.name === name)!;
    setDetail({ ...d, labels: [...d.labels, label] }); // optimistic
    try {
      await source.write(d.id, label);
    } catch {
      if (openId() === d.id) setDetail(d); // rolled back
    }
  }

  return (
    <div class="app">
      <header>
        <div class="group">
          <For each={['open', 'closed'] as const}>
            {(s) => (
              <button
                data-bench="filter-state"
                data-value={s}
                aria-pressed={view().state === s ? "true" : "false"}
                onClick={() => {
                  resetPaging();
                  setView((v) => ({ ...v, state: s }));
                }}
              >
                {s}
              </button>
            )}
          </For>
          <input
            data-bench="search"
            type="search"
            placeholder="Search titles"
            autocomplete="off"
            value={view().q}
            onInput={(e) => {
              resetPaging();
              const q = e.currentTarget.value;
              setView((v) => ({ ...v, q }));
            }}
          />
          <Loading>
            <span class="count">{total()?.toLocaleString() ?? '…'} issues</span>
          </Loading>
        </div>
        <Loading>
          <div class="group">
            <For each={facets().labels}>
              {(l) => (
                <button data-bench="filter-label" data-value={l} aria-pressed={view().labels.includes(l) ? "true" : "false"} onClick={() => toggle('labels', l)}>
                  {l}
                </button>
              )}
            </For>
          </div>
          <div class="group">
            <For each={facets().assignees}>
              {(a) => (
                <button data-bench="filter-assignee" data-value={a} aria-pressed={view().assignees.includes(a) ? "true" : "false"} onClick={() => toggle('assignees', a)}>
                  @{a}
                </button>
              )}
            </For>
          </div>
        </Loading>
      </header>
      <main>
        <Loading fallback={<div class="list" data-bench="list" />}>
          <IssueList rows={page().rows} onOpen={setOpenId} onNearEnd={loadMore} />
        </Loading>
        <aside>
          <Errored fallback={(err) => <p>Couldn't load the issue: {String(err())}</p>}>
            <Loading>
              <Show when={detail()}>
                {(d) => <Detail d={d()} onAddLabel={(name) => addLabelTo(d(), name)} />}
              </Show>
            </Loading>
          </Errored>
        </aside>
      </main>
    </div>
  );
}

function IssueList(props: { rows: IssueRow[]; onOpen: (id: number) => void; onNearEnd: () => void }) {
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
            list memo. A row that stays in the window keeps its DOM node and isn't touched. */}
        <div class="window" style={{ transform: `translateY(${visible().first * ROW_HEIGHT}px)` }}>
          <For each={visible().rows}>
            {(r) => (
              <div class="row" data-bench="row" data-id={r.id} onClick={() => props.onOpen(r.id)}>
                <span class="repo">
                  {r.repo}#{r.number}
                </span>
                <span class="title" data-bench="title">
                  {r.title}
                </span>
                <span class="meta">{r.labels.map((l) => l.name).join(' ')}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function Detail(props: { d: IssueDetail; onAddLabel: (name: string) => void }) {
  const missing = () => props.d.repo_labels.filter((l) => !props.d.labels.some((x) => x.name === l.name));
  return (
    <article data-bench="detail" data-id={props.d.id}>
      <h2>
        <span class="repo">
          {props.d.repo}#{props.d.number}
        </span>{' '}
        {props.d.title}
      </h2>
      <div class="chips">
        <For each={props.d.labels}>
          {(l) => (
            <span class="label" data-bench="label" data-value={l.name} style={{ '--c': `#${l.color}` }}>
              {l.name}
            </span>
          )}
        </For>
      </div>
      <div class="chips">
        Add:{' '}
        <For each={missing()}>
          {(l) => (
            <button data-bench="add-label" data-value={l.name} onClick={() => props.onAddLabel(l.name)}>
              {l.name}
            </button>
          )}
        </For>
      </div>
      <pre data-bench="body">{props.d.body}</pre>
      <For each={props.d.comments}>
        {(c) => (
          <div class="comment" data-bench="comment">
            <div class="meta">
              {c.author} · {c.created_at}
            </div>
            <pre>{c.body}</pre>
          </div>
        )}
      </For>
    </article>
  );
}
