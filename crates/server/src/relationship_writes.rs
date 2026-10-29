//! Relationship writes: the ops that add and remove relationships between issues (`sub_add`,
//! `sub_remove`, `sub_reorder`, `block_add`, `block_remove`, `relate_add`, `relate_remove`), made
//! through `POST /api/ops` (`ops.rs` queues them and runs them here), and the picker that offers
//! what to relate (`GET /api/issues/{id}/relatable`).
//!
//! Each op is GitHub's REST call on one end (docs/research/github-relationship-apis.md): a
//! sub-issue's on its parent, a dependency's on the blocked issue, a relates-to on the op's
//! issue. The other end is named by its id when the tab has one, and always by its place
//! (`owner/repo#n`): an issue in a repo beghu doesn't sync is read from GitHub with the user's
//! token, and becomes a stub once linked.
//!
//! - What GitHub would refuse is refused first, from the mirror, with a reason and no call: a
//!   link to itself, one that's there already, a loop of sub-issues, a direct loop of dependencies
//!   (one through other issues is GitHub's to refuse), nesting past 8 levels (counting the top
//!   issue: an assumption, see the research notes), a 101st sub-issue, a 51st dependency of
//!   either kind, and a second parent unless the op moves the sub-issue (`replace_parent`). The picker lists the same refusals
//!   beside each issue it offers. (The mirror may not know a stub's own relationships: GitHub refuses
//!   what it can't see, as a 422.)
//! - An add GitHub answers 422 "already exists" (or "already been taken", or a second parent that
//!   is this one) is done: the link is there, as asked. A removal is done whether or not the link
//!   was there: GitHub answers a dependency's or a relates-to's 200 either way, and a sub-issue's
//!   404, which is told from an issue out of sight by reading the parent.
//! - A move to another parent is an add with `replace_parent`, then a reorder (`after_id`) unless
//!   it lands last. A reorder sends `after_id`, or `before_id` of the first sibling to go to the
//!   top; one that leaves the order as it is makes no call.
//! - GitHub's answer to a relationship write is an issue, not the link, so there's nothing to
//!   compare field by field: a 2xx is the link as asked. The link is written to the mirror (both
//!   ends pushed), and the deliveries GitHub sends for it find it in place.
//! - A sub-issue's new place takes the midpoint of its neighbours' positions; the next read-back
//!   of the parent's sub-issues numbers them 1..n in GitHub's order.

use crate::App;
use crate::auth::Session;
use crate::edges::{self, Edge, Kind};
use crate::error::ApiError;
use crate::github::{self, RepoInfo, Shown};
use crate::live::Push;
use crate::markdown::Refs;
use crate::ops::{self, Failure, IssueRepo, Op, OpReply, Outcome, Sending, Unapplied};
use crate::tokens;
use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use mirror_db::{Caller, QueryResult, q};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use ts_rs::TS;

/// GitHub's limits (docs/research/github-relationship-apis.md).
const MAX_LEVELS: i64 = 8;
const MAX_CHILDREN: i64 = 100;
const MAX_DEPENDENCIES: i64 = 50;
/// How many issues a picker offers for title words.
const MAX_MATCHES: i64 = 30;

/// The other end of a relationship op: its id when the tab knows it (an issue in the mirror, or
/// one the picker read from GitHub), and its place on GitHub, which names it otherwise (with an
/// id, the place is only how the tab shows it).
#[derive(Deserialize, Serialize, TS, Clone, PartialEq, Debug)]
#[ts(export)]
pub struct RelatedEnd {
    pub id: Option<i64>,
    pub owner: String,
    pub repo: String,
    pub number: i64,
}

/// What a picker links the open issue as.
#[derive(Deserialize, Serialize, TS, Clone, Copy, PartialEq, Debug)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    /// Its parent: it becomes the picked issue's sub-issue, moving from any other parent.
    Parent,
    /// A sub-issue: the picked issue becomes its sub-issue.
    Sub,
    /// It's blocked by the picked issue.
    BlockedBy,
    /// It blocks the picked issue.
    Blocking,
    Relates,
}

/// Why GitHub would refuse to link `this` to `other` as `kind`, from what the mirror holds: the
/// reason, in words for the user, or none. `moving`: a sub-issue add that moves the sub-issue
/// from its parent (`replace_parent`), so its having one isn't a refusal.
pub(crate) fn refusal(
    c: &Connection,
    kind: RelationshipKind,
    this: i64,
    other: i64,
    moving: bool,
) -> QueryResult<Option<String>> {
    if this == other {
        return Ok(Some("An issue can't be linked to itself".into()));
    }
    let refuse = |why: &str| Ok(Some(why.to_owned()));
    match kind {
        RelationshipKind::Parent | RelationshipKind::Sub => {
            let (parent, child) = if kind == RelationshipKind::Parent {
                (other, this)
            } else {
                (this, other)
            };
            if q::has_relationship(c, "sub", parent, child)? {
                return refuse(if kind == RelationshipKind::Parent {
                    "Already its parent"
                } else {
                    "Already a sub-issue"
                });
            }
            if !moving && let Some(p) = q::parent_of(c, child)? {
                return Ok(Some(format!(
                    "Already a sub-issue of {}#{}",
                    p.repo, p.number
                )));
            }
            let ancestry = q::ancestry(c, parent)?;
            if ancestry.iter().any(|a| a.id == child) {
                return refuse("That would make a loop of sub-issues");
            }
            // Issues from the top one down to the deepest under the child, each counted once: 8 at
            // most (the top issue and 7 levels under it; whether GitHub's "eight levels" counts
            // the top one is unmeasured).
            let levels = ancestry.last().map_or(1, |a| a.level) + q::subtree_height(c, child)?;
            if levels > MAX_LEVELS {
                return refuse("Sub-issues nest at most 8 levels deep");
            }
            if q::relationship_counts(c, 0, 0, parent)?.children >= MAX_CHILDREN {
                return refuse("An issue can have at most 100 sub-issues");
            }
        }
        RelationshipKind::BlockedBy | RelationshipKind::Blocking => {
            let (blocker, blocked) = if kind == RelationshipKind::BlockedBy {
                (other, this)
            } else {
                (this, other)
            };
            if q::has_relationship(c, "blocks", blocker, blocked)? {
                return refuse("Already linked");
            }
            // Only a direct loop: whether GitHub refuses one through other issues is unmeasured,
            // so that's left to its 422 (docs/research/github-relationship-apis.md).
            if q::has_relationship(c, "blocks", blocked, blocker)? {
                return refuse("That would make a loop of dependencies");
            }
            let n = q::relationship_counts(c, blocked, blocker, 0)?;
            if n.blocked_by >= MAX_DEPENDENCIES || n.blocking >= MAX_DEPENDENCIES {
                return refuse("An issue can be blocked by, or block, at most 50 issues");
            }
        }
        RelationshipKind::Relates => {
            if q::has_relationship(c, "relates", this.min(other), this.max(other))? {
                return refuse("Already linked");
            }
        }
    }
    Ok(None)
}

/// One end of a link as a write needs it: its id and place, its repo's id, and, for an issue the
/// mirror doesn't hold, what a stub of it needs.
#[derive(Clone, Debug)]
struct Side {
    id: i64,
    owner: String,
    repo: String,
    number: i64,
    repo_id: i64,
    /// In a synced repo: the App is installed on it, so the user's token can write to it.
    synced: bool,
    stub: Option<NewStub>,
}

impl Side {
    fn of(t: &q::OpTargetRow) -> Side {
        Side {
            id: t.id,
            owner: t.owner.clone(),
            repo: t.repo.clone(),
            number: t.number,
            repo_id: t.repo_id,
            synced: t.synced && !t.is_stub,
            stub: None,
        }
    }

    /// `web#12`, as the user knows it.
    fn named(&self) -> String {
        format!("{}#{}", self.repo, self.number)
    }

    fn path(&self) -> String {
        format!("/repos/{}/{}/issues/{}", self.owner, self.repo, self.number)
    }

    /// Its repo, for a refusal's reason.
    fn repo_of(&self) -> IssueRepo {
        IssueRepo {
            repo_id: self.repo_id,
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            own: false,
        }
    }
}

/// An issue GitHub showed the user that the mirror doesn't hold: a stub, once linked.
#[derive(Clone, Debug)]
struct NewStub {
    node_id: String,
    title: String,
    state: String,
    repo: RepoInfo,
}

/// What a failed read of GitHub with the user's token is, as a write's failure.
fn read_failure(e: tokens::Error) -> Failure {
    match e {
        tokens::Error::SignInAgain => Failure::SignedOut,
        tokens::Error::Restarting => Failure::Restarting,
        tokens::Error::GitHub(github::Error::RateLimited(w)) => Failure::RateLimited(w),
        tokens::Error::GitHub(github::Error::Unauthorized) => Failure::SignedOut,
        tokens::Error::GitHub(
            github::Error::Network(_) | github::Error::Unsent(_) | github::Error::Status(500..=599),
        ) => Failure::GitHubDown("GitHub didn't answer; try again".into()),
        e => Failure::Internal(e.to_string()),
    }
}

/// `end` as GitHub shows it to the user, for an issue the mirror doesn't hold: why not, if it
/// isn't an issue the user can see.
async fn fetch(app: &App, account: i64, end: &RelatedEnd) -> Result<Side, Failure> {
    let named = format!("{}/{}#{}", end.owner, end.repo, end.number);
    let unseen = || Failure::Invalid(format!("{named} isn't an issue you can see on GitHub"));
    let gh = app.github().clone();
    let (owner, repo, number) = (end.owner.clone(), end.repo.clone(), end.number);
    let read = app
        .tokens()
        .with_token(account, |token| {
            let (gh, owner, repo) = (gh.clone(), owner.clone(), repo.clone());
            async move {
                let issue = match gh.issue(&token, &owner, &repo, number).await? {
                    Shown::It(i) => i,
                    _ => return Ok(None),
                };
                Ok(gh
                    .repo_info(&token, &owner, &repo)
                    .await?
                    .map(|r| (issue, r)))
            }
        })
        .await;
    let (issue, repo) = match read {
        Ok(Some(found)) => found,
        Ok(None) | Err(tokens::Error::GitHub(github::Error::Status(403 | 404 | 410))) => {
            return Err(unseen());
        }
        Err(e) => return Err(read_failure(e)),
    };
    if issue.is_pr() {
        return Err(Failure::Invalid(format!(
            "{named} is a pull request: only issues link"
        )));
    }
    if end.id.is_some_and(|id| id != issue.id()) {
        return Err(Failure::Gone);
    }
    Ok(Side {
        id: issue.id(),
        owner: repo.owner.clone(),
        repo: repo.name.clone(),
        number: issue.number(),
        repo_id: repo.id,
        synced: false,
        stub: Some(NewStub {
            node_id: issue.node_id().to_owned(),
            title: issue.title().to_owned(),
            state: if issue.state.eq_ignore_ascii_case("open") {
                "open".into()
            } else {
                "closed".into()
            },
            repo,
        }),
    })
}

/// The other end of a relationship: the mirror's item if it holds it (a stub included), else
/// GitHub's.
async fn resolve(app: &App, account: i64, end: &RelatedEnd) -> Result<Side, Failure> {
    let e = end.clone();
    let held = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let id = match e.id {
                Some(id) => Some(id),
                None => q::item_at(c, &e.owner, &e.repo, e.number)?.map(|i| i.id),
            };
            Ok(match id {
                Some(id) => q::op_target(c, id)?,
                None => None,
            })
        })
        .await
        .map_err(Failure::from)?;
    match held {
        Some(t) if t.kind != "issue" => Err(Failure::Invalid(format!(
            "{}#{} is a pull request: only issues link",
            t.repo, t.number
        ))),
        Some(t) => Ok(Side::of(&t)),
        None if !name_ok(&end.owner) || !name_ok(&end.repo) => Err(Failure::Invalid(format!(
            "{}/{} isn't a repo's name on GitHub",
            end.owner, end.repo
        ))),
        None => fetch(app, account, end).await,
    }
}

/// Refuses a relationship write that would change an issue in a repo this server doesn't write
/// to (`BEGHU_DEV_WRITABLE_REPOS`): either end, and a moved sub-issue's old parent, which loses
/// it.
async fn writes_to_every_end(app: &App, account: i64, plan: &Plan) -> Result<(), Failure> {
    let mut ends: Vec<(String, String)> = Vec::new();
    let mut side = |s: &Side| ends.push((s.owner.clone(), s.repo.clone()));
    match plan {
        Plan::Sub {
            parent,
            child,
            replace,
            ..
        } => {
            side(parent);
            side(child);
            if *replace {
                let child = child.id;
                let old = app
                    .mirrors()
                    .read(account, Caller::Request, move |c| {
                        Ok(match q::parent_of(c, child)? {
                            Some(p) => q::op_target(c, p.id)?,
                            None => None,
                        })
                    })
                    .await
                    .map_err(Failure::from)?;
                if let Some(o) = old {
                    ends.push((o.owner, o.repo));
                }
            }
        }
        Plan::Reorder { parent, .. } => side(parent),
        Plan::Blocks {
            blocker, blocked, ..
        } => {
            side(blocker);
            side(blocked);
        }
        Plan::Relates { this, other, .. } => {
            side(this);
            side(other);
        }
    }
    for (owner, repo) in &ends {
        ops::read_only_here(app, owner, repo)?;
    }
    Ok(())
}

/// What a relationship op does, with both ends resolved.
enum Plan {
    Sub {
        parent: Side,
        child: Side,
        add: bool,
        replace: bool,
        /// After the add: where it goes, unless last.
        then_after: Option<i64>,
    },
    Reorder {
        parent: Side,
        child: i64,
        /// The call's body: `after_id` or `before_id`; none when the order is as asked.
        body: Option<Value>,
        after: Option<i64>,
    },
    Blocks {
        blocker: Side,
        blocked: Side,
        add: bool,
    },
    Relates {
        this: Side,
        other: Side,
        add: bool,
    },
}

/// Makes relationship op `op`: refused from the mirror, or GitHub's call (and a reorder after a
/// move), then the mirror and the push.
pub(crate) async fn run(app: &App, account: i64, op: &Op, sending: &Sending) -> Outcome {
    let Some(issue) = op.issue() else {
        return Err(Failure::Internal(format!("{op:?} names no issue")));
    };
    let this = Side::of(&ops::writable(app, account, issue).await?);
    let plan = plan(app, account, op, this).await?;
    writes_to_every_end(app, account, &plan).await?;
    let (method, path, body) = match &plan {
        Plan::Sub {
            parent,
            child,
            add: true,
            replace,
            ..
        } => (
            reqwest::Method::POST,
            format!("{}/sub_issues", parent.path()),
            json!({ "sub_issue_id": child.id, "replace_parent": replace }),
        ),
        Plan::Sub { parent, child, .. } => (
            reqwest::Method::DELETE,
            format!("{}/sub_issue", parent.path()),
            json!({ "sub_issue_id": child.id }),
        ),
        Plan::Reorder { body: None, .. } => return Ok(reply(issue)),
        Plan::Reorder {
            parent,
            child,
            body: Some(body),
            ..
        } => {
            let mut body = body.clone();
            body["sub_issue_id"] = json!(child);
            (
                reqwest::Method::PATCH,
                format!("{}/sub_issues/priority", parent.path()),
                body,
            )
        }
        Plan::Blocks {
            blocker,
            blocked,
            add: true,
        } => (
            reqwest::Method::POST,
            format!("{}/dependencies/blocked_by", blocked.path()),
            json!({ "issue_id": blocker.id }),
        ),
        Plan::Blocks {
            blocker, blocked, ..
        } => (
            reqwest::Method::DELETE,
            format!("{}/dependencies/blocked_by/{}", blocked.path(), blocker.id),
            Value::Null,
        ),
        Plan::Relates {
            this,
            other,
            add: true,
        } => (
            reqwest::Method::POST,
            format!("{}/relates_to", this.path()),
            json!({ "issue_id": other.id }),
        ),
        Plan::Relates { this, other, .. } => (
            reqwest::Method::DELETE,
            format!("{}/relates_to/{}", this.path(), other.id),
            Value::Null,
        ),
    };
    // The repo whose issue the call is on: a refusal is worded from the account's role there.
    let at = match &plan {
        Plan::Sub { parent, .. } | Plan::Reorder { parent, .. } => parent,
        Plan::Blocks { blocked, .. } => blocked,
        Plan::Relates { this, .. } => this,
    };
    let (on, on_synced, on_named) = (at.repo_of(), at.synced, at.named());
    let add = matches!(
        plan,
        Plan::Sub { add: true, .. }
            | Plan::Blocks { add: true, .. }
            | Plan::Relates { add: true, .. }
    );
    match ops::call(app, account, op, method, &path, &body, sending).await {
        Ok(_) => {}
        // A repo the App isn't installed on: GitHub takes no write there with the user's token
        // (403), or doesn't show it (404). `plan` refuses what it knows to be such a write first.
        Err(Failure::Forbidden | Failure::Gone) if !on_synced => {
            return Err(Failure::Refused(not_synced(&on_named)));
        }
        Err(Failure::Forbidden) => {
            return Err(Failure::Refused(
                ops::refused_why(app, account, &on, op).await,
            ));
        }
        // There already, as asked.
        Err(Failure::Unprocessable(m)) if add && already(app, account, &plan, &m).await? => {}
        Err(Failure::Unprocessable(m)) => {
            return Err(Failure::Refused(format!("GitHub refused it: {m}")));
        }
        // A sub-issue that isn't one any more, if GitHub still shows the parent: gone already.
        // (GitHub answers the same 404 for a sub-issue the user can't see; removing that one is
        // then taken as done too. The mirror holds only what the user can see, so the tab can't
        // have named one it couldn't.)
        Err(Failure::Gone) if removes_sub(&plan, app, account).await => {}
        Err(e) => return Err(e),
    }
    store(app, account, &plan).await;
    if let Plan::Sub {
        parent,
        child,
        add: true,
        then_after: Some(after),
        ..
    } = &plan
    {
        // A move that doesn't land last: the reorder, as its own call. The move is made whatever
        // this comes to; a failed reorder comes back unapplied, to retry as a reorder.
        let body = json!({ "sub_issue_id": child.id, "after_id": after });
        let reorder = Op::SubReorder {
            issue: parent.id,
            child: child.id,
            after: Some(*after),
        };
        let placed = ops::call(
            app,
            account,
            &reorder,
            reqwest::Method::PATCH,
            &format!("{}/sub_issues/priority", parent.path()),
            &body,
            sending,
        )
        .await;
        if let Err(f) = placed {
            let why = match f {
                Failure::Forbidden => ops::refused_why(app, account, &on, &reorder).await,
                f => f.words(),
            };
            let mut r = reply(issue);
            r.unapplied.push(Unapplied {
                ops: vec![reorder],
                why,
            });
            return Ok(r);
        }
        store(
            app,
            account,
            &Plan::Reorder {
                parent: parent.clone(),
                child: child.id,
                body: None,
                after: Some(*after),
            },
        )
        .await;
    }
    Ok(reply(issue))
}

/// Whether `plan` removes a sub-issue from a parent GitHub still shows: its 404 is a sub-issue
/// that wasn't attached.
async fn removes_sub(plan: &Plan, app: &App, account: i64) -> bool {
    match plan {
        Plan::Sub {
            parent, add: false, ..
        } => shows(app, account, parent).await,
        _ => false,
    }
}

fn reply(issue: i64) -> OpReply {
    OpReply {
        issue,
        comment: None,
        body: None,
        refs: Refs::new(),
        unapplied: Vec::new(),
    }
}

/// Why a write on issue `named` can't be made: it's in a repo beghu doesn't sync, which the App
/// isn't installed on, so GitHub takes no write there with the user's token.
fn not_synced(named: &str) -> String {
    format!(
        "{named} isn't synced: only an issue beghu syncs can take this write; make it on GitHub"
    )
}

/// The op's ends and what it does, refused before any call if GitHub would refuse it.
async fn plan(app: &App, account: i64, op: &Op, this: Side) -> Result<Plan, Failure> {
    let (kind, add, moving) = match op {
        Op::SubAdd { replace_parent, .. } => (RelationshipKind::Sub, true, *replace_parent),
        Op::SubRemove { .. } | Op::SubReorder { .. } => (RelationshipKind::Sub, false, false),
        Op::BlockAdd { blocking, .. } | Op::BlockRemove { blocking, .. } => (
            if *blocking {
                RelationshipKind::Blocking
            } else {
                RelationshipKind::BlockedBy
            },
            matches!(op, Op::BlockAdd { .. }),
            false,
        ),
        Op::RelateAdd { .. } | Op::RelateRemove { .. } => (
            RelationshipKind::Relates,
            matches!(op, Op::RelateAdd { .. }),
            false,
        ),
        _ => {
            return Err(Failure::Internal(format!(
                "{op:?} isn't a relationship write"
            )));
        }
    };
    if let Op::SubReorder { child, after, .. } = op {
        return reorder(app, account, this, *child, *after).await;
    }
    let end = match op {
        Op::SubAdd { child, .. } | Op::SubRemove { child, .. } => child,
        Op::BlockAdd { other, .. }
        | Op::BlockRemove { other, .. }
        | Op::RelateAdd { other, .. }
        | Op::RelateRemove { other, .. } => other,
        _ => unreachable!("matched above"),
    };
    let other = resolve(app, account, end).await?;
    if other.id == this.id {
        return Err(Failure::Invalid(
            "An issue can't be linked to itself".into(),
        ));
    }
    // A dependency is GitHub's call on the blocked issue: one in a repo beghu doesn't sync takes
    // no write with the user's token.
    if kind == RelationshipKind::Blocking && !other.synced {
        return Err(Failure::Invalid(not_synced(&other.named())));
    }
    let after = match op {
        Op::SubAdd { after, .. } => *after,
        _ => None,
    };
    // A move to the parent it has already (one whose reorder failed, sent again): only the
    // reorder is left, after `after`, or last.
    if moving {
        let (parent, child) = (this.id, other.id);
        let (there, last) = app
            .mirrors()
            .read(account, Caller::Request, move |c| {
                let last = q::sub_positions(c, parent)?
                    .into_iter()
                    .map(|s| s.id)
                    .rfind(|&s| s != child);
                Ok((q::has_relationship(c, "sub", parent, child)?, last))
            })
            .await
            .map_err(Failure::from)?;
        if there {
            return reorder(app, account, this, child, after.or(last)).await;
        }
    }
    let (this_id, other_id, parent_id) = (this.id, other.id, this.id);
    // Refused as GitHub would, before any call; and where a move lands.
    let (why, then_after) = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let why = if add {
                refusal(c, kind, this_id, other_id, moving)?
            } else {
                None
            };
            let siblings: Vec<i64> = q::sub_positions(c, parent_id)?
                .into_iter()
                .map(|s| s.id)
                .filter(|&s| s != other_id)
                .collect();
            let then_after = match after {
                Some(a) if !siblings.contains(&a) => {
                    return Ok((
                        Some("That isn't one of its sub-issues any more".to_owned()),
                        None,
                    ));
                }
                // Last already.
                Some(a) if siblings.last() == Some(&a) => None,
                a => a,
            };
            Ok((why, then_after))
        })
        .await
        .map_err(Failure::from)?;
    if let Some(why) = why {
        return Err(Failure::Invalid(why));
    }
    Ok(match kind {
        RelationshipKind::Sub | RelationshipKind::Parent => Plan::Sub {
            parent: this,
            child: other,
            add,
            replace: moving,
            then_after,
        },
        RelationshipKind::BlockedBy => Plan::Blocks {
            blocker: other,
            blocked: this,
            add,
        },
        RelationshipKind::Blocking => Plan::Blocks {
            blocker: this,
            blocked: other,
            add,
        },
        RelationshipKind::Relates => Plan::Relates { this, other, add },
    })
}

/// A reorder of `parent`'s sub-issue `child` to after `after` (or the top): the call's body, or
/// none when it's there already.
async fn reorder(
    app: &App,
    account: i64,
    parent: Side,
    child: i64,
    after: Option<i64>,
) -> Result<Plan, Failure> {
    let id = parent.id;
    let order: Vec<i64> = app
        .mirrors()
        .read(account, Caller::Request, move |c| q::sub_positions(c, id))
        .await
        .map_err(Failure::from)?
        .into_iter()
        .map(|s| s.id)
        .collect();
    let Some(at) = order.iter().position(|&c| c == child) else {
        return Err(Failure::Invalid(
            "That isn't one of its sub-issues any more".into(),
        ));
    };
    let now = at.checked_sub(1).map(|i| order[i]);
    let others: Vec<i64> = order.iter().copied().filter(|&c| c != child).collect();
    if after.is_some_and(|a| !others.contains(&a)) {
        return Err(Failure::Invalid(
            "That isn't one of its sub-issues any more".into(),
        ));
    }
    let body = match (after, others.first()) {
        _ if now == after => None,
        (Some(a), _) => Some(json!({ "after_id": a })),
        (None, Some(first)) => Some(json!({ "before_id": first })),
        (None, None) => None,
    };
    Ok(Plan::Reorder {
        parent,
        child,
        body,
        after,
    })
}

/// Whether GitHub's 422 to an add says the link is there already: a duplicate, or a second
/// parent that is this parent (as the mirror has it).
async fn already(app: &App, account: i64, plan: &Plan, message: &str) -> Result<bool, Failure> {
    let m = message.to_ascii_lowercase();
    if m.contains("already exists") || m.contains("already been taken") {
        return Ok(true);
    }
    let Plan::Sub { parent, child, .. } = plan else {
        return Ok(false);
    };
    if !m.contains("only have one parent") {
        return Ok(false);
    }
    let (parent, child) = (parent.id, child.id);
    let there = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            q::has_relationship(c, "sub", parent, child)
        })
        .await
        .map_err(Failure::from)?;
    Ok(there)
}

/// Whether GitHub still shows issue `at` to the user: a sub-issue removal's 404 then means the
/// sub-issue wasn't attached, not that the parent is out of sight.
async fn shows(app: &App, account: i64, at: &Side) -> bool {
    let gh = app.github().clone();
    let (owner, repo, number) = (at.owner.clone(), at.repo.clone(), at.number);
    matches!(
        app.tokens()
            .with_token(account, |token| {
                let (gh, owner, repo) = (gh.clone(), owner.clone(), repo.clone());
                async move { gh.issue(&token, &owner, &repo, number).await }
            })
            .await,
        Ok(Shown::It(_))
    )
}

/// Writes what GitHub now has to the account's mirror (a stub for an end it didn't hold), and
/// pushes the items whose rows or detail show it. A failed write is logged, not failed: GitHub
/// has the change, and its webhooks bring it.
async fn store(app: &App, account: i64, plan: &Plan) {
    let change = match plan {
        Plan::Sub {
            parent, child, add, ..
        } => Some((Kind::Sub, parent.clone(), child.clone(), *add)),
        Plan::Blocks {
            blocker,
            blocked,
            add,
        } => Some((Kind::Blocks, blocker.clone(), blocked.clone(), *add)),
        Plan::Relates { this, other, add } => {
            let (a, b) = if this.id < other.id {
                (this.clone(), other.clone())
            } else {
                (other.clone(), this.clone())
            };
            Some((Kind::Relates, a, b, *add))
        }
        Plan::Reorder { .. } => None,
    };
    let reorder = match plan {
        Plan::Reorder {
            parent,
            child,
            after,
            ..
        } => Some((parent.id, *child, *after)),
        _ => None,
    };
    let wrote = app
        .mirrors()
        .write(account, Caller::Request, move |tx, seq| {
            let mut ids = Vec::new();
            if let Some((kind, src, dst, add)) = &change {
                for side in [src, dst] {
                    if let Some(s) = &side.stub {
                        let r = &s.repo;
                        q::upsert_stub_repo(tx, r.id, &r.node_id, &r.owner, &r.name, r.private)?;
                        q::upsert_stub(
                            tx,
                            side.id,
                            &s.node_id,
                            r.id,
                            side.number,
                            "issue",
                            &s.title,
                            &s.state,
                            seq,
                        )?;
                        q::set_stub_place(tx, side.id, r.id, side.number, seq)?;
                    }
                }
                ids = edges::apply_delivery(
                    tx,
                    seq,
                    &Edge {
                        kind: *kind,
                        src: src.id,
                        dst: dst.id,
                        add: *add,
                    },
                )?;
            }
            if let Some((parent, child, after)) = reorder
                && place(tx, seq, parent, child, after)?
            {
                q::touch_edges(tx, parent, seq)?;
                q::touch_edges(tx, child, seq)?;
                ids.extend([parent, child]);
                ids.sort_unstable();
                ids.dedup();
            }
            Ok(ids)
        })
        .await;
    match wrote {
        Ok(ids) if !ids.is_empty() => app.hub().publish(account, Push::Ids(Arc::from(ids))),
        Ok(_) => {}
        Err(e) => eprintln!(
            "relationship writes: account {account}: writing a relationship to the mirror: {e}"
        ),
    }
}

/// Puts sub-issue `child` of `parent` after `after`, or at the top: the midpoint of its new
/// neighbours' positions. Whether it moved.
fn place(
    tx: &rusqlite::Transaction,
    seq: i64,
    parent: i64,
    child: i64,
    after: Option<i64>,
) -> rusqlite::Result<bool> {
    let others: Vec<q::SubPositionsRow> = q::sub_positions(tx, parent)?
        .into_iter()
        .filter(|s| s.id != child)
        .collect();
    let position = match after {
        None => others.first().map_or(1.0, |f| f.position - 1.0),
        Some(a) => match others.iter().position(|s| s.id == a) {
            Some(i) => match others.get(i + 1) {
                Some(next) => (others[i].position + next.position) / 2.0,
                None => others[i].position + 1.0,
            },
            None => return Ok(false),
        },
    };
    Ok(q::set_position(tx, parent, child, position, seq)? > 0)
}

// --- the picker -------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RelatedQuery {
    kind: RelationshipKind,
    /// What the user typed: `#12`, `repo#12`, `owner/repo#12`, a GitHub URL, or title words.
    #[serde(default)]
    q: String,
}

/// One issue a relationship picker offers.
#[derive(Serialize, TS, Debug, PartialEq)]
#[ts(export)]
pub struct RelatedCandidate {
    /// `null` for an issue in a repo beghu doesn't sync that GitHub couldn't be asked about just
    /// now: linking it reads it then.
    pub id: Option<i64>,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    /// `null` when unknown, as `id`.
    pub title: Option<String>,
    /// `open` or `closed`; `null` when unknown.
    pub state: Option<String>,
    /// In a repo beghu doesn't sync: linked, it shows as a stub.
    pub stub: bool,
    /// Why it can't be linked so, in words for the user; `null` when it can.
    pub why_not: Option<String>,
}

/// What the user typed into a relationship picker.
#[derive(Debug, PartialEq)]
enum Asked {
    /// An issue by its place: `#12` (this repo), `repo#12`, `owner/repo#12`, or its URL.
    Place {
        owner: Option<String>,
        repo: Option<String>,
        number: i64,
    },
    Words(String),
}

/// Whether `s` can be an owner's or a repo's name on GitHub: letters, digits, `.`, `_` and `-`,
/// and not `.` or `..` (which a path to GitHub would read as a step up).
fn name_ok(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn asked(q: &str) -> Option<Asked> {
    let q = q.trim();
    if q.is_empty() {
        return None;
    }
    // https://github.com/owner/repo/issues/12 (or /pull/12, or with more after it).
    let url = q
        .strip_prefix("https://")
        .or_else(|| q.strip_prefix("http://"))
        .and_then(|rest| {
            rest.strip_prefix("github.com/")
                .or_else(|| rest.strip_prefix("www.github.com/"))
        });
    if let Some(rest) = url {
        let parts: Vec<&str> = rest.split(['/', '?', '#']).collect();
        if let [owner, repo, "issues" | "pull", n, ..] = parts.as_slice()
            && name_ok(owner)
            && name_ok(repo)
            && let Ok(number) = n.parse()
        {
            return Some(Asked::Place {
                owner: Some((*owner).to_owned()),
                repo: Some((*repo).to_owned()),
                number,
            });
        }
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !q.contains(char::is_whitespace)
        && let Some((place, n)) = q.rsplit_once('#')
        && digits(n)
        && let Ok(number) = n.parse()
    {
        let (owner, repo) = match place.split_once('/') {
            Some((o, r)) if name_ok(o) && name_ok(r) => (Some(o), Some(r)),
            None if place.is_empty() => (None, None),
            None if name_ok(place) => (None, Some(place)),
            _ => return Some(Asked::Words(q.to_owned())),
        };
        return Some(Asked::Place {
            owner: owner.map(str::to_owned),
            repo: repo.map(str::to_owned),
            number,
        });
    }
    if digits(q)
        && let Ok(number) = q.parse()
    {
        return Some(Asked::Place {
            owner: None,
            repo: None,
            number,
        });
    }
    Some(Asked::Words(q.to_owned()))
}

/// `GET /api/issues/{id}/relatable?kind=…&q=…`: what the user can link issue `id` to as `kind`,
/// for what they typed, issues in its own repo first. Each says why it can't be linked, if it
/// can't. An issue named by its place in a repo beghu doesn't sync is read from GitHub with the
/// user's token: offered as a stub, or not at all if GitHub shows no such issue.
pub async fn candidates(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
    Query(lq): Query<RelatedQuery>,
) -> Result<Json<Vec<RelatedCandidate>>, ApiError> {
    let id: i64 = raw.parse().map_err(|_| ApiError::Gone)?;
    let account = s.account;
    let this = app
        .mirrors()
        .read(account, Caller::Request, move |c| q::op_target(c, id))
        .await?
        .filter(|t| t.kind == "issue" && !t.is_stub && t.synced)
        .ok_or(ApiError::Gone)?;
    let Some(asked) = asked(&lq.q) else {
        return Ok(Json(Vec::new()));
    };
    let kind = lq.kind;
    // The parent picker moves the issue from any parent it has.
    let moving = kind == RelationshipKind::Parent;
    let (this_id, this_owner, this_repo, this_repo_id) =
        (this.id, this.owner.clone(), this.repo.clone(), this.repo_id);
    let found = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let mut out = Vec::new();
            let mut lookup = None;
            match asked {
                Asked::Place {
                    owner,
                    repo,
                    number,
                } => {
                    let repo = repo.unwrap_or_else(|| this_repo.clone());
                    let owner = match owner {
                        Some(o) => o,
                        None => q::owners_of_repo(c, &repo)?
                            .into_iter()
                            .next()
                            .map_or_else(|| this_owner.clone(), |r| r.owner),
                    };
                    match q::item_at(c, &owner, &repo, number)? {
                        Some(i) => out.push(RelatedCandidate {
                            id: Some(i.id),
                            owner: i.owner,
                            repo: i.repo,
                            number: i.number,
                            title: Some(i.title),
                            state: Some(i.state),
                            stub: i.is_stub || !i.synced,
                            why_not: (i.kind != "issue")
                                .then(|| "A pull request: only issues link".to_owned()),
                        }),
                        // A synced repo's issue the mirror doesn't hold isn't there (or is a PR).
                        None if q::owners_of_repo(c, &repo)?
                            .iter()
                            .any(|r| r.synced && r.owner.eq_ignore_ascii_case(&owner)) => {}
                        None => {
                            lookup = Some(RelatedEnd {
                                id: None,
                                owner,
                                repo,
                                number,
                            })
                        }
                    }
                }
                Asked::Words(text) => {
                    let words: Vec<mirror_db::list::Word> = text
                        .split_whitespace()
                        .map(|w| mirror_db::list::Word {
                            text: w.to_owned(),
                            phrase: false,
                            exclude: false,
                        })
                        .filter(|w| !w.text.replace('"', "").is_empty())
                        .collect();
                    if !words.is_empty() {
                        let fts: Vec<String> = words.iter().map(mirror_db::search::fts).collect();
                        let query = format!("{{title}} : ({})", fts.join(" AND "));
                        for i in q::relatable_matches(c, &query, this_repo_id, MAX_MATCHES)? {
                            out.push(RelatedCandidate {
                                id: Some(i.id),
                                owner: i.owner,
                                repo: i.repo,
                                number: i.number,
                                title: Some(i.title),
                                state: Some(i.state),
                                stub: false,
                                why_not: None,
                            });
                        }
                    }
                }
            }
            for cand in &mut out {
                if cand.why_not.is_none()
                    && let Some(other) = cand.id
                {
                    cand.why_not = refusal(c, kind, this_id, other, moving)?;
                }
            }
            Ok((out, lookup))
        })
        .await?;
    let (mut out, lookup) = found;
    if let Some(end) = lookup
        && let Some(c) = look_up(&app, account, end).await
    {
        out.push(c);
    }
    // A parent takes the write (its sub-issue list is GitHub's call on it), and so does an
    // issue this one would block (its blocked-by list): only a synced one.
    let synced_only = match kind {
        RelationshipKind::Parent => {
            Some("Not synced: only an issue beghu syncs can be made a parent here")
        }
        RelationshipKind::Blocking => {
            Some("Not synced: only an issue beghu syncs can be marked blocked here")
        }
        _ => None,
    };
    if let Some(why) = synced_only {
        for c in out.iter_mut().filter(|c| c.stub && c.why_not.is_none()) {
            c.why_not = Some(why.into());
        }
    }
    // Its own repo first, then by repo; within a repo as found (most recently updated first).
    out.sort_by_key(|c| {
        (
            !(c.owner.eq_ignore_ascii_case(&this.owner) && c.repo.eq_ignore_ascii_case(&this.repo)),
            c.owner.to_lowercase(),
            c.repo.to_lowercase(),
        )
    });
    Ok(Json(out))
}

/// An issue in a repo beghu doesn't sync, as GitHub shows it to the user: a stub candidate, or
/// none if GitHub shows no such issue. When GitHub can't be asked now, it's offered unread.
async fn look_up(app: &App, account: i64, end: RelatedEnd) -> Option<RelatedCandidate> {
    let unread = RelatedCandidate {
        id: None,
        owner: end.owner.clone(),
        repo: end.repo.clone(),
        number: end.number,
        title: None,
        state: None,
        stub: true,
        why_not: None,
    };
    if app.github().is_down() {
        return Some(unread);
    }
    match fetch(app, account, &end).await {
        Ok(side) => {
            let s = side.stub?;
            Some(RelatedCandidate {
                id: Some(side.id),
                owner: side.owner,
                repo: side.repo,
                number: side.number,
                title: Some(s.title),
                state: Some(s.state),
                stub: true,
                why_not: None,
            })
        }
        Err(Failure::Invalid(_)) | Err(Failure::Gone) => None,
        Err(_) => Some(unread),
    }
}
