# Sync: hand-rolled baseline

For [Sync benchmark: hand-rolled baseline](https://github.com/tomsjansons/beghu/issues/22), the
yardstick for the other sync candidates. Forked from the filtering candidate's `hybrid` variant
([../filtering/README.md](../filtering/README.md)), which is axum + Solid 2 (RC). Throwaway: it
exists to be measured, not to start the real app.

```sh
./bench/run sync-baseline                                     # headline cell, the 8 stack scenarios
./bench/run sync-baseline --scenarios sync --iterations 10    # the sync scenarios
./bench/load sync-baseline --sync --scale all --users 1,5,20 --cpus 4
```

## What it does

The page and its first paint are the hybrid's: the first page comes from `/api/issues` (SQLite
filters), and a Web Worker's cache takes every query once it has caught up. This candidate adds
the sync layer that feeds that cache.

**Server** (`server/src/main.rs`):

- **Cursor.** Every write transaction takes the next `seq` from the mirror's `meta` table and
  stamps the rows it touches, as in
  [Mirror schema and per-account isolation](https://github.com/tomsjansons/beghu/issues/8). A
  deleted issue leaves a tombstone at its `seq`. Every snapshot and delta carries the mirror's
  `epoch`.
- **Snapshot.** `GET /api/snapshot?since=0` serves one stored, precompressed snapshot per account,
  allowed to be stale (its `seq` is inside it) and rebuilt in the background once 500 rows have
  changed. `?since=<seq>` builds a delta: changed rows and deleted ids. The small dictionaries
  (repos, labels, users) come whole, but only when one of them changed after the cursor; a
  one-issue delta is about 0.2 KB.
- **Stream.** `GET /api/sync?since=<seq>&epoch=<epoch>` is server-sent events. The first `delta`
  event carries everything after the cursor (possibly nothing), which tells the client it is
  current; then one `delta` per change. Each change's delta is built once per account, right
  after its commit, and the same bytes go to every stream at that cursor. A stream that finds a
  gap (deltas published out of order) or lags the channel builds its own from the database. A
  cursor from another epoch gets a `reset` event.
- `GET /events` (ids only) stays for a page's main thread until its cache is ready, as in the
  hybrid.
- Writes return the `seq` they were stamped with.

**Browser** (`web/src/worker.ts`, `web/src/cache.ts`):

- **One tab syncs.** Each tab's worker asks for the `beghu-sync` Web Lock at boot. The holder
  opens `/api/sync` from its cursor, applies each delta, appends it to IndexedDB and posts it on
  a `BroadcastChannel`. The other tabs apply what arrives there; one that sees a gap (a delta
  starting after its cursor) catches up over `GET /api/snapshot?since=`. When the syncing tab
  closes, the lock passes to a waiting tab, which opens the stream from its own cursor.
- **Reconnect.** On any stream error the worker closes the `EventSource` and reconnects from its
  cursor after 0.25, 0.5, then every 1 s, or at once on `online`. (`EventSource` retries
  some failures itself but gives up on a 503.)
- **IndexedDB** holds the responses as text, one record per snapshot or delta. Loading replays
  them in order and stops at the first that doesn't chain (a delta starting past the cursor), so
  a tab that took over syncing can never leave a hole. Past 50 records the syncing tab replaces
  them, 2 s later, with one record of its own state in snapshot format (rows with pending writes
  stored as the server's copy).
- **The cache** keeps rows as tuples sorted like the server's list, plus an id → row index, so a
  delta replaces each row with a binary search instead of a pass over every row.
- **Optimistic writes** go through the worker. The cache shows the row with the label added at
  once (an overlay over the server's copy), posts the write, and drops the overlay once it has
  caught up to the `seq` the server returned, or at once if the write fails. The page shows the
  label in the detail at once and puts the old detail back on failure.

**Benchmark controls** (the sync scenarios in `bench/harness/scenarios.mjs` need them):
`POST /bench/outage?ms=N` drops every sync stream and answers 503 to new ones for N ms, and
`POST /bench/fail-writes?n=N` makes the next N writes fail after the GitHub latency. The worker
marks `bench:sync-leader`, `bench:sync-open` (stream accepted) and `bench:sync-caught-up` (first
delta of a connection applied).

The worker CPU throttle is the filtering candidate's: `Cache` spins after each synchronous chunk
for `rate - 1` times as long as it took, since CDP doesn't throttle workers.

Checks used while building, against a running candidate (`./bench/serve sync-baseline`, or
the native server):

```sh
node candidates/sync-baseline/smoke.mjs http://127.0.0.1:8080           # two tabs, hand-off, write, rollback
node candidates/sync-baseline/smoke-compact.mjs http://127.0.0.1:8080 500   # 500 webhooks, then a returning tab
node candidates/sync-baseline/shaped-live.mjs http://127.0.0.1:8080 --cpu 6 --tabs 2   # behind --rtt
```

This directory holds the code after the optimisation pass. The idiomatic pass's versions of the
files it changed are in [idiomatic/](idiomatic/). Results and the change log are in
[RESULTS.md](RESULTS.md).
