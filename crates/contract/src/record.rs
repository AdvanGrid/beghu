//! Recording templates again from a run's answers: each template's shape becomes the shape every
//! answer of its run fits, keeping the nulls the old template allowed (one night's answers may not
//! show a field's null) and its pins.

use crate::check::Findings;
use crate::shape::Shape;
use crate::templates::{Template, Templates};
use serde_json::Value;
use std::collections::BTreeMap;

/// Fields GitHub's API description (its OpenAPI, and the GraphQL schema) marks as nullable,
/// wherever they occur: one run's answers seldom show both a value and a null.
const NULLABLE: [&str; 33] = [
    // REST: issues, comments, labels, milestones, users, events, installations, repos.
    "active_lock_reason",
    "actor",
    "assignee",
    "body",
    "closed_at",
    "closed_by",
    "commit_id",
    "commit_url",
    "creator",
    "description",
    "due_on",
    "email",
    "homepage",
    "language",
    "license",
    "merged_at",
    "milestone",
    "mirror_url",
    "payload",
    "performed_via_github_app",
    "state_reason",
    "suspended_at",
    "suspended_by",
    "type",
    "user",
    // GraphQL.
    "author",
    "closedAt",
    "endCursor",
    "issueType",
    "mergedAt",
    "parent",
    "reviewDecision",
    "stateReason",
];

/// Lists whose items differ by a field, recorded per value of it.
const ITEMS_BY: [(&str, &str); 1] = [("rest.issue_events", "event")];

/// `templates` with every template the run answered recorded again from its answers. A run's
/// answers with another status than the template's (a fault, a refusal) are left out of it.
pub fn record(mut templates: Templates, found: &Findings) -> Templates {
    for (name, samples) in &found.samples {
        let old = templates.get(name).cloned();
        let (request, status) = match &old {
            Some(t) => (t.request.clone(), t.status),
            None => (samples[0].0.clone(), samples[0].1),
        };
        let bodies: Vec<&Value> = samples
            .iter()
            .filter(|(_, s, _)| *s == status)
            .map(|(_, _, b)| b)
            .collect();
        if bodies.is_empty() {
            continue;
        }
        let keep = |new: Shape, old: Option<&Shape>| {
            let new = new.null_fields_unknown().nullable(&NULLABLE);
            match old {
                Some(o) => new.keeping_nulls_of(o),
                None => new,
            }
        };
        let by = ITEMS_BY.iter().find(|(n, _)| n == name).map(|(_, f)| *f);
        let (shape, items_by) = match by {
            Some(field) => {
                let mut variants: BTreeMap<String, Shape> = old
                    .as_ref()
                    .and_then(|t| t.items_by.as_ref())
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                let mut fresh: BTreeMap<String, Shape> = BTreeMap::new();
                for item in bodies.iter().filter_map(|b| b.as_array()).flatten() {
                    if let Some(v) = item[field].as_str() {
                        let s = Shape::of(item);
                        let merged = match fresh.remove(v) {
                            Some(prev) => prev.merge(s),
                            None => s,
                        };
                        fresh.insert(v.to_owned(), merged);
                    }
                }
                for (v, s) in fresh {
                    let kept = keep(s, variants.get(&v));
                    variants.insert(v, kept);
                }
                (
                    Shape::Array(Box::new(Shape::Any)),
                    Some((field.to_owned(), variants)),
                )
            }
            None => {
                let shape = bodies
                    .iter()
                    .map(|b| Shape::of(b))
                    .reduce(Shape::merge)
                    .unwrap_or(Shape::Any);
                (keep(shape, old.as_ref().map(|t| &t.shape)), None)
            }
        };
        let pins = old.as_ref().map(|t| t.pins.clone()).unwrap_or_default();
        templates.all.insert(
            name.clone(),
            Template {
                request,
                status,
                shape,
                pins,
                items_by,
            },
        );
    }
    templates
}
