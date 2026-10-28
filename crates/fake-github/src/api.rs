//! The REST endpoints beghu calls with a user access token: the user, the installations and
//! repos it can see, and one repo, each repo with the user's `permissions` (the role).

use crate::Fake;
use crate::accounts::Role;
use axum::Router;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};

const DOCS: &str = "https://docs.github.com/rest";

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/user", get(user))
        .route("/user/installations", get(installations))
        .route(
            "/user/installations/{installation_id}/repositories",
            get(installation_repos),
        )
        .route("/repos/{owner}/{repo}", get(repo))
}

/// GitHub's error body.
pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    error_documented(status, message, DOCS)
}

/// GitHub's error body, with the `documentation_url` GitHub sends for this error.
pub(crate) fn error_documented(status: StatusCode, message: &str, docs: &str) -> Response {
    (
        status,
        axum::Json(json!({
            "message": message,
            "documentation_url": docs,
            "status": status.as_str(),
        })),
    )
        .into_response()
}

pub(crate) async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Not Found")
}

pub(crate) fn internal(e: impl std::fmt::Display) -> Response {
    eprintln!("fake-github: {e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "Server Error")
}

/// The user id behind the request's `Authorization: Bearer|token <ghu_…>`. Extracting it answers
/// GitHub's 401 when there's no live access token.
pub(crate) struct TokenUser(pub i64);

impl FromRequestParts<Fake> for TokenUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, fake: &Fake) -> Result<Self, Response> {
        authenticate(fake, &parts.headers).await.map(TokenUser)
    }
}

/// What a request's token can read: a user's (their repos) or an App installation's (its repos).
#[derive(Debug, Clone, Copy)]
pub(crate) enum Token {
    User(i64),
    Installation(i64),
}

/// The request's `Authorization: Bearer|token <ghu_…|ghs_…>`. Extracting it answers GitHub's
/// 401 when there's no live token of either kind.
pub(crate) struct AnyToken(pub Token);

impl FromRequestParts<Fake> for AnyToken {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, fake: &Fake) -> Result<Self, Response> {
        let Some(token) = bearer(&parts.headers) else {
            return Err(error(StatusCode::UNAUTHORIZED, "Requires authentication"));
        };
        if token.starts_with("ghs_") {
            let now = fake.now();
            return fake
                .state()
                .truth
                .read(move |c| q::installation_token(c, &token, now))
                .await
                .map_err(internal)?
                .map(|i| AnyToken(Token::Installation(i)))
                .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Bad credentials"));
        }
        authenticate(fake, &parts.headers)
            .await
            .map(|u| AnyToken(Token::User(u)))
    }
}

/// Whether `token` can read the repo: a public repo anyone can; a private one, the users given
/// access to it and the installation it belongs to.
pub(crate) fn can_see(
    c: &rusqlite::Connection,
    token: Token,
    repo_id: i64,
) -> rusqlite::Result<bool> {
    let r = q::repo(c, repo_id)?;
    if !r.private {
        return Ok(true);
    }
    Ok(match token {
        Token::User(u) => q::permission(c, u, repo_id)?.is_some(),
        Token::Installation(i) => r.installation_id == Some(i),
    })
}

/// The token in `Authorization: Bearer|token <token>`.
pub(crate) fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
                .or_else(|| v.strip_prefix("token "))
        })
        .map(str::to_owned)
}

async fn authenticate(fake: &Fake, headers: &HeaderMap) -> Result<i64, Response> {
    let token = bearer(headers);
    let Some(token) = token else {
        return Err(error(StatusCode::UNAUTHORIZED, "Requires authentication"));
    };
    let now = fake.now();
    fake.state()
        .truth
        .read(move |c| q::access_token_user(c, &token, now))
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Bad credentials"))
}

fn user_json(id: i64, login: &str, name: Option<&str>, avatar_url: Option<&str>) -> Value {
    json!({
        "login": login,
        "id": id,
        "node_id": format!("U_kg{id}"),
        "avatar_url": avatar_url,
        "html_url": format!("https://github.com/{login}"),
        "url": format!("https://api.github.com/users/{login}"),
        "type": "User",
        "user_view_type": "public",
        "site_admin": false,
        "name": name,
    })
}

async fn user(State(fake): State<Fake>, TokenUser(id): TokenUser) -> Response {
    match fake.state().truth.read(move |c| q::user(c, id)).await {
        Ok(Some(u)) => axum::Json(user_json(
            u.id,
            &u.login,
            u.name.as_deref(),
            u.avatar_url.as_deref(),
        ))
        .into_response(),
        Ok(None) => error(StatusCode::UNAUTHORIZED, "Bad credentials"),
        Err(e) => internal(e),
    }
}

pub(crate) const EVENTS: [&str; 10] = [
    "issues",
    "issue_comment",
    "label",
    "milestone",
    "pull_request",
    "pull_request_review",
    "sub_issues",
    "issue_dependencies",
    "issue_relates_to",
    "repository",
];

/// `secs` since the Unix epoch as an RFC 3339 UTC timestamp, as GitHub writes times.
pub fn rfc3339(secs: i64) -> String {
    // Days from the civil calendar (Howard Hinnant's algorithm).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// An RFC 3339 timestamp (`2026-10-13T08:22:19Z`, or with an offset or fractional seconds) as
/// Unix seconds, as GitHub reads `since`.
pub(crate) fn parse_time(s: &str) -> Option<i64> {
    if !s.is_ascii() {
        return None;
    }
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> { s.get(from..from + len)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hh, mm, ss) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        rest = frac.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "Z" | "z" | "" => 0,
        o if o.len() == 6 => {
            let sign = match &o[..1] {
                "+" => 1,
                "-" => -1,
                _ => return None,
            };
            sign * (o[1..3].parse::<i64>().ok()? * 3600 + o[4..6].parse::<i64>().ok()? * 60)
        }
        _ => return None,
    };
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

/// `GET /user/installations`, paged by `per_page` (at most 100) and `page`, with `Link`.
async fn installations(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    headers: HeaderMap,
    Query(paging): Query<Paging>,
) -> Response {
    let per_page = paging.per_page.unwrap_or(30).clamp(1, 100);
    let page = paging.page.unwrap_or(1).max(1);
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let rows = q::user_installations(c, user)?;
            let mut out = Vec::new();
            for i in rows {
                let by = match i.suspended_at {
                    Some(_) => q::user_row(c, i.account_id)?,
                    None => None,
                };
                out.push((i, by));
            }
            Ok(out)
        })
        .await;
    let rows = match read {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let total = rows.len() as i64;
    let list: Vec<Value> = rows
        .iter()
        .skip(((page - 1) * per_page) as usize)
        .take(per_page as usize)
        .map(|(i, by)| {
            json!({
                "id": i.id,
                "client_id": fake.state().cfg.client_id,
                "account": {
                    "login": i.account_login,
                    "id": i.account_id,
                    "node_id": format!("O_kg{}", i.account_id),
                    "type": i.account_type,
                    "html_url": format!("https://github.com/{}", i.account_login),
                },
                "repository_selection": "all",
                "access_tokens_url": format!("https://api.github.com/app/installations/{}/access_tokens", i.id),
                "repositories_url": "https://api.github.com/installation/repositories",
                "html_url": format!("https://github.com/organizations/{}/settings/installations/{}", i.account_login, i.id),
                "app_id": 1_000_001,
                "app_slug": "beghu-dev",
                "target_id": i.account_id,
                "target_type": i.account_type,
                "permissions": crate::app::permissions(),
                "events": EVENTS,
                "created_at": rfc3339(i.created_at),
                "updated_at": rfc3339(i.suspended_at.unwrap_or(i.created_at)),
                "single_file_name": null,
                "has_multiple_single_files": false,
                "single_file_paths": [],
                "suspended_by": by.as_ref().map(|u| json!({ "login": u.login, "id": u.id, "type": "User" })),
                "suspended_at": i.suspended_at.map(rfc3339),
            })
        })
        .collect();
    let mut res =
        axum::Json(json!({ "total_count": total, "installations": list })).into_response();
    link_pages(
        &mut res,
        &headers,
        "/user/installations",
        per_page,
        page,
        total,
    );
    res
}

#[derive(Deserialize)]
struct Paging {
    per_page: Option<i64>,
    page: Option<i64>,
}

/// GitHub's `permissions` for a role.
fn permissions(role: Role) -> Value {
    json!({
        "admin": role >= Role::Admin,
        "maintain": role >= Role::Maintain,
        "push": role >= Role::Write,
        "triage": role >= Role::Triage,
        "pull": true,
    })
}

/// GitHub's repo object, as the repo endpoints answer it, with the user's `permissions`.
fn repo_json(
    id: i64,
    node_id: &str,
    owner: &str,
    name: &str,
    private: bool,
    archived: bool,
    role: Role,
) -> Value {
    let full = format!("{owner}/{name}");
    json!({
        "id": id,
        "node_id": node_id,
        "name": name,
        "full_name": full,
        "private": private,
        "visibility": if private { "private" } else { "public" },
        "owner": { "login": owner, "type": "Organization" },
        "html_url": format!("https://github.com/{full}"),
        "url": format!("https://api.github.com/repos/{full}"),
        "archived": archived,
        "disabled": false,
        "has_issues": true,
        "permissions": permissions(role),
    })
}

/// `GET /repos/{owner}/{repo}`: the repo with the user's permissions on it. A private repo the
/// user has no role on is a 404; on a public one they can read.
async fn repo(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    Path((owner, name)): Path<(String, String)>,
) -> Response {
    let read = fake
        .state()
        .truth
        .read(move |c| {
            // Any repo GitHub has, a public one the App isn't installed on included.
            let Some(id) = q::any_repo_by_full_name(c, &owner, &name)? else {
                return Ok(None);
            };
            Ok(Some((q::repo(c, id)?, q::permission(c, user, id)?)))
        })
        .await;
    let (r, role) = match read {
        Ok(Some(found)) => found,
        Ok(None) => return not_found().await,
        Err(e) => return internal(e),
    };
    let role = match role.as_deref().map(Role::from_name) {
        Some(Some(role)) => role,
        Some(None) => return internal(format!("repo {} has an unknown role {role:?}", r.id)),
        None if r.private => return not_found().await,
        None => Role::Read,
    };
    axum::Json(repo_json(
        r.id, &r.node_id, &r.owner, &r.name, r.private, r.archived, role,
    ))
    .into_response()
}

async fn installation_repos(
    State(fake): State<Fake>,
    TokenUser(user): TokenUser,
    headers: HeaderMap,
    Path(installation): Path<i64>,
    Query(paging): Query<Paging>,
) -> Response {
    let per_page = paging.per_page.unwrap_or(30).clamp(1, 100);
    let page = paging.page.unwrap_or(1).max(1);
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let total = q::user_installation_repo_count(c, user, installation)?;
            let rows =
                q::user_installation_repos(c, user, installation, per_page, (page - 1) * per_page)?;
            Ok((total, rows))
        })
        .await;
    let (total, rows) = match read {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    if total == 0 {
        return not_found().await;
    }
    let repos: Result<Vec<Value>, String> = rows
        .iter()
        .map(|r| {
            let role = Role::from_name(&r.role)
                .ok_or_else(|| format!("repo {} has an unknown role {:?}", r.id, r.role))?;
            Ok(repo_json(
                r.id, &r.node_id, &r.owner, &r.name, r.private, r.archived, role,
            ))
        })
        .collect();
    let repos = match repos {
        Ok(repos) => repos,
        Err(e) => return internal(e),
    };
    let mut res = axum::Json(json!({
        "total_count": total,
        "repository_selection": "all",
        "repositories": repos,
    }))
    .into_response();
    link_pages(
        &mut res,
        &headers,
        &format!("/user/installations/{installation}/repositories"),
        per_page,
        page,
        total,
    );
    res
}

/// GitHub's `Link` header for page `page` of `total` items, `per_page` each, at `path`. Links
/// point back at the fake, wherever the caller reached it.
fn link_pages(
    res: &mut Response,
    headers: &HeaderMap,
    path: &str,
    per_page: i64,
    page: i64,
    total: i64,
) {
    let last = ((total + per_page - 1) / per_page).max(1);
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let link = |p: i64, rel: &str| {
        format!("<http://{host}{path}?per_page={per_page}&page={p}>; rel=\"{rel}\"")
    };
    let mut links = Vec::new();
    if page > 1 {
        links.push(link(page - 1, "prev"));
        links.push(link(1, "first"));
    }
    if page < last {
        links.push(link(page + 1, "next"));
        links.push(link(last, "last"));
    }
    if let Ok(v) = HeaderValue::from_str(&links.join(", "))
        && !links.is_empty()
    {
        res.headers_mut().insert(header::LINK, v);
    }
}
