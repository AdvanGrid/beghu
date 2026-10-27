//! Issues leaving where they were, and repos going read-only: the rare GitHub events beghu's
//! mirror must survive, as measured (docs/research/issue-edge-cases.md). On the control port:
//!
//! - `POST /transfer {repo, number, to, as?}`: someone transfers the issue to `to` (`owner/name`
//!   or `name`), another repo of the same owner, installed or not, and never from a private repo
//!   to a public one. The issue becomes a new one there (new id, node id and number; `created_at`
//!   kept, `updated_at` the transfer's) with its comments, assignees and every relationship; its
//!   labels and milestone go along where the destination has one of the same name (a milestone:
//!   title and due date). Its old number answers 301 to the new issue from then on (measured
//!   for a `GET`; the writes GitHub documents a 301 for answer one too, unmeasured). Deliveries,
//!   in GitHub's order: `issues` `opened` in the destination with `changes.old_issue` and
//!   `changes.old_repository`; each dependency and relates-to again, as if just added (no
//!   sub-issue delivery at all); then `issues` `transferred` in the source, with the old issue
//!   and `changes.new_issue` and `changes.new_repository`. A repo the App isn't installed on gets
//!   none of its deliveries.
//! - `POST /convert {repo, number, as?}`: someone converts the issue to a discussion. The
//!   discussion takes the next number; the issue stays, closed as completed and locked, with its
//!   labels, milestone and links. Deliveries: `issues` `locked`, then `issues` `closed` (if it was
//!   open; only an open one's conversion was measured), each with the issue as the conversion
//!   left it. GitHub's `discussion` deliveries go
//!   only to Apps subscribed to discussions, and beghu's isn't.
//! - `POST /archive {repo, archived, as?}`: an admin archives the repo, or unarchives it;
//!   `repository` `archived` or `unarchived` follows.

use crate::Fake;
use crate::api;
use crate::control::bad_request;
use crate::edits::find_repo;
use crate::relationships;
use crate::webhooks::{Delivery, envelope, issue_json, repo_json, user_json};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use fake_db::q;
use rusqlite::Transaction;
use serde::Deserialize;
use serde_json::{Value, json};

/// The answer to a move: what it made, and its deliveries; or why GitHub would refuse it.
type Moved = Result<(Value, Vec<Delivery>), String>;

/// Runs `apply` in the truth's transaction, then sends its deliveries.
async fn run(
    fake: Fake,
    apply: impl FnOnce(&Transaction, i64) -> rusqlite::Result<Moved> + Send + 'static,
) -> Response {
    let now = fake.now();
    match fake.state().truth.write(move |tx| apply(tx, now)).await {
        Ok(Ok((mut answer, deliveries))) => {
            answer["ok"] = json!(true);
            answer["deliveries"] = json!(deliveries.len());
            fake.state().webhooks.send(deliveries);
            axum::Json(answer).into_response()
        }
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}

/// The user `login` names (by default the first fixture account), as deliveries carry them.
fn sender(tx: &Transaction, login: Option<&str>) -> rusqlite::Result<Result<Value, String>> {
    let id = match login {
        Some(login) => q::account_by_login(tx, login)?.map(|a| a.id),
        None => q::accounts(tx)?.first().map(|a| a.id),
    };
    Ok(
        match id.map(|id| q::user_row(tx, id)).transpose()?.flatten() {
            Some(u) => Ok(user_json(u.id, &u.login, u.avatar_url.as_deref())),
            None => Err("the sender isn't a fixture account".into()),
        },
    )
}

/// Any repo GitHub has, installed or not, by `owner/name` or by `name` when only one owner has it.
fn find_any_repo(tx: &Transaction, repo: &str) -> rusqlite::Result<Result<i64, String>> {
    let found = match repo.split_once('/') {
        Some((owner, name)) => q::any_repo_by_full_name(tx, owner, name)?,
        None => {
            let mut all = q::any_repos_by_name(tx, repo)?;
            if all.len() > 1 {
                return Ok(Err(format!("{repo} is ambiguous; name the owner")));
            }
            all.pop()
        }
    };
    Ok(found.ok_or_else(|| format!("no repo {repo}")))
}

/// An issue of an installed repo, named as `repo` and `number`: the repo and the issue's id.
fn find_issue(
    tx: &Transaction,
    repo: &str,
    number: i64,
) -> rusqlite::Result<Result<(q::RepoRow, i64), String>> {
    let r = match find_repo(tx, repo)? {
        Ok(id) => q::repo(tx, id)?,
        Err(why) => return Ok(Err(why)),
    };
    Ok(match q::issue_id(tx, r.id, number)? {
        Some(id) => Ok((r, id)),
        None => Err(format!("no issue {repo}#{number}")),
    })
}

#[derive(Deserialize)]
pub(crate) struct Transfer {
    repo: String,
    number: i64,
    to: String,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /transfer`.
pub(crate) async fn transfer(
    State(fake): State<Fake>,
    axum::Json(t): axum::Json<Transfer>,
) -> Response {
    run(fake, move |tx, now| transfer_in(tx, &t, now)).await
}

fn transfer_in(tx: &Transaction, t: &Transfer, now: i64) -> rusqlite::Result<Moved> {
    let (from, old) = match find_issue(tx, &t.repo, t.number)? {
        Ok(found) => found,
        Err(why) => return Ok(Err(why)),
    };
    let to = match find_any_repo(tx, &t.to)? {
        Ok(id) => q::repo(tx, id)?,
        Err(why) => return Ok(Err(why)),
    };
    let sender = match sender(tx, t.login.as_deref())? {
        Ok(s) => s,
        Err(why) => return Ok(Err(why)),
    };
    let before = q::issue(tx, old)?;
    // GitHub's rules for a transfer.
    if before.kind == "pr" {
        return Ok(Err("a pull request can't be transferred".into()));
    }
    if to.id == from.id {
        return Ok(Err(format!(
            "{}#{} is already in {}",
            t.repo, t.number, t.to
        )));
    }
    if !to.owner.eq_ignore_ascii_case(&from.owner) {
        return Ok(Err(
            "an issue moves only between repos of the same owner".into()
        ));
    }
    if from.private && !to.private {
        return Ok(Err(
            "an issue can't move from a private repo to a public one".into(),
        ));
    }
    let old_json = issue_json(tx, old)?;
    let new = q::next_issue_id(tx)?;
    let number = q::next_number(tx, to.id)?;
    // GitHub's clock only moves forward, even past a fixture written "in the future".
    let at = now.max(before.updated_at.unwrap_or(0));
    q::copy_issue(tx, old, new, &format!("I_kw{new}"), to.id, number, at)?;
    q::copy_labels_by_name(tx, old, new, to.id)?;
    q::copy_milestone_by_title(tx, old, new, to.id)?;
    q::copy_assignees(tx, old, new)?;
    q::move_comments(tx, old, new)?;
    q::repoint_children(tx, old, new)?;
    q::repoint_relationships(tx, old, new)?;
    q::delete_issue_labels(tx, old)?;
    q::delete_issue_assignees(tx, old)?;
    q::delete_issue_relationships(tx, old)?;
    q::delete_issue(tx, old)?;
    q::record_transferred_issue(tx, from.id, before.number, old, new)?;
    q::retire_id(tx, old)?;

    let new_json = issue_json(tx, new)?;
    let mut out = Vec::new();
    if to.installation_id.is_some() {
        let mut p = envelope(&to, &sender);
        p["action"] = json!("opened");
        p["issue"] = new_json.clone();
        p["changes"] = json!({ "old_issue": old_json, "old_repository": repo_json(&from) });
        out.push(Delivery::new("issues", p));
    }
    out.extend(relationships::announce_transferred(tx, new, &sender)?);
    if from.installation_id.is_some() {
        let mut p = envelope(&from, &sender);
        p["action"] = json!("transferred");
        p["issue"] = old_json;
        p["changes"] = json!({ "new_issue": new_json, "new_repository": repo_json(&to) });
        out.push(Delivery::new("issues", p));
    }
    Ok(Ok((json!({ "issue": new_json }), out)))
}

#[derive(Deserialize)]
pub(crate) struct Convert {
    repo: String,
    number: i64,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /convert`.
pub(crate) async fn convert(
    State(fake): State<Fake>,
    axum::Json(c): axum::Json<Convert>,
) -> Response {
    run(fake, move |tx, now| convert_in(tx, &c, now)).await
}

fn convert_in(tx: &Transaction, c: &Convert, now: i64) -> rusqlite::Result<Moved> {
    let (repo, id) = match find_issue(tx, &c.repo, c.number)? {
        Ok(found) => found,
        Err(why) => return Ok(Err(why)),
    };
    let sender = match sender(tx, c.login.as_deref())? {
        Ok(s) => s,
        Err(why) => return Ok(Err(why)),
    };
    let before = q::issue(tx, id)?;
    if before.kind == "pr" {
        return Ok(Err("a pull request can't become a discussion".into()));
    }
    let at = now.max(before.updated_at.unwrap_or(0));
    let number = q::next_number(tx, repo.id)?;
    q::add_discussion(tx, repo.id, number, id, &before.title)?;
    q::lock_and_close(tx, id, at)?;
    let issue = issue_json(tx, id)?;
    let delivery = |action: &str| {
        let mut p = envelope(&repo, &sender);
        p["action"] = json!(action);
        p["issue"] = issue.clone();
        Delivery::new("issues", p)
    };
    let mut out = vec![delivery("locked")];
    if before.state == "open" {
        out.push(delivery("closed"));
    }
    Ok(Ok((
        json!({ "issue": issue, "discussion": { "number": number } }),
        out,
    )))
}

#[derive(Deserialize)]
pub(crate) struct Archive {
    repo: String,
    archived: bool,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /archive`.
pub(crate) async fn archive(
    State(fake): State<Fake>,
    axum::Json(a): axum::Json<Archive>,
) -> Response {
    run(fake, move |tx, _| archive_in(tx, &a)).await
}

fn archive_in(tx: &Transaction, a: &Archive) -> rusqlite::Result<Moved> {
    let before = match find_repo(tx, &a.repo)? {
        Ok(id) => q::repo(tx, id)?,
        Err(why) => return Ok(Err(why)),
    };
    let sender = match sender(tx, a.login.as_deref())? {
        Ok(s) => s,
        Err(why) => return Ok(Err(why)),
    };
    if before.archived == a.archived {
        let was = if a.archived {
            "archived"
        } else {
            "not archived"
        };
        return Ok(Err(format!("{} is already {was}", a.repo)));
    }
    q::set_repo_archived(tx, before.id, a.archived)?;
    let repo = q::repo(tx, before.id)?;
    let mut p = envelope(&repo, &sender);
    p["action"] = json!(if a.archived { "archived" } else { "unarchived" });
    Ok(Ok((
        json!({ "repository": repo_json(&repo) }),
        vec![Delivery::new("repository", p)],
    )))
}
