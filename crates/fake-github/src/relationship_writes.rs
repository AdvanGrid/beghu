//! The REST writes for an issue's relationships, made with a user access token, as GitHub
//! documents them (docs/research/github-relationship-apis.md). Each path names the issue whose
//! side is written; the body names the other issue by its database id:
//!
//! - `POST /repos/{owner}/{repo}/issues/{number}/sub_issues {sub_issue_id, replace_parent?}`:
//!   201 with the parent. The new sub-issue goes last. With `replace_parent`, a sub-issue of
//!   another parent moves here (its old parent's link goes first, with its deliveries).
//! - `DELETE /repos/{owner}/{repo}/issues/{number}/sub_issue {sub_issue_id}`: 200 with the
//!   parent; 404 when it isn't a sub-issue of this one (measured).
//! - `PATCH /repos/{owner}/{repo}/issues/{number}/sub_issues/priority {sub_issue_id, after_id |
//!   before_id}`: 200 with the parent, the sub-issue moved after or before that sibling. Both is
//!   GitHub's 422 (measured). It sends nothing: GitHub has no webhook or event for a reorder.
//! - `POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by {issue_id}`: 201 with
//!   the blocked issue (the one in the path).
//! - `DELETE /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by/{issue_id}`: 200 with
//!   the blocked issue, whether or not it was blocked by that one (measured: idempotent).
//! - `POST /repos/{owner}/{repo}/issues/{number}/relates_to {issue_id}`: 201 with the issue.
//! - `DELETE /repos/{owner}/{repo}/issues/{number}/relates_to/{issue_id}`: 200 with the issue,
//!   whether or not they were related (measured); 404 for an id that isn't an issue.
//!
//! GitHub's refusals are `relationships.rs`'s, as 422s with its messages: a link to itself, a
//! duplicate, a second parent, a loop, nesting past 8 levels, a 101st sub-issue and a 51st
//! dependency. Each change sends the deliveries an outside edit's does (`relationships.rs`),
//! with the token's user as the sender.
//!
//! Roles follow what was verified live (`docs/research/saml-sso-and-read-only-access.md`): every
//! one of these needs Triage on the path's repo, and Read gets 403 even when every issue involved
//! is its own. Whether a cross-repo link needs Triage on the other repo too is unmeasured: the
//! fake asks only that the user can see the other issue (a 404 otherwise, as for an id that
//! doesn't exist). A repo the user can't see is a 404, an archived one a 403.
//!
//! Unmeasured and chosen here: a priority call naming a sub-issue that isn't this issue's is a
//! 404 (as a removal's is), one naming neither `after_id` nor `before_id`, or a sibling that isn't
//! one, a 422; `replace_parent` naming the sub-issue's own parent is the one-parent 422.

use crate::Fake;
use crate::accounts::Role;
use crate::api::{TokenUser, error, internal};
use crate::relationships::{self, Kind};
use crate::webhooks::{issue_json, user_json};
use crate::writes::{OnMoved, json_body, not_accessible, target, unprocessable};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, patch, post};
use fake_db::q;
use serde_json::Value;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route(
            "/repos/{owner}/{repo}/issues/{number}/sub_issues",
            post(sub_add),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/sub_issue",
            delete(sub_remove),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/sub_issues/priority",
            patch(sub_priority),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by",
            post(blocked_by_add),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by/{issue_id}",
            delete(blocked_by_remove),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/relates_to",
            post(relates_add),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/relates_to/{issue_id}",
            delete(relates_remove),
        )
}

/// What a write asks of the path's issue.
#[derive(Clone, Copy)]
enum Ask {
    /// Add `other` as a sub-issue, moving it from another parent if `replace`.
    SubAdd {
        other: i64,
        replace: bool,
    },
    SubRemove {
        other: i64,
    },
    /// Move sub-issue `other` after `after`, or before `before`.
    Priority {
        other: i64,
        after: Option<i64>,
        before: Option<i64>,
    },
    /// The path's issue is blocked by `other`.
    BlockedBy {
        other: i64,
        add: bool,
    },
    Relates {
        other: i64,
        add: bool,
    },
}

impl Ask {
    fn other(&self) -> i64 {
        match self {
            Ask::SubAdd { other, .. }
            | Ask::SubRemove { other }
            | Ask::Priority { other, .. }
            | Ask::BlockedBy { other, .. }
            | Ask::Relates { other, .. } => *other,
        }
    }

    /// 201 for an addition, 200 otherwise.
    fn status(&self) -> StatusCode {
        match self {
            Ask::SubAdd { .. }
            | Ask::BlockedBy { add: true, .. }
            | Ask::Relates { add: true, .. } => StatusCode::CREATED,
            _ => StatusCode::OK,
        }
    }
}

/// An integer field of a body, or GitHub's 422 for one that's missing or isn't one.
fn int(body: &serde_json::Map<String, Value>, key: &str) -> Result<i64, Response> {
    body.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| unprocessable("Validation Failed"))
}

/// The body's JSON, as `make` reads it into an ask.
fn ask_of(
    body: &Bytes,
    make: impl FnOnce(&serde_json::Map<String, Value>) -> Result<Ask, Response>,
) -> Result<Ask, Response> {
    make(&json_body(body)?)
}

async fn sub_add(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let ask = ask_of(&body, |b| {
        Ok(Ask::SubAdd {
            other: int(b, "sub_issue_id")?,
            replace: b
                .get("replace_parent")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    });
    run(fake, user, path, ask).await
}

async fn sub_remove(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let ask = ask_of(&body, |b| {
        Ok(Ask::SubRemove {
            other: int(b, "sub_issue_id")?,
        })
    });
    run(fake, user, path, ask).await
}

async fn sub_priority(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let ask = ask_of(&body, |b| {
        let (after, before) = (
            b.get("after_id").and_then(Value::as_i64),
            b.get("before_id").and_then(Value::as_i64),
        );
        match (after, before) {
            (Some(_), Some(_)) => Err(unprocessable(
                "Only the before_id or the after_id argument may be provided, but not both",
            )),
            (None, None) => Err(unprocessable("Validation Failed")),
            _ => Ok(Ask::Priority {
                other: int(b, "sub_issue_id")?,
                after,
                before,
            }),
        }
    });
    run(fake, user, path, ask).await
}

async fn blocked_by_add(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let ask = ask_of(&body, |b| {
        Ok(Ask::BlockedBy {
            other: int(b, "issue_id")?,
            add: true,
        })
    });
    run(fake, user, path, ask).await
}

async fn blocked_by_remove(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path((owner, repo, number, other)): Path<(String, String, i64, i64)>,
) -> Response {
    let ask = Ok(Ask::BlockedBy { other, add: false });
    run(fake, user, (owner, repo, number), ask).await
}

async fn relates_add(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let ask = ask_of(&body, |b| {
        Ok(Ask::Relates {
            other: int(b, "issue_id")?,
            add: true,
        })
    });
    run(fake, user, path, ask).await
}

async fn relates_remove(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path((owner, repo, number, other)): Path<(String, String, i64, i64)>,
) -> Response {
    let ask = Ok(Ask::Relates { other, add: false });
    run(fake, user, (owner, repo, number), ask).await
}

/// Makes `ask` on the path's issue as `user`, inside the truth's transaction, and sends its
/// deliveries: GitHub's answer, or its refusal.
async fn run(
    fake: Fake,
    user: i64,
    path: (String, String, i64),
    ask: Result<Ask, Response>,
) -> Response {
    let ask = match ask {
        Ok(a) => a,
        Err(res) => return res,
    };
    let status = ask.status();
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let (owner, name, number) = path;
            let t = match target(tx, user, &owner, &name, number, &OnMoved::NotFound)? {
                Ok(t) => t,
                Err(res) => return Ok(Err(res)),
            };
            // Triage, even on the user's own issues.
            if t.role < Some(Role::Triage) {
                return Ok(Err(not_accessible()));
            }
            let not_found = || Ok(Err(error(StatusCode::NOT_FOUND, "Not Found")));
            let Some(other) = q::item_place(tx, ask.other())? else {
                return not_found();
            };
            if other.kind != "issue" || !q::repo_visible(tx, other.repo_id, None, Some(user))? {
                return not_found();
            }
            if other.id == t.issue {
                return Ok(Err(unprocessable(
                    "Target issue cannot be the same as the source issue",
                )));
            }
            let Some(sender) = q::user_row(tx, user)? else {
                return Ok(Err(error(StatusCode::UNAUTHORIZED, "Bad credentials")));
            };
            let sender = user_json(sender.id, &sender.login, sender.avatar_url.as_deref());
            let (id, other) = (t.issue, other.id);
            let changes = match &ask {
                Ask::Priority { after, before, .. } => {
                    if let Err(res) = prioritize(tx, id, other, *after, *before)? {
                        return Ok(Err(res));
                    }
                    return Ok(Ok((issue_json(tx, id)?, Vec::new())));
                }
                Ask::SubAdd { replace, .. } => {
                    relationships::plan_one(tx, id, Kind::Sub, true, (id, other), *replace)?
                }
                Ask::SubRemove { .. } => {
                    relationships::plan_one(tx, id, Kind::Sub, false, (id, other), false)?
                }
                Ask::BlockedBy { add, .. } => {
                    relationships::plan_one(tx, id, Kind::Blocks, *add, (other, id), false)?
                }
                Ask::Relates { add, .. } => relationships::plan_one(
                    tx,
                    id,
                    Kind::Relates,
                    *add,
                    (id.min(other), id.max(other)),
                    false,
                )?,
            };
            let changes = match changes {
                Ok(c) => c,
                // GitHub's 404 for a sub-issue that isn't one; every other refusal is a 422.
                Err(why) if matches!(ask, Ask::SubRemove { .. }) => {
                    return Ok(Err(error(StatusCode::NOT_FOUND, &why)));
                }
                Err(why) => return Ok(Err(unprocessable(&why))),
            };
            let deliveries = relationships::apply(tx, &changes, &sender, now)?;
            Ok(Ok((issue_json(tx, id)?, deliveries)))
        })
        .await;
    match done {
        Ok(Ok((issue, deliveries))) => {
            fake.state().webhooks.send(deliveries);
            (status, axum::Json(issue)).into_response()
        }
        Ok(Err(res)) => res,
        Err(e) => internal(e),
    }
}

/// Moves sub-issue `child` of `parent` after `after` or before `before`, one of its siblings,
/// numbering the parent's sub-issues 1..n in their new order; GitHub's refusal if it can't.
fn prioritize(
    tx: &rusqlite::Transaction,
    parent: i64,
    child: i64,
    after: Option<i64>,
    before: Option<i64>,
) -> rusqlite::Result<Result<(), Response>> {
    let mut order: Vec<i64> = q::sub_issues(tx, parent)?;
    if !order.contains(&child) {
        return Ok(Err(error(StatusCode::NOT_FOUND, "Not Found")));
    }
    order.retain(|&c| c != child);
    let sibling = after.or(before).unwrap_or_default();
    let Some(at) = order.iter().position(|&c| c == sibling) else {
        return Ok(Err(unprocessable("Validation Failed")));
    };
    order.insert(if after.is_some() { at + 1 } else { at }, child);
    for (i, c) in order.iter().enumerate() {
        q::set_sub_position(tx, parent, *c, (i + 1) as f64)?;
    }
    Ok(Ok(()))
}
