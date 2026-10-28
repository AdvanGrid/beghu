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
//!
//! **Dormancy.** An account unused for `dormant_after` (30 days) costs almost nothing: the daily
//! check makes it dormant and deletes its mirror, and from then on it gets no webhooks (they're
//! deduped, then dropped: no active account syncs its repos) and no sweeps. Its use is
//! `last_active_at`, which a request with it active and its open streams move at most every
//! `activity_every` (an hour). The check reads the idle accounts, then deletes each one's mirror
//! through [`Mirrors::delete_if`](mirror_db::Mirrors::delete_if): once the work in flight on it
//! is done, with nothing else let in, it marks the account dormant only if `last_active_at`
//! hasn't moved since it read it, and keeps the mirror if it has. So a request that came in
//! meanwhile keeps the account active, and one that comes after finds it dormant and wakes it.
//! A dormant account's mirror files are deleted at startup too. Any use wakes it ([`used`]), as
//! does signing in again: its repo set is read afresh (dropping the repos it can no longer
//! see), and its mirror comes back empty and imports its whole pick, which the status slot
//! calls "Re-importing — you've been away a while". The daily check also wipes dead tokens.

use crate::App;
use crate::auth;
use crate::live::Push;
use crate::tokens::AccountStatus;
use axum::Form;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use control_db::q;
use mirror_db::Decision;
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
/// still signed in that can be used (a dormant one wakes when used), else the first of them (it will sign in again), else none.
fn successor(left: &[q::SessionAccountsRow]) -> Option<i64> {
    left.iter()
        .find(|a| AccountStatus::from_db(&a.status).is_usable())
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
            // A dormant account wakes once it's used.
            if !AccountStatus::from_db(&a.status).is_usable() {
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
            q::set_account_status(tx, account, AccountStatus::NeedsSignIn.as_str()).map(|_| out)
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
        if status_of(app, account).await != Some(AccountStatus::NeedsSignIn) {
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
    if status_of(app, account).await == Some(AccountStatus::Active) {
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

/// The account's status, if it can be read.
async fn status_of(app: &App, account: i64) -> Option<AccountStatus> {
    let a = app.control().read(move |c| q::account(c, account)).await;
    a.ok().flatten().map(|a| AccountStatus::from_db(&a.status))
}

/// Every account that lost access, as tokens.rs and webhook.rs find out: each goes down
/// [`lost_access`].
pub async fn follow_lost(app: App, mut rx: tokio::sync::mpsc::UnboundedReceiver<i64>) {
    while let Some(account) = rx.recv().await {
        app.spawn(move |app| async move { lost_access(&app, account).await });
    }
}

/// The accounts' daily check, from startup on: accounts whose refresh token has lapsed lose
/// access (their tokens wiped), dead tokens and sessions past their expiry are pruned, and
/// accounts unused for `dormant_after` go dormant.
pub async fn daily(app: App) {
    loop {
        check(&app).await;
        dormancy(&app).await;
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
                q::set_account_status(tx, a, AccountStatus::NeedsSignIn.as_str())?;
            }
            q::wipe_dead_tokens(tx, now)?;
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

/// The accounts unused for `dormant_after` go dormant, one at a time ([`go_dormant`]).
async fn dormancy(app: &App) {
    let before = crate::now() - app.cfg().dormant_after.as_secs() as i64;
    let idle = app
        .control()
        .read(move |c| q::dormancy_candidates(c, before))
        .await;
    match idle {
        Ok(idle) => {
            for a in idle {
                go_dormant(app, a.github_user_id, a.last_active_at).await;
            }
        }
        Err(e) => eprintln!("accounts: reading the idle accounts failed: {e}"),
    }
}

/// The account, last used at `seen`, goes dormant: once the work in flight on its mirror is
/// done, and with nothing else let in, it's marked dormant if it's still active and unused
/// since `seen`, its import stops, and its mirror files are deleted. A use since `seen` keeps
/// it active, with its mirror.
async fn go_dormant(app: &App, account: i64, seen: i64) {
    let check = {
        let app = app.clone();
        async move {
            let t = crate::now();
            let marked = app
                .control()
                .write({
                    let app = app.clone();
                    move |tx| {
                        let n = q::go_dormant(tx, account, seen, t)?;
                        // Stopped inside the write, which a wake waits for: a request that wakes the
                        // account right after marks its re-import on an import already stopped.
                        if n > 0 {
                            app.imports().stop(account);
                        }
                        Ok(n > 0)
                    }
                })
                .await;
            marked.unwrap_or_else(|e| {
                eprintln!("account {account}: marking it dormant: {e}");
                false
            })
        }
    };
    match app.mirrors().delete_if(account, check).await {
        Ok(Decision::Deleted) => {
            eprintln!("account {account}: unused for a while; dormant, its mirror deleted");
            // A request may have woken it already: its sync state is then its own again.
            if status_of(app, account).await != Some(AccountStatus::Dormant) {
                return;
            }
            // Nothing left to repair: its next use imports everything afresh.
            app.reconcile().forget(account);
            if let Err(e) = app
                .control()
                .write(move |tx| q::forget_needs_resync(tx, account))
                .await
            {
                eprintln!("account {account}: forgetting its resync mark: {e}");
            }
            // Its repos leave the sweeps, unless an active account syncs them too.
            app.reconcile().repos_changed();
        }
        Ok(Decision::Kept) => {
            eprintln!("account {account}: used as it was going dormant; it stays active")
        }
        // It lost access meanwhile: that delete took the mirror, and `lost_access` the rest.
        Ok(Decision::Overruled) => {
            eprintln!("account {account}: lost access as it was going dormant")
        }
        Err(mirror_db::Error::Sealed) => eprintln!(
            "account {account}: beghu stopped as it was going dormant; if it went, the next start deletes its mirror"
        ),
        Err(e) => eprintln!("account {account}: deleting its mirror as it went dormant: {e}"),
    }
}

/// A use of the account: a request with it active (auth.rs's `admit`). A dormant account wakes:
/// it's active again from now, its repo set is read afresh, and its mirror comes back empty and
/// imports ([`back_from_dormancy`]). An active one's `last_active_at` moves, if `activity_every`
/// has passed since it last did.
pub(crate) async fn used(
    app: &App,
    account: i64,
    status: AccountStatus,
    last_active_at: i64,
) -> Result<(), control_db::Error> {
    let t = crate::now();
    if status == AccountStatus::Dormant {
        let woke = app
            .control()
            .write(move |tx| q::wake_account(tx, account, t))
            .await?
            > 0;
        // Whoever woke it brings it back; a request that found it woken goes on.
        if woke {
            back_from_dormancy(app, account);
            app.mirrors().revive(account);
            app.spawn(
                move |app| async move { crate::repos::refresh_roles_now(&app, account).await },
            );
        }
        return Ok(());
    }
    if t - last_active_at >= app.cfg().activity_every.as_secs() as i64
        && let Err(e) = app
            .control()
            .write(move |tx| q::touch_account(tx, account, t))
            .await
    {
        eprintln!("account {account}: noting its use: {e}");
    }
    Ok(())
}

/// The account's stream is still open: an active account's `last_active_at` moves to now.
pub(crate) async fn streaming(app: &App, account: i64) {
    let t = crate::now();
    if let Err(e) = app
        .control()
        .write(move |tx| q::touch_account(tx, account, t))
        .await
    {
        eprintln!("account {account}: noting its open stream as use: {e}");
    }
}

/// The account was dormant and is in use again (a request woke it, or it signed in): its import,
/// its whole pick into an empty mirror, says it's a re-import after time away.
pub(crate) fn back_from_dormancy(app: &App, account: i64) {
    eprintln!("account {account}: in use again after going dormant; re-importing its synced repos");
    app.imports().mark_away(account);
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
