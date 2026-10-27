//! Relationship changes in an outside edit: sub-issues, dependencies and relates-to, with
//! GitHub's rules and the webhooks GitHub sends for them (measured, docs/research/
//! webhook-delivery.md):
//!
//! - A sub-issue or dependency change sends two deliveries, one for each side, each to its own
//!   issue's repo: `sub_issue_*` (the parent's side) and `parent_issue_*` (the child's), or
//!   `blocked_by_*` (the blocked issue's side) and `blocking_*` (the blocker's).
//! - A same-repo relates-to change sends one delivery carrying both issues; a cross-repo one
//!   sends one per repo.
//! - Across repos, each delivery carries only its own repo's issue: the other end, its id and
//!   its repository are left out.
//! - A repo the App isn't installed on gets no deliveries.
//!
//! Refused as GitHub refuses them (422s, or a 404 for a sub-issue that isn't attached): a relationship
//! of an issue to itself, a duplicate, a second parent, a loop, nesting past 8 levels, a 101st sub-issue and a
//! 51st dependency of either kind. Removing a dependency or a relates-to relationship that isn't there
//! succeeds and sends nothing.

use crate::webhooks::{Delivery, envelope, issue_json};
use fake_db::q;
use rusqlite::Connection;
use serde_json::{Value, json};

/// GitHub's limits (docs/research/github-relationship-apis.md).
const MAX_CHILDREN: i64 = 100;
const MAX_LEVELS: i64 = 8;
const MAX_DEPENDENCIES: i64 = 50;

/// What an edit asks of the edited issue's relationships. Each names the other issue as
/// `repo#n`, `owner/repo#n` or `#n` (in the edited issue's repo); the repo may be one the App
/// isn't installed on.
#[derive(serde::Deserialize, Default)]
pub(crate) struct Asks {
    add_sub_issue: Option<String>,
    remove_sub_issue: Option<String>,
    add_blocked_by: Option<String>,
    remove_blocked_by: Option<String>,
    add_relates_to: Option<String>,
    remove_relates_to: Option<String>,
    /// Moves this sub-issue of the edited issue before its siblings, as GitHub's
    /// "reprioritize sub-issue" does. GitHub sends nothing for it: no webhook, no feed event
    /// (measured, spec #86: silent reorders).
    prioritize_sub_issue: Option<String>,
}

/// The sub-issue `asks` moves to the top of issue `id`'s, if any; why not, if GitHub would refuse.
pub(crate) fn plan_reorder(
    c: &Connection,
    id: i64,
    repo: i64,
    asks: &Asks,
) -> rusqlite::Result<Result<Option<i64>, String>> {
    let Some(target) = &asks.prioritize_sub_issue else {
        return Ok(Ok(None));
    };
    let child = match find_issue(c, target, repo)? {
        Ok(child) => child,
        Err(why) => return Ok(Err(why)),
    };
    if q::parent_of(c, child)? != Some(id) {
        return Ok(Err(
            "Not Found: that issue isn't a sub-issue of this one".into()
        ));
    }
    Ok(Ok(Some(child)))
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Sub,
    Blocks,
    Relates,
}

/// One checked change: the edge `src → dst` of `kind`, added or removed, from the edit of
/// issue `from`.
pub(crate) struct Change {
    from: i64,
    kind: Kind,
    add: bool,
    src: i64,
    dst: i64,
}

/// The changes `asks` makes to issue `id` (in `repo`), checked against GitHub's rules before
/// anything is written; why not, if GitHub would refuse one.
pub(crate) fn plan(
    c: &Connection,
    id: i64,
    repo: i64,
    asks: &Asks,
) -> rusqlite::Result<Result<Vec<Change>, String>> {
    let mut out = Vec::new();
    let pairs = [
        (&asks.add_sub_issue, Kind::Sub, true),
        (&asks.remove_sub_issue, Kind::Sub, false),
        (&asks.add_blocked_by, Kind::Blocks, true),
        (&asks.remove_blocked_by, Kind::Blocks, false),
        (&asks.add_relates_to, Kind::Relates, true),
        (&asks.remove_relates_to, Kind::Relates, false),
    ];
    for (target, kind, add) in pairs {
        let Some(target) = target else { continue };
        let other = match find_issue(c, target, repo)? {
            Ok(other) => other,
            Err(why) => return Ok(Err(why)),
        };
        if other == id {
            return Ok(Err(
                "Target issue cannot be the same as the source issue".into()
            ));
        }
        let (src, dst) = match kind {
            // The edited issue is the parent.
            Kind::Sub => (id, other),
            // The edited issue is blocked by the other.
            Kind::Blocks => (other, id),
            Kind::Relates => (id.min(other), id.max(other)),
        };
        if let Err(why) = check(c, kind, add, src, dst)? {
            return Ok(Err(why));
        }
        out.push(Change {
            from: id,
            kind,
            add,
            src,
            dst,
        });
    }
    Ok(Ok(out))
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Sub => "sub",
        Kind::Blocks => "blocks",
        Kind::Relates => "relates",
    }
}

/// GitHub's refusals for one change.
fn check(
    c: &Connection,
    kind: Kind,
    add: bool,
    src: i64,
    dst: i64,
) -> rusqlite::Result<Result<(), String>> {
    let exists = q::has_edge(c, kind_name(kind), src, dst)?;
    let refuse = |why: &str| Ok(Err(why.to_owned()));
    if !add {
        // Removing a sub-issue that isn't attached is GitHub's 404; the others are idempotent.
        if kind == Kind::Sub && !exists {
            return refuse("Not Found: that issue isn't a sub-issue of this one");
        }
        return Ok(Ok(()));
    }
    match kind {
        Kind::Sub => {
            if q::parent_of(c, dst)?.is_some() {
                return refuse("Sub issue may only have one parent");
            }
            let ancestry = q::ancestry(c, src)?;
            if ancestry.iter().any(|a| a.id == dst) {
                return refuse("Sub issue may not create a circular dependency");
            }
            let levels = ancestry.last().map_or(1, |a| a.level) + q::subtree_height(c, dst)?;
            if levels > MAX_LEVELS {
                return refuse("Sub issues may only be nested 8 levels deep");
            }
            if q::child_count(c, src)? >= MAX_CHILDREN {
                return refuse("Parent issue may only have 100 sub issues");
            }
        }
        Kind::Blocks => {
            if exists {
                return refuse("Target issue has already been taken");
            }
            if q::blocks_transitively(c, dst, src)? {
                return refuse(
                    "This relationship would create a cycle where the target is already blocked by the source",
                );
            }
            let n = q::dependency_counts(c, dst, src)?;
            if n.blocked_by >= MAX_DEPENDENCIES || n.blocking >= MAX_DEPENDENCIES {
                return refuse(
                    "An issue can be linked to at most 50 issues of each dependency type",
                );
            }
        }
        Kind::Relates => {
            if exists {
                return refuse("The relationship already exists");
            }
        }
    }
    Ok(Ok(()))
}

/// `repo#n`, `owner/repo#n` or `#n` (in `default_repo`): the issue's id, or why there's none.
fn find_issue(
    c: &Connection,
    target: &str,
    default_repo: i64,
) -> rusqlite::Result<Result<i64, String>> {
    let Some((repo, number)) = target.rsplit_once('#') else {
        return Ok(Err(format!("{target} isn't repo#n")));
    };
    let Ok(number) = number.parse::<i64>() else {
        return Ok(Err(format!("{target} isn't repo#n")));
    };
    let repo = if repo.is_empty() {
        Some(default_repo)
    } else {
        match repo.split_once('/') {
            Some((owner, name)) => q::any_repo_by_full_name(c, owner, name)?,
            None => {
                let mut all = q::any_repos_by_name(c, repo)?;
                if all.len() > 1 {
                    return Ok(Err(format!("{repo} is ambiguous; name the owner")));
                }
                all.pop()
            }
        }
    };
    let Some(repo) = repo else {
        return Ok(Err(format!("no repo for {target}")));
    };
    Ok(q::any_issue_id(c, repo, number)?.ok_or_else(|| format!("no issue {target}")))
}

/// Writes the changes and returns their deliveries, in the order GitHub sends them.
pub(crate) fn apply(
    tx: &Connection,
    changes: &[Change],
    sender: &Value,
) -> rusqlite::Result<Vec<Delivery>> {
    let mut out = Vec::new();
    for ch in changes {
        let kind = kind_name(ch.kind);
        if ch.add {
            q::add_edge(tx, kind, ch.src, ch.dst)?;
        } else if q::remove_edge(tx, kind, ch.src, ch.dst)? == 0 {
            // Nothing to remove: GitHub answers 200 and sends nothing.
            continue;
        }
        out.extend(deliveries(tx, ch, sender)?);
    }
    Ok(out)
}

/// One side of a change: the issue, its repo and the delivery's action.
struct Side {
    issue: i64,
    repo: q::RepoRow,
}

fn side(c: &Connection, issue: i64) -> rusqlite::Result<Side> {
    let repo_id = q::issue(c, issue)?.repo_id;
    Ok(Side {
        issue,
        repo: q::repo(c, repo_id)?,
    })
}

/// The deliveries for one change, as GitHub sends them.
fn deliveries(c: &Connection, ch: &Change, sender: &Value) -> rusqlite::Result<Vec<Delivery>> {
    let (a, b) = (side(c, ch.src)?, side(c, ch.dst)?);
    let same_repo = a.repo.id == b.repo.id;
    let verb = if ch.add { "added" } else { "removed" };
    // A delivery to `to`'s repo, with `fields` besides the envelope; none if the App isn't
    // installed there.
    let to = |s: &Side, event: &'static str, action: String, fields: Value| {
        s.repo.installation_id?;
        let mut p = envelope(&s.repo, sender);
        p["action"] = json!(action);
        if let Value::Object(fields) = fields {
            for (k, v) in fields {
                p[k] = v;
            }
        }
        Some(Delivery::new(event, p))
    };
    let (ia, ib) = (issue_json(c, a.issue)?, issue_json(c, b.issue)?);
    let out = match ch.kind {
        Kind::Sub => {
            // The parent is `a`, the child `b`.
            let both = json!({
                "parent_issue_id": a.issue, "parent_issue": ia,
                "sub_issue_id": b.issue, "sub_issue": ib,
            });
            let (parent_side, child_side) = if same_repo {
                (both.clone(), both)
            } else {
                (
                    json!({ "parent_issue_id": a.issue, "parent_issue": ia }),
                    json!({ "sub_issue_id": b.issue, "sub_issue": ib }),
                )
            };
            vec![
                to(&a, "sub_issues", format!("sub_issue_{verb}"), parent_side),
                to(&b, "sub_issues", format!("parent_issue_{verb}"), child_side),
            ]
        }
        Kind::Blocks => {
            // The blocker is `a`, the blocked issue `b`.
            let (blocked_side, blocker_side) = if same_repo {
                let both = json!({
                    "blocked_issue_id": b.issue, "blocked_issue": ib,
                    "blocking_issue_id": a.issue, "blocking_issue": ia,
                });
                let mut blocked = both.clone();
                blocked["blocking_issue_repo"] = crate::webhooks::repo_json(&a.repo);
                let mut blocker = both;
                blocker["blocked_issue_repo"] = crate::webhooks::repo_json(&b.repo);
                (blocked, blocker)
            } else {
                (
                    json!({ "blocked_issue_id": b.issue, "blocked_issue": ib }),
                    json!({ "blocking_issue_id": a.issue, "blocking_issue": ia }),
                )
            };
            vec![
                to(
                    &b,
                    "issue_dependencies",
                    format!("blocked_by_{verb}"),
                    blocked_side,
                ),
                to(
                    &a,
                    "issue_dependencies",
                    format!("blocking_{verb}"),
                    blocker_side,
                ),
            ]
        }
        Kind::Relates => {
            let action = format!("relates_to_{verb}");
            if same_repo {
                // `issue` is the side the change was made from.
                let (mine, theirs) = if ch.from == a.issue {
                    ((a.issue, &ia), (b.issue, &ib))
                } else {
                    ((b.issue, &ib), (a.issue, &ia))
                };
                vec![to(
                    &a,
                    "issue_relates_to",
                    action,
                    json!({
                        "issue_id": mine.0, "issue": mine.1,
                        "related_issue_id": theirs.0, "related_issue": theirs.1,
                    }),
                )]
            } else {
                vec![
                    to(
                        &a,
                        "issue_relates_to",
                        action.clone(),
                        json!({ "issue_id": a.issue, "issue": ia }),
                    ),
                    to(
                        &b,
                        "issue_relates_to",
                        action,
                        json!({ "issue_id": b.issue, "issue": ib }),
                    ),
                ]
            }
        }
    };
    Ok(out.into_iter().flatten().collect())
}
