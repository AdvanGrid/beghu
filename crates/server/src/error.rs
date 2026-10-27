//! How a failed API request answers: a status, a JSON body naming the failure kind (the client
//! maps it to its named error classes), and `retry-after` when trying again later will work.

use crate::markdown::Digest;
use crate::ops::OpKind;
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
    /// A write GitHub refused, or answered without applying: the message says why, in words
    /// for the user.
    Refused(String),
    /// A write held back by GitHub's rate limit for longer than beghu waits quietly: try again
    /// after `retry_after`.
    RateLimited {
        retry_after: Duration,
    },
    /// A write GitHub answered with a conflict.
    Conflict(String),
    /// A write that couldn't reach GitHub: it's down, or kept failing.
    GitHubDown(String),
    /// A resent write the server has no record of: it restarted, or forgot it. The first send
    /// may or may not have reached GitHub. `kind`: what the write was. `digest`: a comment's, as
    /// in [`ErrorBody::digest`].
    Lost {
        kind: OpKind,
        digest: Option<Digest>,
    },
    /// A comment GitHub answered with a 5xx or a 2xx beghu couldn't read, or didn't answer: it
    /// may have been posted. `after`: the newest comment id the mirror held on the issue as it
    /// was sent; only a comment with a greater id can be it. `digest`: as in
    /// [`ErrorBody::digest`].
    MaybePosted {
        after: i64,
        digest: Option<Digest>,
    },
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
    /// With `maybe_posted`: the newest comment id the mirror held on the issue as the comment
    /// was sent. Only a comment with a greater id can be it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<i64>,
    /// With `maybe_posted` or `lost` for a comment: the comment's digest (the SHA-256 of its
    /// Markdown, hex), as a thread's comments carry theirs (`Comment.digest`). The tab compares
    /// it with them to find the comment, without hashing anything itself (a page on plain http
    /// has no `crypto.subtle`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub digest: Option<Digest>,
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
    /// 422: a write GitHub refused or didn't apply.
    Refused,
    /// 429: a write held back by GitHub's rate limit; try again after `retry-after` seconds.
    RateLimited,
    /// 409: a write GitHub answered with a conflict.
    Conflict,
    /// 503 (beghu's own answer, with this body; never a proxy's 502): a write that couldn't reach
    /// GitHub.
    GithubDown,
    /// 410: a resent write the server has no record of; it may or may not have reached GitHub.
    Lost,
    /// 424: a comment GitHub failed on, answered unreadably or didn't answer; it may have been
    /// posted all the same. The body's `after` says which comments can be it.
    MaybePosted,
}

impl From<dbrt::Error> for ApiError {
    fn from(e: dbrt::Error) -> Self {
        // A write that reached a database after the drain's checkpoint sealed it: a request the
        // drain's deadline left running.
        if let dbrt::Error::Sealed = e {
            return ApiError::restarting();
        }
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
            crate::tokens::Error::Restarting => ApiError::restarting(),
            crate::tokens::Error::Db(e) => e.into(),
            e => ApiError::Internal(e.to_string()),
        }
    }
}

impl ApiError {
    /// The drain stopped the work this request waited on: beghu is restarting.
    pub fn restarting() -> ApiError {
        ApiError::Unavailable {
            retry_after: Duration::from_secs(5),
            why: "beghu is restarting; try again in a moment".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (mut retry_after, mut issue, mut after, mut digest) = (None, None, None, None);
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
            ApiError::Refused(m) => (StatusCode::UNPROCESSABLE_ENTITY, ErrorKind::Refused, m),
            ApiError::RateLimited { retry_after: r } => {
                retry_after = Some(r);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    ErrorKind::RateLimited,
                    format!("GitHub's rate limit: try again in {} s", r.as_secs().max(1)),
                )
            }
            ApiError::Conflict(m) => (StatusCode::CONFLICT, ErrorKind::Conflict, m),
            ApiError::GitHubDown(m) => (StatusCode::SERVICE_UNAVAILABLE, ErrorKind::GithubDown, m),
            // These two are the words the tab shows: it says what the write was.
            ApiError::Lost { kind, digest: d } => {
                digest = d;
                (
                    StatusCode::GONE,
                    ErrorKind::Lost,
                    kind.lost_message().to_owned(),
                )
            }
            ApiError::MaybePosted {
                after: a,
                digest: d,
            } => {
                after = Some(a);
                digest = d;
                (
                    StatusCode::FAILED_DEPENDENCY,
                    ErrorKind::MaybePosted,
                    "May have been posted; check the thread".to_owned(),
                )
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
                after,
                digest,
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
