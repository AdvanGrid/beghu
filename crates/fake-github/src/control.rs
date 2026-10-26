//! The control port: what dev tooling (`./dev-ctl fake …`) and tests use to steer the fake at
//! runtime. JSON in and out.
//!
//! - `GET /state`: the fixture, the accounts, who's signed in, token lifetimes, fault rules, and
//!   how many refresh tokens were honoured and how many arrived already spent.
//! - `POST /faults/latency {endpoint, ms}`: delay calls to `endpoint`; `ms: 0` removes the rule.
//! - `POST /faults/fail {endpoint, count, status, retry_after?}`: the next `count` calls fail.
//! - `POST /faults/down {down}`: GitHub unreachable, or back.
//! - `DELETE /faults`: clear every fault rule.
//! - `PUT /tokens {access_ttl?, refresh_ttl?}`: token lifetimes in seconds, for new tokens.
//! - `POST /revoke {login}`: the user revokes the App's authorization in GitHub's settings.
//! - `POST /reset`: back to the pristine fixture: no sign-ins, no faults, default lifetimes.

use crate::faults::{self, Fail};
use crate::{Fake, Ttl, api};
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
        .route("/faults/down", post(down))
        .route("/faults", delete(clear))
        .route("/tokens", put(tokens))
        .route("/revoke", post(revoke))
        .route("/reset", post(reset))
}

fn bad_request(msg: impl Into<String>) -> Response {
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
    let now = crate::now();
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
        "refreshes": fake.state().refreshes.snapshot(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LatencyReq {
    endpoint: String,
    ms: u64,
}

async fn latency(State(fake): State<Fake>, axum::Json(r): axum::Json<LatencyReq>) -> Response {
    let Some(endpoint) = faults::normalise_endpoint(&r.endpoint) else {
        return bad_request(ENDPOINT_HELP);
    };
    fake.state().faults.set_latency(endpoint, r.ms);
    ok()
}

#[derive(Deserialize)]
struct FailReq {
    endpoint: String,
    #[serde(default = "one_call")]
    count: u32,
    status: u16,
    retry_after: Option<u64>,
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
    if !(400..=599).contains(&r.status) {
        return bad_request("status must be an HTTP error status, 400 to 599");
    }
    fake.state().faults.add_fail(Fail {
        endpoint,
        remaining: r.count,
        status: r.status,
        retry_after: r.retry_after,
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

async fn clear(State(fake): State<Fake>) -> Response {
    fake.state().faults.clear();
    ok()
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
struct RevokeReq {
    login: String,
}

async fn revoke(State(fake): State<Fake>, axum::Json(r): axum::Json<RevokeReq>) -> Response {
    let now = crate::now();
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

async fn reset(State(fake): State<Fake>) -> Response {
    let f = fake.clone();
    let done = tokio::task::spawn_blocking(move || f.state().truth.reset()).await;
    match done {
        Ok(Ok(())) => {
            fake.state().faults.clear();
            fake.state().refreshes.clear();
            *fake.state().ttl.lock().unwrap_or_else(|e| e.into_inner()) =
                Ttl::of(&fake.state().cfg);
            ok()
        }
        Ok(Err(e)) => api::internal(e),
        Err(_) => api::internal("reset panicked"),
    }
}
