//! The App's own credentials: a JWT signed with its private key (RS256), traded for an
//! installation token per installation. Installation tokens serve the work no user asked for:
//! webhook follow-up fetches here, and later the import and the sweeps. Each is asked for with
//! only the permissions that work needs: reading issues. GitHub's last an hour; one is reused
//! until 5 minutes before it expires, and concurrent callers share one request for a new one,
//! and its answer, a refusal included. At most [`READS_PER_INSTALLATION`] read-backs run at once
//! against one installation.

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

/// The App's private key from its PEM; why not, if it isn't one ring can sign with.
pub fn parse_key(pem: &str) -> Result<KeyPair, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .map(str::trim)
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "GITHUB_APP_PRIVATE_KEY isn't a PEM key".to_owned())?;
    // GitHub hands out PKCS#1 keys; a key converted to PKCS#8 works too.
    KeyPair::from_der(&der)
        .or_else(|_| KeyPair::from_pkcs8(&der))
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

/// An installation's last failed token request and when it failed; none since one succeeded.
type LastFailure = Option<(Instant, github::Error)>;

pub struct Installations {
    gh: GitHub,
    app_id: String,
    key: KeyPair,
    /// Each installation's token and when it expires (Unix seconds).
    tokens: Mutex<HashMap<i64, (String, i64)>>,
    /// Held while a token for the installation is requested, so callers that find none wait for
    /// that one instead of each requesting their own. It holds the last request's failure and
    /// when it came, for the callers that waited on that request.
    minting: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<LastFailure>>>>,
    /// Each installation's read-backs running at once, at most [`READS_PER_INSTALLATION`].
    reads: Mutex<HashMap<i64, Arc<Semaphore>>>,
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
        }))
    }

    /// The App's JWT, good for 9 minutes.
    fn jwt(&self) -> Result<String, github::Error> {
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

    /// A live token for `installation`: the one held, or a new one. A caller that waited on
    /// another's request for one gets that request's answer, a failure included.
    pub async fn token(&self, installation: i64) -> Result<String, github::Error> {
        if let Some(t) = self.held(installation) {
            return Ok(t);
        }
        let asked = Instant::now();
        let slot = self
            .minting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(installation)
            .or_default()
            .clone();
        let mut last_failure = slot.lock().await;
        // Another caller may have minted one while this one waited.
        if let Some(t) = self.held(installation) {
            return Ok(t);
        }
        // Or failed to: GitHub's answer then holds for this caller too.
        if let Some((at, e)) = &*last_failure
            && *at >= asked
        {
            return Err(e.clone());
        }
        let minted = self.mint(installation).await;
        *last_failure = minted.as_ref().err().map(|e| (Instant::now(), e.clone()));
        minted
    }

    /// Requests a new token for `installation` and holds it.
    async fn mint(&self, installation: i64) -> Result<String, github::Error> {
        let (token, expires) = self
            .gh
            .installation_token(
                &self.jwt()?,
                installation,
                serde_json::json!({ "issues": "read" }),
            )
            .await?;
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(installation, (token.clone(), expires));
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

    /// The token held for `installation`, if it has more than [`MARGIN`] left.
    fn held(&self, installation: i64) -> Option<String> {
        let now = crate::now();
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&installation)
            .filter(|(_, expires)| *expires - now > MARGIN)
            .map(|(t, _)| t.clone())
    }

    /// Forgets `installation`'s token: GitHub refused it.
    pub fn forget(&self, installation: i64) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&installation);
    }

    pub fn github(&self) -> &GitHub {
        &self.gh
    }
}
