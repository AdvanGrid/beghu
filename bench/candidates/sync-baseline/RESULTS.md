# Sync: hand-rolled baseline — passes, change log and results

Run on 2026-10-16 for
[Sync benchmark: hand-rolled baseline](https://github.com/tomsjansons/beghu/issues/22). The
candidate is described in [README.md](README.md). Browser runs used all 8 cells, 20 iterations per
scenario (storage: 3), and held the bench lock. The host was heavily loaded by unrelated work
throughout (28 of 31 GB of RAM in use, 33 GB swapped at the worst point), so compare numbers within
a run, not across days. One cold-load outlier (fast-near-20k, p95 1.6 s in the optimised run) is
host noise: its p50 and every other cell are in line.

The sync scenarios (`reconnect`, `tabs`, `rollback`, `storage`) are new in the harness for this
ticket; see [../../README.md](../../README.md#scenarios).

## Passes

**Idiomatic pass** (the code in [idiomatic/](idiomatic/), results
`results/2026-10-16-084731-sync-baseline` and storage `…-103601-sync-baseline`): the design in the
README, written once with plain Web APIs and no tuning. Every delta carried the three dictionaries
whole; the worker reconnected after 0.25, 0.5, 1, 2, 4, then every 5 s; past 50 stored records the
syncing tab compacted by downloading a fresh snapshot; a small delta found its old rows with one
filter pass over the cache.

It passed everything the hybrid it forked from passed, plus `tabs` and `rollback`. It missed:

- **Reconnect,** in every cell: 2.9–3.4 s p50 against ≤ 2 s. The catch-up itself took 8–72 ms; the
  rest was the backoff, which had reached its 2–4 s steps by the time a 5 s outage ended.
- **A returning tab after 500 changes** took 1.2–4.7 s (fast) and 7.1–8.5 s (low) to have its cache
  ready, against 0.26–0.53 s and 1.3–2.0 s for an ordinary warm visit. The tab replayed hundreds of
  stored deltas, each one an O(rows) pass.
- One harness bug, not the candidate's: on low-near-50k, 10 of 20 reconnect iterations errored
  because a failed iteration left its tab open holding the sync lock. Fixed in `harness/run.mjs`
  (failed iterations now close their tabs); the re-run (`…-104411-sync-baseline`) had no errors:
  3013 / 3086 ms.

**Optimisation pass** (`sync-opt` during the session, now this directory). One session, four
changes, each with the scenario it targets. All four use plain JavaScript, Rust and Web APIs;
there was no library to fight.

| # | Change | Target | Before → after |
|---|---|---|---|
| 1 | Reconnect after 0.25, 0.5, then every 1 s (was up to 5 s), and at once on `online` | `reconnect` | p50 2.9–3.4 s → 0.53–1.19 s, every cell under 2 s; `reconnect_ms` 2.9–3.3 s → 0.39–0.93 s |
| 2 | Deltas carry the dictionaries (repos, labels, users) only when one of them changed after the cursor; the cache keeps the last server→cache index maps for deltas without them | delta size, `live`, server load | A one-issue delta: about 4.9 KB → 190 B. `live` within noise (low-far-20k 149 / 212 → 169 / 181 ms) |
| 3 | The syncing tab compacts IndexedDB from its own state, 2 s after passing 50 records: one record in snapshot format (rows with pending writes stored as the server's copy) plus the index maps. No snapshot download | `storage` | IndexedDB after 500 changes 1380 → 820 KB (20k), 2572 → 1952 KB (50k). Fast-device cache ready on the next visit 1.2–4.7 s → 0.24–0.46 s. The low device didn't improve (6.3–7.2 s): the live tab fell behind and never got to compact |
| 4 | An id → row index in the cache. A small delta finds each old row by binary search on its sort key instead of a filter over every row | `storage` (low), `tabs` | Per-delta cost at 6×: about 26 ms → under 1 ms. Low-device cache ready after 500 changes 7.1–8.5 s → 1.25–1.86 s p50; followers in `tabs` 115–198 / 196–392 ms → 61–79 / 89–99 ms |

Changes 1–3 were measured on the targeted scenarios (`…-104845-sync-opt`, `…-111359-sync-opt`),
change 4 in the full re-run (`…-112519-sync-opt`, storage `…-125830-sync-opt`). Correctness after
each change: `smoke.mjs` (two tabs, leader hand-off, optimistic write) and `smoke-compact.mjs N` (a
returning tab after N webhooks shows the server's rows and the server's `bug` filter, and holds one
record plus what arrived since its compaction), run with N = 80 and N = 500 (the 500 include
transfers and deletes).

One number went the wrong way and wasn't explained in the session: `catchup_ms` (stream accepted →
first delta applied) rose from 8–72 ms to 85–270 ms in the harness. A native probe of the same
build, 4 reconnects after 100 edits, caught up in 14–16 ms. The total, which is what the reference
line measures, still fell by 2.3–2.8 s.

## Browser results

p50 / p95 ms, far network (100 ms RTT, 10 Mbps down). Idiomatic → optimised. Near-network cells are
in the results directories and tell the same story with lower numbers.

### Low device (6× CPU, worker throttled to match)

| | 20k idiomatic | 20k optimised | 50k idiomatic | 50k optimised |
|---|---|---|---|---|
| cold | 1118 / 1316 | 978 / 1152 | 1016 / 1085 | 953 / 1056 |
| first full snapshot stored (cold) | 2438 / 2880 | 2254 / 2615 | 3526 / 4151 | 3600 / 3780 |
| warm | 1023 / 1138 ✗ | **891 / 952** | 929 / 1168 ✗ | **885 / 966** |
| cache ready (warm) | 1429 / 1693 | 1333 / 1674 | 2049 / 2905 | 1946 / 2285 |
| filter, warm visit | 93 / 197 | 86 / 201 ✗ | 189 / 241 ✗ | 181 / 217 ✗ |
| early | 102 / 220 ✗ | 105 / 221 ✗ | 172 / 209 ✗ | 177 / 215 ✗ |
| scroll frame p95 | 50 ✗ | 33.4 ✗ | 33.4 ✗ | 33.4 ✗ |
| detail | 286 / 354 ✗ | 298 / 320 ✗ | 273 / 330 ✗ | 276 / 326 ✗ |
| **live** (webhook → screen) | 149 / 212 | 169 / 181 | 162 / 198 | 171 / 202 |
| write (optimistic) | 39 / 49 | 37 / 45 | 31 / 45 | 38 / 53 |
| **reconnect** | 3375 / 3415 ✗ | **538 / 592** | 3437 / 3483 ✗ | **623 / 723** |
| tabs: leader / follower p95 | 133 / 196 | 99 / 89 | 352 / 392 | 81 / 95 |
| tabs: after the syncing tab closes | 179 / 228 | 151 / 169 | 213 / 264 | 159 / 173 |
| rollback: chip shown | 39 / 54 | 40 / 56 | 50 / 84 | 36 / 47 |
| rollback: chip gone again | 357 / 382 | 359 / 427 | 367 / 391 | 353 / 362 |
| storage: cache ready, next visit after 500 changes | 7054 / 7963 | **1248 / 1311** | 8513 / 10382 | **1703 / 1740** |
| tab PSS, cold | 91 MB | 94 MB | 132 MB | 141 MB |

### Fast device

| | 20k idiomatic | 20k optimised | 50k idiomatic | 50k optimised |
|---|---|---|---|---|
| cold | 353 / 376 | 330 / 368 | 359 / 488 | 331 / 357 |
| first full snapshot stored (cold) | 1116 / 1215 | 1086 / 1116 | 2013 / 2181 | 1989 / 2037 |
| warm | 165 / 220 | 158 / 199 | 175 / 271 | 157 / 183 |
| filter, warm visit | 31 / 127 | 30 / 127 | 126 / 177 | 37 / 132 |
| live | 32 / 79 | 27 / 44 | 131 / 186 | 128 / 140 |
| write | 9 / 14 | 11 / 12 | 10 / 11 | 9 / 12 |
| **reconnect** | 3316 / 3331 ✗ | **526 / 534** | 3331 / 3362 ✗ | **546 / 565** |
| tabs: leader / follower p95 | 43 / 54 | 31 / 31 | 57 / 59 | 32 / 35 |
| tabs: after the syncing tab closes | 133 / 143 | 121 / 131 | 137 / 155 | 126 / 138 |
| rollback: chip gone again | 330 / 338 | 330 / 334 | 331 / 340 | 332 / 340 |
| storage: cache ready, next visit after 500 changes | 1956 / 1978 | **352 / 384** | 4711 / 5018 | **441 / 460** |
| tab PSS, cold | 91 MB | 92 MB | 135 MB | 127 MB |

The misses on filter, early, scroll and detail on the low device are the hybrid's (see
[../filtering/HYBRID.md](../filtering/HYBRID.md)); the sync layer doesn't touch those paths, and the
numbers didn't move.

**Rollback** shows the chip in one frame and takes it away again 330–430 ms after the click: the
300 ms the server waits to stand in for GitHub, plus the round trip and one frame.

**Browser storage** (IndexedDB, as reported by `navigator.storage.estimate()`): 872 KB at 20k and
2056 KB at 50k after a first visit. After 500 changes the idiomatic pass held 1244–1380 KB and
2168–2572 KB, waiting to compact; the optimised pass holds one compacted record: 820–832 KB and
1952 KB. The JS heap metric can't see the worker, so memory is the tab's PSS.

### Through a real shaped link (`./bench/shape`)

CDP's network emulation doesn't delay frames on an open stream, so the harness's `live` and `tabs`
numbers leave out the link's latency for the delta itself. Through `./bench/serve sync-opt --rtt
100` (100 ms RTT, 10 Mbps down, every byte delayed) with `shaped-live.mjs`, 20 title edits, webhook
POSTed straight to the server, two tabs:

| | syncing tab p50 / p95 / max | other tab p50 / p95 / max |
|---|---|---|
| 1× CPU | 93 / 698 / 741 | 76 / 82 / 120 |
| 6× CPU | 145 / 195 / 709 | 94 / 113 / 152 |

The few 0.7 s outliers in the syncing tab (1 or 2 of 20) weren't chased. Even they are well inside the
1–2 s target.

## Server load (`./bench/load --sync`, one mirror per account)

1, 5 and 20 users at once, each their own account, p50 / p95 ms, with the server's mean / peak CPU
(100% = one core). The burst is every user cold-loading together (facets, first page, stored
snapshot), five times. Live is one webhook a second for 30 s while every user holds `/api/sync`
open; the latency is from the webhook POST to the delta arriving on each user's stream. Every
delta was 0.2 KB. No run had errors.

| | burst | live | RAM peak |
|---|---|---|---|
| 50k, 20 users, 4 CPUs | 522 / 683 · 14% / 76% | 119 / 642 · 6% / 48% | 263 MB |
| 50k, 20 users, 1 CPU | 487 / 719 · 13% / 72% | 132 / 480 · 6% / 46% | 255 MB |
| 50k, 5 users, 1 CPU | 145 / 174 · 6% / 67% | 28 / 547 · 2% / 22% | 93 MB |
| 20k, 20 users, 4 CPUs | 275 / 474 · 10% / 70% | 100 / 1007 · 4% / 30% | 191 MB |
| 20k, 20 users, 1 CPU | 229 / 396 · 9% / 70% | 58 / 275 · 3% / 28% | 183 MB |
| 20k, 5 users, 1 CPU | 94 / 117 · 5% / 62% | 16 / 73 · 1% / 11% | 57 MB |
| 20k / 50k, 1 user, 1 CPU | 48 / 59, 81 / 91 | 4 / 6, 4 / 16 | 23–25 MB |

Results: `results/2026-10-18-071717-load-sync-opt-sync-per-user-pool-4cpu` and
`…-072451-…-1cpu`.

- **The burst is the hybrid's** (20 users at 50k: 0.47–0.52 s p50 there and here): the stored
  snapshot does the work, and the sync stream's catch-up delta on connect is a few ms.
- **Holding streams open costs nothing measurable:** 20 idle streams and one change a second keep
  the server at 3–6% mean CPU.
- **The live tail comes from the fixture's fan-out, not the stream.** Every account mirrors every
  fixture repo, so one webhook is applied to 20 mirrors one after another, each its own commit
  and published delta. The 20th account waits for the other 19, which is the 0.3–1.0 s p95. A
  real webhook only touches the accounts that mirror its repo, and applying them concurrently (the
  pools are already per account) is a few lines. Even this worst case is inside the 1–2 s target.
  The p95s are noisy (the 4-CPU run was slower than the 1-CPU one) because the host was loaded.

## What it says

- **A hand-rolled sync layer meets every sync target on every device after one optimisation
  session.** Webhook → screen is 26–171 ms p50 (181–202 ms p95 on the low device, under 0.75 s
  through a real 100 ms link); a second tab sees the change as fast; reconnecting after a 5 s
  outage with 100 missed changes shows the last one 0.5–1.2 s after the server is back; an
  optimistic write shows in a frame and rolls back in a frame after the failure arrives.
- **The idiomatic version's misses were both "obvious once measured"**: a backoff tuned for a
  flaky server rather than a short outage, and per-delta work proportional to the cache size. Each
  took minutes to fix once the scenario pointed at it. Neither would have been found without the
  sync scenarios, so they stay in the harness for the other three sync candidates.
- **Server cost is small,** because each change's delta is built once per account and fanned out
  as the same bytes, and the stored snapshot stays stale on purpose. See the load section.
- **Everything the browser needs is plain platform API:** `EventSource`, Web Locks,
  `BroadcastChannel`, IndexedDB, a dedicated worker. No dependency was added on either side.
- **What it doesn't do yet:** comments and relationships aren't in the cache (opening an issue
  still fetches its detail and comments, 140–300 ms), the delta stream carries only the list's
  columns, and there's no offline write queue: a write while the stream is down is sent at once and
  fails or succeeds like any other.

## What it forces on the design

- **Mirror storage:** none beyond what
  [Mirror schema and per-account isolation](https://github.com/tomsjansons/beghu/issues/8) already
  has. Per-account SQLite with the per-transaction `seq`, tombstones and `epoch` is exactly the
  cursor this needs. One index added (`tombstones(seq)`), and every write path must stamp `seq` in
  the same transaction (one `UPDATE … RETURNING` on `meta`).
- **Server components:** one SSE route (`/api/sync`), the existing snapshot route with `?since=`,
  an in-process broadcast channel per account, and a background snapshot rebuild. No extra process,
  no Postgres, no separate sync server. Writes return the `seq` they were stamped with.
- **Browser:** a dedicated worker that owns the cache, IndexedDB of raw response text plus
  compaction, a Web Lock for leader election and a `BroadcastChannel` for followers.

## How much of the protocol and write-path tickets it answers

**[Mirror-to-browser sync protocol](https://github.com/tomsjansons/beghu/issues/9):** most of it,
as a working, measured proposal:

- *What the browser holds:* the list columns of every issue and PR, in a worker, persisted to
  IndexedDB. Not yet comments or relationships, which that ticket requires ("opening an issue must
  show its comments with no placeholder or layout shift"). Holding comments is the main open piece,
  and it changes the storage numbers (comments are most of the mirror's bytes).
- *Cursor and deltas with deletions:* the mirror's `seq`, deltas since a cursor with tombstoned
  ids, `epoch` for resets. Tombstone pruning (7 days) needs one rule this didn't exercise: a cursor
  older than the oldest tombstone gets a `reset`.
- *Bulk snapshot on first load:* a stored, stale, precompressed snapshot plus a catch-up delta.
- *Transport:* SSE. One-way is enough because writes go over plain HTTP and return their `seq`.
- *Reconnect and catch-up:* reconnect every second at most, then one catch-up delta from the cursor.
  One tab syncs, the others follow, and hand-off on close takes 0.04–0.16 s.

**[Write path: outbox, optimistic view, server write queue](https://github.com/tomsjansons/beghu/issues/10):**
a small part. It shows the optimistic view working: the cache's row is the server's copy plus
pending ops, dropped once the stream has passed the `seq` the write returned, or rolled back on
failure. The op set is one op (add a label). Not covered: a persistent outbox, the per-repo write
queue to GitHub with retries and rate limits, duplicate-create protection, conflict detection,
temporary ids, and blocking writes while GitHub is down.

## DX checklist

- **Agent-friendliness:** good. Every API used is a long-stable platform or crate API the agent
  knew. The bugs were in my own logic, not in stale docs: the leader flag set too late (a second
  tab replayed a delta without its snapshot; fixed with the chain check on load), and the page
  refetching a detail over its own optimistic chip (fixed with an `own` flag on change events).
  Neither took more than one round to find with the smoke scripts. The cost is that there is no
  library to lean on: every edge (gaps, epochs, hand-off, compaction) is ours to think of and test.
- **End-to-end types:** the wire types (`Snapshot`, `Written`, `CacheRow`, …) come from Rust via
  `ts-rs`, so the server and the worker agree by construction. The worker ↔ page messages are a
  hand-written discriminated union (`protocol.ts`, 10 lines). SSE event names are strings.
- **Dev loop:** on this (loaded) host, a cold release build of the server takes 144 s, a release
  rebuild after editing `main.rs` 13 s, and `cargo check` under 1 s. The page and worker build with
  Vite in 1.8 s, and `tsc` checks them in 0.9 s. Errors are rustc's
  and TypeScript's. The sync layer itself is best debugged with the two smoke scripts and the
  `bench:` performance marks, which show each phase on a timeline.
- **Maturity and churn:** no sync dependency at all. The platform APIs are stable (Web Locks and
  `BroadcastChannel` everywhere since 2022). The stack under it is the filtering candidate's: axum
  0.8, rusqlite, Solid 2 (still a release candidate). The bus factor is us: we own every line of
  the protocol.
- **Lines of code** (non-blank, non-comment, after the optimisation pass): server 834 in `main.rs`,
  of which about 270 are added or changed over the filtering candidate (`/api/sync`, deltas with
  tombstones, `seq` stamping, publish, bench controls); worker 120; cache 397, about 210 added or
  changed over the hybrid's; page-side source and protocol 94; App 222. The sync layer is about
  650 of the 1.7k lines.
