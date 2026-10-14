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
  counting run in SQLite on every render.
- **List.** `issue_list` is a `#[shard]` that owns the filter state as signals (state, search
  text, one bool per label and assignee) and a `limit`. Clicking a chip or typing flips a signal
  in the browser; the shard reads them on the server, so topcoat re-renders it and morphs the
  result in. The rows sit in a `live!` region that calls `connected(cx)`, so after the first
  render the shard keeps a run open on topcoat's WebSocket and re-emits the rows whenever the
  broadcast fires. Filter re-renders travel over that socket too. Rows have stable `id`s.
- **Scroll.** Only the first 20 rows render. A `@scroll` handler bumps `limit` by 20 when the list
  nears its end, and the shard re-renders with the longer list.
- **Detail.** `issue_detail` is a second shard taking the open issue id from a page-level signal
  that row clicks set. It is also a connected `live!` region, re-emitting when that issue changes.
- **Write.** Adding a label calls a `#[procedure]`. The chip for every label the issue could gain
  is pre-rendered and inert; a per-label signal flips it on in the browser at click time, before
  the procedure (and its stand-in GitHub latency) returns.
- **Push.** No app-owned WebSocket or SSE route: `live!` with `connected(cx)` over the runtime's
  socket carries every live update.
