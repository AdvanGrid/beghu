//! The REST reads the import makes per repo, with an installation or user token: labels,
//! milestones, issues (PRs among them, as GitHub lists them), an issue's comments and the repo's
//! comments. Pages are GitHub's: `per_page` (at most 100, default 30), `page`, and `Link`
//! headers. A repo the token can't see is a 404, as on GitHub.
//!
//! - `GET /repos/{owner}/{repo}/labels`, and `GET /repos/{owner}/{repo}/labels/{name}` (one, by
//!   name, case-insensitively; 404 without one)
//! - `GET /repos/{owner}/{repo}/milestones?state=open|closed|all`, and
//!   `GET /repos/{owner}/{repo}/milestones/{milestone_number}` (one; 404 without one)
//! - `GET /repos/{owner}/{repo}/issues?state=open|closed|all&sort=updated&direction=asc&since=`:
//!   only `sort=updated` ascending, the order the import pages in. `since` is exclusive, as
//!   GitHub's: only what was updated after it.
//! - `GET /repos/{owner}/{repo}/issues/{number}/comments`
//! - `GET /repos/{owner}/{repo}/issues/comments?sort=updated&direction=asc&since=` (exclusive)
//! - `GET /repos/{owner}/{repo}/issues/comments/{comment_id}`: one comment; 404 when the repo has
//!   no such comment (deleted, say).
//!
//! The lists page by offset, as GitHub's do: an item updated while they're read moves to the end
//! of an `updated` list, and the item after a page boundary slides onto a page already read.

use crate::Fake;
use crate::api::{self, AnyToken, can_see, rfc3339};
use crate::webhooks::{author_association, issue_json, label_json, user_json};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/repos/{owner}/{repo}/labels", get(labels))
        .route("/repos/{owner}/{repo}/labels/{name}", get(one_label))
        .route("/repos/{owner}/{repo}/milestones", get(milestones))
        .route(
            "/repos/{owner}/{repo}/milestones/{number}",
            get(one_milestone),
        )
        .route("/repos/{owner}/{repo}/issues", get(issues))
        .route("/repos/{owner}/{repo}/issues/comments", get(repo_comments))
        .route(
            "/repos/{owner}/{repo}/issues/comments/{comment_id}",
            get(one_comment),
        )
        .route(
            "/repos/{owner}/{repo}/issues/{number}/comments",
            get(issue_comments),
        )
}

#[derive(Deserialize)]
struct Params {
    per_page: Option<i64>,
    page: Option<i64>,
    state: Option<String>,
    since: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
}

impl Params {
    fn per_page(&self) -> i64 {
        self.per_page.unwrap_or(30).clamp(1, 100)
    }

    fn page(&self) -> i64 {
        self.page.unwrap_or(1).max(1)
    }

    fn offset(&self) -> i64 {
        (self.page() - 1) * self.per_page()
    }

    /// `since` as Unix seconds; `Err` for one GitHub would refuse.
    fn since(&self) -> Result<i64, Response> {
        match self.since.as_deref() {
            None => Ok(i64::MIN),
            Some(s) => crate::api::parse_time(s)
                .ok_or_else(|| api::error(StatusCode::UNPROCESSABLE_ENTITY, "Validation Failed")),
        }
    }
}

/// A page of JSON with GitHub's `Link` header: `next` while the page came back full.
fn paged(
    headers: &HeaderMap,
    path: &str,
    p: &Params,
    items: Vec<Value>,
    query: &[(&str, String)],
) -> Response {
    let full = items.len() as i64 == p.per_page();
    let mut res = axum::Json(Value::Array(items)).into_response();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let link = |page: i64, rel: &str| {
        let mut q: Vec<(&str, String)> = query.to_vec();
        q.push(("per_page", p.per_page().to_string()));
        q.push(("page", page.to_string()));
        format!(
            "<http://{host}{path}?{}>; rel=\"{rel}\"",
            serde_urlencoded::to_string(&q).unwrap_or_default()
        )
    };
    let mut links = Vec::new();
    if full {
        links.push(link(p.page() + 1, "next"));
    }
    if p.page() > 1 {
        links.push(link(p.page() - 1, "prev"));
        links.push(link(1, "first"));
    }
    if let Ok(v) = HeaderValue::from_str(&links.join(", "))
        && !links.is_empty()
    {
        res.headers_mut().insert(header::LINK, v);
    }
    res
}

/// The repo `owner/name` if the token can see it; GitHub's 404 if not.
async fn visible_repo(
    fake: &Fake,
    token: AnyToken,
    owner: String,
    name: String,
) -> Result<i64, Response> {
    let AnyToken(token) = token;
    let found = fake
        .state()
        .truth
        .read(move |c| {
            Ok(match q::repo_named(c, &owner, &name)? {
                Some(r) if can_see(c, token, r)? => Some(r),
                _ => None,
            })
        })
        .await
        .map_err(api::internal)?;
    match found {
        Some(r) => Ok(r),
        None => Err(api::not_found().await),
    }
}

async fn labels(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/labels");
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let (limit, offset) = (p.per_page(), p.offset());
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let r = q::repo(c, repo)?;
            Ok(q::repo_labels(c, repo, limit, offset)?
                .iter()
                .map(|l| label_json(&r, l.id, &l.name, &l.color, l.description.as_deref()))
                .collect::<Vec<_>>())
        })
        .await;
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &[]),
        Err(e) => api::internal(e),
    }
}

async fn milestones(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/milestones");
    let (o, n) = (owner.clone(), name.clone());
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let state = p.state.clone().unwrap_or_else(|| "open".into());
    if !matches!(state.as_str(), "open" | "closed" | "all") {
        return api::error(StatusCode::UNPROCESSABLE_ENTITY, "Validation Failed");
    }
    let (limit, offset) = (p.per_page(), p.offset());
    let st = state.clone();
    let read = fake
        .state()
        .truth
        .read(move |c| {
            // Filtered after the page is cut: the fixture's repos have a handful of milestones.
            let all = q::repo_milestones(c, repo, i64::MAX, 0)?;
            Ok(all
                .into_iter()
                .filter(|m| st == "all" || m.state == st)
                .skip(offset as usize)
                .take(limit as usize)
                .map(|m| milestone_json(&format!("{o}/{n}"), &m))
                .collect::<Vec<_>>())
        })
        .await;
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &[("state", state)]),
        Err(e) => api::internal(e),
    }
}

/// A milestone as GitHub's REST API serialises it.
fn milestone_json(full: &str, m: &q::RepoMilestonesRow) -> Value {
    json!({
        "id": m.id,
        "node_id": format!("MI_kw{}", m.id),
        "number": m.number,
        "title": m.title,
        "description": null,
        "state": m.state,
        "due_on": m.due_on.map(rfc3339),
        "created_at": m.updated_at.map(rfc3339),
        "updated_at": m.updated_at.map(rfc3339),
        "closed_at": null,
        "url": format!("https://api.github.com/repos/{full}/milestones/{}", m.number),
        "html_url": format!("https://github.com/{full}/milestone/{}", m.number),
    })
}

async fn one_label(
    State(fake): State<Fake>,
    token: AnyToken,
    Path((owner, name, label)): Path<(String, String, String)>,
) -> Response {
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let r = q::repo(c, repo)?;
            Ok(q::label_by_name(c, repo, &label)?
                .map(|l| label_json(&r, l.id, &l.name, &l.color, l.description.as_deref())))
        })
        .await;
    match read {
        Ok(Some(v)) => axum::Json(v).into_response(),
        Ok(None) => api::not_found().await,
        Err(e) => api::internal(e),
    }
}

async fn one_milestone(
    State(fake): State<Fake>,
    token: AnyToken,
    Path((owner, name, number)): Path<(String, String, i64)>,
) -> Response {
    let full = format!("{owner}/{name}");
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let read = fake
        .state()
        .truth
        .read(move |c| q::repo_milestone(c, repo, number))
        .await;
    match read {
        Ok(Some(m)) => {
            let m = q::RepoMilestonesRow {
                id: m.id,
                number: m.number,
                title: m.title,
                state: m.state,
                due_on: m.due_on,
                updated_at: m.updated_at,
            };
            axum::Json(milestone_json(&full, &m)).into_response()
        }
        Ok(None) => api::not_found().await,
        Err(e) => api::internal(e),
    }
}

async fn issues(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/issues");
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    // The import's order is the one the fake knows.
    if p.sort.as_deref() != Some("updated") || p.direction.as_deref() != Some("asc") {
        return api::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Fake GitHub lists issues only with sort=updated&direction=asc",
        );
    }
    let state = p.state.clone().unwrap_or_else(|| "open".into());
    let (open, closed) = match state.as_str() {
        "open" => (true, false),
        "closed" => (false, true),
        "all" => (true, true),
        _ => return api::error(StatusCode::UNPROCESSABLE_ENTITY, "Validation Failed"),
    };
    let since = match p.since() {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (limit, offset) = (p.per_page(), p.offset());
    let read = fake
        .state()
        .truth
        .read(move |c| {
            q::rest_issues_page(c, repo, open, closed, since, limit, offset)?
                .into_iter()
                .map(|id| issue_json(c, id))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await;
    let mut query = vec![
        ("state", state),
        ("sort", "updated".to_owned()),
        ("direction", "asc".to_owned()),
    ];
    if let Some(s) = &p.since {
        query.push(("since", s.clone()));
    }
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &query),
        Err(e) => api::internal(e),
    }
}

/// A comment, as either list reads it.
struct CommentRow<'a> {
    number: i64,
    id: i64,
    node_id: &'a str,
    author: Option<i64>,
    body: &'a str,
    created: i64,
    updated: i64,
}

/// A comment as GitHub's REST API serialises it.
fn comment_json(
    c: &rusqlite::Connection,
    r: &q::RepoRow,
    x: CommentRow,
) -> rusqlite::Result<Value> {
    let full = format!("{}/{}", r.owner, r.name);
    let (id, number) = (x.id, x.number);
    let user = match x.author.map(|a| q::user_row(c, a)).transpose()?.flatten() {
        Some(u) => user_json(u.id, &u.login, u.avatar_url.as_deref()),
        None => Value::Null,
    };
    Ok(json!({
        "id": id,
        "node_id": x.node_id,
        "url": format!("https://api.github.com/repos/{full}/issues/comments/{id}"),
        "html_url": format!("https://github.com/{full}/issues/{number}#issuecomment-{id}"),
        "issue_url": format!("https://api.github.com/repos/{full}/issues/{number}"),
        "user": user,
        "created_at": rfc3339(x.created),
        "updated_at": rfc3339(x.updated),
        "author_association": author_association(c, r, x.author)?,
        "body": x.body,
    }))
}

async fn issue_comments(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name, number)): Path<(String, String, i64)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/issues/{number}/comments");
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let (limit, offset) = (p.per_page(), p.offset());
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let Some(item) = q::issue_id(c, repo, number)? else {
                return Ok(None);
            };
            let r = q::repo(c, repo)?;
            q::issue_comments_page(c, item, limit, offset)?
                .iter()
                .map(|x| {
                    comment_json(
                        c,
                        &r,
                        CommentRow {
                            number: x.number,
                            id: x.id,
                            node_id: &x.node_id,
                            author: x.author_id,
                            body: &x.body,
                            created: x.created_at,
                            updated: x.updated_at,
                        },
                    )
                })
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(Some)
        })
        .await;
    match read {
        Ok(Some(items)) => paged(&headers, &path, &p, items, &[]),
        Ok(None) => api::not_found().await,
        Err(e) => api::internal(e),
    }
}

async fn repo_comments(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/issues/comments");
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    if p.sort.as_deref() != Some("updated") || p.direction.as_deref() != Some("asc") {
        return api::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Fake GitHub lists comments only with sort=updated&direction=asc",
        );
    }
    let since = match p.since() {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (limit, offset) = (p.per_page(), p.offset());
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let r = q::repo(c, repo)?;
            q::repo_comments_page(c, repo, since, limit, offset)?
                .iter()
                .map(|x| {
                    comment_json(
                        c,
                        &r,
                        CommentRow {
                            number: x.number,
                            id: x.id,
                            node_id: &x.node_id,
                            author: x.author_id,
                            body: &x.body,
                            created: x.created_at,
                            updated: x.updated_at,
                        },
                    )
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await;
    let mut query = vec![
        ("sort", "updated".to_owned()),
        ("direction", "asc".to_owned()),
    ];
    if let Some(s) = &p.since {
        query.push(("since", s.clone()));
    }
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &query),
        Err(e) => api::internal(e),
    }
}

async fn one_comment(
    State(fake): State<Fake>,
    token: AnyToken,
    Path((owner, name, id)): Path<(String, String, i64)>,
) -> Response {
    let repo = match visible_repo(&fake, token, owner, name).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let Some(x) = q::repo_comment(c, repo, id)? else {
                return Ok(None);
            };
            let r = q::repo(c, repo)?;
            comment_json(
                c,
                &r,
                CommentRow {
                    number: x.number,
                    id: x.id,
                    node_id: &x.node_id,
                    author: x.author_id,
                    body: &x.body,
                    created: x.created_at,
                    updated: x.updated_at,
                },
            )
            .map(Some)
        })
        .await;
    match read {
        Ok(Some(v)) => axum::Json(v).into_response(),
        Ok(None) => api::not_found().await,
        Err(e) => api::internal(e),
    }
}
