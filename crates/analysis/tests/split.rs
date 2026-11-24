//! The split check, on the sample's `split.json` and skeleton edited next to each assertion.

mod common;

use analysis::{Report, check_split, rule};
use common::*;
use serde_json::{Value, json};

fn split() -> Value {
    load("split/split.json")
}

fn skeleton() -> Value {
    load("split/1-skeleton.json")
}

fn run(split: Value) -> Report {
    check_split(&skeleton(), &split, Some(&changed_files()))
}

fn edited(f: impl FnOnce(&mut Value)) -> Report {
    let mut s = split();
    f(&mut s);
    run(s)
}

#[test]
fn the_sample_split_passes() {
    assert_clean(&run(split()));
    // Without the run's files, everything but file coverage is still checked.
    assert_clean(&check_split(&skeleton(), &split(), None));
}

#[test]
fn split_file_area() {
    // A changed file no area owns.
    assert_error(
        &edited(|s| drop(s["areas"][0]["owns"].as_array_mut().unwrap().remove(1))),
        rule::SPLIT_FILE_AREA,
    );
    // A file that isn't a changed file of the PR.
    let r = edited(|s| {
        s["areas"][0]["owns"]
            .as_array_mut()
            .unwrap()
            .push(json!("api/health/health.go"))
    });
    assert_error(&r, rule::SPLIT_FILE_AREA);
    // A file outside the area's prefixes.
    let r = edited(|s| {
        s["areas"][0]["owns"].as_array_mut().unwrap().remove(1);
        s["areas"][1]["owns"] = json!(["api/orders/refund.go"]);
        s["areas"][1]["system"] = json!(false);
    });
    assert_error(&r, rule::SPLIT_FILE_AREA);
}

#[test]
fn split_part_area() {
    // `lib` in no area.
    let r = edited(|s| drop(s["areas"].as_array_mut().unwrap().remove(1)));
    assert_error(&r, rule::SPLIT_PART_AREA);
    // `lib` split across two areas.
    let r = edited(|s| {
        s["areas"][1]["prefixes"] = json!(["lib/db/"]);
        s["areas"][1]["id"] = json!("lib/db");
        s["areas"].as_array_mut().unwrap().push(
            json!({ "id": "lib/log", "prefixes": ["lib/log/"], "owns": [], "reads": [],
            "estimate": "1 file", "system": true }),
        );
    });
    assert_error(&r, rule::SPLIT_PART_AREA);
}

#[test]
fn split_overlap() {
    let r = edited(|s| {
        s["areas"].as_array_mut().unwrap().push(
            json!({ "id": "lib/db", "prefixes": ["lib/db/"], "owns": [], "reads": [],
            "estimate": "1 file", "system": true }),
        );
    });
    assert_error(&r, rule::SPLIT_OVERLAP);
}

#[test]
fn split_id() {
    assert_error(
        &edited(|s| s["areas"][0]["id"] = json!("A")),
        rule::SPLIT_ID,
    );
}

#[test]
fn split_system_area() {
    let r = edited(|s| {
        s["areas"][0]["owns"] = json!(["api/main.go"]);
        s["areas"][1]["prefixes"] = json!(["lib/", "api/orders/"]);
        s["areas"][0]["prefixes"] = json!(["api/main.go"]);
        s["areas"][0]["id"] = json!("api/main.go");
        s["areas"][1]["owns"] = json!(["api/orders/refund.go"]);
    });
    assert_error(&r, rule::SPLIT_SYSTEM_AREA);
}

#[test]
fn split_references_and_depth() {
    assert_error(
        &edited(|s| s["candidates"][0]["to"] = json!("libs")),
        rule::REF_UNKNOWN,
    );
    assert_error(
        &edited(|s| s["rules"][0]["purpose"] = json!("purpose:refund")),
        rule::REF_UNKNOWN,
    );
    let r = edited(|s| {
        s["purposes"].as_array_mut().unwrap().push(
            json!({ "id": "purpose:refunds/record", "name": "Record", "parent": "purpose:refunds",
            "kind": "feature", "sources": ["code"], "flow": { "entries": [], "path": [] } }),
        );
        s["purposes"].as_array_mut().unwrap().push(json!({ "id": "purpose:refunds/record/flag", "name": "Flag", "parent": "purpose:refunds/record",
            "kind": "feature", "sources": ["code"], "flow": { "entries": [], "path": [] } }));
    });
    assert_error(&r, rule::PURPOSE_DEPTH);
    assert_error(&edited(|s| s["mode"] = json!("areas")), rule::SHAPE_ENUM);
}
