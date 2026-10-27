# AGENTS.md

beghu v1 is being built to the spec in issue #86. Read `CONTEXT.md` for the glossary and use its
terms.

## Running the app

Run `./dev-ctl help` to learn how to start, stop and inspect the dev stack. `./dev-ctl start` runs
Fake GitHub, the server and Vite in the background in fixture mode (50k issues by default), with
no GitHub account. Read the logs with `./dev-ctl logs` and `./dev-ctl grep`; avoid `logs -f`,
which never exits. `./dev-ctl` is TypeScript run directly by Node (23.6 or newer).

## Checks

CI runs all of these; run them before you commit:

- `cargo fmt --all --check` (fix with `cargo fmt --all`)
- `cargo build --workspace --all-targets --locked`, which also runs the build-time SQL check
- `cargo clippy --workspace --all-targets --locked -- -D warnings -D clippy::disallowed_methods`
- `cargo test --workspace --locked`
- `npm --prefix tools/dev-ctl ci && npm --prefix tools/dev-ctl run typecheck` after changing `./dev-ctl`
- In `web/`: `npm ci`, then `npm run typecheck`, `npm run lint` (StyleX's rules and the colour,
  `class`/`style` and CSS-import rules in `eslint-rules.js`), `npm run test:lint` (those rules'
  and the highlight.js output reader's Node tests) and
  `npx vite build`
- `cargo test` regenerates `web/src/bindings/` (the server's wire types, through ts-rs): commit it
  with the Rust change
- The browser suite, against a running stack: `./dev-ctl start --scale 1k`, then
  `npm --prefix web run e2e` (set `DEV_APP_PORT` as for `./dev-ctl` if you changed it)

## Rules

- **SQL lives only in the database crates**: `crates/sqlcheck`, `crates/dbrt`, `crates/mirror-db`,
  `crates/control-db` and `crates/fake-db` (Fake GitHub's truth). Add a named query to a schema
  crate's `queries/` (or a migration to its `migrations/`) and call the function the build
  generates for it. Clippy fails on rusqlite `prepare`/`execute`/`query_*`/`pragma*` anywhere
  else.
- **Colours come only from the token modules** (`web/src/tokens.stylex.ts`, and
  `web/src/md/tokens.stylex.ts` for posts' Markdown and code highlighting, kept apart so its JS
  stays out of first-load JS; its CSS still goes in the one stylesheet, so nothing splits CSS).
  Every page supports
  light and dark mode: each token is a `light-dark()` pair, and `web/theme.js` sets
  `color-scheme` on `<html>`. Style elements with `{...stylex.attrs(…)}`, never a `class` or
  `style` attribute; the only CSS file is `web/src/escape.css`, one comment per rule. The lint
  enforces all three. Pages outside the web app (the server's and Fake GitHub's plain HTML pages)
  use system colours (`Canvas`, `CanvasText`, `GrayText`, `LinkText`) under
  `color-scheme: light dark`, never literals. GitHub label colours are data, not design: they
  come from GitHub per label and are exempt from the token rule (passed into a dynamic style,
  as the list's label dots do).
- **Check UI changes in fixture mode.** Start the stack, sign in as a fixture user
  (`./dev-ctl login <user>`), and drive the failure states with `./dev-ctl fake …` (latency,
  failing calls, down). Look at the change in both themes. `./dev-ctl reset` puts the mirrors and
  the fake back to pristine afterwards.
- **Review rules** (borrowed from solid-yield): a named error class per failure kind, thrown from
  the API layer; an `Errored` boundary above every async read, root included; writes absorb their
  own failure and roll back.
- **Tests go through public seams** (spec, "Testing Decisions"): the server's HTTP surface with
  Fake GitHub behind it (`crates/server/tests/`, whose `common` harness starts both on a fresh
  data dir with the 1k fixture), Fake GitHub's own HTTP and control surfaces, and the browser
  (`web/e2e/`, Playwright against the `./dev-ctl` stack). Set state up through Fake GitHub or the
  fixture, never by writing to a mirror directly.
- **The allowed exceptions**, each saying why in its file: md-ast's GFM spec conformance run
  (`crates/md-ast/src/gfm_spec.rs`, 670 examples scored on comrak's HTML), md-ast's work counts
  (`crates/md-ast/src/scaling.rs`), the server's render cache tests (the `tests`
  module of `crates/server/src/markdown.rs`), which count renders no HTTP answer shows, and the
  web's highlight.js output reader under hostile input (`web/src/md/hljs.test.ts`), which only
  ever sees highlight.js's own escaped output through the app.
- **Fake GitHub models GitHub, it doesn't invent.** Response shapes follow GitHub's; when the fake
  learns an endpoint, match GitHub's documented or recorded shape and status codes.

## What only real GitHub can show

Fake GitHub can't tell you these. Check them against your own dev App (see `github-app/`) before
relying on them: GraphQL validity and point cost, real webhook timing, the install and permission
screens, SAML, hidden issues, real rate limits, and payload drift.
