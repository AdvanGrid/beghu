# Proa candidate: feasibility, build log, results

For [Frontend benchmark: Proa](https://github.com/tomsjansons/beghu/issues/48). Throwaway.
Proa 0.1.3 CLI (`proa_core` / `proa_macros` / `proa_framework_axum` 0.3.0, `rsjs` 0.2.0), all
first published on crates.io on 2026-10-12. Source read at `proa-labs/proa@984d588`.

## 1. Feasibility (step 1 of the ticket)

Checked against the docs (`/llms-full.txt`), the `rsjs` source and a compiled probe
([probe/](probe/)), driven in Chromium.

| Question | Answer | Escape hatch and its cost |
|---|---|---|
| Can an island host the hybrid's worker cache, or talk to one in plain TS? | **No / one-way.** Web Workers, `EventSource`, `WebSocket`, IndexedDB and raw `fetch` are outside the analyzed RSJS surface ("keep the capability in application-owned JavaScript"). An island can send to app JS (`rsjs::document::dispatch_event_with_detail`), but nothing comes back: `on_document_*` takes only `click`, `pointerdown` and `keydown`, `on_window_storage` fires only in other tabs, and `KNOWN_LIMITATIONS.md` says an external coordinator "cannot subscribe to … signals and often has to observe DOM state instead". The one inbound path that worked: app JS sets a hidden `<input>`'s value and dispatches `input`, which an island's `on_input` reads as a **string**. | The worker, sync, IndexedDB, Web Locks and `BroadcastChannel` stay in hand-written TS (the baseline's `worker.ts` / `cache.ts`, about 670 lines). |
| Can an island render the list from that data? | **No.** A keyed `{for}` renders from a `signal(Vec<T>)` that only handlers can set, and only from values RSJS can build (no JSON decode of a string). A mutation's response can't be iterated (`{for row in search.data()}` fails with "cannot find value `search`"), queries fetch a **static** URL (`FetchRequest.url: &'static str`, no body or params from the key), and neither has an on-success hook. Handlers inside keyed rows are rejected in v0.1; delegation (`closest_attr("data-id")` on the container) works. | The list body, windowing and every live re-render become hand-written DOM code. Proa's own flagship example does exactly this: ORIGIN's 100k-row table and live feed are in `origin.js` (22 KB), with islands that only dispatch `origin:flood` / `origin:filter` events. |
| Can it take live updates? | Not in an island (no `EventSource`). The typed surface offers polling (`QueryOptions.interval_ms`) of one static URL, which can't feed a list. | App JS (`EventSource`), or, without app JS, Turbo Streams (`<turbo-stream-source>` + `refresh`), which re-fetch and morph the whole page. |
| Keep list scroll and filter state across a detail view without a full load? | Not in Proa: no client router ("there is no `<Link>` component or client router"). The docs point to **Turbo Drive**, which swaps `<body>` per visit and tears down islands; filter state goes in the URL. | Turbo Drive (+37 KB brotli). Back restores Turbo's cached snapshot. |
| Bundle size | The RSJS runtime is 186 KB (39 KB brotli) plus 87 KB (19 KB brotli) for queries/mutations, before any island. The probe page shipped 279 KB of JS, uncompressed by default. | The Solid 2 app ships 24.7 KB in total. |

**So the hybrid can't be built in Proa.** Proa would supply SSR first paint and a few buttons, and
everything that makes the hybrid fast would be the same hand-written TS plus a new vanilla DOM
renderer. ts-rs and the page↔worker protocol stay, and the runtime adds roughly 60 KB brotli. The
owner chose (2026-10-19) to measure only the **pure-Proa** build the docs lead to, on the 8 plain
scenarios. The sync scenarios are out of reach without app JS.

## 2. What was built (pure Proa)

`app/`: the axum + Solid candidate's SQL and webhook code (ported to axum 0.7, which Proa pins),
behind Proa SSR pages. No hand-written application JavaScript:

- **List** (`/`): SSR, 50 rows. Filters are `<a>` links carrying the view in the query string;
  Turbo Drive turns a click into a fetch + body swap.
- **Search**: an RSJS island whose `on_input` calls `form.request_submit()` on a GET form; Turbo
  makes it a visit. The form sits in a `data-turbo-permanent` wrapper so focus, caret and text
  survive each body swap; the current filters ride along as hidden inputs (`form="search-form"`)
  in the swapped body.
- **Paging**: a lazy `<turbo-frame loading="lazy">` after row 50 loads the next 50, and so on.
- **Detail** (`/issues/:id`): its own SSR page with the body and every comment.
- **Live**: `<turbo-stream-source src="/stream">` (SSE). Each change sends
  `<turbo-stream action="refresh">`; Turbo re-fetches the current URL and morphs.
- **Write**: an async RSJS island on the detail page. The chip is a signal (shown at once), and a
  `mutation` posts `"<id>\t<label>"`, since a mutation's URL is static.
- `public/bench.js` (6 lines) is harness glue only: it sets `data-bench-ready` on `turbo:load`
  (and, for `o6`, `turbo:frame-load`).

## 3. Results

Runs on 2026-10-19, 20 iterations per scenario, all 8 cells, holding the bench lock, against a
**same-day** full matrix of `axum-solid2` (`results/2026-10-19-084230-axum-solid2`). Proa idiomatic:
`results/2026-10-19-072728-proa`; optimised (`proa:o6`): `results/2026-10-19-105247-proa-o6`
(videos on the low profile). Every cell, p50 / p95: [matrix.md](matrix.md).

**Headline cell (6× CPU, far network, 20k), p50 / p95 ms:**

| | Proa idiomatic | Proa optimised | axum + Solid 2 | Reference |
|---|---|---|---|---|
| cold | 790 / 952 | 848 / 981 | 794 / 860 | ≤ 3000 |
| warm | 800 / 855 | 908 / 1019 ✗ | 674 / 746 | ≤ 1000 |
| filter | 433 / 619 ✗ | 330 / 437 ✗ | 182 / 215 ✗ | ≤ 200 |
| early | 455 / 632 ✗, 7 errors | 347 / 455 ✗, 6 errors | 182 / 217 ✗ | ≤ 200 |
| scroll frames p95, long tasks > 100 ms | 50, 198 | 50, 200 | 50, 0 | ≤ 33, none |
| detail | 437 / 501 ✗ | 449 / 492 ✗ | 277 / 292 | ≤ 300 |
| live | 495 / 529 | 590 / 630 | 169 / 182 | ≤ 2000 |
| write (optimistic) | 59 / 75 | 54 / 70 | 48 / 58 | ≤ 100 |
| JS on a cold load (wire / decoded) | 98 / 385 KB, 5 files | 124 / 475 KB, 8 files | 24 / 69 KB, 1 file | |
| tab PSS, cold / peak | 92 / 237 MB | 92 / 232 MB | 93 / 251 MB | ~300 |
| server CPU during filter, mean / peak | 1.3 / 20% | 1.6 / 14% | 2.7 / 24% | |

- **On the fast device it passes everything** except `early` on the far network, in both builds.
  Idiomatic `write` errors (19 of 20 at fast-far-20k) are gone in the optimised build. The axum +
  Solid 2 build is still ahead in every interactive cell: filter 61 vs 39 ms p50 (fast-near), and
  live 228–319 vs 54–124 ms.
- **On the low device, every interaction costs a page render.** Filter is 1.8–2.6× slower than
  Solid 2 even after optimising (p50 across the four low cells); detail 1.6–1.9×; live 3.4–4.7×. Loads are level (SSR first paint
  matches the SPA's).
- **Scroll** hits about 10 long tasks over 100 ms per iteration (max 230–320 ms): each lazy 50-row
  frame lands as one HTML parse + insert. Reaching row 500 takes 5.0 s against Solid's 2.6 s.
- **Server CPU is no higher than the SPA's** at one user: rendering 50 rows of HTML costs about
  what serialising them to JSON does. Not measured under several users (`./bench/load` speaks the
  JSON API).
- **Errors:** `early` fails on the far network because chip links are rendered with the old `q`
  while a search visit is in flight; the harness clears the search and clicks a label within that
  window, and gets the wrong rows. A real bug in the design, not a harness artefact (see 5).

## 4. Optimisation pass (one session)

Measured on the headline cell, 20 iterations, unless noted. Each step is a `BENCH_VARIANT` of one
image (`app/src/opts.rs`); `o1`–`o3` are cumulative, `o4`–`o6` each build on `o1`.

| # | Change | Target | Before → after (p50 / p95) | Documented or fought |
|---|---|---|---|---|
| o1 | `<link rel=modulepreload>` for every island's runtime and modules on every page, from `rsjs::manifest().page_runtime_plan(...)` | `write`, `early` errors: a click before the detail's island hydrated was lost | fast-far-20k write: 19 errors → 0; headline unchanged (write 59 / 75 → 57 / 63). Cold +100 ms (8 files, 124 KB) | Documented API (runtime plan, preload URLs) |
| o2 | `turbo-cache-control: no-cache` (no snapshot before each visit) | filter, detail | no change (filter 443 → 454, detail 422 → 426) | Documented (Turbo) |
| o3 | 25-row pages, `content-visibility: auto` on rows | filter, scroll | filter 443 / 651 → 354 / 575; detail **worse** 422 → 488; scroll long tasks 200 → 307 | Plain CSS; dropped |
| o4 | Filter links and the search form as `advance` visits. A CPU profile showed that `replace` visits to `/` count as **page refreshes**, and `turbo-refresh-method: morph` (needed for live) then morphs the whole body (idiomorph, ~360 ms at 6×, 100 ms of it per-node `CustomEvent`s) | filter | render step 360 → 41 ms natively, but **search broke**: a body swap moves the `data-turbo-permanent` search box, which blurs it and resets the island's value | Fought: Turbo's refresh semantics vs RSJS |
| o5 | `o4` + `autofocus` on the search input | search under `o4` | focus came back, typed text didn't (the moved island re-activates) | Fought; dropped |
| **o6** | `o1` + a `<turbo-frame id=view data-turbo-action=advance>` around the filters and the list; the search form outside it, targeting the frame; rows `data-turbo-frame=_top` | filter | **filter 433 / 619 → 338 / 429; early 455 / 632 → 326 / 388.** Detail 422 → 485, live 531 → 603 (worse) | Documented Turbo pattern; no Proa feature |

`o6` is the "optimised" build in section 3. The remaining filter time at 6× is the round trip
(100 ms), the server (~25 ms of SQL for a label filter), then Turbo parsing the whole page and
replacing the frame, with three `requestAnimationFrame` waits in its frame renderer.

**Where the rest goes, and plausible fixes (not done):**

- **Filter / detail at 6×:** every interaction is a fetch plus an HTML parse and DOM replace. A
  frame-only response (render just the frame when `Turbo-Frame: view` is sent) would cut parse
  work; the floor is still one round trip per keystroke. Rough cost: half a day. Getting under
  200 ms on the far network needs answers that don't round-trip, which is the worker cache Proa
  can't host.
- **Live (500–600 ms):** a `refresh` re-fetches and morphs the whole page. Broadcasting a
  `<turbo-stream action=replace target=row-<id>>` per changed row would be about 150 ms, but can't
  move a row or know which open views it belongs to. Half a day, and it loses correctness.
- **Scroll long tasks:** each lazy frame is one big insert. Windowing needs client code that
  RSJS can't express (keyed lists only re-render from signals set in handlers).
- **Stale links during a search visit** (`early` errors): make chips submit buttons of the search
  form (`<button form=search-form name=toggle value=label:bug>`) and toggle server-side with a
  redirect. Correct by construction, at one extra round trip per click.

## 5. What it forces on the design

- **The hybrid doesn't survive in Proa.** Worker cache, IndexedDB, leader tab and the sync SSE
  stream can't live in RSJS; keeping them means the same hand-written TS as now plus a vanilla DOM
  renderer for the list, with Proa reduced to SSR first paint and buttons. That's more code than
  the Solid version, not less.
- **ts-rs and the page↔worker protocol** go away only in the pure-Proa build, because there is no
  client data layer at all. With the hybrid they stay.
- **Navigation** is server-routed: every filter, search keystroke and detail view is a request
  and an HTML render. Turbo Drive keeps the JS context alive and swaps the body (or a frame);
  Turbo's snapshot gives back the list on Back. Scroll and filter state live in the URL.
- **Live updates** are page refreshes, not row patches.
- **Turbo becomes a second framework** with its own semantics (refresh vs visit, permanent
  elements, frames) that the islands have to fit into; most of the optimisation pass was spent
  there.

## 6. DX checklist

- **Agent-friendliness:** `/llms-full.txt` is complete (785 KB) and accurate about RSJS's
  boundaries (the Browser APIs page says up front what is out of reach). Stale against crates.io:
  `rsjs_assets_router` and `BasePath` are documented and used in the ORIGIN example but missing
  from the published `proa_framework_axum` 0.3.0. Undocumented: how a mutation's data can be
  rendered (it can't be iterated), that query URLs can't depend on the key, that conditionals in
  repeated regions render both branches.
- **End-to-end types:** Rust → template → island is fully typed; server values cross into an
  island as typed props or signal seeds, and the label write's payload is a typed `String`. The
  limits are the RSJS subset (no `.clone()`, no struct literals of server types in handlers), and
  `FetchRequest` URLs being static pushed one payload into an `"<id>\t<label>"` string. No types
  cross into Turbo: links and form names are strings.
- **Dev loop:** `proa run` / `proa dev` rebuild through the linked pipeline, compiling the crate
  twice. First dev build ~1 m 45 s, an edit-to-run rebuild ~70 s (niced, 4 jobs, while a
  benchmark ran), a release build 6 m 07 s. The image takes ~15 minutes the first time (it builds
  `proa-cli`). Errors: good for unsupported events and methods (each lists the supported set);
  poor for a `{for}` over mutation data ("cannot find value `search`" at the attribute), a
  `{for}` body rooted in `{if}` (a macro panic, "payload_attr requires an Element node"), and
  `WebRender` + `WebRenderSync` in one module (every `.render` ambiguous).
- **Maturity and churn:** CLI 0.1.3; framework crates 0.3.0 and `rsjs` 0.2.0, all first on
  crates.io on 2026-10-12 (a week ago), under 200 downloads each. Repo created 2026-09-12, 201
  stars, **one contributor** (bus factor 1), CLI 0.1.1 → 0.1.3 in two days on crates.io. Apache-2.0 (the
  crates.io metadata says "non-standard"). `rsjs/KNOWN_LIMITATIONS.md` calls itself v0.1.
- **Lines of code:** 997 lines of Rust (324 of it the ported SQL and webhooks) plus 6 lines of
  bench glue and 33 of CSS, against 849 for axum + Solid 2 (482 Rust, ~370 TS/TSX/CSS). Plus
  Turbo, vendored (8.0.23).

## 7. Build log notes

- **Conditionals in repeated regions render both branches** and hide the false one with
  `display:none`, so "is the chip there" checks saw every chip. Worked around with a reactive
  `data-bench` attribute.
- **Async templates can't borrow locals:** anything iterated inside `html!` has to be owned, so
  the list moved to sync components wrapped in `to_async`.
- The tutorial's hand-written rsjs asset router (30 lines) replaces the missing
  `rsjs_assets_router`; it serves `public, no-cache` plus an ETag, as "Page caching" asks for
  unhashed URLs. Compression is `tower-http` outside it, as the docs say.
