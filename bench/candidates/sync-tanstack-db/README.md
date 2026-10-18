# Sync: TanStack DB

For [Sync benchmark: TanStack DB](https://github.com/tomsjansons/beghu/issues/23). Forked from
the hand-rolled baseline ([../sync-baseline/README.md](../sync-baseline/README.md)), which is the
filtering hybrid on axum + Solid 2 (RC). Throwaway: it exists to be measured, not to start the
real app.

```sh
./bench/run sync-tanstack-db --scenarios all,sync      # headline cell, the stack and sync scenarios
./bench/serve sync-tanstack-db --rtt 100 --replay      # the feel session
./bench/run sync-tanstack-db-idiomatic:persisted       # the idiomatic pass (see below)
```

## What it is

The server is the baseline's, unchanged: a stored, precompressed snapshot, `?since=` deltas, and
the `/api/sync` SSE stream, plus the bench controls. The page and its first paint are the
hybrid's. What changes is the worker's cache: the baseline's hand-written `Cache` (sorted tuples,
bitmask filters, an optimistic overlay) is replaced by TanStack DB 0.15 (`@tanstack/db`,
framework-free, so it runs in the worker).

- **One collection** (`issues`), keyed by id, holding every non-stub row with its dictionary
  indexes resolved. Its sync config is a custom adapter that only hands out `begin` / `write` /
  `commit`: the worker applies the stored snapshot, IndexedDB records, stream deltas and other
  tabs' deltas through it, one sync transaction each.
- **Queries are live queries.** Per state, a derived collection of non-PR rows with a BTree index
  on the sort key; per view and page, a live query over it with `where` (`inArray` for labels and
  assignees, `ilike` for the title), `orderBy` on the sort key and `offset` / `limit`. The total
  is a separate `count` query, counted after the page is answered and posted to the page on its
  own. Before the worker says the cache is ready it builds the default view's query; the count and
  the closed state's query follow in the background.
- **Writes are optimistic updates.** `collection.update` shows the label at once; the `onUpdate`
  handler posts it and holds the optimistic row until the cache has passed the `seq` the server
  returned. If the handler throws, TanStack DB rolls the row back.
- **Sync orchestration and persistence are the baseline's** (`web/src/worker.ts`): one tab syncs
  (Web Locks), the others follow over `BroadcastChannel`, IndexedDB keeps raw responses and is
  compacted from the collection's own state, reconnect after 0.25, 0.5 and then every 1 s.

No Solid adapter was needed. The hybrid puts the cache in a dedicated worker, and the page talks
to it in messages, so `useLiveQuery` (or a Solid 2 port of `@tanstack/solid-db`) would have
nothing to bind to. The page is the baseline's, except that a page's total may arrive after its
rows (as a separate `counted` message, so it never re-asks for the list).

The worker CPU throttle is the baseline's: every synchronous call into TanStack DB (a sync
transaction, building a live query, reading one) spins for `cpu - 1` times as long as it took.

## The idiomatic pass

[`../sync-tanstack-db-idiomatic`](../sync-tanstack-db-idiomatic) is the first pass, kept runnable
because it differs in structure, not just in a few lines. Its `persisted` variant is the
documented TanStack DB stack: the same custom sync adapter, run as the collection's own sync
(reading its cursor from sync metadata), wrapped in `persistedCollectionOptions` from
`@tanstack/browser-db-sqlite-persistence` (wa-sqlite on OPFS, `BrowserCollectionCoordinator`
for tabs), and one sorted live query per view with no limit. Its default variant is the same
without persistence. Results and the change log are in [RESULTS.md](RESULTS.md).

Checks used while building, against a running candidate (`./bench/serve sync-tanstack-db`, or
the native server):

```sh
node candidates/sync-tanstack-db/smoke.mjs http://127.0.0.1:8080           # two tabs, hand-off, write, rollback
node candidates/sync-tanstack-db/smoke-compact.mjs http://127.0.0.1:8080 500   # 500 webhooks, then a returning tab
node candidates/sync-tanstack-db/shaped-live.mjs http://127.0.0.1:8080 --cpu 6 --tabs 2   # behind --rtt
```
