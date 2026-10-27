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

/// The fixture generator's summary: the independent oracle for what the default list holds.
pub fn summary() -> Value {
    let path = fixture().with_file_name(format!("fixture-1k-{}.json", fixture::GENERATOR_HASH));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub struct Stack {
    pub server: String,
    pub fake_ctl: String,
    pub data: PathBuf,
    pub http: reqwest::Client,
    /// What a restart needs to build the server's config again.
    fake_api: String,
    /// The built web app the server serves: `index.html`, `assets/` and Vite's manifest.
    pub web: PathBuf,
    /// The running server, stopped when a restart replaces it.
    server_task: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
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
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let truth = dir.path().join("fake").join("truth.db");
    // As `./dev-ctl start` does: pristine mirrors for the accounts that see every repo.
    fake_github::pristine_mirrors(&fixture, &truth, &data.join("mirrors"))
        .await
        .unwrap();
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
        server_task: None,
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
        if let Some(old) = self.server_task.take() {
            old.abort();
            let _ = old.await;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let mut cfg = beghu::Config {
            build_id: BUILD.into(),
            public_url: server.clone(),
            data_dir: self.data.clone(),
            token_key: b"a test key that is at least 32 bytes long".to_vec(),
            github: beghu::GitHubConfig {
                api_url: self.fake_api.clone(),
                web_url: self.fake_api.clone(),
                client_id: CLIENT_ID.into(),
                client_secret: CLIENT_SECRET.into(),
                app_id: fake_github::DEV_APP_ID.to_string(),
                app_key: fake_github::DEV_APP_KEY.into(),
            },
            web_dir: Some(self.web.clone()),
            mirrors: mirror_db_config(),
            repo_refresh_every: Duration::from_secs(15 * 60),
            roles_retry_after_failure: Duration::from_secs(60),
            webhook_secret: WEBHOOK_SECRET.into(),
            stream_heartbeat: Duration::from_secs(15),
            deliveries_kept_for: Duration::from_secs(3 * 24 * 60 * 60),
            github_probe_every: Duration::from_secs(10),
            github_write_timeout: Duration::from_secs(30),
            read_back_retries: beghu::default_read_back_retries(),
        };
        adjust(&mut cfg);
        let app = beghu::App::open(cfg).await?;
        let (signals, received) = tokio::sync::mpsc::unbounded_channel();
        // A stack that restarts or goes away drops `signals`: that server is aborted instead.
        self.signals = Some(signals);
        self.server_task = Some(tokio::spawn(beghu::serve_until(listener, app, received)));
        self.server = server;
        self.fake(
            "PUT",
            "/webhooks",
            serde_json::json!({ "url": format!("{}/webhook", self.server) }),
        )
        .await;
        Ok(())
    }
}

impl Stack {
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
