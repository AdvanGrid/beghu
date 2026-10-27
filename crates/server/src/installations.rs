//! The App's own credentials: a JWT signed with its private key (RS256), read once for the App's
//! install page (`GET /app`), used for its webhook deliveries (the redelivery job), and traded
//! for installation tokens. Installation tokens serve the work no user asked for: the import,
//! webhook follow-up read-backs, and the sweeps. Each
//! is asked for with only the permissions its work needs ([`Scope`]), so an installation has at
//! most one token per scope. GitHub's last an hour; one is reused until 5 minutes before it
//! expires, and concurrent callers share one request for a new one, and its answer, a refusal
//! included. A token GitHub refuses (401) is dropped, so the next caller mints another. At most
//! [`READS_PER_INSTALLATION`] read-backs run at once against one installation.

use crate::config::GitHubConfig;
use crate::github::{self, GitHub};
use base64::Engine as _;
use ring::rsa::KeyPair;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Fetch a new token when less than this many seconds are left.
const MARGIN: i64 = 300;
/// GitHub allows a JWT at most 10 minutes; back-dating `iat` a minute covers clock drift.
const JWT_BACKDATE: i64 = 60;
const JWT_LIFETIME: i64 = 540;
/// How many read-backs may run against one installation at once; the rest queue.
pub const READS_PER_INSTALLATION: usize = 4;

/// What a token is for, and so the permissions it's narrowed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    /// Webhook follow-up read-backs of an issue (a PR among them) and its relationships: issues
    /// and PRs. GitHub may refuse `GET /issues/{n}` for a PR to a token with issues alone (to
    /// verify on the dev App, #118), and the App holds `pull_requests: read` anyway.
    ReadBack,
    /// The import and the sweeps: issues, and PRs with their details. Metadata (the repo
    /// itself) GitHub grants every token; it's named so the token says what they read.
    Import,
}

impl Scope {
    /// The permissions, in GitHub's shape.
    fn permissions(self) -> serde_json::Value {
        match self {
            Scope::ReadBack => serde_json::json!({ "issues": "read", "pull_requests": "read" }),
            Scope::Import => serde_json::json!({
                "issues": "read",
                "metadata": "read",
                "pull_requests": "read",
            }),
        }
    }
}

/// The App's private key from its PEM; why not, if it isn't one ring can sign with. A PKCS#1
/// PEM (`RSA PRIVATE KEY`, as GitHub hands App keys out) or a PKCS#8 one (`PRIVATE KEY`). A PEM
/// passed through an environment variable with its newlines escaped (`\n`) reads too.
pub fn parse_key(pem: &str) -> Result<KeyPair, String> {
    let pem = pem.trim().replace("\\n", "\n");
    let label = pem
        .strip_prefix("-----BEGIN ")
        .and_then(|r| r.split_once("-----"))
        .map(|(l, _)| l.to_owned())
        .ok_or("GITHUB_APP_PRIVATE_KEY isn't a PEM: no -----BEGIN line")?;
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .map(str::trim)
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "GITHUB_APP_PRIVATE_KEY isn't a PEM key".to_owned())?;
    match label.as_str() {
        "RSA PRIVATE KEY" => KeyPair::from_der(&der),
        "PRIVATE KEY" => KeyPair::from_pkcs8(&der),
        other => {
            return Err(format!(
                "GITHUB_APP_PRIVATE_KEY is a {other} PEM, not an RSA private key"
            ));
        }
    }
    .map_err(|e| format!("GITHUB_APP_PRIVATE_KEY isn't an RSA private key: {e}"))
}

/// SHA-256 of Fake GitHub's dev App public key (PKCS#1 DER), committed in
/// `crates/fake-github/src/dev-app-key.pem`. Anyone can read that key, so it must never sign
/// for real GitHub.
const DEV_APP_PUBLIC_KEY_SHA256: &str =
    "2da4ba67e46fd2a5e266d38f6062d19b998d5bad7753ba720ee9ac20e3bbab5b";

/// Whether `key` is Fake GitHub's committed dev App key.
pub fn is_dev_key(key: &KeyPair) -> bool {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(key.public().as_ref());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex == DEV_APP_PUBLIC_KEY_SHA256
}

/// A token's last failed request and when it failed; none since one succeeded.
type LastFailure = Option<(Instant, github::Error)>;

/// Which token: an installation's, in a scope.
type Key = (i64, Scope);

/// The App as GitHub describes it, read once.
#[derive(Clone, Debug)]
pub struct AppInfo {
    /// Where installing the App starts: `<html_url>/installations/new`.
    pub install_url: String,
}

pub struct Installations {
    gh: GitHub,
    app_id: String,
    key: KeyPair,
    /// Each installation's token per scope and when it expires (Unix seconds).
    tokens: Mutex<HashMap<Key, (String, i64)>>,
    /// Held while a token for the installation and scope is requested, so callers that find
    /// none wait for that one instead of each requesting their own. It holds the last request's
    /// failure and when it came, for the callers that waited on that request.
    minting: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<LastFailure>>>>,
    /// Each installation's read-backs running at once, at most [`READS_PER_INSTALLATION`].
    reads: Mutex<HashMap<i64, Arc<Semaphore>>>,
    info: Mutex<Option<AppInfo>>,
}

impl Installations {
    /// Reads the App's key from the config; why not, if it can't be used.
    pub fn new(gh: GitHub, cfg: &GitHubConfig) -> Result<Arc<Installations>, String> {
        Ok(Arc::new(Installations {
            gh,
            app_id: cfg.app_id.clone(),
            key: parse_key(&cfg.app_key)?,
            tokens: Mutex::default(),
            minting: Mutex::default(),
            reads: Mutex::default(),
            info: Mutex::default(),
        }))
    }

    /// The App's JWT, good for 9 minutes.
    pub fn jwt(&self) -> Result<String, github::Error> {
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let now = crate::now();
        let claims = serde_json::json!({
            "iat": now - JWT_BACKDATE,
            "exp": now + JWT_LIFETIME,
            "iss": self.app_id,
        });
        let msg = format!(
            "{}.{}",
            b64.encode(br#"{"alg":"RS256","typ":"JWT"}"#),
            b64.encode(claims.to_string())
        );
        let mut sig = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                msg.as_bytes(),
                &mut sig,
            )
            .map_err(|_| github::Error::Malformed("signing the App's JWT failed".into()))?;
        Ok(format!("{msg}.{}", b64.encode(sig)))
    }

    /// A live token for `installation` in `scope`: the one held, or a new one. A caller that
    /// waited on another's request for one gets that request's answer, a failure included.
    pub async fn token(&self, installation: i64, scope: Scope) -> Result<String, github::Error> {
        let key = (installation, scope);
        if let Some(t) = self.held(key) {
            return Ok(t);
        }
        let asked = Instant::now();
        let slot = self
            .minting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key)
            .or_default()
            .clone();
        let mut last_failure = slot.lock().await;
        // Another caller may have minted one while this one waited.
        if let Some(t) = self.held(key) {
            return Ok(t);
        }
        // Or failed to: GitHub's answer then holds for this caller too.
        if let Some((at, e)) = &*last_failure
            && *at >= asked
        {
            return Err(e.clone());
        }
        let minted = self.mint(key).await;
        *last_failure = minted.as_ref().err().map(|e| (Instant::now(), e.clone()));
        minted
    }

    /// Requests a new token for `key` and holds it.
    async fn mint(&self, key: Key) -> Result<String, github::Error> {
        let (installation, scope) = key;
        let (token, expires) = self
            .gh
            .installation_token(&self.jwt()?, installation, scope.permissions())
            .await?;
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (token.clone(), expires));
        Ok(token)
    }

    /// A turn to read from `installation`: waits while [`READS_PER_INSTALLATION`] others run.
    pub async fn read_turn(&self, installation: i64) -> OwnedSemaphorePermit {
        let reads = self
            .reads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(installation)
            .or_insert_with(|| Arc::new(Semaphore::new(READS_PER_INSTALLATION)))
            .clone();
        reads
            .acquire_owned()
            .await
            .expect("the semaphore is never closed")
    }

    /// The token held for `key`, if it has more than [`MARGIN`] left.
    fn held(&self, key: Key) -> Option<String> {
        let now = crate::now();
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .filter(|(_, expires)| *expires - now > MARGIN)
            .map(|(t, _)| t.clone())
    }

    /// GitHub refused `token` (401), held for `installation` in `scope`: the next caller mints
    /// another. A newer token minted meanwhile stays.
    pub fn drop_token(&self, installation: i64, scope: Scope, token: &str) {
        let mut held = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if held
            .get(&(installation, scope))
            .is_some_and(|(t, _)| t == token)
        {
            held.remove(&(installation, scope));
        }
    }

    /// Where installing the App starts: as GitHub says (`GET /app`), or, when GitHub can't be
    /// asked, the install page of the App's configured `slug`. `None` with neither.
    pub async fn install_url(&self, slug: Option<&str>) -> Option<String> {
        match self.info().await {
            Ok(i) => Some(i.install_url),
            Err(e) => {
                eprintln!("reading the App's install URL: {e}");
                slug.map(|s| self.gh.install_page(s))
            }
        }
    }

    /// The App as GitHub describes it, read from GitHub the first time.
    pub async fn info(&self) -> Result<AppInfo, github::Error> {
        if let Some(i) = self.info.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(i);
        }
        let html_url = self.gh.app_html_url(&self.jwt()?).await?;
        let info = AppInfo {
            install_url: format!("{}/installations/new", html_url.trim_end_matches('/')),
        };
        *self.info.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.clone());
        Ok(info)
    }

    pub fn github(&self) -> &GitHub {
        &self.gh
    }
}
