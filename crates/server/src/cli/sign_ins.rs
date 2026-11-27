//! The CLI's credentials as their account sees and ends them: the setup page's "CLI sign-ins"
//! (`GET /api/cli/sign-ins`, Revoke as `DELETE /api/cli/sign-ins/{id}`), `beghu logout` (`POST
//! /api/cli/logout`, the credential revoking itself) and `beghu status` (`GET /api/cli/status`).
//! A revoked credential's next call answers `401 bad_credential`.

use super::{credential, has_credential};
use crate::analyses::runs::RunError;
use crate::auth::Session;
use crate::error::ApiError;
use crate::{App, now};
use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Serialize;
use ts_rs::TS;

/// One of the account's CLI credentials, as the setup page lists it.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CliSignIn {
    /// What Revoke names it by.
    pub id: String,
    /// The machine's name (`beghu login --name`, its hostname by default).
    pub name: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds, to within a minute.
    pub last_used_at: i64,
    /// When it expires unless it's used again (Unix seconds).
    pub expires_at: i64,
}

/// `GET /api/cli/sign-ins`: the account's live CLI credentials, the newest first.
pub async fn list(
    State(app): State<App>,
    Extension(s): Extension<Session>,
) -> Result<Json<Vec<CliSignIn>>, ApiError> {
    let unused_for = app.cfg().cli.unused_for.as_secs() as i64;
    let (account, after) = (s.account, now() - unused_for);
    let rows = app
        .control()
        .read(move |c| control_db::q::cli_tokens_of(c, account, after))
        .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| CliSignIn {
                id: r.id,
                name: r.name,
                created_at: r.created_at,
                last_used_at: r.last_used_at,
                expires_at: r.last_used_at + unused_for,
            })
            .collect(),
    ))
}

/// `DELETE /api/cli/sign-ins/{id}`: revokes one of the account's CLI credentials. 204 whether
/// or not it was still there.
pub async fn revoke(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let account = s.account;
    let n = app
        .control()
        .write(move |tx| control_db::q::delete_cli_token(tx, account, &id))
        .await?;
    if n > 0 {
        eprintln!("account {account}: a beghu CLI sign-in was revoked on the setup page");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/cli/logout`: the call's credential revokes itself (`beghu logout`). 204.
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode, RunError> {
    let c = credential(&app, &headers).await?;
    let (account, id) = (c.account, c.id);
    app.control()
        .write(move |tx| control_db::q::delete_cli_token(tx, account, &id))
        .await?;
    eprintln!("account {account}: a beghu CLI signed out");
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/cli/status`'s answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The account the call's credential belongs to; `null` for a call without one.
    account: Option<StatusAccount>,
    /// When the credential expires unless it's used again (Unix seconds).
    expires_at: Option<i64>,
    /// This server's build (its git SHA in a deploy).
    build: String,
    /// The oldest CLI this server answers.
    min_cli: String,
    /// The CLI this server serves (`beghu update` installs it).
    cli_version: String,
    /// The analysis schema's version.
    schema: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusAccount {
    id: i64,
    login: String,
    /// `active`, or `needs_sign_in` when the account must sign in to beghu again in a browser.
    status: &'static str,
}

/// `GET /api/cli/status`: the host's build and its CLI floor, and with a credential, its account
/// and expiry. A credential that's revoked or expired is `401 bad_credential`.
pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Json<Status>, RunError> {
    let c = if has_credential(&headers) {
        Some(credential(&app, &headers).await?)
    } else {
        None
    };
    Ok(Json(Status {
        expires_at: c.as_ref().map(|c| c.expires_at(&app)),
        account: c.map(|c| StatusAccount {
            id: c.account,
            login: c.login,
            status: c.status.as_str(),
        }),
        build: app.cfg().build_id.clone(),
        min_cli: app.cfg().cli.min_cli.to_string(),
        cli_version: app.cli_version().to_string(),
        schema: analysis::VERSION,
    }))
}
