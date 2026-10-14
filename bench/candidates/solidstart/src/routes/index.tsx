import { Title } from "@solidjs/meta";
import { A, createAsync, revalidate, usePreloadRoute, useSearchParams, useSubmissions, type RouteDefinition } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createComputed, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, Suspense } from "solid-js";
import { addLabel, facets, issue, issues, PAGE, type Filter, type Row } from "~/lib/api";

type Params = { state?: string; labels?: string; assignees?: string; q?: string; open?: string };

const split = (v: string | undefined) => (v ? v.split(",") : []);
const toFilter = (p: Params): Filter => ({
  state: p.state === "closed" ? "closed" : "open",
  labels: split(p.labels),
  assignees: split(p.assignees),
  q: p.q ?? "",
});

export const route = {
  preload: ({ location }) => {
    facets();
    const query = location.query as Params;
    issues(toFilter(query), 0);
    if (query.open) issue(query.open);
  },
} satisfies RouteDefinition;

export default function Home() {
  const [params, setParams] = useSearchParams<Params>();
  const filter = createMemo(() => toFilter(params), undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const facetList = createAsync(() => facets());
  // The first page is server-rendered and follows the filter through the router. Later pages load
  // as the window nears the end, and the virtualizer renders only the rows on screen.
  const first = createAsync(() => issues(filter(), 0));
  const [more, setMore] = createSignal<Row[][]>([]);
  createComputed(on(filter, () => setMore([]), { defer: true }));
  const rows = createMemo(() => (first() ?? []).concat(...more()));

  let loading = false;
  async function loadMore() {
    const last = more().at(-1) ?? first();
    if (loading || !last || last.length < PAGE) return;
    loading = true;
    const f = filter();
    const n = more().length + 1;
    try {
      const page = await issues(f, n);
      if (f === filter() && more().length === n - 1) setMore([...more(), page]);
    } finally {
      loading = false;
    }
  }
  async function refreshMore() {
    const f = filter();
    const pages = await Promise.all(more().map((_, i) => issues(f, i + 1)));
    if (f === filter()) setMore(pages);
  }

  let scrollEl: HTMLDivElement | undefined;
  const virt = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => 36,
    overscan: 10,
    initialRect: { width: 640, height: 704 },
  });
  createEffect(() => {
    const last = virt.getVirtualItems().at(-1);
    if (last && last.index >= rows().length - 10) loadMore();
  });

  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => {
    setHydrated(true);
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as { ids: string[] };
      revalidate(issues.key).then(refreshMore);
      if (params.open && ids.includes(params.open)) revalidate(issue.keyFor(params.open));
    };
    onCleanup(() => es.close());
  });

  // Opening an issue is a navigation. Preloading its route on hover starts the detail fetch before
  // the click, the way <A> links preload.
  const preloadRoute = usePreloadRoute();
  const preloadIssue = (id: string) => {
    const q = new URLSearchParams(location.search);
    q.set("open", id);
    preloadRoute(`/?${q}`, { preloadData: true });
  };

  // Filters are links to the filtered URL, so the router preloads the list on hover and focus.
  const hrefWith = (patch: Partial<Params>) => {
    const q = new URLSearchParams();
    const next: Params = { ...params, ...patch, open: undefined };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return q.size ? `/?${q}` : "/";
  };
  const toggled = (key: "labels" | "assignees", value: string) => {
    const cur = split(params[key]);
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    return hrefWith({ [key]: next.length ? next.join(",") : undefined });
  };

  return (
    <>
      <Title>beghu bench: SolidStart</Title>
      <header>
        <div>
          <For each={["open", "closed"]}>
            {(s) => (
              <A class="chip" noScroll aria-pressed={filter().state === s} data-bench="filter-state" data-value={s} href={hrefWith({ state: s === "open" ? undefined : s })}>
                {s}
              </A>
            )}
          </For>
        </div>
        <input
          data-bench="search"
          type="search"
          placeholder="Search titles"
          autocomplete="off"
          value={params.q ?? ""}
          onInput={(e) => setParams({ q: e.currentTarget.value || undefined }, { replace: true })}
        />
        <div class="chips">
          <For each={facetList()?.labels}>
            {(l) => (
              <A class="chip" noScroll aria-pressed={filter().labels.includes(l)} data-bench="filter-label" data-value={l} href={toggled("labels", l)}>
                {l}
              </A>
            )}
          </For>
        </div>
        <div class="chips">
          <For each={facetList()?.assignees}>
            {(a) => (
              <A class="chip" noScroll aria-pressed={filter().assignees.includes(a)} data-bench="filter-assignee" data-value={a} href={toggled("assignees", a)}>
                @{a}
              </A>
            )}
          </For>
        </div>
      </header>
      <main>
        <div
          id="list"
          ref={scrollEl}
          data-bench="list"
          data-bench-ready={hydrated() && first() ? "" : undefined}
          data-bench-empty={first()?.length === 0 ? "" : undefined}
        >
          <ul style={{ height: `${virt.getTotalSize()}px` }}>
            <For each={virt.getVirtualItems()}>
              {(v) => <Show when={rows()[v.index]}>{(row) => <IssueRow row={row()} top={v.start} onPreload={preloadIssue} onOpen={(id) => setParams({ open: id })} />}</Show>}
            </For>
          </ul>
        </div>
        <aside id="detail">
          <Show when={params.open}>
            {(id) => (
              <Suspense>
                <IssueDetail id={id()} />
              </Suspense>
            )}
          </Show>
        </aside>
      </main>
    </>
  );
}

function IssueRow(props: { row: Row; top: number; onPreload: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <li
      data-bench="row"
      data-id={props.row.id}
      style={{ transform: `translateY(${props.top}px)` }}
      onPointerEnter={() => props.onPreload(props.row.id)}
      onPointerDown={() => props.onPreload(props.row.id)}
      onClick={() => props.onOpen(props.row.id)}
    >
      <span class="repo">
        {props.row.repo}#{props.row.number}
      </span>
      <span data-bench="title">{props.row.title}</span>
      <span class="meta">{props.row.labels.map((l) => l.name).join(" ")}</span>
    </li>
  );
}

function IssueDetail(props: { id: string }) {
  const d = createAsync(() => issue(props.id));
  // Labels being added right now, shown before the server confirms them.
  const pending = useSubmissions(addLabel, ([id]) => id === props.id);
  const labels = () => {
    const have = d()?.labels ?? [];
    const names = new Set(have.map((l) => l.name));
    const extra = (d()?.repo_labels ?? []).filter((l) => !names.has(l.name) && pending.some((s) => s.pending && s.input[1] === l.name));
    return [...have, ...extra];
  };
  return (
    <Show when={d()}>
      {(d) => (
        <article data-bench="detail" data-id={d().id}>
          <h2>
            <span class="repo">
              {d().repo}#{d().number}{" "}
            </span>
            {d().title}
          </h2>
          <div>
            <For each={labels()}>
              {(l) => (
                <span class="label" data-bench="label" data-value={l.name}>
                  {l.name}
                </span>
              )}
            </For>
          </div>
          <div>
            Add:{" "}
            <For each={d().repo_labels.filter((l) => !labels().some((x) => x.name === l.name))}>
              {(l) => (
                <form action={addLabel.with(d().id, l.name)} method="post" class="inline">
                  <button data-bench="add-label" data-value={l.name}>
                    {l.name}
                  </button>
                </form>
              )}
            </For>
          </div>
          <pre data-bench="body">{d().body}</pre>
          <For each={d().comments}>
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
      )}
    </Show>
  );
}
