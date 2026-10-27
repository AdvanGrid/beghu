//! The REST writes beghu makes with a user access token, and the rate-limit endpoint it probes
//! while GitHub is down:
//!
//! - `POST /repos/{owner}/{repo}/issues/{number}/comments {body}`: 201 with the comment.
//! - `PATCH /repos/{owner}/{repo}/issues/{number} {state?, state_reason?, title?, body?,
//!   milestone?}`: 200 with the issue as stored afterwards. `milestone` is the milestone's number
//!   in the repo, or `null` for none; a number the repo doesn't have is a 422. A number
//!   transferred since is a 301 to the new issue, as GitHub documents (and as its `GET` answers).
//! - `GET /rate_limit`: 200 with the caller's quotas (it needs no token, as on GitHub).
//!
//! A write goes through the same change as an outside edit (`edits.rs`), so it sends the same
//! signed webhooks about a second later, with the token's user as the sender.
//!
//! Roles follow what was verified live (`docs/research/saml-sso-and-read-only-access.md`):
//! anyone who can see the repo may comment; closing and reopening needs Triage or authorship,
//! and Read on someone else's issue gets 403; a title or body edit needs Write or authorship,
//! is a 403 for Read on someone else's issue, and is silently dropped (200, unchanged) for
//! Triage. A milestone needs Triage: Read gets 403 on someone else's issue, and on its own the
//! milestone is silently dropped (200, unchanged). A repo the user can't see is a 404, and an
//! archived repo refuses every write with 403. Fields the fake doesn't model on an update
//! (labels, assignees, type) are a loud 422 rather than a silent guess; labels and assignees have
//! their own endpoints (`triage.rs`).

use crate::Fake;
use crate::accounts::Role;
use crate::api::{Token, TokenUser, error, internal};
use crate::edits::Change;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use fake_db::q;
use serde_json::{Value, json};

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route(
            "/repos/{owner}/{repo}/issues/{number}/comments",
            post(create_comment),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}",
            patch(update_issue).get(crate::repos::issue),
        )
        .route("/rate_limit", get(rate_limit))
}

/// GitHub's 403 for a write the user's role doesn't allow: the same body and header as an
/// App-side denial.
pub(crate) fn not_accessible() -> Response {
    let mut res = error(
        StatusCode::FORBIDDEN,
        "Resource not accessible by integration",
    );
    res.headers_mut().insert(
        "x-accepted-github-permissions",
        HeaderValue::from_static("issues=write; pull_requests=write"),
    );
    res
}

pub(crate) fn unprocessable(message: &str) -> Response {
    error(StatusCode::UNPROCESSABLE_ENTITY, message)
}

/// The request body as JSON, or GitHub's 400 for one that isn't.
pub(crate) fn json_body(body: &Bytes) -> Result<serde_json::Map<String, Value>, Response> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(error(StatusCode::BAD_REQUEST, "Problems parsing JSON")),
    }
}

/// The issue a write names, as the user sees it: the repo, the issue's id, and the user's role
/// and authorship. `Err` is the answer GitHub gives instead.
pub(crate) struct Target {
    pub repo: q::RepoRow,
    pub issue: i64,
    /// None: no collaborator role (only possible on a public repo).
    pub role: Option<Role>,
    pub own: bool,
}

/// What a write's route answers for an issue number transferred since: GitHub's REST docs list a
/// 301 for updating an issue and for adding and removing its labels, and none for commenting or
/// for assignees, whose answer is unmeasured (a 404 here, as for a number the repo never had).
pub(crate) enum OnMoved {
    /// 301 to the new issue, named for the request's `Host`.
    Redirect(HeaderMap),
    NotFound,
}

fn target(
    c: &rusqlite::Connection,
    user: i64,
    owner: &str,
    name: &str,
    number: i64,
    on_moved: &OnMoved,
) -> rusqlite::Result<Result<Target, Response>> {
    let not_found = || error(StatusCode::NOT_FOUND, "Not Found");
    let Some(repo) = q::repo_by_full_name(c, owner, name)? else {
        return Ok(Err(not_found()));
    };
    let repo = q::repo(c, repo)?;
    let role = q::permission(c, user, repo.id)?
        .as_deref()
        .and_then(Role::from_name);
    if role.is_none() && repo.private {
        return Ok(Err(not_found()));
    }
    let Some(issue) = q::issue_id(c, repo.id, number)? else {
        if let OnMoved::Redirect(headers) = on_moved
            && let Some(path) = crate::repos::moved_to(c, Token::User(user), repo.id, number)?
        {
            return Ok(Err(crate::repos::moved(headers, &path)));
        }
        return Ok(Err(not_found()));
    };
    if repo.archived {
        return Ok(Err(error(
            StatusCode::FORBIDDEN,
            "Repository was archived so is read-only.",
        )));
    }
    let own = q::issue(c, issue)?.author_id == Some(user);
    Ok(Ok(Target {
        repo,
        issue,
        role,
        own,
    }))
}

/// Runs `change` (built from the target, inside the truth's transaction) as `user` and sends its
/// webhooks; the change's result as `answer` makes it, or the refusal `change` returned.
pub(crate) async fn write(
    fake: &Fake,
    user: i64,
    path: (String, String, i64),
    on_moved: OnMoved,
    change: impl FnOnce(&rusqlite::Transaction, &Target) -> rusqlite::Result<Result<Change, Response>>
    + Send
    + 'static,
    answer: impl FnOnce(&crate::edits::Changed) -> Response + Send + 'static,
) -> Response {
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let (owner, name, number) = path;
            let t = match target(tx, user, &owner, &name, number, &on_moved)? {
                Ok(t) => t,
                Err(res) => return Ok(Err(res)),
            };
            let change = match change(tx, &t)? {
                Ok(c) => c,
                Err(res) => return Ok(Err(res)),
            };
            Ok(match change.apply(tx, &t.repo, t.issue, user, now)? {
                Some(changed) => Ok(changed),
                None => Err(error(StatusCode::UNAUTHORIZED, "Bad credentials")),
            })
        })
        .await;
    match done {
        Ok(Ok(changed)) => {
            let res = answer(&changed);
            fake.state().webhooks.send(changed.deliveries);
            res
        }
        Ok(Err(res)) => res,
        Err(e) => internal(e),
    }
}

async fn create_comment(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    body: Bytes,
) -> Response {
    let body = match json_body(&body) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let Some(text) = body.get("body").and_then(Value::as_str).map(str::to_owned) else {
        return unprocessable("Validation Failed");
    };
    write(
        &fake,
        user,
        path,
        OnMoved::NotFound,
        move |_, _| {
            Ok(Ok(Change {
                comment: Some(text),
                ..Change::default()
            }))
        },
        |changed| {
            let c = changed.comment.clone().unwrap_or(Value::Null);
            let mut res = (StatusCode::CREATED, axum::Json(&c)).into_response();
            if let Some(Ok(v)) = c["url"].as_str().map(HeaderValue::from_str) {
                res.headers_mut().insert(header::LOCATION, v);
            }
            res
        },
    )
    .await
}

/// The fields of an issue update the fake models.
const MODELLED: [&str; 5] = ["state", "state_reason", "title", "body", "milestone"];

async fn update_issue(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path(path): Path<(String, String, i64)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match json_body(&body) {
        Ok(b) => b,
        Err(res) => return res,
    };
    if let Some(k) = body.keys().find(|k| !MODELLED.contains(&k.as_str())) {
        return unprocessable(&format!(
            "fake GitHub doesn't model `{k}` on an issue update yet"
        ));
    }
    let text = |k: &str| -> Result<Option<String>, Response> {
        match body.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(unprocessable("Validation Failed")),
        }
    };
    let fields = (|| {
        Ok((
            text("state")?,
            text("state_reason")?,
            text("title")?,
            text("body")?,
        ))
    })();
    let (state, state_reason, title, issue_body) = match fields {
        Ok(f) => f,
        Err(res) => return res,
    };
    // Absent: unchanged; `null`: none; else a milestone number.
    let milestone = match body.get("milestone") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => match v.as_i64() {
            Some(n) => Some(Some(n)),
            None => return unprocessable("Validation Failed"),
        },
    };
    if state
        .as_deref()
        .is_some_and(|s| !matches!(s, "open" | "closed"))
        || state_reason
            .as_deref()
            .is_some_and(|r| !matches!(r, "completed" | "not_planned" | "reopened" | "duplicate"))
    {
        return unprocessable("Validation Failed");
    }
    write(
        &fake,
        user,
        path,
        OnMoved::Redirect(headers),
        move |tx, t| {
            let triage = t.role >= Some(Role::Triage);
            let write = t.role >= Some(Role::Write);
            let touches_state = state.is_some() || state_reason.is_some();
            let touches_text = title.is_some() || issue_body.is_some();
            // Read on someone else's issue: refused outright.
            if !t.own && !triage && (touches_state || touches_text || milestone.is_some()) {
                return Ok(Err(not_accessible()));
            }
            let milestone = match milestone {
                Some(Some(n)) => match q::milestone_by_number(tx, t.repo.id, n)? {
                    Some(id) => Some(Some(id)),
                    None => return Ok(Err(unprocessable("Validation Failed"))),
                },
                m => m.map(|_| None),
            };
            // Triage on someone else's issue: the text is silently dropped. Read on its own
            // issue: the milestone is.
            let text_applies = t.own || write;
            Ok(Ok(Change {
                state,
                state_reason,
                title: title.filter(|_| text_applies),
                body: issue_body.filter(|_| text_applies),
                milestone: milestone.filter(|_| triage),
                ..Change::default()
            }))
        },
        |changed| axum::Json(&changed.issue).into_response(),
    )
    .await
}

/// The core rate limit at `now` on the fake's clock: the fake counts no calls against it.
pub(crate) struct CoreLimit {
    pub limit: i64,
    pub used: i64,
    pub reset: i64,
}

impl CoreLimit {
    pub fn at(now: i64) -> CoreLimit {
        CoreLimit {
            limit: 5000,
            used: 0,
            reset: now + 3600,
        }
    }

    pub fn remaining(&self) -> i64 {
        self.limit - self.used
    }
}

/// `GET /rate_limit`: the caller's quotas (`quota.rs`), or fresh ones without a token. It
/// costs nothing.
async fn rate_limit(State(fake): State<Fake>, headers: axum::http::HeaderMap) -> Response {
    let now = fake.now();
    let fresh = || {
        let c = CoreLimit::at(now);
        json!({ "limit": c.limit, "used": c.used, "remaining": c.remaining(), "reset": c.reset })
    };
    let (core, graphql) = match crate::quota::owner(&fake, &headers).await {
        Some(owner) => {
            let q = &fake.state().quotas;
            (
                json!(q.peek(&owner, crate::quota::Resource::Core, now)),
                json!(q.peek(&owner, crate::quota::Resource::Graphql, now)),
            )
        }
        None => (fresh(), fresh()),
    };
    axum::Json(json!({
        "resources": { "core": core, "graphql": graphql, "search": fresh() },
        "rate": core,
    }))
    .into_response()
}
