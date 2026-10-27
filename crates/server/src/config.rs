//! Configuration, from the environment only. Every secret also accepts `<NAME>_FILE`. A missing
//! or malformed value refuses startup and names the variable.

use base64::Engine as _;
use std::path::PathBuf;
use std::time::Duration;

pub use mirror_db::Config as MirrorsConfig;

pub struct Config {
    /// `BEGHU_BUILD_ID`: the git SHA in production.
    pub build_id: String,
    /// `BEGHU_PUBLIC_URL`: where browsers reach beghu, kept as its origin (scheme, host and a
    /// port other than the scheme's own, in lower case), as browsers send it in `Origin`. Sets
    /// the OAuth callback.
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
    /// How old the account's repos must be before the App's setup URL re-reads them (a minute).
    /// Any site can send a browser there, so this bounds what it can make beghu ask GitHub; a
    /// user back from installing sooner sees the new repos when the installation's webhook lands.
    pub setup_reread_after: Duration,
    /// How long after a repo's import fails (GitHub refusing a call for good) it's tried again (a
    /// minute), doubling with each failure in a row up to six hours.
    pub import_retry_after: Duration,
    /// How long one of the import's calls keeps retrying a 5xx or an unanswered call (five
    /// minutes, or ten tries, whichever comes first) before its repo's import fails for the
    /// round. A rate limit is waited out however long it lasts.
    pub import_give_up_after: Duration,
    /// `GITHUB_WEBHOOK_SECRET`: the App's webhook secret, which signs every delivery.
    pub webhook_secret: String,
    /// How often `/api/stream` sends a heartbeat (15 s): under the edge's idle timeout.
    pub stream_heartbeat: Duration,
    /// How long a processed webhook delivery's GUID is kept to dedupe redeliveries (4 days:
    /// GitHub's 3-day redelivery window with a day's margin); older ones are pruned.
    pub deliveries_kept_for: Duration,
    /// While GitHub is down, how often `GET /rate_limit` is tried to see whether it's back (10 s).
    pub github_probe_every: Duration,
    /// How long a write waits for GitHub's answer (30 s): longer than a read, so a slow GitHub
    /// shows as "still sending…" in the tab rather than as a failure.
    pub github_write_timeout: Duration,
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
    /// `GITHUB_APP_PRIVATE_KEY`: the App's private key (PEM, as GitHub hands it out: PKCS#1, or
    /// PKCS#8), which signs those JWTs. The App trades them for installation tokens: the import,
    /// sweeps and webhook follow-up fetches use those.
    pub app_key: String,
    /// `GITHUB_APP_SLUG` (optional): the App's URL name (`github.com/apps/<slug>`). Where
    /// installing starts when GitHub can't be asked (`GET /app` failing).
    pub app_slug: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let key = secret("BEGHU_TOKEN_KEY")?;
        let token_key = base64::engine::general_purpose::STANDARD
            .decode(key.trim())
            .ok()
            .filter(|k| k.len() >= 32)
            .ok_or("BEGHU_TOKEN_KEY must be at least 32 bytes, base64-encoded")?;
        let public_url = public_origin(&required("BEGHU_PUBLIC_URL")?)?;
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
            public_url,
            data_dir: PathBuf::from(required("BEGHU_DATA_DIR")?),
            token_key,
            github: GitHubConfig {
                api_url,
                web_url: optional("GITHUB_WEB_URL", "https://github.com"),
                client_id: required("GITHUB_CLIENT_ID")?,
                client_secret: secret("GITHUB_CLIENT_SECRET")?,
                app_id: app_id()?,
                app_key,
                app_slug: std::env::var("GITHUB_APP_SLUG")
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty()),
            },
            web_dir: std::env::var("BEGHU_WEB_DIR").ok().map(PathBuf::from),
            mirrors: MirrorsConfig::from_env()?,
            repo_refresh_every: Duration::from_secs(15 * 60),
            roles_retry_after_failure: Duration::from_secs(60),
            setup_reread_after: Duration::from_secs(60),
            import_retry_after: Duration::from_secs(60),
            import_give_up_after: Duration::from_secs(5 * 60),
            webhook_secret: secret("GITHUB_WEBHOOK_SECRET")?,
            stream_heartbeat: Duration::from_secs(15),
            deliveries_kept_for: Duration::from_secs(4 * 24 * 60 * 60),
            github_probe_every: Duration::from_secs(10),
            github_write_timeout: Duration::from_secs(30),
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

fn app_id() -> Result<String, String> {
    let id = required("GITHUB_APP_ID")?.trim().to_owned();
    match id.parse::<u64>() {
        Ok(_) => Ok(id),
        Err(_) => Err(format!(
            "GITHUB_APP_ID must be the App's numeric id, got {id:?}"
        )),
    }
}

/// `url`'s origin as browsers serialise it: `https://beghu.example`, with no default port, path
/// or trailing slash, in lower case.
fn public_origin(url: &str) -> Result<String, String> {
    let bad = || format!("BEGHU_PUBLIC_URL must be an http(s) URL, got {url:?}");
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| bad())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(bad());
    }
    Ok(parsed.origin().ascii_serialization())
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

#[cfg(test)]
mod tests {
    use super::public_origin;

    #[test]
    fn the_public_url_is_kept_as_the_origin_browsers_send() {
        for (given, origin) in [
            ("https://beghu.example", "https://beghu.example"),
            ("HTTPS://Beghu.Example:443/", "https://beghu.example"),
            ("http://localhost:80/app/", "http://localhost"),
            ("http://LOCALHOST:5173", "http://localhost:5173"),
            (
                "https://beghu.example:8443/x?y#z",
                "https://beghu.example:8443",
            ),
        ] {
            assert_eq!(public_origin(given).as_deref(), Ok(origin), "{given}");
        }
        for bad in ["beghu.example", "ftp://beghu.example", "https://"] {
            assert!(public_origin(bad).is_err(), "{bad}");
        }
    }
}
