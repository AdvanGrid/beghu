//! The judging and comparing words (`words.judging`) on prose, and not on code: words inside a
//! backtick code span, or part of an identifier, aren't prose, and a capitalised word is a name
//! only where the analysis writes it as code. Each case puts the text in a node's summary of the
//! hand-written sample, and what else the analysis writes in another node's.

mod common;

use analysis::rule;
use common::*;
use serde_json::json;

/// The sample with `text` as `api`'s summary and `elsewhere` as `lib`'s.
fn summary(text: &str, elsewhere: &str) -> analysis::Report {
    check(edit(|v| {
        for (id, t) in [("api", text), ("lib", elsewhere)] {
            let n = v["nodes"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|n| n["id"] == id)
                .unwrap();
            n["summary"] = json!(t);
        }
    }))
}

#[track_caller]
fn flagged(text: &str) {
    flagged_beside(text, "A library.");
}

#[track_caller]
fn flagged_beside(text: &str, elsewhere: &str) {
    let r = summary(text, elsewhere);
    assert!(
        r.warnings
            .iter()
            .any(|f| f.rule == rule::WORDS_JUDGING && f.path == "/nodes/1/summary"),
        "{text:?}: {:#?}",
        r.warnings
    );
}

#[track_caller]
fn not_flagged(text: &str) {
    not_flagged_beside(text, "A library.");
}

#[track_caller]
fn not_flagged_beside(text: &str, elsewhere: &str) {
    let r = summary(text, elsewhere);
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

/// A capitalised word that the analysis never writes as code is a word, wherever it sits.
#[test]
fn a_capitalised_word_is_a_word_unless_the_analysis_writes_it_as_code() {
    flagged("Moves the code; Should be split later.");
    flagged("The handler — Better than the old one.");
    flagged("It is \"Clean\".");
    flagged("It's Concerning.");
    flagged("Summary\nBetter handling");
    flagged("- Splits it\n- Better paths");
    flagged("Opens each file through Mirrors, behind its gate.");
    // A word written as code in one place is still a word elsewhere: only a capitalised or
    // joined one becomes a name.
    flagged_beside("A clean split.", "Runs `clean` first.");
}

/// Once the analysis writes `Mirrors` as code (a code span, or a `::` path in its prose), it's
/// the type, at a sentence's start too.
#[test]
fn a_capitalised_name_the_analysis_writes_as_code_is_skipped() {
    not_flagged_beside("Mirrors opens every account's file.", "Wraps `Mirrors`.");
    not_flagged_beside(
        "Mirrors opens every account's file.",
        "Wraps dbrt::Mirrors.",
    );
    not_flagged_beside(
        "Opens each file through Mirrors, behind its gate.",
        "Wraps `dbrt::Mirrors::new`.",
    );
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
    // Joined by `_` or `::`, or by `-`, `/` or `.` as code is.
    not_flagged("Calls clean_path on every path.");
    not_flagged("Calls dbrt::Mirrors::new.");
    not_flagged("Calls crate::Mirrors.");
    not_flagged("Reads mirrors.rs and web/src/clean.ts.");
    not_flagged("Calls self.clean on drop.");
    // Mixed case.
    not_flagged("Calls isClean and CleanPath.");
    // A phrase doesn't run across an identifier.
    not_flagged("The same as_ref call.");
}

/// Two plain words joined by `-` or `/` (or by `.` before a capital, a missing space) are prose,
/// unless the analysis writes the pair as code: a path, or a code span.
#[test]
fn a_joined_pair_of_plain_words_is_prose_unless_the_analysis_names_it() {
    flagged("It is better-tested now.");
    flagged("clean/simple");
    flagged("It splits it clean.It reads well.");
    flagged("Writes the pristine-mirrors folder.");
    not_flagged_beside(
        "Writes the pristine-mirrors folder.",
        "Copies `pristine-mirrors/` into each data dir.",
    );
}
