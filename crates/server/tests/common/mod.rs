//! The HTTP-seam harness: the real server against a fresh Fake GitHub and the 1k fixture, each
//! test with its own data directory, pristine mirrors and fake truth. Tests drive the server only
//! over HTTP, set GitHub's side up through the fake's control port, and sign in through the same
//! OAuth web flow a browser takes.
#![allow(dead_code)] // each test binary uses its own part of the harness

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const CLIENT_ID: &str = "Iv1.test";
pub const CLIENT_SECRET: &str = "test-secret";
pub const BUILD: &str = "test-build";
pub const WEBHOOK_SECRET: &str = "test-webhook-secret";
/// The session cookie. `__Host-`: `Secure`, `Path=/` and no `Domain`, or browsers refuse it.
pub const SID: &str = "__Host-beghu_sid";

/// The 1k fixture, generated once per test run.
pub fn fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached(
        fixture::Scale::K1,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

/// The 1k fixture's `TwinRepo` variant (a second org's `web` repo), generated once per test run.
pub fn twin_repo_fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached_variant(
        fixture::Scale::K1,
        fixture::Variant::TwinRepo,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

/// The test run's GitHub App key: the server signs with it, the fake checks with its public
/// half. Generated once per test binary.
/// The fixture generator's summary: the independent oracle for what the default list holds.
pub fn summary() -> Value {
    let path = fixture().with_file_name(format!("fixture-1k-{}.json", fixture::GENERATOR_HASH));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A stub a relationship reaches: one every mirror holds (a mirror drops the rest, as the
/// import never learns of them).
pub fn linked_stub() -> i64 {
    let s = summary();
    let unlinked = s["unlinked_stubs"].as_array().unwrap();
    let numbers = s["stub_numbers"].as_array().unwrap();
    let at = numbers.iter().position(|n| !unlinked.contains(n)).unwrap();
    s["stub_ids"][at].as_i64().unwrap()
}

pub struct Stack {
    pub server: String,
    pub fake_ctl: String,
    pub data: PathBuf,
    pub http: reqwest::Client,
    /// Fake GitHub's API (and web) origin.
    pub fake_api: String,
    /// The built web app the server serves: `index.html`, `assets/` and Vite's manifest.
    pub web: PathBuf,
    /// The running server's own runtime, shut down when a restart replaces it, so nothing the
    /// old process had in flight (a request, an import, an unsync) runs on, as after a crash.
    server_rt: Option<tokio::runtime::Runtime>,
    /// The running server, until it stops.
    server_task: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    /// A startup [`Stack::restart_held`] held back, until it hands it over.
    held: Option<Held>,
    /// Signals the running server as SIGTERM does: the first drains, a second stops it at once.
    signals: Option<tokio::sync::mpsc::UnboundedSender<()>>,
    _dir: tempfile::TempDir,
}

/// A minimal built web app: the shell template the server fills in per URL.
pub const SHELL_TEMPLATE: &str = "<!doctype html><html><head><!--beghu:preload--></head><body><div id=\"root\"></div></body></html>";

/// Where the minimal build's issue panel chunk is, as its Vite manifest says.
pub const PANEL_CHUNK: &str = "assets/IssuePanel-test.js";

/// The minimal build's Vite manifest (`.vite/manifest.json`), in the shape `vite build` writes.
pub fn manifest() -> String {
    serde_json::json!({
        "index.html": {
            "file": "assets/index-test.js",
            "src": "index.html",
            "isEntry": true,
            "dynamicImports": ["src/IssuePanel.tsx"],
        },
        "src/IssuePanel.tsx": {
            "file": PANEL_CHUNK,
            "src": "src/IssuePanel.tsx",
            "isDynamicEntry": true,
            "imports": ["index.html"],
        },
    })
    .to_string()
}

pub async fn start() -> Stack {
    start_with(|_| {}).await
}

/// Starts a fake and a server, letting the test adjust the server's config first.
pub async fn start_with(adjust: impl FnOnce(&mut beghu::Config)) -> Stack {
    start_on(fixture(), adjust).await
}

/// Starts a fake and a server on `fixture` (a variant of the 1k fixture, say).
pub async fn start_on(fixture: PathBuf, adjust: impl FnOnce(&mut beghu::Config)) -> Stack {
    start_seeded(fixture, true, adjust).await
}

/// Starts a fake and a server with no mirrors at all, as after `./dev-ctl reset --fresh`: every
/// account imports what it syncs.
pub async fn start_fresh() -> Stack {
    start_seeded(fixture(), false, |_| {}).await
}

/// `start_fresh`, letting the test adjust the server's config first.
pub async fn start_fresh_with(adjust: impl FnOnce(&mut beghu::Config)) -> Stack {
    start_seeded(fixture(), false, adjust).await
}

/// `start_fresh`, on another fixture (a variant of the 1k one, say).
pub async fn start_fresh_on(fixture: PathBuf) -> Stack {
    start_seeded(fixture, false, |_| {}).await
}

/// The 1k fixture's `WideRelates` variant (an issue related to 60 stubs), generated once per
/// test run.
pub fn wide_relates_fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached_variant(
        fixture::Scale::K1,
        fixture::Variant::WideRelates,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

/// The 1k fixture's `WideLinks` variant (an issue with over 100 labels, a PR closing over 50
/// issues), generated once per test run.
pub fn wide_links_fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached_variant(
        fixture::Scale::K1,
        fixture::Variant::WideLinks,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

/// The 1k fixture's `PrivateRelationship` variant (a relationship from a private repo no account sees),
/// generated once per test run.
pub fn private_relationship_fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached_variant(
        fixture::Scale::K1,
        fixture::Variant::PrivateRelationship,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

/// The 1k fixture's `FullParent` variant (a web issue with 100 sub-issues, GitHub's most),
/// generated once per test run.
pub fn full_parent_fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached_variant(
        fixture::Scale::K1,
        fixture::Variant::FullParent,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

async fn start_seeded(
    fixture: PathBuf,
    pristine: bool,
    adjust: impl FnOnce(&mut beghu::Config),
) -> Stack {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let truth = dir.path().join("fake").join("truth.db");
    // As `./dev-ctl start` does: pristine mirrors for the accounts that see every repo.
    if pristine {
        fake_github::pristine_mirrors(&fixture, &truth, &data.join("mirrors"))
            .await
            .unwrap();
    }
    let fake_cfg = fake_github::Config {
        fixture,
        db: truth,
        client_id: CLIENT_ID.into(),
        client_secret: CLIENT_SECRET.into(),
        access_ttl: fake_github::ACCESS_TTL,
        refresh_ttl: fake_github::REFRESH_TTL,
        // Set once the server is listening (see `restart_with`).
        webhook_url: None,
        webhook_secret: WEBHOOK_SECRET.into(),
        setup_url: None,
    };
    let fake = tokio::task::spawn_blocking(move || fake_github::Fake::open(fake_cfg))
        .await
        .unwrap()
        .unwrap();
    let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ctl = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (api_url, ctl_url) = (
        format!("http://{}", api.local_addr().unwrap()),
        format!("http://{}", ctl.local_addr().unwrap()),
    );
    tokio::spawn(fake.serve(api, ctl));

    let web = dir.path().join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), SHELL_TEMPLATE).unwrap();
    std::fs::create_dir_all(web.join(".vite")).unwrap();
    std::fs::write(web.join(".vite").join("manifest.json"), manifest()).unwrap();

    let mut s = Stack {
        server: String::new(),
        fake_ctl: ctl_url,
        data,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        fake_api: api_url,
        web,
        server_rt: None,
        server_task: None,
        held: None,
        signals: None,
        _dir: dir,
    };
    s.restart_with(adjust).await;
    s
}

impl Stack {
    /// Starts a new server on the same data directory and Fake GitHub, as a deploy or a crash
    /// and restart would, and points the stack (and the fake's webhooks) at it. Nothing in
    /// memory carries over. The old server is stopped first.
    pub async fn restart_with(&mut self, adjust: impl FnOnce(&mut beghu::Config)) {
        self.try_restart_with(adjust).await.unwrap();
    }

    /// As [`Stack::restart_with`], but a server that refuses to start says why instead of
    /// panicking; the stack then has no server running.
    pub async fn try_restart_with(
        &mut self,
        adjust: impl FnOnce(&mut beghu::Config),
    ) -> Result<(), String> {
        self.restart_gated(adjust, None).await
    }

    /// As [`Stack::restart_with`], but holding the startup back once the server serves, before
    /// it resumes the webhook deliveries and starts the jobs (`Opened::start`), until
    /// [`Held::start`].
    pub async fn restart_held(&mut self, adjust: impl FnOnce(&mut beghu::Config)) -> Held {
        let (release, gate) = tokio::sync::oneshot::channel();
        self.restart_gated(adjust, Some((gate, release)))
            .await
            .unwrap();
        self.held.take().expect("a held start")
    }

    async fn restart_gated(
        &mut self,
        adjust: impl FnOnce(&mut beghu::Config),
        gate: Option<(
            tokio::sync::oneshot::Receiver<()>,
            tokio::sync::oneshot::Sender<()>,
        )>,
    ) -> Result<(), String> {
        self.stop();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let mut cfg = self.config(&server);
        adjust(&mut cfg);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let (signals, received) = tokio::sync::mpsc::unbounded_channel();
        let (release, gate) = match gate {
            Some((gate, release)) => (Some(release), Some(gate)),
            None => (None, None),
        };
        // As `main` starts it: serving, then the rest of the startup.
        let (serving, served) = tokio::sync::oneshot::channel();
        let started = rt.spawn(async move {
            let opened = beghu::App::open(cfg).await?;
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = serving.send(tokio::spawn(beghu::serve_until(
                listener,
                opened.app(),
                received,
            )));
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            opened.start().await
        });
        // It never serves if the open fails; a held startup is waited for in `Held::start`.
        let served = served.await.ok();
        let task = match (served, release) {
            (Some(task), Some(release)) => {
                self.held = Some(Held { release, started });
                task
            }
            (served, _) => match (served, started.await.unwrap()) {
                (Some(task), Ok(())) => task,
                (_, Err(e)) => {
                    rt.shutdown_background();
                    return Err(e);
                }
                (None, Ok(())) => unreachable!("a startup that never served succeeded"),
            },
        };
        // A stack that restarts or goes away shuts the server's runtime down instead.
        self.signals = Some(signals);
        self.server_task = Some(task);
        self.server_rt = Some(rt);
        self.server = server;
        self.fake(
            "PUT",
            "/webhooks",
            serde_json::json!({ "url": format!("{}/webhook", self.server) }),
        )
        .await;
        self.fake(
            "PUT",
            "/setup-url",
            serde_json::json!({ "url": format!("{}/auth/setup", self.server) }),
        )
        .await;
        Ok(())
    }
}

/// A server's startup held back after it began serving (see [`Stack::restart_held`]).
pub struct Held {
    release: tokio::sync::oneshot::Sender<()>,
    started: tokio::task::JoinHandle<Result<(), String>>,
}

impl Held {
    /// Lets the startup go on, and waits for it.
    pub async fn start(self) {
        let _ = self.release.send(());
        self.started.await.unwrap().unwrap();
    }
}

impl Stack {
    /// The server's config on this stack's data and Fake GitHub, serving at `public_url`.
    fn config(&self, public_url: &str) -> beghu::Config {
        beghu::Config {
            build_id: BUILD.into(),
            public_url: public_url.to_owned(),
            data_dir: self.data.clone(),
            token_key: b"a test key that is at least 32 bytes long".to_vec(),
            github: beghu::GitHubConfig {
                api_url: self.fake_api.clone(),
                web_url: self.fake_api.clone(),
                client_id: CLIENT_ID.into(),
                client_secret: CLIENT_SECRET.into(),
                app_id: fake_github::DEV_APP_ID.to_string(),
                app_key: fake_github::DEV_APP_KEY.into(),
                app_slug: Some(fake_github::APP_SLUG.to_owned()),
                attachments_url: format!("{}/private-user-images", self.fake_api),
            },
            web_dir: Some(self.web.clone()),
            mirrors: mirror_db_config(),
            repo_refresh_every: Duration::from_secs(15 * 60),
            roles_retry_after_failure: Duration::from_secs(60),
            setup_reread_after: Duration::from_secs(60),
            assignees_recheck_after: Duration::from_secs(60),
            import_retry_after: Duration::from_secs(60),
            import_give_up_after: Duration::from_secs(5 * 60),
            webhook_secret: WEBHOOK_SECRET.into(),
            stream_heartbeat: Duration::from_secs(15),
            deliveries_kept_for: Duration::from_secs(3 * 24 * 60 * 60),
            github_probe_every: Duration::from_secs(10),
            github_write_timeout: Duration::from_secs(30),
            read_back_retries: beghu::default_read_back_retries(),
            backup_every: beghu::default_backup_every(),
            assets_kept_for: beghu::default_assets_kept_for(),
            drain_for: beghu::default_drain_for(),
            // The image proxy may fetch from Fake GitHub's stand-in for the web's image hosts.
            media: beghu::MediaConfig {
                dev_image_hosts: vec![
                    self.fake_api
                        .trim_start_matches("http://")
                        .parse()
                        .expect("the fake's API listens on ip:port"),
                ],
                ..beghu::MediaConfig::default()
            },
            accounts_check_every: beghu::default_accounts_check_every(),
            dormant_after: beghu::default_dormant_after(),
            activity_every: beghu::default_activity_every(),
            // Sweeps, periodic redelivery and the events-feed poller stay out of the way of
            // tests about other things: a test about them sets its own schedule
            // (tests/reconcile.rs, tests/prs.rs). Redelivery still runs once at each start, and
            // a full sweep asked for (a Resync) still runs.
            reconcile: beghu::ReconcileConfig {
                tick: Duration::from_secs(3600),
                redeliver_every: Duration::from_secs(3600),
                feed_every: Duration::from_secs(3600),
                ..beghu::ReconcileConfig::default()
            },
        }
    }
}

impl Stack {
    /// Stops the running server, if any, as a crash would: its runtime goes, and with it every
    /// task it had, at the task's next await. Blocking work already under way (a mirror
    /// transaction) runs to its end.
    pub fn stop(&mut self) {
        self.held = None;
        self.signals = None;
        self.server_task = None;
        if let Some(rt) = self.server_rt.take() {
            rt.shutdown_background();
        }
    }

    /// Stops the server as SIGTERM does: the task that ends when it has stopped.
    pub fn sigterm(&mut self) -> tokio::task::JoinHandle<std::io::Result<()>> {
        self.signal_again();
        self.server_task.take().expect("a running server")
    }

    /// Another SIGTERM, during the drain the first one started.
    pub fn signal_again(&self) {
        if let Some(signals) = &self.signals {
            let _ = signals.send(());
        }
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        // A runtime can't be dropped inside another's async context; shut it down instead.
        self.stop();
    }
}

pub fn mirror_db_config() -> beghu::MirrorsConfig {
    beghu::MirrorsConfig::default()
}

/// One browser's cookies, sent back by hand: the session cookie is `Secure`, which a cookie
/// store won't send over the tests' plain HTTP.
#[derive(Default, Clone, Debug)]
pub struct Browser {
    pub cookies: BTreeMap<String, String>,
}

impl Browser {
    /// The account the browser's tabs are on (`beghu_acct`): what a tab's writes name
    /// (`X-Beghu-Account`).
    pub fn account(&self) -> String {
        self.cookies.get("beghu_acct").cloned().unwrap_or_default()
    }

    pub fn header(&self) -> String {
        self.cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Takes the response's `Set-Cookie`s, as a browser would.
    pub fn take(&mut self, res: &reqwest::Response) {
        for v in res.headers().get_all("set-cookie") {
            let v = v.to_str().unwrap();
            let pair = v.split(';').next().unwrap();
            let (k, val) = pair.split_once('=').unwrap();
            let gone = v
                .split(';')
                .any(|a| a.trim().eq_ignore_ascii_case("max-age=0"));
            if gone {
                self.cookies.remove(k.trim());
            } else {
                self.cookies.insert(k.trim().into(), val.trim().into());
            }
        }
    }
}

pub fn location(res: &reqwest::Response) -> String {
    res.headers()["location"].to_str().unwrap().to_owned()
}

pub fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    serde_urlencoded::from_str::<Vec<(String, String)>>(q)
        .unwrap()
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

impl Stack {
    /// A GET from `b`, keeping the cookies it sets.
    pub async fn get(&self, b: &mut Browser, path_or_url: &str) -> reqwest::Response {
        let url = if path_or_url.starts_with("http") {
            path_or_url.to_owned()
        } else {
            format!("{}{path_or_url}", self.server)
        };
        let mut req = self.http.get(url);
        if !b.cookies.is_empty() {
            req = req.header("cookie", b.header());
        }
        let res = req.send().await.unwrap();
        b.take(&res);
        res
    }

    /// Follows redirects from `path` by hand (cookies included) until a non-redirect, returning
    /// every URL visited and the last response.
    pub async fn follow(&self, b: &mut Browser, path: &str) -> (Vec<String>, reqwest::Response) {
        let mut visited = vec![format!("{}{path}", self.server)];
        let mut res = self.get(b, path).await;
        for _ in 0..10 {
            if !res.status().is_redirection() {
                break;
            }
            let to = location(&res);
            let to = if to.starts_with('/') {
                format!("{}{to}", self.server)
            } else {
                to
            };
            visited.push(to.clone());
            // Cookies go only to the server, never to the fake.
            res = if to.starts_with(&self.server) {
                self.get(b, &to).await
            } else {
                self.http.get(&to).send().await.unwrap()
            };
        }
        (visited, res)
    }

    /// Signs `login` in through the whole web flow, starting at `/auth/login?login=…`.
    pub async fn sign_in(&self, login: &str) -> Browser {
        let mut b = Browser::default();
        let (_, res) = self
            .follow(&mut b, &format!("/auth/login?login={login}"))
            .await;
        assert!(res.status().is_success(), "{}", res.status());
        assert!(b.cookies.contains_key(SID), "{:?}", b.cookies);
        b
    }

    /// Signs `login` in on `b`, a browser that may hold a session already: the session gains
    /// the account, which becomes active.
    pub async fn sign_in_on(&self, b: &mut Browser, login: &str) {
        let (_, res) = self.follow(b, &format!("/auth/login?login={login}")).await;
        assert!(res.status().is_success(), "{}", res.status());
    }

    /// A form post from one of beghu's own pages (sign out, switch, disconnect): its `Origin`
    /// is beghu's, as a browser sends it. Keeps the cookies it sets; doesn't follow redirects.
    pub async fn post_form(
        &self,
        b: &mut Browser,
        path: &str,
        form: &[(&str, &str)],
    ) -> reqwest::Response {
        self.post_form_from(b, path, form, Some(&self.server.clone()))
            .await
    }

    /// [`Stack::post_form`] with `origin` as the `Origin` header (`None`: none at all).
    pub async fn post_form_from(
        &self,
        b: &mut Browser,
        path: &str,
        form: &[(&str, &str)],
        origin: Option<&str>,
    ) -> reqwest::Response {
        let mut req = self
            .http
            .post(format!("{}{path}", self.server))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(serde_urlencoded::to_string(form).unwrap());
        if !b.cookies.is_empty() {
            req = req.header("cookie", b.header());
        }
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        let res = req.send().await.unwrap();
        b.take(&res);
        res
    }

    /// A write to the API as the web app sends one: from beghu's own page (`Origin`), as the tab
    /// on `b`'s active account (`X-Beghu-Account`, which every write must carry), with `b`'s
    /// cookies.
    pub fn api_write(
        &self,
        b: &Browser,
        method: reqwest::Method,
        path: &str,
    ) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.server))
            .header("cookie", b.header())
            .header("x-beghu-account", b.account())
            .header("origin", &self.server)
    }

    /// A GET of an API path as a tab on `account` sends it (`X-Beghu-Account`).
    pub async fn api_as(&self, b: &mut Browser, account: i64, path: &str) -> (u16, Value) {
        let res = self
            .http
            .get(format!("{}{path}", self.server))
            .header("cookie", b.header())
            .header("x-beghu-account", account.to_string())
            .send()
            .await
            .unwrap();
        b.take(&res);
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// Opens `/api/stream` as a tab on `account` would (`?account=`).
    pub async fn stream_as(&self, b: &Browser, account: i64) -> Stream {
        let res = self
            .http
            .get(format!("{}/api/stream?account={account}", self.server))
            .header("cookie", b.header())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        Stream::new(res)
    }

    pub async fn api(&self, b: &mut Browser, path: &str) -> (u16, Value) {
        let res = self.get(b, path).await;
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// A call to the fake's control port.
    pub async fn fake(&self, method: &str, path: &str, body: Value) -> Value {
        let res = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.fake_ctl))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{path}: {}", res.status());
        res.json().await.unwrap()
    }

    /// `n` GETs of `path` from `b`, all in flight at once; their statuses.
    pub async fn concurrently(&self, b: &Browser, path: &str, n: usize) -> Vec<u16> {
        let tasks: Vec<_> = (0..n)
            .map(|_| {
                let req = self
                    .http
                    .get(format!("{}{path}", self.server))
                    .header("cookie", b.header());
                tokio::spawn(async move { req.send().await.unwrap().status().as_u16() })
            })
            .collect();
        let mut out = Vec::new();
        for t in tasks {
            out.push(t.await.unwrap());
        }
        out
    }

    pub fn control_db(&self) -> PathBuf {
        self.data.join("control.db")
    }
}

/// Every byte the control DB holds on disk, WAL included.
pub fn db_bytes(path: &Path) -> Vec<u8> {
    let mut all = std::fs::read(path).unwrap_or_default();
    all.extend(std::fs::read(format!("{}-wal", path.display())).unwrap_or_default());
    all
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

impl Stack {
    /// An outside edit on Fake GitHub (`POST /edit`); its webhooks follow about a second later.
    pub async fn edit(&self, edit: Value) -> Value {
        self.fake("POST", "/edit", edit).await
    }

    /// POSTs a delivery to `/webhook`, signed with the webhook secret; the status.
    pub async fn deliver(&self, event: &str, guid: &str, payload: &Value) -> u16 {
        let body = serde_json::to_vec(payload).unwrap();
        self.http
            .post(format!("{}/webhook", self.server))
            .header("x-github-event", event)
            .header("x-github-delivery", guid)
            .header(
                "x-hub-signature-256",
                fake_github::sign_webhook(WEBHOOK_SECRET, &body),
            )
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    /// Opens `/api/stream` as `b`'s tab.
    pub async fn stream(&self, b: &Browser) -> Stream {
        let res = self
            .http
            .get(format!("{}/api/stream", self.server))
            .header("cookie", b.header())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        Stream::new(res)
    }

    /// Polls `/api/issues` until `f` holds for the first page, or panics after `secs`.
    pub async fn until_list(
        &self,
        b: &mut Browser,
        secs: u64,
        f: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let (status, page) = self.api(b, "/api/issues").await;
            if status == 200 && f(&page) {
                return page;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the list didn't change within {secs} s"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// One server-sent event: its name and data. A comment line (the heartbeat) comes as event `:`
/// with the comment as its data.
#[derive(Debug, Clone, PartialEq)]
pub struct Sse {
    pub event: String,
    pub data: String,
}

/// A tab's `/api/stream`, read event by event. `github` events (GitHub up or down) are set
/// aside for [`Stream::github_within`], so tests about pushes read only pushes.
pub struct Stream {
    pub res_headers: reqwest::header::HeaderMap,
    body: std::pin::Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>,
    buf: String,
    /// `github` events read past, oldest first.
    github: std::collections::VecDeque<Sse>,
    /// Other events read past while looking for a `github` one, oldest first.
    others: std::collections::VecDeque<Sse>,
}

impl Stream {
    pub fn new(res: reqwest::Response) -> Stream {
        Stream {
            res_headers: res.headers().clone(),
            body: Box::pin(res.bytes_stream()),
            buf: String::new(),
            github: Default::default(),
            others: Default::default(),
        }
    }

    /// The next event or comment, or `None` if none comes within `wait`.
    pub async fn next_within(&mut self, wait: Duration) -> Option<Sse> {
        use futures_util::StreamExt as _;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(at) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..at + 2).collect();
                let mut ev = Sse {
                    event: "message".into(),
                    data: String::new(),
                };
                for line in block.lines() {
                    if let Some(c) = line.strip_prefix(':') {
                        ev = Sse {
                            event: ":".into(),
                            data: c.trim().into(),
                        };
                    } else if let Some(e) = line.strip_prefix("event:") {
                        ev.event = e.trim().into();
                    } else if let Some(d) = line.strip_prefix("data:") {
                        ev.data.push_str(d.trim());
                    }
                }
                return Some(ev);
            }
            let chunk = tokio::time::timeout_at(deadline, self.body.next())
                .await
                .ok()??;
            self.buf.push_str(&String::from_utf8_lossy(&chunk.ok()?));
        }
    }

    /// Whether the server ends the stream within `wait`, reading past anything it sends first.
    pub async fn ends_within(&mut self, wait: Duration) -> bool {
        use futures_util::StreamExt as _;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, self.body.next()).await {
                Err(_) => return false,
                Ok(None) | Ok(Some(Err(_))) => return true,
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    /// The next event that isn't a heartbeat or a `github` event, or `None` within `wait`.
    pub async fn event_within(&mut self, wait: Duration) -> Option<Sse> {
        if let Some(ev) = self.others.pop_front() {
            return Some(ev);
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let ev = self.next_within(left).await?;
            match ev.event.as_str() {
                ":" => {}
                "github" => self.github.push_back(ev),
                _ => return Some(ev),
            }
        }
    }

    /// The next `github` event's state (`up` or `down`), or `None` within `wait`.
    pub async fn github_within(&mut self, wait: Duration) -> Option<String> {
        let state = |ev: Sse| {
            let v: Value = serde_json::from_str(&ev.data).unwrap();
            v["state"].as_str().unwrap().to_owned()
        };
        if let Some(ev) = self.github.pop_front() {
            return Some(state(ev));
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let ev = self.next_within(left).await?;
            match ev.event.as_str() {
                ":" => {}
                "github" => return Some(state(ev)),
                _ => self.others.push_back(ev),
            }
        }
    }

    /// Reads a `reset` and the status slot's state, which follows every one (a stream opens with
    /// both).
    pub async fn reset(&mut self) {
        let wait = Duration::from_secs(1);
        let first = self.event_within(wait).await;
        assert_eq!(
            first.as_ref().map(|e| e.event.as_str()),
            Some("reset"),
            "{first:?}"
        );
        let second = self.event_within(wait).await;
        assert_eq!(
            second.as_ref().map(|e| e.event.as_str()),
            Some("status"),
            "{second:?}"
        );
    }

    /// Every event (heartbeats aside) that arrives within `wait`.
    pub async fn events_for(&mut self, wait: Duration) -> Vec<Sse> {
        let deadline = tokio::time::Instant::now() + wait;
        let mut out = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.event_within(left).await {
                Some(ev) => out.push(ev),
                None => return out,
            }
        }
    }
}

/// The ids an `ids` event names.
pub fn ids_of(ev: &Sse) -> Vec<i64> {
    assert_eq!(ev.event, "ids", "{ev:?}");
    let v: Value = serde_json::from_str(&ev.data).unwrap();
    v["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_i64().unwrap())
        .collect()
}

/// Polls `f` every 50 ms until it gives a value, or panics after `secs`.
pub async fn until<T, F, Fut>(secs: f64, what: &str, mut f: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs_f64(secs);
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{what}: not within {secs} s"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Holds the write lock on a SQLite file, as another writer would, until dropped. Writers that
/// meet it wait out SQLite's 5 s busy timeout and then fail.
pub struct WriteLock(rusqlite::Connection);

impl WriteLock {
    pub fn take(path: &std::path::Path) -> WriteLock {
        let c = rusqlite::Connection::open(path).unwrap();
        // `BEGIN IMMEDIATE` through rusqlite's own transaction, kept open by forgetting it.
        let mut lock = WriteLock(c);
        std::mem::forget(
            lock.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap(),
        );
        lock
    }
}
