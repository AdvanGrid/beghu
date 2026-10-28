//! Deleting an account's mirror, as callers of `Mirrors` see it: the file goes once the reads
//! and write in flight are done, nothing brings it back until the account is revived, and a
//! revived account's first use creates an empty mirror and asks for its import.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{Kind, Migration};
use dbrt::mirrors::Config;
use dbrt::{Caller, Decision, Error, Mirrors, Notice};
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

#[tokio::test(flavor = "multi_thread")]
async fn a_conditional_delete_checks_once_the_write_in_flight_is_done_and_keeps_the_file_when_told()
{
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    let mut notices = mirrors.notices();
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    while notices.try_recv().is_ok() {}

    // A write in flight as the delete comes: the check runs only once it's done.
    let landed = Arc::new(AtomicBool::new(false));
    let slow = {
        let (m, landed) = (mirrors.clone(), landed.clone());
        tokio::spawn(async move {
            m.write(1, Caller::Webhook, move |c| {
                std::thread::sleep(Duration::from_millis(300));
                c.execute("INSERT INTO t VALUES (2)", [])?;
                landed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let seen = Arc::new(AtomicBool::new(false));
    let check = {
        let (landed, seen) = (landed.clone(), seen.clone());
        async move {
            seen.store(landed.load(Ordering::SeqCst), Ordering::SeqCst);
            false
        }
    };
    let deleting = mirrors.delete_if(1, check);
    // Refused while it's decided, as during any delete.
    let during = count(&mirrors, 1).await;
    assert!(matches!(during, Err(Error::Deleted)), "{during:?}");
    assert_eq!(deleting.await.unwrap(), Decision::Kept, "the check kept it");
    slow.await.unwrap().unwrap();
    assert!(
        seen.load(Ordering::SeqCst),
        "checked after the write landed"
    );

    // Kept, and used as before: nothing to import.
    assert!(dir.path().join("1.db").exists());
    assert_eq!(count(&mirrors, 1).await.unwrap(), 2);
    while let Ok(n) = notices.try_recv() {
        assert!(!matches!(n, Notice::NeedsImport { .. }), "{n:?}");
    }

    // A check that says yes deletes it.
    assert_eq!(
        mirrors.delete_if(1, async { true }).await.unwrap(),
        Decision::Deleted
    );
    assert!(!dir.path().join("1.db").exists());
    assert!(matches!(count(&mirrors, 1).await, Err(Error::Deleted)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_delete_asked_while_a_check_runs_deletes_the_file_whatever_the_check_says() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();

    // The check is under way (it holds the mirror) when the account loses access.
    let (checking, checked) = tokio::sync::oneshot::channel::<()>();
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let conditional = mirrors.delete_if(1, async move {
        let _ = checking.send(());
        let _ = released.await;
        false
    });
    let conditional = tokio::spawn(conditional);
    checked.await.unwrap();
    let plain = tokio::spawn(mirrors.delete(1));
    tokio::time::sleep(Duration::from_millis(50)).await;
    release.send(()).unwrap();

    plain.await.unwrap().unwrap();
    assert_eq!(conditional.await.unwrap().unwrap(), Decision::Overruled);
    assert!(!dir.path().join("1.db").exists(), "the plain delete wins");
    assert!(matches!(count(&mirrors, 1).await, Err(Error::Deleted)));

    // A conditional delete that joins a plain one under way never runs its check.
    mirrors.revive(1);
    assert_eq!(count(&mirrors, 1).await.unwrap(), 0);
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
    let plain = mirrors.delete(1);
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let conditional = mirrors.delete_if(1, {
        let ran = ran.clone();
        async move {
            ran.store(true, std::sync::atomic::Ordering::SeqCst);
            false
        }
    });
    plain.await.unwrap();
    assert_eq!(conditional.await.unwrap(), Decision::Overruled);
    assert!(
        !ran.load(std::sync::atomic::Ordering::SeqCst),
        "no check ran"
    );
    assert!(!dir.path().join("1.db").exists());
    slow.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_check_that_panics_keeps_the_file_and_the_mirror_usable() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    let r = mirrors
        .delete_if(1, async { panic!("the check failed") })
        .await;
    assert!(matches!(r, Ok(Decision::Kept)), "{r:?}");
    assert!(dir.path().join("1.db").exists());
    assert_eq!(count(&mirrors, 1).await.unwrap(), 1);
}
