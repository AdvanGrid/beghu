# Solid Router 2 in the axum-solid2 port: results

One agent session, 2026-10-21, for
[Benchmark: Solid Router 2 in the axum-solid2 port](https://github.com/tomsjansons/beghu/issues/49).
Three builds of one app, same server:

- `axum-solid2`: the port as it was, no URL state.
- `axum-solid2-router`: `@solidjs/router` `2.0.0-next.41` in the shape "Live updates" chose
  (`query`, `intentPreload` + `tapPreload`, `revalidate` on each push, rows as plain `<a href>`, the
  filter in the query string, the issue at `/issues/:id`). See `README.md`.
- `axum-solid2-url`: the same URLs and preload without a router: about 40 lines of History API
  (`src/url.ts`), one delegated click listener, a 5 s preload cache in `getIssue`. See
  [its README](../axum-solid2-url/README.md).

All runs are the headline cell (6× CPU, far network, 20k), 20 iterations, locked, run back to back
and interleaved. The host was busier in some rounds than others, so compare within a round.

## JS

| | wire KB (gzip) | decoded KB |
|---|---|---|
| axum-solid2 | 24.2 | 68.6 |
| axum-solid2-router | 38.9 | 109.8 |
| axum-solid2-url | 24.8 | about 70 |

Of the router's 14.7 KB, about 10 KB is the router itself (routing, `query`, history, link claims)
and about 4.5 KB is `@solidjs/web/server-functions` plus the action layer. `createRouter` imports
the native form/action handler and the single-flight consumer statically, so they ship in an app
with no forms or server functions, and no option removes them.

## Router against no router (two interleaved rounds)

p50 / p95, ms. Round 1 then round 2 for each build.

| | axum-solid2 | axum-solid2-router | Router delta (p50) |
|---|---|---|---|
| cold | 836 / 962, 914 / 992 | 975 / 1091, 1080 / 1274 | +140 to +166 |
| warm | 731 / 770, 768 / 835 | 864 / 967, 1008 / 1342 | +133 to +240 |
| filter | 179 / 224, 197 / 258 | 219 / 270, 240 / 342 | +40 to +43 |
| scroll frames | 33.4, 50 (56 and 250 long tasks) | 50, 66.7 (382 and 557 long tasks, 8 over 100 ms) | worse |
| scroll, time to row 500 | 2488, 2853 | 3168, 3403 | +550 to +680 |
| detail | 269 / 328, 305 / 356 | 211 / 402, 246 / 357 | −58 p50, p95 level or worse |
| live | 161 / 178, 185 / 210 | 185 / 197, 198 / 235 | +13 to +24 |
| write | 43 / 59, 57 / 95 | 46 / 58, 63 / 82 | level |

A second pair of rounds, with the hand-written build in between, gave the same shape: cold +105 to
+110, warm +146, filter +14 to +23, detail −80 to −100, live level.

### Why the router costs what it does

- **Load:** the 14.7 KB of extra JS being parsed and run at 6×.
- **Filter:** a filter is a navigation. With the network out of the way (6× CPU, loopback, 16 label
  toggles) the router adds about 30 ms per click: about 20 ms for putting the filter in the URL
  through the router (`useSearchParams` setter, `pushState`, the scroll-restoration
  `replaceState`, route matching), the rest for the router just being there. The profile's largest
  router entries are its link-claim sweep (`claims.js`: `managedUrl`, `managedLinkUrl`, `new URL`
  per anchor) and `setAttribute`. Every location change re-resolves every claimed anchor to set
  `aria-current` / `data-active`, and every new row is claimed (a `new URL`) as it's created.
  Dropping the query string from row hrefs, or `replace: true` on toggles, didn't change it within
  the noise.
- **Scroll:** the same claims. Every row that scrolls in is a new anchor the router claims.
- **Detail:** faster at p50. Playwright's click moves the pointer onto the row first, so
  `intentPreload` (20 ms rest) and `tapPreload` (`pointerdown`) start the fetch ahead of the click.
  It doesn't pass the router's `pendingLinks` or anything else.

## The replacement: hand-written URL state (two interleaved rounds, after its fixes)

| | axum-solid2 | axum-solid2-url | Delta (p50) |
|---|---|---|---|
| cold | 1054 / 1163, 917 / 980 | 983 / 1124, 859 / 929 | level (−58 to −71, noise) |
| warm | 949 / 1098, 842 / 913 | 926 / 1190, 780 / 878 | level |
| filter | 182 / 219, 180 / 211 | 192 / 277, 196 / 248 | +10 to +17 |
| scroll, time to row 500 | 2607, 2575 (103 and 83 long tasks) | 2695, 2774 (130 and 153) | +88 to +199, none over 100 ms either side |
| detail | 285 / 305, 280 / 355 | 192 / 207, 197 / 249 | −88 to −93 |
| live | 182 / 200, 172 / 202 | 178 / 196, 169 / 183 | level |
| write | 60 / 66, 48 / 82 | 55 / 68, 55 / 64 | level |

The filter's +10–17 ms is `pushState` plus rewriting each visible row's `href` with the new query
string. It keeps the router build's detail win without its load, filter or scroll costs.

Two fixes it needed, both found in this session:

1. **Hover preload on `pointerover` fetched one issue per wheel step** (61 detail requests in one
   scroll), because rows scrolling under a still pointer fire `pointerover`. Starting the timer on
   `pointermove` only brings it to 1, like `intentPreload` (which already got this right).
2. **A wheel listener added to cancel that timer made every scroll wait on the main thread**
   (non-passive): row 500 came about 700 ms later at 6×. It's gone; `pointermove` alone is enough.

## Behaviour checked by hand (both URL builds)

Filter writes `?label=bug`; opening a row gives `/issues/<id>?label=bug` with `aria-current` on
the row; back closes the issue, back again clears the filter; a deep link to
`/issues/<id>?label=bug&state=closed` opens with that filter and issue. Hover then click shares one
fetch. The router claimed anchors correctly with `@solidjs/vite-plugin` next.35 (it is built
against next.50).

## Feel check (owner, 2026-10-21)

The router and hand-written builds served from devinator, used from the owner's laptop, also with
Chrome's slow 4G throttling: no difference that could be felt. Sometimes one seemed smoother, then
the other. The router's measured overhead (load, filter, scroll at 6×) isn't felt.

## Verdict

Keep Solid Router 2, as [Live updates: change push and refetch](https://github.com/tomsjansons/beghu/issues/9)
chose. If its bytes or per-anchor work ever matter (a perf budget, a long list of anchors), the
replacement is `axum-solid2-url`'s shape: History API for the same URLs, one delegated click
listener over plain anchors, preload on `pointermove` rest and `pointerdown` into a 5 s cache.

## Not checked

- Preload against the original port (no preload) by feel: only the router and hand-written builds
  were compared.
- Back/forward refilling the search box (neither build binds it back from the URL).
- `revalidate` on a key whose reader is unmounted, and `query`'s 3-minute back/forward cache.
