import { Title } from "@solidjs/meta";
import { createAsync, revalidate, useSearchParams, useSubmissions, type RouteDefinition } from "@solidjs/router";
import { createMemo, createSignal, For, on, onCleanup, onMount, Show, Suspense, createComputed } from "solid-js";
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
    issues(toFilter(location.query as Params), 0);
  },
} satisfies RouteDefinition;

export default function Home() {
  const [params, setParams] = useSearchParams<Params>();
  const filter = createMemo(() => toFilter(params), undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const [pages, setPages] = createSignal(1);
  createComputed(on(filter, () => setPages(1), { defer: true }));

  const facetList = createAsync(() => facets());
  const first = createAsync(() => issues(filter(), 0));
  const last = createAsync(() => issues(filter(), pages() - 1));

  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => {
    setHydrated(true);
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as { ids: string[] };
      revalidate(issues.key);
      if (params.open && ids.includes(params.open)) revalidate(issue.keyFor(params.open));
    };
    onCleanup(() => es.close());
  });

  const toggle = (key: "labels" | "assignees", value: string) => {
    const cur = split(params[key]);
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    setParams({ [key]: next.length ? next.join(",") : undefined });
  };

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 1500 && last()?.length === PAGE) setPages(pages() + 1);
  };

  return (
    <>
      <Title>beghu bench: SolidStart</Title>
      <header>
        <div>
          <For each={["open", "closed"]}>
            {(s) => (
              <button aria-pressed={filter().state === s} data-bench="filter-state" data-value={s} onClick={() => setParams({ state: s === "open" ? undefined : s })}>
                {s}
              </button>
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
              <button aria-pressed={filter().labels.includes(l)} data-bench="filter-label" data-value={l} onClick={() => toggle("labels", l)}>
                {l}
              </button>
            )}
          </For>
        </div>
        <div class="chips">
          <For each={facetList()?.assignees}>
            {(a) => (
              <button aria-pressed={filter().assignees.includes(a)} data-bench="filter-assignee" data-value={a} onClick={() => toggle("assignees", a)}>
                @{a}
              </button>
            )}
          </For>
        </div>
      </header>
      <main>
        <ul
          id="list"
          data-bench="list"
          data-bench-ready={hydrated() && first() ? "" : undefined}
          data-bench-empty={first()?.length === 0 ? "" : undefined}
          onScroll={onScroll}
        >
          <For each={Array.from({ length: pages() }, (_, i) => i)}>
            {(page) => (
              <Suspense>
                <IssuePage filter={filter()} page={page} onOpen={(id) => setParams({ open: id })} />
              </Suspense>
            )}
          </For>
        </ul>
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

function IssuePage(props: { filter: Filter; page: number; onOpen: (id: string) => void }) {
  const rows = createAsync(() => issues(props.filter, props.page));
  return <For each={rows()}>{(r) => <IssueRow row={r} onOpen={props.onOpen} />}</For>;
}

function IssueRow(props: { row: Row; onOpen: (id: string) => void }) {
  return (
    <li data-bench="row" data-id={props.row.id} onClick={() => props.onOpen(props.row.id)}>
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
