//! `carried`: every previous ID this analysis no longer has is accounted for, with evidence.

use std::collections::{BTreeMap, HashSet};

use super::Previous;
use super::index::Index;
use crate::report::{Report, rule};
use crate::schema::{CarriedKind, ClaimStatus};

/// Every ID `carried` can name in an analysis: nodes, lines, facets, facet values as
/// `<facet id>/<value id>`, and purposes.
fn current(ix: &Index) -> HashSet<String> {
    let a = ix.a;
    let mut out: HashSet<String> = HashSet::new();
    out.extend(a.nodes.iter().map(|n| n.id.clone()));
    out.extend(a.edges.iter().map(|e| e.id.clone()));
    for f in &a.facets {
        out.insert(f.id.clone());
        out.extend(f.values.iter().map(|v| format!("{}/{}", f.id, v.id)));
    }
    out.extend(a.purposes.iter().map(|p| p.id.clone()));
    out
}

pub(super) fn check(ix: &Index, previous: &Previous, r: &mut Report) {
    let a = ix.a;
    let now = current(ix);
    for (i, c) in a.carried.iter().enumerate() {
        let p = format!("/carried/{i}");
        if now.contains(&c.was) {
            r.error(
                format!("{p}/was"),
                rule::CARRY_PRESENT,
                format!(
                    "`{}` is still in this analysis: `carried` is only for IDs it no longer has",
                    c.was
                ),
            );
        }
        let want = match c.kind {
            CarriedKind::Renamed | CarriedKind::Merged => c.now.len() == 1,
            CarriedKind::Split => c.now.len() >= 2,
            CarriedKind::Dropped => c.now.is_empty(),
        };
        if !want {
            r.error(
                format!("{p}/now"),
                rule::CARRY_NOW,
                "`now` holds one ID for renamed and merged, two or more for split, none for dropped",
            );
        }
        for (ni, id) in c.now.iter().enumerate() {
            if !now.contains(id) {
                r.error(
                    format!("{p}/now/{ni}"),
                    rule::REF_UNKNOWN,
                    format!("`{id}` isn't in this analysis"),
                );
            }
        }
        let backed = c.claims.iter().any(|id| {
            ix.claims.get(id.as_str()).is_some_and(|&ci| {
                a.claims[ci].status == ClaimStatus::Supported && !a.claims[ci].evidence.is_empty()
            })
        });
        if !backed {
            r.error(
                format!("{p}/claims"),
                rule::CARRY_EVIDENCE,
                format!("`{}` needs a supported claim with evidence: the lines that show the new reading", c.was),
            );
        }
    }
    match previous {
        Previous::Unknown => {}
        Previous::None => {
            for i in 0..a.carried.len() {
                r.error(
                    format!("/carried/{i}"),
                    rule::CARRY_UNKNOWN,
                    "there is no previous analysis, so `carried` is empty",
                );
            }
        }
        Previous::Some { ids, vocabulary } => {
            // Previous ID → what it was, for the report.
            let mut before: BTreeMap<String, String> = BTreeMap::new();
            for n in &ids.nodes {
                before.insert(n.id.clone(), "node".into());
            }
            for e in &ids.edges {
                before.insert(
                    e.id.clone(),
                    format!("line from `{}` to `{}`", e.from, e.to),
                );
            }
            for f in &vocabulary.facets {
                before.insert(f.id.clone(), format!("facet \"{}\"", f.name));
                for v in &f.values {
                    before.insert(
                        format!("{}/{}", f.id, v.id),
                        format!("value \"{}\" of facet `{}`", v.label, f.id),
                    );
                }
            }
            for p in &vocabulary.purposes {
                before.insert(p.id.clone(), format!("purpose \"{}\"", p.name));
            }
            let declared: HashSet<&str> = a.carried.iter().map(|c| c.was.as_str()).collect();
            for (id, what) in &before {
                if !now.contains(id) && !declared.contains(id.as_str()) {
                    r.error(
                        "/carried",
                        rule::CARRY_UNACCOUNTED,
                        format!("`{id}` ({what}) was in the previous analysis and isn't in this one: reuse it, or say where it went in `carried`"),
                    );
                }
            }
            for (i, c) in a.carried.iter().enumerate() {
                if !before.contains_key(&c.was) {
                    r.error(
                        format!("/carried/{i}/was"),
                        rule::CARRY_UNKNOWN,
                        format!("`{}` wasn't in the previous analysis", c.was),
                    );
                }
            }
        }
    }
}
