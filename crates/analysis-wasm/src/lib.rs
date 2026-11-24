//! The analysis crate for Node: `validate.mjs` and `merge.mjs` (`build.sh` inlines this build
//! into each as base64). Everything crosses as JSON text; the checkouts cross as a JS object
//! whose methods read them with `node:fs`.

use analysis::{CodeSide, Context, EntryKind, PreviousIds, Reader, Report, Vocabulary, rule};
use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// The two checkouts, as `validate.mjs` reads them.
    pub type Checkouts;

    /// A file's text, or `undefined`.
    #[wasm_bindgen(method)]
    fn read(this: &Checkouts, side: &str, path: &str) -> Option<String>;

    /// `"file"`, `"dir"`, or `undefined` when the path doesn't exist.
    #[wasm_bindgen(method)]
    fn kind(this: &Checkouts, side: &str, path: &str) -> Option<String>;

    /// Every file git tracks in that checkout (`git ls-files`), as a JSON array of repo-relative
    /// paths, or `undefined` when git can't list them.
    #[wasm_bindgen(method)]
    fn tracked(this: &Checkouts, side: &str) -> Option<String>;
}

fn side(s: CodeSide) -> &'static str {
    match s {
        CodeSide::Base => "base",
        CodeSide::Head => "head",
    }
}

struct JsReader(Checkouts);

impl Reader for JsReader {
    fn read(&self, s: CodeSide, path: &str) -> Option<String> {
        self.0.read(side(s), path)
    }

    fn kind(&self, s: CodeSide, path: &str) -> Option<EntryKind> {
        match self.0.kind(side(s), path).as_deref() {
            Some("file") => Some(EntryKind::File),
            Some("dir") => Some(EntryKind::Dir),
            _ => None,
        }
    }

    fn tracked(&self, s: CodeSide) -> Option<Vec<String>> {
        self.0
            .tracked(side(s))
            .and_then(|j| serde_json::from_str(&j).ok())
    }
}

/// What each function returns, serialised in field order (`{path, rule, message}` included).
#[derive(Serialize)]
struct Out<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    analysis: Option<Option<&'a Value>>,
    report: &'a Report,
    #[serde(skip_serializing_if = "Option::is_none")]
    counts: Option<Value>,
}

fn out(analysis: Option<Option<&Value>>, report: &Report, counts: Option<Value>) -> String {
    serde_json::to_string(&Out {
        analysis,
        report,
        counts,
    })
    .unwrap_or_default()
}

/// `options`: `{changedFiles?: string[], previous?: {ids, vocabulary} | null}`, where a `null`
/// previous means the run has none. Returns `{report, counts?}`.
#[wasm_bindgen]
pub fn validate(analysis: &str, options: &str, checkouts: Option<Checkouts>) -> String {
    let opts: Value = serde_json::from_str(options).unwrap_or(Value::Null);
    let changed_files = opts
        .get("changedFiles")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let previous = match opts.get("previous") {
        None => analysis::Previous::Unknown,
        Some(Value::Null) => analysis::Previous::None,
        Some(p) => {
            let ids = p
                .get("ids")
                .and_then(|v| serde_json::from_value::<PreviousIds>(v.clone()).ok());
            let vocabulary = p
                .get("vocabulary")
                .and_then(|v| serde_json::from_value::<Vocabulary>(v.clone()).ok());
            match (ids, vocabulary) {
                (Some(ids), Some(vocabulary)) => analysis::Previous::Some { ids, vocabulary },
                _ => {
                    let mut r = Report::default();
                    r.error(
                        "",
                        rule::SHAPE_TYPE,
                        "previous-ids.json or vocabulary.json doesn't fit schema.ts",
                    );
                    return out(None, &r, None);
                }
            }
        }
    };
    let ctx = Context {
        changed_files,
        previous,
    };
    let reader = checkouts.map(JsReader);
    let result = analysis::validate(analysis, &ctx, reader.as_ref().map(|r| r as &dyn Reader));
    let counts = result.analysis.as_ref().map(|a| {
        json!({
            "nodes": a.nodes.len(),
            "edges": a.edges.len(),
            "claims": a.claims.len(),
            "scenarios": a.scenarios.len(),
            "purposes": a.purposes.len(),
            "conflicts": a.conflicts.len(),
        })
    });
    self::out(None, &result.report, counts)
}

/// `changed_files`: a JSON array, or `null` when not known. Returns `{report}`.
#[wasm_bindgen]
pub fn check_split(skeleton: &str, split: &str, changed_files: &str) -> String {
    let mut r = Report::default();
    let parse = |text: &str, what: &str, r: &mut Report| match serde_json::from_str::<Value>(text) {
        Ok(v) => Some(v),
        Err(e) => {
            r.error("", rule::SHAPE_JSON, format!("{what} isn't JSON: {e}"));
            None
        }
    };
    let (Some(skeleton), Some(split)) = (
        parse(skeleton, "the skeleton", &mut r),
        parse(split, "split.json", &mut r),
    ) else {
        return out(None, &r, None);
    };
    let files: Option<Vec<String>> = serde_json::from_str(changed_files).ok().flatten();
    out(
        None,
        &analysis::check_split(&skeleton, &split, files.as_deref()),
        None,
    )
}

/// `fragments`: a JSON array of the fragments' texts, in order. Returns `{analysis, report}`.
#[wasm_bindgen]
pub fn merge(fragments: &str) -> String {
    let texts: Vec<String> = serde_json::from_str(fragments).unwrap_or_default();
    let mut bad = Report::default();
    let mut values = Vec::new();
    for (i, t) in texts.iter().enumerate() {
        match serde_json::from_str::<Value>(t) {
            Ok(v) => values.push(v),
            Err(e) => bad.error(
                format!("/{i}"),
                rule::SHAPE_JSON,
                format!("fragment {} isn't JSON: {e}", i + 1),
            ),
        }
    }
    if !bad.is_ok() {
        return out(Some(None), &bad, None);
    }
    let m = analysis::merge(values);
    out(Some(Some(&m.analysis)), &m.report, None)
}

/// `merged`: the seam pass's output. Returns `{analysis, report}`.
#[wasm_bindgen]
pub fn finish(merged: &str) -> String {
    match serde_json::from_str::<Value>(merged) {
        Ok(v) => {
            let m = analysis::finish(v);
            out(Some(Some(&m.analysis)), &m.report, None)
        }
        Err(e) => {
            let mut r = Report::default();
            r.error("", rule::SHAPE_JSON, format!("not JSON: {e}"));
            out(Some(None), &r, None)
        }
    }
}
