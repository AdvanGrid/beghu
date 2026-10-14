# Leptos: benchmark record

The candidate for [Benchmark: Leptos](https://github.com/tomsjansons/beghu/issues/19).
Throwaway: it exists to be measured and felt, not to start the real app.

```sh
./bench/run leptos                       # headline cell
./bench/run leptos --profile all --net all --scale all
```

**Stack:** Leptos 0.8.22 (SSR + hydration, out-of-order streaming), `leptos_axum` 0.8.10 on
axum 0.8, built by `cargo-leptos` 0.3.11 into one server binary plus a WASM client. SQLite through
rusqlite 0.40 + r2d2. Plain CSS (light and dark through `prefers-color-scheme`).

- `src/api.rs`: types shared by server and client, and the server functions the UI calls
  (`list_issues`, `get_facets`, `get_detail`, `add_label`). One Rust struct on both sides, no
  generated bindings.
- `src/db.rs` (server only): the SQLite mirror, webhook application, and a
  `tokio::sync::broadcast` channel of changed issue ids.
- `src/app.rs`: the UI. The list is one `Resource` per 100-row page, keyed on the filter and a
  live tick, rendered with `<For>`. The detail is a nested route (`/issues/:id`). Live updates are
  an `EventSource` on `/events` that bumps the tick. The optimistic write is a `ServerAction` plus
  a pending-label overlay.
- `src/main.rs`: axum routes for `/healthz`, `/webhook`, `/events`, plus the Leptos routes.

Local dev:

```sh
rustup target add wasm32-unknown-unknown
# cargo-leptos 0.3.11 from https://github.com/leptos-rs/cargo-leptos/releases
cp ../../data/mirror-20k.db /tmp/mirror.db
MIRROR_PATH=/tmp/mirror.db cargo leptos watch     # http://127.0.0.1:3000
```

## Data path

Everything goes through server functions, as the Leptos book leads you; there is no hand-written
JSON API.

| Concern | Idiomatic pass | Optimised pass |
|---|---|---|
| First paint | SSR of the first 100 rows, streamed, hydrated | Same |
| Filter and search | Filter in a signal; one `Resource` keyed on (filter, limit, tick) refetches | Same, and the label and assignee SQL use `IN (subquery)` |
| More rows | Scroll near the bottom raises the limit; the one `Resource` refetches every loaded row | One `Resource` per 100-row page (`LIMIT/OFFSET`); earlier pages stay put |
| Detail | Nested route, `Resource` on the id param | Same |
| Live updates | `EventSource` bumps a tick signal; list resources and the open detail refetch | Same |
| Write | `ServerAction<AddLabel>`, pending labels shown until the server confirms | Same |
| Assets | `cargo leptos build --release` | `--precompress`: `leptos_axum` serves the brotli copies |

## Numbers

Full matrix, 20 iterations per scenario, `--cpus=1 --memory=512m`, under the host-wide bench lock.
Raw output (gitignored, on the bench host): `bench/results/2026-10-14-120637-leptos/` (default,
commit ae6cb6b) and `bench/results/2026-10-14-171917-leptos/` (optimised, this directory).

p95 in ms, **default → optimised**, ✓/✗ against the reference line. `low` = 6× CPU throttle.

| Scenario (p95 ms) | low-far-20k (headline) | low-far-50k | low-near-20k | low-near-50k | fast-far-20k | fast-far-50k | fast-near-20k | fast-near-50k |
|---|---|---|---|---|---|---|---|---|
| Cold load ≤ 3000 | 1385✓ → **1310**✓ | 1473✓ → **1358**✓ | 1261✓ → **1248**✓ | 1297✓ → **1157**✓ | 958✓ → **506**✓ | 943✓ → **509**✓ | 341✓ → **278**✓ | 262✓ → **239**✓ |
| Warm load ≤ 1000 | 1307✗ → **1276**✗ | 1329✗ → **1405**✗ | 1388✗ → **1172**✗ | 1288✗ → **1252**✗ | 274✓ → **318**✓ | 290✓ → **285**✓ | 222✓ → **208**✓ | 502✓ → **195**✓ |
| Filter and search ≤ 200 | 403✗ → **413**✗ | 709✗ → **385**✗ | 369✗ → **340**✗ | 494✗ → **332**✗ | 188✓ → **167**✓ | 345✗ → **169**✓ | 167✓ → **119**✓ | 835✗ → **112**✓ |
| Scroll frames ≤ 33, no task > 100 | 83✗ → **83**✗ | 83✗ → **83**✗ | 100✗ → **83**✗ | 83✗ → **83**✗ | 33.3✗ → **16.8**✓ | 33.3✗ → **16.7**✓ | 83✗ → **16.8**✓ | 67✗ → **16.7**✓ |
| Open detail ≤ 300 | 370✗ → **311**✗ | 428✗ → **328**✗ | 323✗ → **307**✗ | 330✗ → **301**✗ | 155✓ → **145**✓ | 157✓ → **147**✓ | 59✓ → **243**✓ | 58✓ → **54**✓ |
| Live update ≤ 2000 | 300✓ → **279**✓ | 286✓ → **244**✓ | 225✓ → **158**✓ | 254✓ → **176**✓ | 182✓ → **155**✓ | 171✓ → **159**✓ | 64✓ → **51**✓ | 113✓ → **52**✓ |
| Optimistic write ≤ 100 | 79✓ → **74**✓ | 81✓ → **75**✓ | 89✓ → **68**✓ | 96✓ → **73**✓ | 11.3✓ → **12**✓ | 19.8✓ → **11.5**✓ | 14.3✓ → **12.6**✓ | 14.7✓ → **11.6**✓ |

Headline cell (low-far-20k) p50, default → optimised: cold 1288 → 1194, warm 1225 → 1179,
filter 308 → 311, detail 304 → 283, live 253 → 238, write 58 → 59 ms. Row 500 reached in
7.3 → 4.3 s, with 202 → 108 long tasks over 100 ms and the longest 983 → 273 ms.

Notes on reading it:

- **Every fast-profile line passes once optimised.** The default missed filter at 50k (SQL tails)
  and scroll (long tasks from re-rendering the whole list).
- **Scale matters only for the default's filter.** The correlated `EXISTS` filters read seconds
  of cold pages at 50k (assignee and state p95 up to 4 s). After O1, 20k and 50k agree within noise.
- **Filter on `low` is the round trip plus a render.** p50 sits at 230–310 ms. The far network is
  ~110 ms of it, the rest is diffing and creating up to 100 rows in WASM at 6× CPU. The search
  filter is the slowest (p95 330–430 ms): one request per keystroke.
- **The fast-near-20k detail p95 (243 ms)** is one slow iteration; p50 is 44 ms.
- **Bundle.** WASM 695 KB raw, 273 KB gzip, 217 KB brotli (what the optimised build sends). JS
  glue 24 KB decoded, 6.1 KB on the wire. Server RSS stays under 27 MB in every cell.
- **The WASM/JS bridge is cheap.** A CPU profile of a warm load at 6× (1.88 s with the profiler
  on) put ~50 ms in wasm-to-js and js-to-wasm calls. Native parse, style, layout and WASM compile
  took 57%, and hydration inside WASM 23%.

## Change log (optimisation pass)

Each change measured on the headline cell with the harness (`--profile low --net far`), cumulative,
p95 ms. Raw output in `bench/results/2026-10-14-1{54148,55805,60637,61430}-leptos-o*`. Run to run,
the headline cell moves by ±40 ms on cold, warm and filter, so read single steps with that in mind.

| # | Change | Target | Cold | Warm | Filter | Detail | Scroll: >100 ms tasks, max, row 500 | Kind | Kept |
|---|---|---|---|---|---|---|---|---|---|
| — | default | | 1385 | 1307 | 403 | 370 | 202, 983 ms, 7.3 s | | |
| O1 | Label and assignee filters as `IN (subquery)` instead of correlated `EXISTS`; exit on SIGTERM | filter | 1350 | 1309 | 308 | 326 | 136, 194 ms, 4.4 s | plain SQL | yes |
| O2 | One `Resource` per 100-row page (`LIMIT/OFFSET`) instead of one growing `Resource` | scroll | 1525 | 1362 | 337 | 386 | 150, 178 ms, 4.5 s | documented (resources, `<For>`) | yes |
| O3 | `cargo leptos build --precompress` | cold, warm | 1211 | 1200 | 334 | 342 | 128, 187 ms, 4.4 s | documented feature | yes |
| O4 | `content-visibility: auto` on rows | scroll | 1236 | 1349 | 387 | 298 | 151, 287 ms, 6.1 s (worse) | plain CSS | reverted |
| O5 | 50-row pages | scroll, warm | local traces only: no gain | | | | | plain tuning | reverted |

- **O1** is the big one. With a cold page cache SQLite probed the label and assignee tables once
  per scanned row; at 50k one assignee filter took 5.7 s in isolation. The `IN` form builds the id
  set once (with a bloom filter): 88 ms at 50k, 7 ms at 20k. The SIGTERM exit is a harness
  hygiene fix: open SSE streams kept axum's graceful shutdown waiting forever.
- **O1's scroll gain** surprised me: the scenario doesn't filter. The likely cause is the same SQL
  tails stalling earlier iterations' refetches (each live tick refetched every resource), but I
  haven't confirmed it.
- **O2** cut the longest scroll task from ~430 to ~150 ms in local Playwright traces. In the
  harness it is level with O1, within noise.
- **O3** shrinks the JS glue 24 → 6 KB and the WASM 695 → 217 KB on the wire.
- **O4** made scrolling worse: rows skipped by `content-visibility` get laid out as they scroll in,
  which lengthens the append tasks. SvelteKit saw the same.
- Nothing fought the framework. Every kept change is plain SQL, a documented Leptos pattern or a
  documented cargo-leptos flag.

## Where the time goes, and what it would take

Optimised build, against the lines it still misses, all on `low` (6× CPU).

- **Warm load, p95 1172–1405 ms against 1000.** p50 is 1060–1200 ms. The profile splits it into
  the browser's own parse, style, layout and WASM compile (~57%) and hydration in WASM (~23%).
  Hydration has to walk all 100 SSR rows and attach their reactive graph before
  `data-bench-ready`. *Plausible fix:* Leptos islands (`#[island]`), so the list ships as static
  HTML and only the filter bar and detail panel hydrate, with row clicks going through the router's
  anchor handling. A smaller first page (25 rows) also cuts the hydrate walk. *Rough cost:* islands
  is a 1–2 day restructure: islands can't share signals through context, so the filter state, the
  live tick and the list would need to sit in one island or talk through the URL.
- **Filter, p95 332–413 ms against 200.** About 110 ms is the far round trip. The rest is
  creating up to 100 rows (each row's labels are a nested view) and the server function's
  serialisation. *Plausible fix:* a first page of 25–40 rows after a filter change, and debounce
  search so one keystroke doesn't queue behind the last. *Rough cost:* half a day; it shaves the
  render, not the round trip. Getting under 200 ms on `low-far` needs results on the client before
  the request returns, which is the sync-engine territory this benchmark rules out.
- **Scroll, ~100 long tasks over 100 ms per run (max 240–280 ms).** Each 100-row append is one
  task: `<For>` creating 100 rows with their label chips. *Plausible fix:* a windowed list, so
  only ~40 rows exist in the DOM. There is no first-party virtual list; `leptos-use` and the
  community `leptos_virtual_scroller` exist but would need checking against 0.8. Or hand-roll one
  (a spacer plus a slice signal), about 80 lines. *Rough cost:* about a day, plus checking that the
  harness's row-500 probe and `data-bench` hooks survive windowing.
- **Open detail, p95 301–328 ms against 300.** p50 is 260–283 ms: one far round trip, a server
  function, then rendering body and comments. *Plausible fix:* render the row's data (title,
  labels) into the panel instantly from the list, and prefetch the detail on `pointerdown`. That
  starts the request ~80–100 ms before the click lands. *Rough cost:* half a day. It is small, but
  it fits inside 300 ms.

## DX checklist

- **Agent-friendliness.** Good. 0.8's API (`Resource`, `Suspend`, `ServerAction`,
  `Effect::watch`, `ParentRoute`/`Outlet`, `#[server(input = Json)]`) was written from memory and
  compiled first time apart from move errors inside `view!`. Those errors point into `tachys`'
  generated types and the macro's evaluation order (a value moved into an attribute and then used
  as text), so they take a minute to read. The fix is always a clone before the `view!`. The book
  and `docs.rs` agree with the code; the 0.6 → 0.7 rewrite is the main source of stale snippets on
  the web.
- **End-to-end type safety.** Full: server functions are plain Rust signatures over shared
  structs, so a field rename breaks the client and the server in the same `cargo check`. No
  codegen, no casts. The only untyped seam is the hand-rolled SSE payload (a JSON id array parsed
  by hand), and that's this app's choice, not the framework's.
- **Dev loop.** Slow, as Rust is. Cold debug build (server + WASM) 3 min 12 s on this 32-thread
  host. An edit to `app.rs` rebuilds both sides in ~48 s. Docker release build (LTO,
  `opt-level = "z"`) 4 min 04 s cold. `cargo leptos watch` reloads the page after the rebuild;
  hot-reload of `view!` markup exists but only covers markup edits. Compile errors are readable
  outside `view!`; inside it they surface as trait-bound failures on `tachys` render types.
- **Maturity and churn.** Leptos 0.7 shipped 2024-11-30 (a rewrite of the reactive and render
  layers), 0.8 on 2025-05-01, 0.9 in beta now. 30 stable releases in 2 years. Pre-1.0, so every
  minor is breaking. 689 commits in the last 12 months; two people (GitHub `gbj` 255, `sabify`
  242) wrote about 72% of them, so the bus factor is about 2. 21.4k stars.
- **Lines of code after optimisation.** 715 lines of Rust across `src/` (`app.rs` 327, `db.rs`
  224 of which most is the webhook/mirror SQL every candidate needs), plus 39 lines of CSS, an
  18-line Dockerfile and a 56-line `Cargo.toml`. The idiomatic pass was 697 lines of Rust.

## Friction worth weighing

- **Hydration sets the floor under warm load.** Same story as SvelteKit and SolidStart, plus a
  695 KB WASM module the browser has to compile. Islands are the documented escape, at the cost of
  restructuring state.
- **The bridge is not the problem.** For this app, JS ↔ WASM calls were ~3% of a warm load. The
  cost of WASM is compile time and module size, not the boundary.
- **One growing `Resource` is the obvious list and the slow one.** Raising a limit refetches and
  re-diffs every loaded row. Per-page resources fix it and are still idiomatic, but the book
  doesn't show that pattern.
- **Rust's compile times are the dev loop.** ~48 s from save to reload is long next to a JS
  framework's sub-second HMR, and an agent iterating on UI pays it every time.
- **No list virtualisation in the box,** as with every candidate so far.
