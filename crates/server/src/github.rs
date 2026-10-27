//! The GitHub calls beghu makes: with a user's token, the OAuth web flow's code exchange and
//! refresh, the user, the installations and repos the user can see with their `permissions`, and
//! the REST writes (`write`); with the App's JWT, `GET /app` and installation tokens; and GraphQL
//! queries with either kind of token. The import's reads (`graphql_data`, `rest`) say how they
//! failed in a [`CallError`] its retries act on. `GITHUB_API_URL` and `GITHUB_WEB_URL` point
//! these at GitHub or at Fake GitHub.
//!
//! Every call, whichever token it carries, also feeds the process-wide GitHub health flag: 3
//! network errors or 5xx answers in a row, on any call (a write's retries, an installation-token
//! mint and a background GraphQL read-back too), mark GitHub down, and while it's down
//! `GET /rate_limit` is probed every `probe_every` (10 s) until an answer comes. Any answer that
//! isn't a 5xx marks it up again.

use crate::config::GitHubConfig;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use ts_rs::TS;

/// How many network errors or 5xx answers in a row mark GitHub down.
const DOWN_AFTER: u32 = 3;
/// How many users a page of who can be assigned holds: GitHub's most.
pub const ASSIGNABLE_PAGE: usize = 100;

/// A page read again with its `ETag`.
#[derive(Debug)]
pub enum Revalidated<T> {
    /// GitHub answered 304: what the client holds is current. GitHub doesn't count it against
    /// the rate limit.
    NotModified,
    /// GitHub answered with the page, and its new `ETag` (if it sent one).
    Fresh { etag: Option<String>, page: T },
}

#[derive(Debug, Clone)]
pub enum Error {
    /// 401: the access token is expired or revoked.
    Unauthorized,
    /// A rate limit, lifted after this long: a 403 or 429 with `retry-after`, or with no
    /// requests left before `x-ratelimit-reset`, or else any 429 and a 403 that says it's the
    /// secondary rate limit (a minute, as GitHub's docs say).
    RateLimited(Duration),
    /// The token endpoint refused the code or the refresh token (`bad_verification_code`,
    /// `bad_refresh_token`, …). For a refresh this means the grant is gone: sign in again.
    Refused(String),
    /// Any other status.
    Status(u16),
    /// A label removal answered 404 "Label does not exist": the issue doesn't have the label (any
    /// other 404 is `Status(404)`: the issue or repo is out of sight). Observed, not documented
    /// (docs/research/contract-check-shapes.md).
    NoSuchLabel,
    /// No answer: the connection was reset or timed out, so GitHub may have acted on the request.
    Network(String),
    /// No connection: GitHub never saw the request.
    Unsent(String),
    /// An answer we couldn't read.
    Malformed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unauthorized => f.write_str("GitHub answered 401"),
            Error::RateLimited(d) => write!(f, "GitHub's rate limit, for {} s", d.as_secs()),
            Error::Refused(e) => write!(f, "GitHub refused the token request: {e}"),
            Error::Status(s) => write!(f, "GitHub answered {s}"),
            Error::NoSuchLabel => f.write_str("GitHub answered 404: Label does not exist"),
            Error::Network(e) => write!(f, "no answer from GitHub: {e}"),
            Error::Unsent(e) => write!(f, "can't reach GitHub: {e}"),
            Error::Malformed(e) => write!(f, "unreadable GitHub answer: {e}"),
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_decode() {
            Error::Malformed(e.to_string())
        } else if e.is_connect() {
            Error::Unsent(e.to_string())
        } else {
            Error::Network(e.to_string())
        }
    }
}

/// A user access token and its refresh token, as the token endpoint hands them out.
#[derive(Debug, Clone)]
pub struct TokenPair {
    pub access: String,
    /// Unix seconds.
    pub access_expires_at: i64,
    pub refresh: String,
    pub refresh_expires_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct User {
    pub id: i64,
    pub login: String,
}

/// A connected account's role on a repo: one of GitHub's five, lowest first. beghu's own rules
/// group Write and up (CONTEXT.md).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Role {
    Read,
    Triage,
    Write,
    Maintain,
    Admin,
}

impl Role {
    /// As GitHub's API and the mirror spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Read => "read",
            Role::Triage => "triage",
            Role::Write => "write",
            Role::Maintain => "maintain",
            Role::Admin => "admin",
        }
    }

    /// As GitHub's settings name it.
    pub fn name(self) -> &'static str {
        match self {
            Role::Read => "Read",
            Role::Triage => "Triage",
            Role::Write => "Write",
            Role::Maintain => "Maintain",
            Role::Admin => "Admin",
        }
    }

    /// A stored name; `None` for one this build doesn't know.
    pub fn parse(name: &str) -> Option<Role> {
        [
            Role::Read,
            Role::Triage,
            Role::Write,
            Role::Maintain,
            Role::Admin,
        ]
        .into_iter()
        .find(|r| r.as_str() == name)
    }
}

/// What the user may do on a repo, as GitHub answers for it now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Access {
    /// The user can't see the repo.
    None,
    /// GitHub's answer has no `permissions`: the role is unknown.
    Unknown,
    Role(Role),
}

/// A repo the user can see through an installation, and the user's role on it: `None` when
/// GitHub's answer doesn't say.
#[derive(Debug, Clone, PartialEq)]
pub struct VisibleRepo {
    pub id: i64,
    pub node_id: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    pub installation_id: i64,
    pub role: Option<Role>,
}

/// How a call the import makes failed: [`Error`] as the import's retries see it.
#[derive(Debug, Clone)]
pub enum CallError {
    /// GitHub's rate limit (primary or secondary): try again after this long.
    RateLimited(Duration),
    /// GitHub's secondary rate limit without a wait named: GitHub's advice is at least a minute,
    /// backing off exponentially while it lasts.
    SecondaryLimit,
    /// 401: the token is expired or revoked.
    Unauthorized,
    /// 404 (or 410): not there, or not visible to the token.
    NotFound,
    /// Any other status.
    Status(u16),
    /// No answer: refused, reset or timed out.
    Network(String),
    /// An answer that couldn't be read.
    Malformed(String),
    /// GraphQL answered errors and no data.
    GraphQl(String),
}

impl CallError {
    /// Whether the same call may well pass later: rate limits, 5xx and network failures. The
    /// import waits out a rate limit however long it lasts, but gives the others a budget.
    pub fn is_transient(&self) -> bool {
        match self {
            CallError::RateLimited(_) | CallError::SecondaryLimit | CallError::Network(_) => true,
            CallError::Status(s) => *s >= 500,
            _ => false,
        }
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::RateLimited(d) => write!(f, "rate limited for {} s", d.as_secs()),
            CallError::SecondaryLimit => f.write_str("GitHub's secondary rate limit"),
            CallError::Unauthorized => f.write_str("GitHub answered 401"),
            CallError::NotFound => f.write_str("GitHub answered 404"),
            CallError::Status(s) => write!(f, "GitHub answered {s}"),
            CallError::Network(e) => write!(f, "can't reach GitHub: {e}"),
            CallError::Malformed(e) => write!(f, "unreadable GitHub answer: {e}"),
            CallError::GraphQl(e) => write!(f, "GraphQL error: {e}"),
        }
    }
}

impl From<reqwest::Error> for CallError {
    fn from(e: reqwest::Error) -> Self {
        Error::from(e).into()
    }
}

impl From<Error> for CallError {
    fn from(e: Error) -> Self {
        match e {
            Error::Unauthorized => CallError::Unauthorized,
            Error::RateLimited(d) => CallError::RateLimited(d),
            Error::Status(404 | 410) | Error::NoSuchLabel => CallError::NotFound,
            Error::Status(s) => CallError::Status(s),
            Error::Network(e) | Error::Unsent(e) => CallError::Network(e),
            Error::Refused(e) | Error::Malformed(e) => CallError::Malformed(e),
        }
    }
}

#[derive(Clone)]
pub struct GitHub {
    http: reqwest::Client,
    api: String,
    web: String,
    client_id: String,
    client_secret: String,
    /// A write's own timeout (`github_write_timeout`).
    write_timeout: Duration,
    health: Arc<Health>,
}

/// Whether GitHub is answering, across the process.
struct Health {
    /// Network errors and 5xx answers in a row, among every call but the poller's.
    failures: AtomicU32,
    /// The events-feed poller's own streak: its failures in a row, which any answer of its (a
    /// 304 too) ends. Kept apart so its thousands of calls a day neither hide an outage a write
    /// is meeting nor add scattered 502s up into one.
    poller_failures: AtomicU32,
    /// True while GitHub is down.
    down: watch::Sender<bool>,
    probe_every: Duration,
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Installations {
    total_count: i64,
    installations: Vec<Installation>,
}

/// An installation of the App the user can reach.
#[derive(Deserialize, Debug)]
pub struct Installation {
    pub id: i64,
    /// Set while the installation is suspended: it still lists, but reads nothing.
    pub suspended_at: Option<String>,
}

#[derive(Deserialize)]
struct Repos {
    total_count: i64,
    repositories: Vec<Repo>,
}

#[derive(Deserialize)]
struct Repo {
    id: i64,
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner: Option<Owner>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    archived: bool,
    permissions: Option<Permissions>,
}

#[derive(Deserialize)]
struct Owner {
    login: String,
}

#[derive(Deserialize)]
struct Permissions {
    #[serde(default)]
    admin: bool,
    #[serde(default)]
    maintain: bool,
    #[serde(default)]
    push: bool,
    #[serde(default)]
    triage: bool,
}

impl Permissions {
    /// The highest of GitHub's five roles the flags grant.
    fn role(&self) -> Role {
        if self.admin {
            Role::Admin
        } else if self.maintain {
            Role::Maintain
        } else if self.push {
            Role::Write
        } else if self.triage {
            Role::Triage
        } else {
            Role::Read
        }
    }
}

/// How long to wait out a rate limit that doesn't say: GitHub's docs say at least a minute.
const UNSAID_RATE_LIMIT: Duration = Duration::from_secs(60);

/// What a non-2xx answer says, read once for [`Error`] and [`CallError`] alike.
enum Refusal {
    Unauthorized,
    /// A rate limit, lifted after the wait named; `None` when it names none.
    Limited(Option<Duration>),
    Status(u16),
}

/// The wait a rate-limited answer's headers name: `retry-after` if it's there; else, with no
/// requests left, until `x-ratelimit-reset`.
fn header_wait(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    let num = |name: &str| -> Option<i64> { h.get(name)?.to_str().ok()?.trim().parse().ok() };
    let secs = num("retry-after").or_else(|| {
        (num("x-ratelimit-remaining") == Some(0))
            .then(|| num("x-ratelimit-reset").map(|reset| reset - crate::now()))
            .flatten()
    })?;
    Some(Duration::from_secs(secs.max(0) as u64))
}

/// A non-2xx answer: 401, a rate limit, or the status. A rate limit, as GitHub documents it: a
/// 403 or 429 whose headers name a wait; else any 429, and a 403 whose body says it's the
/// secondary rate limit, with no wait named. Any other 403 is a refusal.
async fn read_refusal(res: reqwest::Response) -> Refusal {
    let status = res.status().as_u16();
    match status {
        401 => return Refusal::Unauthorized,
        403 | 429 => {}
        s => return Refusal::Status(s),
    }
    if let Some(wait) = header_wait(res.headers()) {
        return Refusal::Limited(Some(wait));
    }
    let secondary = status == 403 && res.text().await.is_ok_and(|t| says_secondary(&t));
    if status == 429 || secondary {
        Refusal::Limited(None)
    } else {
        Refusal::Status(status)
    }
}

/// The error for a non-2xx answer; a rate limit that names no wait lasts a minute, as GitHub's
/// docs say.
async fn refusal(res: reqwest::Response) -> Error {
    match read_refusal(res).await {
        Refusal::Unauthorized => Error::Unauthorized,
        Refusal::Limited(wait) => Error::RateLimited(wait.unwrap_or(UNSAID_RATE_LIMIT)),
        Refusal::Status(s) => Error::Status(s),
    }
}

/// The import's error for a non-2xx answer: a rate limit that names no wait is its own kind
/// (the import backs off from a minute up), and a named wait is at least a second and at most
/// an hour.
async fn call_error(res: reqwest::Response) -> CallError {
    match read_refusal(res).await {
        Refusal::Unauthorized => CallError::Unauthorized,
        Refusal::Limited(Some(w)) => {
            CallError::RateLimited(w.clamp(Duration::from_secs(1), Duration::from_secs(3600)))
        }
        Refusal::Limited(None) => CallError::SecondaryLimit,
        Refusal::Status(404 | 410) => CallError::NotFound,
        Refusal::Status(s) => CallError::Status(s),
    }
}

/// Whether a 403's body is GitHub's secondary rate limit: its message says so, or its
/// `documentation_url` points at the secondary rate limits.
fn says_secondary(body: &str) -> bool {
    let Ok(b) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_ascii_lowercase().contains("secondary rate limit");
    };
    let said = |field: &str, what: &str| {
        b[field]
            .as_str()
            .is_some_and(|v| v.to_ascii_lowercase().contains(what))
    };
    said("message", "secondary rate limit") || said("documentation_url", "secondary-rate-limits")
}

/// What GitHub shows the token of one issue (or of its thread).
pub enum Shown<T> {
    It(T),
    /// 301: transferred since, to an issue with another id and number, whose own webhooks bring
    /// it (redirects aren't followed).
    Moved,
    /// 404, or 410 for a deleted one: not there, or out of the token's sight.
    Gone,
}

fn shown<T>(read: Result<T, Error>) -> Result<Shown<T>, Error> {
    match read {
        Ok(it) => Ok(Shown::It(it)),
        Err(Error::Status(301)) => Ok(Shown::Moved),
        Err(Error::Status(404 | 410)) => Ok(Shown::Gone),
        Err(e) => Err(e),
    }
}

/// Far enough out to mean "doesn't expire" (an App with token expiry turned off).
const NEVER: i64 = i64::MAX / 2;

impl GitHub {
    /// `probe_every`: how often `/rate_limit` is tried while GitHub is down; `write_timeout`:
    /// how long a write waits for its answer.
    pub fn new(cfg: &GitHubConfig, probe_every: Duration, write_timeout: Duration) -> GitHub {
        let http = reqwest::Client::builder()
            .user_agent("beghu")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("a reqwest client with rustls");
        GitHub {
            http,
            api: cfg.api_url.trim_end_matches('/').to_owned(),
            web: cfg.web_url.trim_end_matches('/').to_owned(),
            client_id: cfg.client_id.clone(),
            client_secret: cfg.client_secret.clone(),
            write_timeout,
            health: Arc::new(Health {
                failures: AtomicU32::new(0),
                poller_failures: AtomicU32::new(0),
                down: watch::channel(false).0,
                probe_every,
            }),
        }
    }

    /// True while GitHub is down.
    pub fn is_down(&self) -> bool {
        *self.health.down.borrow()
    }

    /// GitHub's health as it changes: true while it's down.
    pub fn health(&self) -> watch::Receiver<bool> {
        self.health.down.subscribe()
    }

    /// Sends `req`, recording whether GitHub answered.
    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
        self.send_recording(req, true).await
    }

    /// Sends `req`, recording whether GitHub answered. A 304 is never an answer to the main
    /// streak: GitHub serves an unchanged ETag through outages that fail everything else, so it
    /// would hide them (owner's call: a real outage must show). The events-feed poller (not
    /// `answers`), whose reads run every couple of seconds, keeps a streak of its own (see
    /// [`Health::poller_failures`]): any answer of its ends it, and only `DOWN_AFTER` failures
    /// of its in a row mark GitHub down.
    async fn send_recording(
        &self,
        req: reqwest::RequestBuilder,
        answers: bool,
    ) -> Result<reqwest::Response, Error> {
        let sent = req.send().await;
        let failed = match &sent {
            Ok(res) => res.status().is_server_error(),
            Err(_) => true,
        };
        match (answers, failed) {
            (true, true) => self.failed(),
            (true, false) => {
                if sent
                    .as_ref()
                    .is_ok_and(|r| r.status() != reqwest::StatusCode::NOT_MODIFIED)
                {
                    self.answered();
                }
            }
            (false, true) => {
                let n = self.health.poller_failures.fetch_add(1, Ordering::Relaxed) + 1;
                if n >= DOWN_AFTER {
                    self.mark_down(n, "poller reads");
                }
            }
            (false, false) => self.health.poller_failures.store(0, Ordering::Relaxed),
        }
        sent.map_err(Into::into)
    }

    fn answered(&self) {
        self.health.failures.store(0, Ordering::Relaxed);
        if self
            .health
            .down
            .send_if_modified(|down| std::mem::replace(down, false))
        {
            self.health.poller_failures.store(0, Ordering::Relaxed);
            eprintln!("github: answering again");
        }
    }

    fn failed(&self) {
        let n = self.health.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if n >= DOWN_AFTER {
            self.mark_down(n, "calls");
        }
    }

    /// Marks GitHub down after `n` failed `what` in a row, and starts probing it.
    fn mark_down(&self, n: u32, what: &str) {
        if self
            .health
            .down
            .send_if_modified(|down| !std::mem::replace(down, true))
        {
            eprintln!("github: down after {n} failed {what} in a row; probing /rate_limit");
            let gh = self.clone();
            tokio::spawn(async move { gh.probe().await });
        }
    }

    /// While GitHub is down, tries `GET /rate_limit` every `probe_every`; the first answer marks
    /// it up (through `send`).
    async fn probe(&self) {
        loop {
            tokio::time::sleep(self.health.probe_every).await;
            if !self.is_down() {
                return;
            }
            let _ = self
                .send(
                    self.http
                        .get(format!("{}/rate_limit", self.api))
                        .header("accept", "application/vnd.github+json"),
                )
                .await;
        }
    }

    /// The authorize page, with PKCE and `state`. `login` suggests the account to sign in as.
    pub fn authorize_url(
        &self,
        redirect_uri: &str,
        state: &str,
        challenge: &str,
        login: Option<&str>,
    ) -> String {
        let mut q = vec![
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ];
        if let Some(login) = login {
            q.push(("login", login));
        }
        format!(
            "{}/login/oauth/authorize?{}",
            self.web,
            serde_urlencoded::to_string(q).unwrap_or_default()
        )
    }

    pub async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<TokenPair, Error> {
        self.token_request(&[
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .await
    }

    /// Trades a refresh token for a new pair. GitHub's refresh tokens are single-use.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenPair, Error> {
        self.token_request(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .await
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenPair, Error> {
        let mut all = vec![
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
        ];
        all.extend_from_slice(form);
        let res = self
            .send(
                self.http
                    .post(format!("{}/login/oauth/access_token", self.web))
                    .header("accept", "application/json")
                    .form(&all),
            )
            .await?;
        if !res.status().is_success() {
            return Err(Error::Status(res.status().as_u16()));
        }
        // GitHub answers token errors with 200 and an `error` field.
        let a: TokenAnswer = res.json().await?;
        if let Some(e) = a.error {
            return Err(Error::Refused(e));
        }
        let access = a
            .access_token
            .ok_or_else(|| Error::Malformed("no access_token".into()))?;
        let now = crate::now();
        Ok(TokenPair {
            access,
            access_expires_at: a.expires_in.map_or(NEVER, |s| now + s),
            refresh: a.refresh_token.unwrap_or_default(),
            refresh_expires_at: a.refresh_token_expires_in.map_or(NEVER, |s| now + s),
        })
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<T, Error> {
        let res = self
            .send(
                self.http
                    .get(format!("{}{path}", self.api))
                    .bearer_auth(token)
                    .header("accept", "application/vnd.github+json")
                    .header("x-github-api-version", "2022-11-28"),
            )
            .await?;
        match res.status().as_u16() {
            200 => Ok(res.json().await?),
            _ => Err(refusal(res).await),
        }
    }

    /// A REST write (`POST`, `PATCH`, …) to `path` with `body` (none when it's `null`): GitHub's
    /// answer on a 2xx.
    pub async fn write(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, Error> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .timeout(self.write_timeout);
        if !body.is_null() {
            req = req.json(body);
        }
        let res = self.send(req).await?;
        if res.status().is_success() {
            Ok(res.json().await?)
        } else if res.status() == reqwest::StatusCode::NOT_FOUND {
            #[derive(Deserialize)]
            struct Body {
                message: Option<String>,
            }
            let message = res.json::<Body>().await.ok().and_then(|b| b.message);
            Err(match message.as_deref() {
                Some("Label does not exist") => Error::NoSuchLabel,
                _ => Error::Status(404),
            })
        } else {
            Err(refusal(res).await)
        }
    }

    /// Page `page` (from 1) of who can be assigned to `owner/repo`'s issues
    /// (`GET /repos/{owner}/{repo}/assignees`, [`ASSIGNABLE_PAGE`] a page), by login; with `etag`,
    /// asked as `If-None-Match`, so an unchanged page is a free 304.
    pub async fn assignable_page(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        page: usize,
        etag: Option<&str>,
    ) -> Result<Revalidated<Vec<String>>, Error> {
        #[derive(Deserialize)]
        struct Assignee {
            login: String,
        }
        let mut req = self
            .http
            .get(format!(
                "{}/repos/{owner}/{repo}/assignees?per_page={ASSIGNABLE_PAGE}&page={page}",
                self.api
            ))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(etag) = etag {
            req = req.header("if-none-match", etag);
        }
        let res = self.send(req).await?;
        match res.status().as_u16() {
            304 => Ok(Revalidated::NotModified),
            200 => {
                let etag = res
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let got: Vec<Assignee> = res.json().await?;
                Ok(Revalidated::Fresh {
                    etag,
                    page: got.into_iter().map(|a| a.login).collect(),
                })
            }
            _ => Err(refusal(res).await),
        }
    }

    /// Issue `number` of `owner/repo` as GitHub has it now (`GET /repos/{o}/{r}/issues/{n}`),
    /// or why GitHub shows none to the token.
    pub async fn issue(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        number: i64,
    ) -> Result<Shown<crate::webhook::Issue>, Error> {
        shown(
            self.get(token, &format!("/repos/{owner}/{repo}/issues/{number}"))
                .await,
        )
    }

    /// Every comment on issue `number` of `owner/repo`, oldest first
    /// (`GET /repos/{o}/{r}/issues/{n}/comments`, paged by 100), or why GitHub shows none.
    pub async fn issue_comments(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        number: i64,
    ) -> Result<Shown<Vec<crate::import::shapes::RestComment>>, Error> {
        const PER_PAGE: usize = 100;
        let mut all = Vec::new();
        for page in 1.. {
            let path = format!(
                "/repos/{owner}/{repo}/issues/{number}/comments?per_page={PER_PAGE}&page={page}"
            );
            let got: Vec<crate::import::shapes::RestComment> =
                match shown(self.get(token, &path).await)? {
                    Shown::It(got) => got,
                    Shown::Moved => return Ok(Shown::Moved),
                    Shown::Gone => return Ok(Shown::Gone),
                };
            let n = got.len();
            all.extend(got);
            if n < PER_PAGE {
                break;
            }
        }
        Ok(Shown::It(all))
    }

    /// The user's role on `owner/repo`, from its `permissions`.
    pub async fn repo_access(&self, token: &str, owner: &str, repo: &str) -> Result<Access, Error> {
        match self
            .get::<Repo>(token, &format!("/repos/{owner}/{repo}"))
            .await
        {
            Ok(r) => Ok(r
                .permissions
                .map_or(Access::Unknown, |p| Access::Role(p.role()))),
            Err(Error::Status(404)) => Ok(Access::None),
            Err(e) => Err(e),
        }
    }

    /// Trades the App's JWT for a token for `installation` narrowed to `permissions` (GitHub's
    /// shape: `{"issues": "read"}`), and when it expires (Unix seconds).
    pub async fn installation_token(
        &self,
        jwt: &str,
        installation: i64,
        permissions: serde_json::Value,
    ) -> Result<(String, i64), Error> {
        #[derive(Deserialize)]
        struct Answer {
            token: String,
            expires_at: String,
        }
        let res = self
            .send(
                self.http
                    .post(format!(
                        "{}/app/installations/{installation}/access_tokens",
                        self.api
                    ))
                    .bearer_auth(jwt)
                    .header("accept", "application/vnd.github+json")
                    .header("x-github-api-version", "2022-11-28")
                    .json(&serde_json::json!({ "permissions": permissions })),
            )
            .await?;
        match res.status().as_u16() {
            201 | 200 => {
                let a: Answer = res.json().await?;
                let expires = crate::webhook::parse_time(&a.expires_at)
                    .ok_or_else(|| Error::Malformed(format!("expires_at {:?}", a.expires_at)))?;
                Ok((a.token, expires))
            }
            _ => Err(refusal(res).await),
        }
    }

    /// A GraphQL query, by operation name; its `data`. `node(id:)` for an id GitHub doesn't show
    /// the token (deleted, transferred, out of sight) answers `node: null` with a `NOT_FOUND`
    /// error on `["node"]` (docs/research/issue-edge-cases.md): that is `data` with a null
    /// `node`. Any other error from GitHub (a query it can't run) comes back as `Malformed`.
    pub async fn graphql<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        operation: &str,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<T, Error> {
        #[derive(Deserialize)]
        struct Answer<T> {
            data: Option<T>,
            #[serde(default)]
            errors: Vec<serde_json::Value>,
        }
        let res = self
            .send(
                self.http
                    .post(format!("{}/graphql", self.api))
                    .bearer_auth(token)
                    .json(&serde_json::json!({
                        "query": query, "variables": variables, "operationName": operation,
                    })),
            )
            .await?;
        match res.status().as_u16() {
            200 => {
                let a: Answer<serde_json::Value> = res.json().await?;
                let node_gone = a.data.as_ref().is_some_and(|d| d["node"].is_null());
                let errors: Vec<_> = a
                    .errors
                    .iter()
                    .filter(|e| {
                        !(node_gone
                            && e["type"] == "NOT_FOUND"
                            && e["path"] == serde_json::json!(["node"]))
                    })
                    .collect();
                match (a.data, errors.first()) {
                    (Some(d), None) => serde_json::from_value(d)
                        .map_err(|e| Error::Malformed(format!("GraphQL {operation}: {e}"))),
                    (_, Some(e)) => Err(Error::Malformed(format!("GraphQL {operation}: {e}"))),
                    (None, None) => Err(Error::Malformed(format!("GraphQL {operation}: no data"))),
                }
            }
            _ => Err(refusal(res).await),
        }
    }

    pub async fn user(&self, token: &str) -> Result<User, Error> {
        self.get(token, "/user").await
    }

    /// Every installation of the App the user can reach, suspended ones included, page by page.
    pub async fn user_installations(&self, token: &str) -> Result<Vec<Installation>, Error> {
        let mut out = Vec::new();
        for page in 1.. {
            let path = format!("/user/installations?per_page=100&page={page}");
            let got: Installations = self.get(token, &path).await?;
            let seen = got.installations.len();
            out.extend(got.installations);
            if seen == 0 || out.len() as i64 >= got.total_count {
                break;
            }
        }
        Ok(out)
    }

    /// Every repo the user can see through an installation of the App, with their role on it.
    /// A suspended installation reads nothing, so its repos aren't among them.
    pub async fn visible_repos(&self, token: &str) -> Result<Vec<VisibleRepo>, Error> {
        let installations = self.user_installations(token).await?;
        let mut out = Vec::new();
        for i in installations
            .into_iter()
            .filter(|i| i.suspended_at.is_none())
        {
            let mut page = 1;
            loop {
                let path = format!(
                    "/user/installations/{}/repositories?per_page=100&page={page}",
                    i.id
                );
                let r: Repos = self.get(token, &path).await?;
                let seen = r.repositories.len();
                out.extend(r.repositories.into_iter().map(|repo| VisibleRepo {
                    id: repo.id,
                    node_id: repo.node_id,
                    owner: repo.owner.map(|o| o.login).unwrap_or_default(),
                    name: repo.name,
                    private: repo.private,
                    archived: repo.archived,
                    installation_id: i.id,
                    role: repo.permissions.as_ref().map(Permissions::role),
                }));
                if seen == 0 || (page * 100) >= r.total_count {
                    break;
                }
                page += 1;
            }
        }
        Ok(out)
    }

    /// A request to the API with `auth` (a token or the App's JWT) and GitHub's headers.
    fn api(&self, method: reqwest::Method, path: &str, auth: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(auth)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
    }

    /// The App's install page by its slug, as GitHub serves it: where installing starts when
    /// `GET /app` can't say.
    pub fn install_page(&self, slug: &str) -> String {
        format!("{}/apps/{slug}/installations/new", self.web)
    }

    /// The App's `html_url` (`GET /app` with its JWT): its public page, where installing starts.
    pub async fn app_html_url(&self, jwt: &str) -> Result<String, Error> {
        #[derive(Deserialize)]
        struct AppInfo {
            html_url: String,
        }
        let res = self
            .send(self.api(reqwest::Method::GET, "/app", jwt))
            .await?;
        if !res.status().is_success() {
            return Err(refusal(res).await);
        }
        Ok(res.json::<AppInfo>().await?.html_url)
    }

    /// The import's GraphQL query: its `data`. Errors beside data (a node the token can't see)
    /// are left to the caller to notice as nulls; errors without data are a failure, and so is
    /// GraphQL's primary rate limit, which answers 200 with `RATE_LIMITED` and the quota's
    /// headers.
    pub async fn graphql_data(
        &self,
        token: &str,
        operation: &str,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<serde_json::Value, CallError> {
        Ok(self
            .graphql_quota(token, operation, query, variables)
            .await?
            .0)
    }

    /// [`graphql_data`](Self::graphql_data), with the quota the answer's headers state.
    pub async fn graphql_quota(
        &self,
        token: &str,
        operation: &str,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<(serde_json::Value, Option<Quota>), CallError> {
        let res =
            self.send(self.api(reqwest::Method::POST, "/graphql", token).json(
                &serde_json::json!({
                    "query": query,
                    "variables": variables,
                    "operationName": operation,
                }),
            ))
            .await?;
        if !res.status().is_success() {
            return Err(call_error(res).await);
        }
        let quota = Quota::of(res.headers());
        let wait = header_wait(res.headers());
        let mut body: serde_json::Value = res.json().await?;
        let errors = body["errors"].as_array().cloned().unwrap_or_default();
        if errors.iter().any(|e| e["type"] == "RATE_LIMITED") {
            return Err(wait.map_or(CallError::SecondaryLimit, |w| {
                CallError::RateLimited(w.max(Duration::from_secs(1)))
            }));
        }
        match body.get_mut("data").map(serde_json::Value::take) {
            Some(data) if !data.is_null() => Ok((data, quota)),
            _ => Err(CallError::GraphQl(
                errors
                    .first()
                    .and_then(|e| e["message"].as_str())
                    .unwrap_or("no data")
                    .to_owned(),
            )),
        }
    }

    /// The import's REST read (`path` with its query string): the JSON it answers.
    pub async fn rest(&self, token: &str, path: &str) -> Result<serde_json::Value, CallError> {
        match self.rest_if_changed(token, path, None).await?.0 {
            Fetched::Fresh { body, .. } => Ok(body),
            Fetched::NotModified => Err(CallError::Malformed("a 304 nobody asked for".into())),
        }
    }

    /// A sweep's REST read: conditional on `etag` (`If-None-Match`), so an unchanged answer is
    /// a 304 that costs nothing. With the quota the answer's headers state.
    pub async fn rest_if_changed(
        &self,
        token: &str,
        path: &str,
        etag: Option<&str>,
    ) -> Result<(Fetched, Option<Quota>), CallError> {
        let (fetched, quota, _) = self.conditional(token, path, etag, true).await?;
        Ok((fetched, quota))
    }

    /// The events-feed poller's read: as [`GitHub::rest_if_changed`], but recorded toward
    /// GitHub's health on the poller's own streak (see [`GitHub::send_recording`]), and with
    /// whether the `Link` header names a next page.
    pub async fn poll_if_changed(
        &self,
        token: &str,
        path: &str,
        etag: Option<&str>,
    ) -> Result<(Fetched, Option<Quota>, bool), CallError> {
        self.conditional(token, path, etag, false).await
    }

    async fn conditional(
        &self,
        token: &str,
        path: &str,
        etag: Option<&str>,
        answers: bool,
    ) -> Result<(Fetched, Option<Quota>, bool), CallError> {
        let mut req = self.api(reqwest::Method::GET, path, token);
        if let Some(tag) = etag {
            req = req.header("if-none-match", tag);
        }
        let res = self.send_recording(req, answers).await?;
        let quota = Quota::of(res.headers());
        if res.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok((Fetched::NotModified, quota, false));
        }
        if !res.status().is_success() {
            return Err(call_error(res).await);
        }
        let header = |name: &str| {
            res.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let etag = header("etag");
        let more =
            header("link").is_some_and(|l| l.split(',').any(|part| part.contains("rel=\"next\"")));
        let body = res.json().await?;
        Ok((Fetched::Fresh { body, etag }, quota, more))
    }

    /// The token's primary rate limits, core and GraphQL (`GET /rate_limit`, which costs
    /// nothing).
    pub async fn rate_limit(&self, token: &str) -> Result<(Quota, Quota), CallError> {
        #[derive(Deserialize)]
        struct Limit {
            limit: i64,
            remaining: i64,
            reset: i64,
        }
        #[derive(Deserialize)]
        struct Resources {
            core: Limit,
            graphql: Limit,
        }
        #[derive(Deserialize)]
        struct Answer {
            resources: Resources,
        }
        let res = self
            .send(self.api(reqwest::Method::GET, "/rate_limit", token))
            .await?;
        if !res.status().is_success() {
            return Err(call_error(res).await);
        }
        let a: Answer = res.json().await?;
        let q = |l: Limit| Quota {
            limit: l.limit,
            remaining: l.remaining,
            reset: l.reset,
        };
        Ok((q(a.resources.core), q(a.resources.graphql)))
    }

    /// A page of the App's webhook deliveries, newest first (`GET /app/hook/deliveries`, with
    /// its JWT), and the cursor of the next page, if any.
    pub async fn hook_deliveries(
        &self,
        jwt: &str,
        cursor: Option<&str>,
    ) -> Result<(Vec<HookDelivery>, Option<String>), Error> {
        let mut path = "/app/hook/deliveries?per_page=100".to_owned();
        if let Some(c) = cursor {
            path.push('&');
            path.push_str(&serde_urlencoded::to_string([("cursor", c)]).unwrap_or_default());
        }
        let res = self
            .send(self.api(reqwest::Method::GET, &path, jwt))
            .await?;
        if !res.status().is_success() {
            return Err(refusal(res).await);
        }
        // GitHub pages by cursor through the `Link` header's `next`.
        let next = res
            .headers()
            .get("link")
            .and_then(|v| v.to_str().ok())
            .and_then(next_cursor);
        Ok((res.json().await?, next))
    }

    /// Asks GitHub to send a delivery again (`POST /app/hook/deliveries/{id}/attempts`).
    pub async fn redeliver(&self, jwt: &str, id: i64) -> Result<(), Error> {
        let path = format!("/app/hook/deliveries/{id}/attempts");
        let res = self
            .send(self.api(reqwest::Method::POST, &path, jwt))
            .await?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(refusal(res).await)
        }
    }
}

/// An answer to a conditional read.
pub enum Fetched {
    /// Changed, or asked unconditionally: the body, and the ETag to ask with next time.
    Fresh {
        body: serde_json::Value,
        etag: Option<String>,
    },
    /// 304: unchanged since the ETag asked with.
    NotModified,
}

/// A primary rate limit as GitHub reports it: of `limit`, `remaining` left until `reset` (Unix
/// seconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quota {
    pub limit: i64,
    pub remaining: i64,
    pub reset: i64,
}

impl Quota {
    /// From an answer's `x-ratelimit-*` headers, if it has them.
    fn of(h: &reqwest::header::HeaderMap) -> Option<Quota> {
        let num = |name: &str| -> Option<i64> { h.get(name)?.to_str().ok()?.trim().parse().ok() };
        Some(Quota {
            limit: num("x-ratelimit-limit")?,
            remaining: num("x-ratelimit-remaining")?,
            reset: num("x-ratelimit-reset")?,
        })
    }

    /// Below a fifth of the limit: sweeps wait for the reset (webhook follow-ups don't).
    pub fn low(&self) -> bool {
        self.remaining * 5 < self.limit
    }
}

/// One attempt at delivering a webhook, as `GET /app/hook/deliveries` lists it.
#[derive(Debug, Clone, Deserialize)]
pub struct HookDelivery {
    pub id: i64,
    pub guid: String,
    pub delivered_at: String,
    /// "OK" for a delivery the App answered with a 2xx; anything else failed.
    pub status: String,
    pub installation_id: Option<i64>,
}

/// The `cursor` of a `Link` header's `rel="next"` URL.
fn next_cursor(link: &str) -> Option<String> {
    link.split(',')
        .find(|part| part.contains("rel=\"next\""))
        .and_then(|part| part.split(['<', '>']).nth(1))
        .and_then(|url| url.split_once('?'))
        .and_then(|(_, q)| serde_urlencoded::from_str::<Vec<(String, String)>>(q).ok())
        .and_then(|pairs| {
            pairs
                .into_iter()
                .find(|(k, _)| k == "cursor")
                .map(|(_, v)| v)
        })
}
