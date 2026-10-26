//! Migrate-on-first-use, through `Mirrors`: what callers of an account's mirror see while its
//! file catches up with the build.
#![allow(clippy::disallowed_methods)] // tests of a database crate open files directly

use dbrt::gate::Status;
use dbrt::migrations::{Kind, Migration, file_version};
use dbrt::mirrors::Config;
use dbrt::{Caller, Error, Mirrors, Notice, Unavailable};
use std::time::Duration;

const fn m(version: u32, name: &'static str, kind: Kind, sql: &'static str) -> Migration {
    Migration {
        version,
        name,
        kind,
        sql,
    }
}

const INIT: Migration = m(
    1,
    "init",
    Kind::InPlace,
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
);
static V1: [Migration; 1] = [INIT];
/// A second migration that can only run once: running it twice fails on `CREATE TABLE`.
static V2: [Migration; 2] = [
    INIT,
    m(
        2,
        "runs",
        Kind::InPlace,
        "CREATE TABLE runs (n INTEGER); INSERT INTO runs VALUES (1);",
    ),
];
/// A second migration that fails on the data an existing mirror holds.
static V2_BAD: [Migration; 2] = [
    INIT,
    m(
        2,
        "unique_body",
        Kind::InPlace,
        "CREATE UNIQUE INDEX notes_body ON notes(body);",
    ),
];
static V2_REBUILD: [Migration; 2] = [
    INIT,
    m(
        2,
        "refetch",
        Kind::Rebuild,
        "ALTER TABLE notes ADD COLUMN refetched INTEGER;",
    ),
];

const ACCT: i64 = 42;

/// A v1 mirror for `ACCT` holding two notes with the same body.
async fn v1_mirror(dir: &std::path::Path) {
    let v1 = Mirrors::new(dir, &V1, Config::default());
    v1.write(ACCT, Caller::Webhook, |c| {
        c.execute_batch("INSERT INTO notes (body) VALUES ('same'), ('same');")
    })
    .await
    .unwrap();
}

fn count(c: &rusqlite::Connection, sql: &str) -> rusqlite::Result<i64> {
    c.query_row(sql, [], |r| r.get(0))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_old_mirror_migrates_once_and_every_concurrent_caller_waits_for_that_job() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirror(dir.path()).await;

    let v2 = Mirrors::new(dir.path(), &V2, Config::default());
    let mut calls = Vec::new();
    for caller in [
        Caller::Request,
        Caller::Request,
        Caller::Request,
        Caller::Sweep,
    ] {
        let v2 = v2.clone();
        calls.push(tokio::spawn(async move {
            v2.read(ACCT, caller, |c| count(c, "SELECT count(*) FROM runs"))
                .await
        }));
    }
    let writer = {
        let v2 = v2.clone();
        tokio::spawn(async move {
            v2.write(ACCT, Caller::Webhook, |c| {
                count(c, "SELECT count(*) FROM runs")
            })
            .await
        })
    };
    for call in calls {
        assert_eq!(call.await.unwrap().unwrap(), 1);
    }
    assert_eq!(writer.await.unwrap().unwrap(), 1);
    assert_eq!(file_version(&v2.path(ACCT)).unwrap(), Some(2));
    let notes = v2
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM notes")
        })
        .await
        .unwrap();
    assert_eq!(notes, 2, "an in-place migration keeps the rows");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_migration_leaves_the_file_unchanged_and_the_mirror_in_an_error_state() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirror(dir.path()).await;

    let v2 = Mirrors::new(dir.path(), &V2_BAD, Config::default());
    let mut notices = v2.notices();
    let first = v2
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM notes")
        })
        .await;
    let Err(Error::MigrationFailed(why)) = first else {
        panic!("expected a failed migration, got {first:?}")
    };
    assert!(
        why.contains("0002_unique_body") && why.contains("UNIQUE"),
        "{why}"
    );
    match notices.recv().await.unwrap() {
        Notice::Status {
            account: ACCT,
            status: Some(Status::Failed { retry_in: None, .. }),
        } => {}
        n => panic!("unexpected notice {n:?}"),
    }

    let webhook = v2
        .write(ACCT, Caller::Webhook, |c| {
            c.execute_batch("DELETE FROM notes")
        })
        .await;
    assert!(
        matches!(webhook, Err(Error::MigrationFailed(_))),
        "{webhook:?}"
    );

    assert_eq!(file_version(&v2.path(ACCT)).unwrap(), Some(1));
    let v1 = Mirrors::new(dir.path(), &V1, Config::default());
    let notes = v1
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM notes")
        })
        .await
        .unwrap();
    assert_eq!(notes, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_newer_than_the_build_is_refused_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let v2 = Mirrors::new(dir.path(), &V2, Config::default());
    v2.write(ACCT, Caller::Webhook, |c| {
        c.execute_batch("INSERT INTO notes (body) VALUES ('kept')")
    })
    .await
    .unwrap();

    let v1 = Mirrors::new(dir.path(), &V1, Config::default());
    let r = v1
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM notes")
        })
        .await;
    assert!(matches!(r, Err(Error::TooNew { db: 2, build: 1 })), "{r:?}");
    assert_eq!(file_version(&v1.path(ACCT)).unwrap(), Some(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_migration_shows_updating_and_turns_requests_away_while_webhooks_wait() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirror(dir.path()).await;
    let path = dir.path().join(format!("{ACCT}.db"));

    // Another connection holds the write lock, so the migration waits on it (busy timeout).
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        c.execute_batch("COMMIT").unwrap();
    });
    locked_rx.recv().unwrap();

    let mut cfg = Config::default();
    cfg.gate.status_after = Duration::from_millis(50);
    cfg.gate.request_timeout = Duration::from_millis(300);
    let v2 = Mirrors::new(dir.path(), &V2, cfg);
    let mut notices = v2.notices();
    let webhook = {
        let v2 = v2.clone();
        tokio::spawn(async move {
            v2.write(ACCT, Caller::Webhook, |c| {
                count(c, "SELECT count(*) FROM runs")
            })
            .await
        })
    };
    let request = v2
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM runs")
        })
        .await;
    match request {
        Err(Error::Unavailable {
            reason: Unavailable::Updating,
            retry_after,
        }) => assert!(retry_after > Duration::ZERO),
        r => panic!("expected the request to be turned away, got {r:?}"),
    }
    assert_eq!(
        notices.recv().await.unwrap(),
        Notice::Status {
            account: ACCT,
            status: Some(Status::Updating)
        }
    );

    assert_eq!(
        webhook.await.unwrap().unwrap(),
        1,
        "the webhook waited for the migration"
    );
    assert_eq!(
        notices.recv().await.unwrap(),
        Notice::Status {
            account: ACCT,
            status: None
        }
    );
    holder.join().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rebuild_migration_replaces_the_mirror_with_an_empty_one_to_import() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirror(dir.path()).await;

    let v2 = Mirrors::new(dir.path(), &V2_REBUILD, Config::default());
    let mut notices = v2.notices();
    let notes = v2
        .read(ACCT, Caller::Request, |c| {
            count(c, "SELECT count(*) FROM notes WHERE refetched IS NULL")
        })
        .await
        .unwrap();
    assert_eq!(notes, 0);
    assert!(matches!(
        notices.recv().await.unwrap(),
        Notice::NeedsImport { account: ACCT, .. }
    ));
    assert_eq!(file_version(&v2.path(ACCT)).unwrap(), Some(2));
}
