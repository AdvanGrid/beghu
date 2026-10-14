# Candidate: SolidStart

Throwaway benchmark candidate for
[Benchmark: SolidStart](https://github.com/tomsjansons/beghu/issues/15). SolidStart 2 (Vite 8,
Nitro 3), Solid 1.9, `@solidjs/router` 1.0, `@tanstack/solid-virtual`, and `node:sqlite` on
Node 24.

```sh
./bench/run solidstart --profile low --net far --scale 20k
```

The idiomatic pass is commit `036dc61`. The optimisation pass is the commit after it; its change log
is on the ticket.

How the data path works:

- **Server.** `src/lib/server.ts` is a `"use server"` module whose functions read the mirror through
  `src/lib/db.ts`. API routes handle `/webhook`, `/healthz` and `/api/events` (server-sent events
  carrying the ids that changed). Nitro serves pre-compressed (brotli/gzip) client assets.
- **Client.** Filter state lives in the URL search params, and the filter chips are router links to
  the filtered URL. The list and the detail are router `query`s read with `createAsync`. The page is
  server-rendered with the rows a 704 px window shows, then hydrated. The list is windowed with
  TanStack Virtual, and pages of 50 rows load as the window nears the end. A live event calls
  `revalidate` on the list queries, and on the open issue when it changed.
- **Detail.** Hovering a row preloads its route (`usePreloadRoute`), so the detail fetch starts
  before the click. Comments use `content-visibility: auto`.
- **Write.** Adding a label is a form `action`. `useSubmissions` shows the label while the action
  is still pending.
