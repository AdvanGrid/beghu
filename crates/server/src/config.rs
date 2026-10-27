//! Configuration, from the environment only. Every secret also accepts `<NAME>_FILE`. A missing
//! or malformed value refuses startup and names the variable.

use base64::Engine as _;
use std::path::PathBuf;
use std::time::Duration;

pub use mirror_db::Config as MirrorsConfig;

pub struct Config {
    /// `BEGHU_BUILD_ID`: the git SHA in production.
    pub build_id: String,
    /// `BEGHU_PUBLIC_URL`: where browsers reach beghu. Sets the OAuth callback.
    pub public_url: String,
    /// `BEGHU_DATA_DIR`: the volume. Holds `control.db`, `backups/` and `mirrors/`.
    pub data_dir: PathBuf,
    /// `BEGHU_TOKEN_KEY`: the HKDF master key (base64, at least 32 bytes).
    pub token_key: Vec<u8>,
    pub github: GitHubConfig,
    /// `BEGHU_WEB_DIR`: the built web app (`index.html`, the shell template; `assets/`; and
    /// `.vite/manifest.json`, which names the chunks the shell preloads).
    /// Without it the server answers only `/api`, `/auth` and the probes, as in dev, where Vite
    /// serves the app.
    pub web_dir: Option<PathBuf>,
    pub mirrors: MirrorsConfig,
    /// How often a signed-in account's visible repos and roles are re-read from GitHub.
    pub repo_refresh_every: Duration,
    /// How long after a failed re-read of the roles the next is tried (a minute): long enough
    /// that a failing GitHub isn't asked on every request, short enough to recover soon.
    pub roles_retry_after_failure: Duration,
    /// `GITHUB_WEBHOOK_SECRET`: the App's webhook secret, which signs every delivery.
    pub webhook_secret: String,
    /// How often `/api/stream` sends a heartbeat (15 s): under the edge's idle timeout.
    pub stream_heartbeat: Duration,
    /// How long a processed webhook delivery's GUID is kept to dedupe redeliveries (4 days:
    /// GitHub's 3-day redelivery window with a day's margin); older ones are pruned.
    pub deliveries_kept_for: Duration,
    /// The waits between tries of a relationship read-back that GitHub fails (about 10 minutes
    /// in all). Past the last, the accounts syncing the issue's repo are marked `needs_resync`
    /// for a sweep to repair.
    pub read_back_retries: Vec<Duration>,
}

/// [`Config::read_back_retries`]: doubling from a second, then every minute, 15 tries in all.
pub fn default_read_back_retries() -> Vec<Duration> {
    [1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60, 60, 60, 60, 60]
        .into_iter()
        .map(Duration::from_secs)
        .collect()
}

pub struct GitHubConfig {
    /// `GITHUB_API_URL` (default `https://api.github.com`).
    pub api_url: String,
    /// `GITHUB_WEB_URL` (default `https://github.com`): the OAuth pages.
    pub web_url: String,
    /// `GITHUB_CLIENT_ID`.
    pub client_id: String,
    /// `GITHUB_CLIENT_SECRET`.
    pub client_secret: String,
    /// `GITHUB_APP_ID`: the App's id, the `iss` of the JWTs it signs.
    pub app_id: String,
    /// `GITHUB_APP_PRIVATE_KEY`: the App's private key (PEM, as GitHub hands it out), which signs
    /// those JWTs. The App trades them for installation tokens: imports, sweeps and webhook
    /// follow-up fetches use those.
    pub app_key: String,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let key = secret("BEGHU_TOKEN_KEY")?;
        let token_key = base64::engine::general_purpose::STANDARD
            .decode(key.trim())
            .ok()
            .filter(|k| k.len() >= 32)
            .ok_or("BEGHU_TOKEN_KEY must be at least 32 bytes, base64-encoded")?;
        let public_url = required("BEGHU_PUBLIC_URL")?;
        if !(public_url.starts_with("https://") || public_url.starts_with("http://")) {
            return Err(format!(
                "BEGHU_PUBLIC_URL must be an http(s) URL, got {public_url:?}"
            ));
        }
        // A key in an env var often has its newlines escaped.
        let app_key = secret("GITHUB_APP_PRIVATE_KEY")?.replace("\\n", "\n");
        let api_url = optional("GITHUB_API_URL", "https://api.github.com");
        if crate::installations::is_dev_key(&crate::installations::parse_key(&app_key)?)
            && !is_loopback(&api_url)
        {
            return Err(format!(
                "GITHUB_APP_PRIVATE_KEY is Fake GitHub's dev App key, which is public: it signs only for a Fake GitHub on this machine, and GITHUB_API_URL is {api_url}"
            ));
        }
        Ok(Config {
            build_id: std::env::var("BEGHU_BUILD_ID").unwrap_or_else(|_| "dev".into()),
            public_url: public_url.trim_end_matches('/').to_owned(),
            data_dir: PathBuf::from(required("BEGHU_DATA_DIR")?),
            token_key,
            github: GitHubConfig {
                api_url,
                web_url: optional("GITHUB_WEB_URL", "https://github.com"),
                client_id: required("GITHUB_CLIENT_ID")?,
                client_secret: secret("GITHUB_CLIENT_SECRET")?,
                app_id: required("GITHUB_APP_ID")?.trim().to_owned(),
                app_key,
            },
            web_dir: std::env::var("BEGHU_WEB_DIR").ok().map(PathBuf::from),
            mirrors: MirrorsConfig::from_env()?,
            repo_refresh_every: Duration::from_secs(15 * 60),
            roles_retry_after_failure: Duration::from_secs(60),
            webhook_secret: secret("GITHUB_WEBHOOK_SECRET")?,
            stream_heartbeat: Duration::from_secs(15),
            deliveries_kept_for: Duration::from_secs(4 * 24 * 60 * 60),
            read_back_retries: default_read_back_retries(),
        })
    }

    // `./dev-ctl reset --all` deletes `control.db` (with its `-wal` and `-shm`) and `backups/`
    // under BEGHU_DATA_DIR, and `reset` replaces `mirrors/`: keep these names in step with
    // tools/dev-ctl/src/main.ts.

    pub fn control_db(&self) -> PathBuf {
        self.data_dir.join("control.db")
    }

    /// Where the control DB's `VACUUM INTO` backups go.
    pub fn backups(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    pub fn mirrors_dir(&self) -> PathBuf {
        self.data_dir.join("mirrors")
    }
}

/// Whether `api_url` is on this machine (`localhost` or a loopback address), where Fake GitHub
/// runs in dev and tests: the only place the committed dev App key may sign for.
fn is_loopback(api_url: &str) -> bool {
    let rest = api_url.split_once("://").map_or(api_url, |(_, rest)| rest);
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        // `[::1]:3100`
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn required(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("{name} is required")),
    }
}

fn optional(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.into())
        .trim_end_matches('/')
        .to_owned()
}

/// `NAME`, or the contents of the file `NAME_FILE` names, trimmed. Empty either way is refused:
/// an empty key signs nothing (an empty HMAC key makes every webhook forgeable).
fn secret(name: &str) -> Result<String, String> {
    let Ok(path) = std::env::var(format!("{name}_FILE")) else {
        return required(name).map(|s| s.trim().to_owned());
    };
    let s = std::fs::read_to_string(&path)
        .map_err(|e| format!("{name}_FILE: can't read {path}: {e}"))?;
    match s.trim() {
        "" => Err(format!("{name}_FILE: {path} is empty")),
        s => Ok(s.to_owned()),
    }
}
