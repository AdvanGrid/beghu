//! The GitHub calls beghu makes: with a user's token, the OAuth web flow's code exchange and
//! refresh, the user, and the installations and repos the user can see with their `permissions`;
//! with the App's JWT, installation tokens; and GraphQL queries with either kind of token.
//! `GITHUB_API_URL` and `GITHUB_WEB_URL` point these at GitHub or at Fake GitHub.

use crate::config::GitHubConfig;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum Error {
    /// 401: the access token is expired or revoked.
    Unauthorized,
    /// The token endpoint refused the code or the refresh token (`bad_verification_code`,
    /// `bad_refresh_token`, …). For a refresh this means the grant is gone: sign in again.
    Refused(String),
    /// Any other status.
    Status(u16),
    /// No answer: connection refused, reset or timed out.
    Network(String),
    /// An answer we couldn't read.
    Malformed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unauthorized => f.write_str("GitHub answered 401"),
            Error::Refused(e) => write!(f, "GitHub refused the token request: {e}"),
            Error::Status(s) => write!(f, "GitHub answered {s}"),
            Error::Network(e) => write!(f, "can't reach GitHub: {e}"),
            Error::Malformed(e) => write!(f, "unreadable GitHub answer: {e}"),
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_decode() {
            Error::Malformed(e.to_string())
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

/// A repo the user can see through an installation, and the user's role on it.
#[derive(Debug, Clone, PartialEq)]
pub struct VisibleRepo {
    pub id: i64,
    pub role: &'static str,
}

#[derive(Clone)]
pub struct GitHub {
    http: reqwest::Client,
    api: String,
    web: String,
    client_id: String,
    client_secret: String,
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
    installations: Vec<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: i64,
}

#[derive(Deserialize)]
struct Repos {
    total_count: i64,
    repositories: Vec<Repo>,
}

#[derive(Deserialize)]
struct Repo {
    id: i64,
    permissions: Option<Permissions>,
}

#[derive(Deserialize, Default)]
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
    fn role(&self) -> &'static str {
        if self.admin {
            "admin"
        } else if self.maintain {
            "maintain"
        } else if self.push {
            "write"
        } else if self.triage {
            "triage"
        } else {
            "read"
        }
    }
}

/// Far enough out to mean "doesn't expire" (an App with token expiry turned off).
const NEVER: i64 = i64::MAX / 2;

impl GitHub {
    pub fn new(cfg: &GitHubConfig) -> GitHub {
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
            .http
            .post(format!("{}/login/oauth/access_token", self.web))
            .header("accept", "application/json")
            .form(&all)
            .send()
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
            .http
            .get(format!("{}{path}", self.api))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await?;
        match res.status().as_u16() {
            200 => Ok(res.json().await?),
            401 => Err(Error::Unauthorized),
            s => Err(Error::Status(s)),
        }
    }

    /// Trades the App's JWT for a token for `installation`, and when it expires (Unix seconds).
    /// An installation token narrowed to `permissions` (GitHub's shape: `{"issues": "read"}`),
    /// and when it expires (Unix seconds).
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
            .http
            .post(format!(
                "{}/app/installations/{installation}/access_tokens",
                self.api
            ))
            .bearer_auth(jwt)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .json(&serde_json::json!({ "permissions": permissions }))
            .send()
            .await?;
        match res.status().as_u16() {
            201 | 200 => {
                let a: Answer = res.json().await?;
                let expires = crate::webhook::parse_time(&a.expires_at)
                    .ok_or_else(|| Error::Malformed(format!("expires_at {:?}", a.expires_at)))?;
                Ok((a.token, expires))
            }
            401 => Err(Error::Unauthorized),
            s => Err(Error::Status(s)),
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
            .http
            .post(format!("{}/graphql", self.api))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "query": query, "variables": variables, "operationName": operation,
            }))
            .send()
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
            401 => Err(Error::Unauthorized),
            s => Err(Error::Status(s)),
        }
    }

    pub async fn user(&self, token: &str) -> Result<User, Error> {
        self.get(token, "/user").await
    }

    /// Every repo the user can see through an installation of the App, with their role on it.
    pub async fn visible_repos(&self, token: &str) -> Result<Vec<VisibleRepo>, Error> {
        let inst: Installations = self.get(token, "/user/installations?per_page=100").await?;
        let mut out = Vec::new();
        for i in inst.installations {
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
                    role: repo.permissions.unwrap_or_default().role(),
                }));
                if seen == 0 || (page * 100) >= r.total_count {
                    break;
                }
                page += 1;
            }
        }
        Ok(out)
    }
}
