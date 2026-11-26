//! The coverage test (#178): the committed recordings of beghu's own PR and the hand-written
//! cases together hold every feature the PR view's tests and gates need. A feature the recordings
//! lack gets a small case in `fixtures/pr-view/cases/`, written only for what they lack: a case
//! whose features a recording now holds is deleted (re-recording is the owner's call, and reruns
//! this test).
//!
//! Some features only a later analysis can hold (`carried`, "Since the last analysis"): they
//! wait on v2, and fail here once v2 is committed if it still lacks them. A case for one is named
//! `cases/<feature>.after-v1.json`, and is checked and uploaded as a later analysis after v1.
//!
//! Each conflict kind, `carried` kind and evidence kind is a feature of its own, named by an
//! exhaustive `match` (a new kind fails the build here) and required by the schema's own list of
//! them (so, once named, it fails the test until a recording or a case holds it).

use analysis::{
    Analysis, CarriedKind, ConflictKind, Context, Direction, Evidence, PinnedPr, When, validate,
};
use analysis_fixtures::{Committed, committed, recordings};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn conflict(k: ConflictKind) -> &'static str {
    match k {
        ConflictKind::StatedCode => "conflict-stated-code",
        ConflictKind::PurposePurpose => "conflict-purpose-purpose",
        ConflictKind::PurposeOutside => "conflict-purpose-outside",
    }
}

fn carried(k: CarriedKind) -> &'static str {
    match k {
        CarriedKind::Renamed => "carried-renamed",
        CarriedKind::Merged => "carried-merged",
        CarriedKind::Split => "carried-split",
        CarriedKind::Dropped => "carried-dropped",
    }
}

fn evidence(e: &Evidence) -> &'static str {
    match e {
        Evidence::Code { .. } => "evidence-code",
        Evidence::Description { .. } => "evidence-description",
        Evidence::Issue { .. } => "evidence-issue",
    }
}

/// Every variant's name as the schema writes it, from serde's refusal of one it doesn't have
/// (`unknown variant `?`, expected one of `a`, `b``): `probe` is a value naming `?`.
fn variants<T: DeserializeOwned>(probe: Value) -> Vec<String> {
    let err = serde_json::from_value::<T>(probe)
        .err()
        .expect("`?` is no variant")
        .to_string();
    let list = err
        .split_once("expected one of ")
        .unwrap_or_else(|| panic!("{err}"))
        .1;
    list.split(", ")
        .map(|v| {
            v.trim_matches(|c: char| c == '`' || c.is_whitespace())
                .to_owned()
        })
        .collect()
}

/// Every feature, by the name a case for it is filed under: these, and one for each conflict,
/// `carried` and evidence kind ([`kinds`]).
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
    "since-last-analysis",
    "chapters",
];

/// One feature per kind the schema has: each conflict kind, `carried` kind and evidence kind.
fn kinds() -> Vec<String> {
    let mut out = Vec::new();
    for v in variants::<ConflictKind>(json!("?")) {
        out.push(format!("conflict-{v}"));
    }
    for v in variants::<CarriedKind>(json!("?")) {
        out.push(format!("carried-{v}"));
    }
    for v in variants::<Evidence>(json!({ "kind": "?" })) {
        out.push(format!("evidence-{v}"));
    }
    out
}

/// Every feature.
fn all_features() -> Vec<String> {
    FEATURES
        .iter()
        .map(|f| (*f).to_owned())
        .chain(kinds())
        .collect()
}

/// What only a later analysis holds: a previous analysis to carry from and compare with.
fn later_only(feature: &str) -> bool {
    feature.starts_with("carried-") || feature == "since-last-analysis"
}

/// The features `a`, whose run pinned `pr`, holds. `later` says it's an analysis made after
/// another of the same PR (a view of it has "Since the last analysis").
fn features(a: &Analysis, pr: &PinnedPr, later: bool) -> BTreeSet<&'static str> {
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
    add("unclaimed", !a.unclaimed.is_empty());
    // Served issues: a purpose drawing on an issue the run served (`pr.json`'s `issues`, the
    // ones the PR links), through a claim quoting it in its walk, its parts or lines, or its
    // rules' sources.
    let claims: BTreeMap<&str, &analysis::Claim> =
        a.claims.iter().map(|c| (c.id.as_str(), c)).collect();
    let served = |e: &Evidence| match e {
        Evidence::Issue { repo, number, .. } => pr
            .issues
            .iter()
            .any(|i| i.repo.eq_ignore_ascii_case(repo) && i.number == *number),
        Evidence::Code { .. } | Evidence::Description { .. } => false,
    };
    add(
        "served-issues",
        a.purposes.iter().any(|p| {
            p.walk
                .claims
                .iter()
                .chain(p.serves.iter().flat_map(|s| &s.claims))
                .chain(p.carries.iter().flat_map(|c| &c.claims))
                .chain(p.rules.iter().flatten().flat_map(|r| &r.sources))
                .filter_map(|id| claims.get(id.as_str()))
                .any(|c| c.evidence.iter().any(served))
        }),
    );
    add("since-last-analysis", later);
    add(
        "chapters",
        a.scenarios.iter().any(|s| s.chapters.len() >= 2),
    );
    f.extend(a.conflicts.iter().map(|c| conflict(c.kind)));
    f.extend(a.carried.iter().map(|c| carried(c.kind)));
    f.extend(a.claims.iter().flat_map(|c| &c.evidence).map(evidence));
    f
}

/// The analysis at this build's schema, as every reader migrates it, checked as the server
/// checks its upload (a later analysis against the one it follows), but for its code.
fn migrated(c: &Committed) -> Analysis {
    let pinned = c.pinned();
    let ctx = Context {
        changed_files: Some(pinned.files.iter().map(|f| f.path.clone()).collect()),
        previous: c.previous_ids().unwrap(),
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
    let features_all = all_features();
    let v2 = recordings().iter().any(|(_, vs)| vs.contains(&2));
    let mut recorded: BTreeSet<&str> = BTreeSet::new();
    let mut cases: BTreeMap<String, (&Committed, BTreeSet<&str>)> = BTreeMap::new();
    for c in &all {
        let f = features(&migrated(c), &c.pinned(), c.previous.is_some());
        for name in &f {
            assert!(
                features_all.iter().any(|x| x == name),
                "`{name}` isn't in the feature list: {features_all:?}"
            );
        }
        if c.name.starts_with("cases/") {
            cases.insert(c.name.clone(), (c, f));
        } else {
            recorded.extend(f);
        }
    }
    assert!(!recorded.is_empty(), "no recording is committed");

    // Each case is for a feature the recordings lack, and is named after one it holds.
    for (name, (c, f)) in &cases {
        let feature = c.feature().unwrap();
        assert!(
            features_all.iter().any(|x| x == feature),
            "{name} isn't named after a feature (one of {features_all:?})"
        );
        assert!(f.contains(feature), "{name} doesn't hold `{feature}`");
        assert!(
            !recorded.contains(feature),
            "the recordings hold `{feature}` now: delete {name}"
        );
        assert!(
            !later_only(feature) || c.previous.is_some(),
            "{name} holds `{feature}`, which only an analysis after another has: name it cases/{feature}{}.json, so it's checked and uploaded after v1",
            analysis_fixtures::AFTER_V1
        );
    }

    let covered: BTreeSet<&str> = recorded
        .iter()
        .copied()
        .chain(cases.values().flat_map(|(_, f)| f.iter().copied()))
        .collect();
    let missing: Vec<&str> = features_all
        .iter()
        .map(String::as_str)
        .filter(|f| !covered.contains(f))
        .filter(|f| v2 || !later_only(f))
        .collect();
    assert!(
        missing.is_empty(),
        "no recording or case holds {missing:?}: add a case in fixtures/pr-view/cases/<feature>.json, quoting the recorded PR's code at v1 (for `carried-*` or `since-last-analysis`, which only an analysis after another holds, name it cases/<feature>{}.json: it's checked against v1's IDs, and ./dev-ctl analyse uploads it after v1)",
        analysis_fixtures::AFTER_V1
    );
    if !v2 {
        let waiting: Vec<&str> = features_all
            .iter()
            .map(String::as_str)
            .filter(|f| later_only(f) && !covered.contains(f))
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
