//! Signing in with the GitHub App web flow (PKCE and `state`), and the browser session behind
//! every API request.
//!
//! - `GET /auth/login?next=…&login=…` seals `state`, the PKCE verifier and `next` into a
//!   short-lived cookie, then sends the browser to GitHub's authorize page. `login` is passed
//!   through (GitHub's account hint; Fake GitHub signs that fixture user in at once).
//! - `GET /auth/callback?code&state` checks `state` against that cookie, trades the code for the
//!   user's token pair, stores it encrypted, adds the account to the browser session and makes
//!   it active, then lands on `next`. A user who can reach no installation of the App gets the
//!   install step instead, and an account that hasn't picked repos yet goes to the picker.
//! - `GET /auth/setup` is the App's setup URL, where GitHub sends the browser after an install:
//!   it goes on to the picker (`/repos`), re-reading the account's visible repos only if stale
//!   (the installation's webhook re-reads them).
//! - `__Host-beghu_sid` is 256 random bits, `HttpOnly; Secure; SameSite=Lax; Path=/` with no
//!   `Domain`, sliding 30 days. Only its SHA-256 is stored. Every sign-in rotates it: a new id,
//!   the session's accounts moved over, the old id deleted, so an id planted or seen before
//!   sign-in is worth nothing after it. `beghu_acct` is a readable hint of the active account.
//!
//! The `__Host-` prefix makes browsers refuse the cookie unless it's `Secure` and set from a
//! secure origin. Dev runs over plain `http://localhost`, which Chrome and Firefox treat as a
//! secure origin for cookies, so the same cookie works there unchanged (Safari doesn't, as it
//! already didn't for the plain `Secure` cookie).

use crate::crypto::{self, b64, sha256, unb64};
use crate::error::ApiError;
use crate::{App, now};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Redirect, Response};
use control_db::q;
use serde::{Deserialize, Serialize};

pub const SESSION_COOKIE: &str = "__Host-beghu_sid";
pub const ACCOUNT_COOKIE: &str = "beghu_acct";
const SIGN_IN_COOKIE: &str = "beghu_signin";
/// The sign-in cookie's associated data: its key seals nothing else.
const SIGN_IN_AAD: &[u8] = b"";
/// 30 days, sliding.
pub const SESSION_TTL: i64 = 30 * 24 * 3600;
/// `last_seen_at` (and with it the expiry) moves at most hourly.
const TOUCH_EVERY: i64 = 3600;
/// A sign-in has 10 minutes to come back, as GitHub's codes do.
const SIGN_IN_TTL: i64 = 600;

/// The active account of the request's browser session, put in the request's extensions by
/// [`require_session`].
#[derive(Clone, Debug)]
pub struct Session {
    pub id_hash: Vec<u8>,
    pub account: i64,
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

fn set_cookie(name: &str, value: &str, path: &str, max_age: i64, http_only: bool) -> HeaderValue {
    let http_only = if http_only { "; HttpOnly" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path={path}; Max-Age={max_age}{http_only}; Secure; SameSite=Lax"
    ))
    .expect("cookie values are base64url or digits")
}

fn session_cookies(sid: &str, account: i64) -> [HeaderValue; 2] {
    [
        set_cookie(SESSION_COOKIE, sid, "/", SESSION_TTL, true),
        set_cookie(
            ACCOUNT_COOKIE,
            &account.to_string(),
            "/",
            SESSION_TTL,
            false,
        ),
    ]
}

/// Whether a request comes from beghu's own pages: its `Origin` is beghu's public URL, or, when
/// `none_is_ours`, it has no `Origin` at all (a same-origin `EventSource` sends none).
pub fn from_beghu(app: &App, headers: &HeaderMap, none_is_ours: bool) -> bool {
    match headers.get(header::ORIGIN) {
        None => none_is_ours,
        Some(o) => o.as_bytes() == app.cfg().public_url.as_bytes(),
    }
}

/// Every API request that isn't a GET must come from beghu's own pages. Browsers send `Origin`
/// on every such request, so one without it (or from another site) is refused with 403 before
/// the session is looked at. The session cookie is `SameSite=Lax`, which already keeps it off
/// cross-site POSTs; this check doesn't lean on that.
pub async fn require_same_origin(State(app): State<App>, req: Request, next: Next) -> Response {
    let safe = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    if !safe && !from_beghu(&app, req.headers(), false) {
        return ApiError::Forbidden("Only beghu's own pages may make this request".into())
            .into_response();
    }
    next.run(req).await
}

/// The API's gate: answers 401 without a live session whose active account can be used, and
/// slides the session's expiry (re-sending the cookie) at most hourly.
pub async fn require_session(State(app): State<App>, mut req: Request, next: Next) -> Response {
    let Some(sid) = cookie(req.headers(), SESSION_COOKIE) else {
        return ApiError::SignedOut.into_response();
    };
    let Some(raw) = unb64(&sid).filter(|r| r.len() == 32) else {
        return ApiError::SignedOut.into_response();
    };
    let id_hash = sha256(&raw);
    let t = now();
    let looked = {
        let h = id_hash.clone();
        app.control().read(move |c| q::session(c, &h, t)).await
    };
    let row = match looked {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::SignedOut.into_response(),
        Err(e) => return ApiError::from(e).into_response(),
    };
    let (Some(account), Some(crate::tokens::account_status::ACTIVE)) =
        (row.active_account_id, row.status.as_deref())
    else {
        return ApiError::SignedOut.into_response();
    };
    let touch = t - row.last_seen_at >= TOUCH_EVERY;
    if touch {
        let h = id_hash.clone();
        if let Err(e) = app
            .control()
            .write(move |tx| q::touch_session(tx, &h, t, t + SESSION_TTL))
            .await
        {
            return ApiError::from(e).into_response();
        }
    }
    req.extensions_mut().insert(Session { id_hash, account });
    let mut res = next.run(req).await;
    if touch {
        for c in session_cookies(&sid, account) {
            res.headers_mut().append(header::SET_COOKIE, c);
        }
    }
    res
}

#[derive(Deserialize)]
pub struct LoginQuery {
    next: Option<String>,
    login: Option<String>,
}

/// What the sign-in cookie carries from `/auth/login` to the callback, sealed.
#[derive(Serialize, Deserialize)]
struct Pending {
    state: String,
    verifier: String,
    next: String,
    at: i64,
}

/// `next` if it's a path inside beghu, else `/`. Bytes that can't go in a `Location` header as
/// they are (non-ASCII text, spaces) are percent-encoded, which is how the browser sent them.
fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(n)
            if n.starts_with('/')
                && !n.starts_with("//")
                && !n.starts_with("/\\")
                && !n.chars().any(char::is_control) =>
        {
            let mut out = String::with_capacity(n.len());
            for b in n.bytes() {
                if b.is_ascii_graphic() {
                    out.push(b as char);
                } else {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            out
        }
        _ => "/".into(),
    }
}

pub fn callback_url(app: &App) -> String {
    format!("{}/auth/callback", app.cfg().public_url)
}

pub async fn login(State(app): State<App>, Query(q): Query<LoginQuery>) -> Response {
    let pending = Pending {
        state: crypto::random_token(32),
        verifier: crypto::random_token(32),
        next: safe_next(q.next.as_deref()),
        at: now(),
    };
    let to = app.github().authorize_url(
        &callback_url(&app),
        &pending.state,
        &crypto::pkce_challenge(&pending.verifier),
        q.login.as_deref().filter(|l| !l.is_empty()),
    );
    let sealed = b64(&app.keys().sign_in.seal(
        SIGN_IN_AAD,
        &serde_json::to_vec(&pending).expect("plain struct"),
    ));
    let mut res = Redirect::to(&to).into_response();
    // `Redirect::to` is a 303; GitHub's own redirects are 302s, and either is a GET.
    *res.status_mut() = StatusCode::FOUND;
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SIGN_IN_COOKIE, &sealed, "/auth", SIGN_IN_TTL, true),
    );
    res
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// A plain page for a sign-in that can't go on. System colours only: it follows the light or
/// dark scheme by itself.
fn sign_in_failed(status: StatusCode, why: &str, next: &str) -> Response {
    let again = format!(
        "/auth/login?{}",
        serde_urlencoded::to_string([("next", next)]).unwrap_or_default()
    );
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign-in didn't finish · beghu</title>
<style>
  :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
  body {{ background: Canvas; color: CanvasText; margin: 0; padding: 48px 16px; }}
  main {{ max-width: 420px; margin: 0 auto; }}
  h1 {{ font-size: 20px; font-weight: 600; }}
  p {{ color: GrayText; }}
  a {{ color: LinkText; }}
</style>
</head>
<body><main>
<h1>Sign-in didn't finish</h1>
<p>{why}</p>
<p><a href="{again}" rel="external">Sign in again</a></p>
</main></body>
</html>
"#
    );
    let mut res = (status, Html(html)).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SIGN_IN_COOKIE, "", "/auth", 0, true),
    );
    res
}

pub async fn callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let bad = |why: &str| sign_in_failed(StatusCode::BAD_REQUEST, why, "/");
    if q.error.is_some() {
        return bad("GitHub didn't authorize beghu.");
    }
    let pending = cookie(&headers, SIGN_IN_COOKIE)
        .and_then(|c| unb64(&c))
        .and_then(|s| app.keys().sign_in.open(SIGN_IN_AAD, &s))
        .and_then(|p| serde_json::from_slice::<Pending>(&p).ok())
        .filter(|p| now() - p.at <= SIGN_IN_TTL);
    let Some(pending) = pending else {
        return bad("This sign-in expired or was started in another browser.");
    };
    let (Some(code), Some(state)) = (q.code, q.state) else {
        return bad("GitHub sent beghu back without a code.");
    };
    if state != pending.state {
        return bad("This sign-in expired or was started in another browser.");
    }
    let gh = app.github();
    let next = pending.next.as_str();
    // GitHub refusing the code is the sign-in's fault; anything else is GitHub's.
    let upstream = |e: crate::github::Error| match e {
        crate::github::Error::Refused(_) => sign_in_failed(
            StatusCode::BAD_REQUEST,
            "GitHub didn't accept this sign-in. Try again.",
            next,
        ),
        _ => sign_in_failed(
            StatusCode::BAD_GATEWAY,
            "GitHub didn't answer. Try again.",
            next,
        ),
    };
    let pair = match gh
        .exchange_code(&code, &callback_url(&app), &pending.verifier)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("sign-in: the code exchange failed: {e}");
            return upstream(e);
        }
    };
    let user = match gh.user(&pair.access).await {
        Ok(u) => u,
        Err(e) => {
            eprintln!("sign-in: reading the user failed: {e}");
            return upstream(e);
        }
    };
    // Whether the user can reach an installation, asked beside the sign-in's re-read of the
    // repos and bounded as it is: a slow GitHub costs the sign-in 2 s, not 4.
    let installations = tokio::time::timeout(
        crate::repos::WAIT,
        app.github().user_installations(&pair.access),
    );
    let (finished, installations) =
        tokio::join!(finish(&app, &headers, &user, &pair), installations);
    match finished {
        Ok(cookies) => {
            let mut res = match landing(&app, user.id, installations).await {
                Landing::Install(url) => install_step(url.as_deref()),
                Landing::Pick => {
                    (StatusCode::FOUND, [(header::LOCATION, "/repos")]).into_response()
                }
                Landing::Next => (StatusCode::FOUND, [(header::LOCATION, next)]).into_response(),
            };
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            for c in cookies {
                res.headers_mut().append(header::SET_COOKIE, c);
            }
            res.headers_mut().append(
                header::SET_COOKIE,
                set_cookie(SIGN_IN_COOKIE, "", "/auth", 0, true),
            );
            res
        }
        // At capacity, or beghu restarting (the drain sealed the control DB under it): a 503
        // with `retry-after`, as the API answers.
        Err(ApiError::Unavailable { retry_after, why }) => {
            eprintln!("sign-in: storing the session failed: {why}");
            let mut res = sign_in_failed(
                StatusCode::SERVICE_UNAVAILABLE,
                "beghu is busy or restarting. Sign in again in a moment.",
                next,
            );
            res.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from(retry_after.as_secs().max(1)),
            );
            res
        }
        Err(e) => {
            eprintln!("sign-in: storing the session failed: {e:?}");
            sign_in_failed(
                StatusCode::INTERNAL_SERVER_ERROR,
                "beghu couldn't finish signing you in. Try again.",
                next,
            )
        }
    }
}

/// Where a sign-in lands.
enum Landing {
    /// The user can reach no installation of the App: install it (from this URL, when GitHub
    /// said where).
    Install(Option<String>),
    /// The account syncs nothing yet: pick repos.
    Pick,
    /// Where the sign-in started.
    Next,
}

/// Decided by `/user/installations`, asked with the sign-in's own token: none at all means
/// installing the App. An installation with no repos, or one whose repos are slow to list, is
/// still an installation; if GitHub doesn't answer in time, the sign-in goes on as if it had one
/// (the picker says when there's nothing to pick).
async fn landing(
    app: &App,
    account: i64,
    installations: Result<
        Result<Vec<crate::github::Installation>, crate::github::Error>,
        tokio::time::error::Elapsed,
    >,
) -> Landing {
    match installations {
        Ok(Ok(i)) if i.is_empty() => {
            let url = app
                .installations()
                .install_url(app.cfg().github.app_slug.as_deref())
                .await;
            return Landing::Install(url);
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => eprintln!("sign-in: reading the user's installations failed: {e}"),
        Err(_) => eprintln!("sign-in: GitHub was slow to list the user's installations"),
    }
    match app
        .control()
        .read(move |c| q::synced_repo_ids(c, account))
        .await
    {
        Ok(ids) if ids.is_empty() => Landing::Pick,
        _ => Landing::Next,
    }
}

/// The install step: a plain page linking to the App's install page on GitHub, which comes back
/// through the setup URL. System colours only.
fn install_step(url: Option<&str>) -> Response {
    let link = match url {
        Some(u) => format!(
            r#"<p><a href="{}" rel="external">Install beghu on GitHub</a></p>"#,
            u.replace('&', "&amp;").replace('"', "&quot;")
        ),
        None => "<p>GitHub didn't say where to install the App.</p>".into(),
    };
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Install beghu</title>
<style>
  :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
  body {{ background: Canvas; color: CanvasText; margin: 0; padding: 48px 16px; }}
  main {{ max-width: 420px; margin: 0 auto; }}
  h1 {{ font-size: 20px; font-weight: 600; }}
  p {{ color: GrayText; }}
  a {{ color: LinkText; }}
</style>
</head>
<body><main>
<h1>Install beghu</h1>
<p>beghu reads issues through its GitHub App, and none of your accounts or organizations has it
installed yet. Install it, pick the repos to sync, and you'll come straight back here.</p>
{link}
<p>Installed it already? <a href="/repos">Pick your repos</a>.</p>
</main></body>
</html>
"#
    );
    let mut res = Html(html).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /auth/setup`: GitHub's redirect after the App is installed or its repos change. On to
/// the picker, re-reading the account's visible repos first once the last re-read is
/// `setup_reread_after` (a minute) old, so the repos just installed are there without waiting
/// for the installation's webhook. Any site can send a browser here, but one re-read per account
/// runs at a time and a younger one isn't repeated, so it forces at most one re-read a minute per
/// account. A re-read costs the user's rate limit one call for their installations plus one per
/// 100 repos of each, and a mirror write. Signed out, it signs in first.
pub async fn setup(State(app): State<App>, headers: HeaderMap) -> Response {
    let Some(account) = active_account(&app, &headers).await else {
        let to = format!(
            "/auth/login?{}",
            serde_urlencoded::to_string([("next", "/repos")]).unwrap_or_default()
        );
        return (StatusCode::FOUND, [(header::LOCATION, to)]).into_response();
    };
    // A signed-out answer here only means the picker signs in again.
    let _ = crate::repos::refresh_roles_if_older_than(&app, account, app.cfg().setup_reread_after)
        .await;
    let mut res = (StatusCode::FOUND, [(header::LOCATION, "/repos")]).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The active account of the request's live session, if it has one that can be used.
async fn active_account(app: &App, headers: &HeaderMap) -> Option<i64> {
    let raw = cookie(headers, SESSION_COOKIE)
        .and_then(|c| unb64(&c))
        .filter(|r| r.len() == 32)?;
    let h = sha256(&raw);
    let t = now();
    let row = app
        .control()
        .read(move |c| q::session(c, &h, t))
        .await
        .ok()??;
    match (row.active_account_id, row.status.as_deref()) {
        (Some(a), Some(crate::tokens::account_status::ACTIVE)) => Some(a),
        _ => None,
    }
}

/// Records the account and its tokens, and adds it to this browser's session (a new one if the
/// browser has none) as the active account, under a new session id. Returns the cookies to set.
async fn finish(
    app: &App,
    headers: &HeaderMap,
    user: &crate::github::User,
    pair: &crate::github::TokenPair,
) -> Result<[HeaderValue; 2], ApiError> {
    let t = now();
    let (id, login) = (user.id, user.login.clone());
    let created = app
        .control()
        .write(move |tx| {
            let new = q::account(tx, id)?.is_none();
            q::sign_in_account(tx, id, &login, t)?;
            Ok(new)
        })
        .await?;
    app.tokens().sign_in(id, pair).await?;
    if created {
        crate::repos::adopt_mirror_pick(app, id).await?;
    }

    // Always a new id. A live session the browser already has keeps its accounts under it.
    let old = cookie(headers, SESSION_COOKIE)
        .and_then(|c| unb64(&c))
        .filter(|r| r.len() == 32)
        .map(|r| sha256(&r));
    let sid = crypto::random_token(32);
    let id_hash = sha256(&unb64(&sid).expect("just encoded"));
    app.control()
        .write(move |tx| {
            q::create_session(tx, &id_hash, id, t, t + SESSION_TTL)?;
            if let Some(old) = old {
                if q::session(tx, &old, t)?.is_some() {
                    q::move_session_accounts(tx, &old, &id_hash)?;
                }
                q::delete_session(tx, &old)?;
            }
            q::add_session_account(tx, &id_hash, id, t)
        })
        .await?;
    // The role table starts current.
    crate::repos::refresh_roles_now(app, id).await;
    Ok(session_cookies(&sid, id))
}
