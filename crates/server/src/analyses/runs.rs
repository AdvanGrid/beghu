//! A run's life: starting one (the browser's `POST /api/{owner}/{repo}/pulls/{n}/runs`, the CLI's
//! `POST /api/cli/runs`), ending one (`DELETE /api/{owner}/{repo}/pulls/{n}/run`, or the run's own
//! `POST end`), and what every call on a run checks first ([`admit`]): the token (and a CLI run's
//! credential), then each way a run ends (expired, superseded, ended, the account signed out of
//! every browser, dormant, signed out by GitHub, or without Read on the repo). A run found ended
//! that way is marked so, and the account's streams hear it. Each live run's timer expires it on
//! time ([`watch`], re-armed at startup by [`rearm`]); the daily check prunes runs long ended
//! ([`prune`]); and an account that loses Read on a repo loses its runs and analyses there
//! ([`lost_repo`]).
//!
//! The run API answers in its own terms ([`RunError`]): it's read by an agent with `curl` or by
//! the CLI, never by the web app, so its failures aren't the app's error kinds.

use super::{PrKey, announce, new_id, new_token, pause};
use crate::auth::Session;
use crate::crypto::{sha256, unb64};
use crate::error::ApiError;
use crate::tokens::AccountStatus;
use crate::{App, RunLifetimes, RunPausePoint, now};
use analysis::Report;
use analysis_db::q::RunRow;
use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use ts_rs::TS;

/// Who started a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Producer {
    /// The PR panel's Analyse button: the agent gets the run's URLs.
    Button,
    /// The beghu CLI: the agent gets CLI commands, and every call carries the CLI's credential.
    Cli,
}

impl Producer {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Producer::Button => "button",
            Producer::Cli => "cli",
        }
    }

    pub fn of(run: &RunRow) -> Producer {
        Producer::from_db(&run.producer)
    }

    pub(crate) fn from_db(s: &str) -> Producer {
        match s {
            "cli" => Producer::Cli,
            _ => Producer::Button,
        }
    }
}

/// Why a run ended: as `analyses.db` stores it, and as a 410 names it (`reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ended {
    /// The user ended it (the PR panel, or `beghu analyse end`), or the agent did (`POST end`).
    ByUser,
    /// A newer run for the PR replaced it.
    Superseded,
    Expired,
    /// The account signed out of every browser.
    SignedOut,
    /// The account went dormant.
    Dormant,
    /// GitHub signed the account out: it must sign in again.
    SignInAgain,
    /// The account can no longer read the repo.
    NoRead,
    /// The PR grew past [`super::MAX_FILES`] before the run pinned it.
    TooLarge,
}

impl Serialize for Ended {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl Ended {
    fn as_str(self) -> &'static str {
        match self {
            Ended::ByUser => "ended",
            Ended::Superseded => "superseded",
            Ended::Expired => "expired",
            Ended::SignedOut => "signed_out",
            Ended::Dormant => "dormant",
            Ended::SignInAgain => "sign_in_again",
            Ended::NoRead => "no_read",
            Ended::TooLarge => "too_large",
        }
    }

    pub fn from_db(s: &str) -> Ended {
        match s {
            "superseded" => Ended::Superseded,
            "expired" => Ended::Expired,
            "signed_out" => Ended::SignedOut,
            "dormant" => Ended::Dormant,
            "sign_in_again" => Ended::SignInAgain,
            "no_read" => Ended::NoRead,
            "too_large" => Ended::TooLarge,
            _ => Ended::ByUser,
        }
    }

    /// Why, in words for the agent.
    fn why(self) -> &'static str {
        match self {
            Ended::ByUser => "This run was ended.",
            Ended::Superseded => "A newer run for this PR replaced this one.",
            Ended::Expired => "This run expired.",
            Ended::SignedOut => "The account that started this run signed out of beghu.",
            Ended::Dormant => "The account that started this run went dormant.",
            Ended::SignInAgain => "The account that started this run must sign in to beghu again.",
            Ended::NoRead => "The account that started this run can no longer read the repo.",
            Ended::TooLarge => {
                "The PR has more than 3,000 changed files, more than an analysis can place."
            }
        }
    }
}

/// How a run call, or one of the CLI's own, failed: a status and a JSON body naming the kind.
#[derive(Debug)]
pub(crate) enum RunError {
    /// 401: no such token (or, for a CLI run, a CLI credential of another account).
    BadToken,
    /// 401: the CLI's credential is missing, malformed, revoked or expired: `beghu login`.
    BadCredential,
    /// 426: the CLI is older than the floor ([`crate::MIN_CLI`]).
    CliTooOld {
        minimum: crate::CliVersion,
        host: String,
        /// The CLI this server serves, which `beghu update` installs.
        server: crate::CliVersion,
    },
    /// 409: the CLI is newer than the one this server serves.
    CliTooNew {
        server: crate::CliVersion,
    },
    /// 403: the CLI's account must sign in to beghu again, in a browser.
    SignInAgain,
    /// 410: a `beghu login` that was denied, or expired (or never was).
    LoginEnded {
        denied: bool,
    },
    /// 410: a `beghu login` approved for an account that has since disconnected, gone dormant
    /// or must sign in again: no credential was minted.
    LoginAccountGone,
    /// 429: too many `beghu login`s waiting, from this client or from everyone
    /// (`cli::limits`): try again after `retry_after`.
    TooManyLogins {
        retry_after: Duration,
    },
    /// 410: the run ended.
    Ended(Ended),
    /// 410: the run's account lost its analyses (it went dormant or disconnected, and came
    /// back): the run is gone.
    Gone,
    /// 413: past the upload's limits.
    TooLarge,
    /// 409: the upload's head isn't the one the run pinned.
    HeadMoved {
        pinned: String,
    },
    /// 422: the upload failed a check; nothing was stored. `migrated`: the versions the upload
    /// was migrated between, when it was.
    Refused {
        report: Report,
        migrated: Option<(u32, u32)>,
    },
    /// 404: the file isn't there (no previous analysis).
    NotFound(&'static str),
    BadRequest(String),
    /// 415: a `Content-Encoding` other than `gzip`.
    Encoding,
    /// 503: try again after `retry_after`.
    Unavailable {
        retry_after: Duration,
        why: String,
    },
    /// 500: the stored analysis couldn't be migrated to this build's schema (a bug).
    MigrationFailed,
    Internal(String),
}

/// The run API's error body.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunErrorBody {
    /// `bad_token`, `run_ended`, `too_large`, `head_moved`, `refused`, `not_found`,
    /// `bad_request`, `unsupported_encoding`, `unavailable`, `migration_failed` or `internal`;
    /// and for the CLI, `bad_credential`, `cli_too_old`, `cli_too_new`, `sign_in_again`,
    /// `login_denied`, `login_expired`, `login_account_gone` or `too_many_logins` (with
    /// `retry-after`).
    pub error: &'static str,
    pub message: String,
    /// With `run_ended`: why.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub reason: Option<Ended>,
    /// With `head_moved`: the head SHA the run pinned.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned: Option<String>,
    /// With `refused`: the error report.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub report: Option<Report>,
    /// With `refused`: the server's schema version.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<u32>,
    /// With `too_large`: the limits, in bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "{ wire: number, inflated: number }")]
    pub limits: Option<serde_json::Value>,
    /// With `cli_too_old`: the oldest CLI this server answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub minimum: Option<String>,
    /// With `cli_too_new` and `cli_too_old`: the CLI this server serves (`beghu update` installs
    /// it).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub server: Option<String>,
}

impl From<dbrt::Error> for RunError {
    fn from(e: dbrt::Error) -> Self {
        match ApiError::from(e) {
            ApiError::Unavailable { retry_after, why } => {
                RunError::Unavailable { retry_after, why }
            }
            ApiError::Internal(m) => RunError::Internal(m),
            other => RunError::Internal(format!("{other:?}")),
        }
    }
}

impl From<crate::tokens::Error> for RunError {
    fn from(e: crate::tokens::Error) -> Self {
        match e {
            crate::tokens::Error::SignInAgain => RunError::Ended(Ended::SignInAgain),
            crate::tokens::Error::Restarting => RunError::Unavailable {
                retry_after: Duration::from_secs(5),
                why: "beghu is restarting; try again in a moment".into(),
            },
            crate::tokens::Error::Db(e) => e.into(),
            crate::tokens::Error::GitHub(e) => github_failed(e),
            e => RunError::Internal(e.to_string()),
        }
    }
}

/// GitHub failed a call the run needed: try again later.
pub(crate) fn github_failed(e: crate::github::Error) -> RunError {
    let retry_after = match &e {
        crate::github::Error::RateLimited(d) => *d,
        _ => Duration::from_secs(10),
    };
    RunError::Unavailable {
        retry_after,
        why: format!("GitHub didn't answer as asked ({e}); try again in a moment"),
    }
}

impl IntoResponse for RunError {
    fn into_response(self) -> Response {
        let mut body = RunErrorBody {
            error: "",
            message: String::new(),
            reason: None,
            pinned: None,
            report: None,
            version: None,
            limits: None,
            minimum: None,
            server: None,
        };
        let mut retry = None;
        let status = match self {
            RunError::BadToken => {
                body.error = "bad_token";
                body.message = "No run has this token.".into();
                StatusCode::UNAUTHORIZED
            }
            RunError::BadCredential => {
                body.error = "bad_credential";
                body.message =
                    "This CLI sign-in was revoked, has expired, or is missing: run `beghu login`."
                        .into();
                StatusCode::UNAUTHORIZED
            }
            RunError::CliTooOld {
                minimum,
                host,
                server,
            } => {
                body.error = "cli_too_old";
                body.message = format!(
                    "This beghu needs beghu CLI {minimum} or newer: run `beghu update`, or `curl -fsSL {host}/cli/install.sh | sh`."
                );
                body.minimum = Some(minimum.to_string());
                body.server = Some(server.to_string());
                StatusCode::UPGRADE_REQUIRED
            }
            RunError::CliTooNew { server } => {
                body.error = "cli_too_new";
                body.message = format!(
                    "This beghu serves beghu CLI {server}, older than this one: run `beghu update` to install its build."
                );
                body.server = Some(server.to_string());
                StatusCode::CONFLICT
            }
            RunError::SignInAgain => {
                body.error = "sign_in_again";
                body.message =
                    "The account this CLI is signed in as must sign in to beghu again, in a browser."
                        .into();
                StatusCode::FORBIDDEN
            }
            RunError::LoginEnded { denied } => {
                if denied {
                    body.error = "login_denied";
                    body.message = "The sign-in was denied in the browser.".into();
                } else {
                    body.error = "login_expired";
                    body.message =
                        "The sign-in expired before it was approved: run `beghu login` again."
                            .into();
                }
                StatusCode::GONE
            }
            RunError::LoginAccountGone => {
                body.error = "login_account_gone";
                body.message = "The account that approved this sign-in has since disconnected, gone dormant or must sign in to beghu again: sign in in a browser, then run `beghu login` again.".into();
                StatusCode::GONE
            }
            RunError::TooManyLogins { retry_after } => {
                body.error = "too_many_logins";
                body.message = format!(
                    "Too many beghu logins are waiting for approval: try again in {} s.",
                    retry_after.as_secs().max(1)
                );
                retry = Some(retry_after);
                StatusCode::TOO_MANY_REQUESTS
            }
            RunError::Ended(why) => {
                body.error = "run_ended";
                body.message = format!("{} Start a new run.", why.why());
                body.reason = Some(why);
                StatusCode::GONE
            }
            RunError::Gone => {
                body.error = "run_ended";
                body.message = "This run no longer exists. Start a new run.".into();
                StatusCode::GONE
            }
            RunError::TooLarge => {
                body.error = "too_large";
                body.message = format!(
                    "An upload is at most {} MB on the wire and {} MB once inflated.",
                    super::MAX_WIRE >> 20,
                    super::MAX_INFLATED >> 20
                );
                body.limits =
                    Some(json!({ "wire": super::MAX_WIRE, "inflated": super::MAX_INFLATED }));
                StatusCode::PAYLOAD_TOO_LARGE
            }
            RunError::HeadMoved { pinned } => {
                body.error = "head_moved";
                body.message = format!(
                    "The analysis isn't of the head this run pinned, {pinned}: analyse that commit, or start a new run for a newer head."
                );
                body.pinned = Some(pinned);
                StatusCode::CONFLICT
            }
            RunError::Refused { report, migrated } => {
                body.error = "refused";
                body.message = match migrated {
                    Some((from, to)) => format!(
                        "The analysis failed the server's checks; nothing was stored. The schema moved from version {from} to {to} since this run's files were fetched: refetch schema.ts, validate.mjs and the instructions from this run."
                    ),
                    None => {
                        "The analysis failed the server's checks; nothing was stored.".to_owned()
                    }
                };
                body.report = Some(report);
                body.version = Some(analysis::VERSION);
                StatusCode::UNPROCESSABLE_ENTITY
            }
            RunError::NotFound(what) => {
                body.error = "not_found";
                body.message = what.to_owned();
                StatusCode::NOT_FOUND
            }
            RunError::BadRequest(m) => {
                body.error = "bad_request";
                body.message = m;
                StatusCode::BAD_REQUEST
            }
            RunError::Encoding => {
                body.error = "unsupported_encoding";
                body.message = "Send the analysis as is, or with Content-Encoding: gzip.".into();
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            }
            RunError::Unavailable { retry_after, why } => {
                body.error = "unavailable";
                body.message = why;
                retry = Some(retry_after);
                StatusCode::SERVICE_UNAVAILABLE
            }
            RunError::MigrationFailed => {
                body.error = "migration_failed";
                body.message =
                    "beghu couldn't bring this PR's stored analysis up to its schema.".into();
                StatusCode::INTERNAL_SERVER_ERROR
            }
            RunError::Internal(m) => {
                eprintln!("analysis run: internal error: {m}");
                body.error = "internal";
                body.message = "Something went wrong".into();
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let mut res = (status, Json(body)).into_response();
        if let Some(r) = retry {
            res.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(r.as_secs().max(1)));
        }
        res
    }
}

/// A run call let through: the run's account and its row as it stands.
pub(crate) struct Admitted {
    pub account: i64,
    pub run: RunRow,
}

impl Admitted {
    pub fn pr(&self) -> PrKey {
        PrKey {
            account: self.account,
            repo_id: self.run.repo_id,
            number: self.run.number,
        }
    }

    /// `owner/name`, as the run was started.
    pub fn repo(&self) -> String {
        format!("{}/{}", self.run.owner, self.run.name)
    }
}

/// When the run expires, as it stands: 24 h after its start while nothing fetched from it, then
/// 2 h after its last call, and never later than 7 days after its start (the start call, not the
/// first fetch: a link nobody used for a day still has 6 days, not 7).
pub(crate) fn deadline(l: &RunLifetimes, run: &RunRow) -> i64 {
    deadline_of(l, run.created_at, run.attached_at, run.last_heard_at)
}

/// [`deadline`], from the run's start, its first fetch and its last call.
pub(crate) fn deadline_of(
    l: &RunLifetimes,
    created_at: i64,
    attached_at: Option<i64>,
    last_heard_at: i64,
) -> i64 {
    let by_use = match attached_at {
        None => created_at + l.unused_for.as_secs() as i64,
        Some(_) => last_heard_at + l.idle_for.as_secs() as i64,
    };
    by_use.min(created_at + l.lives_for.as_secs() as i64)
}

/// How [`end`]'s write found the run.
enum Ending {
    /// Live: this call ended it.
    Now,
    /// Ended already, for the reason stored.
    Already(Ended),
    /// Its row is gone (its repo's analyses were deleted).
    Gone,
}

/// Ends the run if it's still live, telling the account's streams and waking its timer. The error
/// the call that found it so answers: `why`, or, when something else ended it first (a supersede
/// between the call's check and this write), the reason stored.
pub(crate) async fn end(app: &App, account: i64, run: &RunRow, why: Ended) -> RunError {
    pause(app, RunPausePoint::End).await;
    let (id, t) = (run.id.clone(), now());
    let ending = app
        .analyses()
        .dbs
        .write(account, move |tx| {
            if analysis_db::q::end_run(tx, &id, why.as_str(), t)? > 0 {
                return Ok(Ending::Now);
            }
            Ok(match analysis_db::q::run(tx, &id)? {
                Some(r) => Ending::Already(Ended::from_db(r.ended_reason.as_deref().unwrap_or(""))),
                None => Ending::Gone,
            })
        })
        .await;
    app.analyses().wake(&run.id);
    match ending {
        Ok(Ending::Now) => {
            eprintln!(
                "account {account}: the analysis run on {}/{}#{} ended ({})",
                run.owner,
                run.name,
                run.number,
                why.as_str()
            );
            announce(
                app,
                account,
                &format!("{}/{}", run.owner, run.name),
                run.number,
                None,
            );
            RunError::Ended(why)
        }
        Ok(Ending::Already(stored)) => RunError::Ended(stored),
        Ok(Ending::Gone) => gone(app, &run.id).await,
        Err(e) => {
            eprintln!("account {account}: ending run {}: {e}", run.id);
            RunError::Ended(why)
        }
    }
}

/// The run's row is gone: the call is told why its token says the run ended (its account lost
/// Read on the repo, which notes why on each run's token before deleting the rows), as [`admit`]
/// tells it; [`RunError::Gone`] when the token doesn't say.
pub(crate) async fn gone(app: &App, run: &str) -> RunError {
    let id = run.to_owned();
    match app
        .control()
        .read(move |c| control_db::q::run_token_ended(c, &id))
        .await
    {
        Ok(Some(Some(why))) => RunError::Ended(Ended::from_db(&why)),
        Ok(_) => RunError::Gone,
        Err(e) => e.into(),
    }
}

/// What every call on a run checks first, in order: the token names a run; for a CLI run, the
/// call carries a live CLI credential (`401 bad_credential` without one) of the run's account
/// (before anything else, so the token alone learns nothing, not even that the run ended); its account isn't dormant or signed out
/// by GitHub; the run exists and hasn't ended or expired; for a button run, the account is still
/// signed in on some browser; the account can still read the repo. A run found ended on the way
/// is marked so. The call counts as the run's use (`last_heard_at`).
pub(crate) async fn admit(
    app: &App,
    token: &str,
    headers: &HeaderMap,
) -> Result<Admitted, RunError> {
    let hash = match unb64(token) {
        Some(raw) if raw.len() == 32 => sha256(&raw),
        _ => return Err(RunError::BadToken),
    };
    let Some(t) = app
        .control()
        .read(move |c| control_db::q::run_token(c, &hash))
        .await?
    else {
        return Err(RunError::BadToken);
    };
    let account = t.github_user_id;
    let producer = Producer::from_db(&t.producer);
    if producer == Producer::Cli && crate::cli::credential(app, headers).await?.account != account {
        return Err(RunError::BadToken);
    }
    let status = AccountStatus::from_db(&t.status);
    // Its analyses were deleted with its mirror, or are about to be.
    if status == AccountStatus::Dormant {
        return Err(RunError::Ended(Ended::Dormant));
    }
    // Disconnected, its file deleted: reading it would make an empty one.
    if status == AccountStatus::NeedsSignIn && !app.analyses().dbs.path(account).exists() {
        return Err(RunError::Ended(Ended::SignInAgain));
    }
    let id = t.run_id.clone();
    let run = match app
        .analyses()
        .dbs
        .read(account, move |c| analysis_db::q::run(c, &id))
        .await
    {
        Ok(Some(run)) => run,
        // Deleted with its repo's analyses (the account lost Read on it): the token says why.
        Ok(None) => {
            return Err(match &t.ended_reason {
                Some(why) => RunError::Ended(Ended::from_db(why)),
                None => RunError::Gone,
            });
        }
        // Disconnect deletes the account's analyses, and leaves it to sign in again.
        Err(dbrt::Error::Deleted) if status == AccountStatus::NeedsSignIn => {
            return Err(RunError::Ended(Ended::SignInAgain));
        }
        Err(dbrt::Error::Deleted) => return Err(RunError::Ended(Ended::Dormant)),
        Err(e) => return Err(e.into()),
    };
    if let Some(why) = &run.ended_reason {
        return Err(RunError::Ended(Ended::from_db(why)));
    }
    if status == AccountStatus::NeedsSignIn {
        return Err(end(app, account, &run, Ended::SignInAgain).await);
    }
    let t = now();
    if t >= deadline(&app.cfg().runs, &run) {
        return Err(end(app, account, &run, Ended::Expired).await);
    }
    if producer == Producer::Button {
        let signed_in = app
            .control()
            .read(move |c| control_db::q::signed_in_anywhere(c, account, t))
            .await?;
        if !signed_in {
            return Err(end(app, account, &run, Ended::SignedOut).await);
        }
    }
    let repo = run.repo_id;
    let role = app
        .mirrors()
        .read(account, mirror_db::Caller::Request, move |c| {
            mirror_db::q::repo_role(c, repo)
        })
        .await?;
    if role.flatten().is_none() {
        return Err(end(app, account, &run, Ended::NoRead).await);
    }
    let id = run.id.clone();
    app.analyses()
        .dbs
        .write(account, move |tx| analysis_db::q::heard_run(tx, &id, t))
        .await?;
    // The PR panel shows when the agent was last heard from: true to within `heard_every`.
    if let Some(attached) = run.attached_at {
        let every = app.cfg().runs.heard_every.as_secs() as i64;
        if app.analyses().heard_due(&run.id, attached, t, every) {
            let repo = format!("{}/{}", run.owner, run.name);
            announce(app, account, &repo, run.number, None);
        }
    }
    Ok(Admitted {
        account,
        run: RunRow {
            last_heard_at: t,
            ..run
        },
    })
}

/// The first wait of a timer whose read of its run failed: doubled with each failure in a row,
/// up to [`TIMER_RETRY_MAX`].
const TIMER_RETRY_FIRST: Duration = Duration::from_secs(1);
const TIMER_RETRY_MAX: Duration = Duration::from_secs(60);

/// The live run's timer: ends the run when it expires, so the account's streams hear an expiry
/// nobody's call found. It sleeps until the run's deadline as it stands, then looks again (a call
/// since moved it). Woken when the run ends otherwise, or its row goes ([`super::Store::wake`]),
/// it stops then: nothing on the HTTP surface tells that from a timer that sleeps on to its
/// deadline and only then finds its run ended, but woken, it doesn't hold a task for up to 7
/// days. A read that fails for a passing reason (busy, at capacity) is tried again, backing
/// off, rather than leave a live run with no timer. One that fails for good (the file can't be
/// opened or read) stops it, logged once: the run's next call finds it expired, and a restart
/// re-arms every live run's ([`rearm`]). Nothing for a run that has a timer already (a start just before startup's
/// re-arm read the live runs).
pub(crate) fn watch(app: &App, account: i64, run: String) {
    let Some(woken) = app.analyses().timer(account, &run) else {
        return;
    };
    app.spawn(move |app| async move {
        let mut retry = TIMER_RETRY_FIRST;
        loop {
            let id = run.clone();
            let read = app
                .analyses()
                .dbs
                .read(account, move |c| analysis_db::q::run(c, &id))
                .await;
            let row = match read {
                Ok(Some(row)) if row.ended_at.is_none() => row,
                // Ended, or its row gone with its repo's analyses or its account's file.
                Ok(_) | Err(dbrt::Error::Deleted) => break,
                Err(e) if !e.is_transient() => {
                    eprintln!(
                        "account {account}: reading analysis run {run} for its timer: {e}; its timer stops, and its next call or the next start ends it"
                    );
                    break;
                }
                Err(e) => {
                    eprintln!(
                        "account {account}: reading analysis run {run} for its timer: {e}; trying again in {}s",
                        retry.as_secs()
                    );
                    tokio::select! {
                        () = tokio::time::sleep(retry) => {}
                        () = woken.notified() => {}
                    }
                    retry = (retry * 2).min(TIMER_RETRY_MAX);
                    continue;
                }
            };
            retry = TIMER_RETRY_FIRST;
            let wait = deadline(&app.cfg().runs, &row) - now();
            if wait <= 0 {
                end(&app, account, &row, Ended::Expired).await;
                break;
            }
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(wait as u64)) => {}
                () = woken.notified() => {}
            }
        }
        app.analyses().timer_done(&run, &woken);
    });
}

/// Startup: a timer for every live run (a restart lost them), each of which expires its run at
/// once if its deadline passed meanwhile, telling the account's streams. Not for a dormant or
/// disconnected account, whose file is deleted (or about to be): reading it would make an empty
/// one. One that must sign in again keeps its file and its runs' timers; its runs' next call ends
/// them.
pub(crate) async fn rearm(app: App) {
    let accounts = match app.control().read(control_db::q::run_token_accounts).await {
        Ok(a) => a,
        Err(e) => {
            eprintln!("startup: reading the accounts with analysis runs: {e}");
            return;
        }
    };
    for account in accounts {
        if !app.analyses().dbs.path(account).exists() {
            continue;
        }
        match app
            .analyses()
            .dbs
            .read(account, analysis_db::q::live_runs)
            .await
        {
            Ok(live) => {
                for run in live {
                    watch(&app, account, run);
                }
            }
            // It went dormant, or disconnected, since.
            Err(dbrt::Error::Deleted) => {}
            Err(e) => eprintln!("startup: reading account {account}'s live analysis runs: {e}"),
        }
    }
}

/// The daily check's part: the runs that ended more than `ended_kept_for` (30 days) ago go, with
/// their tokens, which until then told a call why its run ended. A token whose run's row is gone
/// with its file (the account went dormant or disconnected) or its repo's analyses goes once its
/// run can't have ended later than that: its start was `lives_for` (7 days) longer ago. A dormant
/// or disconnected account's file isn't opened (it's gone, and reading it would make an empty
/// one): its tokens go that second way.
pub(crate) async fn prune(app: &App) {
    let l = &app.cfg().runs;
    let t = now();
    let before = t - l.ended_kept_for.as_secs() as i64;
    match app.control().read(control_db::q::run_token_accounts).await {
        Ok(accounts) => {
            for account in accounts {
                if !app.analyses().dbs.path(account).exists() {
                    continue;
                }
                let pruned = app
                    .analyses()
                    .dbs
                    .write(account, move |tx| {
                        analysis_db::q::prune_ended_runs(tx, before)
                    })
                    .await;
                let ids = match pruned {
                    Ok(ids) => ids,
                    // It went dormant, or disconnected, since.
                    Err(dbrt::Error::Deleted) => continue,
                    Err(e) => {
                        eprintln!("account {account}: pruning its ended analysis runs: {e}");
                        continue;
                    }
                };
                if ids.is_empty() {
                    continue;
                }
                if let Err(e) = app
                    .control()
                    .write(move |tx| {
                        for id in &ids {
                            control_db::q::delete_run_token(tx, id)?;
                        }
                        Ok(())
                    })
                    .await
                {
                    eprintln!("account {account}: pruning its ended analysis runs' tokens: {e}");
                }
            }
        }
        Err(e) => eprintln!("accounts: reading the accounts with analysis runs: {e}"),
    }
    let started_before = before - l.lives_for.as_secs() as i64;
    if let Err(e) = app
        .control()
        .write(move |tx| control_db::q::prune_old_run_tokens(tx, started_before))
        .await
    {
        eprintln!("accounts: pruning old analysis runs' tokens: {e}");
    }
}

/// The account lost Read on the repo: its analyses there go, and so do its runs, each live one
/// ending first as `no_read` (its token keeps why each ended, for its next call's 410), which the
/// account's streams hear. Nothing for an account that has no `analyses.db`.
pub(crate) async fn lost_repo(app: &App, account: i64, repo_id: i64, repo: &str) {
    if !app.analyses().dbs.path(account).exists() {
        return;
    }
    let runs = match app
        .analyses()
        .dbs
        .read(account, move |c| analysis_db::q::repo_runs(c, repo_id))
        .await
    {
        Ok(r) => r,
        // Deleted (dormant, or disconnected): nothing left of it.
        Err(dbrt::Error::Deleted) => return,
        Err(e) => {
            eprintln!("account {account}: reading its analysis runs on {repo}: {e}");
            return;
        }
    };
    let reasons: Vec<(String, String)> = runs
        .iter()
        .map(|r| {
            let why = r.ended_reason.as_deref().unwrap_or(Ended::NoRead.as_str());
            (r.id.clone(), why.to_owned())
        })
        .collect();
    if let Err(e) = app
        .control()
        .write(move |tx| {
            for (id, why) in &reasons {
                control_db::q::set_run_token_ended(tx, id, why)?;
            }
            Ok(())
        })
        .await
    {
        eprintln!("account {account}: noting why its analysis runs on {repo} ended: {e}");
        return;
    }
    if let Err(e) = app
        .analyses()
        .dbs
        .write(account, move |tx| {
            analysis_db::q::delete_repo_runs(tx, repo_id)?;
            analysis_db::q::delete_repo_behind(tx, repo_id)?;
            analysis_db::q::delete_repo_analyses(tx, repo_id)
        })
        .await
    {
        eprintln!("account {account}: deleting its analyses of {repo}: {e}");
        return;
    }
    eprintln!("account {account}: can no longer read {repo}; its analyses there are deleted");
    for r in runs {
        app.analyses().wake(&r.id);
        if r.ended_reason.is_none() {
            announce(app, account, repo, r.number, None);
        }
    }
}

/// The daily check's part (and so startup's, its first): for every active account, each repo it
/// has runs or analyses of that its mirror says it can't read goes as [`lost_repo`] has it go.
/// That runs as a re-read of the roles finds Read lost, once; this retries one whose delete
/// failed, or that a crash cut off. Only against a mirror its repos were read into: one never
/// read (just created or revived) says nothing about them, while one read that lists none says
/// the account lost them all.
pub(crate) async fn heal_lost_repos(app: &App) {
    let accounts = match app.control().read(control_db::q::active_accounts).await {
        Ok(a) => a,
        Err(e) => {
            eprintln!("accounts: reading the active accounts for their lost repos: {e}");
            return;
        }
    };
    for account in accounts {
        if !app.analyses().dbs.path(account).exists() {
            continue;
        }
        let repos = match app
            .analyses()
            .dbs
            .read(account, analysis_db::q::repos)
            .await
        {
            Ok(r) if r.is_empty() => continue,
            Ok(r) => r,
            Err(dbrt::Error::Deleted) => continue,
            Err(e) => {
                eprintln!("account {account}: reading the repos of its analyses: {e}");
                continue;
            }
        };
        let visible = match app
            .mirrors()
            .read(account, mirror_db::Caller::Sweep, |c| {
                Ok((
                    mirror_db::q::visible_repos(c)?,
                    mirror_db::q::roles_read(c)?,
                ))
            })
            .await
        {
            // Never read (a mirror from before `roles_read` lists its repos, so it was).
            Ok((v, false)) if v.is_empty() => continue,
            Ok((v, _)) => v,
            Err(mirror_db::Error::Deleted) => continue,
            Err(e) => {
                eprintln!("account {account}: reading its repos for its analyses: {e}");
                continue;
            }
        };
        for r in repos {
            let readable = visible
                .iter()
                .any(|v| v.id == r.repo_id && v.role.is_some());
            if !readable {
                lost_repo(app, account, r.repo_id, &format!("{}/{}", r.owner, r.name)).await;
            }
        }
    }
}

/// The repo a run is for, as the account's mirror holds it: its id, its name as GitHub spells
/// it, and whether the account can read it.
pub(crate) struct Repo {
    pub id: i64,
    pub owner: String,
    pub name: String,
}

/// `owner/name`, if the account can see it and read it.
pub(crate) async fn readable_repo(
    app: &App,
    account: i64,
    owner: &str,
    name: &str,
) -> Result<Option<Repo>, dbrt::Error> {
    let (o, n) = (owner.to_owned(), name.to_owned());
    let found = app
        .mirrors()
        .read(account, mirror_db::Caller::Request, move |c| {
            mirror_db::q::run_repo(c, &o, &n)
        })
        .await?;
    Ok(found.and_then(|r| {
        r.role.map(|_| Repo {
            id: r.id,
            owner: r.owner,
            name: r.name,
        })
    }))
}

/// `POST /api/{owner}/{repo}/pulls/{n}/runs`'s answer.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    /// The run's ID.
    pub run: String,
    /// The run's token: in the prompt's URL. beghu keeps only its hash, so this is the only time
    /// it's told.
    pub token: String,
    /// The prompt to paste into an agent, word for word.
    pub prompt: String,
    /// When the run started (Unix seconds, the server's clock): what the PR detail's
    /// `run.startedAt` says of it.
    pub started_at: i64,
    /// When the run expires if nothing fetches from it (Unix seconds).
    pub expires_at: i64,
}

/// `POST /api/cli/runs`'s answer.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CliRunStarted {
    pub run: String,
    pub token: String,
    /// The PR's size, as the CLI prints it first: `120 files, +3400 −1200`.
    pub size_line: String,
}

/// A run just started.
struct Started {
    run: String,
    token: String,
    created_at: i64,
    files: i64,
    additions: i64,
    deletions: i64,
}

/// The PR's size, as the prompt and the run header state it: `120 files, +3400 −1200`.
pub(crate) fn size_line(files: i64, additions: i64, deletions: i64) -> String {
    format!("{files} files, +{additions} \u{2212}{deletions}")
}

/// Starts a run on PR `number` of `repo` for `account`, superseding the live one: refused when
/// the account can't read the repo, the number isn't a PR, or the PR changes more than 3,000
/// files.
async fn start(
    app: &App,
    account: i64,
    repo: &Repo,
    number: i64,
    producer: Producer,
) -> Result<Started, ApiError> {
    let gh = app.github().clone();
    let (o, n) = (repo.owner.clone(), repo.name.clone());
    let pull = app
        .tokens()
        .with_token(account, |token| {
            let (gh, o, n) = (gh.clone(), o.clone(), n.clone());
            async move { gh.pull(&token, &o, &n, number).await }
        })
        .await;
    let pull = match pull {
        Ok(crate::github::Shown::It(p)) => p,
        Ok(_) => return Err(ApiError::Gone),
        Err(crate::tokens::Error::GitHub(e)) => {
            return Err(ApiError::GitHubDown(format!(
                "GitHub didn't answer for the PR ({e}); try again in a moment"
            )));
        }
        Err(e) => return Err(e.into()),
    };
    if pull.changed_files > super::MAX_FILES {
        return Err(ApiError::PrTooLarge(format!(
            "This PR changes {} files; an analysis takes at most {} (GitHub lists no more).",
            pull.changed_files,
            super::MAX_FILES
        )));
    }
    let (run, token) = (new_id(), new_token());
    let hash = sha256(&unb64(&token).expect("just encoded"));
    let t = now();
    {
        let run = run.clone();
        app.control()
            .write(move |tx| {
                control_db::q::insert_run_token(tx, &hash, &run, account, producer.as_str(), t)
            })
            .await?;
    }
    let (id, repo_id, owner, name) = (run.clone(), repo.id, repo.owner.clone(), repo.name.clone());
    let written = app
        .analyses()
        .dbs
        .write(account, move |tx| {
            let superseded = analysis_db::q::live_run(tx, repo_id, number)?;
            if let Some(live) = &superseded {
                analysis_db::q::end_run(tx, &live.id, Ended::Superseded.as_str(), t)?;
            }
            analysis_db::q::insert_run(
                tx,
                &id,
                repo_id,
                &owner,
                &name,
                number,
                producer.as_str(),
                t,
            )?;
            Ok(superseded.map(|l| l.id))
        })
        .await;
    if let Ok(Some(superseded)) = &written {
        app.analyses().wake(superseded);
    }
    if let Err(e) = written {
        // The token goes with the run it was for.
        let id = run.clone();
        if let Err(e) = app
            .control()
            .write(move |tx| control_db::q::delete_run_token(tx, &id))
            .await
        {
            eprintln!("account {account}: taking back the token of run {run}: {e}");
        }
        return Err(e.into());
    }
    watch(app, account, run.clone());
    announce(
        app,
        account,
        &format!("{}/{}", repo.owner, repo.name),
        number,
        None,
    );
    Ok(Started {
        run,
        token,
        created_at: t,
        files: pull.changed_files,
        additions: pull.additions,
        deletions: pull.deletions,
    })
}

/// The PR number in a route: digits only, as the app's routes match it.
pub(crate) fn pr_number(raw: &str) -> Result<i64, ApiError> {
    match raw.parse::<i64>() {
        Ok(n) if n > 0 && raw.bytes().all(|b| b.is_ascii_digit()) => Ok(n),
        _ => Err(ApiError::Gone),
    }
}

/// `POST /api/{owner}/{repo}/pulls/{n}/runs`: starts a button run, superseding the PR's live
/// run, and answers the prompt to copy.
pub async fn start_button(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path((owner, name, number)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let number = pr_number(&number)?;
    let repo = readable_repo(&app, s.account, &owner, &name)
        .await?
        .ok_or(ApiError::Gone)?;
    let started = start(&app, s.account, &repo, number, Producer::Button).await?;
    let url = format!(
        "{}/api/runs/{}/instructions",
        app.cfg().public_url,
        started.token
    );
    let prompt = format!(
        "Analyse pull request {}/{}#{number} ({}) for beghu by fetching your instructions from `{url}` and following them to the end: they say how to check out the code, build and check the analysis, and upload it. Large PRs are split across several agents and can take an hour; treat the link as a password, as it lets anyone holding it act on this PR's analysis until the run ends.",
        repo.owner,
        repo.name,
        size_line(started.files, started.additions, started.deletions),
    );
    Ok((
        StatusCode::CREATED,
        Json(RunStarted {
            run: started.run,
            token: started.token,
            prompt,
            started_at: started.created_at,
            expires_at: started.created_at + app.cfg().runs.unused_for.as_secs() as i64,
        }),
    )
        .into_response())
}

/// `DELETE /api/{owner}/{repo}/pulls/{n}/run`: ends the PR's live run, if it has one.
pub async fn end_button(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path((owner, name, number)): Path<(String, String, String)>,
) -> Result<StatusCode, ApiError> {
    let number = pr_number(&number)?;
    let account = s.account;
    let (o, n) = (owner.clone(), name.clone());
    let repo = app
        .mirrors()
        .read(account, mirror_db::Caller::Request, move |c| {
            mirror_db::q::run_repo(c, &o, &n)
        })
        .await?
        .ok_or(ApiError::Gone)?;
    let repo_id = repo.id;
    let live = app
        .analyses()
        .dbs
        .read(account, move |c| {
            analysis_db::q::live_run(c, repo_id, number)
        })
        .await?;
    if let Some(live) = live {
        let id = live.id.clone();
        let run = app
            .analyses()
            .dbs
            .read(account, move |c| analysis_db::q::run(c, &id))
            .await?;
        if let Some(run) = run {
            end(&app, account, &run, Ended::ByUser).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/cli/runs`'s body.
#[derive(Deserialize)]
pub struct CliStart {
    owner: String,
    repo: String,
    number: i64,
}

/// `POST /api/cli/runs`: starts a CLI run for the account the CLI's credential belongs to,
/// superseding the PR's live run, as the browser's start does. `404` for a repo the account can't
/// read or a number that isn't a PR, `400` for a PR past 3,000 changed files.
pub async fn start_cli(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<CliStart>,
) -> Result<Response, RunError> {
    let account = crate::cli::usable_credential(&app, &headers).await?.account;
    if body.number <= 0 {
        return Err(RunError::NotFound("No such PR."));
    }
    let repo = readable_repo(&app, account, &body.owner, &body.repo)
        .await?
        .ok_or(RunError::NotFound("No such repo, or you can't read it."))?;
    let started = match start(&app, account, &repo, body.number, Producer::Cli).await {
        Ok(s) => s,
        Err(ApiError::Gone) => return Err(RunError::NotFound("No such PR.")),
        Err(ApiError::PrTooLarge(m)) => return Err(RunError::BadRequest(m)),
        Err(ApiError::GitHubDown(why)) => {
            return Err(RunError::Unavailable {
                retry_after: Duration::from_secs(10),
                why,
            });
        }
        Err(ApiError::Unavailable { retry_after, why }) => {
            return Err(RunError::Unavailable { retry_after, why });
        }
        Err(ApiError::SignedOut) => return Err(RunError::SignInAgain),
        Err(e) => return Err(RunError::Internal(format!("{e:?}"))),
    };
    Ok((
        StatusCode::CREATED,
        Json(CliRunStarted {
            run: started.run,
            token: started.token,
            size_line: size_line(started.files, started.additions, started.deletions),
        }),
    )
        .into_response())
}
