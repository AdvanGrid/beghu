//! The drain's last step as callers of `Db` and `Mirrors` see it: a checkpoint lets the write in
//! flight land, folds the WAL into the file, and seals the database, so nothing written after it
//! can bring the WAL back.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{Kind, Migration};
use dbrt::mirrors::Config;
use dbrt::{Caller, Db, Error, Mirrors, Notice, Status};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

static SCHEMA: [Migration; 1] = [Migration {
    version: 1,
    name: "init",
    kind: Kind::InPlace,
    sql: "CREATE TABLE t (x INTEGER);",
}];

/// The rows of `t` in the main database file alone, without its WAL: what a copy of the file
/// (a volume snapshot, a restore) would hold.
fn rows_in_file(path: &Path) -> Vec<i64> {
    let copy = tempfile::tempdir().unwrap();
    let only = copy.path().join("only.db");
    std::fs::copy(path, &only).unwrap();
    let c = rusqlite::Connection::open(&only).unwrap();
    let mut st = c.prepare("SELECT x FROM t ORDER BY x").unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn wal(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", path.display()))
}

/// The WAL's length; none is as good as an empty one.
fn wal_len(path: &Path) -> u64 {
    std::fs::metadata(wal(path)).map_or(0, |m| m.len())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_control_db_checkpoint_lets_the_write_in_flight_land_then_refuses_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.db");
    let (db, _) = Db::open_migrated(&path, &SCHEMA, &dir.path().join("backups"), 4).unwrap();
    let db = Arc::new(db);

    // A write on its way when the checkpoint comes.
    let (started, has_started) = tokio::sync::oneshot::channel();
    let slow = {
        let db = db.clone();
        tokio::spawn(async move {
            db.write(move |c| {
                started.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
                c.execute("INSERT INTO t VALUES (1)", [])
            })
            .await
        })
    };
    has_started.await.unwrap();
    db.checkpoint().await.unwrap();
    assert_eq!(slow.await.unwrap().unwrap(), 1);

    let late = db
        .write(|c| c.execute("INSERT INTO t VALUES (2)", []))
        .await;
    assert!(matches!(late, Err(Error::Sealed)), "{late:?}");
    assert_eq!(wal_len(&path), 0);
    assert_eq!(rows_in_file(&path), [1]);
    // Reads still work.
    let read = db
        .read(|c| c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)))
        .await;
    assert_eq!(read.unwrap(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpointed_mirrors_refuse_writes_and_create_no_new_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();

    let failed = mirrors.checkpoint().await;
    assert!(failed.is_empty(), "{failed:?}");

    let one = dir.path().join("1.db");
    let late = mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (2)", [])
        })
        .await;
    assert!(matches!(late, Err(Error::Sealed)), "{late:?}");
    let other = mirrors
        .write(2, Caller::Sweep, |c| {
            c.execute("INSERT INTO t VALUES (3)", [])
        })
        .await;
    assert!(matches!(other, Err(Error::Sealed)), "{other:?}");
    assert_eq!(wal_len(&one), 0);
    assert_eq!(rows_in_file(&one), [1]);
    assert!(!dir.path().join("2.db").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_first_used_after_the_checkpoint_is_retried_later_never_failed() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    let mut notices = mirrors.notices();
    assert!(mirrors.checkpoint().await.is_empty());

    // A read that would create the mirror: the seal stops the creation, as a passing failure.
    let read = mirrors
        .read(3, Caller::Request, |c| {
            c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
        })
        .await;
    assert!(matches!(read, Err(Error::Unavailable { .. })), "{read:?}");
    while let Ok(n) = notices.try_recv() {
        assert!(
            !matches!(
                n,
                Notice::Status {
                    status: Some(Status::Failed { retry_in: None, .. }),
                    ..
                }
            ),
            "{n:?}"
        );
    }
    assert!(!dir.path().join("3.db").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_control_db_checkpoint_stops_a_backup_under_way_instead_of_waiting_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.db");
    let (db, _) = Db::open_migrated(&path, &SCHEMA, &dir.path().join("backups"), 4).unwrap();
    let db = Arc::new(db);
    // Enough that copying it takes a while, and a last write still in the WAL, which the copy
    // reads along with the file.
    db.write(|c| {
        c.execute_batch(
            "CREATE TABLE big (b BLOB);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128)
             INSERT INTO big SELECT randomblob(1 << 20) FROM n;",
        )
    })
    .await
    .unwrap();
    db.write(|c| c.execute("INSERT INTO t VALUES (1)", []))
        .await
        .unwrap();

    let dest = dir.path().join("backup.db");
    let backup = {
        let (db, dest) = (db.clone(), dest.clone());
        tokio::spawn(async move { db.vacuum_into(&dest).await })
    };
    let writing = PathBuf::from(format!("{}.tmp", dest.display()));
    while !writing.exists() {
        assert!(!backup.is_finished(), "the backup never started");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    db.checkpoint().await.unwrap();

    let stopped = backup.await.unwrap();
    assert!(stopped.is_err(), "{stopped:?}");
    assert!(!dest.exists() && !writing.exists());
    assert_eq!(wal_len(&path), 0);
    assert_eq!(rows_in_file(&path), [1]);
}
