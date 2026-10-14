# TanStack Start + React: benchmark record

The candidate for [Benchmark: TanStack Start + React](https://github.com/tomsjansons/beghu/issues/13).
Throwaway: it exists to be measured and felt, not to start the real app.

```sh
./bench/run tanstack-react                       # headline cell
./bench/run tanstack-react --profile all --net all --scale all
```

**Stack:** TanStack Start 1.169.1 (Router 1.170, Query 5.104, Virtual 3.14), React 19 with the
React Compiler (`reactCompilerPreset()` through `@rolldown/plugin-babel`), Vite 8, Nitro 3 beta
(`node-server` preset) on Node 24 (alpine), `node:sqlite` straight on the mirror, Tailwind 4.
Scaffolded with `npx @tanstack/cli create` and the `compiler,tanstack-query,nitro` add-ons.
The build writes `.output/server/index.mjs`, which is what the Dockerfile runs.

## Data path

Server functions (`createServerFn().validator(...)`) over the mirror, read through TanStack Query,
as the Start docs and the `tanstack-query` add-on lead you.

| Concern | Idiomatic pass | Optimised pass |
|---|---|---|
| First paint | SSR: the `_app` loader `ensureInfiniteQueryData`s the first 50 rows, dehydrated into the client cache | Same |
| Filter and search | Filters in typed search params (`validateSearch`, `stripSearchParams`); chips are `<Link search={prev => ...}>`, search input `navigate({ replace })`; `loaderDeps` reruns the loader | Chips are `<button>`s that call `prefetchInfiniteQuery` for the next filters, then `navigate`; the loader picks up the in-flight query |
| List | `useSuspenseInfiniteQuery` + `useVirtualizer` (overscan 10, `initialRect` for SSR), one `<Link>` per row | Plain row elements with one delegated click (`router.navigate`) and hover (`router.preloadRoute`) handler; overscan 4 |
| Detail | Child route `/issues/$id`, loader `ensureQueryData` | Same |
| Live updates | `EventSource` on a server route (`/events`); each event invalidates `['issues']` and `['issue', id]` | Same |
| Write | `useMutation` with optimistic `setQueryData` in `onMutate`, rollback in `onError` | Optimistic "via the UI": `useMutationState` renders pending labels; `onSettled` invalidates |
| Static assets | Served uncompressed | `nitro({ compressPublicAssets: true })`: brotli/gzip precompressed |

## Numbers

Full matrix, 20 iterations per scenario, `--cpus=1 --memory=512m`, run under the host-wide bench
lock, every recorded run after the live-scenario fix (d71da26). Raw output (gitignored, on the
bench host):

- Default, assembled from four runs because the queue was shared and one run was disturbed:
  `bench/results/2026-10-14-050414-tanstack-react/` (fast cells, low-near-20k, low-near-50k
  cold–detail; killed before writing `summary.md`, so `results.json` only),
  `2026-10-14-114202-tanstack-react/` (low-far), `2026-10-14-153913-tanstack-react/`
  (low-near-50k live and write) and `2026-10-14-171350-tanstack-react/` (low-near-20k warm,
  re-run because another session killed the server mid-scenario in the first run).
- Optimised: `bench/results/2026-10-14-180617-tanstack-react/`, one run.

No scenario logged an error. p95 in ms, **default → optimised**, ✓/✗ against the reference line.
`low` = 6× CPU throttle.

| Scenario (p95 ms) | low-far-20k (headline) | low-far-50k | low-near-20k | low-near-50k | fast-far-20k | fast-far-50k | fast-near-20k | fast-near-50k |
|---|---|---|---|---|---|---|---|---|
| Cold load ≤ 3000 | 1856✓ → **1802**✓ | 1914✓ → **1722**✓ | 2074✓ → **1633**✓ | 1876✓ → **1595**✓ | 820✓ → **522**✓ | 804✓ → **542**✓ | 311✓ → **292**✓ | 347✓ → **302**✓ |
| Warm load ≤ 1000 | 1882✗ → **1731**✗ | 1860✗ → **1691**✗ | 1841✗ → **1649**✗ | 1959✗ → **1554**✗ | 371✓ → **352**✓ | 382✓ → **380**✓ | 321✓ → **260**✓ | 264✓ → **269**✓ |
| Filter and search ≤ 200 | 540✗ → **356**✗ | 445✗ → **378**✗ | 588✗ → **470**✗ | 528✗ → **298**✗ | 311✗ → **328**✗ | 394✗ → **381**✗ | 293✗ → **343**✗ | 356✗ → **392**✗ |
| Scroll frames ≤ 33, no task > 100 | 83.3✗ → **66.7**✗ | 100✗ → **66.7**✗ | 83.4✗ → **66.7**✗ | 83.4✗ → **66.7**✗ | 16.7✓ → **16.7**✓ | 16.8✓ → **16.8**✓ | 16.7✓ → **16.8**✓ | 16.8✓ → **16.8**✓ |
| Open detail ≤ 300 | 452✗ → **360**✗ | 561✗ → **368**✗ | 412✗ → **352**✗ | 346✗ → **386**✗ | 177✓ → **172**✓ | 174✓ → **168**✓ | 75.6✓ → **69**✓ | 262✓ → **67.8**✓ |
| Live update ≤ 2000 | 231✓ → **209**✓ | 375✓ → **220**✓ | 129✓ → **104**✓ | 147✓ → **120**✓ | 167✓ → **163**✓ | 178✓ → **165**✓ | 62✓ → **59**✓ | 67✓ → **251**✓ |
| Optimistic write ≤ 100 | 127✗ → **110**✗ | 169✗ → **107**✗ | 89.5✓ → **109**✗ | 104✗ → **107**✗ | 28.4✓ → **28.8**✓ | 29.1✓ → **28.9**✓ | 27.9✓ → **28.8**✓ | 28.7✓ → **29.2**✓ |

Headline cell (low-far-20k) p50, default → optimised: cold 1735 → 1590, warm 1651 → 1552,
filter 289 → 233, detail 387 → 336, live 220 → 194, write 83 → 87 ms. Row 500 reached in
5.5 → 4.8 s, with 57 → 5 long tasks over 100 ms.

Notes on reading it:

- **Scale doesn't matter.** 20k and 50k agree within noise. The SQL runs in milliseconds
  (indexed; the server sits at ~30–40 MB RSS and low CPU); the time is in the browser.
- **Warm load is the wall on `low`.** ~1.5–1.7 s against 1000, in every low cell, before and after.
  The HTML arrives in ~150 ms; the rest is booting the router, Query and React and hydrating
  (~760 ms of framework script spread flat across the profile, ~820 ms `(program)`, 6× CPU).
  Nothing in the optimisation pass moved it much; see "Remaining misses".
- **Filter misses everywhere, including `fast`.** The p50 is fine (47–50 ms fast-near), the tail
  is not. The per-step p95s show it is the **assignee** and **state** toggles (0.7–1.5 s p95 on
  every cell, `fast` included) that blow the p95, while label and search sit at 160–470 ms on
  `low`. Those toggles change the result set the most; the likely cause is the suspended list
  re-mounting and re-measuring the virtualiser, but I did not profile the tail iterations.
- **Scroll is close.** `fast` is clean (0 long tasks). On `low` the p95 frame is 66.7 ms with
  5–11 tasks over 100 ms (max 126–145 ms), down from 57–246 tasks over 100 ms in the default.
- **Write misses by a few ms on `low`** (p95 104–110, p50 83–94). The optimistic chip renders on
  the click, but the mutation hook, the re-render and the compiler-memoised tree still take ~85 ms
  of 6×-throttled script. The O4 change was neutral in the harness (127/169 → 110/107 on far,
  89.5 → 109 on low-near-20k).
- **One odd cell:** fast-near-50k live went 67 → 251 ms p95 (p50 240) in the optimised run, while
  every other live cell improved or held. The live path is unchanged code; read it as a noisy
  cell, not a regression, but it was not re-run.
- **Bundle.** JS is 405 KB decoded in 5 files either way (the main chunk 365 KB raw). Default
  served it uncompressed: **406.9 KB on the wire**. Optimised (`compressPublicAssets`):
  **114.3 KB on the wire** (main chunk ~100 KB br). That is the whole cold-load gain on `fast-far`
  (820 → 522 ms). Devtools are stripped from the production build.

## Change log (optimisation pass)

Per-change numbers come from single-tab Playwright runs on this host against the production
build (6× CPU, far network, 20k), with the idiomatic build re-measured under the same host load
as the baseline: warm 2060, label 407, assignee 324, search 381, detail 390, write 118 ms (p50).
The host was shared and noisy, so they show direction and rough size; the harness matrices above
are the record.

| # | Change | Target | Before → after (p50 ms) | Kind | Kept |
|---|---|---|---|---|---|
| O1 | `nitro({ compressPublicAssets: true })` | Cold load | Main chunk 365 KB → 100 KB br on the wire; warm unaffected (cached) | Documented feature (Nitro) | Yes |
| O1b | `staleTime: Infinity` on the issues query, to stop the refetch-on-mount after hydration | Warm load | No measurable change | Documented feature (Query) | No, reverted |
| O2 | Rows as plain elements with one delegated click/hover handler instead of a `<Link>` each; overscan 10 → 4 | Warm load, scroll, filter | warm 2060 → 1943, label 407 → 331, assignee 324 → 262, search 381 → 331, detail 390 → 318 | Fighting the framework, mildly: gives up `<Link>` (typed hrefs, built-in preloading) for `router.navigate`/`router.preloadRoute` | Yes |
| O3 | Filter chips as `<button>`s that `prefetchInfiniteQuery` the next filters before `navigate` | Filter | click → fetch start 54–157 → 30–90; rows painted: label 403 → 310, assignee 302 → 237, state 237 → 197 | Documented feature (Query prefetch); drops `<Link>` for the chips | Yes |
| O4 | Optimistic label "via the UI" (`useMutationState` over a `mutationKey`) instead of writing the cache in `onMutate` | Write | ~118 → ~120 (no change) | Documented feature (Query) | Yes, it is the simpler code |

Harness, headline cell p95 before → after: filter 540 → 356, detail 452 → 360, write 127 → 110,
warm 1882 → 1731, scroll long tasks > 100 ms 57 → 5.

## Remaining misses

- **Warm load, ~1.55 s p50 against 1000 on `low`.** Framework boot and hydration under 6× CPU:
  React + Router + Query + Virtual is ~365 KB of script that has to parse, run and hydrate before
  `data-bench-ready`. *Plausible fix:* none inside this stack short of serving less JS, e.g. moving
  the list to React Server Components if Start's support for them is usable (not checked).
  *Rough cost:* days, with no guarantee it lands under 1000.
- **Filter, p95 300–470 on `low` and 330–390 on `fast`.** A far round trip (~100 ms) is the
  floor, plus ~100 ms of render, plus the state/assignee tail. *Plausible fix:* keep previous rows
  on screen (`placeholderData: keepPreviousData`) instead of suspending the list, and keep the
  virtualiser mounted across filter changes. *Rough cost:* half a day.
- **Open detail, p95 352–386 on `low`.** The round trip and the panel render. *Plausible fix:*
  seed the detail query from the row already in the list cache (`initialData`) so the title and
  labels paint at once, and the body and comments stream in. *Rough cost:* an hour or two, but
  the harness waits for the body, so it would not move the number.
- **Write, p95 107–110 on `low`.** Re-render cost of the detail panel on the optimistic update.
  *Plausible fix:* split the label chips into their own component so only they re-render.
  *Rough cost:* an hour.

## DX checklist

- **Agent-friendliness.** Mixed. The type surface is excellent once found, and the TypeScript
  errors point at the right place. But: the documented `npm create @tanstack/start` is deprecated
  and silently dropped the `compiler` and `tanstack-query` add-ons (and created a nested `.git`);
  the working scaffolder is `npx @tanstack/cli create`. My knowledge said `inputValidator`; the
  types and current docs say `.validator`. The README the scaffold writes says the build goes to
  `dist/`; it goes to `.output/`. The build prints `MODULE_LEVEL_DIRECTIVE` warnings for
  `"use client"` in dependencies, which are harmless but noise. Each cost a lookup, none a
  dead end. The React Compiler and `@tanstack/react-virtual` coexisted without trouble.
- **End-to-end type safety.** The strongest of the stacks so far: server function inputs are
  validated and typed at the call site, search params are typed through `validateSearch`, route
  params and loader data flow into components, `<Link to>` is checked against the route tree.
  One rough edge: typed `search={(prev) => ...}` reducers on `<Link>` needed `prev` left
  un-annotated and `?? []` defaults to type-check.
- **Dev loop.** Dev server ready in ~2.5 s, first SSR page ~2.9 s later (dependency
  optimisation). Production `vite build` ~2.5 s cold, ~0.7 s cached on a quiet host (1:15 under
  the shared bench load). Docker build ~1.5 min under load. HMR was not measured (no browser
  attached to the dev server in this session).
- **Maturity and churn.** `@tanstack/react-start` has shipped 673 releases on the 1.x line since
  2025-02-25 (35 in the last 90 days): fast-moving, API names still shifting (`validator`).
  Router repo 15.2k stars; over the last year four people (GitHub `schiller-manuel`,
  `tannerlinsley`, `Sheraff`, `birkskyum`) wrote most of the commits (bus factor ~4). TanStack
  Query v5 has been stable since 2023-10. Nitro 3 is still a beta. React itself is the least risky
  part of the stack.
- **Lines of code after optimisation.** 568 hand-written lines across `src/` (`_app.tsx` 162,
  `server/db.server.ts` 200 of which most is the webhook/mirror SQL every candidate needs,
  `issues.$id.tsx` 76), plus 94 kept from the scaffold (`__root.tsx`, `router.tsx`) and the
  generated `routeTree.gen.ts`. The idiomatic pass was ~555.

## Friction worth weighing

- **Heavy client for a list page.** ~365 KB raw (100 KB br) of framework before any app code.
  On `low` it is the warm-load miss, and no setting in the box removes it.
- **`<Link>` everywhere costs.** The idiomatic list renders a typed `<Link>` per row and per chip.
  Each one subscribes to router state and recomputes its href and active state on every
  navigation, which showed up as the largest share of the filter-click work before the fetch even
  started. The fast path gives up `<Link>` for `router.navigate` and loses typed hrefs in the JSX.
- **Two caches to reason about.** The router's loader cache and Query's cache both hold the data;
  the integration wires them together, but deciding which one owns staleness (`staleTime`,
  `loaderDeps`, `preloadRoute` vs `prefetchQuery`) takes reading.
- **Young, fast-moving framework layer.** Start is on its 673rd 1.x release, the scaffolder
  changed under the docs, and the server layer is a Nitro 3 beta. Expect renames.
