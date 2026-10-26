// PROTOTYPE for "Prototype solid-yield for typed pending, failures and contexts" (#45): the
// axum-solid2 app written as solid-yield components. Throwaway: it exists to be read and measured.
import {
  $cleanup,
  $effect,
  $event,
  $memo,
  $optimistic,
  $signal,
  attempt,
  component,
  Errored,
  Failure,
  For,
  latestOf,
  Loading,
  refresh,
  Show,
  view,
  type EventHandler,
  type Handler,
  type Props,
  type Source,
} from 'solid-yield';
import { createVirtualizer } from '../../src/virtual';
import { addLabel, getFacets, getIssue, getIssues, type Changed, type IssueDetail, type IssueRow, type View } from '../../src/api';

const PAGE = 100;
const ROW_HEIGHT = 36;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
export class ListFailed extends Failure('list') {}
export class DetailFailed extends Failure('detail') {}

type Page = { view: View; rows: IssueRow[] };

export const App = component(function* App() {
  const facets = yield* $memo(function* () {
    return yield* attempt(getFacets, (c) => new ListFailed(message(c)));
  });
  // The view is one immutable object, replaced on every change, so the list refetches whenever any
  // part changes.
  const [view_, setView] = yield* $signal<View>({ state: 'open', labels: [], assignees: [], q: '' });

  // The list: the first fetch re-asks the server for the rows already shown (at least a page) on a
  // new view or a live change; loadMore appends pages to `extra`, which belongs to one fetch.
  // A memo has no setter in solid-yield, so Solid 2's writable async memo becomes base + extra.
  let want = PAGE;
  let loadingMore = false;
  const [liveTick, setLiveTick] = yield* $signal(0);
  const base = yield* $memo(function* () {
    yield* liveTick;
    const v = yield* view_;
    const n = want;
    const rows = yield* attempt(
      () => getIssues(v, 0, n),
      (c) => new ListFailed(message(c)),
    );
    return { view: v, rows } as Page;
  });
  const [extra, setExtra] = yield* $signal<{ of: Page | null; rows: IssueRow[] }>({ of: null, rows: [] });
  const rows = yield* $memo(function* () {
    const b = yield* base;
    const e = yield* extra;
    return e.of === b ? [...b.rows, ...e.rows] : b.rows;
  });
  const [exhausted, setExhausted] = yield* $signal(false);

  const loadMore = $event(function* () {
    if (loadingMore || (yield* exhausted)) return;
    const b = yield* base;
    const e = yield* extra;
    const have = e.of === b ? e.rows : [];
    loadingMore = true;
    // Absorbed: a failed page is retried on the next scroll, as before.
    const more = yield* attempt(
      () => getIssues(b.view, b.rows.length + have.length, PAGE),
      () => null,
    );
    loadingMore = false;
    if (more === null || b !== (yield* base)) return;
    if (more.length < PAGE) yield* setExhausted(true);
    yield* setExtra({ of: b, rows: [...have, ...more] });
  });

  const resetPaging = $event(function* () {
    want = PAGE;
    yield* setExhausted(false);
  });
  const toggle = $event(function* (key: 'labels' | 'assignees', value: string) {
    yield* resetPaging();
    yield* setView((v) => ({ ...v, [key]: v[key].includes(value) ? v[key].filter((x) => x !== value) : [...v[key], value] }));
  });
  const pickState = $event(function* (state: View['state']) {
    yield* resetPaging();
    yield* setView((v) => ({ ...v, state }));
  });
  const search = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    const q = e.currentTarget.value;
    yield* resetPaging();
    yield* setView((v) => ({ ...v, q }));
  });

  const [openId, setOpenId] = yield* $signal<number | undefined>(undefined);
  const open = $event(function* (id: number) {
    yield* setOpenId(id);
  });
  const [detailTick, setDetailTick] = yield* $signal(0);
  const detail = yield* $memo(function* () {
    yield* detailTick;
    const id = yield* openId;
    if (id === undefined) return undefined;
    return yield* attempt(
      () => getIssue(id),
      (c) => new DetailFailed(message(c)),
    );
  });
  // Labels added while their write is in flight. An $optimistic shows at once and reverts when the
  // event settles; the event refreshes `detail` first, so the server's labels replace it.
  const [adding, setAdding] = yield* $optimistic<string[]>([]);
  const addLabelTo = $event(function* (id: number, name: string) {
    if (!name) throw new Error('no label');
    yield* setAdding((a) => [...a, name]);
    // Absorbed: the optimistic chip reverts by itself when the event settles.
    const ok = yield* attempt(
      () => addLabel(id, name).then(() => true),
      () => false,
    );
    if (ok) yield* refresh(detail);
  });

  // A live change re-asks for the rows on screen and the open issue if it changed.
  const shownRows = latestOf(rows);
  const changed = $event(function* (ids: number[]) {
    want = Math.max(PAGE, (yield* shownRows).length);
    yield* setLiveTick((t) => t + 1);
    const id = yield* openId;
    if (id !== undefined && ids.includes(id)) yield* setDetailTick((t) => t + 1);
  });
  yield* $effect(
    function* () {},
    function* () {
      const events = new EventSource('/events');
      events.onmessage = (e) => void changed((JSON.parse(e.data) as Changed).ids);
      yield* $cleanup(() => events.close());
    },
  );

  return view(function* () {
    return (
      <div class="app">
        <header>
          <div class="group">
            {yield* For({
              each: ['open', 'closed'] as View['state'][],
              children: function* (s) {
                const pick = $event(function* () {
                  yield* pickState(yield* s);
                });
                return view(function* () {
                  return (
                    <button
                      data-bench="filter-state"
                      data-value={yield* s}
                      aria-pressed={(yield* view_).state === (yield* s) ? 'true' : 'false'}
                      onClick={yield* pick}
                    >
                      {yield* s}
                    </button>
                  );
                });
              },
            })}
            <input
              data-bench="search"
              type="search"
              placeholder="Search titles"
              autocomplete="off"
              value={(yield* view_).q}
              onInput={yield* search}
            />
          </div>
          {yield* Loading({
            children: function* () {
              return (
                <>
                  {yield* Chips({
                    items: function* () {
                      return (yield* facets).labels;
                    },
                    kind: 'label',
                    pressed: function* () {
                      return (yield* view_).labels;
                    },
                    onToggle: toggle,
                  })}
                  {yield* Chips({
                    items: function* () {
                      return (yield* facets).assignees;
                    },
                    kind: 'assignee',
                    pressed: function* () {
                      return (yield* view_).assignees;
                    },
                    onToggle: toggle,
                  })}
                </>
              );
            },
          })}
        </header>
        <main>
          {yield* Loading({
            fallback: function* () {
              return <div class="list" data-bench="list" />;
            },
            children: function* () {
              return <>{yield* IssueList({ rows, onOpen: open, onNearEnd: loadMore })}</>;
            },
          })}
          <aside>
            {yield* Errored({
              catch: [DetailFailed],
              fallback: (err) => <p>Couldn't load the issue: {err().message}</p>,
              children: function* () {
                return (
                  <>
                    {yield* Loading({
                      children: function* () {
                        return (
                          <>
                            {yield* Show({
                              when: detail,
                              children: function* (d) {
                                return view(function* () {
                                  return <>{yield* Detail({ d, adding, onAddLabel: addLabelTo })}</>;
                                });
                              },
                            })}
                          </>
                        );
                      },
                    })}
                  </>
                );
              },
            })}
          </aside>
        </main>
      </div>
    );
  });
});

export const Chips = component(function* Chips(
  props: Props<{
    items: Source<string[], ListFailed, true>;
    kind: 'label' | 'assignee';
    pressed: Source<string[]>;
    onToggle: Handler<['labels' | 'assignees', string]>;
  }>,
) {
  return view(function* () {
    return (
      <div class="group">
        {yield* For({
          each: props.items,
          children: function* (item) {
            const press = $event(function* () {
              const kind = yield* props.kind;
              yield* (yield* props.onToggle)(kind === 'label' ? 'labels' : 'assignees', yield* item);
            });
            return view(function* () {
              return (
                <button
                  data-bench={`filter-${yield* props.kind}`}
                  data-value={yield* item}
                  aria-pressed={(yield* props.pressed).includes(yield* item) ? 'true' : 'false'}
                  onClick={yield* press}
                >
                  {(yield* props.kind) === 'assignee' ? '@' : ''}
                  {yield* item}
                </button>
              );
            });
          },
        })}
      </div>
    );
  });
});

export const IssueList = component(function* IssueList(
  props: Props<{
    rows: Source<IssueRow[], ListFailed, true>;
    onOpen: Handler<[number]>;
    onNearEnd: EventHandler<[], ListFailed, unknown, true>;
  }>,
) {
  let scroller!: HTMLDivElement;
  const virtualizer = yield* createVirtualizer({
    count: function* () {
      return (yield* props.rows).length;
    },
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const visible = yield* $memo(function* () {
    const items = yield* virtualizer.items;
    const all = yield* props.rows;
    const first = items[0]?.index ?? 0;
    return { first, rows: all.slice(first, first + items.length) };
  });
  const scrolled = $event(function* () {
    const items = yield* virtualizer.items;
    const last = items[items.length - 1];
    if (last && last.index > (yield* props.rows).length - 40) yield* (yield* props.onNearEnd)();
  });

  return view(function* () {
    return (
      <div
        ref={(el: HTMLDivElement) => (scroller = el)}
        class="list"
        data-bench="list"
        data-bench-ready=""
        data-bench-empty={(yield* props.rows).length === 0 ? '' : undefined}
        // eslint-disable-next-line solid-yield/no-unshown-wait -- scrolling waits on nothing the user sees
        onScroll={yield* scrolled}
      >
        <div style={{ height: `${yield* virtualizer.totalSize}px`, position: 'relative' }}>
          {/* One translated wrapper around rows in normal flow, keyed by the row objects from the
              list memo. A row that stays in the window keeps its DOM node and isn't touched. */}
          <div class="window" style={{ transform: `translateY(${(yield* visible).first * ROW_HEIGHT}px)` }}>
            {yield* For({
              each: function* () {
                return (yield* visible).rows;
              },
              children: function* (r) {
                const click = $event(function* () {
                  yield* (yield* props.onOpen)(yield* r.id);
                });
                return view(function* () {
                  return (
                    <div class="row" data-bench="row" data-id={yield* r.id} onClick={yield* click}>
                      <span class="repo">
                        {yield* r.repo}#{yield* r.number}
                      </span>
                      <span class="title" data-bench="title">
                        {yield* r.title}
                      </span>
                      <span class="meta">{(yield* r.labels).map((l) => l.name).join(' ')}</span>
                    </div>
                  );
                });
              },
            })}
          </div>
        </div>
      </div>
    );
  });
});

export const Detail = component(function* Detail(
  props: Props<{ d: IssueDetail; adding: Source<string[]>; onAddLabel: Handler<[number, string]> }>,
) {
  const labels = yield* $memo(function* () {
    const d = yield* props.d;
    const adding = yield* props.adding;
    return [...d.labels, ...d.repo_labels.filter((l) => adding.includes(l.name) && !d.labels.some((x) => x.name === l.name))];
  });
  const missing = yield* $memo(function* () {
    const d = yield* props.d;
    const shown = yield* labels;
    return d.repo_labels.filter((l) => !shown.some((x) => x.name === l.name));
  });
  return view(function* () {
    return (
      <article data-bench="detail" data-id={yield* props.d.id}>
        <h2>
          <span class="repo">
            {yield* props.d.repo}#{yield* props.d.number}
          </span>{' '}
          {yield* props.d.title}
        </h2>
        <div class="chips">
          {yield* For({
            each: labels,
            children: function* (l) {
              return view(function* () {
                return (
                  <span class="label" data-bench="label" data-value={yield* l.name} style={{ '--c': `#${yield* l.color}` }}>
                    {yield* l.name}
                  </span>
                );
              });
            },
          })}
        </div>
        <div class="chips">
          Add:{' '}
          {yield* For({
            each: missing,
            children: function* (l) {
              const add = $event(function* () {
                yield* (yield* props.onAddLabel)(yield* props.d.id, yield* l.name);
              });
              return view(function* () {
                return (
                  <button data-bench="add-label" data-value={yield* l.name} onClick={yield* add}>
                    {yield* l.name}
                  </button>
                );
              });
            },
          })}
        </div>
        <pre data-bench="body">{yield* props.d.body}</pre>
        {yield* For({
          each: props.d.comments,
          children: function* (c) {
            return view(function* () {
              return (
                <div class="comment" data-bench="comment">
                  <div class="meta">
                    {yield* c.author} · {yield* c.created_at}
                  </div>
                  <pre>{yield* c.body}</pre>
                </div>
              );
            });
          },
        })}
      </article>
    );
  });
});
