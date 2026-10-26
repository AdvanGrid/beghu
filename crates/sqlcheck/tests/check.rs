//! The checker as a schema crate's build script sees it: a directory of migrations and queries
//! in, generated Rust or `file:line: …` errors out.

use sqlcheck::{Options, check};
use std::path::Path;

const MIRROR: Options = Options {
    allow_rebuild: true,
};
const CONTROL: Options = Options {
    allow_rebuild: false,
};

fn schema(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("migrations")).unwrap();
    std::fs::create_dir(dir.path().join("queries")).unwrap();
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    dir
}

const ITEMS: &str =
    "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT NOT NULL,\n  body TEXT\n);\n";

fn errors(dir: &Path, opts: &Options) -> Vec<String> {
    check(dir, opts).expect_err("the check should fail")
}

#[test]
fn a_column_typo_in_a_query_names_the_file_the_line_and_the_query() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "queries/items.sql",
            "-- name: titles :many\nSELECT i.id,\n       i.titel\nFROM items i;\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR);
    let file = dir.path().join("queries/items.sql");
    assert_eq!(
        errs,
        [format!(
            "{}:3: query `titles`: no such column: i.titel",
            file.display()
        )]
    );
}

#[test]
fn a_column_typo_in_a_later_migration_statement_names_its_own_line() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "migrations/0002_index.sql",
            "CREATE INDEX items_title ON items(title);\n\nCREATE INDEX items_body ON items(bodyy);\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR);
    let file = dir.path().join("migrations/0002_index.sql");
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(
        errs[0].starts_with(&format!("{}:3: migration 0002_index: ", file.display())),
        "{}",
        errs[0]
    );
    assert!(errs[0].contains("bodyy"), "{}", errs[0]);
}

#[test]
fn a_query_against_a_column_a_later_migration_dropped_fails() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "migrations/0002_drop_body.sql",
            "ALTER TABLE items DROP COLUMN body;\n",
        ),
        (
            "queries/items.sql",
            "-- name: bodies :many\nSELECT i.body FROM items i;\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR);
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(
        errs[0].ends_with(":2: query `bodies`: no such column: i.body"),
        "{}",
        errs[0]
    );
}

#[test]
fn a_typo_in_a_fragment_names_the_fragment() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "queries/filters.sql",
            "-- name: titled :fragment\n-- param: t &str\ni.titel = :t\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR);
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(
        errs[0].ends_with(":3: query `titled`: no such column: i.titel"),
        "{}",
        errs[0]
    );
}

#[test]
fn the_control_schema_refuses_rebuild_migrations() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        ("migrations/0002_reset.rebuild.sql", "SELECT 1;\n"),
    ]);
    let errs = errors(dir.path(), &CONTROL);
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(
        errs[0].contains("0002_reset.rebuild.sql:1: "),
        "{}",
        errs[0]
    );
    assert!(check(dir.path(), &MIRROR).is_ok());
}

#[test]
fn params_must_be_declared_and_used_and_columns_listed_and_typed() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "queries/items.sql",
            "-- name: undeclared :many\nSELECT i.id FROM items i WHERE i.id = :id;\n\n\
             -- name: unused :many\n-- param: id i64\nSELECT i.id FROM items i;\n\n\
             -- name: star :many\nSELECT * FROM items;\n\n\
             -- name: untyped :one\nSELECT count(*) AS n FROM items;\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR).join("\n");
    assert!(
        errs.contains("query `undeclared`: `:id` has no `-- param: id <type>` line"),
        "{errs}"
    );
    assert!(
        errs.contains("query `unused`: `-- param: id` is never used"),
        "{errs}"
    );
    assert!(
        errs.contains("query `star`: no `*` in checked queries"),
        "{errs}"
    );
    assert!(
        errs.contains("query `untyped`: column `n` has no declared type"),
        "{errs}"
    );
}

#[test]
fn a_valid_schema_generates_typed_functions_and_the_migration_list() {
    let dir = schema(&[
        ("migrations/0001_init.sql", ITEMS),
        (
            "queries/items.sql",
            "-- name: item :opt\n-- param: id i64\nSELECT i.id, i.title, i.body FROM items i WHERE i.id = :id;\n",
        ),
    ]);
    let code = check(dir.path(), &MIRROR).unwrap();
    assert!(
        code.contains("pub const SCHEMA_VERSION: u32 = 1;"),
        "{code}"
    );
    assert!(
        code.contains("pub id: i64,")
            && code.contains("pub title: String,")
            && code.contains("pub body: Option<String>,"),
        "{code}"
    );
    assert!(
        code.contains(
            "pub fn item(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Option<ItemRow>>"
        ),
        "{code}"
    );
}

#[test]
fn a_broken_migration_is_reported_alone_not_again_by_every_query() {
    let dir = schema(&[
        (
            "migrations/0001_init.sql",
            "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\nCREATE INDEX t ON items(titel);\n",
        ),
        (
            "queries/items.sql",
            "-- name: titles :many\nSELECT i.title FROM items i;\n",
        ),
    ]);
    let errs = errors(dir.path(), &MIRROR);
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(
        errs[0].contains("0001_init.sql:2: migration 0001_init: no such column: titel"),
        "{}",
        errs[0]
    );
}
