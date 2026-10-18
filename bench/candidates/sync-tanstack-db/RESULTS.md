# Sync: TanStack DB — passes, change log and results

Run on 2026-10-18 for
[Sync benchmark: TanStack DB](https://github.com/tomsjansons/beghu/issues/23). The candidate is
described in [README.md](README.md), the idiomatic pass in
[../sync-tanstack-db-idiomatic](../sync-tanstack-db-idiomatic). The server is the hand-rolled
baseline's, byte for byte apart from its banner, so this compares the browser side only. The
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

## Server load

Not re-run: the server is the baseline's, and TanStack DB adds no requests (the worker uses the
same snapshot, `?since=` and `/api/sync` routes in the same pattern). See the baseline's
[Server load](../sync-baseline/RESULTS.md#server-load-benchload---sync-one-mirror-per-account)
(`results/2026-10-18-071717-load-sync-opt-…` and `…-072451-…`). Each run's `srv` CPU was in line
with the baseline's in every scenario: 0.2–11% mean, under 53% peak, in the bench's 1-CPU
container.

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
- **Webhook → screen (1–2 s target) is met either way:** 128–166 ms p50 and under 0.8 s p95 through
  a real 100 ms link at 6×.

## What it forces on the design

- **Server and mirror: nothing.** TanStack DB is browser-only and takes our wire as is, through a
  custom sync config. Everything the baseline forces (per-account `seq`, tombstones, `epoch`, the
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
- **Untested:** its on-demand sync mode (`loadSubset`, query-driven loading) might be a way to hold
  comments only for issues that are opened. This candidate didn't try it.

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
  | Optimised | `db.ts` 399 | 116 | 105 | 227 |
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
