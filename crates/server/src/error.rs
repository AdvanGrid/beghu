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
    /// No such API path.
    NotFound,
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
    /// 404: no such API path.
    NotFound,
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
        let (status, kind, message) = match &self {
            ApiError::SignedOut => (
                StatusCode::UNAUTHORIZED,
                ErrorKind::SignedOut,
                "Sign in to continue".to_owned(),
            ),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, ErrorKind::BadRequest, m.clone()),
            ApiError::NotFound => (
                StatusCode::NOT_FOUND,
                ErrorKind::NotFound,
                "No such API path".to_owned(),
            ),
            ApiError::Unavailable { why, .. } => (
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorKind::Unavailable,
                why.clone(),
            ),
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
            }),
        )
            .into_response();
        if let ApiError::Unavailable { retry_after, .. } = self {
            // Whole seconds, rounded up: `retry-after: 0` would invite a hot loop.
            let secs = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
            res.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs.max(1)));
        }
        res
    }
}
