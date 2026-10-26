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

## Rules

- **SQL lives only in the database crates**: `crates/sqlcheck`, `crates/dbrt`, `crates/mirror-db`,
  `crates/control-db` and `crates/fake-db` (Fake GitHub's truth). Add a named query to a schema
  crate's `queries/` (or a migration to its `migrations/`) and call the function the build
  generates for it. Clippy fails on rusqlite `prepare`/`execute`/`query_*`/`pragma*` anywhere
  else.
- **Colours come only from the token module.** Every page supports light and dark mode, and no
  colour literal appears outside the StyleX tokens (`light-dark()` vars). Until the token module
  lands with the web app, pages use system colours (`Canvas`, `CanvasText`, `GrayText`,
  `LinkText`) under `color-scheme: light dark`, never literals.
- **Check UI changes in fixture mode.** Start the stack, sign in as a fixture user
  (`./dev-ctl login <user>`), and drive the failure states with `./dev-ctl fake …` (latency,
  failing calls, down). Look at the change in both themes. `./dev-ctl reset` puts the mirrors and
  the fake back to pristine afterwards.
- **Review rules** (borrowed from solid-yield): a named error class per failure kind, thrown from
  the API layer; an `Errored` boundary above every async read, root included; writes absorb their
  own failure and roll back.
- **Tests go through public seams** (spec, "Testing Decisions"): the server's HTTP surface with
  Fake GitHub behind it, Fake GitHub's own HTTP and control surfaces, and the browser. Set state up
  through Fake GitHub or the fixture, never by writing to a mirror directly.
- **Fake GitHub models GitHub, it doesn't invent.** Response shapes follow GitHub's; when the fake
  learns an endpoint, match GitHub's documented or recorded shape and status codes.

## What only real GitHub can show

Fake GitHub can't tell you these. Check them against your own dev App (see `github-app/`) before
relying on them: GraphQL validity and point cost, real webhook timing, the install and permission
screens, SAML, hidden issues, real rate limits, and payload drift.
