//! Each connected account's GitHub user token, encrypted at rest. A token with under 5 minutes
//! left is refreshed before use, under a per-account lock, and the new pair is committed before
//! it's used: GitHub's refresh tokens are single-use, so two refreshes racing would sign the
//! account out. A 401 forces one refresh and one retry.
//!
//! A refresh spends the old pair, so the new one must reach the control DB. The refresh and the
//! store run in their own task, which owns the account's lock: a caller that gives up (a closed
//! connection, a timeout) can't stop between the two, and nobody else can refresh until the
//! store has finished. A store that fails for a passing reason (the DB busy or at capacity) is
//! retried a few times.
//!
//! An account whose tokens can't be used (none stored, revoked, or sealed under another key or
//! for another account) is marked `needs_sign_in`, so every request of its sessions answers 401
//! until it signs in again, not only the one that found out. Then it has lost access: the
//! account goes to the lost-access path (`accounts::lost_access`), which deletes its mirror and
//! tells its tabs to sign in again.

use crate::crypto::SealKey;
use crate::github::{self, GitHub, TokenPair};
use control_db::{Control, q};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OwnedMutexGuard;

/// Refresh when less than this many seconds are left.
const MARGIN: i64 = 300;
/// How often a refreshed pair's store is tried, and the wait before the first retry (doubling).
const STORE_TRIES: u32 = 5;
const STORE_BACKOFF: Duration = Duration::from_millis(100);

/// An account's `accounts.status` (control-db's `0001_init.sql` lists the values).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountStatus {
    Active,
    /// Unused for `Config::dormant_after` (30 days): its mirror is deleted, and its next use
    /// wakes it and re-imports it (accounts.rs).
    Dormant,
    /// It lost access (a revoke, a lapsed refresh token, Disconnect): it must sign in again.
    NeedsSignIn,
}

impl AccountStatus {
    /// The column's value. One beghu doesn't know (the schema's `CHECK` allows none) can't be
    /// used: it must sign in again.
    pub fn from_db(s: &str) -> AccountStatus {
        match s {
            "active" => AccountStatus::Active,
            "dormant" => AccountStatus::Dormant,
            _ => AccountStatus::NeedsSignIn,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AccountStatus::Active => "active",
            AccountStatus::Dormant => "dormant",
            AccountStatus::NeedsSignIn => "needs_sign_in",
        }
    }

    /// Whether a request may use the account: an active one, or a dormant one, which the use
    /// wakes. One that must sign in again can't.
    pub fn is_usable(self) -> bool {
        self != AccountStatus::NeedsSignIn
    }
}

/// The `account_tokens.status` values beghu checks (control-db's `tokens.sql` writes them).
pub(crate) mod token_status {
    pub const ACTIVE: &str = "active";
}

#[derive(Debug)]
pub enum Error {
    /// The account has to sign in again: no usable tokens, or GitHub refused the refresh.
    SignInAgain,
    GitHub(github::Error),
    Db(control_db::Error),
    /// The refresh task panicked: a bug, not GitHub or the DB.
    Panicked(String),
    /// A refresh asked for once the drain had stopped the jobs: refused before it spent the
    /// refresh token.
    Restarting,
}

impl From<control_db::Error> for Error {
    fn from(e: control_db::Error) -> Self {
        Error::Db(e)
    }
}

impl From<github::Error> for Error {
    fn from(e: github::Error) -> Self {
        Error::GitHub(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::SignInAgain => f.write_str("the account must sign in again"),
            Error::GitHub(e) => write!(f, "{e}"),
            Error::Db(e) => write!(f, "{e}"),
            Error::Panicked(e) => write!(f, "the token refresh task panicked: {e}"),
            Error::Restarting => f.write_str("beghu is restarting: the token wasn't refreshed"),
        }
    }
}

/// Which of an account's two tokens a blob holds.
#[derive(Clone, Copy)]
enum Column {
    Access,
    Refresh,
}

/// A token's associated data: its account and column. A sealed token copied to another
/// account's row, or into the other column of its own, doesn't open there.
fn aad(account: i64, column: Column) -> Vec<u8> {
    let name: &[u8] = match column {
        Column::Access => b"access",
        Column::Refresh => b"refresh",
    };
    [&account.to_be_bytes()[..], name].concat()
}

pub struct Tokens {
    control: Arc<Control>,
    gh: GitHub,
    key: Arc<crate::crypto::Keys>,
    locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// Refreshes run as whole jobs: the drain waits for one rather than cut it between spending
    /// the refresh token and storing the new pair.
    jobs: crate::jobs::Jobs,
    /// Where an account that lost access goes (see `accounts::lost_access`).
    lost: Lost,
}

/// Where an account that lost access is sent: `lib.rs` follows it with the lost-access path.
pub type Lost = tokio::sync::mpsc::UnboundedSender<i64>;

/// The access token as stored, decrypted.
struct Current {
    access: String,
    access_expires_at: i64,
    refresh: String,
    /// When the pair was issued: which pair a refusal is about (see [`sign_out`]).
    issued_at: i64,
}

/// The stored pair, if it's active and opens, and when the stored row was issued (-1 with none):
/// which tokens a sign-out for unusable ones is about.
struct Opened {
    current: Option<Current>,
    issued_at: i64,
}

impl Tokens {
    pub fn new(
        control: Arc<Control>,
        gh: GitHub,
        key: Arc<crate::crypto::Keys>,
        jobs: crate::jobs::Jobs,
        lost: Lost,
    ) -> Tokens {
        Tokens {
            control,
            gh,
            key,
            locks: Mutex::default(),
            jobs,
            lost,
        }
    }

    fn seal(&self) -> &SealKey {
        &self.key.tokens
    }

    /// Stores the pair a sign-in got for `account`, encrypted, and makes the account active
    /// again. Takes the account's lock, so it can't land in the middle of a refresh: one that
    /// was refused (and signs the account out) finishes first, and this pair wins.
    pub async fn sign_in(&self, account: i64, pair: &TokenPair) -> Result<(), Error> {
        let _turn = self.lock(account).lock_owned().await;
        store(
            &self.control,
            &self.key,
            account,
            pair,
            AccountOnStore::Activate,
        )
        .await
    }

    /// The stored pair, opened, if there's an active one that opens with this key.
    async fn opened(&self, account: i64) -> Result<Opened, Error> {
        let row = self.control.read(move |c| q::tokens(c, account)).await?;
        let issued_at = row.as_ref().map_or(-1, |r| r.issued_at);
        let open = |b: &[u8], column| {
            self.seal()
                .open(&aad(account, column), b)
                .and_then(|p| String::from_utf8(p).ok())
        };
        let current = row
            .filter(|t| t.status == token_status::ACTIVE)
            .and_then(|row| {
                Some(Current {
                    access: open(&row.access_enc, Column::Access)?,
                    access_expires_at: row.access_expires_at,
                    refresh: open(&row.refresh_enc, Column::Refresh)?,
                    issued_at: row.issued_at,
                })
            });
        Ok(Opened { current, issued_at })
    }

    /// The stored pair. Without one, the account is signed out, under its lock (so a sign-in
    /// storing a new pair at the same moment isn't undone).
    async fn current(&self, account: i64) -> Result<Current, Error> {
        if let Some(cur) = self.opened(account).await?.current {
            return Ok(cur);
        }
        let _turn = self.lock(account).lock_owned().await;
        self.current_locked(account).await
    }

    /// [`current`](Self::current) for a caller that holds the account's lock.
    async fn current_locked(&self, account: i64) -> Result<Current, Error> {
        let opened = self.opened(account).await?;
        match opened.current {
            Some(cur) => Ok(cur),
            None => {
                eprintln!(
                    "account {account}: no active tokens that open with this key; it must sign in again"
                );
                Err(sign_out(&self.control, &self.lost, account, opened.issued_at).await)
            }
        }
    }

    /// Holds the account's lock: no pair is stored for it meanwhile, so a sign-in lands wholly
    /// before or after (see `accounts::lost_access`).
    pub async fn hold(&self, account: i64) -> OwnedMutexGuard<()> {
        self.lock(account).lock_owned().await
    }

    fn lock(&self, account: i64) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(account)
            .or_default()
            .clone()
    }

    /// Runs `call` with the account's access token, refreshed first if it's about to expire.
    /// A 401 refreshes once and retries once.
    pub async fn with_token<T, F, Fut>(&self, account: i64, call: F) -> Result<T, Error>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<T, github::Error>>,
    {
        let token = self.usable(account).await?;
        match call(token.clone()).await {
            Err(github::Error::Unauthorized) => {
                let fresh = self.refresh_after_401(account, &token).await?;
                Ok(call(fresh).await?)
            }
            r => Ok(r?),
        }
    }

    /// A token with at least `MARGIN` seconds left.
    async fn usable(&self, account: i64) -> Result<String, Error> {
        let cur = self.current(account).await?;
        if cur.access_expires_at - crate::now() >= MARGIN {
            return Ok(cur.access);
        }
        let turn = self.lock(account).lock_owned().await;
        // Whoever held the lock before us may have refreshed already.
        let cur = self.current_locked(account).await?;
        if cur.access_expires_at - crate::now() >= MARGIN {
            return Ok(cur.access);
        }
        self.refresh(account, cur, turn).await
    }

    /// After `used` got a 401: a newer token if someone refreshed meanwhile, else a refresh.
    async fn refresh_after_401(&self, account: i64, used: &str) -> Result<String, Error> {
        let turn = self.lock(account).lock_owned().await;
        let cur = self.current_locked(account).await?;
        if cur.access != used {
            return Ok(cur.access);
        }
        self.refresh(account, cur, turn).await
    }

    /// Spends the refresh token and stores the new pair, in a task of its own that holds `turn`
    /// (the account's lock) until both are done, whether or not the caller is still waiting. A
    /// whole job: the drain waits for it, as cutting it after GitHub spent the refresh token
    /// would leave the account to sign in again. Once the drain has stopped the jobs it's
    /// [`Error::Restarting`], and the refresh token stays unspent.
    async fn refresh(
        &self,
        account: i64,
        cur: Current,
        turn: OwnedMutexGuard<()>,
    ) -> Result<String, Error> {
        let (control, gh, key) = (self.control.clone(), self.gh.clone(), self.key.clone());
        let lost = self.lost.clone();
        let Some(job) = self.jobs.spawn_whole(async move {
            let _turn = turn;
            match gh.refresh(&cur.refresh).await {
                Ok(pair) => {
                    // Committed before use, so a crash can't strand the account on a spent token.
                    store_retrying(&control, &key, account, &pair).await?;
                    Ok(pair.access)
                }
                Err(github::Error::Refused(why)) => {
                    eprintln!(
                        "account {account}: GitHub refused the token refresh ({why}); it must sign in again"
                    );
                    Err(sign_out(&control, &lost, account, cur.issued_at).await)
                }
                Err(e) => Err(Error::GitHub(e)),
            }
        }) else {
            return Err(Error::Restarting);
        };
        job.await
            .unwrap_or_else(|e| Err(Error::Panicked(e.to_string())))
    }
}

/// GitHub refused the tokens issued at `issued_at` (-1: there were none), or they don't open:
/// marks `account` as having to sign in again, so its sessions answer 401 from now on, and sends
/// it down the lost-access path. Only if those tokens are still the account's and it's active (or dormant): a
/// sign-in since then (new tokens) wins, and an account marked already isn't sent twice. Returns
/// the error to answer with: `SignInAgain`, or the DB's error if the mark couldn't be written
/// (the next use will try again).
async fn sign_out(control: &Control, lost: &Lost, account: i64, issued_at: i64) -> Error {
    let marked = control
        .write(move |tx| {
            let marked = q::lose_access_if_tokens_unchanged(tx, account, issued_at)? > 0;
            if marked {
                q::revoke_tokens(tx, account)?;
            }
            Ok(marked)
        })
        .await;
    match marked {
        Ok(marked) => {
            if marked {
                let _ = lost.send(account);
            }
            Error::SignInAgain
        }
        Err(e) => Error::Db(e),
    }
}

/// What [`store`] does with the account's status.
#[derive(Clone, Copy)]
enum AccountOnStore {
    /// A sign-in: the account is active again.
    Activate,
    /// A refresh: the status stays as it is.
    Leave,
}

/// Writes `pair` for `account`, encrypted.
async fn store(
    control: &Control,
    key: &crate::crypto::Keys,
    account: i64,
    pair: &TokenPair,
    then: AccountOnStore,
) -> Result<(), Error> {
    let seal = &key.tokens;
    let (a, r) = (
        seal.seal(&aad(account, Column::Access), pair.access.as_bytes()),
        seal.seal(&aad(account, Column::Refresh), pair.refresh.as_bytes()),
    );
    let (ae, re, issued) = (
        pair.access_expires_at,
        pair.refresh_expires_at,
        crate::now_ms(),
    );
    control
        .write(move |tx| {
            q::put_tokens(tx, account, &a, ae, &r, re, issued)?;
            if let AccountOnStore::Activate = then {
                q::set_account_status(tx, account, AccountStatus::Active.as_str())?;
            }
            Ok(())
        })
        .await?;
    Ok(())
}

/// [`store`], retried while it fails for a passing reason: the old pair is already spent, so
/// this pair is the account's only way back to GitHub.
async fn store_retrying(
    control: &Control,
    key: &crate::crypto::Keys,
    account: i64,
    pair: &TokenPair,
) -> Result<(), Error> {
    let mut wait = STORE_BACKOFF;
    for attempt in 1.. {
        match store(control, key, account, pair, AccountOnStore::Leave).await {
            Err(Error::Db(e)) if attempt < STORE_TRIES && e.is_transient() => {
                eprintln!(
                    "account {account}: storing the refreshed tokens failed ({e}); retrying in {wait:?}"
                );
                tokio::time::sleep(e.retry_after().map_or(wait, |r| r.min(wait))).await;
                wait *= 2;
            }
            Err(e) => {
                // The old pair is spent and the new one is lost: the next refresh will be
                // refused, and that marks the account `needs_sign_in`.
                eprintln!(
                    "account {account}: storing the refreshed tokens failed for good ({e}); the new pair is lost, so its next refresh will be refused and sign it out"
                );
                return Err(e);
            }
            Ok(()) => return Ok(()),
        }
    }
    unreachable!("the loop returns by its last attempt")
}
