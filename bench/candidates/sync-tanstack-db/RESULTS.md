# Sync: TanStack DB — passes, change log and results

Run on 2026-10-18 for
[Sync benchmark: TanStack DB](https://github.com/tomsjansons/beghu/issues/23). The candidate is
described in [README.md](README.md), the idiomatic pass in
[../sync-tanstack-db-idiomatic](../sync-tanstack-db-idiomatic). The server is the hand-rolled
baseline's, byte for byte apart from its banner, so this compares the browser side only. The
on-demand and progressive variants add two small things to it; see
[Sync modes](#sync-modes-on-demand-and-progressive). The
reference is the baseline's optimised pass ([../sync-baseline/RESULTS.md](../sync-baseline/RESULTS.md),
`results/…-112519-sync-opt`). The host was loaded by unrelated work, as it was for the baseline.

Results directories:

- **Optimised.** Fast cells: `results/2026-10-18-111109-sync-tanstack-db`, 10 iterations. Low cells:
  `results/2026-10-18-133534-sync-tanstack-db`, 10 iterations.
  - The low cells in `…-111109` are **invalid**. The worker CPU throttle nested: a live query built
    inside a sync transaction was charged twice, about 36× in all. It is fixed in `db.ts`
    (`throttled` spins only in the outermost call), and the low cells were re-run.
  - The idiomatic pass never nests the throttle, so its numbers stand.
- **Idiomatic `persisted`.**
  - Fast cells and part of low-near-20k: `…-083409-…-idiomatic-persisted`, 3 iterations. This run was
    cut off at the session's 2 h limit.
  - Headline cell low-far-20k: `…-130612-…`, 5 iterations.
  - `tabs` on fast-near-20k: `…-133123-…`.
- **Not to be cited.** `…-083042`, `…-103436`, `…-104840`, `…-105518` and `…-105703` are
  intermediate builds and spot checks.

## Passes

**Idiomatic pass** ([../sync-tanstack-db-idiomatic](../sync-tanstack-db-idiomatic), variant
`persisted`) is TanStack DB as its docs present it:

- **One collection** whose own sync config runs the baseline's wire. It loads the stored snapshot,
  then `/api/sync` deltas, and keeps the cursor in sync metadata.
- **Persistence** is TanStack's SQLite persistence (`@tanstack/browser-db-sqlite-persistence`
  0.2, wa-sqlite on OPFS), with its `BrowserCollectionCoordinator` for tabs.
- **Writes** go through `onUpdate`, which waits for the write's `seq`.
- **One sorted live query per view**, without a limit.

It failed most of the sync scenarios:

- **First full snapshot stored: 62–70 s at 20k.** At 50k it never finished within the harness's
  120 s, so `cold` and `storage` errored in every 50k cell.
  - Hydrating 20k rows means 20k SQLite row writes through the persistence adapter on OPFS.
  - The OPFS database is 19.7 MB, against 872 KB of compressed responses in the baseline's IndexedDB.
- **`write` failed in every cell but one.** The optimistic label showed, but the `POST` was never
  sent within 30 s.
  - With a sync config present, the persistence wrapper passes `onUpdate` through, and core
    `Transaction.commit` calls it directly. Why the handler's request never left wasn't found in
    the session.
  - The one exception was low-near-20k, where it worked: 33 / 49 ms, round trip 5.3 s.
- **`reconnect` failed in every cell.** The edit made during the outage never showed within 30 s.
  Not root-caused either.
- **`tabs` failed.** The second tab's cache never became ready within 60 s; it never got the OPFS
  database.
- **What worked:** first paint (the hybrid's server render), `live`, and `rollback`.
  - `live`: 44–164 ms p50.
  - `rollback`: the chip shows in one frame and goes again 0.44–2.1 s after the click.
  - `cold` and `warm` are the hybrid's server paint and didn't move.

The non-persisted variant (`./bench/run sync-tanstack-db-idiomatic`) is the same without a
persistence layer. It is the starting point of change 1.

**Optimisation pass** (this directory): one session, three changes. "Fighting" means working
around the library rather than using a documented feature of it.

| # | Change | Target | Kind | Before → after |
|---|---|---|---|---|
| 1 | Drop TanStack's persistence and tab coordinator. Keep the baseline's IndexedDB records (raw responses, compaction), its Web Lock leader and its `BroadcastChannel` followers. The collection's sync config only hands out its `begin` / `write` / `commit` sink, which the worker drives | `cold`, `storage`, `write`, `reconnect`, `tabs` | **Fighting the library.** TanStack DB is reduced to an in-memory query engine plus optimistic transactions; its sync, persistence and multi-tab story are all ours again | Snapshot stored 62–70 s → 0.58 s (fast-near-20k); 50k stores at all (1.2–2.6 s fast). Storage 19.7 MB → 872 KB. `write`, `reconnect` and `tabs` fail → pass on the fast device |
| 2 | One derived collection per state (non-PR rows) with a `BTreeIndex` on the sort key. Each page is a live query with `orderBy` + `offset` / `limit`, and the total is a separate `count` query. An LRU keeps 8 page queries and 4 counts, and a row-identity cache stops unchanged rows being re-posted | `filter`, `early`, `scroll` | Documented features | In Node at 1×, 20k rows: a view went from 50–550 ms (sorted, unlimited) to 4–25 ms for a warm page. A view's first build still costs state collection 210–300, index 47–108, first page 130–224 and count 99–169 ms. In the harness, early local answers didn't clearly improve, because the builds compete with the rest of the worker's work |
| 3 | Post the count as its own `counted` message instead of re-asking for the list. Build the default view (open, first 100) before saying the cache is ready, then the closed state in the background | `scroll` correctness, `tabs` | Documented features; message shape is ours | Fixed a bug: a late count re-query overwrote rows `loadMore` had appended, so scrolling stopped at row 400. A follower's first state switch went from 483 to 56 ms in a hand probe. The harness's `tabs` follower didn't improve (fast-near-20k 527 → 562 ms), because the background builds run right after ready |

Correctness after each change, against a native server:

- `smoke.mjs`: two tabs, hand-off, optimistic write, rollback.
- `smoke-compact.mjs 500`: a returning tab after 500 webhooks.
- `scroll-probe.mjs`, `follow-probe.mjs` and `reconnect-probe.mjs --cpu 6`: probes for the bugs above.

One more fix in the shared harness:

- An unhandled `waitForResponse` rejection in `write` and `rollback` crashed the whole run when
  an iteration timed out. It now fails only that iteration (`harness/scenarios.mjs`).

## Browser results

p50 / p95 ms, far network (100 ms RTT, 10 Mbps down), the headline row group. "Baseline" is the
hand-rolled baseline's optimised pass, on the same server. ✗ marks a miss against the target.

### Low device (6× CPU, worker throttled to match)

| | 20k baseline | 20k TanStack idiomatic | 20k TanStack optimised | 50k baseline | 50k TanStack optimised |
|---|---|---|---|---|---|
| cold (first paint) | 978 / 1152 | 968 / 1151 | 917 / 1018 | 953 / 1056 | 960 / 1079 |
| first full snapshot stored (cold) | 2254 / 2615 | **69 231 / 76 574** | 3216 / 3664 | 3600 / 3780 | 7283 / 7636 |
| cache ready (cold) | 2345 / 2695 | 4946 / 5096 | 5835 / 6256 | 3665 / 3836 | 12 786 / 14 229 (early) |
| warm (first paint) | 891 / 952 | 862 / 929 | 855 / 914 | 885 / 966 | 849 / 954 |
| cache ready (warm) | 1333 / 1674 | 3977 / 4219 | 5081 / 6095 | 1946 / 2285 | 11 278 / 12 836 |
| filter, warm visit | 86 / 201 ✗ | 176 / 204 ✗ (server) | 175 / 212 ✗ (server) | 181 / 217 ✗ | 181 / 216 ✗ (server) |
| early: later local answer p95 | 221 ✗ | 3569 ✗ | 3090 ✗ | 215 ✗ | 8544 ✗ |
| scroll frame p95 | 33.4 ✗ | 33.4 ✗ | 33.4 ✗ | 33.4 ✗ | 33.4 ✗ |
| detail | 298 / 320 ✗ | 256 / 289 | 279 / 443 ✗ | 276 / 326 ✗ | 291 / 327 ✗ |
| **live** (webhook → screen) | 169 / 181 | 164 / 192 | 158 / 179 | 171 / 202 | 166 / 193 |
| write: optimistic label | 37 / 45 | ✗ POST never sent | 32 / 61 | 38 / 53 | 33 / 52 |
| write: round trip until confirmed | 427 / 445 | — | **3559 / 5063** | 427 / 459 | **10 032 / 12 665** |
| **reconnect** | 538 / 592 | ✗ never caught up | 836 / 1564 | 623 / 723 | **5135 / 8995 ✗** |
| tabs: follower sees an edit | 61 / 89 | ✗ second tab never ready | **3921 / 4685 ✗** | 70 / 95 | **10 296 / 16 531 ✗** |
| tabs: after the syncing tab closes | 151 / 169 | — | 159 / 175 | 159 / 173 | 531 / 865 |
| rollback: chip shown | 40 / 56 | 33 / 39 | 37 / 54 | 36 / 47 | 32 / 37 |
| rollback: chip gone again | 359 / 427 | 2137 / 2817 | **3293 / 4093** | 353 / 362 | **8010 / 9572** |
| storage: cache ready, next visit after 500 changes | 1248 / 1311 | 16 092 / 18 047 | 5191 / 6330 | 1703 / 1740 | 12 573 / 13 778 |
| browser storage after a first visit | 872 KB | 19.7 MB (OPFS) | 872 KB | 2056 KB | 2056 KB |
| tab PSS, cold | 94 MB | 263 MB | 157 MB | 141 MB | 259 MB |

### Fast device

| | 20k baseline | 20k TanStack idiomatic | 20k TanStack optimised | 50k baseline | 50k TanStack optimised |
|---|---|---|---|---|---|
| cold | 330 / 368 | 333 / 366 | 333 / 365 | 331 / 357 | 329 / 360 |
| first full snapshot stored (cold) | 1086 / 1116 | **64 143 / 67 270** | 1392 / 1602 | 1989 / 2037 | 2598 / 2835 |
| cache ready (warm) | — | 1608 / 1756 | 989 / 1117 | — | 1995 / 3387 |
| warm | 158 / 199 | 158 / 194 | 156 / 246 | 157 / 183 | 162 / 174 |
| filter, warm visit | 30 / 127 | 124 / 131 (server) | 127 / 420 ✗ | 37 / 132 | 123 / 129 (server) |
| live | 27 / 44 | 127 / 148 | 128 / 186 | 128 / 140 | 127 / 140 |
| write: optimistic label | 11 / 12 | ✗ | 11 / 15 | 9 / 12 | 9 / 12 |
| write: round trip until confirmed | 360 / 376 | — | 486 / 550 | 355 / 367 | 1520 / 2807 |
| **reconnect** | 526 / 534 | ✗ | 880 / 991 | 546 / 565 | 864 / 1471 |
| tabs: follower sees an edit | 24 / 31 | ✗ | 599 / 643 | 25 / 35 | 1556 / 2150 ✗ |
| rollback: chip gone again | 330 / 334 | 443 / 480 | 541 / 620 | 332 / 340 | 1248 / 1753 |
| storage: cache ready, next visit after 500 changes | 352 / 384 | 3136 / 3622 | 959 / 1075 | 441 / 460 | 1835 / 1999 |
| browser storage after 500 changes | 820–832 KB | 18.3 MB | 804 KB | 1952 KB | 1932–1944 KB |
| tab PSS, cold | 92 MB | 265 MB | 160 MB | 127 MB | 261 MB |

The idiomatic pass at fast 50k didn't store a snapshot within 120 s in any iteration.

- **"(server)" in filter means the warm visit's filter steps were answered by the server's
  hybrid path, not the cache.** The cache wasn't ready yet: in TanStack's case it was still
  building the collections.

**What the low device shows:** everything that waits on the worker waits for TanStack DB to
build its collections.

- **Every visit, every tab, builds them from scratch.** It fills the collection (20k or 50k sync
  writes), then the default view's state collection, its BTree index, its first page and its
  count.
  - In Node at 1×, one state's derived collection, index, page and count cost 0.5–0.8 s on top of
    filling the base collection. At 6× that is the 5–6 s (20k) and 11–13 s (50k) of "cache ready"
    above.
  - The baseline's sorted array is ready in 1.3–2.0 s.
- **The `write` round trip, `rollback` chip-gone, `reconnect` and `tabs` misses are inferred to be
  that queue, not the network.**
  - The optimistic label still shows in one frame (it's a synchronous `collection.update`).
  - The server's confirmation, the failure that rolls the chip back, the reconnect's catch-up and
    a follower's first answer all wait behind the builds.
  - This is an inference, not a profile. It fits the fast device's numbers moving the same way, at
    about a sixth of the size: 486 ms vs 360 ms, and 1.5 s vs 0.36 s at 50k.

**Live updates** are as fast as the baseline's once the cache is up. Applying a one-row delta to
the collection, and letting the live page query re-run, takes 158–166 ms p50 on the low device's
far link, against 169–171 ms.

### Through a real shaped link (`./bench/shape`)

These runs used `./bench/serve sync-tanstack-db --rtt 100 --port 8180` (which also checks that
`./bench/serve` starts this candidate), driven by `shaped-live.mjs`:

- 20 title edits, each webhook POSTed straight to the server;
- two tabs, measured from the POST to the frame that shows the title.

| | syncing tab p50 / p95 / max | other tab p50 / p95 / max |
|---|---|---|
| 1× CPU | 92 / 229 / 244 | 77 / 227 / 672 |
| 6× CPU | 146 / 714 / 797 | 102 / 310 / 4584 |

- **Same shape as the baseline's** (1× 93 / 698, 6× 145 / 195 in the syncing tab), except one
  4.6 s follower outlier at 6×. That was most likely the follower's background closed-state build,
  which ran right after it said it was ready.
- **The first 1× attempt timed out** waiting for the first tab's cache, at 60 s. That was the
  first visit through the link after the server started. A second attempt passed, and it wasn't
  chased.

## Sync modes: on-demand and progressive

Everything above is TanStack DB's default **eager** mode: every row is in the collection before a
query runs. TanStack DB 0.15 core also has `syncMode: 'on-demand'`, and Electric's adapter
describes a third, **progressive**. Both were run over the full matrix, as variants of the
optimised candidate. [README.md](README.md#sync-modes) describes how each is built.

- **On-demand.** Each live query asks the collection's `loadSubset` for the rows it needs. The
  worker fetches them from `/api/issues`, the server's existing filtered list. Totals come from the
  server, and the sync stream still applies changes. Nothing is stored in the browser.
- **Progressive.** On-demand while the full copy loads in the background, in 1,000-row chunks,
  outside the sync queue. Once the copy is complete, queries take eager's per-state route and the
  copy is stored in IndexedDB as in eager mode. Progressive isn't in TanStack DB core; it is built
  here on top of on-demand.

Results directories:

- **On-demand:** `results/2026-10-18-172202-sync-tanstack-db-on-demand`.
- **Progressive:** `results/2026-10-18-182201-sync-tanstack-db-progressive`.
- **Both at 10 iterations, all cells, all scenarios plus `sync`.**
- **`write` was re-run on the far cells after a fix:** `…-201635-sync-tanstack-db-on-demand` and
  `…-201824-sync-tanstack-db-progressive`. The `write` rows below are from these re-runs.
  - **The bug:** in the full runs, 8 of 20 far-network `write` iterations sent no POST in
    on-demand, and 15 of 20 in progressive. The harness opens the detail and clicks a label before
    the worker has loaded that row (the page is server-rendered), and `addLabel` refused with
    "not in the cache".
  - **The fix:** the worker now fetches a missing row from `/api/issues/{id}` before the write.
    No other scenario touches that path.

### Low device, far network (the headline row group)

p50 / p95 ms. ✗ marks a miss. "Eager" is the optimised candidate above.

| | 20k baseline | 20k eager | 20k on-demand | 20k progressive | 50k baseline | 50k eager | 50k on-demand | 50k progressive |
|---|---|---|---|---|---|---|---|---|
| cold (first paint) | 978 / 1152 | 917 / 1018 | 963 / 1073 | 975 / 1086 | 953 / 1056 | 960 / 1079 | 917 / 1052 | 935 / 1088 |
| cache ready (cold) | 2345 / 2695 | 5835 / 6256 | **1340** / 2238 | 1378 / 1730 | 3665 / 3836 | 12 786 / 14 229 | **1322** / 1431 | 1392 / 1487 |
| full copy in the worker (cold) | 2345 / 2695 | 5835 / 6256 | never | **13 659 / 14 188** | 3665 / 3836 | 12 786 / 14 229 | never | **32 903 / 35 323** |
| filter, warm visit | 86 / 201 ✗ | 175 / 212 ✗ | 230 / 289 ✗ | 478 / 1218 ✗ | 181 / 217 ✗ | 181 / 216 ✗ | 230 / 273 ✗ | 262 / 1637 ✗ |
| early: later answer p95 | 221 ✗ | 3090 ✗ | 288 ✗ | 1218 ✗ | 215 ✗ | 8544 ✗ | 284 ✗ | 1460 ✗ |
| detail | 298 / 320 ✗ | 279 / 443 ✗ | 259 / 304 ✗ | 272 / 351 ✗ | 276 / 326 ✗ | 291 / 327 ✗ | 258 / 303 ✗ | 264 / 310 ✗ |
| **live** (webhook → screen) | 169 / 181 | 158 / 179 | 241 / 377 | 964 / 3084 ✗ | 171 / 202 | 166 / 193 | 247 / 3509 ✗ | 254 / 5895 ✗ |
| write: round trip until confirmed | 427 / 445 | 3559 / 5063 | 425 / 455 | 769 / 913 | 427 / 459 | 10 032 / 12 665 | 422 / 469 | 423 / 459 |
| **reconnect** | 538 / 592 | 836 / 1564 | **465 / 497** | 2742 / 3419 ✗ | 623 / 723 | 5135 / 8995 ✗ | **476 / 508** | 1392 / 1579 |
| tabs: follower sees an edit | 61 / 89 | 3921 / 4685 ✗ | 106 / 148 | 302 / 1324 | 70 / 95 | 10 296 / 16 531 ✗ | 108 / 160 | 411 / 650 |
| rollback: chip gone again | 359 / 427 | 3293 / 4093 | 398 / 422 | 922 / 1036 | 353 / 362 | 8010 / 9572 | 391 / 432 | 414 / 1121 |
| storage: cache ready, next visit after 500 changes | 1248 / 1311 | 5191 / 6330 | 1173 / 1640 | 2166 / 2339 | 1703 / 1740 | 12 573 / 13 778 | 1237 / 1596 | 2427 / 2824 |
| browser storage after 500 changes | 820–832 KB | 804 KB | none (72 KB, empty schema) | 804 KB | 1952 KB | 1932–1944 KB | none | 1976–1988 KB |
| tab PSS, cold | 94 MB | 157 MB | **71 MB** | 213 MB | 141 MB | 259 MB | **72 MB** | 330 MB |

- **"Cache ready" means different things per mode.** In eager it means every row is loaded. In
  on-demand and progressive it means the worker has the cursor and dictionaries and can take
  queries, answering each first page from the server.
- **The harness labels a worker answer "local" from then on, even when the worker fetched it.** So
  on-demand's "local" filter steps are server round trips made by the worker, slower than the
  page's own server path by one worker hop and the 6× parse.
- **`scroll` p95 is 33.4 ms ✗ in every mode on the low device,** as it is for the baseline.

### Fast device

p50 / p95 ms, far network.

| | 20k baseline | 20k eager | 20k on-demand | 20k progressive | 50k baseline | 50k eager | 50k on-demand | 50k progressive |
|---|---|---|---|---|---|---|---|---|
| cache ready (cold) | — | 989 / 1117 (warm) | 861 / 883 | 878 / 965 | — | 1995 / 3387 (warm) | 877 / 915 | 872 / 908 |
| full copy in the worker (cold) | 1086 / 1116 | 1392 / 1602 | never | 4735 / 4841 | 1989 / 2037 | 2598 / 2835 | never | 8403 / 8895 |
| filter, warm visit | 30 / 127 | 127 / 420 ✗ | 131 / 147 | 140 / 290 ✗ | 37 / 132 | 123 / 129 | 132 / 145 | 133 / 152 |
| early p95 | — | 449 ✗ | 150 | 985 ✗ | — | 1215 ✗ | 148 | 347 ✗ |
| live | 27 / 44 | 128 / 186 | 130 / 277 | 128 / 259 | 128 / 140 | 127 / 140 | 130 / 264 | 133 / 269 |
| write: round trip until confirmed | 360 / 376 | 486 / 550 | 469 / 552 | 460 / 495 | 355 / 367 | 1520 / 2807 | 399 / 514 | 392 / 490 |
| reconnect | 526 / 534 | 880 / 991 | 418 / 423 | 464 / 725 | 546 / 565 | 864 / 1471 | 420 / 429 | 450 / 669 |
| tabs: follower sees an edit | 24 / 31 | 599 / 643 | 35 / 70 | 101 / 128 | 25 / 35 | 1556 / 2150 ✗ | 40 / 149 | 35 / 63 |
| rollback: chip gone again | 330 / 334 | 541 / 620 | 333 / 339 | 1089 / 1552 | 332 / 340 | 1248 / 1753 | 331 / 344 | 333 / 349 |
| storage: cache ready, next visit | 352 / 384 | 959 / 1075 | 513 / 560 | 606 / 654 | 441 / 460 | 1835 / 1999 | 523 / 640 | 634 / 715 |
| tab PSS, cold | 92 MB | 160 MB | 67 MB | 211 MB | 127 MB | 261 MB | 86 MB | 334 MB |

- **On-demand passes every target in all four fast cells,** near and far, once the `write` fix is
  in. It is the first TanStack DB variant to do so.
- **Progressive misses `filter` or `early` p95 in all four fast cells, near and far:** those
  queries land while the fill is running.
- **Progressive's `reconnect` logged one error each in fast-near-50k and fast-far-20k: "a change
  reached the page during the outage".** This is a gap in the harness, not a sync bug.
  - `POST /bench/outage` blocks only `/api/sync`.
  - Iteration 0 is the context's first visit. Its fill was still running, and its catch-up
    fetched `/api/snapshot?since=` over plain HTTP during the outage.
  - In a real outage that fetch fails too.

- **The write round trip includes fetching the row** (about one RTT) when the worker hadn't
  loaded it yet. That's why it is 40–110 ms over the baseline's on the fast device. Progressive at
  low-far-20k (769 ms) is waiting on its fill.

### What the modes needed

- **A string sort key compared byte by byte, not by locale.** An ordered `limit` query over an
  on-demand source loads its page as a prefix (`offset 0, limit = offset + limit`), then a
  boundary request (`eq(k, last)`). TanStack DB can only do that when the `orderBy` and an index
  on the key both use `stringSort: 'lexical'`. With the default locale comparison it silently
  falls back to loading the whole view. Nothing in the docs or the API says so; it was found by
  experiment in Node (`exp-od.mjs`).
- **Totals from the server.** A `count` over an on-demand source loads every matching row, so the
  count query had to go.
- **Two small server additions:**
  - `/api/head`: the cursor, epoch and dictionaries without any rows;
  - `seq` on list pages, so a page fetched before a change can't overwrite the change. The worker
    keeps the `seq` each row was last written at and skips older writes.
- **The view had to be parsed back out of TanStack's query IR.** `loadSubset` receives the
  `where` as `func`/`ref`/`val` nodes, not the query the app built. The worker turns it back into
  the server's `View` (state, labels, assignees, search) and declines anything else.
- **Progressive: eager's route once full.** On-demand-style page queries straight on a full
  collection spike to 0.1–0.6 s when a change moves a row across a page's window boundary. Over
  eager's per-state derived collections that stays small, so progressive switches route when the
  copy completes.
- **Progressive: a fill that yields.** Applied in one go, the fill held the sync queue, and
  "cache ready" waited for it. It is applied in 1,000-row chunks with a `setTimeout` between them.
- **Writes: fetch a missing row.** Covered above.

### What the modes say

- **On-demand is the only shape of TanStack DB that meets the targets on the low device.**
  - It closes every eager-only miss:
    - `reconnect` beats the baseline (465–476 against 538–623 ms);
    - the write round trip and the rollback are within 11% of it;
    - a follower tab sees an edit in 106–108 ms, against 61–70.
  - Memory is half the baseline's.
  - That's because it never builds a 20–50k-row collection. It holds the rows that open queries
    have loaded, plus whatever the stream changes.
- **But on-demand isn't a local cache.**
  - Every new view, filter or page is a server round trip, made by the worker.
  - Filters are therefore slower than the baseline's local answers (230 vs 86 ms p50 at
    low-far-20k), and a little slower than the page's own server path.
  - Nothing is stored, so there is no offline read and no instant answer on a return visit.
  - It is the server-side filtering design with a live-query layer in front: queries stay live as
    the stream changes the rows they hold.
- **Progressive costs the most and loses on the low device.**
  - Its fill is the eager build moved into the background: 13.7 s at 20k and 32.9 s at 50k on the
    low device.
  - For that whole window, queries, deltas and writes share the worker with it. At 6×:
    - live p95 is 3.1–5.9 s;
    - filter p95 is 1.2–1.6 s;
    - reconnect is 1.4–2.7 s.
  - A burst of webhooks during the fill makes it worse. In Node, 500 deltas cost about 13–19 ms
    each while the collection is partly loaded, and stretch a 1 s fill past 6 s.
  - After the fill it is eager, with eager's 213–330 MB of tab memory.
- **So the mode choice doesn't rescue the full-mirror cache.**
  - TanStack DB either builds every row up front (eager, misses on the low device) or in the
    background (progressive, slow while it builds), or skips the copy entirely (on-demand, no
    longer a cache).
  - The baseline's hand-written sorted array remains the only thing measured that holds the full
    mirror and meets the low-device targets.

## Server load

Not re-run: the server is the baseline's, and TanStack DB adds no requests (the worker uses the
same snapshot, `?since=` and `/api/sync` routes in the same pattern). See the baseline's
[Server load](../sync-baseline/RESULTS.md#server-load-benchload---sync-one-mirror-per-account)
(`results/2026-10-18-071717-load-sync-opt-…` and `…-072451-…`). Each run's `srv` CPU was in line
with the baseline's in every scenario: 0.2–11% mean, under 53% peak, in the bench's 1-CPU
container.

- **On-demand and progressive weren't load-tested either.** On-demand moves list reads from the
  page to the worker, plus one extra: a view the page has rendered is read again by the worker
  when its query starts.
- **The extra cost is per visit:** progressive downloads the full snapshot in the background;
  on-demand never does. Their browser runs' `srv` CPU stayed in the same range: 0.3–21% mean,
  under 54% peak.

## What it says

- **TanStack DB works as a query engine and optimistic-transaction layer over our own sync, but
  only after removing the parts that would have made it worth adopting.** Its persistence and tab
  coordination fail at this data size:
  - 62–70 s to store 20k rows, never at 50k;
  - writes that never send, reconnect that never catches up, a second tab that never opens;
  - 19.7 MB in OPFS.

  The working version keeps the baseline's IndexedDB records, leader election and wire, and lets
  TanStack DB hold rows and answer queries.
- **Even as a pure in-memory engine it's slower than the baseline's hand-written cache on the
  device that matters, and nothing it does makes up for that.**
  - **Building collections, indexes and live queries happens on every visit and in every tab,** and
    it can't be persisted. That costs 1.0–3.6 s per visit on the fast device and 5–13 s on the low
    one, against the baseline's 0.5–2.1 s and 1.3–3.7 s.
  - **While it builds, confirmations, rollbacks, reconnect and followers wait.** On the low device
    that misses `reconnect` at 50k and `tabs` in every cell. It also makes a failed write's chip
    linger 3–10 s.
  - **Tab memory is 1.7–1.9× the baseline's** (157–261 MB against 92–141 MB).
  - **The worker bundle grows from 4 KB to 82 KB gzipped.**
- **What it gives in return is real but small here:**
  - typed, declarative queries (`where` / `orderBy` / `offset` / `limit`, `inArray`, `ilike`);
  - incremental live queries, so a one-row delta re-runs cheaply once the queries exist;
  - optimistic mutations that roll back when the handler throws.

  The baseline does each of these in about 400 lines of cache code already measured to meet the
  targets.
- **TanStack DB's other sync modes don't change this.**
  - **On-demand** meets the low-device targets (apart from the same `filter`, `detail` and `scroll`
    margins the baseline misses), with half the baseline's memory. It does so by not holding a
    copy: every new view is a server round trip.
  - **Progressive** builds the copy in the background, in 14–33 s on the low device. Live updates
    and filters are slow for that whole time.
  - See [Sync modes](#sync-modes-on-demand-and-progressive).
- **Webhook → screen (1–2 s target) is met either way:** 128–166 ms p50 and under 0.8 s p95 through
  a real 100 ms link at 6×.

## What it forces on the design

- **Server and mirror: nothing** in eager mode. TanStack DB is browser-only and takes our wire as
  is, through a custom sync config. On-demand needs `/api/head` (the cursor without rows) and a
  `seq` on list pages. Everything the baseline forces (per-account `seq`, tombstones, `epoch`, the
  SSE route, the stored stale snapshot) stays.
- **Browser, if we used it:**
  - **Our own persistence and tab orchestration, not TanStack's**, which means the baseline's worker
    (about 120 lines) stays.
  - **A dedicated worker running TanStack DB core without a framework adapter.** `useLiveQuery`
    can't bind across the worker boundary, so the page↔worker message protocol stays ours. Solid 2
    has no official adapter anyway.
  - **A view model built around derived collections per state**, created ahead of need (`warm`),
    because a live query is built synchronously when it's created and the first build is the
    expensive part.
  - **Paging by `offset`, with the count as a separate query and message**, because a count that
    re-queries the list races with `loadMore`.
- **What it would rule out:** answering from the cache in the first seconds of a low-device visit.
  The cache isn't ready for 5–13 s there, so the hybrid's server path carries every filter in that
  window. This already happens in the numbers above: "(server)".

## How much of the protocol and write-path tickets it answers

**[Mirror-to-browser sync protocol](https://github.com/tomsjansons/beghu/issues/9): nothing beyond
the baseline.** The wire, cursor, deltas, transport and reconnect are the baseline's, because
TanStack DB doesn't specify a protocol. Its sync config is an adapter interface that applies
whatever a protocol delivers.

- **What it adds is a negative result on the browser side.** Its packaged persistence isn't usable
  for a full-mirror cache of 20k–50k rows.
- **On-demand (`loadSubset`) works for query-driven loading over our wire, with conditions.** See
  [Sync modes](#sync-modes-on-demand-and-progressive).
  - It needs a lexical sort key, server totals, and a `seq` on every page so that pages and deltas
    can be ordered.
  - That makes it a plausible way to hold comments only for issues that are opened.
  - It is not a way to hold the full list: every new view becomes a server round trip.

**[Write path: outbox, optimistic view, server write queue](https://github.com/tomsjansons/beghu/issues/10):
a little, and on the browser side only.**

- **Measured:** an optimistic update shows in one frame, is held until the stream passes the
  returned `seq`, and rolls back when `onUpdate` throws. That's the same op as the baseline (add a
  label).
- **Not tried:** TanStack's transaction model (`createOptimisticAction`, manual transactions) and
  its separate offline-transactions package, which offer a persisted outbox. Given that its
  persistence failed at this size, the offline package would need its own test before it counts.
- **Not covered at all:** the server write queue, retries, rate limits, conflict detection and
  temporary ids.

## DX checklist

- **Agent-friendliness: poor to fair.**
  - The core API (`createCollection`, `createLiveQueryCollection`, the query builder) was easy to
    write, but its performance behaviour had to be found by experiment, not from the docs:
    - a live query builds synchronously when created;
    - a lazy `count` builds only on `startSyncImmediate`;
    - an unlimited sorted query over 20k rows costs 50–550 ms.

    Six Node experiments (`exp-offset`, `exp-build`, `exp-sync`) were needed to find a shape that
    pages.
  - The persistence package (0.2.x) needed an internal method (`hydrateBaseline`) to load a
    snapshot. Its failure modes (writes not sent, a second tab never ready) gave no error to go on,
    and weren't root-caused in a session.
  - Two of my own bugs came from TanStack's async edges:
    - a count re-query racing `loadMore`;
    - the nested CPU throttle, a measuring bug caused by query builds running inside sync
      transactions.
- **End-to-end types: good, with one gap.**
  - The query builder is typed through to the row shape: `where`, `orderBy` and `select` reject
    unknown fields.
  - The wire types still come from Rust via `ts-rs`, as in the baseline.
  - The worker↔page protocol is still a hand-written discriminated union (12 lines).
- **Dev loop: same as the baseline's.** Vite builds the page and worker in about 2 s, and the
  release server rebuild is unchanged. Debugging needed Node scripts outside the browser, because
  TanStack DB's internal state (pending transactions, a query's built state) isn't visible from
  the devtools.
- **Maturity and churn: high.** `@tanstack/db` is 0.15, pre-1.0, with frequent minor releases.
  `@tanstack/browser-db-sqlite-persistence` is 0.2.35. Bus factor: a well-funded maintainer
  (TanStack), and ElectricSQL ships its browser client on top of it.
- **Lines of code** (non-blank, non-comment; server unchanged from the baseline, 834):

  | | Cache | Worker | Page-side source + protocol | App |
  |---|---|---|---|---|
  | Optimised | `db.ts` 399 (627 with on-demand and progressive) | 116 | 105 | 227 |
  | Baseline | 397 | 120 | 94 | 222 |
  | Idiomatic | `db.ts` 252, plus `run.ts` 70 and `worker-persisted.ts` 26 | | | |

  The library saved no lines once it had to perform: the optimised cache is the same size as the
  hand-written one.
- **Bundle size** (gzip):

  | Bundle | Optimised | Baseline | Idiomatic |
  |---|---|---|---|
  | Worker | 82 KB (287 KB raw) | 4 KB | 123 KB |
  | wa-sqlite OPFS worker | — | — | 705 KB |
  | Page entry | 25.4 KB | — | — |
