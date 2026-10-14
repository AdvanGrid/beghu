// The issue list with its filters, and an outlet for the open issue. Filters live in the URL's
// search params; the list is one infinite query per filter, windowed with TanStack Virtual.
// Filter chips and rows are buttons that navigate, not <Link>s: at 6x CPU a Link each cost
// too much on load and while scrolling (see the change log on the ticket).

import { Outlet, createFileRoute, stripSearchParams, useNavigate, useRouter } from '@tanstack/solid-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/solid-query'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { DEFAULT_FILTERS, facetsQuery, issuesQuery, validateFilters, type Filters, type IssueRow } from '~/issues'

export const Route = createFileRoute('/_app')({
  ssr: 'data-only',
  validateSearch: validateFilters,
  search: { middlewares: [stripSearchParams(DEFAULT_FILTERS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(facetsQuery()), context.queryClient.ensureInfiniteQueryData(issuesQuery(deps))]),
  component: AppLayout,
})

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

const chip =
  'rounded border px-2 py-0.5 text-xs border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
const chipOn = 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:border-blue-500 dark:text-white dark:hover:bg-blue-600'

function AppLayout() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const facets = useQuery(() => facetsQuery())
  const queryClient = useQueryClient()
  const router = useRouter()
  // Hover preloads the filtered list, as a <Link> with defaultPreload: 'intent' would.
  const preload = (search: (prev: Filters) => Filters) => router.preloadRoute({ from: Route.fullPath, search }).catch(() => {})

  onMount(() => {
    const events = new EventSource('/api/events')
    events.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as { ids: string[] }
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      for (const id of ids) queryClient.invalidateQueries({ queryKey: ['issue', id] })
    }
    onCleanup(() => events.close())
  })

  return (
    <div class="flex h-screen flex-col">
      <header class="flex flex-col gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <div class="flex items-center gap-2">
          <For each={['open', 'closed'] as const}>
            {(state) => (
              <button
                type="button"
                onPointerEnter={() => preload((prev: Filters) => ({ ...prev, state }))}
                onClick={() => navigate({ search: (prev: Filters) => ({ ...prev, state }) })}
                data-bench="filter-state"
                data-value={state}
                class={`${chip} ${search().state === state ? chipOn : ''}`}
              >
                {state}
              </button>
            )}
          </For>
          <input
            data-bench="search"
            type="search"
            placeholder="Search titles"
            autocomplete="off"
            value={search().q}
            onInput={(e) => navigate({ search: (prev: Filters) => ({ ...prev, q: e.currentTarget.value }), replace: true })}
            class="ml-2 w-72 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>
        <div class="flex flex-wrap gap-1">
          <For each={facets.data?.labels}>
            {(name) => (
              <button
                type="button"
                onPointerEnter={() => preload((prev: Filters) => ({ ...prev, labels: toggle(prev.labels, name) }))}
                onClick={() => navigate({ search: (prev: Filters) => ({ ...prev, labels: toggle(prev.labels, name) }) })}
                data-bench="filter-label"
                data-value={name}
                class={`${chip} ${search().labels.includes(name) ? chipOn : ''}`}
              >
                {name}
              </button>
            )}
          </For>
        </div>
        <div class="flex flex-wrap gap-1">
          <For each={facets.data?.assignees}>
            {(login) => (
              <button
                type="button"
                onPointerEnter={() => preload((prev: Filters) => ({ ...prev, assignees: toggle(prev.assignees, login) }))}
                onClick={() => navigate({ search: (prev: Filters) => ({ ...prev, assignees: toggle(prev.assignees, login) }) })}
                data-bench="filter-assignee"
                data-value={login}
                class={`${chip} ${search().assignees.includes(login) ? chipOn : ''}`}
              >
                @{login}
              </button>
            )}
          </For>
        </div>
      </header>
      <main class="flex min-h-0 flex-1">
        <IssueList filters={search()} />
        <aside class="w-1/2 overflow-auto border-l border-zinc-200 dark:border-zinc-800">
          <Outlet />
        </aside>
      </main>
    </div>
  )
}

const ROW_HEIGHT = 36

function IssueList(props: { filters: Filters }) {
  const query = useInfiniteQuery(() => issuesQuery(props.filters))
  const rows = createMemo(() => query.data?.pages.flat() ?? [])
  const [hydrated, setHydrated] = createSignal(false)
  onMount(() => setHydrated(true))

  let scrollEl: HTMLDivElement | undefined
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    initialRect: { width: 640, height: 800 },
  })

  createEffect(() => {
    const items = virtualizer.getVirtualItems()
    const last = items[items.length - 1]
    if (last && last.index >= rows().length - 5 && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage()
  })

  return (
    <div
      ref={scrollEl}
      data-bench="list"
      data-bench-ready={hydrated() ? '' : undefined}
      data-bench-empty={rows().length === 0 && !query.isFetching ? '' : undefined}
      class="min-w-0 flex-1 overflow-auto"
    >
      <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(item) => <Row row={rows()[item.index]} top={item.start} />}
        </For>
      </div>
    </div>
  )
}

// Hover preloads the issue, as a <Link> with defaultPreload: 'intent' would.
function Row(props: { row: IssueRow; top: number }) {
  const navigate = useNavigate()
  const router = useRouter()
  const target = () => ({ from: Route.fullPath, to: '/issues/$id' as const, params: { id: props.row.id }, search: (prev: Filters) => prev })
  return (
    <div
      data-bench="row"
      data-id={props.row.id}
      onPointerEnter={() => router.preloadRoute(target()).catch(() => {})}
      onClick={() => navigate(target())}
      class="absolute left-0 flex w-full cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 text-sm hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
      style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${props.top}px)` }}
    >
      <span class="w-32 shrink-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
        {props.row.repo}#{props.row.number}
      </span>
      <span data-bench="title" class="truncate">
        {props.row.title}
      </span>
      <span class="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{props.row.labels.map((l) => l.name).join(' ')}</span>
    </div>
  )
}
