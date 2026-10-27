//! Opening the truth refuses a fixture at the wrong mirror schema version, rather than migrating
//! it into something the fake's queries don't expect.

use dbrt::migrations::create_fresh;
use fake_db::{Error, MIGRATIONS, Truth};
use std::path::Path;

fn open_with_fixture_at(dir: &Path, version: usize) -> Result<Truth, Error> {
    let fixture = dir.join("fixture.db");
    create_fresh(&fixture, &MIGRATIONS[..version]).unwrap();
    Truth::open(&dir.join("truth.db"), &fixture, Box::new(|_| Ok(())))
}

#[test]
fn a_fixture_newer_than_the_build_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let err = open_with_fixture_at(dir.path(), MIGRATIONS.len())
        .err()
        .expect("refused");
    let msg = err.to_string();
    assert!(matches!(err, Error::FixtureVersion { .. }), "{msg}");
    assert!(msg.contains("newer than this build"), "{msg}");
}

#[test]
fn a_fixture_older_than_the_build_is_refused_as_stale() {
    let dir = tempfile::tempdir().unwrap();
    let err = open_with_fixture_at(dir.path(), 0).err().expect("refused");
    let msg = err.to_string();
    assert!(matches!(err, Error::FixtureVersion { .. }), "{msg}");
    assert!(msg.contains("stale"), "{msg}");
}

#[test]
fn a_refused_fixture_leaves_no_copy_behind() {
    let dir = tempfile::tempdir().unwrap();
    open_with_fixture_at(dir.path(), 0).err().expect("refused");
    let copies: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with("truth.db"))
        .collect();
    assert!(copies.is_empty(), "{copies:?}");
}

#[test]
fn a_fixture_at_the_build_s_mirror_schema_opens() {
    let dir = tempfile::tempdir().unwrap();
    open_with_fixture_at(dir.path(), fake_db::BASE_VERSION as usize).unwrap();
}

#[tokio::test]
async fn a_failed_reset_keeps_the_truth_serving() {
    let dir = tempfile::tempdir().unwrap();
    let truth = open_with_fixture_at(dir.path(), fake_db::BASE_VERSION as usize).unwrap();
    create_fresh(truth.fixture(), &MIGRATIONS[..0]).unwrap();

    let err = truth.reset().expect_err("refused");
    assert!(matches!(err, Error::FixtureVersion { .. }), "{err}");

    let from = truth.read(fake_db::q::fixture).await.unwrap();
    assert_eq!(from.as_deref(), Some(&*truth.fixture().to_string_lossy()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_never_waits_for_a_write_under_way() {
    let dir = tempfile::tempdir().unwrap();
    let truth = open_with_fixture_at(dir.path(), fake_db::BASE_VERSION as usize).unwrap();
    let (holding, held) = std::sync::mpsc::channel();
    let (read_done, read) = std::sync::mpsc::channel::<()>();
    // A write that holds the truth until the read below is done, or gives up after 10 s.
    let writer = tokio::spawn({
        let truth = truth.clone();
        async move {
            truth
                .write(move |_| {
                    holding.send(()).unwrap();
                    Ok(read
                        .recv_timeout(std::time::Duration::from_secs(10))
                        .is_ok())
                })
                .await
                .unwrap()
        }
    });
    tokio::task::spawn_blocking(move || held.recv().unwrap())
        .await
        .unwrap();
    let from = truth.read(fake_db::q::fixture).await.unwrap();
    assert!(from.is_some());
    read_done.send(()).unwrap();
    assert!(writer.await.unwrap(), "the read waited for the write");
}
