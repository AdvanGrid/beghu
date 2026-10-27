//! Outside edits: changes made on "GitHub" by someone other than beghu (a teammate in the web UI,
//! an agent with `gh`). `POST /edit` on the control port applies one to the truth and sends the
//! webhooks GitHub would, one per action, about a second later.
//!
//! ```json
//! { "repo": "acme/web" | "web", "number": 12, "as": "tomsj",
//!   "title": "…", "body": "…", "state": "open" | "closed", "state_reason": "not_planned",
//!   "add_labels": ["bug"], "remove_labels": ["triage"], "comment": "…" }
//! ```
//!
//! Every field but `repo` and `number` is optional; `as` defaults to the first fixture account.
//! Each delivery carries the issue as it is after the whole edit.

use crate::Fake;
use crate::api::{self, rfc3339};
use crate::control::bad_request;
use crate::webhooks::{Delivery, author_association, envelope, issue_json, label_json, user_json};
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
    let Some(sender) = q::user_row(tx, sender)? else {
        return refuse("the sender isn't a user".into());
    };
    let sender = user_json(sender.id, &sender.login, sender.avatar_url.as_deref());
    let mut add = Vec::new();
    let mut remove = Vec::new();
    for (names, into) in [(&e.add_labels, &mut add), (&e.remove_labels, &mut remove)] {
        for name in names {
            match q::label_by_name(tx, repo.id, name)? {
                Some(l) => into.push(l),
                None => return refuse(format!("{} has no label {name}", e.repo)),
            }
        }
    }

    let before = q::issue(tx, id)?;
    // GitHub's clock only moves forward, even past a fixture written "in the future".
    let at = now.max(before.updated_at.unwrap_or(0));
    let title = e.title.clone().unwrap_or_else(|| before.title.clone());
    let body = e.body.clone().or_else(|| before.body.clone());
    let state = e.state.clone().unwrap_or_else(|| before.state.clone());
    let state_changed = state != before.state;
    let (state_reason, closed_at) = match (state.as_str(), state_changed) {
        ("closed", true) => (
            Some(e.state_reason.clone().unwrap_or_else(|| "completed".into())),
            Some(at),
        ),
        ("open", true) => (Some("reopened".to_owned()), None),
        _ => (
            e.state_reason
                .clone()
                .or_else(|| before.state_reason.clone()),
            before.closed_at,
        ),
    };
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
    // As on GitHub, labelling with a label already there (or removing one that isn't) changes
    // nothing and sends nothing.
    let mut added = Vec::new();
    for l in add {
        if q::add_issue_label(tx, id, l.id)? > 0 {
            added.push(l);
        }
    }
    let mut removed = Vec::new();
    for l in remove {
        if q::remove_issue_label(tx, id, l.id)? > 0 {
            removed.push(l);
        }
    }
    let comment = match &e.comment {
        Some(text) => {
            let cid = q::next_comment_id(tx)?;
            let author = sender["id"].as_i64().unwrap_or(0);
            q::add_comment(tx, cid, &format!("IC_kw{cid}"), id, author, text, at)?;
            q::count_comment(tx, id, at)?;
            Some(json!({
                "id": cid,
                "node_id": format!("IC_kw{cid}"),
                "url": format!("https://api.github.com/repos/{}/{}/issues/comments/{cid}", repo.owner, repo.name),
                "html_url": format!("https://github.com/{}/{}/issues/{}#issuecomment-{cid}", repo.owner, repo.name, e.number),
                "user": sender,
                "created_at": rfc3339(at),
                "updated_at": rfc3339(at),
                "author_association": author_association(tx, &repo, Some(author))?,
                "body": text,
            }))
        }
        None => None,
    };

    let issue = issue_json(tx, id)?;
    let delivery = |event: &'static str, action: &str, extra: Value| {
        let mut p = envelope(&repo, &sender);
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
    for (action, labels) in [("labeled", &added), ("unlabeled", &removed)] {
        for l in labels {
            let label = label_json(&repo, l.id, &l.name, &l.color, l.description.as_deref());
            out.push(delivery("issues", action, json!({ "label": label })));
        }
    }
    if let Some(c) = comment {
        out.push(delivery(
            "issue_comment",
            "created",
            json!({ "comment": c }),
        ));
    }
    Ok(Ok((issue, out)))
}
