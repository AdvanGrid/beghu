# Solid 2 port: idiomatic pass, optimisation pass, and the 1.9 comparison

One agent session, run on 2026-10-15, for
[Check the Solid 2 RC works with the libraries the axum + Solid app needs](https://github.com/tomsjansons/beghu/issues/43).
All numbers are the headline cell (6× CPU, far network, 20k), 20 iterations, locked runs on this
host. The bar was: not slower than the 1.9 build.

## Idiomatic port

`createResource` became async memos, `<Suspense>` became `<Loading>`, the view stayed a store
(draft setters), and the label write was an `action` over `createOptimistic`, as the Solid 2
cheatsheet shows. JS: 34.2 KB wire / 99.1 KB decoded, against 17.5 / 51.7 KB for 1.9.

| p95 (ms) | 1.9, run just after | Solid 2 idiomatic |
|---|---|---|
| cold | 782 | 899 |
| warm | 638 | 790 |
| filter | 190 | 209 ✗ |
| scroll frames | 33.4 (39 long tasks, max 78) | 33.4 (32 long tasks, max 75) |
| detail | 280 | 296 |
| live | 174 | 171 |
| write | 56 | 73 |

## Optimisation pass

| # | Change | Effect | Documented or fought |
|---|---|---|---|
| 1 | The view as one immutable signal instead of a store | JS 35.1 → 24.7 KB gzipped: the store module is the largest single source in the runtime | Documented APIs; gives up draft setters for four fields |
| 2 | The detail pane as a writable async memo (`createSignal(fn)`); the optimistic label is a plain write, and a failed write re-asks the server | write p95 73 → 53 | Documented API, but not the cheatsheet's optimistic pattern (`action` + `createOptimistic`), which reverts on failure for free |

## Back to back against 1.9 (optimised port)

Runs interleaved, 2 × each, cold/warm/filter/write; detail, live and scroll from one full run.

| ms | 1.9 (p50 / p95) | Solid 2 (p50 / p95) | Gap (p50) |
|---|---|---|---|
| cold | 640–646 / 704–715 | 722–765 / 816–903 | +80 to +125 |
| warm | 565–593 / 615–676 | 648–664 / 713–758 | +55 to +100 |
| filter | 164–167 / 192–194 | 169–174 / 195–198 | +2 to +10 |
| write | 36–38 / 48–55 | 42–44 / 51–52 | +5 |
| detail | 248 / 280 | 256 / 279 | level |
| live | 159 / 174 | 157 / 168 | level |
| scroll frames | 33.4 | 33.4 | level |

**Verdict: slower on load.** Cold and warm load lose about 60–120 ms at 6×, which is the larger
runtime (24.7 KB vs 17.5 KB of JS, about 70 KB vs 52 KB decoded) being parsed and run. On the
owner's laptop unthrottled, 6× is roughly a 5× stress, so this is about 15–25 ms there. Filter and
write are a few ms slower at p50, inside the noise at p95. Nothing app-side is left to cut: what
remains is `@solidjs/signals` (core, scheduler, lanes, async), `@solidjs/web` and virtual-core.

## Not checked

- Dev-mode diagnostics (`STRICT_READ_UNTRACKED`, owned writes): only the production build was run.
- `@solidjs/router` 2.0.0-next.40 is installable but isn't wired into the app.
