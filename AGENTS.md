# AGENTS.md

The v1 workspace is being built (spec: issue #86). There's no dev server yet; `./dev-ctl`
arrives with #88. Until then:

- `cargo build --workspace --all-targets --locked` builds everything, including the build-time SQL check.
- `cargo test --workspace --locked` runs the tests.
- `cargo clippy --workspace --all-targets --locked -- -D warnings -D clippy::disallowed_methods` is the lint CI runs.
- `cargo fmt --all` formats the code; CI runs `cargo fmt --all --check`.

SQL lives only in the database crates (`crates/sqlcheck`, `crates/dbrt`, `crates/mirror-db`,
`crates/control-db`). Add a named query to a schema crate's `queries/` (or a migration to its
`migrations/`) and call the function the build generates for it. Clippy fails on rusqlite
`prepare`/`execute`/`query_*`/`pragma*` anywhere else.

Every page must support both light and dark mode. Pair each color utility with a `dark:` variant
(e.g. `bg-white dark:bg-zinc-950`). Dark mode is class-based: `web/theme.js` toggles `.dark` on
`<html>` from the light/dark/system switch.
