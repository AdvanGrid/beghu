# Filtering on sqlx against rusqlite

For [Benchmark: sqlx against rusqlite at filter load](https://github.com/tomsjansons/beghu/issues/81).
Forked from [filtering](../filtering/README.md) (server variant only matters here). Throwaway: it
exists to be measured, not to start the real app. Results are in [RESULTS.md](RESULTS.md).

One image, two database layers picked by `BENCH_DB`:

| `BENCH_DB` | `/api/issues` and `/api/facets` |
|---|---|
| `rusqlite` (default) | rusqlite 0.39 + r2d2 + `spawn_blocking`, as in `filtering`: the assembled `WHERE` runs as a count, then one statement that pages ids in a CTE and builds those rows |
| `sqlx` | sqlx 0.9 (`server/src/sqlx_db.rs`): the `WHERE` is built in an unchecked `QueryBuilder` that returns the count and the page's ids, and a checked `query!` hydrates the rows through `json_each(?)`. All three run on one pooled connection |

Both use one SQLite: rusqlite is pinned to 0.39 because sqlx 0.9 takes `libsqlite3-sys <0.38`,
so `cargo tree -i libsqlite3-sys` shows a single 0.37 built with the same `LIBSQLITE3_FLAGS`
(`server/.cargo/config.toml`). Pools match: up to 4 connections per account, one kept open.

In `sqlx` mode, webhooks, detail and writes stay on rusqlite but open a connection per request, so
only sqlx holds connections open. `BENCH_SQLX_WRITES=pool` keeps rusqlite's pools for them
instead. `BENCH_LIST=split` runs the sqlx path's three-statement shape on rusqlite (ids, then a
separate `json_each` hydrate), to separate the cost of the shape from the cost of the library.
Every mode returns byte-identical pages.

**Migrations.** `server/migrations/0001_mirror.sql` is the fixture's schema (with `IF NOT EXISTS`,
so the migrator adopts a mirror built without it) and `0002_list_indexes.sql` the indexes the
rusqlite mode creates at startup. In `sqlx` mode `sqlx::migrate!` runs on account 0's mirror
first (a real migration: it builds the indexes), then on every copy, which is already up to date.
The server logs both times.

**Compile-time check.** The Dockerfile builds an empty `schema.db` from the migrations and points
`DATABASE_URL` at it, so `query!` is checked in the image build with no `.sqlx` data. Locally:

```sh
cat server/migrations/*.sql | sqlite3 /tmp/schema.db
DATABASE_URL=sqlite:///tmp/schema.db cargo build --release --manifest-path server/Cargo.toml
```

```sh
./bench/load filtering-sqlx --scale all --users 1,5,20 --cpus 4 --db rusqlite
./bench/load filtering-sqlx --scale all --users 1,5,20 --cpus 4 --db sqlx
./bench/load filtering-sqlx --scale 50k --users 20 --cpus 1 --db sqlx --env BENCH_SQLX_WRITES=pool
./bench/load filtering-sqlx --scale 50k --users 20 --cpus 1 --db rusqlite --env BENCH_LIST=split
node candidates/filtering-sqlx/accounts-probe.mjs --accounts 100 --scale 20k   # from bench/
```

`./bench/load` gained `--db` (passed as `BENCH_DB`), `--env K=V,…` and a peak thread count per
phase (Docker's and Podman's PIDs column).
