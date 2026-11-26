//! The judging and comparing words (`words.judging`) on prose, and not on code: words inside a
//! backtick code span, or part of an identifier, aren't prose. Each case puts the text in a
//! node's summary of the hand-written sample.

mod common;

use analysis::rule;
use common::*;
use serde_json::json;

fn summary(text: &str) -> analysis::Report {
    check(edit(|v| {
        let n = v["nodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|n| n["id"] == "api")
            .unwrap();
        n["summary"] = json!(text);
    }))
}

#[track_caller]
fn flagged(text: &str) {
    assert_warning(&summary(text), rule::WORDS_JUDGING);
}

#[track_caller]
fn not_flagged(text: &str) {
    let r = summary(text);
    assert!(
        !r.warnings.iter().any(|f| f.rule == rule::WORDS_JUDGING),
        "{text:?}: {:#?}",
        r.warnings
    );
}

#[test]
fn prose_is_flagged() {
    flagged("It mirrors the old handler.");
    flagged("A clean split between the two.");
    flagged("Mirrors the API.");
    flagged("It is similar to the ORM.");
    // A listed phrase written with a hyphen is still the phrase.
    flagged("A well-designed handler.");
    // An all-caps word is emphasis, not a name.
    flagged("It is NOT clean.");
}

#[test]
fn code_spans_are_skipped() {
    not_flagged("Calls `clean_path` on every path.");
    not_flagged("Reads `Mirrors` and `pristine mirrors` both.");
    not_flagged("Runs ``a `clean` step`` first.");
    // An unclosed backtick is text: what follows it is prose.
    flagged("Prints a ` and is clean.");
}

#[test]
fn identifiers_are_skipped() {
    // Joined by `_`, `-`, `::`, `.` or `/`.
    not_flagged("Calls clean_path on every path.");
    not_flagged("Writes the pristine-mirrors folder.");
    not_flagged("Calls dbrt::Mirrors::new.");
    not_flagged("Reads mirrors.rs and web/src/clean.ts.");
    // Mixed case.
    not_flagged("Calls isClean and CleanPath.");
    // Capitalised inside a sentence: a type's name.
    not_flagged("Opens each file through Mirrors, behind its gate.");
    // A phrase doesn't run across an identifier.
    not_flagged("The same as_ref call.");
}
