# Candidate: SolidStart

Throwaway benchmark candidate for
[Benchmark: SolidStart](https://github.com/tomsjansons/beghu/issues/15). SolidStart 2 (Vite 8,
Nitro 3), Solid 1.9, `@solidjs/router` 1.0, and `node:sqlite` on Node 24.

```sh
./bench/run solidstart --profile low --net far --scale 20k
```

How the data path works:

- **Server.** `src/lib/server.ts` is a `"use server"` module whose functions read the mirror through
  `src/lib/db.ts`. API routes handle `/webhook`, `/healthz` and `/api/events` (server-sent events
  carrying the ids that changed).
- **Client.** Filter state lives in the URL search params. The list and the detail are router
  `query`s read with `createAsync`. The page is server-rendered with the first page of rows, then
  hydrated. Pages of 100 rows load as you scroll. A live event calls `revalidate` on the list
  queries, and on the open issue when it changed.
- **Write.** Adding a label is a form `action`. `useSubmissions` shows the label while the action
  is still pending.
