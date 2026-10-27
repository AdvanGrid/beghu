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
//! until it signs in again, not only the one that found out.

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

/// The `accounts.status` values beghu writes and checks (control-db's `0001_init.sql`).
pub mod account_status {
    pub const ACTIVE: &str = "active";
    pub const NEEDS_SIGN_IN: &str = "needs_sign_in";
}

/// The `account_tokens.status` values beghu writes and checks.
mod token_status {
    pub const ACTIVE: &str = "active";
    pub const REVOKED: &str = "revoked";
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
}

/// The access token as stored, decrypted.
struct Current {
    access: String,
    access_expires_at: i64,
    refresh: String,
}

impl Tokens {
    pub fn new(
        control: Arc<Control>,
        gh: GitHub,
        key: Arc<crate::crypto::Keys>,
        jobs: crate::jobs::Jobs,
    ) -> Tokens {
        Tokens {
            control,
            gh,
            key,
            locks: Mutex::default(),
            jobs,
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
    async fn opened(&self, account: i64) -> Result<Option<Current>, Error> {
        let row = self
            .control
            .read(move |c| q::tokens(c, account))
            .await?
            .filter(|t| t.status == token_status::ACTIVE);
        let open = |b: &[u8], column| {
            self.seal()
                .open(&aad(account, column), b)
                .and_then(|p| String::from_utf8(p).ok())
        };
        Ok(row.and_then(|row| {
            Some(Current {
                access: open(&row.access_enc, Column::Access)?,
                access_expires_at: row.access_expires_at,
                refresh: open(&row.refresh_enc, Column::Refresh)?,
            })
        }))
    }

    /// The stored pair. Without one, the account is signed out, under its lock (so a sign-in
    /// storing a new pair at the same moment isn't undone).
    async fn current(&self, account: i64) -> Result<Current, Error> {
        if let Some(cur) = self.opened(account).await? {
            return Ok(cur);
        }
        let _turn = self.lock(account).lock_owned().await;
        self.current_locked(account).await
    }

    /// [`current`](Self::current) for a caller that holds the account's lock.
    async fn current_locked(&self, account: i64) -> Result<Current, Error> {
        match self.opened(account).await? {
            Some(cur) => Ok(cur),
            None => {
                eprintln!(
                    "account {account}: no active tokens that open with this key; it must sign in again"
                );
                Err(sign_out(&self.control, account, TokensOnSignOut::Keep).await)
            }
        }
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
        self.refresh(account, cur.refresh, turn).await
    }

    /// After `used` got a 401: a newer token if someone refreshed meanwhile, else a refresh.
    async fn refresh_after_401(&self, account: i64, used: &str) -> Result<String, Error> {
        let turn = self.lock(account).lock_owned().await;
        let cur = self.current_locked(account).await?;
        if cur.access != used {
            return Ok(cur.access);
        }
        self.refresh(account, cur.refresh, turn).await
    }

    /// Spends the refresh token and stores the new pair, in a task of its own that holds `turn`
    /// (the account's lock) until both are done, whether or not the caller is still waiting. A
    /// whole job: the drain waits for it, as cutting it after GitHub spent the refresh token
    /// would leave the account to sign in again. Once the drain has stopped the jobs it's
    /// [`Error::Restarting`], and the refresh token stays unspent.
    async fn refresh(
        &self,
        account: i64,
        refresh: String,
        turn: OwnedMutexGuard<()>,
    ) -> Result<String, Error> {
        let (control, gh, key) = (self.control.clone(), self.gh.clone(), self.key.clone());
        let Some(job) = self.jobs.spawn_whole(async move {
            let _turn = turn;
            match gh.refresh(&refresh).await {
                Ok(pair) => {
                    // Committed before use, so a crash can't strand the account on a spent token.
                    store_retrying(&control, &key, account, &pair).await?;
                    Ok(pair.access)
                }
                Err(github::Error::Refused(why)) => {
                    eprintln!(
                        "account {account}: GitHub refused the token refresh ({why}); it must sign in again"
                    );
                    Err(sign_out(&control, account, TokensOnSignOut::Revoke).await)
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

/// What [`sign_out`] does with the account's stored tokens.
#[derive(Clone, Copy)]
enum TokensOnSignOut {
    /// GitHub refused them: mark them revoked.
    Revoke,
    /// None that open: nothing to mark.
    Keep,
}

/// Marks `account` as having to sign in again, so its sessions answer 401 from now on. Returns
/// the error to answer with: `SignInAgain`, or the DB's error if the mark couldn't be written
/// (the next use will try again).
async fn sign_out(control: &Control, account: i64, tokens: TokensOnSignOut) -> Error {
    let marked = control
        .write(move |tx| {
            if let TokensOnSignOut::Revoke = tokens {
                q::set_tokens_status(tx, account, token_status::REVOKED)?;
            }
            q::set_account_status(tx, account, account_status::NEEDS_SIGN_IN)
        })
        .await;
    match marked {
        Ok(_) => Error::SignInAgain,
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
    let (ae, re) = (pair.access_expires_at, pair.refresh_expires_at);
    control
        .write(move |tx| {
            q::put_tokens(tx, account, &a, ae, &r, re)?;
            if let AccountOnStore::Activate = then {
                q::set_account_status(tx, account, account_status::ACTIVE)?;
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
