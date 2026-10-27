//! GitHub's primary rate limit and conditional requests, on every call made with a token
//! (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`,
//! `/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests`):
//!
//! - Each token's owner (an installation, or a user) has an hour's quota per resource: `core` for
//!   REST, `graphql` for `POST /graphql`, 5,000 each. Every answer carries `x-ratelimit-limit`,
//!   `-remaining`, `-used`, `-reset` and `-resource`. A call with none left gets GitHub's primary
//!   rate limit (REST: 403 with the quota at 0; GraphQL: 200 with a `RATE_LIMITED` error).
//! - A successful GET answers with a weak `ETag` over its body. Sent back in `If-None-Match`,
//!   an unchanged answer is a 304 with no body, which costs nothing.
//! - A GraphQL query costs what GitHub's documented formula says (`graphql.rs`'s [`cost`]):
//!   docs/research/github-app-mechanics.md §1 and mirror-import-and-reconciliation.md §1.
//!
//! [`cost`]: crate::graphql::cost
//! - `GET /rate_limit` costs nothing, and answers the caller's quota (or a fresh one, without a
//!   token).
//!
//! The control port's `PUT /quota {remaining}` is a fault: every owner's quota reads as at most
//! `remaining` left, as if other clients had spent the rest (`null` lifts it). The OAuth web flow
//! and the App's JWT calls (`/app…`) are outside these quotas.

use crate::Fake;
use crate::api::Token;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sha2::Digest as _;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// GitHub's hourly quota for an installation or a user, per resource.
pub const LIMIT: i64 = 5000;
const WINDOW: i64 = 3600;

#[derive(Default)]
pub(crate) struct Quotas(Mutex<Inner>);

/// What a call spends: REST's quota, or GraphQL's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Resource {
    Core,
    Graphql,
}

impl Resource {
    /// As GitHub names it in `x-ratelimit-resource` and `/rate_limit`.
    pub fn name(self) -> &'static str {
        match self {
            Resource::Core => "core",
            Resource::Graphql => "graphql",
        }
    }

    fn of(path: &str) -> Resource {
        if path == "/graphql" {
            Resource::Graphql
        } else {
            Resource::Core
        }
    }
}

/// What a GraphQL answer cost, by GitHub's formula: set by the handler, spent here.
#[derive(Clone, Copy)]
pub(crate) struct Cost(pub i64);

#[derive(Default)]
struct Inner {
    /// `(owner, resource)` → used and when the window resets.
    used: BTreeMap<(String, Resource), (i64, i64)>,
    /// The fault: at most this many left, for every owner.
    cap: Option<i64>,
}

/// One owner's quota for one resource, as GitHub reports it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub(crate) struct Quota {
    pub limit: i64,
    pub used: i64,
    pub remaining: i64,
    pub reset: i64,
}

impl Quotas {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// `owner`'s quota for `resource` at `now`, after spending `spend` points of it.
    fn take(&self, owner: &str, resource: Resource, now: i64, spend: i64) -> Quota {
        self.with(|q| {
            let w = q
                .used
                .entry((owner.to_owned(), resource))
                .or_insert((0, now + WINDOW));
            if w.1 <= now {
                *w = (0, now + WINDOW);
            }
            w.0 += spend;
            let (used, reset) = *w;
            let mut remaining = (LIMIT - used).max(0);
            if let Some(cap) = q.cap {
                remaining = remaining.min(cap.max(0));
            }
            Quota {
                limit: LIMIT,
                used: LIMIT - remaining,
                remaining,
                reset,
            }
        })
    }

    /// The quota `owner` would see now, without spending any.
    pub fn peek(&self, owner: &str, resource: Resource, now: i64) -> Quota {
        self.take(owner, resource, now, 0)
    }

    pub fn set_cap(&self, cap: Option<i64>) {
        self.with(|q| q.cap = cap);
    }

    pub fn clear(&self) {
        self.with(|q| *q = Inner::default());
    }

    /// Every owner's use so far, for `/state`.
    pub fn snapshot(&self) -> serde_json::Value {
        self.with(|q| {
            let used: serde_json::Map<String, serde_json::Value> = q
                .used
                .iter()
                .map(|((owner, res), (used, _))| {
                    (format!("{owner} {}", res.name()), (*used).into())
                })
                .collect();
            serde_json::json!({ "cap": q.cap, "used": used })
        })
    }
}

/// Who a token's calls count against: `installation:<id>` or `user:<id>`.
pub(crate) async fn owner(fake: &Fake, headers: &HeaderMap) -> Option<String> {
    let token = crate::api::bearer(headers)?;
    // An App's JWT (three dot-separated parts) has a limit of its own, not modelled.
    if token.matches('.').count() == 2 {
        return None;
    }
    let now = fake.now();
    let found = fake
        .state()
        .truth
        .read(move |c| {
            Ok(if token.starts_with("ghs_") {
                fake_db::q::installation_token(c, &token, now)?.map(Token::Installation)
            } else {
                fake_db::q::access_token_user(c, &token, now)?.map(Token::User)
            })
        })
        .await
        .ok()
        .flatten()?;
    Some(match found {
        Token::Installation(i) => format!("installation:{i}"),
        Token::User(u) => format!("user:{u}"),
    })
}

fn headers(h: &mut HeaderMap, q: Quota, resource: Resource) {
    h.insert("x-ratelimit-limit", HeaderValue::from(q.limit));
    h.insert("x-ratelimit-remaining", HeaderValue::from(q.remaining));
    h.insert("x-ratelimit-used", HeaderValue::from(q.used));
    h.insert("x-ratelimit-reset", HeaderValue::from(q.reset));
    h.insert(
        "x-ratelimit-resource",
        HeaderValue::from_static(resource.name()),
    );
}

/// A weak ETag over `body`, as GitHub sends them on lists.
fn etag(body: &[u8]) -> String {
    let d = sha2::Sha256::digest(body);
    let hex: String = d.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("W/\"{hex}\"")
}

/// Whether `If-None-Match` names `tag` (weak comparison: `W/` is ignored on both sides).
fn matches(headers: &HeaderMap, tag: &str) -> bool {
    let bare = |t: &str| t.trim().trim_start_matches("W/").to_owned();
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim() == "*" || bare(t) == bare(tag))
        })
}

pub(crate) async fn middleware(State(fake): State<Fake>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let outside = path == "/rate_limit" || path.starts_with("/login/") || path.starts_with("/app");
    let owner = if outside {
        None
    } else {
        owner(&fake, req.headers()).await
    };
    let Some(owner) = owner else {
        return next.run(req).await;
    };
    let resource = Resource::of(&path);
    let quotas = &fake.state().quotas;
    let now = fake.now();
    let before = quotas.peek(&owner, resource, now);
    if before.remaining == 0 {
        // GitHub names the owner: "installation ID 41000001", "user ID 1".
        let who = owner.replace(':', " ID ");
        let mut res = match resource {
            Resource::Graphql => axum::Json(serde_json::json!({
                "errors": [{
                    "type": "RATE_LIMITED",
                    "message": format!("API rate limit already exceeded for {who}."),
                }],
            }))
            .into_response(),
            Resource::Core => crate::api::error_documented(
                StatusCode::FORBIDDEN,
                &format!("API rate limit exceeded for {who}."),
                "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
            ),
        };
        headers(res.headers_mut(), before, resource);
        return res;
    }
    let get = req.method() == Method::GET;
    let asked = req.headers().clone();
    let res = next.run(req).await;
    // A GraphQL query costs what its handler worked out; any other call, one.
    let spend = res.extensions().get::<Cost>().map_or(1, |c| c.0);
    if !(get && res.status() == StatusCode::OK) {
        let q = quotas.take(&owner, resource, now, spend);
        let mut res = res;
        headers(res.headers_mut(), q, resource);
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return crate::api::internal("reading an answer to tag");
    };
    let tag = etag(&bytes);
    let mut res = if matches(&asked, &tag) {
        // Unchanged: nothing sent, nothing spent.
        let mut r = StatusCode::NOT_MODIFIED.into_response();
        r.headers_mut()
            .insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex"));
        let q = quotas.peek(&owner, resource, now);
        headers(r.headers_mut(), q, resource);
        fake.state()
            .not_modified
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return r;
    } else {
        parts.headers.remove(header::CONTENT_LENGTH);
        Response::from_parts(parts, bytes.into())
    };
    res.headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex"));
    let q = quotas.take(&owner, resource, now, spend);
    headers(res.headers_mut(), q, resource);
    res
}
