# Compile-time checked SQL and migrations for beghu's SQLite

Research date: 2026-10-25. Ticket #80. Sources: crate READMEs and docs.rs pages, the sqlx source
at tag `v0.9.0` (cloned today; paths below are relative to that checkout), the crates.io API
(`https://crates.io/api/v1/crates/<name>` and `/<name>/<version>/dependencies`) for versions,
dates, licences and dependency ranges, the GitHub API for repo and issue state, the sqlc
language-support page, and the SQLite docs. Issue numbers like `sqlx#4322` are in
`github.com/transact-rs/sqlx` (sqlx moved there from `launchbadge/sqlx` after 0.9.0).

Labels: **verified** means observed in an experiment today; **documented** means the crate's docs,
source or changelog say so; **reported** means an open issue says so; **inferred** means
reasoning only.

Experiments (all in the session scratchpad, nothing in the repo):

- A two-crate cargo workspace (`mirror`, `control`) on sqlx 0.9.0 with `sqlite`, `macros`,
  `migrate`, `sqlx-toml`, `json`, plus `libsqlite3-sys = 0.37` (`bundled`) and the same
  `.cargo/config.toml` as `bench/candidates/filtering/server`
  (`LIBSQLITE3_FLAGS = "-USQLITE_ENABLE_MEMORY_MANAGEMENT -DSQLITE_DEFAULT_MEMSTATUS=0"`). The
  mirror schema is a cut-down `items` / `labels` / `item_labels` / `item_assignees` / `repos` /
  `users` with an external-content FTS5 table `items_fts`. The control schema has `accounts` and
  `preferences`.
- `sqlx-cli` 0.9.0 installed with `--features sqlite,sqlx-toml`.
- A release-mode micro-benchmark of sqlx against rusqlite 0.39 (same `libsqlite3-sys` 0.37, same
  SQLite build) on a generated 50k-item mirror, and `EXPLAIN QUERY PLAN` runs in the `sqlite3`
  CLI (3.54.0) on the same file.
- Only sqlx was tried hands-on. Diesel, sea-query, bsql, turbosql and sqlc were read about, not
  built.

## Answers

**Recommendation: sqlx 0.9 `query!` / `query_as!` for static SQL, and sqlx's own embedded
migrator (`sqlx::migrate!`) for both schemas.** Put the mirror queries and the control queries in
two workspace crates, each with a `sqlx.toml` that renames `DATABASE_URL`. Commit each crate's
`.sqlx` directory. The filter bar uses an unchecked `QueryBuilder` that returns only item ids, and
a checked `query!` hydrates the rows. Before committing to it, re-run the ticket #20 load benchmark
on sqlx, because sqlx's per-query overhead was about 2x rusqlite's in a micro-benchmark today.

Why sqlx:

1. **It is the only maintained option that checks hand-written SQLite SQL against the real
   schema at build time.** cornucopia is Postgres-only, clorinde is archived and merged back into
   cornucopia, and sqlc's only Rust plugin (`sqlc-gen-sqlx`) lists Postgres only. Diesel checks
   its DSL against a generated `schema.rs`, not SQL text. sea-query and SeaORM build SQL and check
   nothing against a database. bsql does what sqlx does, but it is six months old with one
   author, 3 stars and 581 downloads. turbosql derives the schema from Rust structs and keeps one
   database per executable. Details are in the per-option sections.
2. **Every SQLite feature beghu needs compiles under `query!` (verified).** That covers FTS5
   `MATCH` with `bm25()` and `snippet()`, `INSERT … RETURNING`, `UPDATE … RETURNING`, upsert
   `RETURNING`, `IN (SELECT value FROM json_each(?))`, `json_group_array` subqueries, CTEs
   including `WITH RECURSIVE`, and `UNION ALL`. Function results with no column origin (`bm25`,
   `snippet`, `highlight`, `json_extract`) come back typed `NULL` and need an override such as
   `AS "rank!: f64"`. That is one annotation per expression column, and the build error tells you
   which column.
3. **Two schemas in one workspace work (verified).** `sqlx.toml` with
   `[common] database-url-var = "MIRROR_DATABASE_URL"` in one crate and `CONTROL_DATABASE_URL` in
   the other makes each crate's macros check against its own database. A control query naming
   the mirror's `items` table fails the build with `no such table: items`. Plain `DATABASE_URL` is
   ignored once a crate renames it.
4. **Many files with one schema is a runtime matter and works (verified).** One
   `static MIGRATOR = sqlx::migrate!()` ran against two mirror files, each through its own pool.
   `Migrator::run` takes any pool or connection.
5. **The custom SQLite build carries over unchanged (verified).** sqlx's `sqlite` feature builds
   the bundled `libsqlite3-sys`, which reads `LIBSQLITE3_FLAGS` the same way rusqlite's does. With
   the flags, `sqlite_compileoption_used('ENABLE_MEMORY_MANAGEMENT')` returned 0 and
   `'DEFAULT_MEMSTATUS=0'` returned 1. With `LIBSQLITE3_FLAGS=" "` they returned 1 and 0, so stock
   sqlx has the same problem ticket #20 found in stock rusqlite.
6. **Offline builds and CI work (verified).** `cargo sqlx prepare`, run inside each crate, wrote
   one JSON file per query to that crate's `.sqlx`. A clean build with no database and
   `SQLX_OFFLINE=true` took 3 s for the two crates. A changed query then failed the build with
   "no cached data for this query", and `cargo sqlx prepare --check` failed with ".sqlx is missing
   one or more queries". With neither the env var nor `SQLX_OFFLINE` set, the macros fall back to
   `.sqlx` on their own.

Main risks:

- **Throughput (verified, micro-benchmark only).** On one 50k mirror, sqlx took 1.65 ms per
  100-row page sequentially and 0.23 ms per query at 8-way concurrency. rusqlite with
  `spawn_blocking` took 0.86 ms and 0.12 ms. Point lookups were 270 µs against 130 µs
  sequentially. sqlx runs each connection on its own OS thread and sends every command and row
  batch over channels (`sqlx-sqlite/src/connection/worker.rs`). Whether that doubling shows up
  next to ticket #20's 183 ms p95, which the query itself dominates, is not known yet.
- **Nullability inference is imperfect in both directions.** Too-nullable costs an annotation:
  `INSERT … RETURNING id` on an `INTEGER PRIMARY KEY` came back `Option<i64>` (verified; open
  regression sqlx#4322 from 0.9's rowid fix), and a `LEFT JOIN … WHERE l.name IS NOT NULL` turned
  `i.id` into "unknown", that is `Option`. Too-strict fails at run time with `UnexpectedNull`.
  sqlx#3202 (open) reports this for queries with several `LEFT JOIN`s. The docs say SQLite
  inference "is more fragile". Every LEFT JOIN query needs a test that runs it on rows where the
  join misses.
- **`libsqlite3-sys` lag.** sqlx 0.9.0 accepts `libsqlite3-sys` `>=0.30.1, <0.38`. rusqlite 0.40
  needs `^0.38`, so sqlx 0.9 and rusqlite 0.40 cannot be in one dependency tree. Cargo refuses
  with the `links = "sqlite3"` conflict (verified). That rules out `r2d2_sqlite` 0.35,
  `deadpool-sqlite` 0.14, `tokio-rusqlite` 0.8 and `rusqlite_migration` 2.6 next to sqlx 0.9.
  rusqlite 0.39 does share `libsqlite3-sys` 0.37 with sqlx (verified). sqlx `main` already allows
  `<0.39`, but that is unreleased, and the same lag has come up four times (sqlx#4160, #4241,
  #4379, #4402).
- **Release cadence.** 0.8.6 came out on 2025-05-19 and 0.9.0 on 2026-05-21, with no 0.9.x patch
  in the five months since. `main` is active (54 commits since 2026-04-25).
- **Stale checks after schema edits (verified).** Cargo does not watch the dev database. After
  dropping `labels.color` from the dev database, `cargo check` still passed until a source file was
  touched. The docs suggest a `build.rs` with `cargo:rerun-if-changed=migrations`. beghu should
  pair that with a script that rebuilds the dev databases from the migrations.

Open questions for the owner are at the end.

## 1. sqlx 0.9 in detail

### How checking works (documented, verified)

`query!` sends the SQL to a real SQLite database at compile time and asks for a description: the
parameter count, column names, declared types and nullability. For SQLite it combines `NOT NULL`
constraints on origin columns with a walk over `EXPLAIN` bytecode (`src/macros/mod.rs`, "For SQLite
we perform a similar check to Postgres … we also can step through the output of `EXPLAIN`"). The
database comes from the URL in `DATABASE_URL`, or in the variable named by `sqlx.toml`, or else from
the crate's `.sqlx` cache. The proc macro links its own copy of SQLite; `cargo tree -i
libsqlite3-sys` shows a second `libsqlite3-sys` built for the host under `sqlx-macros-core`
(verified). `LIBSQLITE3_FLAGS` applies to both builds.

Parameters are not type-checked on SQLite. Only the count is checked, and binding the wrong Rust
type for a `TEXT` column is not an error. That matches SQLite's type affinity, so it is no worse
than rusqlite today (inferred).

Overrides (documented in `src/macros/mod.rs`): `"col!"` forces not-null, `"col?"` forces
nullable, `"col: T"` sets the Rust type, `"col!: T"` does both. The override sits inside the SQL
column alias, so queries with overrides need raw strings (`r#"…"#`). Plain `"…"` strings with
`"rank!: f64"` inside fail to parse as Rust (verified). Also, `ORDER BY rank` cannot refer to an
alias that is now `"rank!: f64"`. Use the position (`ORDER BY 3`) or repeat the expression
(verified).

### What the probes inferred (verified)

From the committed `.sqlx` files. "unknown" is what sqlx records as `null` nullability, and the
macro treats it as `Option`.

| Query shape | Result |
|---|---|
| `LEFT JOIN item_labels … LEFT JOIN labels`, selecting `l.name`, `l.color` | `Option<String>` for both, `i.id` and `i.title` not null. Correct. |
| Same with `WHERE l.name IS NOT NULL` | `l.name` not null, but `i.id` became unknown, so `Option<i64>` |
| `INSERT … RETURNING id, title, body` | `id` unknown, so `Option<i64>` (sqlx#4322); `title` not null, `body` nullable |
| `UPDATE … RETURNING id, seq, milestone` | `id`, `seq` not null, `milestone` nullable. Correct. |
| `INSERT … ON CONFLICT DO UPDATE … RETURNING id, login` | Both not null. Correct. |
| FTS5 `bm25(...)`, `snippet(...)`, `highlight(...)` | Type `NULL`, so the build fails until overridden |
| `json_extract(body, '$.x')` | Type `NULL`, override needed |
| `(SELECT json_group_array(...) …)` scalar subquery | `Option<String>`. It can never be NULL, so `!` is harmless here. |
| `count(*)`, `coalesce(max(seq), 0)` / `max(updated_at)` | Not null / not null / nullable. Correct. |
| CTE deferred join (`WITH page AS (… LIMIT ? OFFSET ?) SELECT … JOIN page`) | Correct per column |
| `ORDER BY … LIMIT` on a table | Correct (the old sqlx#1126 ORDER BY case did not reproduce) |
| `WITH RECURSIVE` walk over `items` | Compiles (old sqlx#1340 panic did not reproduce on this shape) |
| `UNION ALL` | Takes the first branch's types |

### Two schemas, one workspace (verified)

`sqlx.toml` is new in 0.9 and needs the `sqlx-toml` feature on the `sqlx` dependency; sqlx-cli has
it on by default (CHANGELOG, 0.9.0, #3383). The reference (`sqlx-core/src/config/reference.toml`)
lists `[common] database-url-var`, `[migrate] migrations-dir` and `table-name`, and macro type
overrides. Observed details:

- The macros read the `sqlx.toml` in the crate that contains the macro call. Two crates checked
  against two databases in one `cargo build`.
- `cargo sqlx prepare --workspace` at the workspace root failed with "`--database-url` or
  `DATABASE_URL` must be set", because the CLI reads `sqlx.toml` from the current directory only.
  Running `cargo sqlx prepare` inside each crate worked and wrote `<crate>/.sqlx`. CI therefore runs
  the prepare check once per crate.
- When a crate has renamed the variable and it is unset, the error still says "set
  `DATABASE_URL`". The message is misleading.
- `sqlx.toml` must not exist in a crate whose `sqlx` dependency lacks `sqlx-toml`. sqlx-cli built
  without the feature stopped with "found config file … but the `sqlx-toml` feature was not
  enabled".

So the layout is two crates, for example `server/db-mirror` and `server/db-control`, each with
`migrations/`, `sqlx.toml` and `.sqlx/`, and the axum crate depending on both. Queries for a
schema live in that schema's crate. That matches ticket #8's split anyway (inferred).

### Migrations (documented, verified)

- `sqlx::migrate!()` embeds `./migrations` at compile time. `Migrator::run(&pool)` applies pending
  ones and records them in `_sqlx_migrations` with a SHA-384 checksum
  (`sqlx-sqlite/src/migrate.rs`). Each migration runs in one transaction with its bookkeeping
  row, unless the file opts out with `-- no-transaction` (`no_tx`).
- The checksum makes an edited, already-applied migration fail on open. The `ignored-chars`
  setting can make whitespace edits safe.
- On SQLite, `lock()` and `unlock()` do nothing (`sqlx-sqlite/src/migrate.rs`). beghu is one
  process, but two requests that open the same new account at once would both try to migrate. The
  app should open each account file through a per-account once-cell (inferred).
- `migrate!` does not rebuild when a migration file is added. The docs give
  `println!("cargo:rerun-if-changed=migrations")` in `build.rs`, generated by
  `sqlx migrate build-script`.
- The control DB's ticket #76 pattern (one nullable column per key action, one migration each) is
  a one-line `ALTER TABLE preferences ADD COLUMN …` file. After it, `prepare` updates `.sqlx`
  (inferred).

The ticket #8 mirror is disposable. A mirror migration could also be "drop the file and
re-import". sqlx does not care, since the `.sqlx` cache describes the latest schema either way.

### The filter bar (verified)

The filtering benchmark (`bench/candidates/filtering/server/src/main.rs`, around line 270) appends
one `AND +i.id IN (…)` per `label:` and `assignee:` token, counts on offset 0, then pages ids in a
CTE and builds rows for those ids. `query!` needs the SQL text at compile time, so a token list of
any length cannot go through it. Options:

1. **Static SQL with catch-alls,** `(?1 IS NULL OR i.state = ?1)` and
   `IN (SELECT value FROM json_each(?2))` for lists. This is fully checked. But SQLite plans a
   statement once, before it knows which parameters are NULL. On the 50k file, `state = 'open'`
   used `SEARCH … COVERING INDEX issue_list (state=?)` and returned a 100-row page in 0.08 ms. The
   `(?1 IS NULL OR …)` version used `SCAN … issue_list` plus `USE TEMP B-TREE FOR ORDER BY` and took
   8 ms, 100x slower. Leaving `state = ?1` plain and using catch-alls only on the label subquery
   kept the index plan (0.2 ms). STAT4 re-prepares a statement only for parameters in range and
   LIKE/GLOB terms (sqlite.org `c3ref/prepare.html`), which does not cover `IS NULL`.
   `IN json_each` gives OR semantics. The filter bar's AND of several labels needs
   `(SELECT count(DISTINCT l.name) … WHERE l.name IN (SELECT value FROM json_each(?1))) =
   json_array_length(?1)`, which compiles under `query!` but is a correlated subquery per row.
   Catch-alls are fine for rarely-used, non-leading filters and wrong for anything an index
   should drive.
2. **sqlx `QueryBuilder`** (`push`, `push_bind`, `separated`) builds any SQL at run time and checks
   nothing at compile time. Results map by `FromRow` at run time.
3. **Split the query (recommended).** The dynamic part returns only ids, with
   `QueryBuilder::build_query_scalar::<i64>()`. A checked `query!` then hydrates the page:
   `SELECT … FROM json_each(?) AS page JOIN items i ON i.id = page.value JOIN repos r ON …
   ORDER BY page.key`. This ran today: 100 ids, then 100 rows in page order, planned as
   `SEARCH i USING INTEGER PRIMARY KEY`. The wide row (labels JSON, assignees JSON, repo name)
   stays checked. The unchecked part is a WHERE clause over a known table that returns one integer
   column. It is the deferred join the benchmark already uses. To cover it, write a test that runs
   the builder for every token kind and for pairs of them on a migrated mirror. Each built
   statement prepares, which catches unknown tables and columns, and the test can also assert
   results.

FTS5 search (ticket #60) can stay a static, checked query per table (`items_fts`, `comments_fts`).
The builder adds `AND +i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)` when there is
free text. bm25 blending across two tables needs the scores. Either keep it a static `query!` with
`"rank!: f64"` overrides that the builder narrows by id list, or accept that the ranking query is
unchecked (inferred).

What is lost: the builder's SQL is checked by tests, not the compiler. A typo in a rarely-used
token branch shows up in `cargo test`, not in `cargo check`. That is the same trade sqlc and
Kysely users make for dynamic filters (inferred).

### Async, single writer, many files (documented, verified)

- **Threads.** Every `SqliteConnection` spawns a dedicated OS thread named
  `sqlx-sqlite-worker-<n>` and talks to it over bounded `flume` channels: 50 commands and 50 rows
  by default, set with `command_buffer_size` and `row_buffer_size` (`sqlx-sqlite/src/connection/
  worker.rs` line 108, `options/mod.rs`). Nothing runs on the tokio threads. The cost is two thread
  hops per query and one thread per open connection.
- **Single writer.** The pattern is two pools per file: a writer pool with `max_connections(1)` and
  a reader pool with `read_only(true)`, both with `journal_mode(Wal)` and `busy_timeout`. Writes go
  through `conn.begin_with("BEGIN IMMEDIATE")` (`Connection::begin_with` in
  `sqlx-core/src/connection.rs`). That gives the same shape as one rusqlite writer plus r2d2
  readers (inferred).
- **Per-account pools.** Opening a bare connection cost about 1 ms against rusqlite's 0.4 to 0.5
  ms. A pool with one connection, one count over 50k rows and a close cost 6.3 ms. Pools can start
  empty (`min_connections(0)`) and drop idle connections (`idle_timeout`). Then 100 active accounts
  with 1 writer and 4 readers each means at most 500 sqlx worker threads, and idle accounts hold
  none (inferred from the above).
- **Raw access.** `SqliteConnection::lock_handle()` exposes the `sqlite3*` for things sqlx lacks,
  such as `sqlite3_config` calls or FTS5 auxiliary functions (documented).

`SQLITE_CONFIG_MEMSTATUS` can be turned off at run time with `sqlite3_config` before the first
connection (sqlite.org `c3ref/c_config_covering_index_scan.html`). `SQLITE_ENABLE_MEMORY_MANAGEMENT`
is compile-time only. The pcache1 shared-cache choice is an `#if` in `pcache1.c`. So the build
flag stays (inferred from the SQLite source). The `sqlite-unbundled` feature links the system
library instead. Arch's 3.54.0 has no `ENABLE_MEMORY_MANAGEMENT`, but its memory statistics are on
by default (verified with `pragma compile_options`). Bundled plus `LIBSQLITE3_FLAGS` keeps one
known build across dev, CI and Docker.

### Build loop and CI (verified)

- First build of the two-crate workspace: 34 s wall on 32 cores, including two SQLite builds.
- Incremental `cargo check` after a one-line edit, with 7 queries: 0.42 s online and 0.35 s
  offline. Each query costs a few milliseconds of describing. That will grow with query count but
  should stay small next to type checking (inferred).
- Online checking needs the dev databases. Use one script that rebuilds `mirror/dev.db` and
  `control/dev.db` from the migrations (`sqlx database reset` per crate, or the `sqlite3` CLI as
  in the experiment), a `build.rs` that reruns on `migrations/`, and the env vars in
  `.cargo/config.toml` `[env]` so agents and editors pick them up.
- CI: build with `SQLX_OFFLINE=true` and no database, then in each crate run
  `cargo sqlx prepare --check` against freshly migrated databases. The check catches a `.sqlx`
  that is out of date with the code. A schema change that breaks a query fails the online build
  in the same job.
- Agents: online mode gives an editing agent errors like `no such column: l.color` at the macro
  call, the same loop as a type error. An agent that changes a query must run `prepare` or CI
  fails. That rule belongs in AGENTS.md.

### Health (documented)

sqlx: 0.9.0 released 2026-05-21; 173M downloads; MIT OR Apache-2.0; 17.6k stars; 779 open
issues and PRs across all drivers. GitHub search finds 23 open issues labelled `db:sqlite`. Open
SQLite nullability issues include sqlx#4322 (INSERT RETURNING), #2939 (UPDATE RETURNING, which did
not reproduce today), #3202 (multiple LEFT JOINs, wrongly non-null), #3286 (count subquery) and
#1637 (FTS virtual table returning nulls). The 0.9 changelog has rowid nullability work (#4088),
which also caused a rustc segfault for columns with no declared type (sqlx#4373, closed) and the
#4322 regression. Principal authors are mehcode (963 commits, mostly historical) and abonander
(419, the active maintainer); the repo moved to the `transact-rs` organization "to allow inviting
outside collaborators" (CHANGELOG). Bus factor: in practice one active maintainer plus drive-by
contributors. MSRV 1.94.

## 2. Diesel 2.3 (documented)

- **Checking.** The query DSL is type-checked against `schema.rs`, which `diesel print-schema`
  generates from a live database. Raw SQL through `sql_query` is not checked. Its docs say "The
  compiler will be unable to verify that the given type is correct", and rows map by name through
  `QueryableByName`.
- **SQLite features.** `RETURNING` needs the `returning_clauses_for_sqlite_3_35` feature. FTS5
  `MATCH`, `bm25` and `snippet` are not in the DSL. You declare the virtual table by hand in
  `table!`, define the functions with `define_sql_function!`, or drop to `sql_query`
  (diesel#1748 discusses FTS5 primary keys). `json_each` IN lists need custom SQL fragments.
  Every FTS query would be unchecked or hand-typed (inferred).
- **Dynamic filters.** `into_boxed()` queries take `.filter()` calls added at run time and stay
  type-checked. Diesel beats sqlx here: the filter bar would be checked end to end.
- **SQLite build.** `libsqlite3-sys >=0.17.2, <0.39`, so it can share 0.38 with rusqlite 0.40 and
  takes `LIBSQLITE3_FLAGS` the same way (inferred from the shared `-sys` crate).
- **Async.** `SqliteConnection` is synchronous. diesel-async wraps it in `SyncConnectionWrapper`,
  which uses tokio `spawn_blocking`. `deadpool-diesel` 0.7 pools sync connections. That is the
  same model as beghu's current rusqlite + r2d2 + `spawn_blocking`.
- **Migrations.** `diesel_migrations::embed_migrations!` plus `run_pending_migrations(&mut conn)`
  runs against any connection, so it suits many files.
- **Two schemas.** Two `schema.rs` modules, one per database. `diesel.toml` supports several
  `[print_schema]` sections (inferred from diesel's config docs; not tried).
- **Health.** 2.3.14 on 2026-10-07, frequent patch releases, 42M downloads, MIT OR Apache-2.0,
  14.2k stars, 177 open issues. weiznich wrote 43 of the last 100 commits, and two other
  contributors have 26 and 18.

Diesel answers "is this Rust query valid against the schema", not "is this SQL valid". The owner
asked for SQL checked like sqlc, and most of beghu's interesting SQL (FTS5, json, deferred joins)
is what diesel leaves unchecked. Diesel is the runner-up if the filter bar's dynamic part matters
more than the static queries (inferred).

## 3. Others

- **sea-query 1.0 / SeaORM 2.0** (documented). sea-query is a typed SQL builder: identifiers are
  Rust enums, but nothing is checked against a database. SeaORM generates entities from a live
  database (`sea-orm-cli generate entity`), which catches renamed columns at compile time for ORM
  calls only. Both run on sqlx 0.9 (`sea-query-sqlx` 0.9.1, `sea-orm` 2.0.4 depends on
  `sqlx ^0.9`), so they share sqlx's SQLite build and threading. sea-query could build the filter
  bar's id query instead of `QueryBuilder`, with typed identifiers but no schema check. MIT OR
  Apache-2.0, active.
- **cornucopia 1.0.1 / clorinde 2.0.0** (documented). Postgres only ("Generate type-checked Rust
  from your PostgreSQL"). clorinde is archived: "Clorinde has been merged back into Cornucopia".
- **sqlc** (documented). The language table on docs.sqlc.dev marks SQLite "Beta" for Go only. The
  one listed Rust plugin, `mathematic-inc/sqlc-gen-sqlx` (16 stars), lists Postgres only. No SQLite
  plus Rust path exists.
- **bsql 0.27 / 1.0.0-alpha.5** (documented). `query!` checked against `BSQL_DATABASE_URL` or a
  `.bsql/` cache, for Postgres and SQLite. It expands optional clauses into every combination and
  checks each, up to 10 clauses, which is the feature beghu's filter bar wants. But it was created
  2026-04-01, had 27 releases in its first ten days, has 3 stars, one contributor and 581
  downloads, and links `libsqlite3-sys ^0.30`. Not a dependency to bet v1 on. It is worth
  watching.
- **turbosql 0.14** (documented). Derives the schema and append-only migrations from Rust
  structs, with one database file per executable. Last release 2025-08-14. Does not fit many files
  or hand-written FTS SQL.
- **rusqlite-macros** (documented). "Private implementation detail of rusqlite". No schema
  checking.
- **include-sql / include-sqlite-sql** (documented). Generate functions from `.sql` files with no
  database check.
- **Plain rusqlite with a test-time check** (inferred). Keep rusqlite 0.40, put every SQL string
  in a const or a `.sql` file, and have one test prepare each against freshly migrated mirror and
  control databases. `sqlite3_prepare` rejects unknown tables, columns and functions. That catches
  schema drift in `cargo test` but gives no column types or nullability. It is the fallback if the
  sqlx benchmark disappoints.

## 4. Migration tools

| Tool | Tracks state in | Embedded, any connection | Works next to sqlx 0.9 | Notes |
|---|---|---|---|---|
| sqlx migrate (0.9.0) | `_sqlx_migrations` table, checksums | `sqlx::migrate!()` + `run(&pool)`; verified on two files | Is sqlx | Per-crate dir and table name via `sqlx.toml`; no lock on SQLite |
| refinery 0.10.0 | `refinery_schema_history` | `embed_migrations!` + `runner().run(&mut conn)` | Only through rusqlite 0.39 | Drivers: rusqlite (`<=0.40`), postgres, mysql_async, tiberius; no sqlx driver |
| rusqlite_migration 2.6.0 | `PRAGMA user_version` | `Migrations::to_latest(&mut conn)` | No: needs rusqlite `^0.40` | Smallest; `validate()` test helper |
| diesel_migrations 2.3.2 | `__diesel_schema_migrations` | `embed_migrations!` + `run_pending_migrations` | Diesel only | |

With sqlx chosen, sqlx's migrator is the obvious pick. It reads the same `migrations/` directory
the macros' dev database is built from, so there is one source of schema truth per crate.

## Open questions for the owner

1. **Run the ticket #20 load test on sqlx before deciding?** The micro-benchmark shows about 2x
   per-query overhead from sqlx's worker-thread design. Port the filtering candidate's list query
   to sqlx and compare p95 at 20 users. I recommend doing this first.
2. **Is an unchecked id query plus a test acceptable for the filter bar,** given that the rows it
   feeds stay checked? If the filter bar must be compile-time checked end to end, diesel's boxed
   queries are the only mature way, and FTS5 then goes unchecked instead.
3. **Two crates (mirror, control) in a workspace:** acceptable layout for v1?
4. **Drop rusqlite entirely in v1?** sqlx 0.9 cannot share a tree with rusqlite 0.40, r2d2_sqlite
   0.35 or rusqlite_migration 2.6. Anything left on rusqlite would have to pin 0.39 until sqlx
   ships its `<0.39` range.
5. **Mirror schema changes: migrate in place, or delete and re-import?** The mirror is
   disposable (ticket #8). Re-import on a version bump would keep the mirror's migration history
   at one file, but every deploy that changes the schema would cost a re-import per account.
6. **Per-account pool limits:** how many concurrently open accounts to plan for, given one OS
   thread per open sqlx connection.

## Sources

- sqlx 0.9.0 source and changelog: <https://github.com/transact-rs/sqlx/tree/v0.9.0>
  (`CHANGELOG.md`, `src/macros/mod.rs`, `sqlx-core/src/config/reference.toml`,
  `sqlx-sqlite/src/connection/worker.rs`, `sqlx-sqlite/src/options/mod.rs`,
  `sqlx-sqlite/src/migrate.rs`, `sqlx-core/src/connection.rs`)
- sqlx `migrate!` docs: <https://docs.rs/sqlx/0.9.0/sqlx/macro.migrate.html>
- sqlx issues: <https://github.com/transact-rs/sqlx/issues/4322>, /3202, /2939, /3286, /1637,
  /1340, /1126, /4373, /3940, /4160, /4241, /4379, /4402
- sqlx `main` `libsqlite3-sys` range:
  <https://raw.githubusercontent.com/transact-rs/sqlx/main/sqlx-sqlite/Cargo.toml>
- crates.io API for sqlx, sqlx-sqlite, sqlx-cli, rusqlite, libsqlite3-sys, diesel, diesel-async,
  diesel_migrations, deadpool-diesel, deadpool-sqlite, sea-query, sea-query-sqlx,
  sea-query-binder, sea-orm, refinery, refinery-core, rusqlite_migration, r2d2_sqlite,
  tokio-rusqlite, turbosql, cornucopia, clorinde, bsql, bsql-driver-sqlite, rusqlite-macros,
  include-sql, include-sqlite-sql: `https://crates.io/api/v1/crates/<name>`
- Diesel: <https://docs.rs/diesel/2.3.14/diesel/fn.sql_query.html>,
  <https://docs.rs/diesel/2.3.14/diesel/sqlite/struct.SqliteConnection.html>,
  <https://github.com/diesel-rs/diesel/issues/1748>
- diesel-async: <https://docs.rs/diesel-async/0.9.2/diesel_async/sync_connection_wrapper/index.html>
- cornucopia: <https://github.com/cornucopia-rs/cornucopia>; clorinde:
  <https://github.com/halcyonnouveau/clorinde>
- sqlc language support: <https://docs.sqlc.dev/en/latest/reference/language-support.html>;
  <https://github.com/mathematic-inc/sqlc-gen-sqlx>
- bsql: <https://docs.rs/crate/bsql/latest>, <https://github.com/smir-ant/bsql>
- turbosql: <https://github.com/trevyn/turbosql>
- refinery: <https://github.com/rust-db/refinery>; rusqlite_migration:
  <https://github.com/cljoly/rusqlite_migration>
- SQLite: <https://www.sqlite.org/c3ref/prepare.html> (re-prepare on bound values with STAT4),
  <https://www.sqlite.org/c3ref/c_config_covering_index_scan.html> (`SQLITE_CONFIG_MEMSTATUS`),
  <https://www.sqlite.org/fts5.html>, <https://www.sqlite.org/json1.html#jeach>
- beghu: `bench/candidates/filtering/OPTIMISATION.md` and `server/.cargo/config.toml` (ticket
  #20 flags), `bench/candidates/filtering/server/src/main.rs` and
  `bench/candidates/axum-solid2/server/src/main.rs` (filter assembly)
