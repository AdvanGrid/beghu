//! Runtime faults on the GitHub side: latency per endpoint (for every call, or the next N), the
//! next N calls failing with a chosen status or dropping the connection unanswered, the next N
//! answers carrying a rewritten `body` (or cut short), and down. Set through the control port; a
//! reset clears them.
//!
//! A failing call never reaches the endpoint: GitHub didn't act on it. A rewrite does: GitHub
//! acted, and its answer differs from what was asked (payload drift, or GitHub keeping a text in
//! a form of its own).
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
//!
//! A fail rule can be one of GitHub's rate limits ([`Limit`]), in the documented shape: the
//! primary limit (403/429 with the quota at 0), the secondary limit (403/429 saying so, with
//! `retry-after` only when given), or GraphQL's primary limit (200 with a `RATE_LIMITED` error).

use crate::Fake;
use crate::writes::CoreLimit;
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
    pub rewrite: Vec<Rewrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Latency {
    pub endpoint: String,
    pub ms: u64,
    /// How many more calls it delays; none: every call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Fail {
    pub endpoint: String,
    pub remaining: u32,
    /// What the call gets: an answer with this status, or with `reset`, none at all.
    pub status: Option<u16>,
    /// Seconds, sent as `retry-after` (and, for a primary rate limit, as its reset).
    pub retry_after: Option<u64>,
    /// Which of GitHub's rate limits the failure is, if one.
    pub limit: Option<Limit>,
    /// The connection is dropped before any answer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
}

/// GitHub's rate limits, each in its documented shape
/// (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`,
/// `/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Limit {
    /// 403 or 429, `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (`retry_after` seconds
    /// out, a minute without), and `retry-after` when given.
    Primary,
    /// 403 or 429 saying "You have exceeded a secondary rate limit", with its
    /// `documentation_url`, primary quota left as `/rate_limit` says, and `retry-after` only
    /// when given: without it, GitHub's advice is to wait at least a minute.
    Secondary,
    /// GraphQL's primary limit: 200, no data, an error of type `RATE_LIMITED`, and the primary
    /// headers as above.
    Graphql,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Rewrite {
    pub endpoint: String,
    pub remaining: u32,
    #[serde(flatten)]
    pub to: RewriteTo,
}

/// What a rewritten answer carries.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RewriteTo {
    /// What the answer's `body` field says instead.
    Body(String),
    /// The whole body instead, sent complete under the answer's own status: an answer beghu
    /// can't read, such as text that isn't JSON.
    Raw(String),
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

    /// Removes every latency, fail and rewrite rule for `endpoint` (normalised), leaving the rest.
    pub fn clear_endpoint(&self, endpoint: &str) {
        self.with(|r| {
            r.latency.retain(|l| l.endpoint != endpoint);
            r.fail.retain(|f| f.endpoint != endpoint);
            r.rewrite.retain(|w| w.endpoint != endpoint);
        });
    }

    pub fn is_down(&self) -> bool {
        self.with(|r| r.down)
    }

    pub fn set_down(&self, down: bool) {
        self.with(|r| r.down = down);
    }

    /// Sets the latency for `endpoint`, for every call or the next `count`, replacing any
    /// earlier rule for it; 0 removes it.
    pub fn set_latency(&self, endpoint: String, ms: u64, count: Option<u32>) {
        self.with(|r| {
            r.latency.retain(|l| l.endpoint != endpoint);
            if ms > 0 {
                r.latency.push(Latency {
                    endpoint,
                    ms,
                    remaining: count,
                });
            }
        });
    }

    pub fn add_rewrite(&self, rewrite: Rewrite) {
        self.with(|r| r.rewrite.push(rewrite));
    }

    pub fn add_fail(&self, fail: Fail) {
        self.with(|r| r.fail.push(fail));
    }

    /// What happens to one call: the delay before it, how it fails, if it does, and otherwise
    /// how its answer is rewritten, if it is. Uses up one call of every matching
    /// counted latency rule, and of the first matching fail rule or else rewrite rule.
    fn on_call(&self, method: &Method, path: &str) -> (Duration, Option<Fail>, Option<RewriteTo>) {
        self.with(|r| {
            let mut delay = 0;
            for l in r
                .latency
                .iter_mut()
                .filter(|l| matches(&l.endpoint, method, path))
            {
                delay = delay.max(l.ms);
                if let Some(n) = &mut l.remaining {
                    *n -= 1;
                }
            }
            r.latency.retain(|l| l.remaining != Some(0));
            let fail = r
                .fail
                .iter_mut()
                .find(|f| matches(&f.endpoint, method, path))
                .map(|f| {
                    f.remaining -= 1;
                    f.clone()
                });
            r.fail.retain(|f| f.remaining > 0);
            let rewrite = match fail {
                Some(_) => None,
                None => r
                    .rewrite
                    .iter_mut()
                    .find(|w| matches(&w.endpoint, method, path))
                    .map(|w| {
                        w.remaining -= 1;
                        w.to.clone()
                    }),
            };
            r.rewrite.retain(|w| w.remaining > 0);
            (Duration::from_millis(delay), fail, rewrite)
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
    let (delay, fail, rewrite) = faults.on_call(req.method(), req.uri().path());
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    match (fail, rewrite) {
        (Some(f), _) if f.reset => dropped(),
        (Some(f), _) => {
            let who = match f.limit {
                Some(Limit::Graphql) => caller(&fake, req.headers()).await,
                _ => None,
            };
            failure(&f, fake.now(), who.as_deref())
        }
        (None, Some(RewriteTo::Body(body))) => rewritten(next.run(req).await, body).await,
        (None, Some(RewriteTo::Raw(raw))) => {
            let (parts, _) = next.run(req).await.into_parts();
            let mut res = Response::from_parts(parts, raw.into());
            res.headers_mut().remove(header::CONTENT_LENGTH);
            res
        }
        (None, None) => next.run(req).await,
    }
}

/// No answer: the connection is closed before a status line goes out. (A response body that
/// fails at once makes hyper drop the connection with the head still unsent.)
fn dropped() -> Response {
    let body = futures_util::stream::once(async {
        Err::<axum::body::Bytes, _>(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset (fake)",
        ))
    });
    axum::body::Body::from_stream(body).into_response()
}

/// `res` with its JSON `body` field set to `body`.
async fn rewritten(res: Response, body: String) -> Response {
    let (mut parts, b) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(b, usize::MAX).await else {
        return crate::api::internal("reading an answer to rewrite");
    };
    let mut v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Response::from_parts(parts, bytes.into()),
    };
    if let Some(o) = v.as_object_mut() {
        o.insert("body".into(), body.into());
    }
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, axum::Json(v).into_response().into_body())
}

/// The `documentation_url` GitHub sends with a secondary rate limit.
const SECONDARY_DOCS: &str = "https://docs.github.com/free-pro-team@latest/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits";

/// Whose quota GraphQL's rate limit names: the installation behind a `ghs_` token
/// (`installation ID …`), or the user behind an access token (`user ID …`).
async fn caller(fake: &Fake, headers: &axum::http::HeaderMap) -> Option<String> {
    let token = crate::api::bearer(headers)?;
    let now = fake.now();
    fake.state()
        .truth
        .read(move |c| {
            Ok(if token.starts_with("ghs_") {
                fake_db::q::installation_token(c, &token, now)?
                    .map(|i| format!("installation ID {i}"))
            } else {
                fake_db::q::access_token_user(c, &token, now)?.map(|u| format!("user ID {u}"))
            })
        })
        .await
        .ok()
        .flatten()
}

/// The response GitHub gives for `f`, at `now` on the fake's clock. `who` is whose quota a
/// GraphQL rate limit names.
fn failure(f: &Fail, now: i64, who: Option<&str>) -> Response {
    let code = f.status.unwrap_or(500);
    let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    // A 403 or 429 with a wait and no named limit is the primary one, as before limits had names.
    let limit = f.limit.or_else(|| {
        (matches!(code, 403 | 429) && f.retry_after.is_some()).then_some(Limit::Primary)
    });
    let mut res = match limit {
        Some(Limit::Graphql) => axum::Json(serde_json::json!({
            "errors": [{
                "type": "RATE_LIMITED",
                "message": match who {
                    Some(w) => format!("API rate limit already exceeded for {w}."),
                    None => "API rate limit already exceeded.".to_owned(),
                },
            }],
        }))
        .into_response(),
        // GitHub's documented message for a secondary rate limit.
        Some(Limit::Secondary) => crate::api::error_documented(
            status,
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID (fake).",
            SECONDARY_DOCS,
        ),
        Some(Limit::Primary) => crate::api::error(status, "API rate limit exceeded. (fake)"),
        None => {
            let message = match code {
                401 => "Bad credentials",
                403 => "Resource not accessible by integration",
                409 => "Conflict",
                s if s >= 500 => "Server Error",
                _ => status.canonical_reason().unwrap_or("Error"),
            };
            crate::api::error(status, message)
        }
    };
    let h = res.headers_mut();
    if let Some(secs) = f.retry_after {
        h.insert(header::RETRY_AFTER, HeaderValue::from(secs));
    }
    let resource = if limit == Some(Limit::Graphql) {
        "graphql"
    } else {
        "core"
    };
    let core = CoreLimit::at(now);
    match limit {
        Some(Limit::Primary | Limit::Graphql) => {
            // The primary limit ran out, and resets after `retry_after` (a minute without).
            let reset = now + f.retry_after.unwrap_or(60) as i64;
            h.insert("x-ratelimit-limit", HeaderValue::from(core.limit));
            h.insert("x-ratelimit-remaining", HeaderValue::from(0));
            h.insert("x-ratelimit-used", HeaderValue::from(core.limit));
            h.insert("x-ratelimit-reset", HeaderValue::from(reset));
            h.insert("x-ratelimit-resource", HeaderValue::from_static(resource));
        }
        Some(Limit::Secondary) => {
            // The primary limit isn't what ran out: it stands as `/rate_limit` says.
            h.insert("x-ratelimit-limit", HeaderValue::from(core.limit));
            h.insert("x-ratelimit-remaining", HeaderValue::from(core.remaining()));
            h.insert("x-ratelimit-used", HeaderValue::from(core.used));
            h.insert("x-ratelimit-reset", HeaderValue::from(core.reset));
            h.insert("x-ratelimit-resource", HeaderValue::from_static(resource));
        }
        None => {}
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
