# Filtering location: server, client, worker, hybrid

For [Benchmark: client-side vs server-side filtering at 20k and 50k issues](https://github.com/tomsjansons/beghu/issues/20).
Forked from [axum-solid2](../axum-solid2/README.md), the chosen framework. Throwaway: it exists to
be measured, not to start the real app.

One server and one Solid app, four variants picked by `BENCH_VARIANT` (each its own HTML entry and
JS chunk, so the server variant ships none of the cache code):

| Variant | Where the list comes from |
|---|---|
| `server` | `GET /api/issues` on every change of the view: SQLite filters, returns 100 rows plus the total count. Scrolling fetches more pages. |
| `client` | Every non-stub row (issues and PRs, no bodies) is held on the main thread. A query is a scan of an in-memory list kept newest first, with a lowercased title per row as the search index. |
| `worker` | The same cache and scan inside a Web Worker. The main thread asks it for one page at a time, as the server variant asks the server. |
| `hybrid` | For [Benchmark: server + worker hybrid filtering](https://github.com/tomsjansons/beghu/issues/47). The first page comes from `/api/issues`, as in `server`. After that paint it starts the `worker` variant's worker, and once the worker's cache has caught up (`bench:cache-ready`) every query goes to it. The server serves `since=0` from a stored, precompressed snapshot. |

The App (`web/src/App.tsx`) is the same for all three; only its `Source` (`web/src/source-*.ts`)
differs. The client and worker variants share `web/src/cache.ts`:

- **First visit:** `GET /api/snapshot?since=0`: compact rows (`[id, number, repo, is_pr, title,
  open, updated_at, comments, labels, assignees]`) plus small dictionaries for repos, labels and
  users. 2.6 MB of JSON at 20k (555 KB gzipped), 6.5 MB at 50k (1.4 MB gzipped).
- **Later visits:** read IndexedDB, render, then ask for `?since=<seq>`, the delta.
- **Live:** server-sent events trigger the same delta request. The server bumps an item's `seq` on
  every write and webhook.
- Detail, comments and writes go to the server in every variant.

The cache marks `bench:cache-start` and `bench:cache-warm` (snapshot persisted to IndexedDB), and
the harness records the time to `bench:cache-warm` on cold loads.

**Hybrid switchover** (`web/src/source-hybrid.ts`): the source remembers the view and row ids on
screen. When the worker is ready, it asks the worker for the same rows. If they match, nothing
re-renders (`bench:switch-same`). If not, it refetches as on a live change (`bench:switch-differs`).
Live updates come from the main thread's event stream until the switch, then from the worker's.

**Stored snapshot** (`server/src/main.rs`, hybrid only): at startup the server builds each
account's full snapshot once, as gzip and brotli bytes. Every `since=0` request gets those bytes
without touching SQLite. The snapshot is allowed to go stale: its `seq` is inside it, so the
browser asks for the delta since then. A background job rebuilds it once
`BENCH_SNAPSHOT_REBUILD` rows (default 500) have changed since it was built.

**Worker CPU throttle:** CDP's CPU throttle doesn't reach workers (see `bench/README.md`), so the
worker reads the harness's rate from its name (`cpu=6`) and `Cache` spins after each parse,
decode and scan for `rate - 1` times as long as it took.

For `./bench/load`, `BENCH_ACCOUNTS=N` gives the server N mirrors (copies of the harness's, picked
by the `x-account` header; webhooks are written to all of them), and `BENCH_CONN=open` opens a
connection per request instead of a pool per account. SQLite is built with the flags in
`server/.cargo/config.toml`: rusqlite's defaults serialise every connection in the process (see
`OPTIMISATION.md`). The `STOCK_SQLITE=1` build arg builds with those defaults instead.

`idiomatic/` keeps the first pass of `web/src/cache.ts` and `server/src/main.rs`. `OPTIMISATION.md`
has the idiomatic and optimised passes and the results for server, client and worker, and
`HYBRID.md` those for the hybrid, with the worker variant re-run under the worker throttle.

```sh
./bench/run filtering:server --profile all --scale all --scenarios cold,warm,filter,scroll,live
./bench/run filtering:client ...
./bench/run filtering:worker ...
./bench/run filtering:hybrid --profile all --scale all --scenarios cold,warm,filter,early,scroll,live
./bench/load filtering:server --scale all --users 1,5,20 --cpus 4
./bench/load filtering:server --scale all --users 1,5,20 --cpus 4 --accounts shared --sqlite stock
```
