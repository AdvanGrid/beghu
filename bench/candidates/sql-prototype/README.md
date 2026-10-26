# PROTOTYPE: compile-time SQL on rusqlite, and mirrors that migrate on first use

Throwaway. Answers [Prototype compile-time SQL checks on rusqlite and a migrate-on-first-use
runner](https://github.com/tomsjansons/beghu/issues/83), which feeds [Pick the SQL library and
database layout](https://github.com/tomsjansons/beghu/issues/82).

```sh
cargo run -p proto --bin demo                 # part 1: derived types, queries on a real file, broken SQL
cargo run -p proto --bin gate                 # part 2: drive the migration gate by hand (TUI)
cargo run --release -p proto --bin timing     # in-place FTS migration at 20k / 50k
```

Files the binaries write go to `PROTOTYPE-wipe-me/`.

## Layout

| Crate | What it is |
|---|---|
| `sqlcheck` | The checker, run from `build.rs`. It applies `migrations/` to an in-memory SQLite (same bundled build, same `LIBSQLITE3_FLAGS`), prepares every query in `queries/*.sql`, and writes typed Rust to `$OUT_DIR/db.rs`. Failures are `cargo::error=<file>:<line>: …`. |
| `dbrt` | Runtime: `Filter` (what fragments compose into), the in-place / fresh-create / control runners, and `gate`: a pure state machine per account. |
| `mirror-db`, `control-db` | One crate per schema: `migrations/`, `queries/`, a two-line `build.rs`. A control query can't name a mirror table; the build fails. |
| `proto` | `demo`, `gate`, `timing`. |

## Part 1: SQL checked at build time

Query files work like sqlc: a `-- name: list_page :many` header, `-- param: state &str` lines,
then the SQL. Kinds are `:one`, `:opt`, `:many`, `:exec` and `:fragment`. Overrides go in the
alias, as in sqlx: `AS "rank!: f64"`.

- **What's checked:** tables, columns and syntax, from SQLite's own `prepare`, at the right
  `file:line`. Every `:param` must be declared and every declaration used, `*` isn't allowed,
  and every expression column needs a type. Every migration must apply to an empty database,
  which proves a fresh mirror can be created. The control schema can't have `.rebuild.sql`
  migrations. A migration that drops a column fails the build at each query that reads it. Run
  `demo` to see each message.
- **Not checked:** parameter *types*. SQLite doesn't report them, so the `-- param:` type is
  trusted, which is no worse than sqlx on SQLite.
- **Nullability rule:** a column is non-null only when it comes straight from a `NOT NULL` or
  rowid column, through a source no outer join can null out. Anything else is `Option`: outer
  joins (per alias, so `LEFT JOIN m` makes `m.*` nullable and leaves `i.*` alone), CTEs or
  subqueries with an outer join or `UNION` inside, table-valued functions, expressions, compound
  selects, unresolved aliases, views (SQLite traces their columns but not their joins), and
  every column of an aggregate query without `GROUP BY`, which returns one all-NULL row on an
  empty table. Owner review found the last two gaps; both are fixed. `demo` prints the reason for every column. The rule only fails
  in the cautious direction (an extra annotation), never with a surprise `NULL` at run time. The
  cost is a `!` on aggregates and on `bm25`/`snippet`, plus all-`Option` rows through a CTE that
  has an outer join inside (`labelled_titles`).
- **sqlx's misses, here:** `INSERT … RETURNING id` is `i64`, not `Option<i64>` (sqlx#4322). A
  `LEFT JOIN … WHERE l.name IS NOT NULL` stays `Option` for `l.name`, with `i.id` still non-null.
  sqlx turned `i.id` into unknown.
- **Filter bar:** each token is a checked `:fragment`, a predicate over `items i` checked as
  `SELECT 1 FROM items i WHERE (…)`. At run time they compose with `Filter::And/Or/Not`, and
  `/* filter */` in a checked `:many` query marks where the result goes. Only the AND/OR glue is
  unchecked, and it can't produce invalid SQL from valid predicates. Ids come back first, then a
  checked `hydrate` over `json_each(:ids)` in that order.
- **Build cost** (debug, 32 cores): clean 20 s, mostly bundled SQLite. No-op 0.06 s. Editing a
  query or a migration: 0.55 s, and the check reruns, because `rerun-if-changed` covers
  `migrations/` and `queries/`. Editing the checker: 0.85 s. Unrelated Rust: 0.3 s.
- **What sqlx needs that this doesn't:** no `DATABASE_URL`, no dev database, no `.sqlx` cache, no
  `cargo sqlx prepare --check` and no stale checks, because the schema *is* `migrations/`. Plain
  rusqlite at run time, so ~2× faster per query in the ticket #80 micro-benchmark, and rusqlite
  0.40 is usable.
- **What it costs:** about 700 lines of checker that beghu owns, with a small hand-written SQL
  lexer and FROM-clause parser deciding nullability. Unusual SQL (parenthesised join groups,
  `NATURAL` joins) falls back to `Option` or to a "couldn't line up columns" error, not to wrong
  types.

## Part 2: migrate on first use

`dbrt::gate` is pure: events (`Use`, `Opened`, `InPlaceDone`, `Recreated`, `ImportDone`,
`Tick`, `Restart`, `NightlySweep`) in, effects out. `gate` runs the effects on real files.
Mirrors track their version in `PRAGMA user_version`. The control DB uses a `_migrations` table.

| Situation | What happens |
|---|---|
| First use after a deploy, mirror behind, all in place | The first caller triggers one `BEGIN IMMEDIATE` transaction with every pending migration plus `user_version`. Requests and webhook applies wait on it; sweeps wait too. After 200 ms the account's SSE gets "Updating mirror…" (bottom-bar status slot). A request still waiting at 10 s gets a 503 and `retry-after`. |
| Two requests, a webhook and a sweep at once (`z`) | All four wait on the one migration and are all served when it commits. |
| A `.rebuild.sql` migration is pending, the file is missing, or the file is newer than the build (a rollback) | The mirror is deleted and an empty one is created at the build's version (beside the old file, then renamed over it), and the import starts. Requests are served from it straight away with "Importing", as on first sign-in. Webhooks apply to it; sweeps skip it. |
| In-place fails deterministically (bob: 0003's unique index hits duplicate rows) | The transaction rolls back and the file stays v2. Then the mirror rebuilds, since it's disposable. Nobody sees an error. |
| In-place fails transiently (`f`: disk full) | The file stays as it was, with a 30 s backoff that doubles. Requests get 503, webhooks stay queued in the control DB, and the status slot says "Mirror update failed; retrying in 30 s". The next use after the backoff retries. |
| Process stops mid-migration (deploy) | Nothing committed, so the file is unchanged; the next build starts over. |
| Dormant account (no session for 30 days) | The nightly sweep deletes its mirror instead of migrating it, but only when nothing is running or waiting on it. A request clears dormant. Webhooks for an account with no mirror are skipped, and the next sign-in imports fresh. The first version deleted a mirror mid-migration with a request waiting, which is how this rule was found. |
| Control DB | Migrated at startup, before `/readyz`, after a `VACUUM INTO` backup, all in place (no rebuild kind; the build enforces it). |
| Rollback, control DB | An older build runs on a newer control DB only if every migration it doesn't know is marked `-- compat: additive`. Otherwise it refuses to start. With a stop-then-start deploy that means downtime until you roll forward or restore the backup. |

Timing (`timing`, release, this machine): in-place v1→v3 (FTS over title and ~600-byte bodies, plus
the unique index) takes 336 ms at 20k items and 782 ms at 50k, so requests on a big mirror cross
the 200 ms status line but finish well inside the 10 s timeout. A fresh create (empty schema) takes
35 ms, and reading `user_version` well under 1 ms.

## For the owner to react to

1. Are build-time checks from your own migrations (no dev database) worth owning ~700 lines of
   checker, compared with sqlx's `query!` plus `.sqlx`?
2. The nullability rule: is `Option` on everything without a proven `NOT NULL` origin
   acceptable, with `!` overrides?
3. Fragments plus `/* filter */` for the filter bar: is checking each token, and leaving only the
   glue unchecked, enough?
4. Should a deterministic in-place failure silently fall back to a rebuild (3–4 min import), or
   should it show an error?
5. Dormant mirrors: delete them at 30 days, or keep migrating them forever?
6. A control rollback past a non-additive migration means refusing to start: accept that, or
   require every control migration to be additive (expand/contract)?

## Verdict (owner, 2026-10-26)

1. **Home-grown checker on rusqlite, yes:** it avoids sqlx's open problems (nullability guesses,
   the `libsqlite3-sys` cap, `.sqlx` upkeep, stale checks).
2. **The nullability rule is accepted.** `!` can't be eliminated, but the cautious-side `Option`s
   could be narrowed later (`count(*)`, `coalesce(x, literal)`, `IS NOT NULL` filters).
3. **Fragments for the filter bar, yes.**
4. **A failed in-place migration is an error, not a rebuild.** The prototype's fall-back to a
   rebuild is overruled: the file stays as it was and the account shows the error. Rebuilds happen
   only for `.rebuild.sql` migrations and missing files.
5. **Dormant accounts move to their own ticket**, together with their webhooks.
6. **Production only rolls forward.** A build that finds a database newer than itself refuses to
   start. The rollback paths here (mirror newer than the build, control `-- compat: additive`)
   are dropped.
