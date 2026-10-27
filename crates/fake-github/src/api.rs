//! The REST endpoints beghu calls with a user access token: the user, and the installations and
//! repos it can see, with `permissions` (the role).

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
}

/// GitHub's error body.
pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        axum::Json(json!({
            "message": message,
            "documentation_url": DOCS,
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
pub(crate) struct TokenUser(i64);

impl FromRequestParts<Fake> for TokenUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, fake: &Fake) -> Result<Self, Response> {
        authenticate(fake, &parts.headers).await.map(TokenUser)
    }
}

async fn authenticate(fake: &Fake, headers: &HeaderMap) -> Result<i64, Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
                .or_else(|| v.strip_prefix("token "))
        })
        .map(str::to_owned);
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

/// The App's permissions and events, as GitHub reports them on an installation.
fn app_permissions() -> Value {
    json!({ "issues": "write", "metadata": "read", "pull_requests": "read" })
}

const EVENTS: [&str; 10] = [
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
pub(crate) fn rfc3339(secs: i64) -> String {
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

async fn installations(State(fake): State<Fake>, TokenUser(user): TokenUser) -> Response {
    let rows = match fake
        .state()
        .truth
        .read(move |c| q::user_installations(c, user))
        .await
    {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let list: Vec<Value> = rows
        .iter()
        .map(|i| {
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
                "permissions": app_permissions(),
                "events": EVENTS,
                "created_at": rfc3339(i.created_at),
                "updated_at": rfc3339(i.created_at),
                "single_file_name": null,
                "has_multiple_single_files": false,
                "single_file_paths": [],
                "suspended_by": null,
                "suspended_at": null,
            })
        })
        .collect();
    axum::Json(json!({ "total_count": list.len(), "installations": list })).into_response()
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
            let full = format!("{}/{}", r.owner, r.name);
            Ok(json!({
                "id": r.id,
                "node_id": r.node_id,
                "name": r.name,
                "full_name": full,
                "private": r.private,
                "visibility": if r.private { "private" } else { "public" },
                "owner": { "login": r.owner, "type": "Organization" },
                "html_url": format!("https://github.com/{full}"),
                "url": format!("https://api.github.com/repos/{full}"),
                "archived": r.archived,
                "disabled": false,
                "has_issues": true,
                "permissions": permissions(role),
            }))
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
    let last = ((total + per_page - 1) / per_page).max(1);
    // Links point back at the fake, wherever the caller reached it.
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let link = |p: i64, rel: &str| {
        format!(
            "<http://{host}/user/installations/{installation}/repositories?per_page={per_page}&page={p}>; rel=\"{rel}\""
        )
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
    res
}
