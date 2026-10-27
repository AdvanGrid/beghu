//! The GitHub App user web flow: the authorize page, the code-for-token exchange with PKCE, the
//! single-use refresh, and revocation of a grant or a token.
//!
//! `GET /login/oauth/authorize` lists the fixture accounts to sign in as. `login=<user>` skips the
//! page and signs that account in at once, which is how scripts and tests sign in.

use crate::{Fake, api};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use base64::Engine as _;
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Digest as _;

/// Authorization codes last 10 minutes, as on GitHub.
const CODE_TTL: i64 = 600;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/login/oauth/authorize", get(authorize))
        .route("/login/oauth/access_token", post(access_token))
        .route("/applications/{client_id}/grant", delete(revoke_grant))
        .route("/applications/{client_id}/token", delete(revoke_token))
}

struct Authorize {
    client_id: Option<String>,
    redirect_uri: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    login: Option<String>,
}

/// An authorization code as it's stored, to be redeemed once at the token endpoint.
struct StoredCode {
    code: String,
    redirect_uri: String,
    challenge: Option<String>,
    challenge_method: Option<String>,
}

fn page(title: &str, body: &str) -> Html<String> {
    // System colours only, so the page follows the light or dark scheme by itself.
    Html(format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
  body {{ background: Canvas; color: CanvasText; margin: 0; padding: 48px 16px; }}
  main {{ max-width: 420px; margin: 0 auto; }}
  h1 {{ font-size: 20px; font-weight: 600; }}
  p {{ color: GrayText; }}
  ul {{ list-style: none; padding: 0; margin: 24px 0 0; }}
  li + li {{ margin-top: 8px; }}
  a {{ display: block; padding: 12px 16px; border: 1px solid GrayText; border-radius: 6px;
       color: LinkText; text-decoration: none; }}
  a:hover, a:focus-visible {{ border-color: LinkText; }}
  small {{ color: GrayText; margin-left: 8px; }}
</style>
</head>
<body><main>
{body}
</main></body>
</html>
"#
    ))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn authorize(
    State(fake): State<Fake>,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    let get = |k: &str| {
        params
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };
    let a = Authorize {
        client_id: get("client_id"),
        redirect_uri: get("redirect_uri"),
        state: get("state"),
        code_challenge: get("code_challenge"),
        code_challenge_method: get("code_challenge_method"),
        login: get("login"),
    };
    if a.client_id.as_deref() != Some(&fake.state().cfg.client_id) {
        let msg = "<h1>404</h1><p>No application with this client_id.</p>";
        return (StatusCode::NOT_FOUND, page("Not Found", msg)).into_response();
    }
    let Some(redirect_uri) = a.redirect_uri.clone() else {
        let msg = "<h1>Missing redirect_uri</h1><p>The fake has no registered callback URL; pass redirect_uri.</p>";
        return (StatusCode::BAD_REQUEST, page("Bad request", msg)).into_response();
    };
    let accounts = match fake.state().truth.read(q::accounts).await {
        Ok(a) => a,
        Err(e) => return api::internal(e),
    };
    let Some(login) = a.login.clone() else {
        // The page: one link per account, each the same request plus `login`.
        let others: Vec<(String, String)> = params
            .iter()
            .filter(|(k, _)| k != "login")
            .cloned()
            .collect();
        let items: String = accounts
            .iter()
            .map(|u| {
                let mut q = others.clone();
                q.push(("login".into(), u.login.clone()));
                let href = format!(
                    "/login/oauth/authorize?{}",
                    serde_urlencoded::to_string(&q).unwrap_or_default()
                );
                format!(
                    "<li><a href=\"{}\">{}<small>{}</small></a></li>\n",
                    escape(&href),
                    escape(&u.login),
                    escape(&u.name)
                )
            })
            .collect();
        return page(
            "Sign in to Fake GitHub",
            &format!(
                "<h1>Sign in to Fake GitHub</h1>\n<p>Pick a fixture account to authorize beghu as.</p>\n<ul>\n{items}</ul>"
            ),
        )
        .into_response();
    };
    let Some(user) = accounts.iter().find(|u| u.login == login).map(|u| u.id) else {
        let msg = format!(
            "<h1>Unknown account</h1><p>{} isn't a fixture account.</p>",
            escape(&login)
        );
        return (StatusCode::NOT_FOUND, page("Unknown account", &msg)).into_response();
    };
    let code = crate::random(20);
    let expires_at = fake.now() + CODE_TTL;
    let stored = StoredCode {
        code: code.clone(),
        redirect_uri: redirect_uri.clone(),
        challenge: a.code_challenge.clone(),
        challenge_method: a.code_challenge_method.clone(),
    };
    let written = fake
        .state()
        .truth
        .write(move |tx| {
            q::insert_code(
                tx,
                &stored.code,
                user,
                Some(&stored.redirect_uri),
                stored.challenge.as_deref(),
                stored.challenge_method.as_deref(),
                expires_at,
            )
        })
        .await;
    if let Err(e) = written {
        return api::internal(e);
    }
    let mut back = vec![("code", code)];
    if let Some(state) = a.state {
        back.push(("state", state));
    }
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    let to = format!(
        "{redirect_uri}{sep}{}",
        serde_urlencoded::to_string(&back).unwrap_or_default()
    );
    // GitHub redirects back with a 302. The user is now signed in to github.com too, which the
    // App's install page goes by (app.rs).
    let session = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax",
        crate::app::SESSION_COOKIE,
        login
    );
    (
        StatusCode::FOUND,
        [(header::LOCATION, to), (header::SET_COOKIE, session)],
    )
        .into_response()
}

#[derive(Deserialize, Default)]
struct TokenRequest {
    client_id: Option<String>,
    client_secret: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    grant_type: Option<String>,
    refresh_token: Option<String>,
}

/// GitHub answers token errors with 200 and an `error` field.
fn token_error(error: &str, description: &str, anchor: &str) -> Value {
    json!({
        "error": error,
        "error_description": description,
        "error_uri": format!("https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#{anchor}"),
    })
}

async fn access_token(State(fake): State<Fake>, headers: HeaderMap, body: Bytes) -> Response {
    let header_has = |name: header::HeaderName, needle: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains(needle))
    };
    let req: TokenRequest = if header_has(header::CONTENT_TYPE, "application/json") {
        serde_json::from_slice(&body).unwrap_or_default()
    } else {
        serde_urlencoded::from_bytes(&body).unwrap_or_default()
    };
    let json = header_has(header::ACCEPT, "application/json");
    let out = exchange(&fake, req).await;
    let out = match out {
        Ok(v) => v,
        Err(r) => return r,
    };
    if json {
        return axum::Json(out).into_response();
    }
    // GitHub's default answer is form-encoded.
    let pairs: Vec<(String, String)> = out
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| {
            let v = match v {
                Value::String(s) => s.clone(),
                v => v.to_string(),
            };
            (k.clone(), v)
        })
        .collect();
    (
        [(header::CONTENT_TYPE, "application/x-www-form-urlencoded")],
        serde_urlencoded::to_string(pairs).unwrap_or_default(),
    )
        .into_response()
}

async fn exchange(fake: &Fake, req: TokenRequest) -> Result<Value, Response> {
    let cfg = &fake.state().cfg;
    if req.client_id.as_deref() != Some(&cfg.client_id)
        || req.client_secret.as_deref() != Some(&cfg.client_secret)
    {
        return Ok(token_error(
            "incorrect_client_credentials",
            "The client_id and/or client_secret passed are incorrect.",
            "incorrect-client-credentials",
        ));
    }
    let now = fake.now();
    let ttl = fake.ttl();
    let truth = &fake.state().truth;
    if req.grant_type.as_deref() == Some("refresh_token") {
        let token = req.refresh_token.unwrap_or_default();
        let pair = truth
            .write(move |tx| {
                let Some(used) = q::use_refresh_token(tx, &token, now)? else {
                    // Known but no longer live: spent, revoked or expired.
                    let known = q::token_owner(tx, &token)?.is_some();
                    return Ok(Err(known));
                };
                // "That refresh token and the old user access token will no longer work."
                q::revoke_pair(tx, &used.pair, now)?;
                issue(tx, used.user_id, now, ttl).map(Ok)
            })
            .await
            .map_err(api::internal)?;
        let counts = &fake.state().refreshes;
        use std::sync::atomic::Ordering::Relaxed;
        match &pair {
            Ok(_) => counts.ok.fetch_add(1, Relaxed),
            Err(true) => counts.reused.fetch_add(1, Relaxed),
            Err(false) => 0,
        };
        return Ok(pair.unwrap_or_else(|_| {
            token_error(
                "bad_refresh_token",
                "The refresh token passed is incorrect or expired.",
                "bad-refresh-token",
            )
        }));
    }
    let bad_code = || {
        token_error(
            "bad_verification_code",
            "The code passed is incorrect or expired.",
            "bad-verification-code",
        )
    };
    let code = req.code.unwrap_or_default();
    let (verifier, redirect_uri) = (req.code_verifier, req.redirect_uri);
    let issued = truth
        .write(move |tx| {
            let Some(c) = q::take_code(tx, &code, now)? else {
                return Ok(Err(bad_code()));
            };
            if redirect_uri.is_some() && redirect_uri != c.redirect_uri {
                return Ok(Err(token_error(
                    "redirect_uri_mismatch",
                    "The redirect_uri MUST match the registered callback URL for this application.",
                    "redirect-uri-mismatch2",
                )));
            }
            if let Some(challenge) = &c.code_challenge {
                // GitHub only does S256, so a `plain` challenge never matches.
                let ok = match (c.code_challenge_method.as_deref(), &verifier) {
                    (Some("S256") | None, Some(v)) => {
                        base64::engine::general_purpose::URL_SAFE_NO_PAD
                            .encode(sha2::Sha256::digest(v.as_bytes()))
                            == *challenge
                    }
                    _ => false,
                };
                if !ok {
                    return Ok(Err(bad_code()));
                }
            }
            issue(tx, c.user_id, now, ttl).map(Ok)
        })
        .await
        .map_err(api::internal)?;
    Ok(issued.unwrap_or_else(|e| e))
}

/// The two kinds of user token, as the truth stores them.
#[derive(Clone, Copy)]
enum TokenKind {
    Access,
    Refresh,
}

impl TokenKind {
    fn as_str(self) -> &'static str {
        match self {
            TokenKind::Access => "access",
            TokenKind::Refresh => "refresh",
        }
    }
}

/// A new access/refresh pair for `user`.
fn issue(
    tx: &rusqlite::Transaction,
    user: i64,
    now: i64,
    ttl: crate::Ttl,
) -> rusqlite::Result<Value> {
    let access = format!("ghu_{}", crate::random(36));
    let refresh = format!("ghr_{}", crate::random(76));
    let (a, r) = (ttl.access_ttl as i64, ttl.refresh_ttl as i64);
    q::insert_token(
        tx,
        &access,
        TokenKind::Access.as_str(),
        user,
        &access,
        now,
        now + a,
    )?;
    q::insert_token(
        tx,
        &refresh,
        TokenKind::Refresh.as_str(),
        user,
        &access,
        now,
        now + r,
    )?;
    Ok(json!({
        "access_token": access,
        "expires_in": a,
        "refresh_token": refresh,
        "refresh_token_expires_in": r,
        "token_type": "bearer",
        "scope": "",
    }))
}

/// Checks the App's basic auth (client id and secret) on the revocation endpoints.
fn app_authenticated(fake: &Fake, client_id: &str, headers: &HeaderMap) -> bool {
    let cfg = &fake.state().cfg;
    let expected = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", cfg.client_id, cfg.client_secret));
    client_id == cfg.client_id
        && headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Basic "))
            == Some(expected.as_str())
}

#[derive(Deserialize)]
struct TokenBody {
    access_token: String,
}

/// `DELETE /applications/{client_id}/grant`: revokes the user's authorization of the App, and
/// with it every token it issued.
async fn revoke_grant(
    State(fake): State<Fake>,
    Path(client_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    revoke(fake, client_id, headers, body, true).await
}

/// `DELETE /applications/{client_id}/token`: revokes one access token.
async fn revoke_token(
    State(fake): State<Fake>,
    Path(client_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    revoke(fake, client_id, headers, body, false).await
}

async fn revoke(
    fake: Fake,
    client_id: String,
    headers: HeaderMap,
    body: Bytes,
    grant: bool,
) -> Response {
    if !app_authenticated(&fake, &client_id, &headers) {
        return api::not_found().await;
    }
    let Ok(TokenBody { access_token }) = serde_json::from_slice(&body) else {
        return api::error(StatusCode::UNPROCESSABLE_ENTITY, "Validation Failed");
    };
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(user) = q::token_owner(tx, &access_token)? else {
                return Ok(false);
            };
            if grant {
                q::revoke_user(tx, user, now)?;
            } else {
                q::revoke_token(tx, &access_token, now)?;
            }
            Ok(true)
        })
        .await;
    match done {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => api::not_found().await,
        Err(e) => api::internal(e),
    }
}
