//! The migration walker's step, through `Mirrors::catch_up`: after a deploy with a new in-place
//! migration, a mirror nobody uses is brought up to the build's version in the background, and a
//! mirror the walker hasn't reached still migrates on its first use. A mirror that would have to
//! be created (no file, or a pending `.rebuild.sql` migration) is left for its first use, and a
//! failed one is passed by.
#![allow(clippy::disallowed_methods)] // tests of a database crate open files directly

use dbrt::migrations::{Kind, Migration, file_version};
use dbrt::mirrors::Config;
use dbrt::{Caller, CatchUp, Error, Mirrors, Notice};

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
static V2: [Migration; 2] = [
    INIT,
    m(
        2,
        "tags",
        Kind::InPlace,
        "ALTER TABLE notes ADD COLUMN tag TEXT;",
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

/// v1 mirrors for `accounts`, each holding two notes with the same body, as the build before the
/// deploy left them.
async fn v1_mirrors(dir: &std::path::Path, accounts: &[i64]) {
    let v1 = Mirrors::new(dir, &V1, Config::default());
    for &a in accounts {
        v1.write(a, Caller::Webhook, |c| {
            c.execute_batch("INSERT INTO notes (body) VALUES ('same'), ('same');")
        })
        .await
        .unwrap();
    }
    assert!(v1.checkpoint().await.is_empty());
}

fn version(dir: &std::path::Path, account: i64) -> Option<u32> {
    file_version(&dir.join(format!("{account}.db"))).unwrap()
}

async fn notes(m: &Mirrors, account: i64) -> Result<i64, Error> {
    m.read(account, Caller::Request, |c| {
        c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_deploy_the_walker_migrates_a_mirror_in_place_and_one_it_skips_migrates_on_first_use()
 {
    let dir = tempfile::tempdir().unwrap();
    v1_mirrors(dir.path(), &[1, 2]).await;

    let v2 = Mirrors::new(dir.path(), &V2, Config::default());
    let mut notices = v2.notices();
    assert_eq!(v2.catch_up(1).await.unwrap(), CatchUp::Ready);
    assert_eq!(version(dir.path(), 1), Some(2), "migrated with no request");
    assert_eq!(version(dir.path(), 2), Some(1), "one at a time: 2 not yet");
    // Its data is kept: nothing to import.
    assert_eq!(notes(&v2, 1).await.unwrap(), 2);
    // Walking it again has nothing to do.
    assert_eq!(v2.catch_up(1).await.unwrap(), CatchUp::Ready);

    // Account 2's first use migrates it, as before.
    assert_eq!(notes(&v2, 2).await.unwrap(), 2);
    assert_eq!(version(dir.path(), 2), Some(2));
    while let Ok(n) = notices.try_recv() {
        assert!(!matches!(n, Notice::NeedsImport { .. }), "{n:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_walker_leaves_a_pending_rebuild_and_a_missing_file_for_first_use() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirrors(dir.path(), &[1]).await;

    let v2 = Mirrors::new(dir.path(), &V2_REBUILD, Config::default());
    let mut notices = v2.notices();
    assert_eq!(v2.catch_up(1).await.unwrap(), CatchUp::LeftForFirstUse);
    assert_eq!(v2.catch_up(3).await.unwrap(), CatchUp::LeftForFirstUse);
    assert_eq!(version(dir.path(), 1), Some(1), "the old file is untouched");
    assert!(!dir.path().join("3.db").exists(), "no mirror made for 3");
    assert!(notices.try_recv().is_err(), "no import asked for");

    // The first use rebuilds it, empty, and asks for its import.
    assert_eq!(notes(&v2, 1).await.unwrap(), 0);
    assert_eq!(version(dir.path(), 1), Some(2));
    let mut asked = false;
    while let Ok(n) = notices.try_recv() {
        asked |= matches!(n, Notice::NeedsImport { account: 1, .. });
    }
    assert!(asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_walker_passes_a_failed_migration_by_and_leaves_the_file_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirrors(dir.path(), &[1]).await;

    let v2 = Mirrors::new(dir.path(), &V2_BAD, Config::default());
    let walked = v2.catch_up(1).await;
    assert!(
        matches!(walked, Err(Error::MigrationFailed(_))),
        "{walked:?}"
    );
    assert_eq!(version(dir.path(), 1), Some(1));
    // It stays failed for everyone, as a failed first use leaves it.
    assert!(matches!(
        notes(&v2, 1).await,
        Err(Error::MigrationFailed(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_walker_passes_a_mirror_at_the_builds_version_by_without_opening_it() {
    let dir = tempfile::tempdir().unwrap();
    v1_mirrors(dir.path(), &[1]).await;

    // A start with no new migration: nothing to walk, and no connection taken for it.
    let v1 = Mirrors::new(dir.path(), &V1, Config::default());
    assert_eq!(v1.catch_up(1).await.unwrap(), CatchUp::Ready);
    assert_eq!(v1.open_connections(None), 0);
    assert_eq!(notes(&v1, 1).await.unwrap(), 2);
}
