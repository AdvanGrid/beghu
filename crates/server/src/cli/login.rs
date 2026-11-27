//! `beghu login`: beghu's own device flow, never GitHub's (beghu never hands the CLI a GitHub
//! token).
//!
//! 1. `POST /api/cli/login {name}` answers `{device, code, url, interval, expiresIn}`: `device`
//!    is a secret the CLI keeps; `code` is 8 letters for a person (no vowels and no look-alikes,
//!    shown `BCDF-GHJK`); `url` is `/cli/login?code=…` at this deployment.
//! 2. A person signed in to beghu opens `/cli/login` (the CLI opens it, or prints it with the
//!    code over SSH), which reads the login by its code (`GET /api/cli/codes/{code}`), shows the
//!    machine's name, and Approves (`POST …/approve`, as the browser's active account) or Denies
//!    (`POST …/deny`) it.
//! 3. The CLI polls `POST /api/cli/login/poll {device}` every `interval` seconds: `202` while it
//!    waits, `200 {token, account, accountId, expiresAt}` once approved (that poll mints the
//!    credential and ends the login), `410` once denied or expired. A login lives 10 minutes.
//!
//! The device secret and the code are stored only as their SHA-256s: the device secret's 32 raw
//! bytes (before its base64), and the code's 8 letters, upper case without the dash.
//!
//! The logins waiting at once, and the wrong codes a browser session may try, are limited
//! (`cli::limits`): over either, `429` with `Retry-After`.

use super::limits::Client;
use super::new_token;
use crate::analyses::runs::RunError;
use crate::auth::Session;
use crate::crypto::{random_token, sha256, unb64};
use crate::error::ApiError;
use crate::tokens::AccountStatus;
use crate::{App, now};
use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The code's letters: consonants only, so no word can form, and none of the look-alikes
/// (`I`, `O`, `U`, `0`, `1`).
const ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
const CODE_LEN: usize = 8;
/// A machine's name, at most.
const NAME_MAX: usize = 100;

#[derive(Deserialize)]
pub struct Start {
    name: String,
}

/// `POST /api/cli/login`'s answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    device: String,
    code: String,
    url: String,
    /// Seconds between polls.
    interval: u64,
    /// Seconds until the login expires.
    expires_in: u64,
}

/// A code as typed: its letters, upper case, without the dash or spaces; `None` unless it's 8
/// of the code's letters.
fn normalise(code: &str) -> Option<String> {
    let c: String = code
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (c.len() == CODE_LEN && c.bytes().all(|b| ALPHABET.contains(&b))).then_some(c)
}

/// `BCDFGHJK` as a person reads it: `BCDF-GHJK`.
fn shown(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

/// A machine's name as `/cli/login` and the setup page show it: without control characters
/// (Unicode's Cc: newlines, escapes) or the bidirectional overrides and isolates (which could
/// make it read as another name), its runs of whitespace one space, trimmed, and at most
/// [`NAME_MAX`] characters. "unnamed machine" when nothing is left.
pub(crate) fn clean_name(raw: &str) -> String {
    let bidi = |c: char| {
        matches!(
            c,
            '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
    };
    let kept: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !bidi(*c))
        .collect();
    let name: String = kept
        .split(' ')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NAME_MAX)
        .collect();
    let name = name.trim_end().to_owned();
    if name.is_empty() {
        "unnamed machine".into()
    } else {
        name
    }
}

/// `POST /api/cli/login`: a new login, waiting for its approval. Anyone may start one: only a
/// signed-in person's Approve makes it a credential. Over the limits (`cli::limits`), `429
/// too_many_logins`.
pub async fn start(
    State(app): State<App>,
    client: Client,
    Json(body): Json<Start>,
) -> Result<Response, RunError> {
    let name = clean_name(&body.name);
    let lives = app.cfg().cli.login_for.as_secs();
    let device = random_token(32);
    let device_hash = sha256(&unb64(&device).expect("just encoded"));
    let t0 = now();
    let limits = &app.cfg().cli;
    app.0
        .cli_limits
        .start_login(
            client,
            &device_hash,
            t0,
            t0 + lives as i64,
            limits.logins_at_once,
            limits.logins_per_client,
        )
        .map_err(|f| {
            eprintln!("cli login: refused one from {client}: too many waiting");
            RunError::TooManyLogins {
                retry_after: f.retry_after,
            }
        })?;
    let started = insert(&app, &device_hash, &name, lives).await;
    let code = match started {
        Ok(c) => c,
        Err(e) => {
            app.0.cli_limits.end_login(&device_hash);
            return Err(e);
        }
    };
    let url = format!("{}/cli/login?code={}", app.cfg().public_url, shown(&code));
    Ok((
        StatusCode::CREATED,
        Json(Started {
            device,
            code: shown(&code),
            url,
            interval: app.cfg().cli.poll_every.as_secs().max(1),
            expires_in: lives,
        }),
    )
        .into_response())
}

/// Stores a new login: its code.
async fn insert(app: &App, device_hash: &[u8], name: &str, lives: u64) -> Result<String, RunError> {
    // A code another live login holds is drawn again: two at once in 20^8 is rare.
    let mut last = None;
    for _ in 0..3 {
        let code: String = {
            let mut rng = rand::rng();
            (0..CODE_LEN)
                .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
                .collect()
        };
        let (d, c, n, t) = (
            device_hash.to_owned(),
            sha256(code.as_bytes()),
            name.to_owned(),
            now(),
        );
        let inserted = app
            .control()
            .write(move |tx| {
                control_db::q::prune_cli_logins(tx, t)?;
                if control_db::q::cli_login_by_code(tx, &c, t)?.is_some() {
                    return Ok(false);
                }
                control_db::q::insert_cli_login(tx, &d, &c, &n, t, t + lives as i64)?;
                Ok(true)
            })
            .await;
        match inserted {
            Ok(true) => return Ok(code),
            Ok(false) => {}
            Err(e) => last = Some(e),
        }
    }
    Err(match last {
        Some(e) => e.into(),
        None => RunError::Internal("no free login code in three draws".into()),
    })
}

#[derive(Deserialize)]
pub struct Poll {
    device: String,
}

/// `POST /api/cli/login/poll`'s answer once approved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    token: String,
    /// The account's GitHub login.
    account: String,
    account_id: i64,
    /// When the credential expires unless it's used (Unix seconds).
    expires_at: i64,
}

/// What a poll found.
enum Polled {
    Pending,
    Ended {
        denied: bool,
    },
    /// Approved, by an account that can't have a credential any more.
    AccountGone,
    Approved(Approved),
}

/// `POST /api/cli/login/poll`. An approved login mints its credential only while its account
/// is active: one that has disconnected or gone dormant since (whose transactions delete its
/// logins too) or must sign in again ends the login, `410 login_account_gone`.
pub async fn poll(State(app): State<App>, Json(body): Json<Poll>) -> Result<Response, RunError> {
    let Some(hash) = unb64(&body.device)
        .filter(|r| r.len() == 32)
        .map(|r| sha256(&r))
    else {
        return Err(RunError::LoginEnded { denied: false });
    };
    let (t, unused_for) = (now(), app.cfg().cli.unused_for.as_secs() as i64);
    let device_hash = hash.clone();
    let polled = app
        .control()
        .write(move |tx| {
            let Some(l) = control_db::q::cli_login_by_device(tx, &hash)? else {
                return Ok(Polled::Ended { denied: false });
            };
            if l.expires_at <= t {
                control_db::q::delete_cli_login(tx, &hash)?;
                return Ok(Polled::Ended { denied: false });
            }
            match (l.state.as_str(), l.github_user_id) {
                ("approved", Some(account)) => {
                    control_db::q::delete_cli_login(tx, &hash)?;
                    let Some(acc) = control_db::q::account(tx, account)?
                        .filter(|a| AccountStatus::from_db(&a.status) == AccountStatus::Active)
                    else {
                        return Ok(Polled::AccountGone);
                    };
                    let (token, token_hash) = new_token();
                    let id = random_token(16);
                    control_db::q::insert_cli_token(tx, &id, &token_hash, account, &l.name, t)?;
                    Ok(Polled::Approved(Approved {
                        token,
                        account: acc.login,
                        account_id: account,
                        expires_at: t + unused_for,
                    }))
                }
                ("denied", _) => {
                    control_db::q::delete_cli_login(tx, &hash)?;
                    Ok(Polled::Ended { denied: true })
                }
                _ => Ok(Polled::Pending),
            }
        })
        .await?;
    if !matches!(polled, Polled::Pending) {
        app.0.cli_limits.end_login(&device_hash);
    }
    match polled {
        Polled::Pending => {
            let mut res = (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({ "pending": true })),
            )
                .into_response();
            res.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from(app.cfg().cli.poll_every.as_secs().max(1)),
            );
            Ok(res)
        }
        Polled::Ended { denied } => Err(RunError::LoginEnded { denied }),
        Polled::AccountGone => Err(RunError::LoginAccountGone),
        Polled::Approved(a) => {
            eprintln!(
                "account {}: a beghu CLI signed in ({})",
                a.account_id, a.account
            );
            Ok(Json(a).into_response())
        }
    }
}

/// A login as `/cli/login` shows it.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CliCode {
    /// As a person reads it, `BCDF-GHJK`.
    pub code: String,
    /// The machine's name (`beghu login --name`, its hostname by default).
    pub name: String,
    /// When `beghu login` started it (Unix seconds).
    pub created_at: i64,
    /// When it expires (Unix seconds).
    pub expires_at: i64,
    /// `pending`, `approved` or `denied`.
    pub state: String,
}

/// The stored hash of a code as typed: `404 gone` when it can't be a code, as for one past its
/// life.
fn code_hash(raw: &str) -> Result<(String, Vec<u8>), ApiError> {
    let c = normalise(raw).ok_or(ApiError::Gone)?;
    let h = sha256(c.as_bytes());
    Ok((c, h))
}

/// Runs `f` for `session`'s code, held to the wrong-code limit (`cli::limits`): refused `429
/// too_many_codes` once the session has asked for too many lately, and an answer of `404 gone`
/// counts as one more.
async fn limited<T>(
    app: &App,
    session: &Session,
    f: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    let cfg = &app.cfg().cli;
    app.0
        .cli_limits
        .may_try_code(
            &session.id_hash,
            now(),
            cfg.wrong_codes,
            cfg.wrong_codes_for,
        )
        .map_err(|f| ApiError::TooManyCodes {
            retry_after: f.retry_after,
        })?;
    let out = f.await;
    if let Err(ApiError::Gone) = &out {
        app.0
            .cli_limits
            .wrong_code(&session.id_hash, now(), cfg.wrong_codes_for);
    }
    out
}

/// `GET /api/cli/codes/{code}`: the live login with this code, or `404 gone`.
pub async fn by_code(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(code): Path<String>,
) -> Result<Json<CliCode>, ApiError> {
    limited(&app, &s, async {
        let (c, h) = code_hash(&code)?;
        let t = now();
        let row = app
            .control()
            .read(move |conn| control_db::q::cli_login_by_code(conn, &h, t))
            .await?
            .ok_or(ApiError::Gone)?;
        Ok(Json(CliCode {
            code: shown(&c),
            name: row.name,
            created_at: row.created_at,
            expires_at: row.expires_at,
            state: row.state,
        }))
    })
    .await
}

/// Approve or Deny a live, pending login: 204, or `404 gone` when it isn't one any more.
async fn decide(
    app: &App,
    session: &Session,
    code: &str,
    account: Option<i64>,
) -> Result<StatusCode, ApiError> {
    limited(app, session, async {
        let (_, h) = code_hash(code)?;
        let (t, state) = (
            now(),
            if account.is_some() {
                "approved"
            } else {
                "denied"
            },
        );
        let n = app
            .control()
            .write(move |tx| control_db::q::decide_cli_login(tx, &h, state, account, t))
            .await?;
        if n == 0 {
            return Err(ApiError::Gone);
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

/// `POST /api/cli/codes/{code}/approve`: the CLI signs in as the browser's active account.
pub async fn approve(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    decide(&app, &s, &code, Some(s.account)).await
}

/// `POST /api/cli/codes/{code}/deny`.
pub async fn deny(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    decide(&app, &s, &code, None).await
}
