//! Opening the control DB at startup: back up, migrate in place, never roll back.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{ControlOutcome, Kind, Migration};
use dbrt::{Db, Error};

const fn m(version: u32, name: &'static str, sql: &'static str) -> Migration {
    Migration {
        version,
        name,
        kind: Kind::InPlace,
        sql,
    }
}
const INIT: Migration = m(
    1,
    "init",
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY, login TEXT NOT NULL);",
);
static V1: [Migration; 1] = [INIT];
static V2: [Migration; 2] = [
    INIT,
    m(
        2,
        "status",
        "ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
    ),
];
static V2_BAD: [Migration; 2] = [
    INIT,
    m(
        2,
        "bad",
        "ALTER TABLE accounts ADD COLUMN status TEXT; CREATE UNIQUE INDEX x ON accounts(nope);",
    ),
];

fn logins(path: &std::path::Path) -> Vec<String> {
    let c = rusqlite::Connection::open(path).unwrap();
    let mut st = c.prepare("SELECT login FROM accounts ORDER BY id").unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

async fn v1_with_an_account(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("control.db");
    let (db, outcome) = Db::open_migrated(&path, &V1, &dir.join("backups"), 4).unwrap();
    assert_eq!(
        outcome,
        ControlOutcome::Migrated {
            from: 0,
            to: 1,
            backup: None
        }
    );
    db.write(|c| c.execute("INSERT INTO accounts (id, login) VALUES (1, 'tomsj')", []))
        .await
        .unwrap();
    path
}

#[tokio::test]
async fn startup_backs_up_then_migrates_and_a_second_start_has_nothing_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let path = v1_with_an_account(dir.path()).await;

    let (db, outcome) = Db::open_migrated(&path, &V2, &dir.path().join("backups"), 4).unwrap();
    let ControlOutcome::Migrated {
        from: 1,
        to: 2,
        backup: Some(backup),
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    assert_eq!(
        logins(&backup),
        ["tomsj"],
        "the backup holds the data from before the migration"
    );
    let status: String = db
        .read(|c| c.query_row("SELECT status FROM accounts WHERE id = 1", [], |r| r.get(0)))
        .await
        .unwrap();
    assert_eq!(status, "active");
    drop(db);

    let (_, again) = Db::open_migrated(&path, &V2, &dir.path().join("backups"), 4).unwrap();
    assert_eq!(again, ControlOutcome::Current(2));
}

#[tokio::test]
async fn a_failed_migration_stops_startup_and_leaves_the_db_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let path = v1_with_an_account(dir.path()).await;

    let err = Db::open_migrated(&path, &V2_BAD, &dir.path().join("backups"), 4)
        .err()
        .expect("startup must fail");
    assert!(
        matches!(&err, Error::MigrationFailed(e) if e.contains("0002_bad")),
        "{err}"
    );
    let (_, outcome) = Db::open_migrated(&path, &V1, &dir.path().join("backups"), 4).unwrap();
    assert_eq!(outcome, ControlOutcome::Current(1));
    assert_eq!(logins(&path), ["tomsj"]);
}

#[tokio::test]
async fn a_control_db_newer_than_the_build_refuses_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.db");
    drop(Db::open_migrated(&path, &V2, &dir.path().join("backups"), 4).unwrap());

    let err = Db::open_migrated(&path, &V1, &dir.path().join("backups"), 4)
        .err()
        .expect("startup must fail");
    assert!(matches!(err, Error::TooNew { db: 2, build: 1 }), "{err}");
}

const PARENT: Migration = m(
    1,
    "init",
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY, login TEXT NOT NULL);
     CREATE TABLE tokens (account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE);",
);
static PARENT_V1: [Migration; 1] = [PARENT];
/// SQLite's table rebuild (create, copy, drop, rename), the way a column type changes.
static PARENT_REBUILT: [Migration; 2] = [
    PARENT,
    m(
        2,
        "rebuild_accounts",
        "CREATE TABLE accounts_new (id INTEGER PRIMARY KEY, login TEXT NOT NULL COLLATE NOCASE);
         INSERT INTO accounts_new SELECT id, login FROM accounts;
         DROP TABLE accounts;
         ALTER TABLE accounts_new RENAME TO accounts;",
    ),
];
static PARENT_DANGLING: [Migration; 2] = [PARENT, m(2, "dangling", "DELETE FROM accounts;")];

async fn parent_v1_with_a_token(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("control.db");
    let (db, _) = Db::open_migrated(&path, &PARENT_V1, &dir.join("backups"), 4).unwrap();
    db.write(|c| {
        c.execute_batch("INSERT INTO accounts VALUES (1, 'tomsj'); INSERT INTO tokens VALUES (1);")
    })
    .await
    .unwrap();
    path
}

#[tokio::test]
async fn foreign_keys_are_enforced_and_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let path = parent_v1_with_a_token(dir.path()).await;
    let (db, _) = Db::open_migrated(&path, &PARENT_V1, &dir.path().join("backups"), 4).unwrap();

    let orphan = db
        .write(|c| c.execute("INSERT INTO tokens VALUES (2)", []))
        .await;
    assert!(orphan.is_err(), "a token for a missing account is refused");
    db.write(|c| c.execute("DELETE FROM accounts", []))
        .await
        .unwrap();
    let tokens: i64 = db
        .read(|c| c.query_row("SELECT count(*) FROM tokens", [], |r| r.get(0)))
        .await
        .unwrap();
    assert_eq!(tokens, 0);
}

#[tokio::test]
async fn a_migration_that_rebuilds_a_parent_table_keeps_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let path = parent_v1_with_a_token(dir.path()).await;

    let (db, _) =
        Db::open_migrated(&path, &PARENT_REBUILT, &dir.path().join("backups"), 4).unwrap();
    let tokens: i64 = db
        .read(|c| c.query_row("SELECT count(*) FROM tokens", [], |r| r.get(0)))
        .await
        .unwrap();
    assert_eq!(
        tokens, 1,
        "dropping the old table during the rebuild must not cascade"
    );
}

#[tokio::test]
async fn a_migration_that_leaves_a_dangling_reference_stops_startup() {
    let dir = tempfile::tempdir().unwrap();
    let path = parent_v1_with_a_token(dir.path()).await;

    let err = Db::open_migrated(&path, &PARENT_DANGLING, &dir.path().join("backups"), 4)
        .err()
        .expect("startup must fail");
    assert!(
        matches!(&err, Error::MigrationFailed(e) if e.contains("foreign key")),
        "{err}"
    );
    let (_, outcome) =
        Db::open_migrated(&path, &PARENT_V1, &dir.path().join("backups"), 4).unwrap();
    assert_eq!(
        outcome,
        ControlOutcome::Current(1),
        "the failed migration rolled back"
    );
}
