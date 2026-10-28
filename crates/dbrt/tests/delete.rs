//! Deleting an account's mirror, as callers of `Mirrors` see it: the file goes once the reads
//! and write in flight are done, nothing brings it back until the account is revived, and a
//! revived account's first use creates an empty mirror and asks for its import.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{Kind, Migration};
use dbrt::mirrors::Config;
use dbrt::{Caller, Error, Mirrors, Notice};
use std::time::Duration;

static SCHEMA: [Migration; 1] = [Migration {
    version: 1,
    name: "init",
    kind: Kind::InPlace,
    sql: "CREATE TABLE t (x INTEGER);",
}];

async fn count(m: &Mirrors, account: i64) -> Result<i64, Error> {
    m.read(account, Caller::Request, |c| {
        c.query_row("SELECT count(*) FROM t", [], |r| r.get(0))
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_mirror_is_gone_and_refused_until_revived_then_starts_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    let mut notices = mirrors.notices();
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    assert_eq!(count(&mirrors, 1).await.unwrap(), 1);
    while notices.try_recv().is_ok() {}

    // A read in flight as the delete comes: it finishes first, then the file goes.
    let slow = {
        let m = mirrors.clone();
        tokio::spawn(async move {
            m.read(1, Caller::Request, |c| {
                std::thread::sleep(Duration::from_millis(300));
                c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
            })
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    mirrors.delete(1).await.unwrap();
    assert_eq!(slow.await.unwrap().unwrap(), 1);
    let file = dir.path().join("1.db");
    assert!(!file.exists());
    assert!(!dir.path().join("1.db-wal").exists());
    assert_eq!(mirrors.open_connections(Some(1)), 0);

    // Nothing brings it back meanwhile: not a webhook, not a request.
    let late = mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (2)", [])
        })
        .await;
    assert!(matches!(late, Err(Error::Deleted)), "{late:?}");
    assert!(matches!(count(&mirrors, 1).await, Err(Error::Deleted)));
    assert!(!file.exists());
    // Another account's mirror is untouched.
    assert_eq!(count(&mirrors, 2).await.unwrap(), 0);
    while notices.try_recv().is_ok() {}

    mirrors.revive(1);
    assert_eq!(count(&mirrors, 1).await.unwrap(), 0);
    let mut asked = false;
    while let Ok(n) = notices.try_recv() {
        asked |= matches!(n, Notice::NeedsImport { account: 1, .. });
    }
    assert!(asked, "a revived mirror asks for its import");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delete_after_the_drain_sealed_the_mirrors_leaves_the_file_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    assert!(mirrors.checkpoint().await.is_empty());

    let r = mirrors.delete(1).await;
    assert!(matches!(r, Err(Error::Sealed)), "{r:?}");
    assert!(dir.path().join("1.db").exists());
}
