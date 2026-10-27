//! How a failed API request answers: a status, a JSON body naming the failure kind (the client
//! maps it to its named error classes), and `retry-after` when trying again later will work.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::time::Duration;
use ts_rs::TS;

#[derive(Debug)]
pub enum ApiError {
    /// No session, an expired one, or an account that must sign in again.
    SignedOut,
    BadRequest(String),
    /// Refused: from another site's page.
    Forbidden(String),
    /// No such API path.
    NotFound,
    /// No such issue in the account's mirror: deleted, or never there.
    Gone,
    /// The issue is in the mirror but outside the synced repos (a stub, or a repo no longer
    /// synced), so beghu doesn't hold it. Its body says where it is on GitHub.
    NoAccess(IssueRef),
    /// Try again after `retry_after`: at the connection cap, or a mirror still migrating.
    Unavailable {
        retry_after: Duration,
        why: String,
    },
    Internal(String),
}

/// The body of every failed API response.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct ErrorBody {
    pub error: ErrorKind,
    pub message: String,
    /// With `no_access`: the issue, enough to link out to it on GitHub.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue: Option<IssueRef>,
}

/// An issue beghu doesn't hold, named well enough to link out to it on GitHub.
#[derive(Serialize, TS, Debug)]
#[ts(export)]
pub struct IssueRef {
    /// `issue` or `pr`.
    pub kind: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
}

/// What kind of failure: the client maps each kind to one of its named error classes.
#[derive(Serialize, TS, Clone, Copy, Debug)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 401: sign in.
    SignedOut,
    /// 400.
    BadRequest,
    /// 403: refused, whoever asks.
    Forbidden,
    /// 404: no such API path.
    NotFound,
    /// 404: the issue isn't there (any more).
    Gone,
    /// 403: the issue is outside the account's synced repos.
    NoAccess,
    /// 503: try again after the `retry-after` header's seconds.
    Unavailable,
    /// 500.
    Internal,
}

impl From<dbrt::Error> for ApiError {
    fn from(e: dbrt::Error) -> Self {
        match e.retry_after() {
            Some(retry_after) => ApiError::Unavailable {
                retry_after,
                why: e.to_string(),
            },
            None => ApiError::Internal(e.to_string()),
        }
    }
}

impl From<crate::tokens::Error> for ApiError {
    fn from(e: crate::tokens::Error) -> Self {
        match e {
            crate::tokens::Error::SignInAgain => ApiError::SignedOut,
            crate::tokens::Error::Db(e) => e.into(),
            e => ApiError::Internal(e.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (mut retry_after, mut issue) = (None, None);
        let (status, kind, message) = match self {
            ApiError::SignedOut => (
                StatusCode::UNAUTHORIZED,
                ErrorKind::SignedOut,
                "Sign in to continue".to_owned(),
            ),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, ErrorKind::BadRequest, m),
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, ErrorKind::Forbidden, m),
            ApiError::NotFound => (
                StatusCode::NOT_FOUND,
                ErrorKind::NotFound,
                "No such API path".to_owned(),
            ),
            ApiError::Gone => (
                StatusCode::NOT_FOUND,
                ErrorKind::Gone,
                "This issue was deleted, or isn't in your synced repos".to_owned(),
            ),
            ApiError::NoAccess(i) => {
                issue = Some(i);
                (
                    StatusCode::FORBIDDEN,
                    ErrorKind::NoAccess,
                    "This issue is in a repo that isn't synced".to_owned(),
                )
            }
            ApiError::Unavailable {
                retry_after: r,
                why,
            } => {
                retry_after = Some(r);
                (StatusCode::SERVICE_UNAVAILABLE, ErrorKind::Unavailable, why)
            }
            ApiError::Internal(m) => {
                eprintln!("internal error: {m}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ErrorKind::Internal,
                    "Something went wrong".to_owned(),
                )
            }
        };
        let mut res = (
            status,
            axum::Json(ErrorBody {
                error: kind,
                message,
                issue,
            }),
        )
            .into_response();
        if let Some(retry_after) = retry_after {
            // Whole seconds, rounded up: `retry-after: 0` would invite a hot loop.
            let secs = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
            res.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs.max(1)));
        }
        res
    }
}
