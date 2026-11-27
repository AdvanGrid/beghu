//! Claims and their evidence, short of reading the code.

use std::collections::HashSet;

use super::graph::words;
use super::index::{Index, Source, claim_refs};
use crate::report::{Report, rule};
use crate::schema::{ClaimStatus, Evidence};

/// The longest code evidence, in lines.
pub const MAX_LINES: u32 = 25;

pub(super) fn check(ix: &Index, r: &mut Report) {
    let a = ix.a;
    let refs = claim_refs(a);
    let mut used = HashSet::new();
    let mut stated_flagged = HashSet::new();
    for cr in &refs {
        used.insert(cr.id);
        let Some(&ci) = ix.claims.get(cr.id) else {
            r.error(
                &cr.path,
                rule::REF_UNKNOWN,
                format!("unknown claim `{}`", cr.id),
            );
            continue;
        };
        let c = &a.claims[ci];
        let stated_only = !c.evidence.is_empty()
            && !c
                .evidence
                .iter()
                .any(|e| matches!(e, Evidence::Code { .. }));
        if cr.source == Source::CodeOnly
            && stated_only
            && stated_flagged.insert((cr.path.clone(), ci))
        {
            r.error(
                &cr.path,
                rule::CLAIM_STATED_ONLY,
                format!(
                    "`{}` rests on the description or an issue alone, but this is the code view: back it with code, or mark it undetermined with where you looked",
                    c.id
                ),
            );
        }
    }
    for (i, c) in a.claims.iter().enumerate() {
        let p = format!("/claims/{i}");
        if !used.contains(c.id.as_str()) {
            r.warn(
                &p,
                rule::CLAIM_UNUSED,
                format!("nothing refers to `{}`", c.id),
            );
        }
        if c.status == ClaimStatus::Supported && c.evidence.is_empty() {
            r.error(
                format!("{p}/evidence"),
                rule::CLAIM_NO_EVIDENCE,
                format!("`{}` is supported but has no evidence", c.id),
            );
        }
        if c.status == ClaimStatus::Undetermined
            && c.looked_at.as_deref().is_none_or(|s| s.trim().is_empty())
        {
            r.error(
                format!("{p}/lookedAt"),
                rule::CLAIM_LOOKED_AT,
                format!("`{}` is undetermined: say where you looked", c.id),
            );
        }
        words(ix, r, format!("{p}/text"), &c.text);
        for (ei, e) in c.evidence.iter().enumerate() {
            if let Evidence::Code { start, end, .. } = e {
                let ep = format!("{p}/evidence/{ei}");
                if *start < 1 || end < start {
                    r.error(
                        &ep,
                        rule::EVIDENCE_LINES,
                        format!("lines {start}–{end} aren't a range: 1-based, start ≤ end"),
                    );
                } else if end - start >= MAX_LINES {
                    r.error(
                        &ep,
                        rule::EVIDENCE_LINES,
                        format!(
                            "{} lines: cite at most {MAX_LINES}, the lines that show the point",
                            end - start + 1
                        ),
                    );
                }
            }
        }
    }
}
