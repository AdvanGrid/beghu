//! Fetching upstream for the attachment route, the image proxy and the probes, with their limits
//! ([`MediaConfig`]): a connect timeout, a wait for the first byte, a wait between chunks, a cap
//! on the bytes (refused up front when `Content-Length` is over it, otherwise cut there), and for
//! the proxy a total time. Bytes stream through and are never stored.

use super::guard::{self, Blocked};
use crate::config::MediaConfig;
use axum::body::Body;
use axum::body::Bytes;
use futures_util::StreamExt as _;
use reqwest::Url;
use reqwest::header::{HeaderMap, LOCATION};
use std::sync::Arc;
use tokio::time::Instant;

/// How many redirects the image proxy follows, each hop checked by the guard.
const REDIRECTS: usize = 4;

/// Why a fetch failed: each answers with its own status (`routes.rs`), and the probes keep a
/// lasting one as an image's `unavailable` reason. (Size and type are judged on the answer.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The guard refused a hop.
    Blocked,
    /// Past a wait: connecting, the first byte, between chunks, or in all.
    Timeout,
    /// More redirects than [`REDIRECTS`], or one with no usable `Location`.
    Redirects,
    /// No answer.
    Unreachable(String),
}

impl Failure {
    /// The reason an image is known in advance not to load, for a failure that will last.
    pub fn lasting(&self) -> Option<&'static str> {
        match self {
            Failure::Blocked => Some("blocked"),
            _ => None,
        }
    }
}

fn failure(e: reqwest::Error) -> Failure {
    if guard::is_blocked(&e) {
        Failure::Blocked
    } else if e.is_timeout() {
        Failure::Timeout
    } else {
        Failure::Unreachable(e.without_url().to_string())
    }
}

/// The two HTTP clients: the guarded one for anything a post names, and a plain one for GitHub's
/// minted attachment URLs, whose host the config fixes.
#[derive(Clone)]
pub struct Fetcher {
    guarded: reqwest::Client,
    plain: reqwest::Client,
    pub cfg: Arc<MediaConfig>,
}

impl Fetcher {
    pub fn new(cfg: MediaConfig) -> Fetcher {
        let build = |guarded: bool| {
            let b = reqwest::Client::builder()
                .user_agent("beghu")
                .connect_timeout(cfg.connect)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy();
            let b = if guarded {
                b.dns_resolver(Arc::new(guard::Resolver))
            } else {
                b
            };
            b.build().expect("a reqwest client with rustls")
        };
        Fetcher {
            guarded: build(true),
            plain: build(false),
            cfg: Arc::new(cfg),
        }
    }

    /// A GET of a URL a post named, through the guard, following up to [`REDIRECTS`] redirects
    /// with the guard on every hop; the answer once its headers are in. `by` bounds it all.
    pub async fn guarded(
        &self,
        url: Url,
        headers: HeaderMap,
        by: Instant,
    ) -> Result<reqwest::Response, Failure> {
        let mut url = url;
        for _ in 0..=REDIRECTS {
            guard::check(&url, &self.cfg.dev_image_hosts).map_err(|Blocked(_)| Failure::Blocked)?;
            let req = self.guarded.get(url.clone()).headers(headers.clone());
            let res = self.first_byte(req, by).await?;
            if !res.status().is_redirection() || res.status().as_u16() == 304 {
                return Ok(res);
            }
            let next = res
                .headers()
                .get(LOCATION)
                .and_then(|l| l.to_str().ok())
                .and_then(|l| url.join(l).ok())
                .ok_or(Failure::Redirects)?;
            url = next;
        }
        Err(Failure::Redirects)
    }

    /// A GET of a minted attachment URL: no redirects followed.
    pub async fn minted(&self, url: Url, headers: HeaderMap) -> Result<reqwest::Response, Failure> {
        let req = self.plain.get(url).headers(headers);
        self.first_byte(req, Instant::now() + self.cfg.first_byte)
            .await
    }

    /// Sends `req` and waits for the answer's headers: [`MediaConfig::first_byte`] at most, and
    /// never past `by`.
    async fn first_byte(
        &self,
        req: reqwest::RequestBuilder,
        by: Instant,
    ) -> Result<reqwest::Response, Failure> {
        let until = by.min(Instant::now() + self.cfg.first_byte);
        match tokio::time::timeout_at(until, req.send()).await {
            Err(_) => Err(Failure::Timeout),
            Ok(Err(e)) => Err(failure(e)),
            Ok(Ok(res)) => Ok(res),
        }
    }

    /// Up to `n` bytes of `res`'s body, waiting [`MediaConfig::idle`] at most between chunks and
    /// never past `by`.
    pub async fn head_bytes(
        &self,
        res: reqwest::Response,
        n: usize,
        by: Instant,
    ) -> Result<Vec<u8>, Failure> {
        let mut out = Vec::new();
        let mut body = res.bytes_stream();
        while out.len() < n {
            let until = by.min(Instant::now() + self.cfg.idle);
            match tokio::time::timeout_at(until, body.next()).await {
                Err(_) => return Err(Failure::Timeout),
                Ok(None) => break,
                Ok(Some(Err(e))) => return Err(failure(e)),
                Ok(Some(Ok(chunk))) => {
                    out.extend_from_slice(&chunk[..chunk.len().min(n - out.len())])
                }
            }
        }
        Ok(out)
    }

    /// `res`'s body streamed through: at most `cap` bytes, [`MediaConfig::idle`] at most between
    /// chunks, and never past `by` (if given). Past any of them the stream fails, so the
    /// browser's response ends short rather than looking whole. `hold` is kept until the stream
    /// ends: the session's turn.
    pub fn stream<H: Send + 'static>(
        &self,
        res: reqwest::Response,
        cap: u64,
        by: Option<Instant>,
        hold: H,
    ) -> Body {
        let idle = self.cfg.idle;
        struct State<H> {
            body: futures_util::stream::BoxStream<'static, reqwest::Result<Bytes>>,
            sent: u64,
            over: bool,
            done: bool,
            _hold: H,
        }
        let state = State {
            body: res.bytes_stream().boxed(),
            sent: 0,
            over: false,
            done: false,
            _hold: hold,
        };
        let s = futures_util::stream::unfold(state, move |mut st| async move {
            if st.done {
                return None;
            }
            if st.over {
                st.done = true;
                return Some((Err(cut("over the cap")), st));
            }
            let until = Instant::now() + idle;
            let until = by.map_or(until, |b| b.min(until));
            let next = match tokio::time::timeout_at(until, st.body.next()).await {
                Err(_) => Err(cut("timed out")),
                Ok(None) => return None,
                Ok(Some(Err(e))) => Err(cut(&e.without_url().to_string())),
                Ok(Some(Ok(chunk))) => {
                    let room = cap - st.sent;
                    if chunk.len() as u64 > room {
                        // What fits goes out; the next poll fails the stream.
                        st.sent = cap;
                        st.over = true;
                        Ok(chunk.slice(..room as usize))
                    } else {
                        st.sent += chunk.len() as u64;
                        Ok(chunk)
                    }
                }
            };
            st.done = next.is_err();
            Some((next, st))
        });
        Body::from_stream(s)
    }
}

fn cut(why: &str) -> std::io::Error {
    std::io::Error::other(format!("upstream cut short: {why}"))
}
