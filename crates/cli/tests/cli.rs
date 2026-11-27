//! The beghu CLI as a public seam: the built `beghu` binary, run as a subprocess against the
//! server tests' harness (the real server and Fake GitHub, 1k fixture), checked by its stdout,
//! stderr, exit code and the files it writes. Each test has its own working folder and
//! credentials file; nothing touches the machine's own.

#[path = "../../server/tests/common/mod.rs"]
mod common;

use common::{Browser, RECORDED, Stack, start, start_with};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_beghu");

/// One machine running the CLI: a working folder, a credentials file, and the host it talks to.
struct Machine {
    dir: tempfile::TempDir,
    host: String,
    /// The binary it runs: `target/`'s, or a copy a test may let it replace.
    bin: PathBuf,
}

/// What a run of the CLI did.
#[derive(Debug)]
struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Machine {
    fn new(s: &Stack) -> Machine {
        Machine {
            dir: tempfile::tempdir().unwrap(),
            host: s.server.clone(),
            bin: PathBuf::from(BIN),
        }
    }

    fn cwd(&self) -> &Path {
        self.dir.path()
    }

    fn credentials(&self) -> PathBuf {
        self.cwd().join("state").join("credentials.toml")
    }

    /// The CLI with this machine's environment: `BEGHU_HOST` at the stack, its own credentials
    /// file and home, no browser to open.
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(&self.bin);
        c.args(args)
            .current_dir(self.cwd())
            .env("BEGHU_HOST", &self.host)
            .env("BEGHU_CREDENTIALS", self.credentials())
            .env("HOME", self.cwd())
            .env_remove("BEGHU_TOKEN")
            .env_remove("BEGHU_UPDATED")
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::null());
        c
    }

    /// Runs `c` to its end, off the test's runtime, which serves Fake GitHub meanwhile.
    async fn output(mut c: Command) -> Ran {
        let out = tokio::task::spawn_blocking(move || c.output().unwrap())
            .await
            .unwrap();
        Ran {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    async fn run(&self, args: &[&str]) -> Ran {
        Machine::output(self.command(args)).await
    }

    /// `beghu login`, approved by `b` once it shows its code: what it printed.
    async fn login(&self, s: &Stack, b: &Browser) -> Ran {
        self.login_deciding(s, b, true).await
    }

    async fn login_deciding(&self, s: &Stack, b: &Browser, approve: bool) -> Ran {
        let mut c = self.command(&["login", "--no-browser", "--name", "test-machine"]);
        c.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let reader = std::thread::spawn(move || {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let _ = tx.send(line);
            }
        });
        let mut seen = Vec::new();
        let code = loop {
            let line = tokio::time::timeout(Duration::from_secs(30), rx.recv())
                .await
                .expect("beghu login printed its code within 30 s")
                .expect("beghu login printed its code before it exited");
            seen.push(line.clone());
            if let Some(at) = line.find("the code ") {
                break line[at + 9..at + 18].to_owned();
            }
        };
        assert!(
            seen.iter()
                .any(|l| l.contains(&format!("{}/cli/login?code={code}", self.host))),
            "{seen:?}"
        );
        assert_eq!(s.decide_cli_login(b, &code, approve).await, 204);
        let out = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap())
            .await
            .unwrap();
        reader.join().unwrap();
        while let Ok(l) = rx.try_recv() {
            seen.push(l);
        }
        Ran {
            code: out.status.code().unwrap_or(-1),
            stdout: seen.join("\n"),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    /// The credential `beghu login` stored for the stack.
    fn token(&self) -> String {
        let text = std::fs::read_to_string(self.credentials()).unwrap();
        let line = text
            .lines()
            .find(|l| l.starts_with("token = "))
            .expect("a token in the credentials file");
        line["token = ".len()..].trim_matches('"').to_owned()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn version_names_the_semver_and_build() {
    let out = Machine::output({
        let mut c = Command::new(BIN);
        c.arg("--version");
        c
    })
    .await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stdout
            .starts_with(&format!("beghu {} (build ", env!("CARGO_PKG_VERSION"))),
        "{out:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn device_code_login_approved_in_the_browser() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);

    let out = m.login(&s, &b).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stdout
            .contains(&format!("Signed in to {} as tomsj.", s.server)),
        "{out:?}"
    );
    // One entry, the active host's, private to the user.
    let meta = std::fs::metadata(m.credentials()).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    let text = std::fs::read_to_string(m.credentials()).unwrap();
    assert!(
        text.contains(&format!("active = \"{}\"", s.server)),
        "{text}"
    );
    assert!(m.token().starts_with("beghu_cli_"), "{text}");

    let st = m.run(&["status"]).await;
    assert_eq!(st.code, 0, "{st:?}");
    assert!(st.stdout.contains("account: tomsj;"), "{st:?}");
    assert!(st.stdout.contains("(active)"), "{st:?}");
    assert!(
        st.stdout
            .contains(&format!("host's build: {}", common::BUILD)),
        "{st:?}"
    );

    // The setup page lists it by the machine's name.
    let mut b = b;
    let (status, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    assert_eq!(status, 200);
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list[0]["name"], "test-machine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denied_login_stores_nothing() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    let out = m.login_deciding(&s, &b, false).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("denied"), "{out:?}");
    assert!(!m.credentials().exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_sign_in_is_signed_out_on_its_next_call() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);

    let (_, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    let id = list[0]["id"].as_str().unwrap().to_owned();
    let res = s
        .api_write(
            &b,
            reqwest::Method::DELETE,
            &format!("/api/cli/sign-ins/{id}"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    let out = m.run(&["status"]).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr.contains(&format!(
            "signed out on the server; run `beghu login --host {}`",
            s.server
        )),
        "{out:?}"
    );
    // Its entry is gone; the active host stays.
    let text = std::fs::read_to_string(m.credentials()).unwrap();
    assert!(!text.contains("token = "), "{text}");
    let (_, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    assert_eq!(list, serde_json::json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn logout_revokes_on_the_server_then_forgets() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);
    let token = m.token();

    let out = m.run(&["logout"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stdout.contains("Signed out of"), "{out:?}");
    let (_, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    assert_eq!(list, serde_json::json!([]));
    // The token itself is dead.
    let res = s
        .http
        .get(format!("{}/api/cli/status", s.server))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn beghu_token_overrides_the_credentials_file() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);
    let token = m.token();

    // Another machine (a CI job) with no credentials file at all, only the environment.
    let ci = Machine::new(&s);
    let mut c = ci.command(&["status"]);
    c.env("BEGHU_TOKEN", &token);
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stdout.contains("account: tomsj, from BEGHU_TOKEN;"),
        "{out:?}"
    );
    assert!(!ci.credentials().exists());

    // A bad one is signed out, and the file (which it isn't from) is left alone.
    let mut c = m.command(&["status"]);
    c.env(
        "BEGHU_TOKEN",
        "beghu_cli_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    let out = Machine::output(c).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("BEGHU_TOKEN was revoked"), "{out:?}");
    assert_eq!(m.token(), token);
}

#[tokio::test(flavor = "multi_thread")]
async fn beghu_token_goes_only_to_the_host_beghu_host_names() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);
    let token = m.token();
    // The same server under another origin: another host, as far as the CLI knows.
    let other = s.server.replace("127.0.0.1", "localhost");
    assert_ne!(other, s.server);

    // Without BEGHU_HOST, BEGHU_TOKEN is refused: beghu won't guess where it may go.
    let mut c = m.command(&["status"]);
    c.env("BEGHU_TOKEN", &token).env_remove("BEGHU_HOST");
    let out = Machine::output(c).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr.contains("BEGHU_TOKEN is set without BEGHU_HOST"),
        "{out:?}"
    );

    // `--host` another origin: BEGHU_TOKEN is left out, and that's said; the file has no
    // sign-in there.
    let mut c = m.command(&["status", "--host", &other]);
    c.env("BEGHU_TOKEN", &token);
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stdout.contains("account: not signed in"), "{out:?}");
    assert!(
        out.stderr.contains(&format!(
            "BEGHU_TOKEN is for {} (BEGHU_HOST), not {other}",
            s.server
        )),
        "{out:?}"
    );

    // A run started on the file's host, ended with BEGHU_HOST and BEGHU_TOKEN set for another:
    // the run's host gets the file's sign-in (a bad BEGHU_TOKEN there would be signed out).
    let pr = format!("AdvanGrid/beghu#{RECORDED}");
    assert_eq!(m.run(&["analyse", &pr]).await.code, 0);
    let mut c = m.command(&["analyse", "end"]);
    c.env("BEGHU_HOST", &other).env(
        "BEGHU_TOKEN",
        "beghu_cli_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stdout.contains("Ended the run"), "{out:?}");
    assert!(
        out.stderr.contains(&format!(
            "BEGHU_TOKEN is for {other} (BEGHU_HOST), not {}",
            s.server
        )),
        "{out:?}"
    );

    // `logout` with BEGHU_TOKEN for the host signs out BEGHU_TOKEN, and keeps the file's.
    let ci = Machine::new(&s);
    assert_eq!(ci.login(&s, &b).await.code, 0);
    let theirs = ci.token();
    let mut c = m.command(&["logout"]);
    c.env("BEGHU_TOKEN", &theirs);
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stdout
            .contains(&format!("Signed out BEGHU_TOKEN on {}", s.server)),
        "{out:?}"
    );
    assert!(
        out.stdout.contains(&format!(
            "The credentials file's sign-in for {} is kept",
            s.server
        )),
        "{out:?}"
    );
    let status = |t: String| {
        let (http, url) = (s.http.clone(), format!("{}/api/cli/status", s.server));
        async move {
            let res = http.get(url).bearer_auth(t).send().await.unwrap();
            res.json::<Value>().await.unwrap()["account"].clone()
        }
    };
    assert_eq!(status(theirs).await, Value::Null, "BEGHU_TOKEN's is dead");
    assert_eq!(
        status(m.token()).await["login"],
        "tomsj",
        "the file's lives"
    );
}

/// A checkout of this repo at `sha` in `dir`: a clone sharing this clone's objects, so the commit
/// needs only to be in this clone (CI fetches the recorded ones by SHA).
fn checkout(dir: &Path, sha: &str) {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let git = |args: &[&str], cwd: &Path| {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(
        &[
            "clone",
            "--quiet",
            "--shared",
            "--no-checkout",
            repo.to_str().unwrap(),
            dir.to_str().unwrap(),
        ],
        &repo,
    );
    git(&["checkout", "--quiet", "--detach", sha], dir);
}

/// The recorded PR's analysis graph, as the view reads it (uncompressed).
async fn graph(s: &Stack, b: &Browser) -> (u16, Value) {
    let res = s
        .http
        .get(format!(
            "{}/api/AdvanGrid/beghu/pulls/{RECORDED}/analysis",
            s.server
        ))
        .header("cookie", b.header())
        .header("accept-encoding", "identity")
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// The only run folder in `./.beghu/`.
fn run_dir(m: &Machine) -> PathBuf {
    let runs: Vec<PathBuf> = std::fs::read_dir(m.cwd().join(".beghu"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(runs.len(), 1, "{runs:?}");
    runs.into_iter().next().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn analyse_check_and_upload_the_recorded_pr() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);

    let pr = format!("AdvanGrid/beghu#{RECORDED}");
    let out = m.run(&["analyse", &pr, "--yes", "--max-areas", "3"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    let first = out.stdout.lines().next().unwrap();
    assert!(first.contains(" files, +"), "{first}");
    assert!(out.stdout.contains("--yes: at the checkpoint"), "{out:?}");
    assert!(out.stdout.contains("# beghu analysis run"), "{out:?}");
    assert!(out.stdout.contains("`beghu analyse upload analysis.json`"));
    assert!(
        !out.stdout.contains("/api/runs/"),
        "a CLI run names no URLs"
    );

    // The run's files, its private run.toml, and nothing to commit.
    let dir = run_dir(&m);
    for f in ["instructions.md", "pr.json", "schema.ts"] {
        assert!(dir.join(f).exists(), "{f}");
    }
    assert!(
        !dir.join("previous-ids.json").exists(),
        "no previous analysis"
    );
    let mode = std::fs::metadata(dir.join("run.toml"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    // The folders holding it are the user's alone too.
    for d in [dir.clone(), m.cwd().join(".beghu")] {
        let mode = std::fs::metadata(&d).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "{}", d.display());
    }
    assert_eq!(
        std::fs::read_to_string(m.cwd().join(".beghu/.gitignore"))
            .unwrap()
            .lines()
            .last(),
        Some("*")
    );
    let pinned: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("pr.json")).unwrap()).unwrap();
    let recorded = fixture::recorded::version(RECORDED, 1).unwrap();
    assert_eq!(pinned, recorded.pr);

    // The checkouts the instructions name, then the full validator over them.
    let text =
        std::fs::read_to_string(fixture::recorded::analysis_path(RECORDED, 1).unwrap()).unwrap();
    let analysis: Value = serde_json::from_str(&text).unwrap();
    checkout(
        &m.cwd().join("base"),
        analysis["pr"]["baseSha"].as_str().unwrap(),
    );
    checkout(
        &m.cwd().join("head"),
        analysis["pr"]["headSha"].as_str().unwrap(),
    );
    std::fs::write(m.cwd().join("analysis.json"), &text).unwrap();
    let out = m.run(&["analyse", "check", "analysis.json"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stderr.starts_with("0 errors"), "{out:?}");
    let report: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(report["errors"], serde_json::json!([]));

    // An analysis with errors is refused before anything is sent.
    let mut broken = analysis.clone();
    broken.as_object_mut().unwrap().remove("nodes");
    std::fs::write(m.cwd().join("broken.json"), broken.to_string()).unwrap();
    let out = m.run(&["analyse", "upload", "broken.json"]).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("refusing to upload"), "{out:?}");
    let (status, _) = graph(&s, &b).await;
    assert_eq!(status, 404, "nothing was uploaded");

    let out = m.run(&["analyse", "upload", "analysis.json"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stderr.starts_with("uploaded: analysis "), "{out:?}");
    let accepted: Value = serde_json::from_str(&out.stdout).unwrap();
    let (status, graph) = graph(&s, &b).await;
    assert_eq!(status, 200);
    assert_eq!(graph["id"], accepted["analysis"], "{graph}");
    // Gzipped, and the snippets checked by the uploader's tool.
    assert_eq!(graph["snippets"], "checked", "{graph}");

    let out = m.run(&["analyse", "end"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(!dir.join("run.toml").exists());
    assert!(dir.join("pr.json").exists(), "its files stay");
    let out = m.run(&["analyse", "end"]).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr.contains("no beghu run in this folder"),
        "{out:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_split_past_max_areas_is_refused() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let m = Machine::new(&s);
    assert_eq!(m.login(&s, &b).await.code, 0);
    let out = m
        .run(&[
            "analyse",
            &format!("https://github.com/AdvanGrid/beghu/pull/{RECORDED}"),
            "--max-areas",
            "1",
        ])
        .await;
    assert_eq!(out.code, 0, "{out:?}");
    let pinned: Value =
        serde_json::from_str(&std::fs::read_to_string(run_dir(&m).join("pr.json")).unwrap())
            .unwrap();
    let files: Vec<&str> = pinned["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    let (crates, rest): (Vec<&str>, Vec<&str>) =
        files.iter().partition(|f| f.starts_with("crates/"));
    let area = |id: &str, owns: &[&str]| {
        serde_json::json!({
            "id": id, "prefixes": [format!("{id}/")], "owns": owns, "reads": [],
            "estimate": "a few files", "system": false,
        })
    };
    let split = serde_json::json!({
        "areas": [area("crates", &crates), area("web", &rest)],
        "candidates": [], "purposes": [], "rules": [],
    });
    std::fs::write(m.cwd().join("split.json"), split.to_string()).unwrap();
    std::fs::write(
        m.cwd().join("skeleton.json"),
        serde_json::json!({ "version": 1 }).to_string(),
    )
    .unwrap();
    let out = m.run(&["analyse", "check-split", "split.json"]).await;
    assert_eq!(out.code, 1, "{out:?}");
    let report: Value = serde_json::from_str(&out.stdout).unwrap();
    assert!(
        report["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["rule"] == "split.max-areas"),
        "{report}"
    );
}

/// A `BEGHU_CLI_DIR` holding `version` and this platform's `beghu`, as the image's `cli` stage
/// writes one.
fn cli_dir(version: &str, binary: &[u8]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("version"), format!("{version}\n")).unwrap();
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    std::fs::create_dir_all(d.path().join(&platform)).unwrap();
    std::fs::write(d.path().join(&platform).join("beghu"), binary).unwrap();
    d
}

/// A copy of the binary in a folder of its own, for a test that lets it replace itself.
fn own_copy() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("beghu");
    std::fs::copy(BIN, &p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    (d, p)
}

/// The "newer build" a test serves: a script that says how it was run.
const NEWER: &str =
    "#!/bin/sh\necho \"the newer build ran: $*\"\necho \"updated from $BEGHU_UPDATED\"\n";

#[tokio::test(flavor = "multi_thread")]
async fn below_the_floor_it_updates_itself_and_runs_again() {
    let builds = cli_dir("0.2.0", NEWER.as_bytes());
    let dir = builds.path().to_owned();
    let s = start_with(move |c| {
        c.cli_dir = Some(dir);
        c.cli.min_cli = beghu_server::CliVersion::parse("0.2.0").unwrap();
    })
    .await;
    let (_keep, copy) = own_copy();
    let mut m = Machine::new(&s);
    m.bin = copy.clone();

    let out = m.run(&["status"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stderr.contains(&format!(
            "updated beghu {} \u{2192} 0.2.0 from {}",
            env!("CARGO_PKG_VERSION"),
            s.server
        )),
        "{out:?}"
    );
    assert!(
        out.stdout.contains("the newer build ran: status"),
        "{out:?}"
    );
    assert!(
        out.stdout
            .contains(&format!("updated from {}", env!("CARGO_PKG_VERSION"))),
        "{out:?}"
    );
    assert_eq!(std::fs::read(&copy).unwrap(), NEWER.as_bytes());
    let mode = std::fs::metadata(&copy).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);
}

/// The newer build of the update mid-run: it ends the run as `beghu analyse end` does, as a CLI
/// the raised floor lets in, from the run folder the old one left.
const NEWER_ENDS_THE_RUN: &str = r#"#!/bin/sh
set -eu
[ "$*" = "analyse end" ] || { echo "the newer build ran: $*" >&2; exit 3; }
run=$(ls .beghu/run-*/run.toml)
field() { sed -n "s/^$1 = \"\(.*\)\"\$/\1/p" "$2"; }
host=$(field host "$run")
token=$(field token "$run")
credential=$(field token "$BEGHU_CREDENTIALS")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'user-agent: beghu-cli/0.2.0' \
  -H "authorization: Bearer $credential" -H 'content-type: application/json' -d '{}' \
  "$host/api/runs/$token/end")
[ "$code" = 204 ] || { echo "ending the run: $code" >&2; exit 1; }
rm "$run"
echo "Ended the run (beghu 0.2.0, updated from $BEGHU_UPDATED)."
"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_run_survives_a_floor_raised_mid_run_and_the_update_ends_it() {
    let builds = cli_dir("0.2.0", NEWER_ENDS_THE_RUN.as_bytes());
    let dir = builds.path().to_owned();
    let mut s = start_with({
        let dir = dir.clone();
        move |c| c.cli_dir = Some(dir)
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let (_keep, copy) = own_copy();
    let mut m = Machine::new(&s);
    m.bin = copy.clone();
    assert_eq!(m.login(&s, &b).await.code, 0);
    let out = m
        .run(&["analyse", &format!("AdvanGrid/beghu#{RECORDED}")])
        .await;
    assert_eq!(out.code, 0, "{out:?}");
    let run = run_dir(&m);
    let toml = std::fs::read_to_string(run.join("run.toml")).unwrap();
    let token = toml
        .lines()
        .find_map(|l| l.strip_prefix("token = "))
        .unwrap()
        .trim_matches('"')
        .to_owned();

    // A deploy at the same URL raises the floor past this CLI, mid-run.
    s.restart_in_place_with(move |c| {
        c.cli_dir = Some(dir);
        c.cli.min_cli = beghu_server::CliVersion::parse("0.2.0").unwrap();
    })
    .await;
    let out = m.run(&["analyse", "end"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stderr.contains(&format!(
            "updated beghu {} \u{2192} 0.2.0 from {}",
            env!("CARGO_PKG_VERSION"),
            s.server
        )),
        "{out:?}"
    );
    assert!(
        out.stdout.contains(&format!(
            "Ended the run (beghu 0.2.0, updated from {}).",
            env!("CARGO_PKG_VERSION")
        )),
        "{out:?}"
    );
    assert_eq!(std::fs::read(&copy).unwrap(), NEWER_ENDS_THE_RUN.as_bytes());
    assert!(!run.join("run.toml").exists());
    // Ended on the server, by the run the 426 left alive.
    let res = s
        .http
        .get(format!("{}/api/runs/{token}/pr.json", s.server))
        .bearer_auth(m.token())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 410);
}

#[tokio::test(flavor = "multi_thread")]
async fn below_the_floor_and_not_writable_it_says_how_to_update() {
    let builds = cli_dir("0.2.0", NEWER.as_bytes());
    let dir = builds.path().to_owned();
    let s = start_with(move |c| {
        c.cli_dir = Some(dir);
        c.cli.min_cli = beghu_server::CliVersion::parse("0.2.0").unwrap();
    })
    .await;
    let (keep, copy) = own_copy();
    std::fs::set_permissions(keep.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    // Root (or anything with CAP_DAC_OVERRIDE) writes in a read-only folder all the same, so the
    // CLI could replace itself: nothing to see here.
    let probe = keep.path().join(".probe");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(&probe);
        std::fs::set_permissions(keep.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        eprintln!(
            "skipped: this user can write in a read-only folder (root?), so the binary's folder can't be made unwritable"
        );
        return;
    }
    let mut m = Machine::new(&s);
    m.bin = copy.clone();

    let out = m.run(&["status"]).await;
    std::fs::set_permissions(keep.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr.contains("needs beghu CLI 0.2.0 or newer"),
        "{out:?}"
    );
    assert!(
        out.stderr
            .contains(&format!("curl -fsSL {}/cli/install.sh | sh", s.server)),
        "{out:?}"
    );
    assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(BIN).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn newer_than_the_server_it_only_says_so() {
    let builds = cli_dir("0.0.1", b"an older build");
    let dir = builds.path().to_owned();
    let s = start_with(move |c| c.cli_dir = Some(dir)).await;
    let (_keep, copy) = own_copy();
    let mut m = Machine::new(&s);
    m.bin = copy.clone();

    let out = m.run(&["status"]).await;
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr
            .contains("serves beghu CLI 0.0.1, older than this one"),
        "{out:?}"
    );
    assert!(out.stderr.contains("beghu update"), "{out:?}");
    // It never goes older by itself.
    assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(BIN).unwrap());

    // `beghu update` does, deliberately: exactly the host's build.
    let out = m.run(&["update"]).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stdout.contains("\u{2192} 0.0.1 from"), "{out:?}");
    assert_eq!(std::fs::read(&copy).unwrap(), b"an older build");
}

#[tokio::test(flavor = "multi_thread")]
async fn install_sh_installs_a_working_beghu() {
    let builds = cli_dir(env!("CARGO_PKG_VERSION"), &std::fs::read(BIN).unwrap());
    let dir = builds.path().to_owned();
    let s = start_with(move |c| c.cli_dir = Some(dir)).await;
    let into = tempfile::tempdir().unwrap();
    let mut c = Command::new("sh");
    c.args([
        "-c",
        &format!("curl -fsSL {}/cli/install.sh | sh", s.server),
    ])
    .env("BEGHU_INSTALL_DIR", into.path())
    .env("HOME", into.path());
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(out.stdout.contains("installed beghu "), "{out:?}");
    let installed = into.path().join("beghu");
    let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);
    let mut c = Command::new(&installed);
    c.arg("--version");
    let out = Machine::output(c).await;
    assert_eq!(out.code, 0, "{out:?}");
    assert!(
        out.stdout
            .starts_with(&format!("beghu {} ", env!("CARGO_PKG_VERSION"))),
        "{out:?}"
    );
}

/// The analysis crate's split sample (`crates/analysis/tests/sample/split/`).
fn sample(file: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../analysis/tests/sample/split")
        .join(file)
        .to_str()
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn merge_joins_fragments_and_finish_refuses_unresolved_hints() {
    // The merge needs no run and no host.
    let dir = tempfile::tempdir().unwrap();
    let run = |args: Vec<String>| {
        let mut c = Command::new(BIN);
        c.args(args)
            .current_dir(dir.path())
            .env("BEGHU_CREDENTIALS", dir.path().join("none.toml"));
        Machine::output(c)
    };
    let out = run(vec![
        "analyse".into(),
        "merge".into(),
        "--split".into(),
        sample("split.json"),
        sample("1-skeleton.json"),
        sample("2-api.json"),
        sample("3-lib.json"),
    ])
    .await;
    assert_eq!(out.code, 0, "{out:?}");
    let merged: Value = serde_json::from_str(&out.stdout).unwrap();
    let hints = merged["hints"].as_array().unwrap().len();
    assert!(hints > 0, "the seam pass's work is left as hints");
    assert!(
        out.stderr
            .contains(&format!("{hints} hints left for the seam pass")),
        "{out:?}"
    );
    std::fs::write(dir.path().join("merged.json"), &out.stdout).unwrap();
    let out = run(vec![
        "analyse".into(),
        "merge".into(),
        "--finish".into(),
        "merged.json".into(),
    ])
    .await;
    assert_eq!(out.code, 1, "unresolved hints: {out:?}");
}
