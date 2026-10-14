# SvelteKit (Svelte 5): benchmark record

The candidate for [Benchmark: SvelteKit (Svelte 5)](https://github.com/tomsjansons/beghu/issues/18).
Throwaway: it exists to be measured and felt, not to start the real app.

```sh
./bench/run sveltekit                       # headline cell
./bench/run sveltekit --profile all --net all --scale all
```

**Stack:** SvelteKit 3.0.1, Svelte 5.57 (runes), Vite 8, adapter-node 6 on Node 24 (alpine),
`node:sqlite` straight on the mirror, Tailwind 4. No other runtime dependencies.

## Data path

Server-side SQL, as SvelteKit's docs lead you: the mirror is read in `+page.server.ts` load
functions and written by a form action.

| Concern | Idiomatic pass | Optimised pass |
|---|---|---|
| First paint | SSR of the first 50 rows from `load`, hydrated | SSR of the first 25 rows |
| Filter and search | Links and `goto()` change the URL, `load` reruns (`__data.json`) | One `fetch` to a `+server.ts` JSON endpoint; URL updated by a shallow `goto` |
| More rows | `IntersectionObserver` sentinel fetches 50-row pages | Only after the first scroll; 100-row pages |
| Detail | `preloadData` + shallow routing (`goto(href, { shallow, state })`), as the docs show for modals | Same, comments use `content-visibility: auto` |
| Live updates | `EventSource` on a streaming `+server.ts`; each event calls `invalidate('app:issues')` | Each event refetches the first page |
| Write | Form action + `use:enhance`, optimistic chip set before the request | Same |

## Numbers

Full matrix, 20 iterations per scenario, `--cpus=1 --memory=512m`, run under the host-wide bench
lock with nothing else measuring. Raw output (gitignored, on the bench host):
`bench/results/2026-10-14-100318-sveltekit/` (default, commit d71da26) and
`bench/results/2026-10-14-110028-sveltekit/` (optimised).

p95 in ms, **default → optimised**, ✓/✗ against the reference line. `low` = 6× CPU throttle.

| Scenario (p95 ms) | low-far-20k (headline) | low-far-50k | low-near-20k | low-near-50k | fast-far-20k | fast-far-50k | fast-near-20k | fast-near-50k |
|---|---|---|---|---|---|---|---|---|
| Cold load ≤ 3000 | 1574✓ → **1096**✓ | 1582✓ → **1108**✓ | 1589✓ → **1131**✓ | 1564✓ → **1057**✓ | 598✓ → **376**✓ | 567✓ → **380**✓ | 384✓ → **238**✓ | 342✓ → **258**✓ |
| Warm load ≤ 1000 | 1432✗ → **1190**✗ | 1751✗ → **1131**✗ | 1462✗ → **1147**✗ | 1337✗ → **1160**✗ | 340✓ → **302**✓ | 387✓ → **339**✓ | 230✓ → **200**✓ | 248✓ → **223**✓ |
| Filter and search ≤ 200 | 541✗ → **272**✗ | 577✗ → **273**✗ | 508✗ → **280**✗ | 499✗ → **279**✗ | 170✓ → **132**✓ | 174✓ → **132**✓ | 91✓ → **52**✓ | 115✓ → **50**✓ |
| Scroll frames ≤ 33, no task > 100 | 233✗ → **33**✗ | 217✗ → **33**✗ | 233✗ → **317**✗ | 233✗ → **317**✗ | 33.3✗ → **33.2**✗ | 33.3✗ → **33.2**✗ | 33.3✗ → **33.3**✗ | 33.3✗ → **33.3**✗ |
| Open detail ≤ 300 | 480✗ → **346**✗ | 448✗ → **373**✗ | 446✗ → **661**✗ | 622✗ → **616**✗ | 180✓ → **158**✓ | 347✗ → **165**✓ | 79✓ → **61**✓ | 100✓ → **63**✓ |
| Live update ≤ 2000 | 488✓ → **166**✓ | 429✓ → **187**✓ | 444✓ → **99**✓ | 640✓ → **88**✓ | 177✓ → **134**✓ | 183✓ → **138**✓ | 74✓ → **53**✓ | 85✓ → **55**✓ |
| Optimistic write ≤ 100 | 79✓ → **85**✓ | 82✓ → **72**✓ | 92✓ → **87**✓ | 87✓ → **81**✓ | 14✓ → **12**✓ | 12✓ → **12**✓ | 13✓ → **15**✓ | 13✓ → **12**✓ |

Headline cell (low-far-20k) p50, default → optimised: cold 1447 → 1031, warm 1305 → 1032,
filter 408 → 205, detail 429 → 323, live 398 → 158, write 63 → 69 ms. Row 500 reached in
5.6 → 3.6 s, with 185 → 154 long tasks over 100 ms.

Notes on reading it:

- **Scale doesn't matter.** 20k and 50k agree within noise everywhere. The SQL runs in single
  milliseconds; the time is in the browser.
- **The `fast` scroll ✗ is one dropped frame.** p95 33.3 ms is two 60 Hz frames, with zero long
  tasks in the default and none over 100 ms optimised. It misses the line by a hair, not by work.
- **The default's state toggle was the worst filter.** open ↔ closed had p95 0.5–1.8 s, because
  the navigation re-rendered every row. Through the endpoint (O5) it falls in line with the other
  filters, at 212–252 ms on `low`.
- **The `low-near` detail tail** (p95 616–661 ms, p50 242–249 ms) comes from one or two
  iterations per cell, not a shift in the distribution. The far cells' p50 323–333 ms is the
  number to hold the candidate to.
- **Bundle.** Default: 42 KB gzipped JS in 13 files. Optimised (`bundleStrategy: 'single'`):
  40.1 KB in 1 file, 123.7 KB decoded. Server RSS stays under 33 MB in every cell.

## Change log (optimisation pass)

Per-change numbers come from single-tab Playwright traces on this host against `node build`
(6× CPU, far network, 20k), not the harness. They show direction and rough size; the harness
matrices above are the record.

| # | Change | Target | Before → after | Kind | Kept |
|---|---|---|---|---|---|
| O1 | First page 50 → 25 rows; sentinel margin 1500 → 600 px | warm, filter | warm ready 1325 → 1265 ms; filter little change | documented (plain tuning) | yes |
| O2 | Drop `backdrop-blur` on the sticky header | filter, scroll | filter ≈ unchanged | plain CSS | yes |
| O3 | `output.bundleStrategy: 'single'` | cold | cold ready median 1438 → 1274 ms (5 runs); warm unchanged, hydration becomes one ~380 ms task | documented feature | yes |
| O4 | No page fetch before the first scroll; later pages 100 rows | warm, cold | warm ready 1300 → 1060–1090 ms; cold median 1274 → 1095 ms | plain code | yes |
| O5 | Filters fetch rows from a JSON endpoint instead of navigating; URL via shallow `goto` in its own task | filter | 390–450 → 345–395 ms (trace includes ~80–100 ms of Playwright's pre-click work); ≈ 290 ms from the click event | **fights the framework**: bypasses `load` for everything but the first render | yes |
| O6 | Label chips as plain markup, row highlight via one `$derived` | filter | no measurable change within noise | — | reverted |
| O7 | Re-enable SvelteKit's default hover/tap preloading on rows | detail | detail ≈ unchanged (Playwright's mousedown lands ms before the click); scroll frames p50 17 → 33 ms because every row scrolled under the pointer starts a preload | documented default | reverted |
| O8 | `content-visibility: auto` on comments | detail | ~330 → ~285 ms | plain CSS | yes |
| — | `content-visibility: auto` on rows | scroll | frames p50 17 → 33 ms (worse) | plain CSS | reverted |
| O9 | Drop the row hover background | scroll | frames p95 67 → 33 ms; long tasks only on page appends; row 500 reached in 5.1 → 3.1 s | plain CSS, a UX trade | yes |
| — | 40-row scroll pages / appending 20 rows per frame / one `{#each}` per page | scroll long tasks | append tasks stay 100–260 ms; frames worse or unchanged | — | reverted |

## Where the time goes, and what it would take

Optimised build, against the lines it still misses, all on `low` (6× CPU).

- **Warm load, p95 1131–1190 ms against 1000.** p50 sits right on the line (1000–1032 ms).
  The time is HTML parse and paint of 25 SSR rows, then one ~200–380 ms hydration task before the
  page counts as ready. The bundle is already one file, and the first page already small.
  *Plausible fix:* skip hydrating the list. Render rows as static SSR HTML, hydrate only the
  header, and wire row clicks with one delegated listener. Or don't SSR the list at all and render
  25 rows on the client from a JSON island. *Rough cost:* 1–2 days. Either way it means leaving
  SvelteKit's single-component page model, and the second one gives up SSR's early paint.
- **Filter, p95 272–280 ms against 200.** p50 is 180–205 ms. About 110 ms is the far network's
  round trip, which no client can avoid without a client-side copy of the data. The rest is
  rendering 25 keyed rows at 6× CPU (~60–90 ms) plus the shallow `goto`. The label filter is the
  slowest (p95 307–338 ms): its rows carry the most chips. *Plausible fix:* render chips as plain
  markup instead of a component per chip, and defer the URL update until after paint. O6 tried the
  first in local traces and saw nothing within noise, so expect tens of ms, not 80. Making it
  safe takes a client cache of recent filter results (show the cached page, then refresh).
  *Rough cost:* half a day for the render trims; 1–2 days for a cache, which edges toward the
  sync-engine territory this benchmark rules out.
- **Scroll, ~140–155 long tasks over 100 ms per run.** Frames hold 16.7 ms p50 with no hover
  repaint (O9). The long tasks are page appends: Svelte creating 100 keyed rows costs ~1.3 ms a row
  at 6× CPU, so each append is a 200–330 ms task. Smaller pages trade fewer long tasks for more
  requests and an emptier scroll (tried, reverted). *Plausible fix:* a windowed list (e.g.
  virtua's Svelte `VList`), so only ~40 rows exist in the DOM at once. *Rough cost:* about a day,
  plus a check that the harness's row-500 probe and `data-bench` hooks survive virtualisation.
- **Open detail, p50 323–333 ms against 300 on far.** One far round trip (~110 ms), the
  `preloadData` load-function call, then rendering the panel with its comments. O8's
  `content-visibility` took about 45 ms off the render. *Plausible fix:* show the row's data in the
  panel instantly (title, labels and assignees are already on the client), and stream the body and
  comments in when the request returns. *Rough cost:* half a day. The harness waits for the
  `detail` hook with its body, so the scenario would still count the round trip, but the user
  would see the panel at once.
- **Fast-profile scroll, p95 33.2–33.3 ms against 33.** One dropped frame in twenty, no long
  tasks over 100 ms. Not worth chasing separately: the windowed list above would cover it.

## DX checklist

- **Agent-friendliness.** SvelteKit 3.0.0 shipped on 2026-10-01, two weeks before this build, so
  an agent's knowledge is 2.x. What changed under me: config moved into `vite.config.ts`
  (`sveltekit({ adapter, output, ... })`); `$lib` became the `#lib` subpath import, and TypeScript
  only resolved `#lib/types.ts` *with* the extension; `$app/environment` became `$app/env`; env
  vars must be declared in `src/env.ts` with `defineEnvVars` before `$app/env/private` exports
  them; `pushState`/`invalidateAll` are deprecated for `goto(..., { shallow })`/`refreshAll`.
  Every one was findable: the JSDoc in `@sveltejs/kit/types` names the replacement, and the
  migration guide lists them. No circles once looked up. `sv create` stalled on an interactive
  prompt until given `tailwindcss=plugins:none`.
- **End-to-end type safety.** Strong on the framework path: `load` return types flow into
  `PageProps`, form actions and `$app/state` are typed, `svelte-check` catches template errors and
  a11y issues. Weak off it: `+server.ts` JSON endpoints are untyped at the call site (`fetch` →
  cast), and O5 moved the filter path onto one. Typed RPC exists as remote functions
  (`query`/`command`/`form`, plus `query.live`), still experimental behind a flag in 3.0.
- **Dev loop.** Production build ~7 s cold or warm; `svelte-check` ~7 s; dev server ready in
  ~2.9 s with a cold Vite cache; HMR edit-to-DOM ~180–250 ms (first edit ~590 ms); edits to
  server modules apply on the next request without a page reload. Errors are readable, with one
  trap: the build's route analysis imports server modules, so opening the database at module
  scope failed the build with `unable to open database file` from a compiled chunk. Fix:
  guard with `building` from `$app/env`.
- **Maturity and churn.** Two majors in two years: Svelte 5 (runes, 2024-10) and SvelteKit 3
  (2026-10). Before that SvelteKit 2 (2023-12). Cadence: 63 SvelteKit and 109 Svelte releases in
  the last 12 months. Bus factor: Svelte had 62 commit authors in 12 months, but two people
  (GitHub `Rich-Harris` and `dummdidumm`) wrote about 56% of the commits. Rich Harris works on
  Svelte at Vercel.
- **Lines of code after optimisation.** 750 lines across `src/` (`+page.svelte` 218,
  `lib/server/db.ts` 212 of which most is the webhook/mirror SQL every candidate needs), plus a
  15-line Dockerfile and 20-line `vite.config.ts`. The idiomatic pass was 710.

## Friction worth weighing

- **Hydration is the floor under cold and warm.** SSR paints rows early, but `data-bench-ready`
  waits for hydration. At 6× CPU that is one 200–380 ms long task whatever the bundle strategy.
  The docs offer no partial or lazy hydration for a page like this one.
- **The router is the slow path for in-page state.** The documented way to filter is to put the
  filter in the URL and let `load` rerun. Each change then pays for a `__data.json` round trip,
  the router's navigation lifecycle and a whole-page re-render. Filtering got fast only once it
  stopped navigating (O5). After that, `load` serves the first paint and nothing else, and the
  filter path loses `load`'s types.
- **Defaults that hurt this workload.** Hover preloading (`data-sveltekit-preload-data="hover"`
  from the template) starts a request for every row the pointer crosses while scrolling. It is
  easy to switch off, but it is on by default.
- **No list virtualisation in the box.** Appending 100 rows is a 200–330 ms task at 6× CPU
  (about 1.3 ms per row through Svelte's keyed `{#each}`). Slicing and per-page blocks didn't
  help. The fix is a windowed list from a third-party package.
- **Two type systems for the data path.** `load` and form actions are typed end to end. JSON
  `+server.ts` endpoints are not, and the fast paths (filter, paging, live refetch) all go
  through one. Remote functions would close the gap but are experimental in 3.0.
- **A brand-new major.** SvelteKit 3 is two weeks old: the agent's training and most of the
  web describe 2.x. Each rename cost one lookup, not a dead end.
