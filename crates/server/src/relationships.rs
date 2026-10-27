//! Relationships on the read side: what a list row shows of them (its open blockers, up to 8,
//! and its sub-issue progress) and what the detail shows (the parent, the sub-issues, both sides
//! of the dependencies and the relates-to relationships), with its linked PRs, which aren't
//! relationships: the issues a PR closes, and the PRs that close an issue. Progress always counts
//! every descendant, closed against total. An end in a repo that isn't synced is a stub: the
//! client opens it on GitHub.

use crate::api::PrStatus;
use mirror_db::{QueryResult, Reader, q};
use serde::Serialize;
use std::collections::HashMap;
use ts_rs::TS;

/// Sub-issue progress: every descendant, however deep.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct Progress {
    /// Closed descendants.
    pub done: i64,
    /// All descendants, open and closed.
    pub total: i64,
}

/// One open blocker of a list row, as its chip and the hover card show it.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Blocker {
    pub id: i64,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// In a repo that isn't synced: shown as "not synced", opening on GitHub.
    pub stub: bool,
    /// Who has it (the first assignee); `null` when nobody does.
    pub assignee: Option<String>,
    /// How many open issues block it in turn: above 0, it's itself blocked.
    pub blocked_by: i64,
    /// Unix seconds; `null` for a stub.
    pub updated_at: Option<i64>,
}

/// What a list row shows of its relationships.
#[derive(Default)]
pub struct RowRelationships {
    /// Open blockers in all.
    pub blocked_by: i64,
    /// The first 8 of them (`row_blockers` caps them): enough for the chips and the hover card.
    pub blockers: Vec<Blocker>,
    pub progress: Option<Progress>,
}

/// The relationships of each of `ids` that has any, for the list.
pub fn for_rows(c: &Reader, ids: &[i64]) -> QueryResult<HashMap<i64, RowRelationships>> {
    let mut out: HashMap<i64, RowRelationships> = HashMap::new();
    for b in q::row_blockers(c, ids)? {
        let row = out.entry(b.item_id).or_default();
        row.blocked_by = b.open_total;
        row.blockers.push(Blocker {
            id: b.id,
            owner: b.owner,
            repo: b.repo,
            number: b.number,
            title: b.title,
            stub: b.is_stub || !b.synced,
            assignee: b.assignee,
            blocked_by: b.open_blockers,
            updated_at: b.updated_at,
        });
    }
    for (id, p) in progress(c, ids)? {
        out.entry(id).or_default().progress = Some(p);
    }
    Ok(out)
}

/// Sub-issue progress of each of `ids` that has sub-issues.
fn progress(c: &Reader, ids: &[i64]) -> QueryResult<HashMap<i64, Progress>> {
    Ok(q::progress(c, ids)?
        .into_iter()
        .map(|p| {
            (
                p.item_id,
                Progress {
                    done: p.done,
                    total: p.total,
                },
            )
        })
        .collect())
}

/// An issue at the other end of a relationship, as the detail shows it.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Related {
    pub id: i64,
    /// `issue` or `pr`.
    pub kind: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    pub state_reason: Option<String>,
    /// In a repo that isn't synced: shown as "not synced", opening on GitHub.
    pub stub: bool,
    /// Who has it (the first assignee); `null` when nobody does.
    pub assignee: Option<String>,
    /// How many open issues block it.
    pub blocked_by: i64,
    /// Its own sub-issue progress, if it has sub-issues.
    pub progress: Option<Progress>,
    /// A PR's status; `null` for an issue.
    pub pr_status: Option<PrStatus>,
}

/// Everything an issue is related to.
#[derive(Serialize, TS, Default)]
#[ts(export)]
pub struct Relationships {
    pub parent: Option<Related>,
    /// In GitHub's order.
    pub sub_issues: Vec<Related>,
    pub blocked_by: Vec<Related>,
    pub blocking: Vec<Related>,
    pub relates_to: Vec<Related>,
}

/// One item's linked PRs: on a PR, the issues it closes; on an issue, the PRs that close it.
#[derive(Default)]
pub struct Linked {
    pub closes: Vec<Related>,
    pub linked_prs: Vec<Related>,
}

/// The relationships and the linked PRs of one item.
pub fn for_item(c: &Reader, id: i64) -> QueryResult<(Relationships, Linked)> {
    let rows = q::item_relationships(c, id)?;
    // Progress for the parent and each sub-issue, in one query.
    let tree: Vec<i64> = rows
        .iter()
        .filter(|r| r.rel == "parent" || r.rel == "sub")
        .map(|r| r.id)
        .collect();
    let mut progress = progress(c, &tree)?;
    let mut out = Relationships::default();
    let mut linked = Linked::default();
    for r in rows {
        let pr_status = (r.kind == "pr").then(|| PrStatus::of(&r.state, r.draft, r.merged_at));
        let related = Related {
            id: r.id,
            kind: r.kind,
            owner: r.owner,
            repo: r.repo,
            number: r.number,
            title: r.title,
            state: r.state,
            state_reason: r.state_reason,
            stub: r.is_stub || !r.synced,
            assignee: r.assignee,
            blocked_by: r.open_blockers,
            progress: progress.remove(&r.id),
            pr_status,
        };
        match r.rel.as_str() {
            "parent" => out.parent = Some(related),
            "sub" => out.sub_issues.push(related),
            "blocked_by" => out.blocked_by.push(related),
            "blocking" => out.blocking.push(related),
            "closes" => linked.closes.push(related),
            "linked_pr" => linked.linked_prs.push(related),
            _ => out.relates_to.push(related),
        }
    }
    Ok((out, linked))
}
