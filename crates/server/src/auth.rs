//! Signing in with the GitHub App web flow (PKCE and `state`), and the browser session behind
//! every API request.
//!
//! - `GET /auth/login?next=…&login=…&add=1` seals `state`, the PKCE verifier and `next` into a
//!   short-lived cookie, then sends the browser to GitHub's authorize page. `login` is passed
//!   through (GitHub's account hint; Fake GitHub signs that fixture user in at once); without
//!   one, a browser whose active account must sign in again hints that account. `add` (adding
//!   another account) asks GitHub to offer its account picker (`prompt=select_account`).
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
//!   sign-in is worth nothing after it. `beghu_acct` is a readable hint of the active account;
//!   every answer as an account puts it right when the session changed under the browser.
//! - Every API request may name the tab's account (`X-Beghu-Account`; the stream's `?account=`),
//!   and every write must (400 without). One that isn't the session's active account is answered
//!   409 `switched`, having done nothing: the user switched or signed out in another tab. The
//!   shell's preloads name none; they're for whoever is active, and every answer names the
//!   account it was made as (`X-Beghu-Account`), so the tab drops a preload made for another.
//!
//! The sign-in cookie is `__Host-` prefixed too, so a sibling subdomain can't plant one: a planted
//! `state` and verifier would let another site finish its own sign-in in this browser. The
//! accounts a session carries over at sign-in are shown plainly: the header names the active
//! one, and the account menu lists every one, so an account the user didn't sign in as can't
//! hide (see `accounts.rs`).
//!
//! The `__Host-` prefix makes browsers refuse the cookie unless it's `Secure` and set from a
//! secure origin. Dev runs over plain `http://localhost`, which Chrome and Firefox treat as a
//! secure origin for cookies, so the same cookie works there unchanged (Safari doesn't, as it
//! already didn't for the plain `Secure` cookie).

use crate::crypto::{self, b64, sha256, unb64};
use crate::error::ApiError;
use crate::tokens::AccountStatus;
use crate::{App, now};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Redirect, Response};
use control_db::q;
use serde::{Deserialize, Serialize};

pub const SESSION_COOKIE: &str = "__Host-beghu_sid";
pub const ACCOUNT_COOKIE: &str = "beghu_acct";
/// The tab's account, on every API request it makes.
pub const ACCOUNT_HEADER: &str = "x-beghu-account";
const SIGN_IN_COOKIE: &str = "__Host-beghu_signin";
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

pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

pub(crate) fn set_cookie(
    name: &str,
    value: &str,
    path: &str,
    max_age: i64,
    http_only: bool,
) -> HeaderValue {
    let http_only = if http_only { "; HttpOnly" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path={path}; Max-Age={max_age}{http_only}; Secure; SameSite=Lax"
    ))
    .expect("cookie values are base64url or digits")
}

pub(crate) fn session_cookies(sid: &str, account: i64) -> [HeaderValue; 2] {
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

/// The `beghu_acct` hint to send back when the request's doesn't name `active`, the session's
/// active account: the session changed under this browser (a switch, a sign-in or a Disconnect
/// in another browser), and a tab loaded with the old hint would be on an account the session
/// no longer has active. Sent on every answer as the account, refusals included (a 409
/// `switched`, the stream's one event), so the browser's next load is on the active account.
pub(crate) fn account_hint(headers: &HeaderMap, active: i64) -> Option<HeaderValue> {
    let active = active.to_string();
    (cookie(headers, ACCOUNT_COOKIE).as_deref() != Some(active.as_str()))
        .then(|| set_cookie(ACCOUNT_COOKIE, &active, "/", SESSION_TTL, false))
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

/// The hash of the session id the browser holds, if it holds a well-formed one.
pub(crate) fn session_hash(headers: &HeaderMap) -> Option<Vec<u8>> {
    cookie(headers, SESSION_COOKIE)
        .and_then(|c| unb64(&c))
        .filter(|r| r.len() == 32)
        .map(|r| sha256(&r))
}

/// The cookies that end the browser's session: both cleared.
pub(crate) fn cleared_cookies() -> [HeaderValue; 2] {
    [
        set_cookie(SESSION_COOKIE, "", "/", 0, true),
        set_cookie(ACCOUNT_COOKIE, "", "/", 0, false),
    ]
}

/// The browser's live session, as its cookie names it: the cookie's id, its hash, and the
/// session's row (its active account and that account's status). `None` without one: no cookie,
/// a malformed one, or a session that expired or ended.
pub(crate) struct LiveSession {
    pub sid: String,
    pub id_hash: Vec<u8>,
    pub row: q::SessionRow,
}

pub(crate) async fn live_session(
    app: &App,
    headers: &HeaderMap,
) -> Result<Option<LiveSession>, control_db::Error> {
    let Some(sid) = cookie(headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    let Some(id_hash) = session_hash(headers) else {
        return Ok(None);
    };
    let (h, t) = (id_hash.clone(), now());
    let row = app.control().read(move |c| q::session(c, &h, t)).await?;
    Ok(row.map(|row| LiveSession { sid, id_hash, row }))
}

/// Why a request can't go on as the browser session's active account.
pub(crate) enum Refusal {
    /// No live session, or one with no account left: sign in.
    SignedOut,
    /// The session's active account lost access to GitHub: it must sign in again.
    SignInAgain(i64),
    /// The request names another account (`X-Beghu-Account`, the stream's `?account=`) than
    /// the session's active one, which this is.
    Switched(i64),
    /// A write that names no account: beghu can't tell which tab's account it was made for.
    Unnamed,
    Failed(ApiError),
}

impl From<Refusal> for ApiError {
    fn from(r: Refusal) -> ApiError {
        match r {
            Refusal::SignedOut | Refusal::SignInAgain(_) => ApiError::SignedOut,
            Refusal::Switched(_) => ApiError::Switched,
            Refusal::Unnamed => ApiError::BadRequest(format!(
                "every API request that isn't a GET must carry {ACCOUNT_HEADER}"
            )),
            Refusal::Failed(e) => e,
        }
    }
}

/// A request let through: its session, and the cookies to send back: both if the session's
/// expiry slid (at most hourly), else the account hint if the request's names another account
/// ([`account_hint`]).
pub(crate) struct Admitted {
    pub session: Session,
    pub cookies: Vec<HeaderValue>,
}

impl Refusal {
    /// The account hint to send back with this refusal, when the session has an active account
    /// the request's hint doesn't name ([`account_hint`]).
    pub(crate) fn hint(&self, headers: &HeaderMap) -> Option<HeaderValue> {
        match self {
            Refusal::Switched(a) | Refusal::SignInAgain(a) => account_hint(headers, *a),
            _ => None,
        }
    }
}

/// Lets a request through as the browser session's active account, if it can be used and is
/// the account the request names (`claimed`, when it names one; a write must). Slides the
/// session's expiry at most hourly, and counts as the account's use ([`crate::accounts::used`]):
/// a dormant account wakes.
pub(crate) async fn admit(
    app: &App,
    headers: &HeaderMap,
    claimed: Option<&str>,
    write: bool,
) -> Result<Admitted, Refusal> {
    let live = match live_session(app, headers).await {
        Ok(Some(l)) => l,
        Ok(None) => return Err(Refusal::SignedOut),
        Err(e) => return Err(Refusal::Failed(e.into())),
    };
    let Some(account) = live.row.active_account_id else {
        return Err(Refusal::SignedOut);
    };
    match claimed {
        Some(c) if c.parse::<i64>().ok() != Some(account) => {
            return Err(Refusal::Switched(account));
        }
        None if write => return Err(Refusal::Unnamed),
        _ => {}
    }
    let status = live.row.status.as_deref().map(AccountStatus::from_db);
    let Some(status) = status.filter(|s| s.is_usable()) else {
        return Err(Refusal::SignInAgain(account));
    };
    // The account is in use: a dormant one wakes, and is re-imported. Only a failed wake fails
    // the request (the account would stay dormant); a failed move of `last_active_at` is
    // logged, and the next request moves it.
    crate::accounts::used(app, account, status, live.row.last_active_at.unwrap_or(0))
        .await
        .map_err(|e| Refusal::Failed(e.into()))?;
    let t = now();
    let touch = t - live.row.last_seen_at >= TOUCH_EVERY;
    if touch {
        let h = live.id_hash.clone();
        app.control()
            .write(move |tx| q::touch_session(tx, &h, t, t + SESSION_TTL))
            .await
            .map_err(|e| Refusal::Failed(e.into()))?;
    }
    Ok(Admitted {
        session: Session {
            id_hash: live.id_hash,
            account,
        },
        cookies: if touch {
            session_cookies(&live.sid, account).into()
        } else {
            account_hint(headers, account).into_iter().collect()
        },
    })
}

/// The API's gate: answers 401 without a live session whose active account can be used, 409
/// `switched` to a request naming another account than the active one (`X-Beghu-Account`), and
/// 400 to a write that names none. Every answer it lets through names the account it was made
/// as (`X-Beghu-Account`), so a tab can tell a preload served for another account, and every
/// answer as an account puts a stale `beghu_acct` right ([`account_hint`]). The stream
/// is let in by [`admit`] itself, to answer in its own terms (live.rs).
pub async fn require_session(State(app): State<App>, mut req: Request, next: Next) -> Response {
    let write = !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let claimed = req
        .headers()
        .get(ACCOUNT_HEADER)
        .map(|v| v.to_str().unwrap_or("").to_owned());
    let admitted = match admit(&app, req.headers(), claimed.as_deref(), write).await {
        Ok(a) => a,
        Err(r) => {
            let hint = r.hint(req.headers());
            let mut res = ApiError::from(r).into_response();
            res.headers_mut()
                .extend(hint.map(|c| (header::SET_COOKIE, c)));
            return res;
        }
    };
    let account = admitted.session.account;
    req.extensions_mut().insert(admitted.session);
    let mut res = next.run(req).await;
    res.headers_mut()
        .insert(ACCOUNT_HEADER, HeaderValue::from(account));
    for c in admitted.cookies {
        res.headers_mut().append(header::SET_COOKIE, c);
    }
    res
}

#[derive(Deserialize)]
pub struct LoginQuery {
    next: Option<String>,
    login: Option<String>,
    /// Adding another account: GitHub offers its account picker.
    add: Option<String>,
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
pub(crate) fn safe_next(next: Option<&str>) -> String {
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

pub async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<LoginQuery>,
) -> Response {
    let hint = match q.login.as_deref().filter(|l| !l.is_empty()) {
        Some(l) => Some(l.to_owned()),
        None if q.add.is_none() => must_sign_in_again(&app, &headers).await,
        None => None,
    };
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
        hint.as_deref(),
        q.add.is_some(),
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
        set_cookie(SIGN_IN_COOKIE, &sealed, "/", SIGN_IN_TTL, true),
    );
    res
}

/// The login of the browser session's active account, if it must sign in again (it lost
/// access): signing in asks GitHub for that account.
async fn must_sign_in_again(app: &App, headers: &HeaderMap) -> Option<String> {
    let row = live_session(app, headers).await.ok()??.row;
    let account = row.active_account_id?;
    if row.status.as_deref().map(AccountStatus::from_db) != Some(AccountStatus::NeedsSignIn) {
        return None;
    }
    let a = app
        .control()
        .read(move |c| q::account(c, account))
        .await
        .ok()??;
    Some(a.login)
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
        set_cookie(SIGN_IN_COOKIE, "", "/", 0, true),
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
                set_cookie(SIGN_IN_COOKIE, "", "/", 0, true),
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
    let row = live_session(app, headers).await.ok()??.row;
    // A dormant one signs in again, which wakes it.
    match (
        row.active_account_id,
        row.status.as_deref().map(AccountStatus::from_db),
    ) {
        (Some(a), Some(AccountStatus::Active)) => Some(a),
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
    let was = app
        .control()
        .write(move |tx| {
            let was = q::account(tx, id)?.map(|a| a.status);
            q::sign_in_account(tx, id, &login, t)?;
            Ok(was)
        })
        .await?;
    let created = was.is_none();
    app.tokens().sign_in(id, pair).await?;
    if was.as_deref().map(AccountStatus::from_db) == Some(AccountStatus::Dormant) {
        crate::accounts::back_from_dormancy(app, id);
    }
    // A mirror deleted when the account lost access (or went dormant) comes back empty, and
    // imports.
    app.mirrors().revive(id);
    if created {
        crate::repos::adopt_mirror_pick(app, id).await?;
    }

    // Always a new id. A live session the browser already has keeps its accounts under it.
    let old = session_hash(headers);
    let sid = crypto::random_token(32);
    let id_hash = sha256(&unb64(&sid).expect("just encoded"));
    {
        let (old, id_hash) = (old.clone(), id_hash.clone());
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
    }
    // The browser's open tabs follow the session to its new id, and hear that this account is
    // now the active one.
    if let Some(old) = &old {
        app.hub().rekey_session(old, &id_hash);
    }
    app.hub()
        .publish_session(&id_hash, crate::live::Push::switched(Some(id), false));
    // The role table starts current.
    crate::repos::refresh_roles_now(app, id).await;
    Ok(session_cookies(&sid, id))
}
