# Sync: TanStack DB, idiomatic pass

The first pass of [Sync benchmark: TanStack DB](https://github.com/tomsjansons/beghu/issues/23),
kept runnable next to the optimised candidate in [../sync-tanstack-db](../sync-tanstack-db), whose
README and RESULTS.md describe both. Throwaway.

```sh
./bench/run sync-tanstack-db-idiomatic:persisted   # the idiomatic pass: TanStack DB's SQLite persistence
./bench/run sync-tanstack-db-idiomatic             # the same without persistence (optimisation change 1)
```

- `web/src/db.ts`: one `issues` collection whose own sync config runs the baseline's wire
  (stored snapshot, then `/api/sync` deltas; cursor in sync metadata), an `onUpdate` handler that
  waits for the write's `seq`, and one sorted live query per view, unlimited.
- `web/src/worker-persisted.ts` (served as `/` when `BENCH_VARIANT=persisted`): the same
  collection wrapped in `persistedCollectionOptions` (wa-sqlite on OPFS) with a
  `BrowserCollectionCoordinator`. `web/src/worker.ts`: in memory, every tab syncs on its own.
- `server/`: the baseline's, plus the route that serves `persisted.html`.
