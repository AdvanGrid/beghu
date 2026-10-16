# Filtering location: server, client, worker

For [Benchmark: client-side vs server-side filtering at 20k and 50k issues](https://github.com/tomsjansons/beghu/issues/20).
Forked from [axum-solid2](../axum-solid2/README.md), the chosen framework. Throwaway: it exists to
be measured, not to start the real app.

One server and one Solid app, three variants picked by `BENCH_VARIANT` (each its own HTML entry and
JS chunk, so the server variant ships none of the cache code):

| Variant | Where the list comes from |
|---|---|
| `server` | `GET /api/issues` on every change of the view: SQLite filters, returns 100 rows plus the total count. Scrolling fetches more pages. |
| `client` | Every non-stub row (issues and PRs, no bodies) is held on the main thread. A query is a scan of an in-memory list kept newest first, with a lowercased title per row as the search index. |
| `worker` | The same cache and scan inside a Web Worker. The main thread asks it for one page at a time, as the server variant asks the server. |

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

For `./bench/load`, `BENCH_ACCOUNTS=N` gives the server N mirrors (copies of the harness's, picked
by the `x-account` header; webhooks are written to all of them), and `BENCH_CONN=open` opens a
connection per request instead of a pool per account. SQLite is built with the flags in
`server/.cargo/config.toml`: rusqlite's defaults serialise every connection in the process (see
`OPTIMISATION.md`). The `STOCK_SQLITE=1` build arg builds with those defaults instead.

`idiomatic/` keeps the first pass of `web/src/cache.ts` and `server/src/main.rs`. `OPTIMISATION.md`
has the idiomatic and optimised passes and the results.

```sh
./bench/run filtering:server --profile all --scale all --scenarios cold,warm,filter,scroll,live
./bench/run filtering:client ...
./bench/run filtering:worker ...
./bench/load filtering:server --scale all --users 1,5,20 --cpus 4
./bench/load filtering:server --scale all --users 1,5,20 --cpus 4 --accounts shared --sqlite stock
```
