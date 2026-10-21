import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from 'solid-js';
import { createVirtualizer } from './virtual';
import { addLabel, getFacets, getIssue, getIssues, type Changed, type IssueDetail, type IssueRow, type View } from './api';
import { clickedIssue, readUrl, searchOf, writeUrl } from './url';

const PAGE = 100;
const ROW_HEIGHT = 36;

export function App() {
  const facets = createMemo(getFacets);
  // The view is one immutable object, replaced on every change, so the list refetches whenever any
  // part changes. A store would pull Solid 2's store module into the bundle for four fields.
  const start = readUrl();
  const [view, setView] = createSignal<View>(start.view);
  const viewKey = view;

  // The list is an async writable memo: a new view or a live change re-asks the server for the
  // rows already shown (at least a page), and loadMore appends pages by writing to it.
  let want = PAGE;
  const [liveTick, setLiveTick] = createSignal(0);
  const [rows, setRows] = createSignal<IssueRow[]>(() => {
    liveTick();
    return getIssues(viewKey(), 0, want);
  });
  const [exhausted, setExhausted] = createSignal(false);
  let loadingMore = false;

  async function loadMore() {
    const have = rows();
    if (loadingMore || exhausted()) return;
    loadingMore = true;
    const key = viewKey();
    const more = await getIssues(key, have.length, PAGE).finally(() => (loadingMore = false));
    if (key !== viewKey()) return;
    if (more.length < PAGE) setExhausted(true);
    setRows([...have, ...more]);
  }

  const resetPaging = () => {
    want = PAGE;
    setExhausted(false);
  };
  const [openId, setOpenId] = createSignal<number | undefined>(start.id);
  // Every view change and every opened issue is a history entry; typing replaces the entry.
  const go = (v: View, id: number | undefined, replace = false) => {
    if (v !== view()) {
      resetPaging();
      setView(v);
    }
    setOpenId(id);
    writeUrl({ view: v, id }, replace);
  };
  const toggle = (key: 'labels' | 'assignees', value: string) => {
    const v = view();
    go({ ...v, [key]: v[key].includes(value) ? v[key].filter((x) => x !== value) : [...v[key], value] }, openId());
  };
  const [detailTick, setDetailTick] = createSignal(0);
  let seenTick = 0;
  // A writable async memo: the optimistic label is a plain write that lands at once, and a failed
  // write re-asks the server. Cheaper at 6× than an action over createOptimistic.
  const [detail, setDetail] = createSignal<IssueDetail | undefined>(() => {
    // A tick (live change, failed write) re-asks the server; opening an issue may use a preload.
    const tick = detailTick();
    const fresh = tick !== seenTick;
    seenTick = tick;
    const id = openId();
    return id === undefined ? undefined : getIssue(id, fresh);
  });

  onSettled(() => {
    const back = () => {
      const r = readUrl();
      if (searchOf(r.view) !== searchOf(view())) {
        resetPaging();
        setView(r.view);
      }
      setOpenId(r.id);
    };
    addEventListener('popstate', back);
    const events = new EventSource('/events');
    events.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as Changed;
      want = Math.max(PAGE, rows().length);
      setLiveTick((t) => t + 1);
      const open = openId();
      if (open !== undefined && ids.includes(open)) setDetailTick((t) => t + 1);
    };
    return () => {
      events.close();
      removeEventListener('popstate', back);
    };
  });

  async function addLabelTo(d: IssueDetail, name: string) {
    const label = d.repo_labels.find((l) => l.name === name)!;
    setDetail({ ...d, labels: [...d.labels, label] }); // optimistic
    try {
      await addLabel(d.id, name);
    } catch {
      if (openId() === d.id) setDetailTick((t) => t + 1);
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
                onClick={() => go({ ...view(), state: s }, openId())}
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
            onInput={(e) => go({ ...view(), q: e.currentTarget.value }, openId(), true)}
          />
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
          <IssueList rows={rows()} search={searchOf(view())} openId={openId()} onOpen={(id) => go(view(), id)} onNearEnd={loadMore} />
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

function IssueList(props: { rows: IssueRow[]; search: string; openId: number | undefined; onOpen: (id: number) => void; onNearEnd: () => void }) {
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

  let hover: ReturnType<typeof setTimeout> | undefined;
  const preload = (t: EventTarget | null) => {
    const id = (t as Element | null)?.closest<HTMLElement>('a[data-id]')?.dataset.id;
    if (id) void getIssue(Number(id));
  };

  return (
    <div
      ref={scroller}
      class="list"
      data-bench="list"
      data-bench-ready=""
      data-bench-empty={props.rows.length === 0 ? '' : undefined}
      // One listener for every row: a click navigates in place, and a pointer that moves onto a row
      // and rests 20 ms, or goes down on it, starts the detail fetch ahead of it. Only a move counts:
      // rows the wheel scrolls under a still pointer fire pointerover, and preloading those fetched
      // one issue per wheel step. No wheel listener: a non-passive one made every scroll wait on the
      // main thread (row 500 came about 700 ms later at 6×).
      onClick={(e) => {
        const id = clickedIssue(e);
        if (id === undefined) return;
        e.preventDefault();
        props.onOpen(id);
      }}
      onPointerDown={(e) => preload(e.target)}
      onPointerMove={(e) => {
        clearTimeout(hover);
        hover = setTimeout(() => preload(e.target), 20);
      }}
      onPointerLeave={() => clearTimeout(hover)}
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
              <a class="row" data-bench="row" data-id={r.id} href={`/issues/${r.id}${props.search}`} aria-current={props.openId === r.id ? 'page' : undefined}>
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
