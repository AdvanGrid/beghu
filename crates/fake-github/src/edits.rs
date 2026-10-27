//! Outside edits: changes made on "GitHub" by someone other than beghu (a teammate in the web UI,
//! an agent with `gh`). `POST /edit` on the control port applies one to the truth and sends the
//! webhooks GitHub would, one per action, about a second later.
//!
//! ```json
//! { "repo": "acme/web" | "web", "number": 12, "as": "tomsj",
//!   "title": "…", "body": "…", "state": "open" | "closed", "state_reason": "not_planned",
//!   "add_labels": ["bug"], "remove_labels": ["triage"], "comment": "…",
//!   "type": "Bug" | null }
//! ```
//!
//! Relationship changes name the other issue (`repo#n`, `owner/repo#n` or `#n`), which may be in
//! a repo the App isn't installed on: `add_sub_issue`/`remove_sub_issue` (the edited issue is the
//! parent), `add_blocked_by`/`remove_blocked_by` and `add_relates_to`/`remove_relates_to` (see
//! `relationships.rs` for GitHub's rules and deliveries). `prioritize_sub_issue` moves one of the
//! edited issue's sub-issues before its siblings, which GitHub does without a webhook.
//!
//! `"delete": true` deletes the issue instead (GitHub's `deleteIssue` mutation), with its comments
//! and relationships, and sends `issues` `deleted`.
//!
//! Every field but `repo` and `number` is optional; `as` defaults to the first fixture account.
//! `type` sets the issue type by name (an `issues` `typed` delivery), and `null` removes it
//! (`untyped`), as GitHub's `PATCH /repos/{owner}/{repo}/issues/{number}` takes it. A PR has no
//! type.
//! Each delivery carries the issue as it is after the whole edit.
//!
//! `POST /label` on the control port changes a repo's labels, with GitHub's `label` deliveries:
//! `{ "repo": "web", "name": "bug", "rename": "defect" }` renames one (`edited`, with
//! `changes.name.from`), and `{ "repo": "web", "name": "needs-design", "color": "ededed" }`
//! creates one (`created`).

use crate::Fake;
use crate::api::{self, rfc3339};
use crate::control::bad_request;
use crate::relationships;
use crate::webhooks::{
    Delivery, author_association, envelope, issue_json, issue_type_json, label_json, user_json,
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
    /// Sub-issue, dependency and relates-to changes (see `relationships.rs`).
    #[serde(flatten)]
    relationships: relationships::Asks,
    /// The issue is deleted, and nothing else in the edit is made.
    #[serde(default)]
    delete: bool,
}

/// A field that's present, `null` included: `Some(None)` for `null`, so absent stays `None`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// Why an edit can't be made: the control port answers 400 with it.
struct Refused(String);

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
        Ok(Err(Refused(why))) => bad_request(why),
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
    let refuse = |why: String| Ok(Err(Refused(why)));
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
    if e.issue_type.is_some() && q::issue(tx, id)?.kind == "pr" {
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
    deliveries.extend(relationships::apply(tx, &links, &sender_json)?);
    if let Some(child) = reorder {
        // Silent: GitHub sends nothing for a reorder.
        q::move_sub_issue_first(tx, id, child)?;
    }
    // A relationship change doesn't touch the issue's own fields, so the issue `done` read back
    // is still the issue afterwards.
    Ok(Ok((done.issue, deliveries)))
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
    pub comment: Option<String>,
    /// Absent: unchanged. `Some(None)`: untyped. A name: that type.
    pub issue_type: Option<Option<String>>,
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
            || self.comment.is_some();
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
        let delivery = |event: &'static str, action: &str, extra: Value| {
            let mut p = envelope(repo, &sender);
            p["action"] = json!(action);
            p["issue"] = issue.clone();
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
}

/// `POST /label`: creates or renames a repo's label, as GitHub's web UI would.
pub(crate) async fn label(
    State(fake): State<Fake>,
    axum::Json(l): axum::Json<LabelChange>,
) -> Response {
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let repo = match find_repo(tx, &l.repo)? {
                Ok(id) => q::repo(tx, id)?,
                Err(why) => return Ok(Err(why)),
            };
            let Some(sender) = q::accounts(tx)?.first().map(|a| a.id) else {
                return Ok(Err("the fixture has no accounts".to_owned()));
            };
            let Some(u) = q::user_row(tx, sender)? else {
                return Ok(Err("the sender isn't a user".to_owned()));
            };
            let sender = user_json(u.id, &u.login, u.avatar_url.as_deref());
            let held = q::label_by_name(tx, repo.id, &l.name)?;
            let (action, row, changes) = match (held, &l.rename) {
                (Some(h), Some(to)) => {
                    q::rename_label(tx, h.id, to)?;
                    let from = h.name.clone();
                    let row = q::LabelByNameRow {
                        name: to.clone(),
                        ..h
                    };
                    ("edited", row, Some(json!({ "name": { "from": from } })))
                }
                (None, None) => {
                    let id = q::next_label_id(tx)?;
                    let color = l.color.clone().unwrap_or_else(|| "ededed".into());
                    q::create_label(tx, id, repo.id, &l.name, &color)?;
                    let row = q::LabelByNameRow {
                        id,
                        name: l.name.clone(),
                        color,
                        description: None,
                    };
                    ("created", row, None)
                }
                (Some(_), None) => return Ok(Err(format!("{} has a label {}", l.repo, l.name))),
                (None, Some(_)) => return Ok(Err(format!("{} has no label {}", l.repo, l.name))),
            };
            let mut p = envelope(&repo, &sender);
            p["action"] = json!(action);
            p["label"] = label_json(
                &repo,
                row.id,
                &row.name,
                &row.color,
                row.description.as_deref(),
            );
            if let Some(c) = changes {
                p["changes"] = c;
            }
            Ok(Ok((row.id, Delivery::new("label", p))))
        })
        .await;
    match done {
        Ok(Ok((id, d))) => {
            fake.state().webhooks.send(vec![d]);
            axum::Json(json!({ "ok": true, "id": id })).into_response()
        }
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}
