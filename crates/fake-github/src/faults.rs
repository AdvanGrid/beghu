//! Runtime faults on the GitHub side: latency per endpoint, the next N calls failing with a
//! chosen status, and down. Set through the control port; a reset clears them.
//!
//! An endpoint is `*` (everything), or a path with an optional method in front (`GET /user`).
//! A path matches only itself, ignoring a trailing slash on either side; rules are stored
//! normalised (see [`normalise_endpoint`]). A `*` segment inside it
//! stands for exactly one segment: `/repos/*/*/issues/*/comments` matches
//! `/repos/acme/web/issues/5/comments`. A path ending in `/*` matches everything under it:
//! `/user/installations/*` matches `/user/installations/41000001/repositories`.
//!
//! When several latency rules match a call, the longest applies. When several fail rules match,
//! the first one added wins and uses up one of its calls; the others wait their turn.

use crate::Fake;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub(crate) struct Faults(Mutex<Rules>);

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub(crate) struct Rules {
    pub down: bool,
    pub latency: Vec<Latency>,
    pub fail: Vec<Fail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Latency {
    pub endpoint: String,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Fail {
    pub endpoint: String,
    pub remaining: u32,
    pub status: u16,
    /// Seconds, sent as `retry-after` (and as the rate-limit reset for 403 and 429).
    pub retry_after: Option<u64>,
}

impl Faults {
    fn with<T>(&self, f: impl FnOnce(&mut Rules) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn snapshot(&self) -> Rules {
        self.with(|r| r.clone())
    }

    pub fn clear(&self) {
        self.with(|r| *r = Rules::default());
    }

    pub fn is_down(&self) -> bool {
        self.with(|r| r.down)
    }

    pub fn set_down(&self, down: bool) {
        self.with(|r| r.down = down);
    }

    /// Sets the latency for `endpoint`, replacing any earlier rule for it; 0 removes it.
    pub fn set_latency(&self, endpoint: String, ms: u64) {
        self.with(|r| {
            r.latency.retain(|l| l.endpoint != endpoint);
            if ms > 0 {
                r.latency.push(Latency { endpoint, ms });
            }
        });
    }

    pub fn add_fail(&self, fail: Fail) {
        self.with(|r| r.fail.push(fail));
    }

    /// What happens to one call: the delay before it, and the status it fails with, if any.
    /// Uses up one call of the first matching fail rule.
    fn on_call(&self, method: &Method, path: &str) -> (Duration, Option<Fail>) {
        self.with(|r| {
            let delay = r
                .latency
                .iter()
                .filter(|l| matches(&l.endpoint, method, path))
                .map(|l| l.ms)
                .max()
                .unwrap_or(0);
            let fail = r
                .fail
                .iter_mut()
                .find(|f| matches(&f.endpoint, method, path))
                .map(|f| {
                    f.remaining -= 1;
                    f.clone()
                });
            r.fail.retain(|f| f.remaining > 0);
            (Duration::from_millis(delay), fail)
        })
    }
}

/// `endpoint` (see the module docs) in the one spelling rules are stored under: the method in
/// upper case and no trailing slash, so `get /user/` and `GET /user` are one rule. `None` if it
/// isn't an endpoint.
pub(crate) fn normalise_endpoint(endpoint: &str) -> Option<String> {
    let (method, path) = match endpoint.split_once(' ') {
        Some((m, p)) => (
            Some(Method::from_bytes(m.to_ascii_uppercase().as_bytes()).ok()?),
            p,
        ),
        None => (None, endpoint),
    };
    if path != "*" && !path.starts_with('/') {
        return None;
    }
    let path = match path.trim_end_matches('/') {
        "" => "/",
        p => p,
    };
    Some(match method {
        Some(m) => format!("{m} {path}"),
        None => path.to_owned(),
    })
}

fn matches(endpoint: &str, method: &Method, path: &str) -> bool {
    let pattern = match endpoint.split_once(' ') {
        Some((m, p)) if m == method.as_str() => p,
        Some(_) => return false,
        None => endpoint,
    };
    if pattern == "*" {
        return true;
    }
    let (pattern, under) = match pattern.strip_suffix("/*") {
        Some(prefix) => (prefix, true),
        None => (pattern, false),
    };
    let mut segments = path.trim_end_matches('/').split('/');
    for want in pattern.split('/') {
        match segments.next() {
            Some(got) if got == want || (want == "*" && !got.is_empty()) => {}
            _ => return false,
        }
    }
    match segments.next() {
        Some(rest) => under && !rest.is_empty(),
        None => !under,
    }
}

/// Applies the rules to every call on the GitHub side.
pub(crate) async fn middleware(State(fake): State<Fake>, req: Request, next: Next) -> Response {
    let faults = &fake.state().faults;
    if faults.is_down() {
        // A connection opened before going down: answer like a dead upstream and close it.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONNECTION, "close")],
            "GitHub is down (fake)",
        )
            .into_response();
    }
    let (delay, fail) = faults.on_call(req.method(), req.uri().path());
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    match fail {
        Some(f) => failure(&f),
        None => next.run(req).await,
    }
}

/// The response GitHub gives for `f.status`.
fn failure(f: &Fail) -> Response {
    let status = StatusCode::from_u16(f.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let rate_limited = matches!(f.status, 403 | 429) && f.retry_after.is_some();
    let message = match f.status {
        _ if rate_limited => "API rate limit exceeded. (fake)",
        403 => "Resource not accessible by integration",
        409 => "Conflict",
        s if s >= 500 => "Server Error",
        _ => status.canonical_reason().unwrap_or("Error"),
    };
    let mut res = crate::api::error(status, message);
    let h = res.headers_mut();
    if let Some(secs) = f.retry_after {
        h.insert(header::RETRY_AFTER, HeaderValue::from(secs));
    }
    if rate_limited {
        let reset = crate::now() + f.retry_after.unwrap_or(0) as i64;
        h.insert("x-ratelimit-limit", HeaderValue::from(5000));
        h.insert("x-ratelimit-remaining", HeaderValue::from(0));
        h.insert("x-ratelimit-used", HeaderValue::from(5000));
        h.insert("x-ratelimit-reset", HeaderValue::from(reset));
        h.insert("x-ratelimit-resource", HeaderValue::from_static("core"));
    }
    res
}

/// The API listener: while the fake is down, new connections are dropped as soon as they're
/// accepted, so callers see a network error, as with an unreachable GitHub.
pub(crate) struct DownAware {
    inner: tokio::net::TcpListener,
    fake: Fake,
}

impl DownAware {
    pub fn new(inner: tokio::net::TcpListener, fake: Fake) -> DownAware {
        DownAware { inner, fake }
    }
}

impl axum::serve::Listener for DownAware {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (io, addr) = axum::serve::Listener::accept(&mut self.inner).await;
            if !self.fake.state().faults.is_down() {
                return (io, addr);
            }
            drop(io);
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}
