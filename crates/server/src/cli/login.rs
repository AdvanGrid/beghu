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
//! The device secret and the code are stored only as their SHA-256s.

use super::new_token;
use crate::analyses::runs::RunError;
use crate::auth::Session;
use crate::crypto::{random_token, sha256, unb64};
use crate::error::ApiError;
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

/// `POST /api/cli/login`: a new login, waiting for its approval. Anyone may start one: only a
/// signed-in person's Approve makes it a credential.
pub async fn start(State(app): State<App>, Json(body): Json<Start>) -> Result<Response, RunError> {
    let mut name: String = body.name.trim().chars().take(NAME_MAX).collect();
    if name.is_empty() {
        name = "unnamed machine".into();
    }
    let lives = app.cfg().cli.login_for.as_secs();
    let device = random_token(32);
    let device_hash = sha256(&unb64(&device).expect("just encoded"));
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
            device_hash.clone(),
            sha256(code.as_bytes()),
            name.clone(),
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
            Ok(true) => {
                let url = format!("{}/cli/login?code={}", app.cfg().public_url, shown(&code));
                return Ok((
                    StatusCode::CREATED,
                    Json(Started {
                        device,
                        code: shown(&code),
                        url,
                        interval: app.cfg().cli.poll_every.as_secs().max(1),
                        expires_in: lives,
                    }),
                )
                    .into_response());
            }
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
    Ended { denied: bool },
    Approved(Approved),
}

/// `POST /api/cli/login/poll`.
pub async fn poll(State(app): State<App>, Json(body): Json<Poll>) -> Result<Response, RunError> {
    let Some(hash) = unb64(&body.device)
        .filter(|r| r.len() == 32)
        .map(|r| sha256(&r))
    else {
        return Err(RunError::LoginEnded { denied: false });
    };
    let (t, unused_for) = (now(), app.cfg().cli.unused_for.as_secs() as i64);
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
                    let (token, token_hash) = new_token();
                    let id = random_token(16);
                    control_db::q::insert_cli_token(tx, &id, &token_hash, account, &l.name, t)?;
                    control_db::q::delete_cli_login(tx, &hash)?;
                    let login = control_db::q::account(tx, account)?
                        .map(|a| a.login)
                        .unwrap_or_default();
                    Ok(Polled::Approved(Approved {
                        token,
                        account: login,
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

/// `GET /api/cli/codes/{code}`: the live login with this code, or `404 gone`.
pub async fn by_code(
    State(app): State<App>,
    Path(code): Path<String>,
) -> Result<Json<CliCode>, ApiError> {
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
}

/// Approve or Deny a live, pending login: 204, or `404 gone` when it isn't one any more.
async fn decide(app: &App, code: &str, account: Option<i64>) -> Result<StatusCode, ApiError> {
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
}

/// `POST /api/cli/codes/{code}/approve`: the CLI signs in as the browser's active account.
pub async fn approve(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    decide(&app, &code, Some(s.account)).await
}

/// `POST /api/cli/codes/{code}/deny`.
pub async fn deny(
    State(app): State<App>,
    Extension(_): Extension<Session>,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    decide(&app, &code, None).await
}
