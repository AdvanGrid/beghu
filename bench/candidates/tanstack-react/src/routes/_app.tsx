import { Link, Outlet, createFileRoute, stripSearchParams, useNavigate } from '@tanstack/react-router'
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { facetsQuery, issuesQuery } from '#/lib/queries'
import { validateFilters, type Filters } from '#/lib/types'

const defaults: Filters = { state: 'open', label: [], assignee: [], q: '' }
const ROW_HEIGHT = 36

export const Route = createFileRoute('/_app')({
  validateSearch: validateFilters,
  search: { middlewares: [stripSearchParams(defaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    Promise.all([queryClient.ensureInfiniteQueryData(issuesQuery(deps)), queryClient.ensureQueryData(facetsQuery())]),
  component: AppLayout,
})

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

const chip =
  'rounded border border-zinc-200 px-2 py-0.5 text-zinc-900 hover:bg-zinc-100 aria-pressed:border-blue-600 aria-pressed:text-blue-600 dark:border-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-900 dark:aria-pressed:border-blue-400 dark:aria-pressed:text-blue-400'

function AppLayout() {
  useLiveUpdates()
  return (
    <div className="flex h-screen flex-col bg-white text-sm text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <FilterBar />
      <main className="grid min-h-0 flex-1 grid-cols-2">
        <IssueList />
        <aside className="overflow-y-auto px-4 py-3">
          <Outlet />
        </aside>
      </main>
    </div>
  )
}

// Refetches whatever is on screen when the server says something changed.
function useLiveUpdates() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const es = new EventSource('/events')
    es.onmessage = (e) => {
      const { ids } = JSON.parse(e.data) as { ids: string[] }
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      for (const id of ids) queryClient.invalidateQueries({ queryKey: ['issue', id] })
    }
    return () => es.close()
  }, [queryClient])
}

function FilterBar() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { data: facets } = useSuspenseQuery(facetsQuery())
  const [q, setQ] = useState(search.q)

  return (
    <header className="flex h-24 flex-wrap items-center gap-1.5 overflow-hidden border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      {(['open', 'closed'] as const).map((s) => (
        <Link key={s} to="." search={(prev) => ({ ...prev, state: s })} aria-pressed={search.state === s} data-bench="filter-state" data-value={s} className={chip}>
          {s}
        </Link>
      ))}
      <input
        data-bench="search"
        type="search"
        placeholder="Search titles"
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          navigate({ to: '.', search: (prev) => ({ ...prev, q: e.target.value }), replace: true })
        }}
        className="w-56 rounded border border-zinc-200 bg-white px-2 py-0.5 dark:border-zinc-800 dark:bg-zinc-950"
      />
      {facets.labels.map((l) => (
        <Link key={l} to="." search={(prev) => ({ ...prev, label: toggle(prev.label ?? [], l) })} aria-pressed={search.label.includes(l)} data-bench="filter-label" data-value={l} className={chip}>
          {l}
        </Link>
      ))}
      {facets.assignees.map((a) => (
        <Link key={a} to="." search={(prev) => ({ ...prev, assignee: toggle(prev.assignee ?? [], a) })} aria-pressed={search.assignee.includes(a)} data-bench="filter-assignee" data-value={a} className={chip}>
          @{a}
        </Link>
      ))}
    </header>
  )
}

function IssueList() {
  const filters = Route.useLoaderDeps()
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useSuspenseInfiniteQuery(issuesQuery(filters))
  const rows = data.pages.flat()
  const hydrated = useHydrated()
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    initialRect: { width: 640, height: 704 },
  })
  const items = virtualizer.getVirtualItems()

  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (lastIndex >= rows.length - 20 && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <div
      ref={parentRef}
      data-bench="list"
      data-bench-ready={hydrated ? '' : undefined}
      data-bench-empty={rows.length === 0 ? '' : undefined}
      className="overflow-y-auto border-r border-zinc-200 dark:border-zinc-800"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const r = rows[item.index]
          return (
            <Link
              key={r.id}
              to="/issues/$id"
              params={{ id: r.id }}
              search={filters}
              data-bench="row"
              data-id={r.id}
              className="absolute left-0 top-0 flex h-9 w-full gap-2 overflow-hidden whitespace-nowrap border-b border-zinc-200 px-3 py-2 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <span className="text-zinc-500 dark:text-zinc-400">
                {r.repo}#{r.number}
              </span>
              <span data-bench="title" className="truncate">
                {r.title}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">{r.labels.map((l) => l.name).join(' ')}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
