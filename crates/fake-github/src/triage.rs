//! The REST writes for an issue's labels and assignees, made with a user access token:
//!
//! - `POST /repos/{owner}/{repo}/issues/{number}/labels {labels: [name…]}` (or a bare array of
//!   names): adds them; 200 with every label the issue has afterwards. A name the repo has no
//!   label for is a loud 422: GitHub would create the label, which the fake doesn't model.
//! - `DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}`: 200 with the labels left; 404
//!   "Label does not exist" (GitHub's observed body, not a documented one) if the issue doesn't
//!   have it, where an issue or repo the user can't see is a plain "Not Found".
//! - `POST /repos/{owner}/{repo}/issues/{number}/assignees {assignees: [login…]}`: adds them;
//!   201 with the issue. Users already assigned stay, and a login that can't be assigned in the
//!   repo is silently ignored, as GitHub documents.
//! - `DELETE /repos/{owner}/{repo}/issues/{number}/assignees {assignees: [login…]}`: 200 with
//!   the issue.
//!
//! Each sends what GitHub sends: an `issues` `labeled`/`unlabeled`/`assigned`/`unassigned`
//! delivery per label or user that changed, about a second later. Roles follow what was
//! verified live (`docs/research/saml-sso-and-read-only-access.md`): all four need Triage, and
//! Read gets 403 even on its own issues.
//!
//! Who can be assigned (`GET /repos/{owner}/{repo}/assignees` lists them, in `repos.rs`): GitHub
//! documents anyone with write access and the org's members with read access, read from the
//! truth's permissions (the fixture's teammates have theirs: see `accounts.rs`). Being assigned
//! already makes no one assignable.

use crate::Fake;
use crate::accounts::Role;
use crate::api::{TokenUser, error, error_documented};
use crate::edits::Change;
use crate::writes::{Target, json_body, not_accessible, unprocessable, write};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post};
use fake_db::q;
use serde_json::Value;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route(
            "/repos/{owner}/{repo}/issues/{number}/labels",
            post(add_labels),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/labels/{name}",
            delete(remove_label),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/assignees",
            post(add_assignees).delete(remove_assignees),
        )
}

/// A user who can be assigned to the repo's issues.
pub(crate) struct Assignable {
    pub id: i64,
    pub login: String,
    pub avatar_url: Option<String>,
}

/// Everyone who can be assigned to the repo's issues, by login (see the module's docs).
pub(crate) fn assignable(
    c: &rusqlite::Connection,
    r: &q::RepoRow,
) -> rusqlite::Result<Vec<Assignable>> {
    let org = r.owner_type.as_deref().unwrap_or("Organization") == "Organization";
    let mut out: Vec<Assignable> = Vec::new();
    for m in q::repo_members(c, r.id)? {
        let member = org
            && crate::ACCOUNTS
                .iter()
                .any(|a| a.member && a.login == m.login);
        let owner = !org && m.login.eq_ignore_ascii_case(&r.owner);
        let writes = Role::from_name(&m.role) >= Some(Role::Write);
        if member || owner || writes {
            out.push(Assignable {
                id: m.id,
                login: m.login,
                avatar_url: m.avatar_url,
            });
        }
    }
    out.sort_by_key(|a| a.login.to_lowercase());
    Ok(out)
}

/// The names a write lists under `key` (or as a bare array, where GitHub takes one); `Err` is
/// GitHub's answer to a body it can't take.
fn names(body: &Bytes, key: &str, bare: bool) -> Result<Vec<String>, Response> {
    let list = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Array(a)) if bare => a,
        Ok(_) => match json_body(body)?.remove(key) {
            Some(Value::Array(a)) => a,
            _ => return Err(unprocessable("Validation Failed")),
        },
        Err(_) => return Err(error(StatusCode::BAD_REQUEST, "Problems parsing JSON")),
    };
    list.into_iter()
        .map(|v| match v {
            Value::String(s) => Ok(s),
            _ => Err(unprocessable("Validation Failed")),
        })
        .collect()
}

/// Labels and assignees need Triage, even on the user's own issue.
fn triage(t: &Target) -> Result<(), Response> {
    if t.role >= Some(Role::Triage) {
        Ok(())
    } else {
        Err(not_accessible())
    }
}

async fn add_labels(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let wanted = match names(&body, "labels", true) {
        Ok(n) if n.is_empty() => {
            return unprocessable("fake GitHub doesn't model adding no labels");
        }
        Ok(n) => n,
        Err(res) => return res,
    };
    write(
        &fake,
        user,
        path,
        move |tx, t| {
            if let Err(res) = triage(t) {
                return Ok(Err(res));
            }
            let mut add_labels = Vec::new();
            for name in &wanted {
                match q::label_by_name(tx, t.repo.id, name)? {
                    Some(l) => add_labels.push(l),
                    None => {
                        return Ok(Err(unprocessable(&format!(
                            "fake GitHub doesn't model creating the label {name:?} by adding it"
                        ))));
                    }
                }
            }
            Ok(Ok(Change {
                add_labels,
                ..Change::default()
            }))
        },
        |changed| axum::Json(&changed.issue["labels"]).into_response(),
    )
    .await
}

/// GitHub's 404 for removing a label the issue doesn't have, with the body it was observed to
/// send (not a documented one).
fn no_such_label() -> Response {
    error_documented(
        StatusCode::NOT_FOUND,
        "Label does not exist",
        "https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue",
    )
}

async fn remove_label(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path((owner, repo, number, name)): Path<(String, String, i64, String)>,
) -> Response {
    write(
        &fake,
        user,
        (owner, repo, number),
        move |tx, t| {
            if let Err(res) = triage(t) {
                return Ok(Err(res));
            }
            let on = q::issue_labels(tx, t.issue)?
                .into_iter()
                .find(|l| l.name.eq_ignore_ascii_case(&name));
            let Some(on) = on else {
                return Ok(Err(no_such_label()));
            };
            let Some(label) = q::label_by_name(tx, t.repo.id, &on.name)? else {
                return Ok(Err(no_such_label()));
            };
            Ok(Ok(Change {
                remove_labels: vec![label],
                ..Change::default()
            }))
        },
        |changed| axum::Json(&changed.issue["labels"]).into_response(),
    )
    .await
}

async fn add_assignees(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    assignees(fake, user, path, body, true).await
}

async fn remove_assignees(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    assignees(fake, user, path, body, false).await
}

/// Assigns (`add`) or unassigns the logins the body names; the issue afterwards, 201 or 200.
async fn assignees(
    fake: Fake,
    user: i64,
    path: (String, String, i64),
    body: Bytes,
    add: bool,
) -> Response {
    let logins = match names(&body, "assignees", false) {
        Ok(n) => n,
        Err(res) => return res,
    };
    write(
        &fake,
        user,
        path,
        move |tx, t| {
            if let Err(res) = triage(t) {
                return Ok(Err(res));
            }
            let can = if add {
                assignable(tx, &t.repo)?
            } else {
                Vec::new()
            };
            let mut ids = Vec::new();
            for login in &logins {
                let Some(u) = q::user_by_login(tx, login)? else {
                    continue;
                };
                if !add || can.iter().any(|a| a.id == u.id) {
                    ids.push(u.id);
                }
            }
            Ok(Ok(if add {
                Change {
                    add_assignees: ids,
                    ..Change::default()
                }
            } else {
                Change {
                    remove_assignees: ids,
                    ..Change::default()
                }
            }))
        },
        move |changed| {
            let status = if add {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, axum::Json(&changed.issue)).into_response()
        },
    )
    .await
}
