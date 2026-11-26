//! The coverage test (#178): the committed recordings of beghu's own PR and the hand-written
//! cases together hold every feature the PR view's tests and gates need. A feature the recordings
//! lack gets a small case in `fixtures/pr-view/cases/`, written only for what they lack: a case
//! whose features a recording now holds is deleted (re-recording is the owner's call, and reruns
//! this test).
//!
//! Some features only a second recording can hold (`carried`, "Since the last analysis"): they
//! wait on v2, and fail here once v2 is committed if it still lacks them.

use analysis::{
    Analysis, CarriedKind, ConflictKind, Context, Direction, Evidence, Previous, When, validate,
};
use analysis_fixtures::{Committed, committed, recordings};
use std::collections::{BTreeMap, BTreeSet};

/// Every feature, by the name a case for it is filed under.
const FEATURES: &[&str] = &[
    "when-build",
    "when-test",
    "uses",
    "direction-forward",
    "direction-back",
    "direction-both",
    "drawn-partial",
    "sub-purposes",
    "rule-holds",
    "rule-breaks",
    "shared-cause",
    "conflict-stated-code",
    "conflict-purpose-purpose",
    "conflict-purpose-outside",
    "unclaimed",
    "served-issues",
    "carried-renamed",
    "carried-merged",
    "carried-split",
    "carried-dropped",
    "since-last-analysis",
    "chapters",
    "evidence-code",
    "evidence-description",
    "evidence-issue",
];

/// What only a second recording holds: a previous analysis to carry from and compare with.
const AFTER_V2: &[&str] = &[
    "carried-renamed",
    "carried-merged",
    "carried-split",
    "carried-dropped",
    "since-last-analysis",
];

/// The features `a` holds. `second` says it's a recording made after another of the same PR (a
/// view of it has "Since the last analysis").
fn features(a: &Analysis, second: bool) -> BTreeSet<&'static str> {
    let mut f = BTreeSet::new();
    let mut add = |name: &'static str, yes: bool| {
        if yes {
            f.insert(name);
        }
    };
    add("when-build", a.edges.iter().any(|e| e.when == When::Build));
    add("when-test", a.edges.iter().any(|e| e.when == When::Test));
    add("uses", a.edges.iter().any(|e| e.uses.is_some()));
    for (name, d) in [
        ("direction-forward", Direction::Forward),
        ("direction-back", Direction::Back),
        ("direction-both", Direction::Both),
    ] {
        add(
            name,
            a.edges
                .iter()
                .any(|e| e.data.as_ref().is_some_and(|x| x.direction == d)),
        );
    }
    add("drawn-partial", a.nodes.iter().any(|n| n.drawn.is_some()));
    add(
        "sub-purposes",
        a.purposes.iter().any(|p| p.parent.is_some()),
    );
    let rules: Vec<_> = a
        .purposes
        .iter()
        .flat_map(|p| p.rules.iter().flatten())
        .collect();
    add("rule-holds", rules.iter().any(|r| r.checked.holds > 0));
    add("rule-breaks", rules.iter().any(|r| r.checked.breaks > 0));
    let mut causes: BTreeMap<&str, usize> = BTreeMap::new();
    for c in &a.conflicts {
        if let Some(cause) = &c.cause {
            *causes.entry(cause).or_default() += 1;
        }
    }
    add("shared-cause", causes.values().any(|n| *n >= 2));
    for (name, k) in [
        ("conflict-stated-code", ConflictKind::StatedCode),
        ("conflict-purpose-purpose", ConflictKind::PurposePurpose),
        ("conflict-purpose-outside", ConflictKind::PurposeOutside),
    ] {
        add(name, a.conflicts.iter().any(|c| c.kind == k));
    }
    add("unclaimed", !a.unclaimed.is_empty());
    let evidence: Vec<&Evidence> = a.claims.iter().flat_map(|c| &c.evidence).collect();
    let issue = evidence.iter().any(|e| matches!(e, Evidence::Issue { .. }));
    add("served-issues", issue);
    for (name, k) in [
        ("carried-renamed", CarriedKind::Renamed),
        ("carried-merged", CarriedKind::Merged),
        ("carried-split", CarriedKind::Split),
        ("carried-dropped", CarriedKind::Dropped),
    ] {
        add(name, a.carried.iter().any(|c| c.kind == k));
    }
    add("since-last-analysis", second);
    add(
        "chapters",
        a.scenarios.iter().any(|s| s.chapters.len() >= 2),
    );
    add(
        "evidence-code",
        evidence.iter().any(|e| matches!(e, Evidence::Code { .. })),
    );
    add(
        "evidence-description",
        evidence
            .iter()
            .any(|e| matches!(e, Evidence::Description { .. })),
    );
    add("evidence-issue", issue);
    f
}

/// The analysis at this build's schema, as every reader migrates it.
fn migrated(c: &Committed) -> Analysis {
    let pinned = c.pinned();
    let ctx = Context {
        changed_files: Some(pinned.files.iter().map(|f| f.path.clone()).collect()),
        previous: Previous::Unknown,
    };
    let out = validate(&c.analysis_text(), &ctx, None);
    assert!(
        out.report.errors.is_empty(),
        "{}: {:#?}",
        c.name,
        out.report.errors
    );
    out.analysis.unwrap()
}

#[test]
fn the_recordings_and_the_cases_hold_every_feature() {
    let all = committed();
    let v2 = recordings().iter().any(|(_, vs)| vs.contains(&2));
    let mut recorded: BTreeSet<&str> = BTreeSet::new();
    let mut cases: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for c in &all {
        let second = c.name.ends_with("analysis-v2.json");
        let f = features(&migrated(c), second);
        if c.name.starts_with("cases/") {
            cases.insert(c.name.clone(), f);
        } else {
            recorded.extend(f);
        }
    }
    assert!(!recorded.is_empty(), "no recording is committed");

    // Each case is for a feature the recordings lack, and is named after one it holds.
    for (name, f) in &cases {
        let feature = name.trim_start_matches("cases/").trim_end_matches(".json");
        assert!(
            FEATURES.contains(&feature),
            "{name} isn't named after a feature (one of {FEATURES:?})"
        );
        assert!(f.contains(feature), "{name} doesn't hold `{feature}`");
        assert!(
            !recorded.contains(feature),
            "the recordings hold `{feature}` now: delete {name}"
        );
    }

    let covered: BTreeSet<&str> = recorded
        .iter()
        .copied()
        .chain(cases.values().flatten().copied())
        .collect();
    let missing: Vec<&str> = FEATURES
        .iter()
        .copied()
        .filter(|f| !covered.contains(f))
        .filter(|f| v2 || !AFTER_V2.contains(f))
        .collect();
    assert!(
        missing.is_empty(),
        "no recording or case holds {missing:?}: add a case in fixtures/pr-view/cases/<feature>.json, quoting the recorded PR's code at v1"
    );
    if !v2 {
        let waiting: Vec<&str> = AFTER_V2
            .iter()
            .copied()
            .filter(|f| !covered.contains(f))
            .collect();
        eprintln!("waiting on v2: {waiting:?}");
    }
}

/// Every committed analysis passes the validator's checks that need no code, at this build's
/// schema (CI's `pr-view-fixtures` job runs the rest, against the real commits).
#[test]
fn every_committed_analysis_migrates_and_validates() {
    for c in committed() {
        migrated(&c);
    }
}
