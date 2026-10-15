# axum + Solid 2 candidate

The [axum + Solid candidate](../axum-solid/README.md) ported to the Solid 2 release candidate, for
[Check the Solid 2 RC works with the libraries the axum + Solid app needs](https://github.com/tomsjansons/beghu/issues/43).
Throwaway: it exists to be measured, not to start the real app.

- `server/`: unchanged from `axum-solid` (same binary name, same SQL, same SSE).
- `web/`: Solid `2.0.0-rc.15` with `@solidjs/web` and `@solidjs/vite-plugin` (the renamed
  `vite-plugin-solid` 3.x). What changed from the 1.9 build:
  - `createResource` → async computations. The list is a writable async memo
    (`createSignal(() => getIssues(...))`): a new view or a live change re-runs it, and paging
    appends by writing to it. The detail pane is the same shape, so the optimistic label is a plain
    write.
  - `<Suspense>` → `<Loading>`, plus an `<Errored>` around the detail pane.
  - `@tanstack/solid-virtual` → `src/virtual.ts`, about 40 lines over `@tanstack/virtual-core`.
    solid-virtual 3.x imports `mergeProps`, `onMount`, `createComputed` and `solid-js/store`, none
    of which Solid 2 exports.
  - The view is one immutable signal, not a store: the store module alone added about 10 KB gzipped.
  - Booleans are presence/absence in Solid 2, so `aria-pressed` takes the strings `"true"`/`"false"`.

`OPTIMISATION.md` has the idiomatic port, the one optimisation pass, and the back-to-back runs
against the 1.9 build.

Run it: `./bench/run axum-solid2 ...` from the repo root.
