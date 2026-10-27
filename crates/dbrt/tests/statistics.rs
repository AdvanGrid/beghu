//! The query planner's statistics: a mirror gets them (`sqlite_stat1`) once its writer has
//! filled it, and keeps them current across migrations, so the planner can tell a rare filter
//! value from a common one.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::migrations::{Kind, Migration};
use dbrt::mirrors::Config;
use dbrt::pool::Budget;
use dbrt::{Caller, Mirrors};
use std::time::Duration;

const INIT: Migration = Migration {
    version: 1,
    name: "init",
    kind: Kind::InPlace,
    sql: "CREATE TABLE t (x INTEGER); CREATE INDEX t_x ON t(x);",
};
static V1: [Migration; 1] = [INIT];
static V2: [Migration; 2] = [
    INIT,
    Migration {
        version: 2,
        name: "y",
        kind: Kind::InPlace,
        sql: "ALTER TABLE t ADD COLUMN y INTEGER; CREATE INDEX t_y ON t(y);",
    },
];

const ACCT: i64 = 1;

/// The indexes of `t` the planner has statistics for.
async fn analyzed(m: &Mirrors) -> Vec<String> {
    m.read(ACCT, Caller::Request, |c| {
        let has = c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1'",
            [],
            |r| r.get::<_, i64>(0),
        )?;
        if has == 0 {
            return Ok(Vec::new());
        }
        let mut st = c.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 't' ORDER BY idx")?;
        st.query_map([], |r| r.get(0))?.collect()
    })
    .await
    .unwrap()
}

async fn fill(m: &Mirrors) {
    m.write(ACCT, Caller::Webhook, |c| {
        c.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
             INSERT INTO t (x) SELECT i % 7 FROM n;",
        )
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_writer_that_closes_leaves_statistics_for_what_it_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let idle = Duration::from_millis(40);
    let m = Mirrors::new(
        dir.path(),
        &V1,
        Config {
            budget: Budget {
                reader_idle: idle,
                writer_idle: idle,
                ..Budget::default()
            },
            ..Config::default()
        },
    );
    fill(&m).await;
    // The writer closes once it has been idle a while, off the caller's path: poll.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let got = analyzed(&m).await;
        if got == ["t_x"] {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no statistics: {got:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_migrated_in_place_has_statistics_for_its_new_indexes() {
    let dir = tempfile::tempdir().unwrap();
    fill(&Mirrors::new(dir.path(), &V1, Config::default())).await;

    let v2 = Mirrors::new(dir.path(), &V2, Config::default());
    assert_eq!(analyzed(&v2).await, ["t_x", "t_y"]);
}

/// The indexes of `t` the planner has per-value samples for.
async fn sampled(m: &Mirrors) -> Vec<String> {
    m.read(ACCT, Caller::Request, |c| {
        let has = c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat4'",
            [],
            |r| r.get::<_, i64>(0),
        )?;
        if has == 0 {
            return Ok(Vec::new());
        }
        let mut st = c.prepare("SELECT DISTINCT idx FROM sqlite_stat4 WHERE tbl = 't'")?;
        st.query_map([], |r| r.get(0))?.collect()
    })
    .await
    .unwrap()
}

/// The planner's statistics are a sample of each index, which can't tell a rare value from a
/// common one. The indexes the schema names get per-value samples too (`sqlite_stat4`).
#[tokio::test(flavor = "multi_thread")]
async fn a_writer_that_closes_samples_the_values_of_the_named_indexes() {
    let dir = tempfile::tempdir().unwrap();
    let idle = Duration::from_millis(40);
    let m = Mirrors::new(
        dir.path(),
        &V1,
        Config {
            budget: Budget {
                reader_idle: idle,
                writer_idle: idle,
                ..Budget::default()
            },
            sampled_indexes: &["t_x"],
            ..Config::default()
        },
    );
    fill(&m).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let got = sampled(&m).await;
        if got == ["t_x"] {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no samples: {got:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
