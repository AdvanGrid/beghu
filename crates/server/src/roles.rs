//! The roles rule module: what a connected account may do on an issue, decided in one place from
//! what the mirror stores, and never from GitHub's `viewerCan*` fields. Its inputs are the
//! account's **role** on the issue's repo (re-read from GitHub every `repo_refresh_every` while the
//! account has a live session, and at once on any refusal: `repos.rs` and [`refused_why`]),
//! authorship, the repo's `archived` flag and the issue's `locked` flag; for a relationship, the
//! roles on both repos.
//!
//! The matrix, verified live (docs/research/saml-sso-and-read-only-access.md, section 1):
//!
//! - Read comments and opens issues (title and body only). On its own issues it also closes,
//!   reopens and edits the title and body. (GitHub's roles page says Read reopens only issues it
//!   closed itself; the matrix measured an own issue Read had closed. beghu offers Reopen on every
//!   own issue, and when GitHub refuses one someone else closed, says so: see [`refused_why`].) It never touches labels, assignees, the milestone or
//!   relationships, not even on its own issues.
//! - Triage adds labels, assignees, the milestone, closing and reopening on any issue, and
//!   relationships, which take Triage on both repos. It edits only its own issues' text.
//! - Write and up do everything.
//! - An archived repo is read-only for everyone, and takes no new issues.
//! - A locked issue takes comments only from Write and up.
//!
//! A role not read yet (`null` in the mirror) is GitHub's to judge: the rules offer everything,
//! and GitHub's answer decides.
//!
//! What it emits: per synced repo in `/api/me`, the allowed ops on the account's own issues and on
//! others' ([`RepoCan`]); per issue in the detail, the `can` set, the reason for each op left out,
//! and the role line ([`IssueCan`]); and the reason a write was refused, worded from the role as
//! GitHub has it now ([`refused_why`]). A `roles` push tells the account's tabs to read `/api/me`
//! and the open detail again whenever a re-read changed what's stored.

use crate::github::{Access, Role};
use crate::live::Push;
use crate::ops::Op;
use crate::{App, repos};
use mirror_db::{Caller, q};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use ts_rs::TS;

/// How long a refused write waits for the repo's role to be re-read, to say why in its terms.
const REREAD_WAIT: Duration = Duration::from_secs(2);

/// What an account may do, by op: the writes beghu offers, as the tab looks them up.
#[derive(Serialize, Deserialize, TS, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum Can {
    /// Add a comment.
    Comment,
    /// Close the issue.
    Close,
    /// Reopen the issue.
    Reopen,
    /// Add or remove labels.
    Labels,
    /// Assign or unassign.
    Assignees,
    /// Set or clear the milestone.
    Milestone,
    /// Edit the title or the body.
    Edit,
    /// Add, remove or reorder relationships: sub-issues, dependencies, relates to.
    Relationships,
    /// Open a new issue in the repo.
    Create,
}

/// Every op an issue can take, in the order the tables list them.
const ON_ISSUES: [Can; 8] = [
    Can::Comment,
    Can::Close,
    Can::Reopen,
    Can::Labels,
    Can::Assignees,
    Can::Milestone,
    Can::Edit,
    Can::Relationships,
];

impl Can {
    /// What a write is, to the rules.
    pub fn of(op: &Op) -> Can {
        match op {
            Op::Comment { .. } => Can::Comment,
            Op::Close { .. } => Can::Close,
            Op::Reopen { .. } => Can::Reopen,
            Op::LabelAdd { .. } | Op::LabelRemove { .. } => Can::Labels,
            Op::AssigneeAdd { .. } | Op::AssigneeRemove { .. } => Can::Assignees,
            Op::MilestoneSet { .. } => Can::Milestone,
            Op::TitleEdit { .. } | Op::BodyEdit { .. } => Can::Edit,
            Op::Create { .. } => Can::Create,
            Op::SubAdd { .. }
            | Op::SubRemove { .. }
            | Op::SubReorder { .. }
            | Op::BlockAdd { .. }
            | Op::BlockRemove { .. }
            | Op::RelateAdd { .. }
            | Op::RelateRemove { .. } => Can::Relationships,
        }
    }
}

/// A repo as the rules see it: its name as the user knows it (bare), the account's role on it
/// (`None`: not read yet, GitHub's to judge), and whether it's archived.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoAccess {
    pub name: String,
    pub role: Option<Role>,
    pub archived: bool,
}

impl RepoAccess {
    /// As the mirror stores it: a role this build doesn't know reads as not read yet.
    pub fn stored(name: &str, role: Option<&str>, archived: bool) -> RepoAccess {
        RepoAccess {
            name: name.to_owned(),
            role: role.and_then(Role::parse),
            archived,
        }
    }
}

/// A mirror row that names a repo, the account's role on it and its archived flag, as the rules
/// read it: `$name` is the field holding the repo's bare name.
macro_rules! stored_access {
    ($($row:ty => $name:ident),* $(,)?) => {
        $(impl From<&$row> for RepoAccess {
            fn from(r: &$row) -> RepoAccess {
                RepoAccess::stored(&r.$name, r.role.as_deref(), r.archived)
            }
        })*
    };
}

stored_access! {
    q::RepoAccessRow => name,
    q::RepoAccessNamedRow => name,
    q::SyncedReposRow => name,
    q::OpTargetRow => repo,
    q::ItemDetailRow => repo,
    q::CreateTargetRow => name,
}

/// An issue as the rules see it: whether the account opened it, and whether it's locked.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct IssueFacts {
    pub own: bool,
    pub locked: bool,
}

/// Why `repo`'s rules leave `can` out on an issue like `issue`, in words for the user; `None` when
/// they allow it. A relationship's other repo is [`relationship_why_not`]'s.
pub fn why_not(repo: &RepoAccess, issue: IssueFacts, can: Can) -> Option<String> {
    let name = &repo.name;
    if repo.archived {
        return Some(format!("{name} is archived, so it's read-only"));
    }
    let role = repo.role?;
    let has = || format!("you have {} on {name}", role.name());
    match can {
        Can::Create => None,
        Can::Comment => (issue.locked && role < Role::Write).then(|| {
            format!(
                "it's locked, and only Write and up comment on it; you have {} on {name}",
                role.name()
            )
        }),
        Can::Close | Can::Reopen => (!issue.own && role < Role::Triage)
            .then(|| format!("{}, which closes or reopens only issues you opened", has())),
        Can::Labels | Can::Assignees | Can::Milestone => (role < Role::Triage).then(has),
        Can::Edit => (!issue.own && role < Role::Write)
            .then(|| format!("{}, which edits only issues you opened", has())),
        Can::Relationships => (role < Role::Triage).then(|| format!("needs Triage on {name}")),
    }
}

/// Why a relationship between an issue in `this` and one in `other` can't be made or changed:
/// it takes Triage on both repos. `other` is `None` for a repo beghu knows no role on (one only
/// stubs point into): GitHub's to judge.
pub fn relationship_why_not(this: &RepoAccess, other: Option<&RepoAccess>) -> Option<String> {
    let facts = IssueFacts::default();
    why_not(this, facts, Can::Relationships)
        .or_else(|| other.and_then(|o| why_not(o, facts, Can::Relationships)))
}

/// What the account may do in a synced repo: on the issues it opened, and on everyone else's
/// (an issue that isn't locked), and why each op left out of either is. `create` is in both while
/// the repo takes new issues; a new issue is the account's own, so `own` says which of its fields
/// a new one may set, and `denied_own` why the rest can't be.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct RepoCan {
    pub own: Vec<Can>,
    pub others: Vec<Can>,
    /// Why each op left out of `own` is, in words for the user.
    pub denied_own: BTreeMap<Can, String>,
    /// Why each op left out of `others` is.
    pub denied_others: BTreeMap<Can, String>,
}

pub fn repo_can(repo: &RepoAccess) -> RepoCan {
    let table = |own: bool| {
        let facts = IssueFacts { own, locked: false };
        let mut allowed = Vec::new();
        let mut denied = BTreeMap::new();
        for c in ON_ISSUES.into_iter().chain([Can::Create]) {
            match why_not(repo, facts, c) {
                Some(why) => {
                    denied.insert(c, why);
                }
                None => allowed.push(c),
            }
        }
        (allowed, denied)
    };
    let ((own, denied_own), (others, denied_others)) = (table(true), table(false));
    RepoCan {
        own,
        others,
        denied_own,
        denied_others,
    }
}

/// [`relationship_why_not`] for an issue in repo `this` and one in repo `other`, as the mirror
/// stores their roles: the one check every relationship goes through, whether it's offered (the
/// detail, the pickers, the tree's drops) or made (`relationship_writes.rs`). A repo the mirror
/// holds no row for is GitHub's to judge.
pub(crate) fn relationship_refusal(
    c: &rusqlite::Connection,
    this: i64,
    other: Option<i64>,
) -> mirror_db::QueryResult<Option<String>> {
    let Some(mine) = q::repo_access(c, this)? else {
        return Ok(None);
    };
    let theirs = match other.filter(|&o| o != this) {
        Some(o) => q::repo_access(c, o)?,
        None => None,
    };
    Ok(relationship_why_not(
        &RepoAccess::from(&mine),
        theirs.as_ref().map(RepoAccess::from).as_ref(),
    ))
}

/// What the account may do on one issue (or PR): the ops it's offered, why each other one isn't,
/// and the role line by the status badge.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct IssueCan {
    pub can: Vec<Can>,
    /// Why each op the issue isn't offered is left out, in words for the user.
    pub denied: BTreeMap<Can, String>,
    /// What the account's role means here, in a few words ("Read on cli", "Archived repo ·
    /// read-only"); `null` when it allows everything.
    pub role_line: Option<String>,
}

/// The rules for one issue in `repo`. A PR takes no writes in beghu.
pub fn issue_can(repo: &RepoAccess, issue: IssueFacts, pr: bool) -> IssueCan {
    let mut can = Vec::new();
    let mut denied = BTreeMap::new();
    for c in ON_ISSUES {
        let why = if pr {
            Some("beghu doesn't write to pull requests; open it on GitHub".to_owned())
        } else {
            why_not(repo, issue, c)
        };
        match why {
            Some(why) => {
                denied.insert(c, why);
            }
            None => can.push(c),
        }
    }
    IssueCan {
        can,
        denied,
        role_line: role_line(repo),
    }
}

/// The role line: an archived repo says so; a role below Write says which, and where.
fn role_line(repo: &RepoAccess) -> Option<String> {
    if repo.archived {
        return Some("Archived repo · read-only".into());
    }
    match repo.role {
        Some(r) if r < Role::Write => Some(format!("{} on {}", r.name(), repo.name)),
        _ => None,
    }
}

/// The repo an op's issue is in, and the issue's facts, for wording a refusal.
#[derive(Clone, Debug)]
pub(crate) struct At {
    pub(crate) repo_id: i64,
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) issue: IssueFacts,
}

impl At {
    pub(crate) fn of(t: &q::OpTargetRow, account: i64) -> At {
        At {
            repo_id: t.repo_id,
            owner: t.owner.clone(),
            repo: t.repo.clone(),
            issue: IssueFacts {
                own: t.author_id == Some(account),
                locked: t.locked,
            },
        }
    }
}

/// What a re-read of one repo found.
enum Reread {
    /// The user can't see the repo any more.
    Gone,
    /// GitHub's answer has no `permissions`: the role is unknown.
    Unknown {
        archived: bool,
    },
    Seen(RepoAccess),
    /// GitHub couldn't be asked, or didn't answer within [`REREAD_WAIT`].
    Unsure,
}

/// Why GitHub refused `op`, or answered it without applying it, in terms of the account's role
/// on `at`'s repo (and for a relationship, on `other`'s too), re-read from GitHub at once and
/// stored for the next write, the next `/api/me` and the account's tabs (a `roles` push). Only
/// the wait for it is bounded (by [`REREAD_WAIT`]): a slower re-read is still stored when it
/// comes. Just the reason: the tab says what couldn't be done. The 403's own message is never
/// read: GitHub's is the same for a missing role and a missing App permission.
pub(crate) async fn refused_why(
    app: &App,
    account: i64,
    at: &At,
    other: Option<&At>,
    op: &Op,
) -> String {
    let can = Can::of(op);
    let mut sides = vec![at];
    if can == Can::Relationships
        && let Some(o) = other.filter(|o| o.repo_id != at.repo_id)
    {
        sides.push(o);
    }
    // Both re-reads under way at once, each waited on in turn.
    let started: Vec<_> = sides
        .iter()
        .map(|s| start_reread(app, account, s))
        .collect();
    let mut unsure = None;
    for (side, read) in sides.iter().zip(started) {
        let found = match tokio::time::timeout(REREAD_WAIT, read).await {
            Ok(Ok(Some(Ok(found)))) => found,
            Ok(Ok(Some(Err(e)))) => {
                eprintln!(
                    "roles: account {account}: re-reading the role on {}: {e}",
                    side.repo
                );
                Reread::Unsure
            }
            Ok(Err(e)) => {
                eprintln!(
                    "roles: account {account}: re-reading the role on {} panicked: {e}",
                    side.repo
                );
                Reread::Unsure
            }
            // The drain stopped it, or it's slower than the reply waits for.
            Ok(Ok(None)) | Err(_) => Reread::Unsure,
        };
        let facts = if can == Can::Relationships {
            IssueFacts::default()
        } else {
            side.issue
        };
        match found {
            Reread::Gone => return format!("you no longer have access to {}", side.repo),
            Reread::Seen(access) => {
                if let Some(why) = why_not(&access, facts, can) {
                    return why;
                }
                // Read reopens only an issue it closed itself (GitHub's roles page): one someone
                // else closed is refused though the rules offer it.
                if can == Can::Reopen && access.role == Some(Role::Read) {
                    return format!(
                        "you have Read on {}, which reopens only issues you closed yourself",
                        side.repo
                    );
                }
            }
            Reread::Unknown { archived: true } => {
                return format!("{} is archived, so it's read-only", side.repo);
            }
            Reread::Unknown { archived: false } | Reread::Unsure => {
                unsure.get_or_insert(side.repo.as_str());
            }
        }
    }
    match unsure {
        Some(repo) => format!("your role on {repo} may not allow it"),
        None => "GitHub didn't apply this change".into(),
    }
}

/// Re-reads the account's access to each of `repos` in the background, for a write the stored
/// role refused before any call: the role may have changed on GitHub since it was read. A change
/// is stored and pushed as `roles`, so the next attempt (and every tab) has it.
pub(crate) fn reread_later(app: &App, account: i64, repos: &[&At]) {
    for at in repos {
        drop(start_reread(app, account, at));
    }
}

/// Starts a re-read of the account's access to `at`'s repo in a task of its own, so the caller's
/// bounded wait never cuts it short.
fn start_reread(
    app: &App,
    account: i64,
    at: &At,
) -> tokio::task::JoinHandle<Option<Result<Reread, String>>> {
    let at = at.clone();
    app.spawn(move |app| async move { reread(&app, account, &at).await })
}

/// The account's access to `at`'s repo, from GitHub now. A known role is stored with the
/// archived flag, and a change pushes `roles` to the account's tabs. With no access, a full
/// re-read of its repos follows, to stop syncing the repo.
async fn reread(app: &App, account: i64, at: &At) -> Result<Reread, String> {
    let gh = app.github().clone();
    let access = app
        .tokens()
        .with_token(account, |token| {
            let gh = gh.clone();
            async move { gh.repo_access(&token, &at.owner, &at.repo).await }
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(match access {
        Access::None => {
            app.spawn(move |app| async move { repos::refresh_roles_now(&app, account).await });
            Reread::Gone
        }
        Access::Seen {
            role: None,
            archived,
        } => {
            // No role to store, but the archived flag still is.
            let id = at.repo_id;
            let changed = app
                .mirrors()
                .write(account, Caller::Request, move |tx, _| {
                    q::set_repo_archived(tx, id, archived)
                })
                .await
                .map_err(|e| e.to_string())?;
            if changed > 0 {
                app.hub().publish(account, Push::Roles);
            }
            Reread::Unknown { archived }
        }
        Access::Seen {
            role: Some(role),
            archived,
        } => {
            let id = at.repo_id;
            let changed = app
                .mirrors()
                .write(account, Caller::Request, move |tx, _| {
                    q::set_repo_access(tx, id, role.as_str(), archived)
                })
                .await
                .map_err(|e| e.to_string())?;
            if changed > 0 {
                app.hub().publish(account, Push::Roles);
            }
            Reread::Seen(RepoAccess {
                name: at.repo.clone(),
                role: Some(role),
                archived,
            })
        }
    })
}
