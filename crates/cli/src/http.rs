//! The CLI's calls to a beghu deployment. Every one says what it is (`User-Agent:
//! beghu-cli/<semver>`, `Beghu-Schema: <n>`), and the answers the CLI acts on wherever they come
//! become a [`Fail`]: `426` (older than the host's floor: [`Fail::TooOld`], which updates and
//! runs again), `409 cli_too_new` (newer than the host's build) and `401 bad_credential` (signed
//! out on the server: [`Fail::SignedOut`]).

use crate::Fail;
use serde::Deserialize;
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The git SHA this binary was built from (`BEGHU_BUILD_ID` at build time, as the image's `cli`
/// stage sets it), or `dev`.
pub const BUILD: &str = match option_env!("BEGHU_BUILD_ID") {
    Some(b) => b,
    None => "dev",
};

/// This machine's platform, as the host's builds are named: `linux-x86_64`, `macos-aarch64`, …
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// An error body, as beghu's run API and CLI routes answer one.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
    pub reason: Option<String>,
    pub report: Option<serde_json::Value>,
    pub minimum: Option<String>,
    pub server: Option<String>,
}

pub struct Api {
    http: reqwest::Client,
    pub host: String,
    token: Option<String>,
}

/// An answer from the host that isn't one of those every caller handles alike.
pub struct Answer {
    pub status: u16,
    pub bytes: Vec<u8>,
}

impl Answer {
    pub fn json<T: serde::de::DeserializeOwned>(&self, what: &str) -> Result<T, Fail> {
        serde_json::from_slice(&self.bytes).map_err(|e| {
            Fail::msg(format!(
                "{what}: the answer isn't what a beghu server sends ({e})"
            ))
        })
    }

    pub fn error(&self) -> ErrorBody {
        serde_json::from_slice(&self.bytes).unwrap_or_default()
    }

    /// The error's message, or the status when the body has none.
    pub fn why(&self) -> String {
        let e = self.error();
        if e.message.is_empty() {
            format!("the host answered {}", self.status)
        } else {
            e.message
        }
    }
}

impl Api {
    pub fn new(host: &str, token: Option<String>) -> Result<Api, Fail> {
        Api::build(host, token, reqwest::redirect::Policy::default())
    }

    /// An API that follows no redirect, for the update's downloads: the build comes from the host
    /// itself, never from wherever an answer points.
    pub fn without_redirects(host: &str) -> Result<Api, Fail> {
        Api::build(host, None, reqwest::redirect::Policy::none())
    }

    fn build(
        host: &str,
        token: Option<String>,
        redirects: reqwest::redirect::Policy,
    ) -> Result<Api, Fail> {
        let http = reqwest::Client::builder()
            .user_agent(format!("beghu-cli/{VERSION}"))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .redirect(redirects)
            .build()
            .map_err(|e| Fail::msg(format!("can't set up HTTPS: {}", chain(&e.without_url()))))?;
        Ok(Api {
            http,
            host: host.to_owned(),
            token,
        })
    }

    pub fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .request(method, format!("{}{path}", self.host))
            .header("beghu-schema", analysis::VERSION.to_string());
        if let Some(t) = &self.token {
            rb = rb.bearer_auth(t);
        }
        rb
    }

    /// Sends the request: its answer, unless it's one every call handles alike.
    pub async fn send(&self, rb: reqwest::RequestBuilder) -> Result<Answer, Fail> {
        let res = rb.send().await.map_err(|e| {
            Fail::msg(format!(
                "can't reach {}: {}",
                self.host,
                chain(&e.without_url())
            ))
        })?;
        let status = res.status().as_u16();
        let bytes = res
            .bytes()
            .await
            .map_err(|e| {
                Fail::msg(format!(
                    "{} stopped answering: {}",
                    self.host,
                    chain(&e.without_url())
                ))
            })?
            .to_vec();
        let a = Answer { status, bytes };
        let e = a.error();
        match (status, e.error.as_str()) {
            (426, _) => Err(Fail::TooOld {
                host: self.host.clone(),
                message: a.why(),
            }),
            (409, "cli_too_new") => Err(Fail::msg(format!(
                "{} (beghu {VERSION} here; {} serves {})",
                a.why(),
                self.host,
                e.server.as_deref().unwrap_or("an older one")
            ))),
            (401, "bad_credential") => Err(Fail::SignedOut {
                host: self.host.clone(),
            }),
            _ => Ok(a),
        }
    }

    pub async fn get(&self, path: &str) -> Result<Answer, Fail> {
        self.send(self.request(reqwest::Method::GET, path)).await
    }

    pub async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<Answer, Fail> {
        self.send(self.request(reqwest::Method::POST, path).json(body))
            .await
    }
}

/// An error with its causes, as one line: reqwest's own says little ("error sending request").
/// Give it a reqwest error `without_url()`: a run's URL holds its token, which is never printed.
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(&format!(": {s}"));
        src = s.source();
    }
    out
}

/// A host as given (`https://beghu.example.com`, `beghu.example.com`, with or without a
/// trailing slash) as the CLI keeps it: its origin. Plain `http` only for this machine (a dev
/// stack): a credential never crosses a network in the clear.
pub fn host(raw: &str) -> Result<String, Fail> {
    let raw = raw.trim().trim_end_matches('/');
    let full = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let (scheme, rest) = full.split_once("://").expect("has one");
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() || rest.len() != authority.len() {
        return Err(Fail::usage(format!(
            "{raw:?} isn't a beghu host: give its origin, like https://beghu.example.com"
        )));
    }
    let name = authority
        .rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit()))
        .map_or(authority, |(h, _)| h);
    let loopback = matches!(name, "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => Ok(full.to_ascii_lowercase()),
        "http" if loopback => Ok(full.to_ascii_lowercase()),
        "http" => Err(Fail::usage(format!(
            "{raw} is plain http: beghu sends its credential only over https (or to this machine)"
        ))),
        _ => Err(Fail::usage(format!("{raw:?} isn't an http(s) URL"))),
    }
}
