# axum + Solid 2 + Solid Router 2 candidate

The [axum + Solid 2 port](../axum-solid2/README.md) with `@solidjs/router` `2.0.0-next.41`, in the
shape [Live updates: change push and refetch](https://github.com/tomsjansons/beghu/issues/9) chose,
for [Benchmark: Solid Router 2 in the axum-solid2 port](https://github.com/tomsjansons/beghu/issues/49).
Throwaway: it exists to be measured.

- `src/router.ts`: `createRouter` with `/` and `/issues/:id`, `intentPreload()` + `tapPreload()`.
  The issue route's `preload` warms `getIssue`.
- `src/App.tsx` is the root layout and always mounted. The view is the query string
  (`?state=closed&label=a&label=b&assignee=x&q=…`) through `useSearchParams`; typing replaces the
  history entry. Rows are plain `<a href="/issues/:id?…">`, handled by the router's delegated
  listener. Each SSE push calls `revalidate` on the list key, and on the open issue's key.
- `src/api.ts`: every read is a `query`.
- `server/`: as `axum-solid2`, plus an SPA fallback so `/issues/:id` serves the shell.

Not bound back from the URL: the search box. The URL lags the input while a navigation settles,
and writing it back would drop keys typed in between. So back/forward doesn't refill it.

Run it: `./bench/run axum-solid2-router ...` from the repo root.
