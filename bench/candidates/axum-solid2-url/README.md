# axum + Solid 2 + hand-written URL candidate

The [axum + Solid 2 port](../axum-solid2/README.md) with the same URLs as
[the Solid Router 2 build](../axum-solid2-router/README.md) but no router, for
[Benchmark: Solid Router 2 in the axum-solid2 port](https://github.com/tomsjansons/beghu/issues/49).
Throwaway: it exists to be measured.

- `src/url.ts` (about 40 lines): reads and writes `?state&label&assignee&q` and `/issues/:id` with
  the History API, and recognises an unmodified primary click on a row anchor.
- `src/App.tsx`: every view change and opened issue is a `pushState` (typing replaces), `popstate`
  sets both back. Rows are plain `<a href>`; one listener on the list handles their clicks, so
  middle click and open in new tab still work. A hover resting 20 ms or a `pointerdown` on a row
  starts its detail fetch.
- `src/api.ts`: `getIssue` keeps a preload for 5 s, as the router's `query` does. A live change or
  failed write asks fresh.
- `server/`: as `axum-solid2-router` (SPA fallback for `/issues/:id`).

Run it: `./bench/run axum-solid2-url ...` from the repo root.
