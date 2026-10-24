# PROTOTYPE: comment thread size probe (throwaway)

How many comments an issue detail can carry and still go from click to paint in about 200 ms.
Findings are in [`docs/research/comment-thread-size.md`](../../../../docs/research/comment-thread-size.md).

- `fetch-agents.sh`: fetches five public PR/issue threads with heavy bot traffic (`gh api`) into
  `data/raw/`, and writes `data/agents.json` (109 bot comments of 1.5–40 KB) and
  `data/kandev-2669.json` (one whole 744-comment agent PR thread, in order).
- `rs/`: the server path as decided: comrak 0.57 → ammonia 4.2.4 → compact AST JSON, walked
  straight off ammonia's tree (needs `--cfg ammonia_unstable`, set in `rs/.cargo/config.toml`). Its
  output is byte-identical to `../js/compact.mjs` on all 653 corpus docs. `asts <docs.json>` and
  `time <thread.json> [reps]`.
- `build.mjs`: builds threads of N = 10…800 for human (`../github/data/corpus.json`), agent and a
  50/50 mix, plus the real kandev thread, into `data/threads/`; times the server path and gzip-6 /
  brotli-4/5; writes `data/build.json`.
- `web/`: a Solid 2 page (`window.go(k)`): `JSON.parse` + the compact-AST walker + layout + next
  frame, all comments or first + newest k. `?cv` adds `content-visibility: auto` per comment,
  `?nocss` drops the stylesheet. `node_modules` is a symlink to `../../web/node_modules`.
- `client.mjs [regex]`: times every thread at 1× and 6× CDP throttle → `data/client*.json`
  (`CV=1`, `NOCSS=1`, `KS=0,10,20` select variants).
- `diag.mjs`: English-only and Chinese-heavy agent threads (`agentEN-*`, `agentZH-*`).
- `model.mjs`: the transfer model (slow start from initcwnd 10, or a warm window) and the
  click → paint tables. `shapecheck.mjs` checks the warm model through `bench/shape`.
- `split.mjs [budget]`: what a byte-budgeted first response (first + newest that fit) holds.

Run order: `./fetch-agents.sh`, `(cd rs && cargo build --release)`, `node build.mjs`,
`node diag.mjs`, `(cd web && npx vite build)`, `node client.mjs`, `CV=1 KS=0 node client.mjs`,
`node model.mjs`, `node shapecheck.mjs`, `node split.mjs`.
