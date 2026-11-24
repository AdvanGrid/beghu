//! The merge and `--finish`, on the sample's fragments: the skeleton, the `api` area and the
//! `lib` system area.

mod common;

use analysis::{Context, finish, merge, rule, validate_value};
use common::*;
use serde_json::{Value, json};

fn fragments() -> Vec<Value> {
    [
        "split/1-skeleton.json",
        "split/2-api.json",
        "split/3-lib.json",
    ]
    .iter()
    .map(|f| load(f))
    .collect()
}

fn ids(v: &Value, key: &str) -> Vec<String> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap().to_owned())
        .collect()
}

fn hint_kinds(v: &Value) -> Vec<String> {
    v["hints"].as_array().map_or(Vec::new(), |h| {
        h.iter()
            .map(|x| x["kind"].as_str().unwrap().to_owned())
            .collect()
    })
}

#[test]
fn merge_joins_renumbers_and_drops_replaced_lines() {
    let m = merge(fragments());
    assert_clean(&m.report);
    let a = &m.analysis;
    // Every fragment's nodes, the area's `api` in place of the skeleton's.
    assert_eq!(
        ids(a, "nodes"),
        [
            "shop",
            "api",
            "lib",
            "postgres",
            "stripe",
            "customer",
            "api.orders",
            "api.health",
            "lib.db"
        ]
    );
    assert!(
        a["nodes"][1]["files"].as_array().unwrap().len() == 1,
        "the area's api, with its files"
    );
    // The skeleton's coarse lib → postgres gave way to lib.db → postgres; api → lib has no finer line yet.
    assert_eq!(
        ids(a, "edges"),
        [
            "api->lib",
            "customer->api.orders",
            "api.orders->stripe",
            "lib.db->postgres"
        ]
    );
    // Claims renumbered c1… across fragments, and every reference follows.
    let claims = ids(a, "claims");
    assert_eq!(
        claims,
        (1..=claims.len())
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        a["edges"][3]["claims"],
        json!(["c17"]),
        "lib's fragment's c3 became c17"
    );
    // The purpose joined the skeleton's name with the area's members.
    assert_eq!(a["purposes"][0]["name"], "Refund an order");
    assert_eq!(a["purposes"][0]["serves"][0]["node"], "api.orders");
    // The seam pass's work: the unmatched seam hint, the line that ends at a parent whose child is
    // in another area, the unresolved candidate and the purpose hint.
    assert_eq!(hint_kinds(a), ["seam", "candidate", "purpose", "deepen"]);
    assert_eq!(a["hints"][3]["line"], "api->lib");
    assert_eq!(a["hints"][3]["children"], json!(["lib.db"]));
}

#[test]
fn a_seam_hint_a_line_answers_is_dropped() {
    let mut f = fragments();
    let line = json!({ "id": "api.orders->lib.db:exec", "from": "api.orders", "to": "lib.db", "kind": "call", "when": "runtime",
        "uses": "exec", "label": "marks the order refunded", "mode": "sync", "change": "added", "boundaries": [], "facets": [],
        "questions": [], "claims": [] });
    f[2]["edges"].as_array_mut().unwrap().push(line);
    let m = merge(f);
    assert!(!hint_kinds(&m.analysis).contains(&"seam".to_owned()));
}

#[test]
fn a_resolved_candidate_leaves_no_trace() {
    let mut f = fragments();
    f[1]["hints"][1]["resolution"] = json!({ "how": "rejected", "refs": [], "claims": ["c3"] });
    let m = merge(f);
    assert!(!hint_kinds(&m.analysis).contains(&"candidate".to_owned()));
    // A resolution naming a line that doesn't exist stays as work.
    let mut f = fragments();
    f[1]["hints"][1]["resolution"] =
        json!({ "how": "drawn", "refs": ["api->lib.db"], "claims": [] });
    let m = merge(f);
    assert_error(&m.report, rule::HINT_UNRESOLVED);
    assert!(hint_kinds(&m.analysis).contains(&"candidate".to_owned()));
}

#[test]
fn merge_duplicate() {
    // Two areas writing the same part.
    let mut f = fragments();
    let mut lib_db = f[2]["nodes"][0].clone();
    lib_db["summary"] = json!("Postgres access, as the api area saw it.");
    f[1]["nodes"].as_array_mut().unwrap().push(lib_db);
    let m = merge(f);
    assert_warning(&m.report, rule::MERGE_DUPLICATE);
    // The skeleton's coarse version giving way to an area's isn't one.
    assert!(merge(fragments()).report.warnings.is_empty());
}

#[test]
fn merge_reports_claims_a_fragment_doesnt_hold() {
    let mut f = fragments();
    f[2]["edges"][0]["claims"] = json!(["c9"]);
    let m = merge(f);
    assert_error(&m.report, rule::REF_UNKNOWN);
}

/// The seam pass's output: the merge with every hint resolved, as the agent would leave it.
fn resolved() -> Value {
    let mut a = merge(fragments()).analysis;
    let exec = json!({ "id": "api.orders->lib.db:exec", "from": "api.orders", "to": "lib.db", "kind": "call", "when": "runtime",
        "uses": "exec", "label": "marks the order refunded", "mode": "sync", "change": "added", "boundaries": [], "facets": [],
        "questions": [], "claims": ["c11"] });
    a["edges"].as_array_mut().unwrap().push(exec);
    let edges = a["edges"].as_array_mut().unwrap();
    edges[0]["id"] = json!("api.orders->lib.db:query");
    edges[0]["from"] = json!("api.orders");
    edges[0]["to"] = json!("lib.db");
    a["purposes"].as_array_mut().unwrap().push(
        json!({ "id": "purpose:refunds/record", "name": "Record the refund",
        "parent": "purpose:refunds", "kind": "feature" }),
    );
    let res = [
        json!({ "how": "drawn", "refs": ["api.orders->lib.db:exec", "api.orders->lib.db:query"], "claims": [] }),
        json!({ "how": "drawn", "refs": ["api.orders->lib.db:query"], "claims": [] }),
        json!({ "how": "added", "refs": ["purpose:refunds/record"], "claims": [] }),
        json!({ "how": "deepened", "refs": ["api.orders->lib.db:query"], "claims": [] }),
    ];
    for (h, r) in a["hints"].as_array_mut().unwrap().iter_mut().zip(res) {
        h["resolution"] = r;
    }
    a
}

#[test]
fn finish_strips_resolved_hints() {
    let f = finish(resolved());
    assert_clean(&f.report);
    assert!(f.analysis.get("hints").is_none());
    // The validator no longer sees the split procedure at all.
    let r = validate_value(f.analysis, &Context::default(), None).report;
    assert!(
        !r.rules()
            .any(|x| x == rule::HINT_UNRESOLVED || x == rule::SHAPE_HINTS),
        "{:#?}",
        r.errors
    );
}

#[test]
fn finish_keeps_and_reports_what_isnt_resolved() {
    let mut a = resolved();
    a["hints"][0].as_object_mut().unwrap().remove("resolution");
    a["hints"][2]["resolution"] = json!({ "how": "rejected", "refs": [], "claims": [] });
    let f = finish(a);
    assert_eq!(
        f.report
            .errors
            .iter()
            .filter(|e| e.rule == rule::HINT_UNRESOLVED)
            .count(),
        2
    );
    assert_eq!(hint_kinds(&f.analysis), ["seam", "purpose"]);
    // And the validator refuses them.
    assert_error(&check(f.analysis), rule::HINT_UNRESOLVED);
}
