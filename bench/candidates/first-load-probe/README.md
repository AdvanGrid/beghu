# first-load probe (throwaway)

A copy of [axum-solid2-router](../axum-solid2-router/README.md) for the first-load research
(`docs/research/first-load.md`). Only the server's `/` handler differs; `BENCH_VARIANT` picks:

- `preload` (default): the static shell with `<link rel=preload as=fetch>` for facets and the first
  list page, `Cache-Control: no-cache`.
- `nopreload`: the same shell without the preload links.
- `cached`: the preload shell with `Cache-Control: max-age=600`, so a warm load skips the HTML request.
- `inline`: the shell rendered per request with facets and the first 100 rows seeded into Solid
  Router's `query` cache through `globalThis._$HY.r` (read by `takeHydrationValue`),
  `Cache-Control: private, no-cache`.

Run it: `./bench/run first-load-probe:inline --scenarios cold,warm`.
