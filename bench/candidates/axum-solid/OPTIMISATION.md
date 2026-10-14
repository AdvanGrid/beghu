# Optimisation pass: change log

One agent session, run on 2026-10-14. Before/after numbers are unlocked 5-iteration smoke runs of
the headline cell (low CPU, far network, 20k) that overlapped another candidate's locked matrix run.
Use them for direction only; the recorded numbers come from the full matrices.

| # | Target | Change | Before (p95) | After (p95) | Documented feature or fought the framework |
|---|---|---|---|---|---|
| 1 | Filter | Label and assignee filters as `i.id IN (SELECT item_id ... WHERE label_id IN ...)` instead of correlated `EXISTS`, plus two covering indexes (`item_labels(label_id, item_id)`, `item_assignees(user_id, item_id)`) and `ANALYZE` at startup. SQL over all 8 labels × 8 assignees × 2 states: mean 42.5 → 9.8 ms, worst 97 → 28 ms on the host. Label-only queries got slower (0.9 → up to 27 ms) but stay small. | filter 1689 (assignee 2098, state 1689) | filter 234 (assignee 173, state 160) | Documented (plain SQLite indexing, nothing framework-specific) |
| 2 | Scroll | Tried `<Index>` over `getVirtualItems()` instead of the documented `<For>`. | 42 long tasks, max 69 ms | 218 long tasks, 46 > 100 ms | Reverted: every row's signals shift on each scroll |
| 3 | Scroll | Render the window as one `translateY` wrapper around rows in normal flow, with `<For>` keyed by the resource's row objects. Rows that stay in the window keep their DOM node. | 218 long tasks (after #2) | 74 long tasks, 0 > 100 ms, frames p95 50 | Fought the docs a little: the `@tanstack/solid-virtual` example uses `<For>` over the virtual items |
| 4 | Scroll | `contain: strict` on rows, `will-change: transform` on the wrapper | 74 long tasks, max 98 ms | 28 long tasks, max 74 ms, frames p95 still 50 | Documented CSS |
| 5 | Cold/warm load | `<link rel=preload as=fetch>` for `/api/facets` and the first page | warm 814 | warm 686 | Documented web platform feature |

## Where the remaining time goes

- **Filter (search p95 about 230 ms against 200).** Every keystroke is a server round trip. At
  100 ms RTT plus about 25 KB of JSON at 10 Mbps, the network alone takes 120 ms or more before
  Solid renders. A fix would filter on the client, which is the question for the
  filtering-location benchmark. A rough cost would be a day for a client-side index over the 20k
  rows, plus the memory budget to hold them.
- **Scroll frames (p95 50 ms, which is three 16.7 ms frames).** The CPU profile at 6× shows about
  10% JS. The rest is browser style, layout and paint. The stub, with no windowing, sits at 66 ms
  on the same host. A further gain probably needs fewer DOM nodes per row or a canvas list, which
  isn't worth it before the old-laptop check confirms that 6× is the right throttle.
- **Detail (p95 about 290 ms against 300).** One round trip plus rendering 30 comments. Prefetching
  on hover or pointerdown, as Solid Router's `preload` does, would hide most of the RTT. Not done.
