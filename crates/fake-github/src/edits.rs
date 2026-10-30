//! Outside edits: changes made on "GitHub" by someone other than beghu (a teammate in the web UI,
//! an agent with `gh`). `POST /edit` on the control port applies one to the truth and sends the
//! webhooks GitHub would, one per action, about a second later.
//!
//! ```json
//! { "repo": "acme/web" | "web", "number": 12, "as": "tomsj",
//!   "title": "…", "body": "…", "state": "open" | "closed", "state_reason": "not_planned",
//!   "add_labels": ["bug"], "remove_labels": ["triage"], "comment": "…",
//!   "type": "Bug" | null, "locked": true }
//! ```
//!
//! Relationship changes name the other issue (`repo#n`, `owner/repo#n` or `#n`), which may be in
//! a repo the App isn't installed on: `add_sub_issue`/`remove_sub_issue` (the edited issue is the
//! parent), `add_blocked_by`/`remove_blocked_by` and `add_relates_to`/`remove_relates_to` (see
//! `relationships.rs` for GitHub's rules and deliveries). `prioritize_sub_issue` moves one of the
//! edited issue's sub-issues before its siblings, which GitHub does without a webhook.
//!
//! On a PR, `add_linked_issue`/`remove_linked_issue` link an issue in the Development sidebar,
//! and `review` (`approve`, `request_changes`, `comment`, `dismiss`) reviews it; its own changes
//! send `pull_request` deliveries rather than `issues` ones (see `pulls.rs`).
//!
//! `"delete": true` deletes the issue instead (GitHub's `deleteIssue` mutation, or an admin in its
//! sidebar), with its labels, assignees, comments and relationships, and sends `issues` `deleted`
//! with the issue as it was; its number answers 410 from then on. (Whether GitHub also sends
//! relationship deliveries for the links that go is unrecorded: the fake sends none.) A PR can't
//! be deleted, on GitHub or here: it's refused.
//!
//! `locked` locks the conversation (`issues` `locked`) or unlocks it (`unlocked`), as someone
//! with Write or up does in the issue's sidebar.
//!
//! Every field but `repo` and `number` is optional; `as` defaults to the first fixture account.
//! `type` sets the issue type by name (an `issues` `typed` delivery), and `null` removes it
//! (`untyped`), as GitHub's `PATCH /repos/{owner}/{repo}/issues/{number}` takes it. A PR has no
//! type.
//! Each delivery carries the issue as it is after the whole edit.
//!
//! `POST /label` on the control port changes a repo's labels as someone would in its label
//! settings, with GitHub's `label` deliveries: `{repo, name, rename?, color?, description?, as?}`.
//! A label the repo has is edited (`edited`, whose `changes` name what each changed field was;
//! no issue changes, as a rename bumps no issue's `updated_at`), and one it hasn't is created
//! (`created`, `ededed` unless `color` says otherwise).
//!
//! `POST /milestone` changes one of a repo's milestones the same way:
//! `{repo, title, rename?, state?, as?}`. A rename sends `milestone` `edited` (with
//! `changes.title.from`), and closing or reopening it `closed` or `opened`; the milestone's
//! `updated_at` moves, no issue's does.

use crate::Fake;
use crate::api::{self, rfc3339};
use crate::control::bad_request;
use crate::relationships;
use crate::webhooks::{
    Delivery, author_association, envelope, issue_json, issue_type_json, label_json,
    milestone_json, user_json,
};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub(crate) struct Edit {
    repo: String,
    number: i64,
    #[serde(rename = "as")]
    login: Option<String>,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    state_reason: Option<String>,
    #[serde(default)]
    add_labels: Vec<String>,
    #[serde(default)]
    remove_labels: Vec<String>,
    comment: Option<String>,
    /// Absent: unchanged. `null`: untyped. A name: that type.
    #[serde(rename = "type", default, deserialize_with = "present")]
    issue_type: Option<Option<String>>,
    /// The conversation locked (`true`) or unlocked (`false`).
    locked: Option<bool>,
    /// Sub-issue, dependency and relates-to changes (see `relationships.rs`).
    #[serde(flatten)]
    relationships: relationships::Asks,
    /// On a PR: an issue (`#n`, `repo#n` or `owner/repo#n`) linked to it, or unlinked, in the
    /// Development sidebar (see `pulls.rs`).
    add_linked_issue: Option<String>,
    remove_linked_issue: Option<String>,
    /// On a PR: a review by the sender, `approve`, `request_changes`, `comment` or `dismiss`.
    review: Option<String>,
    /// The issue is deleted, and nothing else in the edit is made.
    #[serde(default)]
    delete: bool,
}

/// A field that's present, `null` included: `Some(None)` for `null`, so absent stays `None`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// Why an edit can't be made: the control port answers 400 with it, or with `unprocessable`
/// 422, as GitHub answers a call it validates and refuses.
struct Refused(String, bool);

pub(crate) async fn edit(State(fake): State<Fake>, axum::Json(e): axum::Json<Edit>) -> Response {
    if let Some(s) = e.state.as_deref()
        && !matches!(s, "open" | "closed")
    {
        return bad_request("state is open or closed");
    }
    let now = fake.now();
    let done = fake.state().truth.write(move |tx| apply(tx, &e, now)).await;
    match done {
        Ok(Ok((issue, deliveries))) => {
            let n = deliveries.len();
            fake.state().webhooks.send(deliveries);
            axum::Json(json!({ "ok": true, "issue": issue, "deliveries": n })).into_response()
        }
        Ok(Err(Refused(why, false))) => bad_request(why),
        Ok(Err(Refused(why, true))) => crate::writes::unprocessable(&why),
        Err(e) => api::internal(e),
    }
}

/// The issue as the edit left it, and the deliveries it sends.
type Edited = (Value, Vec<Delivery>);

/// A synced repo by `owner/name`, or by `name` alone when only one owner has it; why not, when
/// there's no such repo.
pub(crate) fn find_repo(
    c: &rusqlite::Connection,
    repo: &str,
) -> rusqlite::Result<Result<i64, String>> {
    let found = match repo.split_once('/') {
        Some((owner, name)) => q::repo_by_full_name(c, owner, name)?,
        None => {
            let mut all = q::repos_by_name(c, repo)?;
            if all.len() > 1 {
                return Ok(Err(format!("{repo} is ambiguous; name the owner")));
            }
            all.pop()
        }
    };
    Ok(found.ok_or_else(|| format!("no synced repo {repo}")))
}

/// Applies the edit inside the truth's transaction: the issue afterwards, and its deliveries.
/// Everything that can refuse it is checked before anything is written.
fn apply(
    tx: &rusqlite::Transaction,
    e: &Edit,
    now: i64,
) -> rusqlite::Result<Result<Edited, Refused>> {
    let refuse = |why: String| Ok(Err(Refused(why, false)));
    let repo = match find_repo(tx, &e.repo)? {
        Ok(id) => q::repo(tx, id)?,
        Err(why) => return refuse(why),
    };
    let Some(id) = q::issue_id(tx, repo.id, e.number)? else {
        return refuse(format!("no issue {}#{}", e.repo, e.number));
    };
    let sender = match e.login.as_deref() {
        Some(login) => match q::account_by_login(tx, login)? {
            Some(a) => a.id,
            None => return refuse(format!("{login} isn't a fixture account")),
        },
        None => match q::accounts(tx)?.first() {
            Some(a) => a.id,
            None => return refuse("the fixture has no accounts".into()),
        },
    };
    let Some(sender_row) = q::user_row(tx, sender)? else {
        return refuse("the sender isn't a user".into());
    };
    let sender_json = user_json(
        sender_row.id,
        &sender_row.login,
        sender_row.avatar_url.as_deref(),
    );
    if e.delete {
        // GitHub deletes issues only: `deleteIssue` takes no PR, and no PR is ever deleted (it
        // can only be closed), so there's no `pull_request` `deleted` either.
        if q::issue(tx, id)?.kind == "pr" {
            return refuse(format!(
                "{}#{} is a pull request: GitHub doesn't delete pull requests",
                e.repo, e.number
            ));
        }
        return delete(tx, &repo, id, &sender_json).map(Ok);
    }
    let links = match relationships::plan(tx, id, repo.id, &e.relationships)? {
        Ok(links) => links,
        Err(why) => return refuse(why),
    };
    let reorder = match relationships::plan_reorder(tx, id, repo.id, &e.relationships)? {
        Ok(child) => child,
        Err(why) => return refuse(why),
    };
    let pr = q::issue(tx, id)?.kind == "pr";
    let pr_only =
        e.add_linked_issue.is_some() || e.remove_linked_issue.is_some() || e.review.is_some();
    if pr_only && !pr {
        return refuse(format!(
            "{}#{} is an issue: only a pull request links issues or takes reviews",
            e.repo, e.number
        ));
    }
    if let Some(r) = e.review.as_deref()
        && !matches!(r, "approve" | "request_changes" | "comment" | "dismiss")
    {
        return refuse("review is approve, request_changes, comment or dismiss".into());
    }
    // GitHub refuses a PR's author approving or requesting changes on their own PR (422);
    // commenting is fine.
    if let Some(r @ ("approve" | "request_changes")) = e.review.as_deref()
        && q::issue(tx, id)?.author_id == Some(sender)
    {
        let what = if r == "approve" {
            "approve"
        } else {
            "request changes on"
        };
        return Ok(Err(Refused(
            format!("Can not {what} your own pull request"),
            true,
        )));
    }
    let mut linked = Vec::new();
    for (target, add) in [(&e.add_linked_issue, true), (&e.remove_linked_issue, false)] {
        let Some(target) = target else { continue };
        match relationships::find_issue(tx, target, repo.id)? {
            Ok(issue) => linked.push((issue, add)),
            Err(why) => return refuse(why),
        }
    }
    if e.issue_type.is_some() && pr {
        return refuse(format!(
            "{}#{} is a pull request: it has no type",
            e.repo, e.number
        ));
    }
    if let Some(Some(t)) = &e.issue_type
        && t.trim().is_empty()
    {
        return refuse("type is a name or null".into());
    }
    let mut change = Change {
        title: e.title.clone(),
        body: e.body.clone(),
        state: e.state.clone(),
        state_reason: e.state_reason.clone(),
        comment: e.comment.clone(),
        issue_type: e.issue_type.clone(),
        locked: e.locked,
        ..Change::default()
    };
    for (names, into) in [
        (&e.add_labels, &mut change.add_labels),
        (&e.remove_labels, &mut change.remove_labels),
    ] {
        for name in names {
            match q::label_by_name(tx, repo.id, name)? {
                Some(l) => into.push(l),
                None => return refuse(format!("{} has no label {name}", e.repo)),
            }
        }
    }
    let Some(done) = change.apply(tx, &repo, id, sender, now)? else {
        return refuse("the sender isn't a user".into());
    };
    let mut deliveries = done.deliveries;
    deliveries.extend(relationships::apply(tx, &links, &sender_json, now)?);
    if let Some(child) = reorder {
        // Silent: GitHub sends nothing for a reorder.
        q::move_sub_issue_first(tx, id, child)?;
    }
    for (issue, add) in linked {
        crate::pulls::sidebar(tx, id, issue, add, sender, now)?;
    }
    let mut issue = done.issue;
    if let Some(r) = e.review.as_deref()
        && let Some(d) = crate::pulls::review(tx, &repo, id, r, sender, now)?
    {
        deliveries.push(d);
        issue = crate::webhooks::issue_json(tx, id)?;
    }
    // A relationship change doesn't touch the issue's own fields, so the issue `done` read back
    // is still the issue afterwards.
    Ok(Ok((issue, deliveries)))
}

/// Deletes issue `id` of `repo`, as GitHub's `deleteIssue` does: it, its comments and its
/// relationships go, with one `issues` `deleted` delivery carrying the issue as it was.
fn delete(
    tx: &rusqlite::Transaction,
    repo: &q::RepoRow,
    id: i64,
    sender: &Value,
) -> rusqlite::Result<Edited> {
    let issue = issue_json(tx, id)?;
    q::delete_issue_labels(tx, id)?;
    q::delete_issue_assignees(tx, id)?;
    q::delete_issue_comments(tx, id)?;
    q::delete_issue_relationships(tx, id)?;
    q::delete_issue(tx, id)?;
    // GitHub answers 410 for its number from then on, and never reuses the id.
    q::record_deleted_issue(tx, repo.id, issue["number"].as_i64().unwrap_or_default())?;
    q::retire_id(tx, id)?;
    let mut p = envelope(repo, sender);
    p["action"] = json!("deleted");
    p["issue"] = issue.clone();
    Ok((issue, vec![Delivery::new("issues", p)]))
}

/// One change to an issue, made by `sender`: an outside edit, or a REST write beghu makes. Each
/// field left out stays as it is.
#[derive(Default)]
pub(crate) struct Change {
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<String>,
    pub state_reason: Option<String>,
    pub add_labels: Vec<q::LabelByNameRow>,
    pub remove_labels: Vec<q::LabelByNameRow>,
    /// Users (ids) to assign; one already assigned changes nothing and sends nothing.
    pub add_assignees: Vec<i64>,
    /// Users (ids) to unassign; one not assigned changes nothing and sends nothing.
    pub remove_assignees: Vec<i64>,
    /// Absent: unchanged. `Some(None)`: no milestone. An id: that milestone of the repo.
    pub milestone: Option<Option<i64>>,
    pub comment: Option<String>,
    /// Absent: unchanged. `Some(None)`: untyped. A name: that type.
    pub issue_type: Option<Option<String>>,
    /// Absent: unchanged. Locking a locked issue (or unlocking an unlocked one) changes nothing
    /// and sends nothing.
    pub locked: Option<bool>,
}

/// What a change did: the issue afterwards, the comment it added, and the webhooks GitHub sends
/// for it, one per action.
pub(crate) struct Changed {
    pub issue: Value,
    pub comment: Option<Value>,
    pub deliveries: Vec<Delivery>,
}

impl Change {
    /// Writes the change to issue `id` of `repo` inside the truth's transaction. `None` if the
    /// sender isn't a user the truth knows.
    pub(crate) fn apply(
        &self,
        tx: &rusqlite::Transaction,
        repo: &q::RepoRow,
        id: i64,
        sender: i64,
        now: i64,
    ) -> rusqlite::Result<Option<Changed>> {
        let Some(sender) = q::user_row(tx, sender)? else {
            return Ok(None);
        };
        let sender = user_json(sender.id, &sender.login, sender.avatar_url.as_deref());
        let before = q::issue(tx, id)?;
        // GitHub's clock only moves forward, even past a fixture written "in the future".
        let at = now.max(before.updated_at.unwrap_or(0));
        let title = self.title.clone().unwrap_or_else(|| before.title.clone());
        let body = self.body.clone().or_else(|| before.body.clone());
        let state = self.state.clone().unwrap_or_else(|| before.state.clone());
        let state_changed = state != before.state;
        let (state_reason, closed_at) = match (state.as_str(), state_changed) {
            ("closed", true) => (
                Some(
                    self.state_reason
                        .clone()
                        .unwrap_or_else(|| "completed".into()),
                ),
                Some(at),
            ),
            ("open", true) => (Some("reopened".to_owned()), None),
            _ => (
                self.state_reason
                    .clone()
                    .or_else(|| before.state_reason.clone()),
                before.closed_at,
            ),
        };
        // Relationship changes alone (made by the caller after this) don't bump `updated_at` on
        // GitHub, so a change with nothing of the issue's own leaves it alone.
        let props = self.title.is_some()
            || self.body.is_some()
            || self.state.is_some()
            || !self.add_labels.is_empty()
            || !self.remove_labels.is_empty()
            || !self.add_assignees.is_empty()
            || !self.remove_assignees.is_empty()
            || self.milestone.is_some()
            || self.comment.is_some();
        let pr = before.kind == "pr";
        if pr && body != before.body {
            crate::pulls::relink(tx, id, repo.id, before.body.as_deref(), body.as_deref())?;
        }
        if state_changed {
            let event = if state == "closed" {
                "closed"
            } else {
                "reopened"
            };
            crate::events::record(tx, id, event, sender["id"].as_i64(), None, at)?;
        }
        if props {
            q::update_issue(
                tx,
                id,
                &title,
                body.as_deref(),
                &state,
                state_reason.as_deref(),
                closed_at,
                at,
            )?;
        }
        // Setting the type it already has changes nothing and sends nothing.
        let typed = match &self.issue_type {
            Some(t) if *t != before.issue_type => {
                q::set_issue_type(tx, id, t.as_deref(), at)?;
                Some(t.clone())
            }
            _ => None,
        };
        // As on GitHub, labelling with a label already there (or removing one that isn't)
        // changes nothing and sends nothing.
        let mut added = Vec::new();
        for l in &self.add_labels {
            if q::add_issue_label(tx, id, l.id)? > 0 {
                added.push(l);
            }
        }
        let mut removed = Vec::new();
        for l in &self.remove_labels {
            if q::remove_issue_label(tx, id, l.id)? > 0 {
                removed.push(l);
            }
        }
        let mut assigned = Vec::new();
        for u in &self.add_assignees {
            if q::add_issue_assignee(tx, id, *u)? > 0 {
                assigned.push(*u);
            }
        }
        let mut unassigned = Vec::new();
        for u in &self.remove_assignees {
            if q::remove_issue_assignee(tx, id, *u)? > 0 {
                unassigned.push(*u);
            }
        }
        // Setting the milestone it already has changes nothing and sends nothing.
        let milestoned = match self.milestone {
            Some(m) if m != before.milestone_id => {
                q::set_issue_milestone(tx, id, m)?;
                Some(m)
            }
            _ => None,
        };
        let locked = match self.locked {
            Some(l) if l != before.locked => {
                q::set_issue_locked(tx, id, l, at)?;
                Some(l)
            }
            _ => None,
        };
        let comment = match &self.comment {
            Some(text) => {
                let cid = q::next_comment_id(tx)?;
                let author = sender["id"].as_i64().unwrap_or(0);
                q::add_comment(tx, cid, &format!("IC_kw{cid}"), id, author, text, at)?;
                q::count_comment(tx, id, at)?;
                let full = format!("{}/{}", repo.owner, repo.name);
                Some(json!({
                    "id": cid,
                    "node_id": format!("IC_kw{cid}"),
                    "url": format!("https://api.github.com/repos/{full}/issues/comments/{cid}"),
                    "html_url": format!("https://github.com/{full}/issues/{}#issuecomment-{cid}", before.number),
                    "issue_url": format!("https://api.github.com/repos/{full}/issues/{}", before.number),
                    "user": sender,
                    "created_at": rfc3339(at),
                    "updated_at": rfc3339(at),
                    "author_association": author_association(tx, repo, Some(author))?,
                    "body": text,
                    "performed_via_github_app": null,
                }))
            }
            None => None,
        };

        let issue = issue_json(tx, id)?;
        // A PR's own changes are `pull_request` deliveries, carrying the PR (`pulls.rs`).
        let pull = if pr {
            Some(crate::pulls::pr_json(tx, id)?)
        } else {
            None
        };
        let delivery = |event: &'static str, action: &str, extra: Value| {
            let mut p = envelope(repo, &sender);
            p["action"] = json!(action);
            let event = match (&pull, event) {
                (Some(pr), "issues") => {
                    p["number"] = json!(before.number);
                    p["pull_request"] = pr.clone();
                    "pull_request"
                }
                _ => {
                    p["issue"] = issue.clone();
                    event
                }
            };
            if let Value::Object(extra) = extra {
                for (k, v) in extra {
                    p[k] = v;
                }
            }
            Delivery::new(event, p)
        };
        let mut out = Vec::new();
        let mut changes = serde_json::Map::new();
        if title != before.title {
            changes.insert("title".into(), json!({ "from": before.title }));
        }
        if body != before.body {
            changes.insert("body".into(), json!({ "from": before.body }));
        }
        if !changes.is_empty() {
            out.push(delivery("issues", "edited", json!({ "changes": changes })));
        }
        if state_changed {
            let action = if state == "closed" {
                "closed"
            } else {
                "reopened"
            };
            out.push(delivery("issues", action, json!({})));
        }
        if let Some(t) = typed {
            // `type` names the issue's type now, or, once untyped, the one it had.
            let (action, name) = match &t {
                Some(name) => ("typed", Some(name.as_str())),
                None => ("untyped", before.issue_type.as_deref()),
            };
            let ty = name.map_or(Value::Null, issue_type_json);
            out.push(delivery("issues", action, json!({ "type": ty })));
        }
        for (action, labels) in [("labeled", &added), ("unlabeled", &removed)] {
            for l in labels {
                let label = label_json(repo, l.id, &l.name, &l.color, l.description.as_deref());
                out.push(delivery("issues", action, json!({ "label": label })));
            }
        }
        for (action, users) in [("assigned", &assigned), ("unassigned", &unassigned)] {
            for u in users.iter() {
                let Some(u) = q::user_row(tx, *u)? else {
                    continue;
                };
                let assignee = user_json(u.id, &u.login, u.avatar_url.as_deref());
                out.push(delivery("issues", action, json!({ "assignee": assignee })));
            }
        }
        // `milestoned` names the milestone it's in now; `demilestoned`, once out of one, the one
        // it was in. (Whether GitHub also sends `demilestoned` for the old milestone when an
        // issue moves straight to another is unrecorded: the fake sends `milestoned` alone.)
        if let Some(m) = milestoned {
            let (action, which) = match m {
                Some(m) => ("milestoned", Some(m)),
                None => ("demilestoned", before.milestone_id),
            };
            let milestone = match which {
                Some(m) => milestone_json(tx, repo, m)?,
                None => Value::Null,
            };
            out.push(delivery(
                "issues",
                action,
                json!({ "milestone": milestone }),
            ));
        }
        if let Some(l) = locked {
            let action = if l { "locked" } else { "unlocked" };
            out.push(delivery("issues", action, json!({})));
        }
        if let Some(c) = &comment {
            out.push(delivery(
                "issue_comment",
                "created",
                json!({ "comment": c }),
            ));
        }
        Ok(Some(Changed {
            issue,
            comment,
            deliveries: out,
        }))
    }
}

#[derive(Deserialize)]
pub(crate) struct LabelChange {
    repo: String,
    name: String,
    rename: Option<String>,
    color: Option<String>,
    description: Option<String>,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /label`: edits or creates a repo's label, as GitHub's web UI would.
pub(crate) async fn label(
    State(fake): State<Fake>,
    axum::Json(l): axum::Json<LabelChange>,
) -> Response {
    if l.rename.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return bad_request("rename can't be empty");
    }
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let repo = match find_repo(tx, &l.repo)? {
                Ok(id) => q::repo(tx, id)?,
                Err(why) => return Ok(Err(why)),
            };
            let sender = match l.login.as_deref() {
                Some(login) => q::account_by_login(tx, login)?.map(|a| a.id),
                None => q::accounts(tx)?.first().map(|a| a.id),
            };
            let Some(u) = sender.map(|id| q::user_row(tx, id)).transpose()?.flatten() else {
                return Ok(Err("the sender isn't a fixture account".to_owned()));
            };
            let sender = user_json(u.id, &u.login, u.avatar_url.as_deref());
            let (action, row, changes) = match q::label_by_name(tx, repo.id, &l.name)? {
                Some(before) => {
                    let name = l.rename.clone().unwrap_or_else(|| before.name.clone());
                    let color = l.color.clone().unwrap_or_else(|| before.color.clone());
                    let description = l.description.clone().or_else(|| before.description.clone());
                    q::update_label(tx, before.id, &name, &color, description.as_deref())?;
                    let mut changes = serde_json::Map::new();
                    if name != before.name {
                        changes.insert("name".into(), json!({ "from": before.name }));
                    }
                    if color != before.color {
                        changes.insert("color".into(), json!({ "from": before.color }));
                    }
                    if description != before.description {
                        changes.insert("description".into(), json!({ "from": before.description }));
                    }
                    let row = q::LabelByNameRow {
                        id: before.id,
                        name,
                        color,
                        description,
                    };
                    ("edited", row, Some(Value::Object(changes)))
                }
                None if l.rename.is_some() => {
                    return Ok(Err(format!("{} has no label {}", l.repo, l.name)));
                }
                None => {
                    let id = q::next_label_id(tx)?;
                    let color = l.color.clone().unwrap_or_else(|| "ededed".into());
                    q::create_label(tx, id, repo.id, &l.name, &color, l.description.as_deref())?;
                    let row = q::LabelByNameRow {
                        id,
                        name: l.name.clone(),
                        color,
                        description: l.description.clone(),
                    };
                    ("created", row, None)
                }
            };
            let label = label_json(
                &repo,
                row.id,
                &row.name,
                &row.color,
                row.description.as_deref(),
            );
            let mut p = envelope(&repo, &sender);
            p["action"] = json!(action);
            p["label"] = label.clone();
            if let Some(c) = changes {
                p["changes"] = c;
            }
            Ok(Ok((row.id, label, Delivery::new("label", p))))
        })
        .await;
    match done {
        Ok(Ok((id, label, d))) => {
            fake.state().webhooks.send(vec![d]);
            axum::Json(json!({ "ok": true, "id": id, "label": label })).into_response()
        }
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct MilestoneChange {
    repo: String,
    title: String,
    rename: Option<String>,
    state: Option<String>,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /milestone`: renames, closes or reopens one of a repo's milestones, as GitHub's web UI
/// would.
pub(crate) async fn milestone(
    State(fake): State<Fake>,
    axum::Json(m): axum::Json<MilestoneChange>,
) -> Response {
    if m.rename.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return bad_request("rename can't be empty");
    }
    if let Some(s) = m.state.as_deref()
        && !matches!(s, "open" | "closed")
    {
        return bad_request("state is open or closed");
    }
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let repo = match find_repo(tx, &m.repo)? {
                Ok(id) => q::repo(tx, id)?,
                Err(why) => return Ok(Err(why)),
            };
            let sender = match m.login.as_deref() {
                Some(login) => q::account_by_login(tx, login)?.map(|a| a.id),
                None => q::accounts(tx)?.first().map(|a| a.id),
            };
            let Some(u) = sender.map(|id| q::user_row(tx, id)).transpose()?.flatten() else {
                return Ok(Err("the sender isn't a fixture account".to_owned()));
            };
            let sender = user_json(u.id, &u.login, u.avatar_url.as_deref());
            let Some(before) = q::milestone_by_title(tx, repo.id, &m.title)? else {
                return Ok(Err(format!("{} has no milestone {}", m.repo, m.title)));
            };
            let title = m.rename.clone().unwrap_or_else(|| before.title.clone());
            let state = m.state.clone().unwrap_or_else(|| before.state.clone());
            q::update_milestone(tx, before.id, &title, &state, now)?;
            let milestone = milestone_json(tx, &repo, before.id)?;
            let delivery = |action: &str, changes: Option<Value>| {
                let mut p = envelope(&repo, &sender);
                p["action"] = json!(action);
                p["milestone"] = milestone.clone();
                if let Some(c) = changes {
                    p["changes"] = c;
                }
                Delivery::new("milestone", p)
            };
            let mut out = Vec::new();
            if title != before.title {
                out.push(delivery(
                    "edited",
                    Some(json!({ "title": { "from": before.title } })),
                ));
            }
            if state != before.state {
                out.push(delivery(
                    if state == "closed" {
                        "closed"
                    } else {
                        "opened"
                    },
                    None,
                ));
            }
            Ok(Ok((milestone.clone(), out)))
        })
        .await;
    match done {
        Ok(Ok((milestone, deliveries))) => {
            let n = deliveries.len();
            fake.state().webhooks.send(deliveries);
            axum::Json(json!({ "ok": true, "milestone": milestone, "deliveries": n }))
                .into_response()
        }
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}
