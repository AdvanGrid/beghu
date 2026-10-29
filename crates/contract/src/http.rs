//! The check's HTTP: GitHub's REST and GraphQL with a token, the App's JWT calls, and the OAuth
//! token endpoint. Every call is logged to stderr with its status.

use serde_json::Value;
use std::time::Duration;

/// An answer: its status, its body as JSON (null when empty or not JSON), and the headers the
/// check reads.
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub etag: Option<String>,
    /// The `Link` header's `next` URL.
    pub next: Option<String>,
}

#[derive(Clone)]
pub struct Http {
    client: reqwest::Client,
    /// GitHub's API origin: `https://api.github.com`, or a Fake GitHub's.
    pub api: String,
    /// GitHub's web origin, for the OAuth token endpoint: `https://github.com`, or the fake's.
    pub web: String,
}

/// A request beyond its method and path.
#[derive(Default)]
pub struct Extra<'a> {
    pub body: Option<&'a Value>,
    pub accept: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}

impl Http {
    pub fn new(api: &str, web: &str) -> Http {
        Http {
            client: reqwest::Client::builder()
                .user_agent("beghu-contract-check")
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("a reqwest client with rustls"),
            api: api.trim_end_matches('/').to_owned(),
            web: web.trim_end_matches('/').to_owned(),
        }
    }

    /// `method path` on the API with `token` (none: no `Authorization`). `path` may also be a
    /// whole URL (a `Link` header's).
    pub async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        extra: Extra<'_>,
    ) -> Result<Answer, String> {
        let url = if path.starts_with("http") {
            path.to_owned()
        } else {
            format!("{}{path}", self.api)
        };
        let mut req = self
            .client
            .request(method.clone(), &url)
            .header(
                "accept",
                extra.accept.unwrap_or("application/vnd.github+json"),
            )
            .header("x-github-api-version", "2022-11-28");
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = extra.body {
            req = req.json(b);
        }
        if let Some(e) = extra.if_none_match {
            req = req.header("if-none-match", e);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("{method} {path}: {e}"))?;
        let status = res.status().as_u16();
        let header = |n: &str| {
            res.headers()
                .get(n)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let etag = header("etag");
        let next = header("link").and_then(|l| next_link(&l));
        let text = res
            .text()
            .await
            .map_err(|e| format!("{method} {path}: {e}"))?;
        eprintln!("contract: {method} {} -> {status}", strip_query(path));
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok(Answer {
            status,
            body,
            etag,
            next,
        })
    }

    pub async fn get(&self, path: &str, token: &str) -> Result<Answer, String> {
        self.call(reqwest::Method::GET, path, Some(token), Extra::default())
            .await
    }

    /// A GraphQL document with its variables.
    pub async fn graphql(&self, token: &str, query: &str, vars: Value) -> Result<Answer, String> {
        let body = serde_json::json!({ "query": query, "variables": vars });
        self.call(
            reqwest::Method::POST,
            "/graphql",
            Some(token),
            Extra {
                body: Some(&body),
                ..Extra::default()
            },
        )
        .await
    }

    /// `POST {web}/login/oauth/access_token` with `form`, as an App's token exchange sends it.
    pub async fn oauth_token(&self, form: &[(&str, &str)]) -> Result<Answer, String> {
        let url = format!("{}/login/oauth/access_token", self.web);
        let body = serde_urlencoded::to_string(form).map_err(|e| e.to_string())?;
        let res = self
            .client
            .post(&url)
            .header("accept", "application/json")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("POST /login/oauth/access_token: {e}"))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        eprintln!("contract: POST /login/oauth/access_token -> {status}");
        Ok(Answer {
            status,
            body: serde_json::from_str(&text).unwrap_or(Value::Null),
            etag: None,
            next: None,
        })
    }

    /// Fake GitHub only: signs `login` in through the fake's authorize page (its `login=`
    /// skips the account picker) and trades the code for a user access token.
    pub async fn fake_sign_in(
        &self,
        login: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<String, String> {
        let callback = "http://contract.invalid/callback";
        let query = serde_urlencoded::to_string([
            ("client_id", client_id),
            ("redirect_uri", callback),
            ("state", "contract"),
            ("login", login),
        ])
        .map_err(|e| e.to_string())?;
        let url = format!("{}/login/oauth/authorize?{query}", self.web);
        let res = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("authorize: {e}"))?;
        let to = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("authorize answered {} without a redirect", res.status()))?;
        let code = to
            .split_once("code=")
            .map(|(_, c)| c.split('&').next().unwrap_or(c).to_owned())
            .ok_or_else(|| format!("no code in {to}"))?;
        let a = self
            .oauth_token(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("code", &code),
                ("redirect_uri", callback),
            ])
            .await?;
        a.body["access_token"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("no access token: {}", a.body))
    }
}

/// `rel="next"` of a `Link` header.
fn next_link(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        rel.contains("rel=\"next\"").then(|| {
            url.trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .to_owned()
        })
    })
}

fn strip_query(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}
