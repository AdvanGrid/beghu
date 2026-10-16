# Filtering location: idiomatic pass, optimisation pass, and the matrix

Run on 2026-10-15 for
[Benchmark: client-side vs server-side filtering at 20k and 50k issues](https://github.com/tomsjansons/beghu/issues/20).
The browser runs used the far network (100 ms RTT, 10 Mbps), 20 iterations each, and held the bench lock
on this host. Every cell ran its three variants back to back. The host is shared and was heavily
loaded during the runs, so compare numbers within a cell, not across days.

## Idiomatic pass

The cache stored one IndexedDB record per row and saved the snapshot before the first render. The
server filtered with plain `LIKE` and a separate count, and used the indexes inherited from
axum-solid2. Smoke run on the headline cell (6× CPU, far, 20k, 3 iterations, p50 / p95 ms):

| | cold | warm | filter |
|---|---|---|---|
| server | 1331 / 9031 | 1105 / 1148 | 193 / 237 |
| client | 13613 / 16212 | 10727 / 15006 | 107 / 228 |
| worker | 2481 / 2707 | 2541 / 2701 | 89 / 130 |

The client's 13 s cold load came from 25k structured clones into IndexedDB, about 9 s of main-thread
time at 6×. In the worker variant the same work happened off the main thread, so the page did not
wait for it, but the cache took 3.9 s to become warm.

## Optimisation pass

| # | Change | Effect |
|---|---|---|
| 1 | IndexedDB stores each server response as its raw JSON text, one record per snapshot or delta, instead of one record per row | Client cold load at 6× without shaping: 11–13 s → 2.4 s. Warm load: 10.7 s → 1.5 s |
| 2 | The snapshot is persisted when the browser is idle, after the first render | First rows no longer wait on IndexedDB |
| 3 | Deltas append a record; past 50 records, the next visit replaces them with one snapshot | A warm load reads a bounded number of records |
| 4 | Server: a partial covering index `issue_list(state, updated_at DESC, id DESC, title) WHERE kind='issue' AND is_stub=0`, a unary `+i.id IN (…)` so the planner keeps that index, and a deferred join (page the ids, then build only those rows) | Queries at 50k: 80–160 ms → 15–50 ms. The 100-row page takes under 1 ms; the rest is `count(*)` |
| 5 | The total is counted only for offset 0 | Scrolling to later pages skips the count |
| 6 | SQLite built without `SQLITE_ENABLE_MEMORY_MANAGEMENT` and with memory statistics off (`server/.cargo/config.toml`) | Connections stop serialising each other; see "SQLite concurrency" |
| 7 | Covering index `item_cache` for the snapshot | Snapshot SQL at 50k: 374 → 260 ms; no body pages read, no sort |
| — | Tried FTS5 trigram for search | Rejected: scanning the covering index for `instr(lower(title), …)` costs about 9 ms at 50k |

## Results

p50 / p95 ms on the far network. "Cache warm" means the snapshot is persisted to IndexedDB.

### Low device (6× CPU)

| | 20k server | 20k client | 20k worker | 50k server | 50k client | 50k worker |
|---|---|---|---|---|---|---|
| cold | **1026 / 1246** | 2643 / 2886 | 1838 / 1920 | **980 / 1092** | 4084 / 4405 ✗ | 2928 / 3226 ✗ |
| cache warm | — | 2833 / 3099 | 1897 / 1968 | — | 4415 / 4761 | 2974 / 3289 |
| warm | **1040 / 1186** | 1599 / 1746 | 1111 / 1232 | **969 / 1045** | 2097 / 2344 | 1155 / 1410 |
| filter | 189 / 234 ✗ | **72 / 148** | 80 / 128 | 177 / 206 ✗ | **66 / 128** | 75 / 120 |
| scroll frame p95 | 50 | 50 | 50 | 33.4 | 50 | 33.4 |
| live | 189 / 221 | 174 / 210 | 158 / 177 | 179 / 203 | 220 / 254 | 171 / 195 |
| tab PSS, cold | 70 MB | 90 MB | 93 MB | 69 MB | 131 MB | 125 MB |
| main-thread JS heap | 2.7 MB | 17 MB | 2.7 MB | 2.7 MB | 35 MB | 2.7 MB |

### Fast device

| | 20k server | 20k client | 20k worker | 50k server | 50k client | 50k worker |
|---|---|---|---|---|---|---|
| cold | **421 / 447** | 1243 / 1336 | 1330 / 1389 | **419 / 460** | 2601 / 2746 | 2449 / 2541 |
| warm | **260 / 282** | 330 / 429 | 348 / 414 | **257 / 273** | 478 / 555 | 454 / 547 |
| filter | 123 / 130 | **12 / 18** | 28 / 36 | 122 / 128 | **13 / 21** | 28 / 37 |
| live | 129 / 149 | 124 / 133 | 130 / 144 | 127 / 137 | 129 / 139 | 130 / 143 |

Scroll stayed at a p95 of 16.7 ms on the fast device for all variants. Tab PSS on the warm load
(160–240 MB) was about the same for every variant, including the server variant, so it reflects the
reused browser profile and does not separate the variants. The cold-load PSS is the fair comparison.
The JS heap metric cannot see a worker's heap.

### Server load (`./bench/load`)

The first load run used the stock rusqlite build, one mirror shared by every user, and a
container with 1 CPU. It showed server-side filtering at 20 users × 50k with a p95 of 4.1 s, and
5 users cold-loading snapshots at once queueing for 7 s. Most of that was not the work itself:
SQLite serialised every connection in the process (see "SQLite concurrency" below). The runs below
were made after fixing that. The original numbers are in
`results/2026-10-15-141701-load-filtering-server` and `…-142505-load-filtering-client`.

Each run uses 20 users, p50 / p95 ms, and the server's mean / peak CPU (100% = one core).
"Shared" means one mirror for every user. "Per user" is beghu's real shape: one mirror per
account, each user its own account (`x-account`), and every webhook written to every mirror. The
CPU column is the container's CPU limit.

| 50k, 20 users | server variant: filter phase | server variant: live | client variant: snapshot burst |
|---|---|---|---|
| first run: shared, 1 CPU, stock SQLite, no snapshot index | 669 / 4102 · 74% / 101% | 265 / 465 | 21379 / 33320 |
| shared, 4 CPUs, stock SQLite | 83 / 485 · 114% / 257% | 99 / 170 | 6244 / 12052 |
| shared, 4 CPUs, fixed SQLite | **17 / 40** · 50% / 96% | 63 / 116 | 2950 / 5024 |
| per user, pooled, 4 CPUs | 26 / 183 · 59% / 108% | 31 / 101 | 8739 / 11768 ¹ |
| per user, connection per request, 4 CPUs | 27 / 158 · 60% / 116% | 56 / 115 | 7218 / 11478 ¹ |
| per user, pooled, 1 CPU | 59 / 263 · 56% / 100% | 287 / 392 | 31272 / 37753 ¹ |

| 20k, 20 users | server variant: filter phase | server variant: live | client variant: snapshot burst |
|---|---|---|---|
| first run: shared, 1 CPU, stock SQLite, no snapshot index | 29 / 855 · 51% / 102% | 116 / 228 | 7771 / 12280 |
| shared, 4 CPUs, stock SQLite | 17 / 40 · 42% / 100% | 60 / 103 | 1897 / 2937 |
| shared, 4 CPUs, fixed SQLite | 11 / 21 · 28% / 49% | 31 / 58 | 985 / 1351 |
| per user, pooled, 4 CPUs | 19 / 128 · 39% / 78% | 25 / 41 | 1087 / 1603 |
| per user, connection per request, 4 CPUs | 18 / 119 · 39% / 80% | 30 / 40 | 1122 / 1535 |
| per user, pooled, 1 CPU | 16 / 131 · 35% / 73% | 92 / 127 | 4028 / 5455 |

¹ Container memory reached its 512 MB limit: 20 snapshots of 7.5 MB of JSON, plus row vectors and
gzip buffers, all built at once.

Every other cell is in `results/2026-10-15-17*-load-filtering-*` and `…-18*-load-filtering-*`. At
1 and 5 users, every configuration filters with a p50 of 11–23 ms. Client-variant deltas stay at
4–19 ms in every configuration. No run had errors. The filter phase is deliberately harsh: every
user types at the same moment, one request per keystroke, with no debounce.

The browser matrix above ran on the first server build. Its single-user numbers are not affected by
lock contention; snapshots there would be about 30% faster with the snapshot index.

### SQLite concurrency

A probe (Rust, rusqlite 0.40 with its bundled SQLite, on the host with no CPU limit) ran the search
count and the snapshot query on N threads, each with its own connection:

| ops/s | 1 thread | 4 | 8 | 16 |
|---|---|---|---|---|
| search count, one 50k DB, stock build | 100 | 56 | 48 | 39 |
| search count, one 50k DB, fixed build | 114 | — | 836 | 1515 |
| snapshot SQL, one 50k DB, stock build | 2.6 | 2.2 | 2.0 | — |
| snapshot SQL, one 50k DB, fixed build + snapshot index | 3.8 | 13.1 | 23.9 | — |
| snapshot SQL, 8 separate 20k DBs, stock build | 7.0 | 6.7 | 6.3 | — |
| snapshot SQL, 8 separate 20k DBs, fixed build + snapshot index | 10.6 | 34.7 | 58.6 | 101 |

On the stock build, adding threads made throughput worse, even with each thread on its own database
file. rusqlite's `bundled` feature compiles SQLite with:

- `SQLITE_ENABLE_MEMORY_MANAGEMENT`, which makes every connection in the process share one page
  cache (`pcache1`) behind one mutex. `strace -k` put almost every `futex` call in
  `pcache1Fetch` and `pcache1Unpin`.
- Memory statistics on (`SQLITE_DEFAULT_MEMSTATUS=1`), which take another global mutex on every
  allocation. `lower()` allocates once per row, so the search count was hit hardest.

`server/.cargo/config.toml` sets
`LIBSQLITE3_FLAGS="-USQLITE_ENABLE_MEMORY_MANAGEMENT -DSQLITE_DEFAULT_MEMSTATUS=0"`, and
`STOCK_SQLITE=1` (`./bench/load … --sqlite stock`) builds without it for comparison. beghu's
real server needs the same flags, or a system SQLite built without them.

Two smaller findings:

- **Opening a connection per request costs about 2 ms.** A count on a fresh connection to a 20k
  mirror took 4.9 ms against 3.1 ms on a cached one. Under load it made no clear difference
  (above). A connection's own page cache is only 2 MB; the OS page cache is what stays warm.
- **Snapshot cost after the fixes, 50k:** 260 ms of SQL, 25 ms of JSON, and 446 ms of gzip at the
  default level (1.4 MB). gzip level 1 takes 67 ms but produces 2.1 MB. The covering index
  `item_cache` takes the SQL from 374 ms to 260 ms, because without it the scan reads every
  body page and sorts.

## What it says

- **Filtering is faster in the browser on every device, at both scales.** It takes 66–80 ms
  against 177–189 ms on the low device, and 12–28 ms against 122 ms on the fast one. The
  server's time is mostly the 100 ms round trip. Scan time barely grows from 20k to 50k. On the
  fast device the worker's postMessage hop adds about 15 ms over the main thread.
- **Loading the page is faster from the server, and that is where the crossover is.** At 20k on
  the low device, a cold load with the cache costs 0.8 s more in the worker (1.6 s more on the main
  thread). At 50k the worker costs 1.9 s more and goes over the 3 s budget. Warm loads in the
  worker stay within 0.1–0.2 s of the server, but the main-thread client loses 0.6–1.1 s, because
  parsing and decoding the cache blocks the first render.
- **The main-thread client has no advantage over the worker.** It filters 5–15 ms faster but
  loads more slowly, and at 50k it carries 35 MB of heap on the UI thread. If the cache lives in
  the browser, it belongs in a worker.
- **Server-side filtering is cheap once SQLite stops serialising connections.** With one mirror
  per account and 20 users all typing at once without a debounce, 50k filters have a p50 of 26 ms
  and a p95 of 183 ms on 4 CPUs, and 59 / 263 ms on 1 CPU. Server capacity is therefore not a
  reason to filter in the browser; the round trip is.
- **Full snapshots are the expensive request.** Each costs about 0.3 s of CPU at 50k even after the
  fixes, and gzip is the larger part. 20 at once also hit the 512 MB memory limit. Deltas cost
  4–19 ms. A full snapshot should be built once per change and served as stored, compressed bytes,
  or streamed in chunks, not rebuilt and compressed per request.
- **Per-account connections:** a small pool per account is the simple choice, and opening per
  request is also affordable (about 2 ms). The first query on an account whose mirror is not in the
  OS page cache is slow: burst p95 is 0.5–0.6 s per user against 0.06–0.09 s on a shared mirror.
  How much memory to give the mirror page cache per account is a hosting question.
- **A hybrid is indicated, but it was not built or measured.** Paint the first page from the
  server, where the server variant's cold and warm loads are the fastest. Warm a worker cache in the
  background, and answer filters from it once it is ready.

## How much cache the sync stage needs

Every non-stub row is cached, issues and PRs, without bodies: 10 small fields plus label and
assignee ids.

| | JSON | gzipped | IndexedDB (raw text) | heap once decoded |
|---|---|---|---|---|
| 20k | 2.6 MB | 555 KB | about 2.6 MB | about 15–17 MB |
| 50k | 6.5 MB | 1.4 MB | about 6.5 MB | about 35 MB |

Sync keeps a `seq` cursor. The server bumps an item's `seq` on every write and webhook, and
`/api/snapshot?since=<seq>` returns only the rows changed since the cursor. Comments and bodies stay
on the server.
