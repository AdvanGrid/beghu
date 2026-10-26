//! Connection limits as callers of `Mirrors` and `Db` see them.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{Kind, Migration, file_version};
use dbrt::mirrors::Config;
use dbrt::pool::Budget;
use dbrt::{Caller, Db, Error, Mirrors, Unavailable};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const INIT: Migration = Migration {
    version: 1,
    name: "init",
    kind: Kind::InPlace,
    sql: "CREATE TABLE t (x INTEGER);",
};
static SCHEMA: [Migration; 1] = [INIT];
static SCHEMA_V2: [Migration; 2] = [
    INIT,
    Migration {
        version: 2,
        name: "u",
        kind: Kind::InPlace,
        sql: "CREATE TABLE u (y INTEGER);",
    },
];

/// Holds account 1's only reader until the returned sender is dropped or sent to.
async fn hold_a_reader(
    mirrors: &Mirrors,
) -> (
    std::sync::mpsc::Sender<()>,
    tokio::task::JoinHandle<Result<(), Error>>,
) {
    let (release, wait_release) = std::sync::mpsc::channel::<()>();
    let (started, has_started) = tokio::sync::oneshot::channel();
    let m = mirrors.clone();
    let busy = tokio::spawn(async move {
        m.read(1, Caller::Request, move |_| {
            started.send(()).unwrap();
            let _ = wait_release.recv();
            Ok(())
        })
        .await
    });
    has_started.await.unwrap();
    (release, busy)
}

/// Counts how many closures run at once.
#[derive(Clone, Default)]
struct Overlap {
    now: Arc<AtomicUsize>,
    max: Arc<AtomicUsize>,
}

impl Overlap {
    fn hold(&self, d: Duration) -> rusqlite::Result<()> {
        let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.max.fetch_max(n, Ordering::SeqCst);
        std::thread::sleep(d);
        self.now.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }
    fn max(&self) -> usize {
        self.max.load(Ordering::SeqCst)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn an_account_gets_one_writer_and_two_readers_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    let (reads, writes) = (Overlap::default(), Overlap::default());
    let mut tasks = Vec::new();
    for i in 0..5 {
        let (m, r, w) = (mirrors.clone(), reads.clone(), writes.clone());
        tasks.push(tokio::spawn(async move {
            m.read(1, Caller::Request, move |_| {
                r.hold(Duration::from_millis(100))
            })
            .await
            .unwrap();
        }));
        let m = mirrors.clone();
        tasks.push(tokio::spawn(async move {
            m.write(1, Caller::Webhook, move |c| {
                w.hold(Duration::from_millis(50))?;
                c.execute("INSERT INTO t VALUES (?1)", [i])
            })
            .await
            .unwrap();
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(reads.max(), 2);
    assert_eq!(writes.max(), 1);
    assert_eq!(mirrors.open_connections(Some(1)), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn readers_are_query_only_and_every_connection_is_wal_with_synchronous_normal() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    let settings = |c: &rusqlite::Connection| -> rusqlite::Result<(String, i64)> {
        Ok((
            c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
            c.query_row("PRAGMA synchronous", [], |r| r.get(0))?,
        ))
    };
    let write = mirrors
        .write(1, Caller::Webhook, move |c| settings(c))
        .await
        .unwrap();
    let read = mirrors
        .read(1, Caller::Request, move |c| settings(c))
        .await
        .unwrap();
    assert_eq!(write, ("wal".to_string(), 1));
    assert_eq!(read, ("wal".to_string(), 1));
    let refused = mirrors
        .read(1, Caller::Request, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await;
    assert!(matches!(refused, Err(Error::Sqlite(_))), "{refused:?}");
}

#[test]
fn sqlite_is_the_bundled_build_with_fts5_and_without_memory_management() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    let opts: Vec<String> = c
        .prepare("PRAGMA compile_options")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(opts.iter().any(|o| o == "ENABLE_FTS5"), "{opts:?}");
    assert!(opts.iter().any(|o| o == "DEFAULT_MEMSTATUS=0"), "{opts:?}");
    assert!(
        !opts.iter().any(|o| o == "ENABLE_MEMORY_MANAGEMENT"),
        "{opts:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn idle_readers_close_after_a_minute_and_idle_writers_after_five() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    mirrors.read(1, Caller::Request, |_| Ok(())).await.unwrap();
    assert_eq!(mirrors.open_connections(Some(1)), 2);

    tokio::time::sleep(Duration::from_secs(55)).await;
    assert_eq!(mirrors.open_connections(Some(1)), 2);
    tokio::time::sleep(Duration::from_secs(25)).await;
    assert_eq!(
        mirrors.open_connections(Some(1)),
        1,
        "the reader closed after 60 s idle"
    );
    tokio::time::sleep(Duration::from_secs(200)).await;
    assert_eq!(
        mirrors.open_connections(Some(1)),
        1,
        "the writer stays for 5 min"
    );
    tokio::time::sleep(Duration::from_secs(40)).await;
    assert_eq!(mirrors.open_connections(Some(1)), 0);
}

#[tokio::test(start_paused = true)]
async fn at_the_cap_the_least_recently_used_idle_connection_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        budget: Budget {
            max: 2,
            ..Budget::default()
        },
        ..Config::default()
    };
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, cfg);
    for acct in [1, 2, 3] {
        mirrors
            .read(acct, Caller::Request, |_| Ok(()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert_eq!(mirrors.open_connections(None), 2);
    assert_eq!(
        mirrors.open_connections(Some(1)),
        0,
        "account 1's reader was the least recently used"
    );
    assert_eq!(mirrors.open_connections(Some(2)), 1);
    assert_eq!(mirrors.open_connections(Some(3)), 1);

    // Using account 2 again makes account 3's reader the oldest.
    mirrors.read(2, Caller::Request, |_| Ok(())).await.unwrap();
    mirrors.read(1, Caller::Request, |_| Ok(())).await.unwrap();
    assert_eq!(mirrors.open_connections(Some(3)), 0);
    assert_eq!(mirrors.open_connections(Some(2)), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn at_the_cap_with_nothing_idle_a_caller_waits_then_gets_retry_after() {
    let dir = tempfile::tempdir().unwrap();
    let budget = Budget {
        max: 1,
        wait: Duration::from_millis(100),
        retry_after: Duration::from_secs(1),
        ..Budget::default()
    };
    let mirrors = Mirrors::new(
        dir.path(),
        &SCHEMA,
        Config {
            budget,
            ..Config::default()
        },
    );
    // Create both mirrors first; their creation doesn't hold a lane connection.
    for acct in [1, 2] {
        mirrors
            .read(acct, Caller::Request, |_| Ok(()))
            .await
            .unwrap();
    }

    let (release, busy) = hold_a_reader(&mirrors).await;

    let r = mirrors.read(2, Caller::Request, |_| Ok(())).await;
    match r {
        Err(
            e @ Error::Unavailable {
                reason: Unavailable::AtCapacity,
                ..
            },
        ) => assert_eq!(e.retry_after(), Some(Duration::from_secs(1))),
        r => panic!("expected 503 at the cap, got {r:?}"),
    }

    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    mirrors.read(2, Caller::Request, |_| Ok(())).await.unwrap();
    assert_eq!(mirrors.open_connections(None), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn at_the_cap_webhooks_and_sweeps_wait_for_a_connection_instead_of_giving_up() {
    let dir = tempfile::tempdir().unwrap();
    let budget = Budget {
        max: 1,
        wait: Duration::from_millis(100),
        ..Budget::default()
    };
    let mirrors = Mirrors::new(
        dir.path(),
        &SCHEMA,
        Config {
            budget,
            ..Config::default()
        },
    );
    for acct in [1, 2] {
        mirrors
            .read(acct, Caller::Request, |_| Ok(()))
            .await
            .unwrap();
    }
    let (release, busy) = hold_a_reader(&mirrors).await;

    let webhook = {
        let m = mirrors.clone();
        tokio::spawn(async move {
            m.write(2, Caller::Webhook, |c| {
                c.execute("INSERT INTO t VALUES (1)", [])
            })
            .await
        })
    };
    let sweep = {
        let m = mirrors.clone();
        tokio::spawn(async move {
            m.read(2, Caller::Sweep, |c| {
                c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
            })
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !webhook.is_finished() && !sweep.is_finished(),
        "still waiting, well past the request's 100 ms"
    );

    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    assert_eq!(webhook.await.unwrap().unwrap(), 1);
    sweep.await.unwrap().unwrap();
    assert_eq!(mirrors.open_connections(None), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_migration_waits_for_a_connection_under_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let v1 = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    v1.write(2, Caller::Webhook, |c| {
        c.execute("INSERT INTO t VALUES (1)", [])
    })
    .await
    .unwrap();
    let path = v1.path(2);
    drop(v1);

    let budget = Budget {
        max: 1,
        ..Budget::default()
    };
    let v2 = Mirrors::new(
        dir.path(),
        &SCHEMA_V2,
        Config {
            budget,
            ..Config::default()
        },
    );
    v2.read(1, Caller::Request, |_| Ok(())).await.unwrap();
    let (release, busy) = hold_a_reader(&v2).await;

    let webhook = {
        let m = v2.clone();
        tokio::spawn(async move {
            m.write(2, Caller::Webhook, |c| {
                c.execute("INSERT INTO u VALUES (1)", [])
            })
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        file_version(&path).unwrap(),
        Some(1),
        "the migration hasn't run past the cap"
    );
    assert_eq!(v2.open_connections(None), 1);

    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    webhook.await.unwrap().unwrap();
    assert_eq!(file_version(&path).unwrap(), Some(2));
    assert_eq!(v2.open_connections(None), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn the_control_db_gets_one_writer_and_four_readers() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Db::open_migrated(
        &dir.path().join("control.db"),
        &SCHEMA,
        &dir.path().join("backups"),
        4,
    )
    .unwrap();
    let db = Arc::new(db);
    let (reads, writes) = (Overlap::default(), Overlap::default());
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (d, r) = (db.clone(), reads.clone());
        tasks.push(tokio::spawn(async move {
            d.read(move |_| r.hold(Duration::from_millis(100)))
                .await
                .unwrap()
        }));
        let (d, w) = (db.clone(), writes.clone());
        tasks.push(tokio::spawn(async move {
            d.write(move |_| w.hold(Duration::from_millis(20)))
                .await
                .unwrap()
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(reads.max(), 4);
    assert_eq!(writes.max(), 1);
    assert_eq!(db.open_connections(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_dropped_mid_query_gives_its_connection_back_to_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let idle = Duration::from_millis(40);
    let budget = Budget {
        max: 1,
        reader_idle: idle,
        writer_idle: idle,
        ..Budget::default()
    };
    let mirrors = Mirrors::new(
        dir.path(),
        &SCHEMA,
        Config {
            budget,
            ..Config::default()
        },
    );
    let (started, has_started) = tokio::sync::oneshot::channel();
    let m = mirrors.clone();
    let request = tokio::spawn(async move {
        m.read(1, Caller::Request, move |_| {
            started.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            Ok(())
        })
        .await
    });
    has_started.await.unwrap();
    // The client went away: the handler's future is dropped while its query still runs.
    request.abort();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while mirrors.open_connections(None) > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the dropped request's place under the cap was never given back"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    mirrors.read(1, Caller::Request, |_| Ok(())).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn requests_dropped_mid_query_keep_their_turn_until_the_query_ends() {
    let dir = tempfile::tempdir().unwrap();
    let mirrors = Mirrors::new(dir.path(), &SCHEMA, Config::default());
    mirrors
        .write(1, Caller::Webhook, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])
        })
        .await
        .unwrap();
    let (reads, writes) = (Overlap::default(), Overlap::default());
    let mut most_open = mirrors.open_connections(Some(1));

    // Each request starts its query, then its client goes away and the handler's future is dropped.
    for i in 0..6 {
        let (started, has_started) = tokio::sync::oneshot::channel();
        let m = mirrors.clone();
        let request = if i % 2 == 0 {
            let w = writes.clone();
            tokio::spawn(async move {
                m.write(1, Caller::Request, move |_| {
                    started.send(()).unwrap();
                    w.hold(Duration::from_millis(200))
                })
                .await
            })
        } else {
            let r = reads.clone();
            tokio::spawn(async move {
                m.read(1, Caller::Request, move |_| {
                    started.send(()).unwrap();
                    r.hold(Duration::from_millis(200))
                })
                .await
            })
        };
        has_started.await.unwrap();
        request.abort();
        most_open = most_open.max(mirrors.open_connections(Some(1)));
    }
    // These wait for the dropped requests' queries, which still hold the turns.
    let w = writes.clone();
    mirrors
        .write(1, Caller::Webhook, move |_| w.hold(Duration::ZERO))
        .await
        .unwrap();
    mirrors.read(1, Caller::Request, |_| Ok(())).await.unwrap();
    most_open = most_open.max(mirrors.open_connections(Some(1)));

    assert_eq!(writes.max(), 1, "writes ran at once");
    assert!(reads.max() <= 2, "{} reads ran at once", reads.max());
    assert!(
        most_open <= 3,
        "{most_open} connections open to one account"
    );
}
