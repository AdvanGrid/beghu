//! Hints: what the split procedure leaves for the seam pass. They never reach the upload.

use std::collections::HashSet;

use serde_json::Value;

use super::parse;
use crate::report::{Report, rule};
use crate::tools::{Hint, Resolution, ResolutionHow};

pub(crate) fn resolution(h: &Hint) -> Option<&Resolution> {
    match h {
        Hint::Seam { resolution, .. }
        | Hint::Deepen { resolution, .. }
        | Hint::Candidate { resolution, .. }
        | Hint::Purpose { resolution, .. }
        | Hint::Rule { resolution, .. } => resolution.as_ref(),
    }
}

/// A short description of the hint, for messages.
pub(crate) fn describe(h: &Hint) -> String {
    match h {
        Hint::Seam { from, to, .. } => format!("seam hint `{from}` → `{to}`"),
        Hint::Deepen { line, to, .. } => {
            format!("line `{line}` ends at `{to}`, which has children in another area")
        }
        Hint::Candidate { from, to, .. } => format!("candidate `{from}` → `{to}`"),
        Hint::Purpose { name, .. } => format!("purpose hint \"{name}\""),
        Hint::Rule { text, .. } => format!("rule hint \"{text}\""),
    }
}

/// An analysis given to the validator still carries `hints`: each unresolved one is
/// `hint.unresolved`, and the key itself fails the shape check (`shape.hints`), even when the list
/// is empty, since an upload carries no `hints` at all.
pub(crate) fn check_present(hints: &Value, r: &mut Report) {
    let Some(items) = hints.as_array() else {
        r.error(
            "/hints",
            rule::SHAPE_HINTS,
            "an upload carries no `hints`: resolve them and run `node merge.mjs --finish`",
        );
        return;
    };
    let mut resolved = 0;
    for (i, v) in items.iter().enumerate() {
        let Some(h) = parse::<Hint>(v, &format!("/hints/{i}"), r) else {
            continue;
        };
        if resolution(&h).is_none() {
            r.error(
                format!("/hints/{i}"),
                rule::HINT_UNRESOLVED,
                format!("{} is unresolved: draw it, deepen it, add or fold it, or reject it with a claim", describe(&h)),
            );
        } else {
            resolved += 1;
        }
    }
    let message = if items.is_empty() {
        "an empty `hints` list is still here: an upload carries no `hints` key; `node merge.mjs --finish` drops it".to_owned()
    } else if resolved == items.len() {
        format!(
            "{resolved} resolved hints are still here: `node merge.mjs --finish` strips them, and an upload carries no `hints`"
        )
    } else {
        "an upload carries no `hints`: resolve every one, then `node merge.mjs --finish` strips them".to_owned()
    };
    r.error("/hints", rule::SHAPE_HINTS, message);
}

/// The IDs a resolution may point at, from a (possibly partial) analysis.
pub(crate) struct Known {
    pub edges: HashSet<String>,
    pub purposes: HashSet<String>,
    pub rules: HashSet<String>,
    pub claims: HashSet<String>,
}

impl Known {
    pub fn of(v: &Value) -> Self {
        let ids = |key: &str| -> HashSet<String> {
            v.get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|x| x.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        };
        let rules = v
            .get("purposes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|p| {
                p.get("rules")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .filter_map(|x| x.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        Known {
            edges: ids("edges"),
            purposes: ids("purposes"),
            rules,
            claims: ids("claims"),
        }
    }
}

/// Why a resolution doesn't hold, if it doesn't.
pub(crate) fn resolution_problem(h: &Hint, res: &Resolution, known: &Known) -> Option<String> {
    for c in &res.claims {
        if !known.claims.contains(c) {
            return Some(format!("its resolution names unknown claim `{c}`"));
        }
    }
    let refs_in = |set: &HashSet<String>, what: &str| -> Option<String> {
        if res.refs.is_empty() {
            return Some(format!("its resolution names no {what}"));
        }
        res.refs
            .iter()
            .find(|x| !set.contains(*x))
            .map(|x| format!("its resolution names unknown {what} `{x}`"))
    };
    match res.how {
        ResolutionHow::Rejected if res.claims.is_empty() => {
            Some("a rejection needs a claim saying where you looked".into())
        }
        ResolutionHow::Rejected => None,
        ResolutionHow::Drawn | ResolutionHow::Deepened => match h {
            Hint::Seam { .. } | Hint::Deepen { .. } | Hint::Candidate { .. } => {
                refs_in(&known.edges, "edge")
            }
            _ => Some("a purpose or rule hint is added, folded or rejected".into()),
        },
        ResolutionHow::Added | ResolutionHow::Folded => match h {
            Hint::Purpose { .. } => refs_in(&known.purposes, "purpose"),
            Hint::Rule { .. } => refs_in(&known.rules, "rule"),
            _ => Some("a line hint is drawn, deepened or rejected".into()),
        },
    }
}
