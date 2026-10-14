import { createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { addLabel, getFacets, getIssue, getIssues, type Changed, type IssueDetail, type IssueRow, type View } from './api';

const PAGE = 100;
const ROW_HEIGHT = 36;

export function App() {
  const [facets] = createResource(getFacets);
  const [view, setView] = createStore<View>({ state: 'open', labels: [], assignees: [], q: '' });
  // A plain-object snapshot of the view, so the resource refetches whenever any part changes.
  const viewKey = createMemo(() => ({ state: view.state, labels: [...view.labels], assignees: [...view.assignees], q: view.q }));

  const [rows, { mutate: setRows, refetch: refetchRows }] = createResource<IssueRow[], View, number>(viewKey, (v, { refetching }) =>
    getIssues(v, 0, typeof refetching === 'number' ? Math.max(PAGE, refetching) : PAGE),
  );
  const [exhausted, setExhausted] = createSignal(false);
  let loadingMore = false;

  async function loadMore() {
    const have = rows();
    if (loadingMore || exhausted() || !have || rows.loading) return;
    loadingMore = true;
    const key = viewKey();
    const more = await getIssues(key, have.length, PAGE).finally(() => (loadingMore = false));
    if (key !== viewKey()) return;
    if (more.length < PAGE) setExhausted(true);
    setRows([...have, ...more]);
  }

  const toggle = (key: 'labels' | 'assignees', value: string) => {
    setExhausted(false);
    setView(key, (cur) => (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]));
  };

  const [openId, setOpenId] = createSignal<number>();
  const [detail, { mutate: setDetail, refetch: refetchDetail }] = createResource(openId, getIssue);

  const events = new EventSource('/events');
  events.onmessage = (e) => {
    const { ids } = JSON.parse(e.data) as Changed;
    refetchRows(rows()?.length ?? PAGE);
    const open = openId();
    if (open !== undefined && ids.includes(open)) refetchDetail();
  };
  onCleanup(() => events.close());

  async function onAddLabel(d: IssueDetail, name: string) {
    const label = d.repo_labels.find((l) => l.name === name)!;
    setDetail({ ...d, labels: [...d.labels, label] }); // optimistic
    try {
      await addLabel(d.id, name);
    } catch {
      if (openId() === d.id) refetchDetail();
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
                aria-pressed={view.state === s}
                onClick={() => {
                  setExhausted(false);
                  setView('state', s);
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
            value={view.q}
            onInput={(e) => {
              setExhausted(false);
              setView('q', e.currentTarget.value);
            }}
          />
        </div>
        <div class="group">
          <For each={facets()?.labels}>
            {(l) => (
              <button data-bench="filter-label" data-value={l} aria-pressed={view.labels.includes(l)} onClick={() => toggle('labels', l)}>
                {l}
              </button>
            )}
          </For>
        </div>
        <div class="group">
          <For each={facets()?.assignees}>
            {(a) => (
              <button data-bench="filter-assignee" data-value={a} aria-pressed={view.assignees.includes(a)} onClick={() => toggle('assignees', a)}>
                @{a}
              </button>
            )}
          </For>
        </div>
      </header>
      <main>
        <IssueList rows={rows() ?? []} ready={rows.state === 'ready' || rows.state === 'refreshing'} onOpen={setOpenId} onNearEnd={loadMore} />
        <aside>
          <Show when={detail()}>
            {(d) => <Detail d={d()} onAddLabel={(name) => onAddLabel(d(), name)} />}
          </Show>
        </aside>
      </main>
    </div>
  );
}

function IssueList(props: { rows: { id: number; number: number; repo: string; title: string; labels: { name: string }[] }[]; ready: boolean; onOpen: (id: number) => void; onNearEnd: () => void }) {
  let scroller!: HTMLDivElement;
  const virtualizer = createVirtualizer({
    get count() {
      return props.rows.length;
    },
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div
      ref={scroller}
      class="list"
      data-bench="list"
      data-bench-ready={props.ready ? '' : undefined}
      data-bench-empty={props.ready && props.rows.length === 0 ? '' : undefined}
      onScroll={() => {
        const items = virtualizer.getVirtualItems();
        const last = items[items.length - 1];
        if (last && last.index > props.rows.length - 40) props.onNearEnd();
      }}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        <For each={virtualizer.getVirtualItems()}>
          {(item) => {
            const row = () => props.rows[item.index];
            return (
              <Show when={row()}>
                {(r) => (
                  <div
                    class="row"
                    data-bench="row"
                    data-id={r().id}
                    style={{ transform: `translateY(${item.start}px)`, height: `${ROW_HEIGHT}px` }}
                    onClick={() => props.onOpen(r().id)}
                  >
                    <span class="repo">
                      {r().repo}#{r().number}
                    </span>
                    <span class="title" data-bench="title">
                      {r().title}
                    </span>
                    <span class="meta">{r().labels.map((l) => l.name).join(' ')}</span>
                  </div>
                )}
              </Show>
            );
          }}
        </For>
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
