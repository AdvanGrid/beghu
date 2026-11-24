//! The hand-written sample (`tests/sample/`): a two-file PR on a tiny Go shop, its analysis, its
//! base and head checkouts, its `pr.json`, the previous analysis's skeleton, a `split.json` and
//! the fragments of a split run. Tests edit the analysis next to their assertion.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use analysis::{CodeSide, Context, EntryKind, Previous, Reader, Report, validate_value};
use serde_json::Value;

pub fn sample_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sample")
}

pub fn load(rel: &str) -> Value {
    let p = sample_dir().join(rel);
    serde_json::from_str(
        &std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
    )
    .unwrap()
}

/// The sample analysis.
pub fn sample() -> Value {
    load("analysis.json")
}

/// The sample, edited.
pub fn edit(f: impl FnOnce(&mut Value)) -> Value {
    let mut v = sample();
    f(&mut v);
    v
}

/// The run's changed files, from the sample's `pr.json`.
pub fn changed_files() -> Vec<String> {
    load("pr.json")["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_owned())
        .collect()
}

pub fn previous() -> Previous {
    Previous::Some {
        ids: serde_json::from_value(load("previous/previous-ids.json")).unwrap(),
        vocabulary: serde_json::from_value(load("previous/vocabulary.json")).unwrap(),
    }
}

/// The two checkouts on disk, as the CLI reads them.
pub struct Checkouts;

impl Checkouts {
    fn path(side: CodeSide, p: &str) -> PathBuf {
        sample_dir()
            .join(match side {
                CodeSide::Base => "base",
                CodeSide::Head => "head",
            })
            .join(p)
    }
}

impl Reader for Checkouts {
    fn read(&self, side: CodeSide, path: &str) -> Option<String> {
        std::fs::read_to_string(Self::path(side, path)).ok()
    }

    fn kind(&self, side: CodeSide, path: &str) -> Option<EntryKind> {
        let m = std::fs::metadata(Self::path(side, path)).ok()?;
        Some(if m.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        })
    }

    /// Every file under the checkout: the sample's checkouts are committed whole, so every file
    /// in them is tracked.
    fn tracked(&self, side: CodeSide) -> Option<Vec<String>> {
        let root = Self::path(side, "");
        let mut out = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).ok()?.filter_map(Result::ok) {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    let rel = p
                        .strip_prefix(&root)
                        .ok()?
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push(rel);
                }
            }
        }
        out.sort();
        Some(out)
    }
}

/// The checks with no reader, as the server runs them.
pub fn check(v: Value) -> Report {
    validate_value(v, &Context::default(), None).report
}

pub fn check_with(v: Value, ctx: &Context) -> Report {
    validate_value(v, ctx, None).report
}

/// Every check, with the checkouts, as the CLI and validate.mjs run them.
pub fn check_code(v: Value) -> Report {
    validate_value(v, &Context::default(), Some(&Checkouts)).report
}

#[track_caller]
pub fn assert_error(r: &Report, rule: &str) {
    assert!(
        r.errors.iter().any(|f| f.rule == rule),
        "expected an error `{rule}`, got errors {:#?} and warnings {:#?}",
        r.errors,
        r.warnings
    );
}

#[track_caller]
pub fn assert_warning(r: &Report, rule: &str) {
    assert!(
        r.warnings.iter().any(|f| f.rule == rule),
        "expected a warning `{rule}`, got errors {:#?} and warnings {:#?}",
        r.errors,
        r.warnings
    );
    assert!(
        !r.errors.iter().any(|f| f.rule == rule),
        "`{rule}` is a warning, not an error"
    );
}

#[track_caller]
pub fn assert_clean(r: &Report) {
    assert!(
        r.errors.is_empty() && r.warnings.is_empty(),
        "errors {:#?}, warnings {:#?}",
        r.errors,
        r.warnings
    );
}
