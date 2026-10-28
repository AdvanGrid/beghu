//! Several connected accounts in one browser, and every way out of a session.
//!
//! - `POST /auth/switch` (`account`, `next`): makes another account of the browser session the
//!   active one, then goes back to `next`. URLs carry no account: the same page shows the other
//!   account's data. An account that must sign in again goes to sign-in instead.
//! - `POST /auth/logout` (`account` or `all`, `next`): signs one account, or every one, out of
//!   this browser. Signing out the active account switches to another signed-in one if there is
//!   one; with none left, the session ends and the browser lands on a plain signed-out page.
//!   GitHub's tokens are left alone, so signing back in is quick and other browsers carry on.
//! - `POST /auth/disconnect` (`account`): revokes the account's grant on GitHub, deletes its
//!   mirror, its preferences and its tokens, and takes it out of every browser session. It keeps
//!   its repo pick, and its row as `needs_sign_in`, so nothing syncs for it until it signs in.
//!   Without usable tokens it can't reach the grant: it disconnects all the same, and its answer
//!   says GitHub access wasn't revoked, linking to GitHub's authorized-apps page.
//! - `GET /auth/signed-out`: the page a browser lands on with nothing signed in.
//!
//! The three are form posts from beghu's own pages, `Origin`-checked as every non-GET is. Each
//! change of a session's active account is pushed as `switched` to every open tab of that
//! browser (live.rs), so a tab left on the old account freezes its writes at once.
//!
//! The accounts a session carries are shown plainly: the header names the active one and the
//! account menu lists every one. A sign-in carries the accounts of the browser's live session
//! over to the new one (auth.rs); any of them the user doesn't recognise is in that list, to
//! sign out. (Telling an account the user added from one planted by another site isn't possible
//! from the session alone; the sign-in cookie being `__Host-` keeps a planted sign-in out.)
//!
//! **Lost access.** A refused refresh or unusable tokens (tokens.rs), a
//! `github_app_authorization` `revoked` delivery (webhook.rs), or a lapsed refresh token (the
//! daily check here) mark the account `needs_sign_in` and send it down [`lost_access`]: its
//! import stops, its mirror is deleted, and its open tabs are told to sign in again. Each marks
//! it where it finds out, in one conditional update, and only if it still holds: the account is
//! active and its tokens are the ones refused (or, for a revoke, were issued before beghu
//! received it). So a revoke applied late or replayed, or a refusal racing a sign-in, never
//! signs out an account that has signed in since. Every request of its sessions answers 401
//! (its stream, a `switched` asking to sign in again) until it does; signing in revives the
//! mirror empty, which imports the account's pick afresh. At startup, the mirrors of accounts that aren't active are
//! deleted (a delete the drain sealed out is finished there).

use crate::App;
use crate::auth;
use crate::live::Push;
use crate::tokens::account_status;
use axum::Form;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use control_db::q;
use serde::Deserialize;

/// Where a browser lands once nothing is signed in on it.
const SIGNED_OUT: &str = "/auth/signed-out";

/// A 303 to `to` (a form post's answer), never cached, setting `cookies`.
fn see_other(to: &str, cookies: impl IntoIterator<Item = HeaderValue>) -> Response {
    let mut res = (StatusCode::SEE_OTHER, [(header::LOCATION, to)]).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for c in cookies {
        h.append(header::SET_COOKIE, c);
    }
    res
}

/// The browser's live session: its id as the cookie holds it, and its hash.
async fn live_session(app: &App, headers: &HeaderMap) -> Option<(String, Vec<u8>)> {
    let live = auth::live_session(app, headers).await.ok()??;
    Some((live.sid, live.id_hash))
}

/// Who a session's active account becomes once `gone` has left it: the first of the accounts
/// still signed in that can be used, else the first of them (it will sign in again), else none.
fn successor(left: &[q::SessionAccountsRow]) -> Option<i64> {
    left.iter()
        .find(|a| a.status == account_status::ACTIVE)
        .or(left.first())
        .map(|a| a.github_user_id)
}

/// Tells the tabs of browser session `session` that its active account is now `account`.
fn tell_session(app: &App, session: &[u8], account: Option<i64>) {
    app.hub()
        .publish_session(session, Push::switched(account, false));
}

/// A plain page for a form post that can't go on. System colours only.
fn plain_page(status: StatusCode, title: &str, body: &str) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title} · beghu</title>
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
<h1>{title}</h1>
{body}
</main></body>
</html>
"#
    );
    let mut res = (status, Html(html)).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /auth/signed-out`.
pub async fn signed_out() -> Response {
    plain_page(
        StatusCode::OK,
        "You're signed out",
        r#"<p>Nothing is signed in to beghu in this browser. Your GitHub accounts stay connected,
so signing back in is quick.</p>
<p><a href="/auth/login">Sign in</a> · <a href="/auth/login?add=1">Sign in with another GitHub account</a></p>"#,
    )
}

#[derive(Deserialize)]
pub struct SwitchForm {
    account: i64,
    next: Option<String>,
}

/// `POST /auth/switch`.
pub async fn switch(
    State(app): State<App>,
    headers: HeaderMap,
    Form(f): Form<SwitchForm>,
) -> Response {
    let next = auth::safe_next(f.next.as_deref());
    let Some((sid, hash)) = live_session(&app, &headers).await else {
        return see_other(SIGNED_OUT, auth::cleared_cookies());
    };
    let (h, to) = (hash.clone(), f.account);
    let switched = app
        .control()
        .write(move |tx| {
            let Some(a) = q::session_accounts(tx, &h)?
                .into_iter()
                .find(|a| a.github_user_id == to)
            else {
                return Ok(None);
            };
            if a.status != account_status::ACTIVE {
                return Ok(Some(Err(a.login)));
            }
            q::set_active_account(tx, &h, to)?;
            Ok(Some(Ok(())))
        })
        .await;
    match switched {
        // Not an account of this browser's: nothing to do.
        Ok(None) => see_other(&next, []),
        Ok(Some(Err(login))) => {
            let to = format!(
                "/auth/login?{}",
                serde_urlencoded::to_string([("login", login.as_str()), ("next", next.as_str())])
                    .unwrap_or_default()
            );
            see_other(&to, [])
        }
        Ok(Some(Ok(()))) => {
            tell_session(&app, &hash, Some(to));
            see_other(&next, auth::session_cookies(&sid, to))
        }
        Err(e) => failed(e),
    }
}

/// A form post that couldn't be stored: beghu is busy or restarting, or failed.
fn failed(e: control_db::Error) -> Response {
    eprintln!("accounts: {e}");
    plain_page(
        StatusCode::SERVICE_UNAVAILABLE,
        "That didn't go through",
        r#"<p>beghu is busy or restarting. Go back and try again in a moment.</p>"#,
    )
}

#[derive(Deserialize)]
pub struct LogoutForm {
    /// The account to sign out; without it, `all`.
    account: Option<i64>,
    /// Every account.
    all: Option<String>,
    next: Option<String>,
}

/// How a session ended up after an account left it.
enum Left {
    /// The active account didn't change.
    Same,
    /// The active account is now this one.
    Switched(i64),
    /// Nothing is signed in any more: the session is gone.
    Ended,
}

/// `POST /auth/logout`.
pub async fn logout(
    State(app): State<App>,
    headers: HeaderMap,
    Form(f): Form<LogoutForm>,
) -> Response {
    let next = auth::safe_next(f.next.as_deref());
    let Some((sid, hash)) = live_session(&app, &headers).await else {
        return see_other(SIGNED_OUT, auth::cleared_cookies());
    };
    let h = hash.clone();
    let (account, all) = (f.account, f.all.is_some() || f.account.is_none());
    let left = app
        .control()
        .write(move |tx| {
            if all {
                q::delete_session(tx, &h)?;
                return Ok(Left::Ended);
            }
            let gone = account.expect("one account, or all");
            let active = q::session(tx, &h, crate::now())?.and_then(|s| s.active_account_id);
            q::remove_session_account(tx, &h, gone)?;
            leave(tx, &h, active, gone)
        })
        .await;
    match left {
        Ok(Left::Same) => see_other(&next, []),
        Ok(Left::Switched(to)) => {
            tell_session(&app, &hash, Some(to));
            see_other(&next, auth::session_cookies(&sid, to))
        }
        Ok(Left::Ended) => {
            tell_session(&app, &hash, None);
            see_other(SIGNED_OUT, auth::cleared_cookies())
        }
        Err(e) => failed(e),
    }
}

/// Once `gone` has left session `h`, whose active account was `active`: a successor if `gone`
/// was active, the session's end if nothing is left.
fn leave(
    tx: &rusqlite::Transaction,
    h: &[u8],
    active: Option<i64>,
    gone: i64,
) -> rusqlite::Result<Left> {
    let left = q::session_accounts(tx, h)?;
    if left.is_empty() {
        q::delete_session(tx, h)?;
        return Ok(Left::Ended);
    }
    if active.is_some_and(|a| a != gone) {
        return Ok(Left::Same);
    }
    let to = successor(&left).expect("not empty");
    q::set_active_account(tx, h, to)?;
    Ok(Left::Switched(to))
}

#[derive(Deserialize)]
pub struct DisconnectForm {
    account: i64,
}

/// `POST /auth/disconnect`.
pub async fn disconnect(
    State(app): State<App>,
    headers: HeaderMap,
    Form(f): Form<DisconnectForm>,
) -> Response {
    let Some((sid, hash)) = live_session(&app, &headers).await else {
        return see_other(SIGNED_OUT, auth::cleared_cookies());
    };
    let (h, account) = (hash.clone(), f.account);
    // Only an account signed in on this browser.
    let here = app
        .control()
        .read(move |c| q::session_accounts(c, &h))
        .await
        .map(|all| all.iter().any(|a| a.github_user_id == account));
    match here {
        Ok(true) => {}
        Ok(false) => return see_other("/", []),
        Err(e) => return failed(e),
    }

    // The grant first: if GitHub can't be told, nothing changes here, and the user can try again.
    let gh = app.github().clone();
    let revoked = app
        .tokens()
        .with_token(account, |token| {
            let gh = gh.clone();
            async move { gh.revoke_grant(&token).await }
        })
        .await;
    let revoked = match revoked {
        Ok(()) => true,
        // No usable tokens (GitHub refused them, they lapsed, or they don't open): beghu can't
        // reach the grant any more, so it may still be there. Disconnect goes on, and says so.
        Err(crate::tokens::Error::SignInAgain) => {
            eprintln!(
                "disconnect: account {account}: no usable tokens, so its grant on GitHub wasn't revoked"
            );
            false
        }
        Err(e) => {
            eprintln!("disconnect: account {account}: revoking the grant: {e}");
            return plain_page(
                StatusCode::BAD_GATEWAY,
                "GitHub didn't answer",
                r#"<p>beghu couldn't revoke its access on GitHub, so nothing was disconnected. Go back and try again in a moment.</p>"#,
            );
        }
    };

    let sessions = app
        .control()
        .write(move |tx| {
            let mut out = Vec::new();
            let sessions = q::sessions_of_account(tx, account)?;
            q::remove_account_from_sessions(tx, account)?;
            for s in sessions {
                let left = leave(tx, &s.id_hash, s.active_account_id, account)?;
                out.push((s.id_hash, left));
            }
            q::delete_tokens(tx, account)?;
            q::delete_preferences(tx, account)?;
            q::set_account_status(tx, account, account_status::NEEDS_SIGN_IN).map(|_| out)
        })
        .await;
    let sessions = match sessions {
        Ok(s) => s,
        Err(e) => return failed(e),
    };
    // Its tabs hear where their browser is now first; then it goes as any account losing access
    // does.
    let mut mine = Left::Same;
    for (session, left) in sessions {
        match &left {
            Left::Same => {}
            Left::Switched(to) => tell_session(&app, &session, Some(*to)),
            Left::Ended => tell_session(&app, &session, None),
        }
        if session == hash {
            mine = left;
        }
    }
    lost_access(&app, account).await;
    let (to, cookies): (&str, Vec<HeaderValue>) = match mine {
        Left::Ended => (SIGNED_OUT, auth::cleared_cookies().into()),
        Left::Switched(to) => ("/", auth::session_cookies(&sid, to).into()),
        Left::Same => ("/", Vec::new()),
    };
    if revoked {
        return see_other(to, cookies);
    }
    let mut res = plain_page(
        StatusCode::OK,
        "GitHub access wasn't revoked",
        &format!(
            r#"<p>beghu disconnected this account: its synced data and preferences are deleted, and
it's signed out in every browser. But beghu had no working GitHub token for it, so it couldn't
revoke its access on GitHub. If beghu still shows under <a href="{web}/settings/apps/authorizations"
rel="external">Authorized GitHub Apps</a>, revoke it there.</p>
<p><a href="{to}">Continue</a></p>"#,
            web = app.cfg().github.web_url,
        ),
    );
    for c in cookies {
        res.headers_mut().append(header::SET_COOKIE, c);
    }
    res
}

/// The account lost access to GitHub: whoever found out (a refused refresh or unusable tokens,
/// a revoke, the daily check, Disconnect) has marked it `needs_sign_in`. Stops its import,
/// deletes its mirror, then tells its open tabs to sign in again. Only while it's still marked:
/// a sign-in that landed first wins, and nothing here changes it. The check and the delete's
/// start are made under the account's token lock, which a sign-in stores its pair under before
/// it revives the mirror: so a sign-in lands wholly before the check, or revives a mirror whose
/// delete is under way, which then comes back empty and imports. After the delete, the status is
/// read again under the lock: a sign-in that landed meanwhile keeps its sync state and its tabs.
pub async fn lost_access(app: &App, account: i64) {
    let deleting = {
        let _turn = app.tokens().hold(account).await;
        if status_of(app, account).await.as_deref() != Some(account_status::NEEDS_SIGN_IN) {
            return;
        }
        app.imports().stop(account);
        app.mirrors().delete(account)
    };
    match deleting.await {
        Ok(()) => eprintln!("account {account}: lost access; its mirror is deleted"),
        Err(mirror_db::Error::Sealed) => {
            eprintln!(
                "account {account}: lost access as beghu stopped; the next start deletes its mirror"
            )
        }
        Err(e) => eprintln!("account {account}: deleting its mirror: {e}"),
    }
    // Read once more, under the token lock, which a sign-in activates the account under: one that
    // landed while the mirror was being deleted wins, and its mirror comes back (empty, so it
    // imports); its sync state, resync mark and tabs are left alone.
    let turn = app.tokens().hold(account).await;
    if status_of(app, account).await.as_deref() == Some(account_status::ACTIVE) {
        drop(turn);
        app.mirrors().revive(account);
        crate::repos::refresh_roles_now(app, account).await;
        return;
    }
    // What sync missed in the mirror (a delivery that failed on it, a sweep's repair): with the
    // mirror gone there's nothing to repair, and the import after a sign-in reads everything
    // afresh. Left, the account would show "sync degraded" from its first sign-in after.
    app.reconcile().forget(account);
    if let Err(e) = app
        .control()
        .write(move |tx| q::forget_needs_resync(tx, account))
        .await
    {
        eprintln!("account {account}: forgetting its resync mark: {e}");
    }
    // After the delete, so a tab that signs in again from here finds the mirror gone.
    app.hub()
        .publish(account, Push::switched(Some(account), true));
}

/// The account's status (`account_status`), if it can be read.
async fn status_of(app: &App, account: i64) -> Option<String> {
    let a = app.control().read(move |c| q::account(c, account)).await;
    a.ok().flatten().map(|a| a.status)
}

/// Every account that lost access, as tokens.rs and webhook.rs find out: each goes down
/// [`lost_access`].
pub async fn follow_lost(app: App, mut rx: tokio::sync::mpsc::UnboundedReceiver<i64>) {
    while let Some(account) = rx.recv().await {
        app.spawn(move |app| async move { lost_access(&app, account).await });
    }
}

/// The accounts' daily check, from startup on: accounts whose refresh token has lapsed lose
/// access (their tokens wiped), and sessions past their expiry are pruned.
// TODO(#114): dormancy (30 days unused) joins this check.
pub async fn daily(app: App) {
    loop {
        check(&app).await;
        tokio::time::sleep(app.cfg().accounts_check_every).await;
    }
}

async fn check(app: &App) {
    let now = crate::now();
    let lapsed = app
        .control()
        .write(move |tx| {
            let lapsed = q::lapsed_accounts(tx, now)?;
            for &a in &lapsed {
                q::delete_tokens(tx, a)?;
                q::set_account_status(tx, a, account_status::NEEDS_SIGN_IN)?;
            }
            q::prune_expired_sessions(tx, now)?;
            Ok(lapsed)
        })
        .await;
    match lapsed {
        Ok(lapsed) => {
            for account in lapsed {
                eprintln!("account {account}: its refresh token lapsed; it must sign in again");
                app.spawn(move |app| async move { lost_access(&app, account).await });
            }
        }
        Err(e) => eprintln!("accounts: the daily check failed: {e}"),
    }
}

/// Startup step 3: deletes the mirrors of accounts that aren't active (they lost access, or
/// went dormant), before anything can open one. A failure is logged; the account stays signed
/// out, and its mirror refused, either way.
pub async fn delete_unused_mirrors(app: &App) -> Result<(), String> {
    let accounts = app
        .control()
        .read(q::accounts_without_mirrors)
        .await
        .map_err(|e| format!("can't read the accounts that aren't active: {e}"))?;
    for account in accounts {
        if let Err(e) = app.mirrors().delete(account).await {
            eprintln!("startup: deleting account {account}'s mirror: {e}");
        }
    }
    Ok(())
}
