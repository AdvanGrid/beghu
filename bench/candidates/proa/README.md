# Proa candidate

For [Frontend benchmark: Proa](https://github.com/tomsjansons/beghu/issues/48). Throwaway: it
exists to be measured, not to start the real app. Results, the feasibility findings, the change
log and the DX notes are in [RESULTS.md](RESULTS.md).

[Proa](https://proa.so/docs) is a Rust SSR framework on axum, with RSJS islands (Rust compiled to
JS). The feasibility step showed the server + worker hybrid can't be built in Proa without
hand-writing the worker, sync and list rendering in JS, so this is the **pure-Proa** build the
docs lead to: server-rendered pages, Turbo Drive for navigation, and two islands. It runs the 8
plain scenarios; it has no sync layer, so the sync scenarios don't apply.

```sh
./bench/run proa ...            # the idiomatic pass
./bench/run proa:o6 ...         # the optimised build
./bench/serve proa:o6           # for the feel session
```

- `app/src/db.rs`: the axum + Solid candidate's SQL and webhook handling, as plain functions.
- `app/src/pages.rs`: the list, its filters (links), lazy row frames and the detail's static parts.
- `app/src/shell.rs`: the document and the detail page (async, because of the label island).
- `app/src/search.rs`, `app/src/labels.rs`: the two RSJS islands.
- `app/src/opts.rs`: the optimisation steps, switched by `BENCH_VARIANT` (`o1`…`o6`).
- `app/public/turbo.js`: Turbo 8.0.23, vendored. `bench.js` is harness glue (`data-bench-ready`).
- `probe/`: the feasibility probe (keyed list, mutation, delegation, inbound DOM bridge).
- `tools/compare.py`: side-by-side p50 / p95 for several results directories.

The image installs `proa-cli` 0.1.3 and builds with `proa build` (the linked RSJS pipeline); the
first build takes about 15 minutes.
