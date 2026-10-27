//! The GitHub App's own side: the endpoints an App calls with its JWT (`GET /app`, and minting an
//! installation's access token), and the install pages a user goes through to install it.
//!
//! - A JWT is RS256, signed with the App's private key, with `iat`, `exp` (at most 10 minutes
//!   after `iat`) and `iss` (the App's id or client id), as GitHub checks them. The fake checks
//!   the signature against the dev App's key, [`DEV_APP_KEY`].
//! - `POST /app/installations/{id}/access_tokens` mints a `ghs_` token good for an hour, which
//!   reads the installation's repos (and anything public). A body's `permissions` narrow the
//!   token, as GitHub's do; asking for one the installation hasn't got, or a higher level, is
//!   GitHub's 422, and a body that isn't JSON its 400. The control port's `/state` lists each
//!   token minted with its permissions.
//! - `GET /apps/{slug}/installations/new` is the install page. GitHub knows who is installing by
//!   their github.com session: the fake's is the `fake_gh_user` cookie its authorize page sets,
//!   or a `login=` parameter, as on the authorize page. A user installs the App on their own
//!   account, covering all their repos; the fake then sends `installation` `created` and sends the
//!   browser to the App's setup URL with `installation_id` and `setup_action=install`.
//! - Uninstalling (`POST /uninstall` on the control port, as the user would in their settings)
//!   deletes the installation, revokes its tokens and sends `installation` `deleted`.
//! - Suspending (`POST /suspend`, and `POST /unsuspend`) keeps the installation listed, with
//!   `suspended_at`, but it mints no tokens (403) and its tokens stop working; GitHub sends
//!   `installation` `suspend` (or `unsuspend`). Unverified: what GitHub answers a token minted
//!   before the suspension. Its docs (and docs/research) don't say; the fake answers 401 "Bad
//!   credentials", as for any dead token. To check against the real App with `--github` (#118).

use crate::Fake;
use crate::api::{self, bearer, rfc3339};
use crate::webhooks::{Delivery, repo_json, user_json};
use axum::Router;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Mutex;

/// The dev App's id, as its installations report it.
pub const DEV_APP_ID: i64 = 1_000_001;
/// The dev App's URL slug (`/apps/beghu-dev`).
pub const SLUG: &str = "beghu-dev";

/// The dev App's private key (PKCS#1 PEM, as GitHub hands App keys out). Dev and test data only:
/// it signs JWTs for Fake GitHub, never for GitHub.
pub const DEV_APP_KEY: &str = include_str!("dev-app-key.pem");

/// GitHub's installation tokens last an hour.
const TOKEN_TTL: i64 = 3600;
/// GitHub refuses a JWT whose lifetime is over 10 minutes.
const MAX_JWT_LIFETIME: i64 = 600;
/// Who the fake's github.com session belongs to: set by the authorize page.
pub(crate) const SESSION_COOKIE: &str = "fake_gh_user";

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/app", get(app))
        .route(
            "/app/installations/{installation_id}/access_tokens",
            post(access_token),
        )
        .route(
            "/apps/{slug}/installations/new",
            get(install_page).post(install),
        )
}

/// Each installation token minted, in order: its installation and permissions.
#[derive(Default)]
pub(crate) struct Minted(Mutex<Vec<Value>>);

impl Minted {
    fn record(&self, installation: i64, permissions: &Value) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(json!({ "installation": installation, "permissions": permissions }));
    }

    /// Each token minted, oldest first: its installation and permissions.
    pub(crate) fn minted(&self) -> Vec<Value> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
fn asked_permissions(body: &[u8]) -> Result<Value, (StatusCode, &'static str)> {
    const REFUSED: (StatusCode, &str) = (
        StatusCode::UNPROCESSABLE_ENTITY,
        "The permissions requested are not granted to this installation.",
    );
    let all = permissions();
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(all);
    }
    let req: Value = serde_json::from_slice(body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Problems parsing JSON"))?;
    let Some(asked) = req.get("permissions").and_then(Value::as_object) else {
        return Ok(all);
    };
    for (name, want) in asked {
        let have = all[name].as_str().and_then(level);
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

/// Checks the request's `Authorization: Bearer <JWT>` as GitHub does for an App: GitHub's 401
/// when it wouldn't take it. The messages are unverified: docs/research doesn't record GitHub's
/// own wording, so check them against real GitHub with `--github` (#118) before anything relies
/// on the text.
fn check_jwt(fake: &Fake, headers: &HeaderMap) -> Result<(), Response> {
    const UNREADABLE: &str = "A JSON web token could not be decoded";
    let refuse = |why: &str| api::error(StatusCode::UNAUTHORIZED, why);
    let jwt = bearer(headers).ok_or_else(|| refuse(UNREADABLE))?;
    let mut parts = jwt.split('.');
    let (Some(head), Some(body), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(refuse(UNREADABLE));
    };
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header: Value = b64
        .decode(head)
        .ok()
        .and_then(|h| serde_json::from_slice(&h).ok())
        .ok_or_else(|| refuse(UNREADABLE))?;
    if header["alg"] != "RS256" {
        return Err(refuse(UNREADABLE));
    }
    let sig = b64.decode(sig).map_err(|_| refuse(UNREADABLE))?;
    let key = public_key().ok_or_else(|| refuse("the dev App key is unreadable"))?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, key)
        .verify(format!("{head}.{body}").as_bytes(), &sig)
        .map_err(|_| refuse(UNREADABLE))?;
    let claims: Claims = b64
        .decode(body)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| refuse(UNREADABLE))?;
    let ours = match &claims.iss {
        Value::Number(n) => n.as_i64() == Some(DEV_APP_ID),
        Value::String(s) => s == &DEV_APP_ID.to_string() || s == &fake.state().cfg.client_id,
        _ => return Err(refuse("'Issuer' claim ('iss') must be an Integer")),
    };
    if !ours {
        return Err(refuse("Integration not found"));
    }
    let now = fake.now();
    if claims.exp <= now {
        return Err(refuse(
            "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
        ));
    }
    if claims.exp - claims.iat > MAX_JWT_LIFETIME {
        return Err(refuse(
            "'Expiration time' claim ('exp') is too far in the future",
        ));
    }
    if claims.iat > now + 60 {
        return Err(refuse(
            "'Issued at' claim ('iat') must be an Integer representing a time in the past",
        ));
    }
    Ok(())
}

fn host(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_owned()
}

/// GitHub's App permissions, as on an installation and in a minted token.
pub(crate) fn permissions() -> Value {
    json!({ "issues": "write", "metadata": "read", "pull_requests": "read" })
}

/// `GET /app`: the authenticated App. Its `html_url` is where installing starts.
async fn app(State(fake): State<Fake>, headers: HeaderMap) -> Response {
    if let Err(r) = check_jwt(&fake, &headers) {
        return r;
    }
    let host = host(&headers);
    axum::Json(json!({
        "id": DEV_APP_ID,
        "slug": SLUG,
        "node_id": format!("A_kw{DEV_APP_ID}"),
        "client_id": fake.state().cfg.client_id,
        "owner": { "login": "AdvanGrid", "id": 61_000_000, "type": "Organization" },
        "name": SLUG,
        "description": "beghu, against Fake GitHub",
        "external_url": "https://beghu.dev",
        "html_url": format!("http://{host}/apps/{SLUG}"),
        "created_at": rfc3339(1_756_684_800),
        "updated_at": rfc3339(1_756_684_800),
        "permissions": permissions(),
        "events": crate::api::EVENTS,
    }))
    .into_response()
}

/// `POST /app/installations/{id}/access_tokens`.
async fn access_token(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Path(installation): Path<i64>,
    body: axum::body::Bytes,
) -> Response {
    if let Err(r) = check_jwt(&fake, &headers) {
        return r;
    }
    let granted = match asked_permissions(&body) {
        Ok(p) => p,
        Err((status, why)) => return api::error(status, why),
    };
    let now = fake.now();
    let token = format!("ghs_{}", crate::random(36));
    let t = token.clone();
    let made = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(i) = q::installation(tx, installation)? else {
                return Ok(Minting::NoSuch);
            };
            if i.suspended_at.is_some() {
                return Ok(Minting::Suspended);
            }
            q::insert_installation_token(tx, &t, installation, now, now + TOKEN_TTL)?;
            Ok(Minting::Made)
        })
        .await;
    match made {
        Ok(Minting::Made) => {
            fake.state().app_tokens.record(installation, &granted);
            (
                StatusCode::CREATED,
                axum::Json(json!({
                    "token": token,
                    "expires_at": rfc3339(now + TOKEN_TTL),
                    "permissions": granted,
                    "repository_selection": "all",
                })),
            )
                .into_response()
        }
        Ok(Minting::NoSuch) => api::error(StatusCode::NOT_FOUND, "Not Found"),
        Ok(Minting::Suspended) => api::error(
            StatusCode::FORBIDDEN,
            "This installation has been suspended",
        ),
        Err(e) => api::internal(e),
    }
}

/// What minting a token found.
enum Minting {
    Made,
    NoSuch,
    Suspended,
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
  p, small {{ color: GrayText; }}
  ul {{ list-style: none; padding: 0; margin: 24px 0 0; }}
  li + li {{ margin-top: 8px; }}
  li {{ padding: 12px 16px; border: 1px solid GrayText; border-radius: 6px; }}
  a {{ color: LinkText; }}
  button {{ font: inherit; color: ButtonText; background: ButtonFace; border: 1px solid GrayText;
            border-radius: 6px; padding: 4px 12px; margin-left: 8px; cursor: pointer; }}
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

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

#[derive(Deserialize)]
struct InstallQuery {
    login: Option<String>,
    state: Option<String>,
}

/// Who is on the install page: the `login` parameter, else the fake's github.com session.
fn who(q: &InstallQuery, headers: &HeaderMap) -> Option<String> {
    q.login
        .clone()
        .or_else(|| cookie(headers, SESSION_COOKIE))
        .filter(|l| !l.is_empty())
}

/// `GET /apps/{slug}/installations/new`: pick the account to install on.
async fn install_page(
    State(fake): State<Fake>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(q): Query<InstallQuery>,
) -> Response {
    if slug != SLUG {
        return api::not_found().await;
    }
    let accounts = match fake.state().truth.read(q::accounts).await {
        Ok(a) => a,
        Err(e) => return api::internal(e),
    };
    let Some(login) = who(&q, &headers).filter(|l| accounts.iter().any(|a| a.login == *l)) else {
        // Signed out of the fake's github.com: pick who you are, as on the authorize page.
        let items: String = accounts
            .iter()
            .map(|a| {
                let mut params = vec![("login", a.login.clone())];
                if let Some(s) = &q.state {
                    params.push(("state", s.clone()));
                }
                format!(
                    "<li><a href=\"/apps/{SLUG}/installations/new?{}\">{}</a> <small>{}</small></li>\n",
                    escape(&serde_urlencoded::to_string(&params).unwrap_or_default()),
                    escape(&a.login),
                    escape(&a.name)
                )
            })
            .collect();
        return page(
            "Sign in to Fake GitHub",
            &format!("<h1>Sign in to Fake GitHub</h1>\n<p>Pick who installs {SLUG}.</p>\n<ul>\n{items}</ul>"),
        )
        .into_response();
    };
    let l = login.clone();
    let installed = match fake
        .state()
        .truth
        .read(move |c| q::installation_on(c, &l))
        .await
    {
        Ok(i) => i,
        Err(e) => return api::internal(e),
    };
    let row = match (&installed, fake.setup_url()) {
        (Some(id), Some(setup)) => format!(
            "Installed · <a href=\"{}\">Configure</a>",
            escape(&setup_redirect(&setup, *id, "update", q.state.as_deref()))
        ),
        (Some(_), None) => "Installed".to_owned(),
        (None, _) => {
            let state = q
                .state
                .as_deref()
                .map(|s| {
                    format!(
                        "<input type=\"hidden\" name=\"state\" value=\"{}\">",
                        escape(s)
                    )
                })
                .unwrap_or_default();
            format!(
                "<form method=\"post\" action=\"/apps/{SLUG}/installations/new\" style=\"display:inline\">\
<input type=\"hidden\" name=\"login\" value=\"{l}\"><input type=\"hidden\" name=\"target\" value=\"{l}\">{state}\
<button type=\"submit\">Install</button></form>",
                l = escape(&login)
            )
        }
    };
    page(
        &format!("Install {SLUG}"),
        &format!(
            "<h1>Install {SLUG}</h1>\n<p>Where do you want to install {SLUG}? It gets all repositories of the account.</p>\n<ul>\n<li>{} {row}</li>\n</ul>",
            escape(&login)
        ),
    )
    .into_response()
}

#[derive(Deserialize)]
struct InstallForm {
    login: String,
    target: String,
    state: Option<String>,
}

fn setup_redirect(setup: &str, installation: i64, action: &str, state: Option<&str>) -> String {
    let mut params = vec![
        ("installation_id", installation.to_string()),
        ("setup_action", action.to_owned()),
    ];
    if let Some(s) = state {
        params.push(("state", s.to_owned()));
    }
    let sep = if setup.contains('?') { '&' } else { '?' };
    format!(
        "{setup}{sep}{}",
        serde_urlencoded::to_string(&params).unwrap_or_default()
    )
}

/// The installation as GitHub's webhooks carry it; `suspended_by` is who suspended it, while it
/// is suspended (the account's owner, as the API lists it).
fn installation_json(i: &q::InstallationRow, suspended_by: Value) -> Value {
    json!({
        "id": i.id,
        "client_id": null,
        "account": {
            "login": i.account_login,
            "id": i.account_id,
            "node_id": format!("U_kg{}", i.account_id),
            "type": i.account_type,
        },
        "repository_selection": "all",
        "app_id": DEV_APP_ID,
        "app_slug": SLUG,
        "target_id": i.account_id,
        "target_type": i.account_type,
        "permissions": permissions(),
        "events": crate::api::EVENTS,
        "created_at": rfc3339(i.created_at),
        "updated_at": rfc3339(i.suspended_at.unwrap_or(i.created_at)),
        "suspended_by": suspended_by,
        "suspended_at": i.suspended_at.map(rfc3339),
    })
}

/// An `installation` delivery (`created`, `deleted`, `suspend`, `unsuspend`), naming the
/// installation's repos.
fn installation_delivery(
    c: &rusqlite::Connection,
    action: &str,
    i: &q::InstallationRow,
    repos: &[i64],
    sender: &Value,
) -> rusqlite::Result<Delivery> {
    let repos: Vec<Value> = repos
        .iter()
        .map(|id| {
            let r = q::repo(c, *id)?;
            let full = repo_json(&r);
            Ok(json!({
                "id": full["id"], "node_id": full["node_id"], "name": full["name"],
                "full_name": full["full_name"], "private": full["private"],
            }))
        })
        .collect::<rusqlite::Result<_>>()?;
    let suspended_by = match i.suspended_at {
        Some(_) => q::user_row(c, i.account_id)?.map_or(Value::Null, |u| {
            user_json(u.id, &u.login, u.avatar_url.as_deref())
        }),
        None => Value::Null,
    };
    Ok(Delivery::new(
        "installation",
        json!({
            "action": action,
            "installation": installation_json(i, suspended_by),
            "repositories": repos,
            "requester": null,
            "sender": sender,
        }),
    ))
}

/// The install page's form: installs the App on the user's own account.
async fn install(
    State(fake): State<Fake>,
    Path(slug): Path<String>,
    Form(f): Form<InstallForm>,
) -> Response {
    if slug != SLUG {
        return api::not_found().await;
    }
    if !f.login.eq_ignore_ascii_case(&f.target) {
        return api::error(
            StatusCode::FORBIDDEN,
            "You can only install the App on an account you administer",
        );
    }
    let now = fake.now();
    let login = f.login.clone();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(user) = q::account_by_login(tx, &login)? else {
                return Ok(Err("no such account"));
            };
            if q::installation_on(tx, &login)?.is_some() {
                return Ok(Err("already installed"));
            }
            let id = q::next_installation_id(tx)?;
            q::add_installation(tx, id, user.id, &user.login, "User", now)?;
            let repos = q::owned_repos(tx, &user.login)?;
            for r in &repos {
                q::set_repo_installation(tx, *r, Some(id))?;
            }
            let i = q::installation(tx, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let u = q::user_row(tx, user.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let sender = user_json(u.id, &u.login, u.avatar_url.as_deref());
            let d = installation_delivery(tx, "created", &i, &repos, &sender)?;
            Ok(Ok((id, d)))
        })
        .await;
    let (id, delivery) = match done {
        Ok(Ok(v)) => v,
        Ok(Err(why)) => return api::error(StatusCode::UNPROCESSABLE_ENTITY, why),
        Err(e) => return api::internal(e),
    };
    fake.state().webhooks.send(vec![delivery]);
    match fake.setup_url() {
        Some(setup) => (
            StatusCode::FOUND,
            [(
                header::LOCATION,
                setup_redirect(&setup, id, "install", f.state.as_deref()),
            )],
        )
            .into_response(),
        None => page(
            "Installed",
            &format!(
                "<h1>Installed</h1>\n<p>{SLUG} is installed on {}.</p>",
                escape(&f.login)
            ),
        )
        .into_response(),
    }
}

/// Uninstalls the App from `login`'s own account, as the user would in their settings: the
/// installation and its tokens go, and GitHub sends `installation` `deleted`. False when the App
/// isn't installed there.
pub(crate) async fn uninstall(fake: &Fake, login: String) -> Result<bool, fake_db::Error> {
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(id) = q::installation_on(tx, &login)? else {
                return Ok(None);
            };
            let i = q::installation(tx, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let repos = q::installation_repos(tx, i.id)?;
            let sender = match q::user_row(tx, i.account_id)? {
                Some(u) => user_json(u.id, &u.login, u.avatar_url.as_deref()),
                None => Value::Null,
            };
            let d = installation_delivery(tx, "deleted", &i, &repos, &sender)?;
            for r in &repos {
                q::set_repo_installation(tx, *r, None)?;
            }
            q::revoke_installation_tokens(tx, i.id)?;
            q::delete_installation(tx, i.id)?;
            Ok(Some(d))
        })
        .await?;
    Ok(match done {
        Some(d) => {
            fake.state().webhooks.send(vec![d]);
            true
        }
        None => false,
    })
}

/// Suspends (or unsuspends) the App's installation on `login`'s own account, as the user would in
/// their settings: GitHub sends `installation` `suspend` (or `unsuspend`). While suspended, the
/// installation still lists, mints no tokens, and its tokens stop working. False when the App
/// isn't installed there.
pub(crate) async fn suspend(
    fake: &Fake,
    login: String,
    suspended: bool,
) -> Result<bool, fake_db::Error> {
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let Some(id) = q::installation_on(tx, &login)? else {
                return Ok(None);
            };
            q::set_installation_suspended(tx, id, suspended.then_some(now))?;
            let i = q::installation(tx, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let repos = q::installation_repos(tx, i.id)?;
            let sender = match q::user_row(tx, i.account_id)? {
                Some(u) => user_json(u.id, &u.login, u.avatar_url.as_deref()),
                None => Value::Null,
            };
            let action = if suspended { "suspend" } else { "unsuspend" };
            Ok(Some(installation_delivery(
                tx, action, &i, &repos, &sender,
            )?))
        })
        .await?;
    Ok(match done {
        Some(d) => {
            fake.state().webhooks.send(vec![d]);
            true
        }
        None => false,
    })
}

impl Fake {
    pub(crate) fn setup_url(&self) -> Option<String> {
        self.state()
            .setup_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub(crate) fn set_setup_url(&self, url: Option<String>) {
        *self
            .state()
            .setup_url
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = url;
    }
}
