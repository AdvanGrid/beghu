//! The import's mirror writes: an issue or PR, a relationship or linked PR (and the stubs at its
//! ends), comments, all
//! under the webhook upserts' guards.

use super::paging::Repo;
use super::shapes::*;
use crate::App;
use crate::edges::Kind;
use crate::live::Push;
use crate::webhook::time;
use mirror_db::{Caller, q};
use rusqlite::Transaction;

/// Sends the ids a write changed to the account's tabs (a reset past the push's cap).
pub(crate) fn publish(app: &App, account: i64, mut ids: Vec<i64>) {
    ids.sort_unstable();
    ids.dedup();
    match ids.len() {
        0 => {}
        n if n > crate::webhook::MAX_IDS => app.hub().publish(account, Push::Reset),
        _ => app.hub().publish(account, Push::Ids(ids.into())),
    }
}

/// Whether the repo is still synced: an import page (or a webhook's write) for a repo unsynced
/// meanwhile is dropped.
pub(crate) fn synced(tx: &Transaction, repo: i64) -> rusqlite::Result<bool> {
    Ok(q::repo_state(tx, repo)?.is_some_and(|r| r.synced))
}

/// One mirror transaction writing `repo`'s rows with `f`, skipped (nothing written, `T`'s
/// default) if the repo is no longer synced. What `f` says it changed.
pub(crate) async fn write_synced<F, T>(
    app: &App,
    account: i64,
    caller: Caller,
    repo: i64,
    f: F,
) -> Result<T, mirror_db::Error>
where
    F: FnOnce(&Transaction, i64) -> rusqlite::Result<T> + Send + 'static,
    T: Default + Send + 'static,
{
    app.mirrors()
        .write(account, caller, move |tx, seq| {
            if !synced(tx, repo)? {
                return Ok(T::default());
            }
            f(tx, seq)
        })
        .await
}

// --- writes ------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct UserData {
    pub(crate) id: i64,
    pub(crate) login: String,
    pub(crate) avatar_url: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PrData {
    pub(crate) pr_id: i64,
    pub(crate) draft: bool,
    pub(crate) merged_at: Option<i64>,
    pub(crate) head_ref: Option<String>,
    pub(crate) base_ref: Option<String>,
    pub(crate) review_decision: Option<String>,
}

/// An issue or PR as the import writes it, from GraphQL or REST.
#[derive(Clone, Debug)]
pub(crate) struct ItemData {
    pub(crate) id: i64,
    pub(crate) node_id: String,
    pub(crate) number: i64,
    pub(crate) kind: &'static str,
    pub(crate) title: String,
    pub(crate) body: Option<String>,
    pub(crate) state: String,
    pub(crate) state_reason: Option<String>,
    pub(crate) locked: bool,
    pub(crate) author: Option<UserData>,
    pub(crate) milestone: Option<i64>,
    pub(crate) created: Option<i64>,
    pub(crate) updated: i64,
    pub(crate) closed: Option<i64>,
    pub(crate) comments: i64,
    pub(crate) issue_type: Option<String>,
    pub(crate) labels: Vec<String>,
    pub(crate) assignees: Vec<UserData>,
    pub(crate) pr: Option<PrData>,
}

impl ItemData {
    pub(crate) fn from_graphql(i: &GqlIssue) -> ItemData {
        ItemData {
            id: i.database_id,
            node_id: i.id.clone(),
            number: i.number,
            kind: "issue",
            title: i.title.clone(),
            body: i.body.clone(),
            state: i.state.to_lowercase(),
            state_reason: i.state_reason.as_deref().map(str::to_lowercase),
            locked: i.locked,
            author: i.author.as_ref().and_then(Actor::user),
            milestone: i.milestone.as_ref().map(|m| m.number),
            created: Some(time(&i.created_at)),
            updated: time(&i.updated_at),
            closed: i.closed_at.as_deref().map(time),
            comments: i.comments.total_count,
            issue_type: i.issue_type.as_ref().map(|t| t.name.clone()),
            labels: i
                .labels
                .nodes
                .iter()
                .flatten()
                .map(|l| l.name.clone())
                .collect(),
            assignees: i
                .assignees
                .nodes
                .iter()
                .flatten()
                .filter_map(Actor::user)
                .collect(),
            pr: None,
        }
    }

    pub(crate) fn from_rest(i: &RestIssue) -> ItemData {
        let pr = i.pull_request.is_some();
        ItemData {
            id: i.id,
            node_id: i.node_id.clone(),
            number: i.number,
            kind: if pr { "pr" } else { "issue" },
            title: i.title.clone(),
            body: i.body.clone(),
            state: i.state.clone(),
            state_reason: i.state_reason.clone(),
            locked: i.locked,
            author: i.user.as_ref().map(RestUser::user),
            milestone: i.milestone.as_ref().map(|m| m.number),
            created: i.created_at.as_deref().map(time),
            updated: time(&i.updated_at),
            closed: i.closed_at.as_deref().map(time),
            comments: i.comments,
            // Never on a PR.
            issue_type: i
                .issue_type
                .as_ref()
                .filter(|_| !pr)
                .map(|t| t.name.clone()),
            labels: i.labels.iter().map(|l| l.name.clone()).collect(),
            assignees: i.assignees.iter().map(RestUser::user).collect(),
            // The PR's own fields come from its details (`ImportPullDetails`).
            pr: None,
        }
    }

    /// The item as a relationship names it.
    pub(super) fn target(&self, repo: &Repo) -> Target {
        self.target_at(repo.id, &repo.owner, &repo.name, repo.private)
    }

    /// The item, in repo `repo_id` (`owner/name`), as a relationship names it.
    pub(crate) fn target_at(&self, repo_id: i64, owner: &str, name: &str, private: bool) -> Target {
        Target {
            typename: Some(
                if self.kind == "pr" {
                    "PullRequest"
                } else {
                    "Issue"
                }
                .into(),
            ),
            id: self.node_id.clone(),
            database_id: self.id,
            number: self.number,
            title: self.title.clone(),
            state: self.state.to_uppercase(),
            repository: TargetRepo {
                id: String::new(),
                database_id: repo_id,
                name: name.to_owned(),
                owner: Login {
                    login: owner.to_owned(),
                },
                is_private: private,
            },
        }
    }
}

/// Writes an issue or PR under the webhook upserts' guards; false when the mirror already had it
/// as new or newer, or it was deleted. A new row is inserted whole; an existing one gets only
/// what changed (see webhooks.sql).
pub(crate) fn write_item(
    tx: &Transaction,
    seq: i64,
    repo: i64,
    it: &ItemData,
) -> rusqlite::Result<bool> {
    let milestone = match it.milestone {
        Some(n) => q::milestone_by_number(tx, repo, n)?,
        None => None,
    };
    let author = it.author.as_ref().map(|u| u.id);
    let applied = q::upsert_item(
        tx,
        it.id,
        &it.node_id,
        repo,
        it.number,
        it.kind,
        &it.title,
        it.body.as_deref(),
        &it.state,
        it.state_reason.as_deref(),
        it.locked,
        author,
        milestone,
        it.created,
        it.updated,
        it.closed,
        it.comments,
        it.issue_type.as_deref(),
        seq,
    )? > 0;
    if !applied {
        return Ok(false);
    }
    q::set_item_place(tx, it.id, repo, it.number)?;
    q::unstub_item(tx, it.id)?;
    q::set_item_text(tx, it.id, &it.title, it.body.as_deref())?;
    q::set_item_kind(tx, it.id, it.kind)?;
    q::set_item_state(tx, it.id, &it.state, it.closed)?;
    q::set_item_created(tx, it.id, it.created)?;
    q::set_item_updated(tx, it.id, it.updated)?;
    q::set_item_author(tx, it.id, author)?;
    q::set_item_comments(tx, it.id, it.comments)?;
    q::set_item_type(tx, it.id, it.issue_type.as_deref())?;
    if let Some(p) = &it.pr {
        q::set_item_pr(
            tx,
            it.id,
            p.pr_id,
            p.draft,
            p.merged_at,
            p.head_ref.as_deref(),
            p.base_ref.as_deref(),
            p.review_decision.as_deref(),
        )?;
    }
    if let Some(u) = &it.author {
        q::upsert_user(tx, u.id, &u.login, u.avatar_url.as_deref())?;
    }
    q::clear_item_labels(tx, it.id)?;
    for name in &it.labels {
        if let Some(l) = q::label_by_name(tx, repo, name)? {
            q::link_item_label(tx, it.id, l)?;
        }
    }
    q::clear_item_assignees(tx, it.id)?;
    for a in &it.assignees {
        q::upsert_user(tx, a.id, &a.login, a.avatar_url.as_deref())?;
        q::add_item_assignee(tx, it.id, a.id)?;
    }
    Ok(true)
}

/// Where a relationship's end lands in this mirror: the id of an item in a synced repo, of a
/// stub (an issue in a repo the account can see or anyone can), or nowhere. The bool says
/// whether it's inside the synced repos.
pub(crate) fn relationship_end(
    tx: &Transaction,
    seq: i64,
    t: &Target,
) -> rusqlite::Result<Option<(i64, bool)>> {
    let repo = q::repo_state(tx, t.repository.database_id)?;
    if repo.as_ref().is_some_and(|r| r.synced) {
        return Ok(Some((t.database_id, true)));
    }
    let visible = repo.as_ref().is_some_and(|r| r.installation_id.is_some());
    if !(visible || !t.repository.is_private) {
        return Ok(None);
    }
    q::upsert_stub_repo(
        tx,
        t.repository.database_id,
        &t.repository.id,
        &t.repository.owner.login,
        &t.repository.name,
        t.repository.is_private,
    )?;
    let kind = if t.typename.as_deref() == Some("PullRequest") {
        "pr"
    } else {
        "issue"
    };
    q::upsert_stub(
        tx,
        t.database_id,
        &t.id,
        t.repository.database_id,
        t.number,
        kind,
        &t.title,
        &t.state.to_lowercase(),
        seq,
    )?;
    q::set_stub_place(tx, t.database_id, t.repository.database_id, t.number, seq)?;
    Ok(Some((t.database_id, false)))
}

/// Writes one linked PR: `pr` closes `issue`, if both land and one is inside the synced repos.
/// The ids whose linked PRs changed.
pub(crate) fn write_linked_pr(
    tx: &Transaction,
    seq: i64,
    pr: &Target,
    issue: &Target,
) -> rusqlite::Result<Vec<i64>> {
    write_pair(tx, seq, "closes", pr, issue, None)
}

/// Writes one relationship, `src` to `dst` (relates-to in id order), if both ends land and at
/// least one is inside the synced repos. The ids whose relationships changed.
pub(crate) fn write_relationship(
    tx: &Transaction,
    seq: i64,
    kind: Kind,
    src: &Target,
    dst: &Target,
    position: Option<f64>,
) -> rusqlite::Result<Vec<i64>> {
    write_pair(tx, seq, kind.name(), src, dst, position)
}

/// A relationship or a linked PR (`closes`): both are rows of `relationships`.
fn write_pair(
    tx: &Transaction,
    seq: i64,
    kind: &str,
    src: &Target,
    dst: &Target,
    position: Option<f64>,
) -> rusqlite::Result<Vec<i64>> {
    let (Some((s, s_in)), Some((d, d_in))) = (
        relationship_end(tx, seq, src)?,
        relationship_end(tx, seq, dst)?,
    ) else {
        return Ok(Vec::new());
    };
    if !(s_in || d_in) || s == d {
        return Ok(Vec::new());
    }
    let (s, d) = if kind == "relates" {
        (s.min(d), s.max(d))
    } else {
        (s, d)
    };
    // Newer than what a sweep under way read of either end.
    q::touch_edges(tx, s, seq)?;
    q::touch_edges(tx, d, seq)?;
    if kind == "sub" {
        q::drop_other_parents(tx, d, s)?;
    }
    Ok(
        if q::import_relationship(tx, kind, s, d, position, seq)? > 0 {
            vec![s, d]
        } else {
            Vec::new()
        },
    )
}

#[derive(Clone, Debug)]
pub(crate) struct CommentData {
    pub(crate) id: i64,
    pub(crate) node_id: String,
    pub(crate) item: i64,
    pub(crate) author: Option<UserData>,
    pub(crate) body: String,
    pub(crate) created: i64,
    pub(crate) updated: i64,
}

impl CommentData {
    pub(crate) fn from_graphql(item: i64, c: GqlComment) -> CommentData {
        CommentData {
            id: c.database_id,
            node_id: c.id,
            item,
            author: c.author.as_ref().and_then(Actor::user),
            body: c.body,
            created: time(&c.created_at),
            updated: time(&c.updated_at),
        }
    }

    pub(crate) fn from_rest(item: i64, c: RestComment) -> CommentData {
        let updated = time(&c.updated_at);
        CommentData {
            id: c.id,
            node_id: c.node_id,
            item,
            author: c.user.as_ref().map(RestUser::user),
            body: c.body.unwrap_or_default(),
            created: c.created_at.as_deref().map_or(updated, time),
            updated,
        }
    }
}

/// Writes comments under the webhook upsert's guards, keeping each item's last-commented time.
pub(crate) fn write_comments(
    tx: &Transaction,
    seq: i64,
    comments: &[CommentData],
) -> rusqlite::Result<Vec<i64>> {
    let mut changed = Vec::new();
    for c in comments {
        if let Some(u) = &c.author {
            q::upsert_user(tx, u.id, &u.login, u.avatar_url.as_deref())?;
        }
        let written = q::upsert_comment(
            tx,
            c.id,
            &c.node_id,
            c.item,
            c.author.as_ref().map(|u| u.id),
            &c.body,
            c.created,
            c.updated,
            seq,
        )? > 0;
        if written {
            q::bump_last_commented(tx, c.item, c.created, seq)?;
            changed.push(c.item);
        }
    }
    Ok(changed)
}
