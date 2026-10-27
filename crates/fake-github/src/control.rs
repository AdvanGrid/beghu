//! The control port: what dev tooling (`./dev-ctl fake …`) and tests use to steer the fake at
//! runtime. JSON in and out.
//!
//! - `GET /state`: the fixture, the accounts, who's signed in, token lifetimes, fault rules,
//!   how many refresh tokens were honoured and how many arrived already spent, each
//!   installation token minted with its permissions, and how many delivery attempts the App's
//!   log holds (failed and redelivered among them), each token owner's quota used, and how many
//!   conditional requests were answered 304.
//! - `POST /faults/latency {endpoint, ms, count?}`: delay calls to `endpoint` (only the next
//!   `count`, with one); `ms: 0` removes the rule.
//! - `POST /faults/fail {endpoint, count, status?, retry_after?, limit?, reset?}`: the next
//!   `count` calls fail with `status`, or with `reset` get no answer at all. `limit` (`primary`
//!   or `secondary` with 403/429, `graphql` with 200) makes the failure that GitHub rate limit,
//!   in its documented shape.
//! - `POST /faults/rewrite {endpoint, count, body | raw}`: the next `count` answers from
//!   `endpoint` carry `body` as their `body` field, or have `raw` as their whole body, sent
//!   complete under the answer's own status (an answer beghu can't read, such as text that isn't
//!   JSON), though the call did what it was asked.
//! - `POST /faults/down {down}`: GitHub unreachable, or back.
//! - `POST /faults/webhooks {drop?, duplicate?, reorder?, delay_ms?}`: the next `drop`
//!   deliveries are lost, the next `duplicate` are sent twice under one GUID, the next `reorder`
//!   are held and sent newest first, and every delivery waits `delay_ms` longer.
//! - `DELETE /faults`: clear every fault rule, webhook ones included. With `{endpoint}`, only
//!   that endpoint's latency, fail and rewrite rules, so callers sharing the fake (tests running
//!   side by side) can each remove their own.
//! - `PUT /webhooks {url}`: where webhooks go (`null`: nowhere).
//! - `POST /edit {repo, number, as?, title?, body?, state?, state_reason?, add_labels?,
//!   remove_labels?, comment?, add_sub_issue?, remove_sub_issue?, add_blocked_by?,
//!   remove_blocked_by?, add_relates_to?, remove_relates_to?, delete?}`: an outside edit (see `edits.rs`
//!   and `relationships.rs`), with its webhooks.
//! - `PUT /tokens {access_ttl?, refresh_ttl?}`: token lifetimes in seconds, for new tokens.
//! - `POST /label {repo, name, rename | color}`: renames or creates a repo's label, with its
//!   `label` delivery (`edits.rs`).
//! - `PUT /clock {offset}`: run the fake's clock `offset` seconds ahead of the real one, so
//!   tokens and codes expire without waiting.
//! - `PUT /quota {remaining}`: every token owner's primary rate limit reads as at most
//!   `remaining` left, as if other clients had spent the rest; `null` lifts it (`quota.rs`).
//! - `POST /revoke {login}`: the user revokes the App's authorization in GitHub's settings.
//! - `PUT /permissions {login, repo, role}`: an admin gives the account `role` on the repo
//!   (`read` … `admin`), or with `role: null` removes its access, as removing a collaborator or
//!   a team does. The repo then drops out of what the account's token sees.
//! - `PUT /setup-url {url}`: the App's setup URL, where the install page sends the browser
//!   (`null`: nowhere).
//! - `POST /uninstall {login}`: the user uninstalls the App from their own account, as in their
//!   settings; GitHub sends `installation` `deleted`.
//! - `POST /suspend {login}`, `POST /unsuspend {login}`: the App's installation on the user's
//!   own account is suspended, or no longer; GitHub sends `installation` `suspend` or
//!   `unsuspend`.
//! - `POST /reset`: back to the pristine fixture: no sign-ins, no faults, default lifetimes, the
//!   real clock, no deliveries logged.

use crate::faults::{self, Fail};
use crate::{Fake, Ttl, api, edits, webhooks};
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use fake_db::q;
use serde::Deserialize;
use serde_json::json;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/state", get(state))
        .route("/faults/latency", post(latency))
        .route("/faults/fail", post(fail))
        .route("/faults/rewrite", post(rewrite))
        .route("/faults/down", post(down))
        .route("/faults/webhooks", post(webhook_faults))
        .route("/faults", delete(clear))
        .route("/webhooks", put(webhook_target))
        .route("/edit", post(edits::edit))
        .route("/label", post(edits::label))
        .route("/tokens", put(tokens))
        .route("/clock", put(clock))
        .route("/quota", put(quota))
        .route("/revoke", post(revoke))
        .route("/permissions", put(permissions))
        .route("/setup-url", put(setup_url))
        .route("/uninstall", post(uninstall))
        .route("/suspend", post(suspend))
        .route("/unsuspend", post(unsuspend))
        .route("/reset", post(reset))
}

/// The control port's one 400: `{"error": msg}`.
pub(crate) fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn ok() -> Response {
    axum::Json(json!({ "ok": true })).into_response()
}

const ENDPOINT_HELP: &str = "endpoint is `*`, or a path with an optional method in front, like `GET /user`; a `*` segment inside the path stands for exactly one segment, and a trailing `/*` covers the whole subtree under the path (`/user/*` matches `/user/installations/1/repositories` but not `/user`)";

async fn state(State(fake): State<Fake>) -> Response {
    let now = fake.now();
    let read = fake
        .state()
        .truth
        .read(move |c| Ok((q::accounts(c)?, q::signed_in(c, now)?)))
        .await;
    let (accounts, signed_in) = match read {
        Ok(r) => r,
        Err(e) => return api::internal(e),
    };
    let accounts: Vec<_> = accounts
        .iter()
        .map(|a| json!({ "login": a.login, "id": a.id, "name": a.name }))
        .collect();
    axum::Json(json!({
        "fixture": fake.state().truth.fixture(),
        "accounts": accounts,
        "signed_in": signed_in,
        "tokens": fake.ttl(),
        "faults": fake.state().faults.snapshot(),
        "webhooks": {
            "url": fake.state().webhooks.target(),
            "faults": fake.state().webhooks.rules(),
            "deliveries": fake.state().webhooks.log(now, |all| json!({
                "attempts": all.len(),
                "failed": all.iter().filter(|a| !(200..400).contains(&a.status_code)).count(),
                "redelivered": all.iter().filter(|a| a.redelivery).count(),
            })),
        },
        "refreshes": fake.state().refreshes.snapshot(),
        "graphql": fake.state().graphql.snapshot(),
        "installation_tokens": fake.state().app_tokens.minted(),
        "clock": { "offset": fake.clock_offset() },
        "quota": fake.state().quotas.snapshot(),
        "not_modified": fake.state().not_modified.load(std::sync::atomic::Ordering::Relaxed),
        "setup_url": fake.setup_url(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LatencyReq {
    endpoint: String,
    ms: u64,
    count: Option<u32>,
}

async fn latency(State(fake): State<Fake>, axum::Json(r): axum::Json<LatencyReq>) -> Response {
    let Some(endpoint) = faults::normalise_endpoint(&r.endpoint) else {
        return bad_request(ENDPOINT_HELP);
    };
    if r.count == Some(0) {
        return bad_request("count must be at least 1");
    }
    fake.state().faults.set_latency(endpoint, r.ms, r.count);
    ok()
}

#[derive(Deserialize)]
struct FailReq {
    endpoint: String,
    #[serde(default = "one_call")]
    count: u32,
    status: Option<u16>,
    retry_after: Option<u64>,
    limit: Option<faults::Limit>,
    #[serde(default)]
    reset: bool,
}

/// A fail rule without a count fails just the next call.
fn one_call() -> u32 {
    1
}

async fn fail(State(fake): State<Fake>, axum::Json(r): axum::Json<FailReq>) -> Response {
    let Some(endpoint) = faults::normalise_endpoint(&r.endpoint) else {
        return bad_request(ENDPOINT_HELP);
    };
    if r.count == 0 {
        return bad_request("count must be at least 1");
    }
    match (r.status, r.reset) {
        (None, false) => return bad_request("a fail rule needs a status, or reset: true"),
        (Some(_), true) => return bad_request("a reset sends no status"),
        _ => {}
    }
    match (r.limit, r.status) {
        (Some(faults::Limit::Graphql), Some(s)) if s != 200 => {
            return bad_request("GraphQL's rate limit answers 200: status must be 200");
        }
        (Some(faults::Limit::Primary | faults::Limit::Secondary), s)
            if !matches!(s, Some(403 | 429)) =>
        {
            return bad_request("a rate limit answers 403 or 429");
        }
        (None, Some(s)) if !(400..=599).contains(&s) => {
            return bad_request("status must be an HTTP error status, 400 to 599");
        }
        _ => {}
    }
    fake.state().faults.add_fail(Fail {
        endpoint,
        remaining: r.count,
        status: r.status,
        retry_after: r.retry_after,
        limit: r.limit,
        reset: r.reset,
    });
    ok()
}

#[derive(Deserialize)]
struct RewriteReq {
    endpoint: String,
    #[serde(default = "one_call")]
    count: u32,
    body: Option<String>,
    raw: Option<String>,
}

async fn rewrite(State(fake): State<Fake>, axum::Json(r): axum::Json<RewriteReq>) -> Response {
    let Some(endpoint) = faults::normalise_endpoint(&r.endpoint) else {
        return bad_request(ENDPOINT_HELP);
    };
    if r.count == 0 {
        return bad_request("count must be at least 1");
    }
    let to = match (r.body, r.raw) {
        (Some(body), None) => faults::RewriteTo::Body(body),
        (None, Some(raw)) => faults::RewriteTo::Raw(raw),
        _ => return bad_request("a rewrite rule takes a body or a raw answer, not both"),
    };
    fake.state().faults.add_rewrite(faults::Rewrite {
        endpoint,
        remaining: r.count,
        to,
    });
    ok()
}

#[derive(Deserialize)]
struct DownReq {
    down: bool,
}

async fn down(State(fake): State<Fake>, axum::Json(r): axum::Json<DownReq>) -> Response {
    fake.state().faults.set_down(r.down);
    ok()
}

#[derive(Deserialize)]
struct ClearReq {
    endpoint: Option<String>,
}

async fn clear(State(fake): State<Fake>, body: axum::body::Bytes) -> Response {
    // No body, `null` or `{}`: everything.
    let r = if body.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        match serde_json::from_slice::<Option<ClearReq>>(&body) {
            Ok(r) => r,
            Err(e) => return bad_request(e.to_string()),
        }
    };
    match r.and_then(|r| r.endpoint) {
        Some(endpoint) => {
            let Some(endpoint) = faults::normalise_endpoint(&endpoint) else {
                return bad_request(ENDPOINT_HELP);
            };
            fake.state().faults.clear_endpoint(&endpoint);
        }
        None => {
            fake.state().faults.clear();
            fake.state().webhooks.clear();
        }
    }
    ok()
}

async fn webhook_faults(
    State(fake): State<Fake>,
    axum::Json(r): axum::Json<webhooks::MoreRules>,
) -> Response {
    if r.reorder == 1 {
        return bad_request("reorder takes a batch of at least 2 deliveries");
    }
    fake.state().webhooks.add_rules(r);
    ok()
}

#[derive(Deserialize)]
struct TargetReq {
    url: Option<String>,
}

async fn webhook_target(
    State(fake): State<Fake>,
    axum::Json(r): axum::Json<TargetReq>,
) -> Response {
    if let Some(u) = &r.url
        && !(u.starts_with("http://") || u.starts_with("https://"))
    {
        return bad_request("url must be an http(s) URL");
    }
    fake.state().webhooks.set_target(r.url);
    ok()
}

async fn setup_url(State(fake): State<Fake>, axum::Json(r): axum::Json<TargetReq>) -> Response {
    if let Some(u) = &r.url
        && !(u.starts_with("http://") || u.starts_with("https://"))
    {
        return bad_request("url must be an http(s) URL");
    }
    fake.set_setup_url(r.url);
    ok()
}

async fn uninstall(State(fake): State<Fake>, axum::Json(r): axum::Json<RevokeReq>) -> Response {
    match crate::app::uninstall(&fake, r.login).await {
        Ok(true) => ok(),
        Ok(false) => bad_request("the App isn't installed on that account"),
        Err(e) => api::internal(e),
    }
}

async fn suspend(State(fake): State<Fake>, axum::Json(r): axum::Json<RevokeReq>) -> Response {
    suspended(fake, r.login, true).await
}

async fn unsuspend(State(fake): State<Fake>, axum::Json(r): axum::Json<RevokeReq>) -> Response {
    suspended(fake, r.login, false).await
}

async fn suspended(fake: Fake, login: String, on: bool) -> Response {
    match crate::app::suspend(&fake, login, on).await {
        Ok(true) => ok(),
        Ok(false) => bad_request("the App isn't installed on that account"),
        Err(e) => api::internal(e),
    }
}

#[derive(Deserialize)]
struct TokensReq {
    access_ttl: Option<u64>,
    refresh_ttl: Option<u64>,
}

async fn tokens(State(fake): State<Fake>, axum::Json(r): axum::Json<TokensReq>) -> Response {
    if r.access_ttl == Some(0) || r.refresh_ttl == Some(0) {
        return bad_request("lifetimes are at least 1 second");
    }
    let mut ttl = fake.state().ttl.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = r.access_ttl {
        ttl.access_ttl = s;
    }
    if let Some(s) = r.refresh_ttl {
        ttl.refresh_ttl = s;
    }
    ok()
}

#[derive(Deserialize)]
struct ClockReq {
    offset: i64,
}

async fn clock(State(fake): State<Fake>, axum::Json(r): axum::Json<ClockReq>) -> Response {
    fake.set_clock_offset(r.offset);
    ok()
}

#[derive(Deserialize)]
struct QuotaReq {
    remaining: Option<i64>,
}

async fn quota(State(fake): State<Fake>, axum::Json(r): axum::Json<QuotaReq>) -> Response {
    if r.remaining.is_some_and(|n| n < 0) {
        return bad_request("remaining is at least 0, or null to lift the cap");
    }
    fake.state().quotas.set_cap(r.remaining);
    ok()
}

#[derive(Deserialize)]
struct RevokeReq {
    login: String,
}

async fn revoke(State(fake): State<Fake>, axum::Json(r): axum::Json<RevokeReq>) -> Response {
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| match q::account_by_login(tx, &r.login)? {
            Some(a) => q::revoke_user(tx, a.id, now).map(|_| true),
            None => Ok(false),
        })
        .await;
    match done {
        Ok(true) => ok(),
        Ok(false) => bad_request("no fixture account with that login"),
        Err(e) => api::internal(e),
    }
}

#[derive(Deserialize)]
struct PermissionsReq {
    login: String,
    repo: String,
    /// `None`: no access at all.
    role: Option<crate::Role>,
}

async fn permissions(
    State(fake): State<Fake>,
    r: Result<axum::Json<PermissionsReq>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let r = match r {
        Ok(axum::Json(r)) => r,
        Err(e) => {
            return bad_request(format!(
                "{}; role is read, triage, write, maintain, admin or null",
                e.body_text()
            ));
        }
    };
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(user) = q::account_by_login(tx, &r.login)? else {
                return Ok(Err(format!("{} isn't a fixture account", r.login)));
            };
            let repo = match edits::find_repo(tx, &r.repo)? {
                Ok(id) => id,
                Err(why) => return Ok(Err(why)),
            };
            match r.role {
                Some(role) => q::set_permission(tx, user.id, repo, role.as_str())?,
                None => q::remove_permission(tx, user.id, repo)?,
            };
            Ok(Ok(()))
        })
        .await;
    match done {
        Ok(Ok(())) => ok(),
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}

async fn reset(State(fake): State<Fake>) -> Response {
    let f = fake.clone();
    let done = tokio::task::spawn_blocking(move || f.state().truth.reset()).await;
    match done {
        Ok(Ok(())) => {
            fake.state().faults.clear();
            fake.state().webhooks.clear();
            fake.state().webhooks.clear_log();
            fake.state().refreshes.clear();
            fake.state().graphql.clear();
            fake.state().app_tokens.clear();
            fake.state().quotas.clear();
            fake.state()
                .not_modified
                .store(0, std::sync::atomic::Ordering::Relaxed);
            fake.set_clock_offset(0);
            *fake.state().ttl.lock().unwrap_or_else(|e| e.into_inner()) =
                Ttl::of(&fake.state().cfg);
            ok()
        }
        Ok(Err(e)) => api::internal(e),
        Err(_) => api::internal("reset panicked"),
    }
}
