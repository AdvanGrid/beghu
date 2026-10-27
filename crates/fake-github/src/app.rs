//! The App's own credentials, and the GraphQL API.
//!
//! - `POST /app/installations/{id}/access_tokens`: the App signs a JWT (RS256, `iss` its App id
//!   or client id, at most 10 minutes from `iat` to `exp`) with its private key and trades it for
//!   an installation token (`ghs_…`, an hour). The fake checks the signature against the dev
//!   App's key, [`DEV_APP_KEY`]. A body's `permissions` narrow the token, as GitHub's do; asking
//!   for one the installation hasn't got, or a higher level, is GitHub's 422, and a body that isn't
//!   JSON its 400. The control port's
//!   `/state` lists each token minted with its permissions.
//! - `POST /graphql`: the queries beghu makes, matched by operation name (the fake parses no
//!   GraphQL). A token sees what GitHub would let it: an installation token the installation's
//!   repos, a user token the repos the user has access to, and either one every public repo.
//!   Issues in repos the token can't see are left out of lists without a trace, as GitHub does.
//!
//! `IssueEdges($id, $sub, $blocks, $relates, $relatesAfter)`: an issue's relationships of the
//! kinds asked for (`@include(if: …)`), each end with its repository. `relatesTo` is a page of
//! at most 100 (GitHub's largest page), newest first as GitHub orders it by default, with its
//! `pageInfo`; `$relatesAfter` is the `endCursor` of the page before. The other lists are whole:
//! GitHub caps them at 100 sub-issues and 50 dependencies of each kind.

use crate::Fake;
use crate::api::{self, bearer, rfc3339};
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use fake_db::q;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;

/// The dev App's id, as its installations report it.
pub const DEV_APP_ID: i64 = 1_000_001;

/// The dev App's private key (PKCS#1 PEM, as GitHub hands App keys out). Dev and test data only:
/// it signs JWTs for Fake GitHub, never for GitHub.
pub const DEV_APP_KEY: &str = include_str!("dev-app-key.pem");

/// The most nodes GitHub returns in one page of a connection.
const MAX_PAGE: usize = 100;

/// GitHub's installation tokens last an hour.
const INSTALLATION_TTL: i64 = 3600;
/// GitHub refuses a JWT whose lifetime is over 10 minutes.
const MAX_JWT_LIFETIME: i64 = 600;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route(
            "/app/installations/{installation_id}/access_tokens",
            post(access_token),
        )
        .route("/graphql", post(graphql))
}

/// What the App's installations may do, as GitHub reports it on each.
pub(crate) fn installation_permissions() -> serde_json::Map<String, Value> {
    [
        ("issues", "write"),
        ("metadata", "read"),
        ("pull_requests", "read"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), json!(v)))
    .collect()
}

/// The installation tokens issued: by token, the installation and expiry of each; and, in the
/// order minted, each one's installation and permissions.
#[derive(Default)]
pub(crate) struct InstallationTokens(Mutex<Issued>);

#[derive(Default)]
struct Issued {
    live: HashMap<String, (i64, i64)>,
    minted: Vec<Value>,
}

impl InstallationTokens {
    fn issue(&self, installation: i64, expires_at: i64, permissions: &Value) -> String {
        let token = format!("ghs_{}", crate::random(36));
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        all.live.insert(token.clone(), (installation, expires_at));
        all.minted
            .push(json!({ "installation": installation, "permissions": permissions }));
        token
    }

    /// The installation a live token belongs to.
    fn installation(&self, token: &str, now: i64) -> Option<i64> {
        let all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        all.live
            .get(token)
            .filter(|(_, expires)| *expires > now)
            .map(|(i, _)| *i)
    }

    /// Each token minted, oldest first: its installation and permissions.
    pub(crate) fn minted(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .minted
            .clone()
    }

    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Issued::default();
    }
}

/// A permission level's rank: `read` < `write` < `admin`.
fn level(l: &str) -> Option<u8> {
    match l {
        "read" => Some(1),
        "write" => Some(2),
        "admin" => Some(3),
        _ => None,
    }
}

/// The permissions a token request's body asks for, within the installation's; none asked is
/// all of them. GitHub's status and message when the body isn't JSON (400) or asks for more
/// (422).
fn permissions(body: &[u8]) -> Result<Value, (StatusCode, &'static str)> {
    const REFUSED: (StatusCode, &str) = (
        StatusCode::UNPROCESSABLE_ENTITY,
        "The permissions requested are not granted to this installation.",
    );
    let all = installation_permissions();
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Object(all));
    }
    let req: Value = serde_json::from_slice(body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Problems parsing JSON"))?;
    let Some(asked) = req.get("permissions").and_then(Value::as_object) else {
        return Ok(Value::Object(all));
    };
    for (name, want) in asked {
        let have = all.get(name).and_then(Value::as_str).and_then(level);
        let want = want.as_str().and_then(level);
        match (have, want) {
            (Some(h), Some(w)) if w <= h => {}
            _ => return Err(REFUSED),
        }
    }
    Ok(Value::Object(asked.clone()))
}

/// The DER bytes of the PEM block in `pem`.
pub(crate) fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .map(str::trim)
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// The dev App's public key, to check JWTs against.
fn public_key() -> Option<Vec<u8>> {
    let der = pem_to_der(DEV_APP_KEY)?;
    let pair = ring::rsa::KeyPair::from_der(&der).ok()?;
    Some(pair.public().as_ref().to_vec())
}

#[derive(Deserialize)]
struct Claims {
    iss: Value,
    iat: i64,
    exp: i64,
}

/// Why GitHub would refuse the App's JWT, if it would: a 401 each time. The messages are
/// unverified: docs/research doesn't record GitHub's own wording, so check them against real
/// GitHub with `--github` (#118) before anything relies on the text.
fn check_jwt(fake: &Fake, jwt: &str) -> Result<(), &'static str> {
    const UNREADABLE: &str = "A JSON web token could not be decoded";
    let mut parts = jwt.split('.');
    let (Some(head), Some(body), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(UNREADABLE);
    };
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header: Value = b64
        .decode(head)
        .ok()
        .and_then(|h| serde_json::from_slice(&h).ok())
        .ok_or(UNREADABLE)?;
    if header["alg"] != "RS256" {
        return Err(UNREADABLE);
    }
    let sig = b64.decode(sig).map_err(|_| UNREADABLE)?;
    let key = public_key().ok_or("the dev App key is unreadable")?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, key)
        .verify(format!("{head}.{body}").as_bytes(), &sig)
        .map_err(|_| UNREADABLE)?;
    let claims: Claims = b64
        .decode(body)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or(UNREADABLE)?;
    let ours = match &claims.iss {
        Value::Number(n) => n.as_i64() == Some(DEV_APP_ID),
        Value::String(s) => s == &DEV_APP_ID.to_string() || s == &fake.state().cfg.client_id,
        _ => return Err("'Issuer' claim ('iss') must be an Integer"),
    };
    if !ours {
        return Err("Integration not found");
    }
    let now = fake.now();
    if claims.exp <= now {
        return Err(
            "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
        );
    }
    if claims.exp - claims.iat > MAX_JWT_LIFETIME {
        return Err("'Expiration time' claim ('exp') is too far in the future");
    }
    if claims.iat > now + 60 {
        return Err("'Issued at' claim ('iat') must be an Integer representing a time in the past");
    }
    Ok(())
}

async fn access_token(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Path(installation): Path<i64>,
    body: axum::body::Bytes,
) -> Response {
    // The message is unverified, as `check_jwt`'s are (#118).
    let Some(jwt) = bearer(&headers) else {
        return api::error(
            StatusCode::UNAUTHORIZED,
            "A JSON web token could not be decoded",
        );
    };
    if let Err(why) = check_jwt(&fake, &jwt) {
        return api::error(StatusCode::UNAUTHORIZED, why);
    }
    let known = fake
        .state()
        .truth
        .read(move |c| q::installation_exists(c, installation))
        .await;
    match known {
        Ok(true) => {}
        Ok(false) => return api::not_found().await,
        Err(e) => return api::internal(e),
    }
    let granted = match permissions(&body) {
        Ok(p) => p,
        Err((status, why)) => return api::error(status, why),
    };
    let expires_at = fake.now() + INSTALLATION_TTL;
    let token = fake
        .state()
        .app_tokens
        .issue(installation, expires_at, &granted);
    (
        StatusCode::CREATED,
        axum::Json(json!({
            "token": token,
            "expires_at": rfc3339(expires_at),
            "permissions": granted,
            "repository_selection": "all",
        })),
    )
        .into_response()
}

/// Who a token speaks for.
#[derive(Clone, Copy)]
enum Caller {
    Installation(i64),
    User(i64),
}

#[derive(Deserialize)]
struct Request {
    query: String,
    #[serde(default)]
    variables: Value,
    #[serde(rename = "operationName")]
    operation_name: Option<String>,
}

async fn graphql(
    State(fake): State<Fake>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<Request>,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return api::error(StatusCode::UNAUTHORIZED, "Requires authentication");
    };
    let now = fake.now();
    let caller = match fake.state().app_tokens.installation(&token, now) {
        Some(i) => Caller::Installation(i),
        None => match fake
            .state()
            .truth
            .read(move |c| q::access_token_user(c, &token, now))
            .await
        {
            Ok(Some(u)) => Caller::User(u),
            Ok(None) => return api::error(StatusCode::UNAUTHORIZED, "Bad credentials"),
            Err(e) => return api::internal(e),
        },
    };
    let calls = &fake.state().graphql;
    match caller {
        Caller::Installation(_) => &calls.installation,
        Caller::User(_) => &calls.user,
    }
    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let op = req.operation_name.clone().or_else(|| {
        let rest = req.query.trim_start().strip_prefix("query")?;
        let name: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        (!name.is_empty()).then_some(name)
    });
    match op.as_deref() {
        Some("IssueEdges") => {
            let vars = req.variables;
            let done = fake
                .state()
                .truth
                .read(move |c| issue_edges(c, caller, &vars))
                .await;
            match done {
                Ok(answer) => axum::Json(answer).into_response(),
                Err(e) => api::internal(e),
            }
        }
        other => axum::Json(json!({
            "errors": [{ "message": format!("Fake GitHub doesn't know the operation {other:?}") }],
        }))
        .into_response(),
    }
}

fn visible(c: &Connection, caller: Caller, repo: i64) -> rusqlite::Result<bool> {
    let (inst, user) = match caller {
        Caller::Installation(i) => (Some(i), None),
        Caller::User(u) => (None, Some(u)),
    };
    q::repo_visible(c, repo, inst, user)
}

/// One end of a relationship, as GraphQL's `Issue` gives it with its repository.
fn end(c: &Connection, id: i64) -> rusqlite::Result<Value> {
    let i = q::graphql_issue(c, id)?;
    Ok(json!({
        "id": i.node_id,
        "databaseId": i.id,
        "number": i.number,
        "title": i.title,
        "state": i.state.to_uppercase(),
        "repository": {
            "databaseId": i.repo_id,
            "id": i.repo_node_id,
            "name": i.repo_name,
            "owner": { "login": i.repo_owner },
            "isPrivate": i.repo_private,
        },
    }))
}

/// The ends among `ids` the caller can see, in order.
fn ends(c: &Connection, caller: Caller, ids: Vec<i64>) -> rusqlite::Result<Value> {
    let mut nodes = Vec::new();
    for id in ids {
        if visible(c, caller, q::graphql_issue(c, id)?.repo_id)? {
            nodes.push(end(c, id)?);
        }
    }
    Ok(json!({ "nodes": nodes }))
}

/// `IssueEdges`'s answer: `data`, and the errors beside it. An id GitHub doesn't know (deleted,
/// transferred) or doesn't show the caller is `node: null` with a `NOT_FOUND` error on `node`
/// (docs/research/issue-edge-cases.md, mirror-import-and-reconciliation.md).
fn issue_edges(c: &Connection, caller: Caller, vars: &Value) -> rusqlite::Result<Value> {
    let node_id = vars["id"].as_str().unwrap_or_default();
    let not_found = || {
        json!({
            "data": { "node": null },
            "errors": [{
                "type": "NOT_FOUND",
                "path": ["node"],
                "locations": [{ "line": 2, "column": 3 }],
                "message": format!("Could not resolve to a node with the global id of '{node_id}'"),
            }],
        })
    };
    let Some(id) = q::issue_by_node_id(c, node_id)? else {
        return Ok(not_found());
    };
    let issue = q::graphql_issue(c, id)?;
    if !visible(c, caller, issue.repo_id)? {
        return Ok(not_found());
    }
    let mut node = json!({ "__typename": "Issue", "databaseId": id });
    let flag = |k: &str| vars[k].as_bool().unwrap_or(false);
    if flag("sub") {
        node["parent"] = match q::parent_of(c, id)? {
            Some(p) if visible(c, caller, q::graphql_issue(c, p)?.repo_id)? => end(c, p)?,
            _ => Value::Null,
        };
        node["subIssues"] = ends(c, caller, q::sub_issues(c, id)?)?;
    }
    if flag("blocks") {
        node["blockedBy"] = ends(c, caller, q::blocked_by(c, id)?)?;
        node["blocking"] = ends(c, caller, q::blocking(c, id)?)?;
    }
    if flag("relates") {
        // Newest first: GitHub's default order, `RELATES_TO_ADDED_AT DESC`.
        let mut all = q::relates_to(c, id)?;
        all.reverse();
        let mut seen = Vec::new();
        for other in all {
            if visible(c, caller, q::graphql_issue(c, other)?.repo_id)? {
                seen.push(other);
            }
        }
        let from = vars["relatesAfter"]
            .as_str()
            .and_then(from_cursor)
            .unwrap_or(0)
            .min(seen.len());
        let to = (from + MAX_PAGE).min(seen.len());
        let mut page = Vec::new();
        for other in &seen[from..to] {
            page.push(end(c, *other)?);
        }
        node["relatesTo"] = json!({
            "pageInfo": {
                "hasNextPage": to < seen.len(),
                "endCursor": (to > from).then(|| cursor(to)),
            },
            "nodes": page,
        });
    }
    Ok(json!({ "data": { "node": node } }))
}

/// An opaque cursor past the first `n` nodes of a list, as GitHub's look (base64).
fn cursor(n: usize) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("cursor:v2:{n}"))
}

fn from_cursor(c: &str) -> Option<usize> {
    let raw = base64::engine::general_purpose::STANDARD.decode(c).ok()?;
    String::from_utf8(raw)
        .ok()?
        .strip_prefix("cursor:v2:")?
        .parse()
        .ok()
}
