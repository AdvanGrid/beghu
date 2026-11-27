//! The beghu CLI's side of the server (#179): the floor every CLI call is held to
//! ([`MIN_CLI`], [`gate`]), the CLI's credential ([`credential`]), beghu's own device flow
//! ([`login`]), the setup page's "CLI sign-ins", `beghu logout` and `beghu status`
//! ([`sign_ins`]), and the CLI's builds this deployment serves ([`dist`]).
//!
//! **The credential** is `beghu_cli_` then 256 random bits, URL-safe, so secret scanners
//! recognise it. Only the SHA-256 of its random part is stored, in the control DB (`cli_tokens`),
//! with its account, the machine's name, and when it was made and last used. It can only start
//! analysis runs and act within them. It expires 90 days after its last use, with no absolute
//! cap, and goes with its account at dormancy and at Disconnect; signing out in a browser leaves
//! it, so CI isn't broken by every sign-out. A call counts as the account's use, as a browser's
//! does.
//!
//! **Versions.** Every CLI call says what it is (`User-Agent: beghu-cli/<semver>`,
//! `Beghu-Schema: <n>`). One older than [`MIN_CLI`] is refused on every call, mid-run included,
//! with `426` and how to update, and the run survives; one newer than the CLI this server serves
//! is refused with `409` and that version. Only calls from the CLI are held to it: an agent's
//! `curl` on a button run carries no CLI version.

pub(crate) mod dist;
pub(crate) mod limits;
pub(crate) mod login;
pub(crate) mod sign_ins;

use crate::analyses::runs::RunError;
use crate::crypto::{sha256, unb64};
use crate::tokens::AccountStatus;
use crate::{App, now};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// The oldest beghu CLI this server answers. Bump it in the same change as any schema bump
/// (`analysis::VERSION`), and in any change whose instructions name a CLI command an older CLI
/// doesn't have. 0.1.0: the CLI's first version, which has every command the instructions name.
pub const MIN_CLI: &str = "0.1.0";

/// The CLI's own manifest, for the version this source tree builds.
const CLI_MANIFEST: &str = include_str!("../../../cli/Cargo.toml");

/// The hosted deployment, the CLI's default host: `install.sh` from any other names its host in
/// the `beghu login` it suggests.
pub const DEFAULT_HOST: &str = "https://beghu.dev";

/// What every CLI credential starts with.
pub const TOKEN_PREFIX: &str = "beghu_cli_";

/// A CLI call moves its credential's `last_used_at` at most this often.
const TOUCH_EVERY: i64 = 60;

/// A semver, as `MIN_CLI` compares them: major, minor, patch. A pre-release or build suffix
/// (`-dev`, `+abc`) is ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CliVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl CliVersion {
    pub fn parse(s: &str) -> Option<CliVersion> {
        let core = s.trim().split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|p| {
            (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse::<u64>().ok())
                .flatten()
        });
        let v = CliVersion {
            major: parts.next()??,
            minor: parts.next()??,
            patch: parts.next()??,
        };
        parts.next().is_none().then_some(v)
    }
}

impl std::fmt::Display for CliVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The CLI version this source tree builds (`crates/cli/Cargo.toml`'s `[package] version`).
pub fn source_version() -> CliVersion {
    let mut in_package = false;
    for line in CLI_MANIFEST.lines().map(str::trim) {
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if in_package && let Some(v) = line.strip_prefix("version") {
            let v = v
                .trim_start()
                .trim_start_matches('=')
                .trim()
                .trim_matches('"');
            return CliVersion::parse(v).expect("crates/cli/Cargo.toml's version is a semver");
        }
    }
    panic!("crates/cli/Cargo.toml has no [package] version")
}

/// A new credential: the token to hand the CLI, once, and the hash to store.
pub(crate) fn new_token() -> (String, Vec<u8>) {
    let secret = crate::crypto::random_token(32);
    let hash = sha256(&unb64(&secret).expect("just encoded"));
    (format!("{TOKEN_PREFIX}{secret}"), hash)
}

/// The stored hash of a well-formed credential.
fn token_hash(token: &str) -> Option<Vec<u8>> {
    let raw = unb64(token.strip_prefix(TOKEN_PREFIX)?)?;
    (raw.len() == 32).then(|| sha256(&raw))
}

/// The CLI version a request comes from (`User-Agent: beghu-cli/<semver>`): `None` for one
/// that isn't the CLI's, `Some(None)` for the CLI's with a version beghu can't read.
fn cli_of(headers: &HeaderMap) -> Option<Option<CliVersion>> {
    let ua = headers.get(header::USER_AGENT)?.to_str().ok()?;
    let v = ua.strip_prefix("beghu-cli/")?;
    Some(CliVersion::parse(v.split_whitespace().next().unwrap_or("")))
}

/// The run API's and the CLI's routes: a call from a CLI older than the floor answers `426`, and
/// one from a CLI newer than the one this server serves `409`. Every other call goes on.
pub(crate) async fn gate(State(app): State<App>, req: Request, next: Next) -> Response {
    if let Some(v) = cli_of(req.headers()) {
        let floor = app.cfg().cli.min_cli;
        let ours = app.cli_version();
        match v {
            Some(v) if v < floor => {
                return RunError::CliTooOld {
                    minimum: floor,
                    host: app.cfg().public_url.clone(),
                    server: ours,
                }
                .into_response();
            }
            Some(v) if v > ours => return RunError::CliTooNew { server: ours }.into_response(),
            Some(_) => {}
            None => {
                return RunError::BadRequest(
                    "The User-Agent names beghu-cli without a version beghu can read.".into(),
                )
                .into_response();
            }
        }
    }
    next.run(req).await
}

/// A CLI call let in by its credential.
pub(crate) struct Credential {
    pub id: String,
    pub account: i64,
    pub login: String,
    pub status: AccountStatus,
    /// When it was last used, this call included.
    pub last_used_at: i64,
}

impl Credential {
    /// When it expires unless it's used again.
    pub fn expires_at(&self, app: &App) -> i64 {
        self.last_used_at + app.cfg().cli.unused_for.as_secs() as i64
    }
}

/// Whether the call carries a credential at all (`Authorization: Bearer …`).
pub(crate) fn has_credential(headers: &HeaderMap) -> bool {
    headers.contains_key(header::AUTHORIZATION)
}

/// The CLI credential a call carries (`Authorization: Bearer beghu_cli_…`), if it's live: `401
/// bad_credential` when it's missing, malformed, revoked or expired (an expired one is deleted).
/// The call counts as the credential's use, and as its account's (a browser's request does the
/// same): its `last_used_at` moves, at most once a minute.
pub(crate) async fn credential(app: &App, headers: &HeaderMap) -> Result<Credential, RunError> {
    let hash = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| token_hash(t.trim()))
        .ok_or(RunError::BadCredential)?;
    let Some(row) = app
        .control()
        .read(move |c| control_db::q::cli_token(c, &hash))
        .await?
    else {
        return Err(RunError::BadCredential);
    };
    let t = now();
    let unused_for = app.cfg().cli.unused_for.as_secs() as i64;
    if row.last_used_at + unused_for <= t {
        let (account, id) = (row.github_user_id, row.id.clone());
        app.control()
            .write(move |tx| control_db::q::delete_cli_token(tx, account, &id))
            .await?;
        return Err(RunError::BadCredential);
    }
    let mut last_used_at = row.last_used_at;
    if t - row.last_used_at >= TOUCH_EVERY {
        let id = row.id.clone();
        app.control()
            .write(move |tx| control_db::q::touch_cli_token(tx, &id, t))
            .await?;
        last_used_at = t;
    }
    let status = AccountStatus::from_db(&row.status);
    if status.is_usable() {
        crate::accounts::used(app, row.github_user_id, status, row.last_active_at).await?;
    }
    Ok(Credential {
        id: row.id,
        account: row.github_user_id,
        login: row.login,
        status,
        last_used_at,
    })
}

/// [`credential`], for a call that acts as its account: one that must sign in to beghu again
/// (in a browser) is refused, `403 sign_in_again`.
pub(crate) async fn usable_credential(
    app: &App,
    headers: &HeaderMap,
) -> Result<Credential, RunError> {
    let c = credential(app, headers).await?;
    if c.status.is_usable() {
        Ok(c)
    } else {
        Err(RunError::SignInAgain)
    }
}

/// The daily check's part: credentials unused for 90 days go.
pub(crate) async fn prune(app: &App) {
    let before = now() - app.cfg().cli.unused_for.as_secs() as i64;
    if let Err(e) = app
        .control()
        .write(move |tx| control_db::q::prune_cli_tokens(tx, before))
        .await
    {
        eprintln!("accounts: pruning the CLI credentials unused for 90 days: {e}");
    }
}
