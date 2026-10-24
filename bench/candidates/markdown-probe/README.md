# PROTOTYPE: markdown probe (throwaway)

Measurements for [Markdown rendering for bodies and comments](https://github.com/tomsjansons/beghu/issues/59).
Findings are in [`docs/research/markdown-rendering.md`](../../../docs/research/markdown-rendering.md).

- `github/fetch.sh`: the corpus. Six public issues, 616 comments, fetched over REST with
  `application/vnd.github.full+json`, saved to `github/data/corpus.json`. `github/gql.sh` runs the
  GraphQL cost and size runs.
- `spec/`: the cmark-gfm `spec.txt` (commit 27d942c) plus its `normalize.py`. `score.py` scores
  each renderer's `out-*.json`, and `common.py` lists failures per renderer.
- `rs/`: comrak 0.57, pulldown-cmark 0.13.5, markdown-rs 1.0.0, ammonia 4.2.4 and syntect 5.3.
  It has four modes:
  - `spec` writes each crate's output for the spec examples.
  - `bench <docs.json>` times the renderers.
  - `render <docs.json>` writes comrak output cleaned by ammonia.
  - `hl <blocks.json>` times syntect.
- `js/`:
  - `size.sh` bundles `entries/*.js` with esbuild and reports minified, gzip -9 and brotli sizes.
  - `spec-js.mjs` runs the spec examples through the JS renderers.
  - `sizes.mjs` (run it from this directory) measures markdown, HTML, compact AST, hast and
    body_html per thread.
  - `parse-speed.mjs` and `hl-speed.mjs` measure throughput.
- `web/`: a Solid 2 page with `window.run(mode, thread)`.
  - `bench.mjs [iterations]` times each render mode in Chromium at 1× and 6× CDP CPU throttle.
  - `shift.mjs` checks that colouring code doesn't move layout.

Run order: build `rs/` (`cargo build --release`), `node js/sizes.mjs`, `cd web && npx vite build && node bench.mjs 15`.
