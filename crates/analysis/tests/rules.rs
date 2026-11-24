//! One test per validator rule, each on the hand-written sample edited next to its assertion.
//! `every_rule_has_a_test` keeps the list complete.

mod common;

use analysis::migrate::{Chain, Rename, Step};
use analysis::{Context, Previous, rule, validate, validate_with};
use common::*;
use serde_json::{Value, json};

fn node<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|n| n["id"] == id)
        .unwrap_or_else(|| panic!("no node {id}"))
}

fn edge<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["edges"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"] == id)
        .unwrap_or_else(|| panic!("no edge {id}"))
}

fn claim<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["claims"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == id)
        .unwrap()
}

fn push(v: &mut Value, key: &str, item: Value) {
    v[key].as_array_mut().unwrap().push(item);
}

// The baseline: the sample passes every check, with the checkouts, the run's files and the
// previous analysis.

#[test]
fn the_sample_passes_every_check() {
    let ctx = Context {
        changed_files: Some(changed_files()),
        previous: previous(),
    };
    let out = analysis::validate_value(sample(), &ctx, Some(&Checkouts));
    assert_clean(&out.report);
    assert!(out.analysis.is_some());
    assert_eq!(out.from_version, Some(1));
}

// Versions and shape.

#[test]
fn version_unknown() {
    assert_error(
        &check(edit(|v| v["version"] = json!(analysis::VERSION + 1))),
        rule::VERSION_UNKNOWN,
    );
    assert_error(
        &check(edit(|v| v["version"] = json!("one"))),
        rule::VERSION_UNKNOWN,
    );
}

fn bump(v: Value) -> Result<(Value, Vec<Rename>), String> {
    Ok((
        v,
        vec![Rename {
            old: "api.payments".into(),
            new: "api.orders".into(),
            step: 1,
        }],
    ))
}

#[test]
fn schema_migrated() {
    // A chain one version ahead of the sample: the sample is migrated, warned about and checked.
    let chain = Chain {
        version: 2,
        steps: &[Step { from: 1, run: bump }],
    };
    let out = validate_with(&chain, sample(), &Context::default(), None);
    assert_warning(&out.report, rule::SCHEMA_MIGRATED);
    assert!(out.report.errors.is_empty(), "{:#?}", out.report.errors);
    assert_eq!(out.from_version, Some(1));
    assert_eq!(out.analysis.unwrap().version, 2);
    assert_eq!(
        out.renames,
        vec![Rename {
            old: "api.payments".into(),
            new: "api.orders".into(),
            step: 1
        }]
    );
}

#[test]
fn migration_failed() {
    fn broken(_: Value) -> Result<(Value, Vec<Rename>), String> {
        Err("no `nodes`".into())
    }
    let chain = Chain {
        version: 2,
        steps: &[Step {
            from: 1,
            run: broken,
        }],
    };
    let out = validate_with(&chain, sample(), &Context::default(), None);
    assert_error(&out.report, rule::MIGRATION_FAILED);
    assert!(out.analysis.is_none());
}

#[test]
fn shape_json() {
    let out = validate("{ not json", &Context::default(), None);
    assert_error(&out.report, rule::SHAPE_JSON);
}

#[test]
fn shape_missing_field() {
    let r = check(edit(|v| {
        node(v, "api").as_object_mut().unwrap().remove("kind");
    }));
    assert_error(&r, rule::SHAPE_MISSING_FIELD);
    assert_eq!(r.errors[0].path, "/nodes/1");
    assert_error(
        &check(edit(|v| drop(v.as_object_mut().unwrap().remove("causes")))),
        rule::SHAPE_MISSING_FIELD,
    );
}

#[test]
fn shape_unknown_field() {
    assert_error(
        &check(edit(|v| edge(v, "lib.db->postgres")["crosses"] = json!([]))),
        rule::SHAPE_UNKNOWN_FIELD,
    );
    assert_error(
        &check(edit(|v| v["notes"] = json!([]))),
        rule::SHAPE_UNKNOWN_FIELD,
    );
}

#[test]
fn shape_enum() {
    // `dependency` lines are gone.
    let r = check(edit(|v| {
        edge(v, "lib.db->postgres")["kind"] = json!("dependency")
    }));
    assert_error(&r, rule::SHAPE_ENUM);
    assert_error(
        &check(edit(|v| {
            edge(v, "lib.db->postgres")["when"] = json!("deploy")
        })),
        rule::SHAPE_ENUM,
    );
}

#[test]
fn shape_type() {
    assert_error(
        &check(edit(|v| node(v, "api")["paths"] = json!("api"))),
        rule::SHAPE_TYPE,
    );
    // `drawn.partial` is always true.
    assert_error(
        &check(edit(|v| node(v, "lib")["drawn"]["partial"] = json!(false))),
        rule::SHAPE_TYPE,
    );
}

#[test]
fn shape_hints() {
    let r = check(edit(|v| {
        v["hints"] = json!([{ "kind": "seam", "from": "api.orders", "to": "lib", "lineKind": "call", "why": "runs SQL",
            "claims": [], "resolution": { "how": "drawn", "refs": ["api.orders->lib.db:exec"], "claims": [] } }]);
    }));
    assert_error(&r, rule::SHAPE_HINTS);
}

/// Any `hints` key fails the shape check, an empty list included: an upload carries none.
#[test]
fn an_empty_hints_list_fails_the_shape_check() {
    assert_error(&check(edit(|v| v["hints"] = json!([]))), rule::SHAPE_HINTS);
    assert_error(&check(edit(|v| v["hints"] = json!({}))), rule::SHAPE_HINTS);
}

/// A shape error points at the field serde refused, not the element holding it, with `~` and `/`
/// escaped in keys.
#[test]
fn shape_errors_point_at_the_exact_field() {
    let r = check(edit(|v| {
        node(v, "api")["files"][0]["added"] = json!("three")
    }));
    assert_error(&r, rule::SHAPE_TYPE);
    assert_eq!(r.errors[0].path, "/nodes/1/files/0/added");
    let r = check(edit(|v| {
        node(v, "api")["files"][0]["weird/key~"] = json!(1)
    }));
    assert_error(&r, rule::SHAPE_UNKNOWN_FIELD);
    assert_eq!(r.errors[0].path, "/nodes/1/files/0/weird~1key~0");
    let r = check(edit(|v| v["a/b~c"] = json!(1)));
    assert_eq!(r.errors[0].path, "/a~1b~0c");
}

#[test]
fn hint_unresolved() {
    let r = check(edit(|v| {
        v["hints"] = json!([{ "kind": "candidate", "from": "api", "to": "lib" }]);
    }));
    assert_error(&r, rule::HINT_UNRESOLVED);
}

// IDs and references.

#[test]
fn id_duplicate() {
    assert_error(
        &check(edit(|v| {
            edge(v, "lib.db->postgres")["id"] = json!("lib.db")
        })),
        rule::ID_DUPLICATE,
    );
    assert_error(
        &check(edit(|v| v["facets"][3]["values"][1]["id"] = json!("go"))),
        rule::ID_DUPLICATE,
    );
}

#[test]
fn ref_unknown() {
    assert_error(
        &check(edit(|v| edge(v, "lib.db->postgres")["to"] = json!("mysql"))),
        rule::REF_UNKNOWN,
    );
    assert_error(
        &check(edit(|v| {
            node(v, "api")["responsibilities"][0]["claims"] = json!(["c99"])
        })),
        rule::REF_UNKNOWN,
    );
    assert_error(
        &check(edit(|v| {
            v["scenarios"][0]["steps"][0]["edge"] = json!("nope")
        })),
        rule::REF_UNKNOWN,
    );
    assert_error(
        &check(edit(|v| v["carried"][0]["now"] = json!(["api.refunds"]))),
        rule::REF_UNKNOWN,
    );
}

#[test]
fn claim_id() {
    assert_error(
        &check(edit(|v| claim(v, "c9")["id"] = json!("claim-9"))),
        rule::CLAIM_ID,
    );
    assert_error(
        &check(edit(|v| claim(v, "c9")["id"] = json!("c09"))),
        rule::CLAIM_ID,
    );
}

#[test]
fn purpose_id() {
    let r = check(edit(|v| {
        v["purposes"][1]["id"] = json!("purpose:record");
        v["purposes"][0]["stops"][2]["ref"] = json!("purpose:record");
    }));
    assert_error(&r, rule::PURPOSE_ID);
    assert_error(
        &check(edit(|v| v["purposes"][0]["id"] = json!("Refunds"))),
        rule::PURPOSE_ID,
    );
}

// The graph.

#[test]
fn system_root() {
    let r = check(edit(|v| {
        push(
            v,
            "nodes",
            json!({ "id": "shop2", "kind": "system", "name": "shop2", "paths": [], "summary": "Another root.",
            "change": "unchanged", "responsibilities": [], "facets": [], "questions": [], "files": [] }),
        );
    }));
    assert_error(&r, rule::SYSTEM_ROOT);
    assert_error(
        &check(edit(|v| {
            drop(
                node(v, "customer")
                    .as_object_mut()
                    .unwrap()
                    .remove("parent"),
            )
        })),
        rule::SYSTEM_ROOT,
    );
}

#[test]
fn node_parent_cycle() {
    assert_error(
        &check(edit(|v| node(v, "lib")["parent"] = json!("lib.db"))),
        rule::NODE_PARENT_CYCLE,
    );
}

#[test]
fn node_paths() {
    assert_error(
        &check(edit(|v| node(v, "api.health")["paths"] = json!([]))),
        rule::NODE_PATHS,
    );
    // A store is code that exists too.
    assert_error(
        &check(edit(|v| node(v, "postgres")["paths"] = json!([]))),
        rule::NODE_PATHS,
    );
}

#[test]
fn node_change_summary() {
    assert_error(
        &check(edit(|v| {
            drop(
                node(v, "api")
                    .as_object_mut()
                    .unwrap()
                    .remove("changeSummary"),
            )
        })),
        rule::NODE_CHANGE_SUMMARY,
    );
}

#[test]
fn change_own_code() {
    // A store the PR merely starts using stays unchanged: its lines carry the change.
    let r = check(edit(|v| {
        let n = node(v, "stripe");
        n["change"] = json!("modified");
        n["changeSummary"] = json!("Now receives refunds.");
    }));
    assert_error(&r, rule::CHANGE_OWN_CODE);
    let r = check(edit(|v| {
        let n = node(v, "lib.db");
        n["change"] = json!("modified");
        n["changeSummary"] = json!("Now marks orders refunded.");
    }));
    assert_error(&r, rule::CHANGE_OWN_CODE);
}

#[test]
fn file_duplicate() {
    let r = check(edit(|v| {
        let f = node(v, "api")["files"][0].clone();
        node(v, "api.orders")["files"]
            .as_array_mut()
            .unwrap()
            .push(f);
    }));
    assert_error(&r, rule::FILE_DUPLICATE);
}

#[test]
fn file_unplaced() {
    let mut files = changed_files();
    files.push("api/orders/refund_test.go".into());
    let r = check_with(
        sample(),
        &Context {
            changed_files: Some(files),
            previous: Previous::Unknown,
        },
    );
    assert_error(&r, rule::FILE_UNPLACED);
}

#[test]
fn file_summary() {
    assert_error(
        &check(edit(|v| {
            drop(
                node(v, "api")["files"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("summary"),
            )
        })),
        rule::FILE_SUMMARY,
    );
    // A generated file is listed, not explained.
    let r = check(edit(|v| {
        let f = node(v, "api")["files"][0].as_object_mut().unwrap();
        f.remove("summary");
        f.insert("generated".into(), json!(true));
    }));
    assert_clean(&r);
}

#[test]
fn responsibility_duplicate() {
    assert_error(
        &check(edit(|v| {
            node(v, "lib.db")["responsibilities"][1]["id"] = json!("query")
        })),
        rule::RESPONSIBILITY_DUPLICATE,
    );
}

#[test]
fn group_responsibility() {
    // A node with children is code that does something of its own, never a group.
    assert_error(
        &check(edit(|v| node(v, "lib")["responsibilities"] = json!([]))),
        rule::GROUP_RESPONSIBILITY,
    );
}

#[test]
fn group_top_level_kinds() {
    // `services/` holding services is a grouping node.
    let r = check(edit(|v| node(v, "lib.db")["kind"] = json!("library")));
    assert_error(&r, rule::GROUP_TOP_LEVEL_KINDS);
}

#[test]
fn group_inside() {
    let r = check(edit(|v| {
        drop(node(v, "api")["facets"].as_array_mut().unwrap().remove(0))
    }));
    assert_error(&r, rule::GROUP_INSIDE);
    assert_error(
        &check(edit(|v| v["facets"][0]["multi"] = json!(false))),
        rule::GROUP_INSIDE,
    );
}

#[test]
fn group_outside() {
    assert_error(
        &check(edit(|v| {
            drop(
                node(v, "stripe")["facets"]
                    .as_array_mut()
                    .unwrap()
                    .remove(1),
            )
        })),
        rule::GROUP_OUTSIDE,
    );
    assert_error(
        &check(edit(|v| v["facets"][2]["id"] = json!("runner"))),
        rule::GROUP_OUTSIDE,
    );
}

#[test]
fn drawn_changed() {
    assert_error(
        &check(edit(|v| {
            node(v, "api")["drawn"] = json!({ "partial": true, "folders": 2 })
        })),
        rule::DRAWN_CHANGED,
    );
}

#[test]
fn built_changed() {
    let r = check(edit(
        |v| {
            node(v, "api.health")["built"] =
                json!([{ "kind": "constraint", "text": "always answers 200", "claims": ["c9"] }])
        },
    ));
    assert_error(&r, rule::BUILT_CHANGED);
}

// Facets.

#[test]
fn facet_values() {
    let r = check(edit(|v| {
        v["facets"][3]["values"].as_array_mut().unwrap().remove(0);
        node(v, "api")["facets"][1]["values"][0]["value"] = json!("unknown");
        node(v, "lib")["facets"][1]["values"][0]["value"] = json!("unknown");
    }));
    assert_error(&r, rule::FACET_VALUES);
}

#[test]
fn facet_unknown_value() {
    assert_error(
        &check(edit(|v| {
            drop(v["facets"][3]["values"].as_array_mut().unwrap().remove(1))
        })),
        rule::FACET_UNKNOWN_VALUE,
    );
}

#[test]
fn facet_prefix() {
    assert_error(
        &check(edit(|v| {
            v["facets"][3]["values"][0]["prefix"] = json!("GOLANG")
        })),
        rule::FACET_PREFIX,
    );
    assert_error(
        &check(edit(|v| v["facets"][3]["values"][0]["prefix"] = json!(""))),
        rule::FACET_PREFIX,
    );
}

#[test]
fn facet_applies_to() {
    assert_error(
        &check(edit(|v| v["facets"][3]["appliesTo"] = json!("edge"))),
        rule::FACET_APPLIES_TO,
    );
}

#[test]
fn facet_single() {
    let r = check(edit(|v| {
        node(v, "api")["facets"][1]["values"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "value": "unknown", "claims": ["c1"] }));
    }));
    assert_error(&r, rule::FACET_SINGLE);
}

#[test]
fn facet_value_claims() {
    // Every value of a multi-valued assignment carries its own claims.
    let r = check(edit(|v| {
        node(v, "lib")["facets"][0]["values"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "value": "checkout", "claims": [] }));
    }));
    assert_error(&r, rule::FACET_VALUE_CLAIMS);
}

// Lines.

#[test]
fn line_uses() {
    assert_error(
        &check(edit(|v| {
            drop(
                edge(v, "api.orders->stripe")
                    .as_object_mut()
                    .unwrap()
                    .remove("uses"),
            )
        })),
        rule::LINE_USES,
    );
    // `list` is a responsibility of api.orders, not of Stripe.
    assert_error(
        &check(edit(|v| {
            edge(v, "api.orders->stripe")["uses"] = json!("list")
        })),
        rule::LINE_USES,
    );
    // A responsibility of a node inside `to` is fine: lines roll up.
    let r = check(edit(|v| {
        let e = edge(v, "api.orders->lib.db:exec");
        e["to"] = json!("lib");
    }));
    assert!(!r.rules().any(|x| x == rule::LINE_USES), "{:#?}", r.errors);
}

#[test]
fn line_data() {
    assert_error(
        &check(edit(|v| {
            drop(
                edge(v, "lib.db->postgres")
                    .as_object_mut()
                    .unwrap()
                    .remove("data"),
            )
        })),
        rule::LINE_DATA,
    );
}

#[test]
fn line_data_generic() {
    assert_warning(
        &check(edit(|v| {
            edge(v, "lib.db->postgres")["data"]["what"] = json!("data")
        })),
        rule::LINE_DATA_GENERIC,
    );
    assert_warning(
        &check(edit(|v| {
            edge(v, "api.orders->stripe")["data"]["what"] = json!("Request")
        })),
        rule::LINE_DATA_GENERIC,
    );
}

#[test]
fn line_call_site() {
    // c2 is api/main.go's listener: not on the caller's paths.
    assert_error(
        &check(edit(|v| {
            edge(v, "api.orders->lib.db:query")["claims"] = json!(["c2"])
        })),
        rule::LINE_CALL_SITE,
    );
    // From a person, the receiving entry point is on the callee's paths: main.go isn't api.orders.
    assert_error(
        &check(edit(|v| {
            edge(v, "customer->api.orders")["claims"] = json!(["c1"])
        })),
        rule::LINE_CALL_SITE,
    );
    // A suspected line, drawn with an undetermined claim, passes.
    let r = check(edit(|v| {
        edge(v, "api.orders->lib.db:query")["claims"] = json!(["c8", "c14"])
    }));
    assert!(!r.rules().any(|x| x == rule::LINE_CALL_SITE));
}

#[test]
fn line_per_interaction() {
    let r = check(edit(|v| {
        let mut e = edge(v, "api.orders->lib.db:exec").clone();
        e["id"] = json!("api.orders->lib.db:exec2");
        push(v, "edges", e);
    }));
    assert_error(&r, rule::LINE_PER_INTERACTION);
}

#[test]
fn line_needed_by() {
    assert_error(
        &check(edit(|v| {
            drop(
                edge(v, "api.orders->stripe")
                    .as_object_mut()
                    .unwrap()
                    .remove("neededBy"),
            )
        })),
        rule::LINE_NEEDED_BY,
    );
}

// Scenarios.

#[test]
fn chapter_missing() {
    assert_error(
        &check(edit(|v| v["scenarios"][0]["chapters"] = json!([]))),
        rule::CHAPTER_MISSING,
    );
}

#[test]
fn chapter_first() {
    let r = check(edit(|v| {
        v["scenarios"][0]["chapters"] = json!([{ "title": "The API refunds", "from": 1 }])
    }));
    assert_error(&r, rule::CHAPTER_FIRST);
}

#[test]
fn chapter_order() {
    let out_of_order = json!([{ "title": "a", "from": 0 }, { "title": "b", "from": 2 }, { "title": "c", "from": 1 }]);
    assert_error(
        &check(edit(|v| v["scenarios"][0]["chapters"] = out_of_order)),
        rule::CHAPTER_ORDER,
    );
    let off_the_steps = json!([{ "title": "a", "from": 0 }, { "title": "b", "from": 9 }]);
    assert_error(
        &check(edit(|v| v["scenarios"][0]["chapters"] = off_the_steps)),
        rule::CHAPTER_ORDER,
    );
}

#[test]
fn chapter_long() {
    let r = check(edit(|v| {
        let steps = v["scenarios"][0]["steps"].as_array().unwrap().clone();
        v["scenarios"][0]["steps"] = json!([steps.clone(), steps].concat());
        v["scenarios"][0]["chapters"] = json!([{ "title": "The customer asks for a refund", "from": 0 },
            { "title": "The API refunds through Stripe and records it", "from": 1 }]);
    }));
    assert_warning(&r, rule::CHAPTER_LONG);
}

// Claims and evidence.

#[test]
fn claims_missing() {
    assert_error(
        &check(edit(|v| v["boundaries"][0]["claims"] = json!([]))),
        rule::CLAIMS_MISSING,
    );
    assert_error(
        &check(edit(|v| {
            node(v, "api")["questions"][0]["claims"] = json!([])
        })),
        rule::CLAIMS_MISSING,
    );
}

#[test]
fn claim_unused() {
    let r = check(edit(|v| {
        push(
            v,
            "claims",
            json!({ "id": "c18", "text": "Info prints one line", "status": "supported",
            "evidence": [{ "kind": "code", "side": "head", "path": "lib/log/log.go", "start": 6, "end": 8, "note": "", "snippet": "" }] }),
        );
    }));
    assert_warning(&r, rule::CLAIM_UNUSED);
}

#[test]
fn claim_no_evidence() {
    assert_error(
        &check(edit(|v| claim(v, "c9")["evidence"] = json!([]))),
        rule::CLAIM_NO_EVIDENCE,
    );
}

#[test]
fn claim_looked_at() {
    assert_error(
        &check(edit(|v| {
            drop(claim(v, "c14").as_object_mut().unwrap().remove("lookedAt"))
        })),
        rule::CLAIM_LOOKED_AT,
    );
}

#[test]
fn claim_stated_only() {
    // A responsibility is the code view: the description alone can't back it.
    assert_error(
        &check(edit(|v| {
            node(v, "lib")["responsibilities"][0]["claims"] = json!(["c15"])
        })),
        rule::CLAIM_STATED_ONLY,
    );
    // A purpose's walk may rest on the description alone.
    let r = check(edit(|v| {
        v["purposes"][0]["walk"]["claims"] = json!(["c15"])
    }));
    assert!(
        !r.rules().any(|x| x == rule::CLAIM_STATED_ONLY),
        "{:#?}",
        r.errors
    );
}

#[test]
fn evidence_lines() {
    assert_error(
        &check(edit(|v| claim(v, "c13")["evidence"][0]["end"] = json!(40))),
        rule::EVIDENCE_LINES,
    );
    assert_error(
        &check(edit(|v| claim(v, "c13")["evidence"][0]["start"] = json!(0))),
        rule::EVIDENCE_LINES,
    );
}

#[test]
fn words_judging() {
    assert_warning(
        &check(edit(|v| {
            node(v, "api")["summary"] = json!("A better HTTP API.")
        })),
        rule::WORDS_JUDGING,
    );
    assert_warning(
        &check(edit(|v| {
            v["scenarios"][0]["chapters"][1]["title"] = json!("The API should retry")
        })),
        rule::WORDS_JUDGING,
    );
    assert_warning(
        &check(edit(|v| {
            node(v, "lib.db")["summary"] = json!("Similar to the ORM.")
        })),
        rule::WORDS_JUDGING,
    );
}

// Purposes and conflicts.

#[test]
fn purpose_depth() {
    let r = check(edit(|v| {
        push(
            v,
            "purposes",
            json!({ "id": "purpose:refunds/record/flag", "name": "Set the flag", "parent": "purpose:refunds/record",
            "kind": "feature", "walk": { "intro": "a", "journey": "b", "destination": "c", "claims": ["c7"] },
            "stops": [], "serves": [{ "node": "lib.db", "role": "writes", "claims": ["c12"] }], "carries": [] }),
        );
    }));
    assert_error(&r, rule::PURPOSE_DEPTH);
}

#[test]
fn purpose_redundant_member() {
    let r = check(edit(|v| {
        v["purposes"][0]["serves"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "node": "api", "role": "routes it", "claims": ["c1"] }));
    }));
    assert_error(&r, rule::PURPOSE_REDUNDANT_MEMBER);
}

#[test]
fn purpose_no_members() {
    assert_error(
        &check(edit(|v| v["purposes"][1]["serves"] = json!([]))),
        rule::PURPOSE_NO_MEMBERS,
    );
}

#[test]
fn purpose_stop_not_member() {
    let r = check(edit(|v| {
        v["purposes"][0]["stops"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "ref": "api.health", "line": "x" }))
    }));
    assert_error(&r, rule::PURPOSE_STOP_NOT_MEMBER);
    let r = check(edit(|v| {
        v["purposes"][1]["stops"] = json!([{ "ref": "api.orders->stripe", "line": "x" }])
    }));
    assert_error(&r, rule::PURPOSE_STOP_NOT_MEMBER);
    // A part holding a member is a fine stop.
    let r = check(edit(|v| {
        v["purposes"][0]["stops"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "ref": "api", "line": "the API takes it" }));
    }));
    assert!(
        !r.rules().any(|x| x == rule::PURPOSE_STOP_NOT_MEMBER),
        "{:#?}",
        r.errors
    );
}

#[test]
fn walk_required() {
    // A changed top-level part.
    assert_error(
        &check(edit(|v| {
            drop(node(v, "api").as_object_mut().unwrap().remove("walk"))
        })),
        rule::WALK_REQUIRED,
    );
    // A stop.
    assert_error(
        &check(edit(|v| {
            drop(
                node(v, "api.orders")
                    .as_object_mut()
                    .unwrap()
                    .remove("walk"),
            )
        })),
        rule::WALK_REQUIRED,
    );
}

#[test]
fn walk_claims() {
    assert_error(
        &check(edit(|v| v["walk"]["claims"] = json!([]))),
        rule::WALK_CLAIMS,
    );
}

#[test]
fn conflict_kind_sides() {
    // Two stated sides.
    assert_error(
        &check(edit(|v| v["conflicts"][0]["b"]["who"] = json!("issue"))),
        rule::CONFLICT_KIND_SIDES,
    );
    // Purpose against purpose needs two purposes.
    let r = check(edit(|v| {
        let c = &mut v["conflicts"][0];
        c["kind"] = json!("purpose-purpose");
        c["a"]["who"] = json!("purpose");
        c["a"]["purpose"] = json!("purpose:refunds");
        c["b"]["who"] = json!("purpose");
        c["b"]["purpose"] = json!("purpose:refunds");
        c["touches"]["purposes"] = json!(["purpose:refunds"]);
    }));
    assert_error(&r, rule::CONFLICT_KIND_SIDES);
    // Purpose against outside code needs its rule, and code outside the diff.
    let r = check(edit(|v| {
        let c = &mut v["conflicts"][0];
        c["kind"] = json!("purpose-outside");
        c["rule"] = json!("rule:refund-recorded");
        c["a"]["who"] = json!("purpose");
        c["a"]["purpose"] = json!("purpose:refunds");
        c["b"]["who"] = json!("outside");
        c["touches"]["purposes"] = json!(["purpose:refunds"]);
    }));
    assert_error(&r, rule::CONFLICT_KIND_SIDES);
}

#[test]
fn conflict_touches() {
    assert_error(
        &check(edit(|v| v["conflicts"][0]["touches"]["nodes"] = json!([]))),
        rule::CONFLICT_TOUCHES,
    );
}

#[test]
fn conflict_sites() {
    let r = check(edit(|v| {
        v["conflicts"][0]["b"]["sites"] = json!({ "claims": vec!["c6"; 21], "more": 3 })
    }));
    assert_error(&r, rule::CONFLICT_SITES);
}

#[test]
fn cause_evidence() {
    let r = check(edit(|v| {
        v["causes"] = json!([{ "id": "cause:late", "text": "The description was written first.", "claims": ["c14"] }]);
        v["conflicts"][0]["cause"] = json!("cause:late");
    }));
    assert_error(&r, rule::CAUSE_EVIDENCE);
}

#[test]
fn unclaimed_missing() {
    // The full fallback: no purposes, so every changed leaf part is unclaimed.
    let r = check(edit(|v| {
        v["purposes"] = json!([]);
        v["unbacked"] = json!("The description names no outcome the code shows.");
        node(v, "api.orders")["walk"] = Value::Null;
        edge(v, "api.orders->stripe")
            .as_object_mut()
            .unwrap()
            .remove("neededBy");
        edge(v, "api.orders->stripe")
            .as_object_mut()
            .unwrap()
            .remove("walk");
        v["conflicts"][0]["touches"]["purposes"] = json!([]);
    }));
    assert_error(&r, rule::UNCLAIMED_MISSING);
    let r = check(edit(|v| {
        v["purposes"] = json!([]);
        v["unbacked"] = json!("The description names no outcome the code shows.");
        v["unclaimed"] = json!([{ "node": "api.orders", "reason": "no purpose names refunds" }]);
    }));
    assert!(
        !r.rules().any(|x| x == rule::UNCLAIMED_MISSING),
        "{:#?}",
        r.errors
    );
}

#[test]
fn unbacked_exact() {
    assert_error(
        &check(edit(|v| v["unbacked"] = json!("Nothing backs it."))),
        rule::UNBACKED_EXACT,
    );
    let r = check(edit(|v| {
        v["purposes"] = json!([]);
        v["unclaimed"] = json!([{ "node": "api.orders", "reason": "no purpose names refunds" }]);
    }));
    assert_error(&r, rule::UNBACKED_EXACT);
    // A blank `unbacked` says nothing.
    for blank in ["", "  \n"] {
        let r = check(edit(|v| {
            v["purposes"] = json!([]);
            v["unclaimed"] =
                json!([{ "node": "api.orders", "reason": "no purpose names refunds" }]);
            v["unbacked"] = json!(blank);
        }));
        assert!(
            r.errors
                .iter()
                .any(|e| e.rule == rule::UNBACKED_EXACT && e.message.contains("empty")),
            "{:#?}",
            r.errors
        );
    }
}

// Carrying over.

fn with_previous(v: Value) -> analysis::Report {
    check_with(
        v,
        &Context {
            changed_files: None,
            previous: previous(),
        },
    )
}

#[test]
fn carry_unaccounted() {
    // The previous analysis had `api.payments`; drop its entry and it's unaccounted for.
    let r = with_previous(edit(|v| v["carried"] = json!([])));
    assert_error(&r, rule::CARRY_UNACCOUNTED);
    assert!(r.errors.iter().any(|f| f.message.contains("api.payments")));
    // A retired facet value counts too.
    let r = with_previous(edit(|v| {
        v["facets"][1]["values"].as_array_mut().unwrap().remove(0);
        node(v, "stripe")["facets"][0]["values"][0]["value"] = json!("unknown");
    }));
    assert!(
        r.errors
            .iter()
            .any(|f| f.rule == rule::CARRY_UNACCOUNTED
                && f.message.contains("outside-role/payments"))
    );
}

#[test]
fn carry_unknown() {
    let r = check_with(
        sample(),
        &Context {
            changed_files: None,
            previous: Previous::None,
        },
    );
    assert_error(&r, rule::CARRY_UNKNOWN);
    let r = with_previous(edit(|v| {
        push(
            v,
            "carried",
            json!({ "kind": "dropped", "was": "api.legacy", "now": [], "cause": "code", "reason": "gone", "claims": ["c1"] }),
        );
    }));
    assert_error(&r, rule::CARRY_UNKNOWN);
}

#[test]
fn carry_present() {
    assert_error(
        &check(edit(|v| v["carried"][0]["was"] = json!("api"))),
        rule::CARRY_PRESENT,
    );
}

#[test]
fn carry_now() {
    assert_error(
        &check(edit(|v| v["carried"][0]["kind"] = json!("split"))),
        rule::CARRY_NOW,
    );
    assert_error(
        &check(edit(|v| v["carried"][0]["kind"] = json!("dropped"))),
        rule::CARRY_NOW,
    );
}

#[test]
fn carry_evidence() {
    assert_error(
        &check(edit(|v| v["carried"][0]["claims"] = json!(["c14"]))),
        rule::CARRY_EVIDENCE,
    );
}

// With the checkouts.

#[test]
fn evidence_file() {
    assert_error(
        &check_code(edit(|v| {
            claim(v, "c9")["evidence"][0]["path"] = json!("api/health/healthz.go")
        })),
        rule::EVIDENCE_FILE,
    );
    // refund.go is new: it isn't at base.
    assert_error(
        &check_code(edit(|v| {
            claim(v, "c3")["evidence"][0]["side"] = json!("base")
        })),
        rule::EVIDENCE_FILE,
    );
    assert_error(
        &check_code(edit(|v| {
            claim(v, "c9")["evidence"][0]["path"] = json!("../secrets")
        })),
        rule::EVIDENCE_FILE,
    );
}

#[test]
fn evidence_range() {
    let r = check_code(edit(|v| {
        claim(v, "c9")["evidence"][0]["start"] = json!(8);
        claim(v, "c9")["evidence"][0]["end"] = json!(12);
    }));
    assert_error(&r, rule::EVIDENCE_RANGE);
}

#[test]
fn evidence_snippet() {
    assert_error(
        &check_code(edit(|v| {
            claim(v, "c7")["evidence"][0]["snippet"] = json!("db.Exec(\"DELETE FROM orders\")")
        })),
        rule::EVIDENCE_SNIPPET,
    );
    // Trailing whitespace and the first line's indentation don't count.
    let r = check_code(edit(|v| {
        let s = claim(v, "c7")["evidence"][0]["snippet"]
            .as_str()
            .unwrap()
            .trim()
            .to_owned();
        claim(v, "c7")["evidence"][0]["snippet"] = json!(format!("{s}  \r"));
    }));
    assert_clean(&r);
}

#[test]
fn path_missing() {
    assert_error(
        &check_code(edit(|v| {
            node(v, "api.health")["paths"] = json!(["api/healthz"])
        })),
        rule::PATH_MISSING,
    );
    // A path at base only (a removed folder) exists.
    let r = check_code(edit(|v| {
        node(v, "api.orders")["paths"] = json!(["api/orders", "api/orders/refund.go"])
    }));
    assert!(!r.rules().any(|x| x == rule::PATH_MISSING));
}

#[test]
fn drawn_folders() {
    // lib holds db, db/pool and log.
    assert_error(
        &check_code(edit(|v| node(v, "lib")["drawn"]["folders"] = json!(2))),
        rule::DRAWN_FOLDERS,
    );
}

/// The instructions list every rule the validator reports, so the agent can look one up.
#[test]
fn the_instructions_name_every_rule() {
    let missing: Vec<&str> = rule::ALL
        .iter()
        .copied()
        .filter(|id| !analysis::INSTRUCTIONS.contains(&format!("`{id}`")))
        .collect();
    assert!(missing.is_empty(), "ANALYSIS.md doesn't name {missing:?}");
}

/// Every rule ID has a test here or in `split.rs` and `merge.rs`, named by its constant.
#[test]
fn every_rule_has_a_test() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut text = String::new();
    for f in ["rules.rs", "split.rs", "merge.rs"] {
        text.push_str(&std::fs::read_to_string(dir.join(f)).unwrap());
    }
    let missing: Vec<&str> = rule::ALL
        .iter()
        .copied()
        .filter(|id| {
            let name = id.to_uppercase().replace(['.', '-'], "_");
            !text.contains(&format!("rule::{name})")) && !text.contains(&format!("rule::{name},"))
        })
        .collect();
    assert!(missing.is_empty(), "rules with no test: {missing:?}");
}
