# axum + Solid candidate

Benchmark candidate for [Benchmark: Rust (axum) backend + Solid frontend](https://github.com/tomsjansons/beghu/issues/16).
Throwaway: it exists to be measured, not to start the real app.

- `server/`: axum 0.8 owns the SQLite mirror (rusqlite + r2d2), filters on the server with SQL,
  and pushes changed issue ids over server-sent events (`/events`). It serves the built SPA from
  `public/`.
- `web/`: a Solid SPA built with Vite. `createResource` per view, `@tanstack/solid-virtual` for
  the list window, infinite paging of 100 rows, and a list refetch on every SSE message.
- Types are shared one way, Rust to TypeScript, with ts-rs. After changing a struct, regenerate:

  ```sh
  cd server && TS_RS_LARGE_INT=number TS_RS_EXPORT_DIR=bindings cargo test
  ```

Run it: `./bench/run axum-solid ...` from the repo root. For local dev, `cargo run` in `server/`
with `MIRROR_PATH` pointing at a copy of `bench/data/mirror-20k.db`, and `npm run dev` in `web/`
(Vite proxies `/api` and `/events` to port 8080).
