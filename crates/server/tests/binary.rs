//! The real `beghu` binary, configured from the environment only: it refuses to start without a
//! required variable, naming it, and with a valid environment it serves `/healthz`.

use std::io::Read as _;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_beghu");

/// Everything `beghu` needs, for a data directory under `dir` and `port`.
fn valid_env(dir: &std::path::Path, port: u16) -> Vec<(&'static str, String)> {
    vec![
        ("PORT", port.to_string()),
        ("BEGHU_BUILD_ID", "smoke".into()),
        ("BEGHU_PUBLIC_URL", format!("http://localhost:{port}")),
        ("BEGHU_DATA_DIR", dir.join("data").display().to_string()),
        // 32 bytes, base64.
        (
            "BEGHU_TOKEN_KEY",
            "c21va2UgdGVzdCBrZXkgdGhhdCBpcyAzMiBieXRlcyE=".into(),
        ),
        // Fake GitHub's dev App key below is refused against real GitHub.
        ("GITHUB_API_URL", "http://127.0.0.1:9".into()),
        ("GITHUB_CLIENT_ID", "Iv1.smoke".into()),
        ("GITHUB_CLIENT_SECRET", "smoke-secret".into()),
        ("GITHUB_WEBHOOK_SECRET", "smoke-webhook-secret".into()),
        ("GITHUB_APP_ID", fake_github::DEV_APP_ID.to_string()),
        // As an env var often carries it: newlines escaped.
        (
            "GITHUB_APP_PRIVATE_KEY",
            fake_github::DEV_APP_KEY.replace('\n', "\\n"),
        ),
    ]
}

fn beghu(env: &[(&str, String)]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.env_clear().envs(env.iter().map(|(k, v)| (*k, v)));
    cmd
}

/// A running `beghu`, killed when dropped, so a failing test leaves no process behind.
struct Running(Child);

impl Running {
    /// Stops the child and fails the test with `why` and everything it wrote to stderr.
    fn fail(&mut self, why: &str) -> ! {
        let _ = self.0.kill();
        let _ = self.0.wait();
        let mut stderr = String::new();
        if let Some(mut pipe) = self.0.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        panic!("{why}; beghu's stderr:\n{stderr}");
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn it_refuses_to_start_without_a_required_variable_and_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let env: Vec<_> = valid_env(dir.path(), 1)
        .into_iter()
        .filter(|(k, _)| *k != "GITHUB_CLIENT_ID")
        .collect();
    let out = beghu(&env).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("GITHUB_CLIENT_ID is required"), "{stderr}");
}

#[test]
fn it_refuses_a_build_id_it_cant_name_a_file_or_header_with() {
    let dir = tempfile::tempdir().unwrap();
    let env: Vec<_> = valid_env(dir.path(), 1)
        .into_iter()
        .map(|(k, v)| match k {
            "BEGHU_BUILD_ID" => (k, "../a b".into()),
            _ => (k, v),
        })
        .collect();
    let out = beghu(&env).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("BEGHU_BUILD_ID"), "{stderr}");
}

#[test]
fn it_refuses_an_app_key_it_cant_sign_with() {
    let dir = tempfile::tempdir().unwrap();
    let env: Vec<_> = valid_env(dir.path(), 1)
        .into_iter()
        .map(|(k, v)| match k {
            "GITHUB_APP_PRIVATE_KEY" => (
                k,
                "-----BEGIN RSA PRIVATE KEY-----\nbm9wZQ==\n-----END RSA PRIVATE KEY-----".into(),
            ),
            _ => (k, v),
        })
        .collect();
    let out = beghu(&env).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("GITHUB_APP_PRIVATE_KEY"), "{stderr}");
}

#[test]
fn it_refuses_the_committed_dev_app_key_against_anything_but_a_local_fake() {
    let dir = tempfile::tempdir().unwrap();
    for api in [
        None,
        Some("https://api.github.com"),
        Some("https://api.github.com/"),
        // GitHub Enterprise Server.
        Some("https://github.example.com/api/v3"),
        Some("http://127.0.0.1.example.com:3100"),
    ] {
        let env: Vec<_> = valid_env(dir.path(), 1)
            .into_iter()
            .filter(|(k, _)| *k != "GITHUB_API_URL")
            .chain(api.map(|a| ("GITHUB_API_URL", a.to_owned())))
            .collect();
        let out = beghu(&env).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{api:?}: {out:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("GITHUB_APP_PRIVATE_KEY is Fake GitHub's dev App key"),
            "{stderr}"
        );
    }
}

/// Starts `beghu` on a free port and waits for its first `/healthz` answer.
async fn running(dir: &std::path::Path) -> (Running, u16, reqwest::Response) {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Running(
        beghu(&valid_env(dir, port))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let http = reqwest::Client::new();
    let started = Instant::now();
    let res = loop {
        if let Ok(res) = http
            .get(format!("http://localhost:{port}/healthz"))
            .send()
            .await
        {
            break res;
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            child.fail(&format!("beghu exited with {status}"));
        }
        if started.elapsed() > Duration::from_secs(20) {
            child.fail("no /healthz in 20 s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    (child, port, res)
}

#[tokio::test(flavor = "multi_thread")]
async fn with_a_valid_environment_it_serves_healthz() {
    let dir = tempfile::tempdir().unwrap();
    let (_child, _, res) = running(dir.path()).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-beghu-build"], "smoke");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["build"], "smoke");
}

/// What a platform's stop sends: SIGTERM, with nothing in flight, ends the process cleanly well
/// inside the drain, the control DB's WAL folded into its file.
#[tokio::test(flavor = "multi_thread")]
async fn sigterm_stops_it_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let (mut child, _, _) = running(dir.path()).await;
    let killed = Command::new("kill")
        .args(["-TERM", &child.0.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(10) {
            child.fail("still running 10 s after SIGTERM");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(status.success(), "{status}");
    let wal = dir.path().join("data").join("control.db-wal");
    assert_eq!(std::fs::metadata(&wal).map_or(0, |m| m.len()), 0);
}

#[test]
fn it_refuses_an_empty_webhook_secret_however_it_is_given() {
    let dir = tempfile::tempdir().unwrap();
    let blank = dir.path().join("blank-secret");
    std::fs::write(&blank, " \n\t\n").unwrap();
    let without_secret = || {
        valid_env(dir.path(), 1)
            .into_iter()
            .filter(|(k, _)| *k != "GITHUB_WEBHOOK_SECRET")
            .collect::<Vec<_>>()
    };
    let mut from_file = without_secret();
    from_file.push(("GITHUB_WEBHOOK_SECRET_FILE", blank.display().to_string()));
    let mut from_env = without_secret();
    from_env.push(("GITHUB_WEBHOOK_SECRET", "  ".into()));
    // An empty key would make every HMAC forgeable: refuse to start, naming the variable.
    for env in [from_file, from_env] {
        let out = beghu(&env).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{out:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("GITHUB_WEBHOOK_SECRET"), "{stderr}");
    }
}
