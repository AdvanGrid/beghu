# sqlx against rusqlite at filter load: results

For [Benchmark: sqlx against rusqlite at filter load](https://github.com/tomsjansons/beghu/issues/81).
Run on 2026-10-26 with `./bench/load` (see [README.md](README.md)): per-account 50k mirrors, 20
users, the filter phase's harsh shape (every user types at once, one request per key, no
debounce), and live (one webhook a second; every user refetches its first page on each push).
p50 / p95 in ms. Every cell ran in the same image on the same day; the repeats show how much a
single run moves.

## Headline: 50k, 20 users

| | filter p50 / p95 | live refetch p50 / p95 | threads |
|---|---|---|---|
| **4 CPUs, rusqlite** | 28 / 236 · 26 / 177 · 51 / 1937 ¹ | 29 / 84 · 32 / 94 · 38 / 92 | 105 |
| **4 CPUs, sqlx** | 27 / 183 · 29 / 167 · 30 / 192 | 46 / 114 · 78 / 124 · 67 / 118 | 45–47 |
| **1 CPU, rusqlite** | 63 / 253 · 74 / 308 · 75 / 269 | 292 / 385 · 277 / 356 · 282 / 383 | 102 |
| **1 CPU, sqlx** | 101 / 449 · 68 / 365 · 114 / 723 | 396 / 493 · 376 / 435 · 377 / 463 | 42–61 |

¹ One rusqlite run had a multi-second tail while its blocking pool grew to 131 threads; it is
the only such run in either layer.

On 4 CPUs the filter phase is level: sqlx's overhead is lost under the query cost. The previous
record for this cell was p95 183 ms (rusqlite 0.40, ticket #20); today's rusqlite runs gave
177–236 ms. On 1 CPU, where the 20 users saturate the core, sqlx's filter p95 is 1.4–2.7× and its
p50 up to 1.5×.

Live is the one place sqlx is slower every time, on any CPU count: +15–45 ms p50 on 4 CPUs and
about +100 ms on 1 CPU. A push makes all 20 users refetch in the same instant, so per-request CPU
cost turns straight into queueing. The live phase's mean server CPU is 36–38% on sqlx against
28–30% on rusqlite for the same 600 requests (and the same webhook writes), so a sqlx list
request costs roughly a quarter more CPU.

## Where the cost is

| 50k, 20 users | filter p50 / p95 | live p50 / p95 | what it isolates |
|---|---|---|---|
| 1 CPU, rusqlite with sqlx's three-statement shape (`BENCH_LIST=split`) | 48 / 194 | 275 / 331 | the count + ids + `json_each` hydrate shape, on rusqlite |
| 4 CPUs, same | 28 / 173 | 30 / 94 | |
| 1 CPU, sqlx with rusqlite pools for webhook writes (`BENCH_SQLX_WRITES=pool`) | 102 / 688 | 392 / 491 | the per-request rusqlite connections sqlx mode uses for writes |
| 4 CPUs, same | 27 / 154 | 87 / 124 | |

- **The query shape costs nothing.** On rusqlite, ids then a separate hydrate is as fast as the
  one-statement CTE, or faster. The unchecked-ids-plus-checked-hydrate design is free.
- **The write connections aren't it.** Pooling the webhook writes left sqlx's live numbers where
  they were.
- So the gap is sqlx itself: each statement crosses to the connection's worker thread and back
  over channels, as the micro-benchmark in `docs/research/compile-time-sql.md` found
  (~2× per query). Under the real query cost that is about +25% CPU per list request, and it
  only shows in latency once the CPU is saturated.

## 20k and fewer users

From the full matrix (`--scale all --users 1,5,20`, one run each). Filter p50 / p95:

| | 1 user | 5 users | 20 users |
|---|---|---|---|
| 20k, 4 CPUs, rusqlite / sqlx | 12 / 25 · 13 / 24 | 14 / 89 · 16 / 103 | 15 / 119 · 15 / 99 |
| 20k, 1 CPU, rusqlite / sqlx | 13 / 29 · 14 / 26 | 14 / 89 · 16 / 104 | 18 / 268 · 18 / 116 |
| 50k, 4 CPUs, rusqlite / sqlx | 18 / 41 · 18 / 42 | 21 / 140 · 22 / 137 | (above) |
| 50k, 1 CPU, rusqlite / sqlx | 21 / 52 · 20 / 43 | 21 / 163 · 25 / 170 | (above) |

At 1 and 5 users the layers can't be told apart. Live at 20k, 20 users: 20 / 31 against 27 / 38
on 4 CPUs, and 79 / 132 against 189 / 228 on 1 CPU, the same pattern as at 50k. No run in either
layer had an error.

## Threads and memory with many accounts

`accounts-probe.mjs`, 100 accounts on 20k mirrors, 4 CPUs. Threads / RSS:

| | idle after startup | after every account served 4 concurrent lists | 30 s later |
|---|---|---|---|
| rusqlite + r2d2 | 305 / 44 MB | 309 / 819 MB | 305 / 818 MB |
| sqlx | 106 / 43 MB | 405 / 851 MB | 405 / 851 MB |

- **sqlx holds one OS thread per open connection.** That's one per account at idle (the pool's
  `min_connections(1)`), and up to `max_connections` per account once busy. Idle connections are
  only closed after the pool's `idle_timeout` (10 min by default), so the 400 threads stay.
- **r2d2 costs threads too.** Each pool runs its own 3-thread scheduler (`r2d2-worker`, r2d2
  0.8.10 `config.rs`), so rusqlite carries ~3 threads per account whether busy or not. Pools can
  share one scheduler through `Builder::thread_pool`, which this benchmark didn't do. Under the 20-account load test, rusqlite ran
  102–105 threads and sqlx 42–61.
- **Memory is the same in both and is page cache.** Each connection keeps up to 2 MB of SQLite
  page cache, so 400 open connections hold ~800 MB, in either layer. The real server needs a
  bound here, not a choice of library: fewer connections per idle account, a shorter idle
  timeout, or a smaller `cache_size` (the OS page cache stays warm either way, see
  `../filtering/OPTIMISATION.md`).

## Opening pools and migrating

From the sqlx server's startup log, on the probe's 100 accounts (20k, 4 CPUs):

- **First migrate of a mirror built before the migrator existed:** pool 27 ms. `migrate!`
  1.41 s, almost all of it `0002`'s five index builds and `ANALYZE` on 20k items.
- **An up-to-date mirror (the other 99):** opening a pool takes 5.8 ms p50 (max 19 ms), and the
  migrator's check takes 1.6 ms p50 (max 3.4 ms). Locally, with 3 accounts, those were 2.4 ms and
  0.6 ms.

So opening a mirror and confirming it's current costs under 10 ms, which is cheap enough to do
on first use after a deploy. A migration that rebuilds indexes costs about a second per 20k
mirror.

## What it says

- **At the server's real load, sqlx's per-query overhead is mostly lost under the query cost.**
  With CPU to spare, filtering is level and the extra latency on a live push is 15–45 ms.
- **It costs about a quarter more CPU per list request.** On one saturated core that becomes about
  +100 ms on a 20-user live refetch burst, and a filter p95 1.4–2.7× rusqlite's. Neither comes
  near the 1–2 s live target, whose cost is dominated by GitHub's ~1.3 s webhook delivery. It does
  mean a 1-CPU host saturates sooner on sqlx.
- **The recommended shape is free.** An unchecked `QueryBuilder` for ids plus a checked `query!`
  hydrate through `json_each` is as fast as the hand-written single statement.
- **Threads and memory need a bound on either layer.** sqlx has one thread per open connection,
  and r2d2 three threads per pool. Page cache at 2 MB per connection dominates memory in both.
- Migrations: pool plus up-to-date check is under 10 ms a mirror, and an index-building migration
  about 1.4 s per 20k mirror.

Raw results: `bench/results/2026-10-26-03*-load-filtering-sqlx-*`,
`…-04*-load-filtering-sqlx-*` and `…-043836-accounts-probe-100-20k`.
