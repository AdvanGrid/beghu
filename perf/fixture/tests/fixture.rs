//! The fixture is a real mirror: the current build opens it as-is (no migration, no rebuild)
//! and serves the list from it. This is the CI check that the generator still loads after each
//! migration.

use fixture::{GENERATOR_HASH, Scale, cached, generate};
use mirror_db::{Caller, Config, Mirrors, frag, q};

#[tokio::test(flavor = "multi_thread")]
async fn the_1k_fixture_opens_with_the_current_schema_and_serves_the_default_list() {
    let dir = tempfile::tempdir().unwrap();
    let path = cached(Scale::K1, dir.path()).unwrap();
    let summary =
        std::fs::read_to_string(dir.path().join(format!("fixture-1k-{GENERATOR_HASH}.json")))
            .unwrap();

    let mirrors_dir = dir.path().join("mirrors");
    std::fs::create_dir(&mirrors_dir).unwrap();
    std::fs::copy(&path, mirrors_dir.join("1.db")).unwrap();
    let mirrors = Mirrors::new(&mirrors_dir, Config::default());
    let mut notices = mirrors.notices();

    let (open, top) = mirrors
        .read(1, Caller::Request, |c| {
            let open = q::item_ids(c, &frag::state("open"), "issue", i64::MAX)?;
            let top = q::hydrate(c, &open[..40])?;
            Ok((open, top))
        })
        .await
        .unwrap();
    assert!(
        notices.try_recv().is_err(),
        "the fixture needed no migration or rebuild"
    );
    assert!(
        summary.contains(&format!("\"open_issues\": {},", open.len())),
        "{summary}"
    );
    let targets: Vec<String> = top.iter().map(|r| r.id.to_string()).collect();
    assert!(
        summary.contains(&format!("\"detail_targets\": [{}]", targets.join(", "))),
        "{summary}"
    );
    assert!(
        top.iter()
            .all(|r| r.comments_count == 30 && r.owner == "acme")
    );
}

#[test]
fn the_same_scale_always_gives_the_same_bytes_and_the_cache_keeps_them() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a.db"), dir.path().join("b.db"));
    generate(Scale::K1, &a).unwrap();
    generate(Scale::K1, &b).unwrap();
    assert!(
        std::fs::read(&a).unwrap() == std::fs::read(&b).unwrap(),
        "two runs differ"
    );

    let first = cached(Scale::K1, dir.path()).unwrap();
    let written = std::fs::metadata(&first).unwrap().modified().unwrap();
    let second = cached(Scale::K1, dir.path()).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        std::fs::metadata(&second).unwrap().modified().unwrap(),
        written,
        "a cached fixture isn't regenerated"
    );
    assert!(std::fs::read(&first).unwrap() == std::fs::read(&a).unwrap());
}
