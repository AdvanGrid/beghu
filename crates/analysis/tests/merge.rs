//! The merge and `--finish`, on the sample's fragments: the skeleton, the `api` area and the
//! `lib` system area.

mod common;

use analysis::{Context, check_split, finish, merge, rule, validate_value};
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
    let m = merge(fragments(), None);
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
    let m = merge(f, None);
    assert!(!hint_kinds(&m.analysis).contains(&"seam".to_owned()));
}

#[test]
fn a_resolved_candidate_leaves_no_trace() {
    let mut f = fragments();
    f[1]["hints"][1]["resolution"] = json!({ "how": "rejected", "refs": [], "claims": ["c3"] });
    let m = merge(f, None);
    assert!(!hint_kinds(&m.analysis).contains(&"candidate".to_owned()));
    // A resolution naming a line that doesn't exist stays as work.
    let mut f = fragments();
    f[1]["hints"][1]["resolution"] =
        json!({ "how": "drawn", "refs": ["api->lib.db"], "claims": [] });
    let m = merge(f, None);
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
    let m = merge(f, None);
    assert_warning(&m.report, rule::MERGE_DUPLICATE);
    // At the later writer's element.
    assert_eq!(m.report.warnings[0].path, "/2/nodes/0");
    // The skeleton's coarse version giving way to an area's isn't one.
    assert!(merge(fragments(), None).report.warnings.is_empty());
}

#[test]
fn merge_reports_claims_a_fragment_doesnt_hold() {
    let mut f = fragments();
    f[2]["edges"][0]["claims"] = json!(["c9"]);
    let m = merge(f, None);
    assert_error(&m.report, rule::REF_UNKNOWN);
}

/// The seam pass's output: the merge with every hint resolved, as the agent would leave it.
fn resolved() -> Value {
    let mut a = merge(fragments(), None).analysis;
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

/// Every position in a value, as a JSON pointer.
fn pointers(v: &Value, at: String, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                pointers(
                    x,
                    format!("{at}/{}", k.replace('~', "~0").replace('/', "~1")),
                    out,
                );
            }
        }
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                pointers(x, format!("{at}/{i}"), out);
            }
        }
        _ => {}
    }
    out.push(at);
}

/// The kinds of value a malformed file might hold where something else belongs: a scalar, a list
/// of the wrong thing, an empty object.
fn wrong() -> [Value; 3] {
    [json!(1), json!([1]), json!({})]
}

/// Each sample file with one position replaced by each wrong kind of value: every position, so
/// the merge, `--finish`, the split check and the validator meet every shape they might be
/// given. None of them may panic (under WASM a panic is an `unreachable` trap and no report).
fn every_malformed(v: &Value) -> Vec<Value> {
    let mut ps = Vec::new();
    pointers(v, String::new(), &mut ps);
    let mut out = Vec::new();
    for p in &ps {
        for w in wrong() {
            let mut x = v.clone();
            if let Some(slot) = x.pointer_mut(p) {
                *slot = w;
                out.push(x);
            }
        }
    }
    out
}

#[test]
fn no_malformed_fragment_makes_the_merge_panic() {
    let split = load("split/split.json");
    let frags = fragments();
    for fi in 0..frags.len() {
        for bad in every_malformed(&frags[fi]) {
            let mut f = frags.clone();
            f[fi] = bad;
            let m = merge(f.clone(), Some(&split));
            finish(m.analysis);
            if fi == 0 {
                check_split(&f[0], &split, Some(&changed_files()));
            }
        }
    }
}

#[test]
fn no_malformed_split_json_makes_the_merge_or_split_check_panic() {
    for bad in every_malformed(&load("split/split.json")) {
        merge(fragments(), Some(&bad));
        check_split(&fragments()[0], &bad, Some(&changed_files()));
    }
}

#[test]
fn no_malformed_analysis_makes_the_validator_or_finish_panic() {
    // A wrong value fails the shape check, so the checks after it (the reader's among them) never
    // see one: the reader isn't needed here.
    for bad in every_malformed(&sample()) {
        check(bad.clone());
        finish(bad);
    }
}

/// A scenario that isn't an object, or whose steps aren't a list, doesn't stop the merge from
/// pointing what named a replaced line at the line that replaced it.
#[test]
fn a_malformed_scenario_doesnt_stop_the_merge() {
    let mut f = fragments();
    f[1]["scenarios"] = json!([1, { "id": "s", "steps": 2 }, { "id": "t", "steps": [3] }]);
    let m = merge(f, None);
    assert_eq!(m.analysis["scenarios"].as_array().unwrap().len(), 3);
}

#[test]
fn a_fragment_without_a_version_is_reported_and_left_out() {
    let mut f = fragments();
    f[2].as_object_mut().unwrap().remove("version");
    let m = merge(f, None);
    assert_error(&m.report, rule::SHAPE_MISSING_FIELD);
    let e = &m.report.errors[0];
    assert_eq!(e.path, "/2/version");
    assert!(
        e.message.contains("fragment 3 has no `version`"),
        "{}",
        e.message
    );
    assert!(!ids(&m.analysis, "nodes").contains(&"lib.db".to_owned()));
}

#[test]
fn merge_duplicate_claim() {
    let mut f = fragments();
    let again = f[2]["claims"][0].clone();
    f[2]["claims"].as_array_mut().unwrap().push(again);
    let m = merge(f, None);
    assert_error(&m.report, rule::MERGE_DUPLICATE_CLAIM);
    assert_eq!(m.report.errors[0].path, "/2/claims/3/id");
    // The numbering stays c1… with no claim written twice.
    let claims = ids(&m.analysis, "claims");
    assert_eq!(
        claims,
        (1..=claims.len())
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
    );
}

#[test]
fn an_area_hints_a_purpose_or_rule_it_writes_rather_than_creating_it() {
    let mut f = fragments();
    f[1]["purposes"].as_array_mut().unwrap().push(json!({
        "id": "purpose:refunds/notify", "name": "Tell the customer", "parent": "purpose:refunds",
        "serves": [{ "node": "api.orders", "role": "sends the email", "claims": ["c7"] }] }));
    f[1]["purposes"][0]["rules"] = json!([{ "id": "rule:refund-once", "text": "an order is refunded once",
        "scope": "api/orders", "sources": ["c4"] }]);
    let m = merge(f, None);
    let a = &m.analysis;
    assert_eq!(ids(a, "purposes"), ["purpose:refunds"]);
    assert!(
        a["purposes"][0]
            .get("rules")
            .is_none_or(|r| r == &json!([]))
    );
    let hints = a["hints"].as_array().unwrap();
    let purpose = hints
        .iter()
        .find(|h| h["kind"] == "purpose" && h["name"] == "Tell the customer")
        .expect("a purpose hint");
    assert_eq!(purpose["parent"], "purpose:refunds");
    assert_eq!(purpose["nodes"], json!(["api.orders"]));
    let rule = hints
        .iter()
        .find(|h| h["kind"] == "rule")
        .expect("a rule hint");
    assert_eq!(rule["purpose"], "purpose:refunds");
    assert_eq!(rule["text"], "an order is refunded once");
    // A rule split.json settled is the area's to write.
    let mut f = fragments();
    f[1]["purposes"][0]["rules"] = json!([{ "id": "rule:refund-recorded", "text": "every refund is recorded",
        "scope": "api/orders", "sources": ["c4"] }]);
    let m = merge(f, Some(&load("split/split.json")));
    assert_eq!(
        m.analysis["purposes"][0]["rules"][0]["id"],
        "rule:refund-recorded"
    );
    assert!(!hint_kinds(&m.analysis).contains(&"rule".to_owned()));
}

#[test]
fn with_split_json_every_candidate_no_area_resolved_is_left_for_the_seam_pass() {
    let split = load("split/split.json");
    // The api area forgot its candidate.
    let mut f = fragments();
    f[1]["hints"].as_array_mut().unwrap().remove(1);
    assert!(!hint_kinds(&merge(f.clone(), None).analysis).contains(&"candidate".to_owned()));
    let m = merge(f, Some(&split));
    let hints = m.analysis["hints"].as_array().unwrap();
    let c: Vec<&Value> = hints.iter().filter(|h| h["kind"] == "candidate").collect();
    assert_eq!(
        c,
        [&json!({ "kind": "candidate", "from": "api", "to": "lib" })]
    );
    // One the area resolved, or left unresolved itself, isn't added again.
    let mut f = fragments();
    f[1]["hints"][1]["resolution"] = json!({ "how": "rejected", "refs": [], "claims": ["c3"] });
    assert!(!hint_kinds(&merge(f, Some(&split)).analysis).contains(&"candidate".to_owned()));
    let m = merge(fragments(), Some(&split));
    assert_eq!(
        hint_kinds(&m.analysis)
            .iter()
            .filter(|k| *k == "candidate")
            .count(),
        1
    );
    // A split.json that doesn't fit is reported.
    assert_error(
        &merge(fragments(), Some(&json!({ "areas": [] }))).report,
        rule::SHAPE_MISSING_FIELD,
    );
}

#[test]
fn a_seam_hint_with_uses_is_answered_only_by_a_line_with_that_uses() {
    let with = |uses: &str| {
        let mut f = fragments();
        let line = json!({ "id": "api.orders->lib.db:exec", "from": "api.orders", "to": "lib.db", "kind": "call", "when": "runtime",
            "uses": "exec", "label": "marks the order refunded", "mode": "sync", "change": "added", "boundaries": [], "facets": [],
            "questions": [], "claims": [] });
        f[2]["edges"].as_array_mut().unwrap().push(line);
        f[1]["hints"][0]["uses"] = json!(uses);
        hint_kinds(&merge(f, None).analysis).contains(&"seam".to_owned())
    };
    assert!(with("query"), "an exec line doesn't answer a query seam");
    assert!(!with("exec"));
}

#[test]
fn a_list_that_isnt_one_is_reported_not_dropped_silently() {
    let mut f = fragments();
    f[1]["nodes"] = json!({ "id": "x" });
    f[1]["hints"] = json!({ "kind": "seam" });
    f[1]["purposes"] = json!("p");
    f[2]["purposes"] = json!([5]);
    let m = merge(f, None);
    for at in ["/1/nodes", "/1/hints", "/1/purposes", "/2/purposes/0"] {
        assert!(
            m.report
                .errors
                .iter()
                .any(|e| e.path == at && e.rule == rule::SHAPE_TYPE),
            "no shape.type at {at}: {:?}",
            m.report.errors
        );
    }
}

#[test]
fn a_purpose_split_json_alone_settled_is_the_areas_to_write() {
    // The skeleton leaves the purpose to split.json.
    let mut f = fragments();
    f[0]["purposes"] = json!([]);
    let hinted = |m: &analysis::Merged| {
        m.analysis["hints"].as_array().is_some_and(|h| {
            h.iter().any(|x| {
                x["kind"] == "purpose" && x["why"].as_str().unwrap().contains("`purpose:refunds`")
            })
        })
    };
    let m = merge(f.clone(), Some(&load("split/split.json")));
    assert_eq!(ids(&m.analysis, "purposes"), ["purpose:refunds"]);
    assert!(!hinted(&m));
    // Without split.json nothing settled it, so the area only hints it.
    let m = merge(f, None);
    assert!(hinted(&m));
}
