//! The validator. It migrates first, then checks the shape, then every rule that needs no code,
//! then, given a reader, the rules that read the checkouts. It never stops early on its own
//! account: every finding lands in the one report.

mod carried;
mod claims;
mod code;
mod graph;
pub(crate) mod hints;
pub(crate) mod index;
mod purposes;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::migrate::{CHAIN, Chain, MigrateError, Rename};
use crate::reader::Reader;
use crate::report::{Report, rule};
use crate::schema::Analysis;
use crate::tools::{PreviousIds, Vocabulary};

/// What the caller knows beyond the analysis itself.
#[derive(Debug, Clone, Default)]
pub struct Context {
    /// The changed files the run pinned (`pr.json`'s `files[].path`). With them, every one must
    /// be placed on a node (`file.unplaced`).
    pub changed_files: Option<Vec<String>>,
    pub previous: Previous,
}

/// The previous analysis, as the run serves it.
#[derive(Debug, Clone, Default)]
pub enum Previous {
    /// Not given: `carried` isn't checked against anything.
    #[default]
    Unknown,
    /// There is none: `carried` must be empty.
    None,
    Some {
        ids: PreviousIds,
        vocabulary: Vocabulary,
    },
}

/// The validator's result.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub report: Report,
    /// The analysis at the current version, when its shape held.
    pub analysis: Option<Analysis>,
    /// The version the file had, when it had one this build knows.
    pub from_version: Option<u32>,
    /// IDs the migrations renamed (the server stores them as `migratedIds`).
    pub renames: Vec<Rename>,
}

/// Validates an analysis given as JSON text.
pub fn validate(text: &str, ctx: &Context, reader: Option<&dyn Reader>) -> Outcome {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => validate_value(v, ctx, reader),
        Err(e) => {
            let mut report = Report::default();
            report.error("", rule::SHAPE_JSON, format!("not JSON: {e}"));
            Outcome {
                report,
                analysis: None,
                from_version: None,
                renames: Vec::new(),
            }
        }
    }
}

/// Validates an analysis already parsed as JSON.
pub fn validate_value(value: Value, ctx: &Context, reader: Option<&dyn Reader>) -> Outcome {
    validate_with(&CHAIN, value, ctx, reader)
}

/// Validates against a given migration chain: [`validate_value`] passes this build's.
pub fn validate_with(
    chain: &Chain,
    value: Value,
    ctx: &Context,
    reader: Option<&dyn Reader>,
) -> Outcome {
    let mut report = Report::default();
    let mut out = Outcome {
        report: Report::default(),
        analysis: None,
        from_version: None,
        renames: Vec::new(),
    };
    let migrated = match chain.migrate(value) {
        Ok(m) => m,
        Err(e) => {
            let r = match e {
                MigrateError::Step { .. } => rule::MIGRATION_FAILED,
                MigrateError::NoVersion(_) | MigrateError::Newer(..) => rule::VERSION_UNKNOWN,
            };
            report.error("/version", r, e.to_string());
            out.report = report;
            return out;
        }
    };
    out.from_version = Some(migrated.from);
    out.renames = migrated.renames;
    if migrated.from < chain.version {
        report.warn(
            "/version",
            rule::SCHEMA_MIGRATED,
            format!(
                "migrated from version {} to {}: the schema moved since your files were fetched; refetch schema.ts, validate.mjs and the instructions from the same run",
                migrated.from, chain.version
            ),
        );
    }
    let mut value = migrated.value;
    if let Some(h) = value.as_object_mut().and_then(|o| o.remove("hints")) {
        hints::check_present(&h, &mut report);
    }
    let Some(a) = shape(&value, &mut report) else {
        out.report = report;
        return out;
    };
    report.extend(check(&a, ctx, reader));
    out.report = report;
    out.analysis = Some(a);
    out
}

/// Every rule on a parsed analysis.
fn check(a: &Analysis, ctx: &Context, reader: Option<&dyn Reader>) -> Report {
    let mut r = Report::default();
    let ix = index::Index::new(a);
    graph::check(&ix, ctx, &mut r);
    claims::check(&ix, &mut r);
    purposes::check(&ix, &mut r);
    carried::check(&ix, &ctx.previous, &mut r);
    if let Some(reader) = reader {
        code::check(&ix, reader, &mut r);
    }
    r
}

/// The top level's fields, in order.
pub(crate) const FIELDS: &[&str] = &[
    "version",
    "pr",
    "coverage",
    "walk",
    "nodes",
    "edges",
    "boundaries",
    "scenarios",
    "facets",
    "purposes",
    "conflicts",
    "causes",
    "unclaimed",
    "unbacked",
    "carried",
    "claims",
];

/// The shape check, element by element so one bad node doesn't hide the next. Returns the typed
/// analysis only when every part of it held.
fn shape(value: &Value, r: &mut Report) -> Option<Analysis> {
    let Some(obj) = value.as_object() else {
        r.error("", rule::SHAPE_TYPE, "an analysis is a JSON object");
        return None;
    };
    for k in obj.keys() {
        if !FIELDS.contains(&k.as_str()) {
            r.error(
                format!("/{k}"),
                rule::SHAPE_UNKNOWN_FIELD,
                format!("unknown field `{k}`"),
            );
        }
    }
    let before = r.errors.len();
    let version = one::<u32>(obj, "version", r);
    let pr = one(obj, "pr", r);
    let coverage = one(obj, "coverage", r);
    let walk = one(obj, "walk", r);
    let nodes = list(obj, "nodes", r);
    let edges = list(obj, "edges", r);
    let boundaries = list(obj, "boundaries", r);
    let scenarios = list(obj, "scenarios", r);
    let facets = list(obj, "facets", r);
    let purposes = list(obj, "purposes", r);
    let conflicts = list(obj, "conflicts", r);
    let causes = list(obj, "causes", r);
    let unclaimed = list(obj, "unclaimed", r);
    let unbacked = match obj.get("unbacked") {
        None | Some(Value::Null) => Some(None),
        Some(v) => parse::<String>(v, "/unbacked", r).map(Some),
    };
    let carried = list(obj, "carried", r);
    let claims = list(obj, "claims", r);
    if r.errors.len() > before {
        return None;
    }
    Some(Analysis {
        version: version?,
        pr: pr?,
        coverage: coverage?,
        walk: walk?,
        nodes: nodes?,
        edges: edges?,
        boundaries: boundaries?,
        scenarios: scenarios?,
        facets: facets?,
        purposes: purposes?,
        conflicts: conflicts?,
        causes: causes?,
        unclaimed: unclaimed?,
        unbacked: unbacked?,
        carried: carried?,
        claims: claims?,
    })
}

fn one<T: DeserializeOwned>(obj: &Map<String, Value>, key: &str, r: &mut Report) -> Option<T> {
    match obj.get(key) {
        Some(v) => parse(v, &format!("/{key}"), r),
        None => {
            r.error(
                "",
                rule::SHAPE_MISSING_FIELD,
                format!("missing field `{key}`"),
            );
            None
        }
    }
}

fn list<T: DeserializeOwned>(
    obj: &Map<String, Value>,
    key: &str,
    r: &mut Report,
) -> Option<Vec<T>> {
    match obj.get(key) {
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            let mut ok = true;
            for (i, v) in items.iter().enumerate() {
                match parse(v, &format!("/{key}/{i}"), r) {
                    Some(x) => out.push(x),
                    None => ok = false,
                }
            }
            ok.then_some(out)
        }
        Some(_) => {
            r.error(
                format!("/{key}"),
                rule::SHAPE_TYPE,
                format!("`{key}` is a list"),
            );
            None
        }
        None => {
            r.error(
                "",
                rule::SHAPE_MISSING_FIELD,
                format!("missing field `{key}` (an empty list if there are none)"),
            );
            None
        }
    }
}

/// Parses one element, filing serde's complaint under the rule it names.
pub(crate) fn parse<T: DeserializeOwned>(v: &Value, path: &str, r: &mut Report) -> Option<T> {
    match T::deserialize(v) {
        Ok(x) => Some(x),
        Err(e) => {
            let msg = e.to_string();
            let id = if msg.starts_with("missing field") {
                rule::SHAPE_MISSING_FIELD
            } else if msg.starts_with("unknown field") {
                rule::SHAPE_UNKNOWN_FIELD
            } else if msg.starts_with("unknown variant") {
                rule::SHAPE_ENUM
            } else {
                rule::SHAPE_TYPE
            };
            r.error(path, id, msg);
            None
        }
    }
}
