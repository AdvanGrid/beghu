# Candidate: topcoat

Throwaway benchmark candidate for
[Benchmark: topcoat (Rust, server-rendered, streamed chunks)](https://github.com/tomsjansons/beghu/issues/26).
topcoat 0.10.0 with its browser runtime, `rusqlite` (bundled SQLite) on tokio. No JS of its own:
the only browser code is topcoat's runtime plus a few `raw!` snippets.

```sh
./bench/run topcoat --profile low --net far --scale 20k
```

How the data path works:

- **Server.** One Rust binary. `src/db.rs` holds the mirror behind a mutex and a tokio broadcast
  channel of changed ids. `/webhook` and `/healthz` are plain `#[route]`s. Filtering, search and
  counting run in SQLite on every render, on a partial covering index (`bench_issue_list`); counts
  are cached per filter and the cache is dropped on every change.
- **List.** `issue_list` is a `#[shard]` that owns the filter state as signals (state, search
  text, one bool per label and assignee) and a `limit`. Clicking a chip or typing flips a signal
  in the browser; the shard reads them on the server, so topcoat re-renders it and morphs the
  result in. The rows sit in a `live!` region that calls `connected(cx)`, so after the first
  render the shard keeps a run open on topcoat's WebSocket and re-emits the rows whenever the
  broadcast fires. Filter re-renders travel over that socket too. Rows have stable `id`s. One
  delegated `@click` on the list opens a row, instead of a compiled handler per row.
- **Scroll.** The shard renders a window of at most 40 rows (36 px each) below a spacer `<li>` that
  stands in for the rows scrolled past. There is no spacer below, so the list can't scroll past rows
  the server hasn't sent. A `@scroll` handler sets the window's end to one chunk past the bottom
  visible row's chunk, and the shard re-renders that window. Only one window request is in flight at a time: the
  runtime aborts a pending render when a newer one starts, so under continuous scrolling none would
  ever land.
- **Detail.** `issue_detail` is a second shard taking the open issue id from a page-level signal
  that row clicks set. It is also a connected `live!` region, re-emitting when that issue changes.
- **Write.** Adding a label calls a `#[procedure]`. The chip for every label the issue could gain
  is pre-rendered and inert; a per-label signal flips it on in the browser at click time, before
  the procedure (and its stand-in GitHub latency) returns.
- **Push.** No app-owned WebSocket or SSE route: `live!` with `connected(cx)` over the runtime's
  socket carries every live update.

## Optimisation pass

Change log, measured locally on the release build with 6× CPU throttle, from input event to frame:

| Change | Target | Before → after | Kind |
|---|---|---|---|
| Delegated row click (`cx.hydrate` on a raw JS value) | filter, scroll | filter ~137 → ~127 ms; worst scroll long task 572 → 437 ms | fights the framework: `cx.hydrate` is undocumented |
| Server-side window of 40 rows plus one-in-flight guard | scroll | row 500 in 9.6 s with 13 long tasks → 3.4 s with 1 (max 104 ms) | documented shards and signals; the guard works around abort-latest |
| No spacer below the window | scroll | the matrix run missed row 500 in up to 20 of 20 iterations, because fast wheels outran the round trip into blank spacer → reached every time locally | a fix to the change above |
| Partial covering index plus count cache | filter, scroll at 50k | filter ~240 → ~140 ms at 50k; scroll long tasks → 0 | plain SQLite |

The fixture already ships an index named `items_list`, so the idiomatic pass's
`CREATE INDEX IF NOT EXISTS items_list` was a silent no-op; the new index has its own name.
