//! `beghu login`, `beghu logout` and `beghu status`, and which host and credential a call uses:
//! `--host`, else `BEGHU_HOST`, else the active host (the last one signed in to), else the hosted
//! one; and `BEGHU_TOKEN`, else that host's entry in the credentials file.

use crate::http::{self, Api};
use crate::store::{Credentials, SignIn, credentials_path};
use crate::{Args, DEFAULT_HOST, Fail};
use serde::Deserialize;
use std::time::Duration;

/// The credentials file and what it holds.
pub fn credentials() -> Result<(std::path::PathBuf, Credentials), Fail> {
    let path = credentials_path().map_err(Fail::Msg)?;
    let c = Credentials::load(&path).map_err(Fail::Msg)?;
    Ok((path, c))
}

/// The host a call goes to.
pub fn host_for(flag: Option<&str>, c: &Credentials) -> Result<String, Fail> {
    let env = std::env::var("BEGHU_HOST")
        .ok()
        .filter(|h| !h.trim().is_empty());
    let raw = flag
        .map(str::to_owned)
        .or(env)
        .or_else(|| c.active.clone())
        .unwrap_or_else(|| DEFAULT_HOST.to_owned());
    http::host(&raw)
}

/// Where a credential came from.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum From {
    Env,
    File,
}

/// The credential for `host`: `BEGHU_TOKEN`, else the file's.
pub fn token_for(host: &str, c: &Credentials) -> Option<(String, From)> {
    if let Some(t) = std::env::var("BEGHU_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty())
    {
        return Some((t.trim().to_owned(), From::Env));
    }
    c.hosts.get(host).map(|s| (s.token.clone(), From::File))
}

/// An API for `host` with its credential: refused when there's none.
pub fn signed_in_api(host: &str, c: &Credentials) -> Result<Api, Fail> {
    match token_for(host, c) {
        Some((t, _)) => Api::new(host, Some(t)),
        None => Err(Fail::msg(format!(
            "not signed in to {host}: run `beghu login{}` first, or set BEGHU_TOKEN",
            host_flag(host)
        ))),
    }
}

/// ` --host URL`, unless `host` is the hosted beghu.
pub fn host_flag(host: &str) -> String {
    if host == DEFAULT_HOST {
        String::new()
    } else {
        format!(" --host {host}")
    }
}

/// A call answered `401 bad_credential`: the sign-in is dead on the server. The file's entry for
/// it goes (`BEGHU_TOKEN`'s is the environment's to change).
pub fn signed_out(host: &str) {
    let cmd = format!("beghu login{}", host_flag(host));
    let from_env = std::env::var("BEGHU_TOKEN").is_ok_and(|t| !t.trim().is_empty());
    if from_env {
        eprintln!(
            "beghu: signed out on the server: BEGHU_TOKEN was revoked or has expired; run `{cmd}` for a new one"
        );
        return;
    }
    eprintln!("beghu: signed out on the server; run `{cmd}`");
    if let Ok((path, mut c)) = credentials()
        && c.hosts.remove(host).is_some()
        && let Err(e) = c.save(&path)
    {
        eprintln!("beghu: {e}");
    }
}

/// This machine's name, as `--name` defaults it: its hostname.
fn hostname() -> String {
    let from_file = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|h| h.trim().to_owned());
    let name = from_file.filter(|h| !h.is_empty()).or_else(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .filter(|h| !h.is_empty())
    });
    name.unwrap_or_else(|| "unnamed machine".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStarted {
    device: String,
    code: String,
    url: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Approved {
    token: String,
    account: String,
    expires_at: i64,
}

/// Whether to open the browser here: not over SSH, and on Linux only with a display.
fn can_open_browser() -> bool {
    let ssh = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]
        .iter()
        .any(|v| std::env::var_os(v).is_some());
    if ssh {
        return false;
    }
    cfg!(target_os = "macos")
        || ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|v| std::env::var_os(v).is_some_and(|d| !d.is_empty()))
}

fn open_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// `beghu login [--host URL] [--no-browser] [--name NAME]`.
pub async fn login(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--host", "--name"], &["--no-browser"])?;
    if let Some(p) = a.pos.first() {
        return Err(Fail::usage(format!("login takes no {p:?}")));
    }
    let (path, mut c) = credentials()?;
    let host = host_for(a.opt("--host"), &c)?;
    let name = a.opt("--name").map(str::to_owned).unwrap_or_else(hostname);
    let api = Api::new(&host, None)?;
    let res = api
        .post_json("/api/cli/login", &serde_json::json!({ "name": name }))
        .await?;
    if res.status != 201 {
        return Err(Fail::msg(format!(
            "{host} didn't start a sign-in: {}",
            res.why()
        )));
    }
    let started: LoginStarted = res.json("signing in")?;
    println!(
        "To sign in the beghu CLI on {name:?} to {host}, approve it in a browser signed in to beghu:"
    );
    println!("  {}", started.url);
    println!("  It shows the code {}.", started.code);
    if !a.flag("--no-browser") && can_open_browser() && open_browser(&started.url) {
        println!("(Opened in your browser.)");
    }
    println!("Waiting for the approval\u{2026}");
    let deadline = std::time::Instant::now() + Duration::from_secs(started.expires_in);
    let every = Duration::from_secs(started.interval.max(1));
    let approved = loop {
        tokio::time::sleep(every).await;
        let res = api
            .post_json(
                "/api/cli/login/poll",
                &serde_json::json!({ "device": started.device }),
            )
            .await?;
        match res.status {
            200 => break res.json::<Approved>("signing in")?,
            202 => {}
            410 => return Err(Fail::msg(res.why())),
            _ => return Err(Fail::msg(format!("signing in: {}", res.why()))),
        }
        if std::time::Instant::now() >= deadline {
            return Err(Fail::msg(
                "the sign-in expired before it was approved: run `beghu login` again",
            ));
        }
    };
    // The sign-in this one replaces is revoked, if the host still knows it.
    if let Some(old) = c.hosts.get(&host)
        && let Ok(old_api) = Api::new(&host, Some(old.token.clone()))
    {
        let _ = old_api
            .post_json("/api/cli/logout", &serde_json::json!({}))
            .await;
    }
    c.hosts.insert(
        host.clone(),
        SignIn {
            token: approved.token,
            account: approved.account.clone(),
            expires: approved.expires_at,
        },
    );
    c.active = Some(host.clone());
    c.save(&path).map_err(Fail::Msg)?;
    println!("Signed in to {host} as {}.", approved.account);
    if std::env::var("BEGHU_TOKEN").is_ok_and(|t| !t.trim().is_empty()) {
        println!("BEGHU_TOKEN is set, and goes first: unset it to use this sign-in.");
    }
    Ok(())
}

/// `beghu logout [--host URL | --all]`: revokes each sign-in on its server, then forgets it here.
/// One whose server can't be reached is kept, and said so.
pub async fn logout(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--host"], &["--all"])?;
    if a.flag("--all") && a.opt("--host").is_some() {
        return Err(Fail::usage("give --host or --all, not both"));
    }
    let (path, mut c) = credentials()?;
    let hosts: Vec<String> = if a.flag("--all") {
        c.hosts.keys().cloned().collect()
    } else {
        vec![host_for(a.opt("--host"), &c)?]
    };
    if hosts.is_empty() {
        println!("Not signed in anywhere.");
        return Ok(());
    }
    let mut failed = false;
    for host in hosts {
        let token = if a.flag("--all") {
            c.hosts.get(&host).map(|s| (s.token.clone(), From::File))
        } else {
            token_for(&host, &c)
        };
        let Some((token, from)) = token else {
            println!("Not signed in to {host}.");
            continue;
        };
        let api = Api::new(&host, Some(token))?;
        match api
            .post_json("/api/cli/logout", &serde_json::json!({}))
            .await
        {
            Ok(r) if r.status == 204 => println!("Signed out of {host}."),
            // Dead already.
            Err(Fail::SignedOut { .. }) => println!("Signed out of {host} (it was already)."),
            Ok(r) => {
                eprintln!("beghu: {host} didn't sign this out: {}; kept here", r.why());
                failed = true;
                continue;
            }
            Err(Fail::Msg(m)) => {
                eprintln!("beghu: {m}; the sign-in is kept here (revoke it on the setup page)");
                failed = true;
                continue;
            }
            Err(e) => return Err(e),
        }
        if from == From::Env {
            println!("(That was BEGHU_TOKEN: unset it.)");
            continue;
        }
        c.hosts.remove(&host);
        if c.active.as_deref() == Some(host.as_str()) {
            c.active = None;
        }
    }
    c.save(&path).map_err(Fail::Msg)?;
    if failed { Err(Fail::Exit(1)) } else { Ok(()) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    account: Option<StatusAccount>,
    expires_at: Option<i64>,
    build: String,
    min_cli: String,
    cli_version: String,
    schema: u32,
}

#[derive(Deserialize)]
struct StatusAccount {
    login: String,
    status: String,
}

/// A Unix time as a UTC date: `2027-02-25`.
pub fn date(t: i64) -> String {
    // Howard Hinnant's days-to-civil.
    let z = t.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `beghu status [--host URL]`.
pub async fn status(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--host"], &[])?;
    let (path, mut c) = credentials()?;
    let host = host_for(a.opt("--host"), &c)?;
    let active = if c.active.as_deref() == Some(host.as_str()) {
        " (active)"
    } else {
        ""
    };
    println!("host:    {host}{active}");
    println!(
        "beghu:   {} (build {}, {})",
        http::VERSION,
        http::BUILD,
        http::platform()
    );
    println!("schema:  {}", analysis::VERSION);
    let token = token_for(&host, &c);
    let api = Api::new(&host, token.as_ref().map(|(t, _)| t.clone()))?;
    let res = api.get("/api/cli/status").await?;
    if res.status != 200 {
        return Err(Fail::msg(format!(
            "{host} isn't answering as a beghu does: {}",
            res.why()
        )));
    }
    let s: Status = res.json("status")?;
    match (&s.account, token) {
        (Some(acc), Some((_, from))) => {
            let via = if from == From::Env {
                ", from BEGHU_TOKEN"
            } else {
                ""
            };
            let expiry = s
                .expires_at
                .map(|t| format!("; the sign-in expires {} unless used", date(t)))
                .unwrap_or_default();
            println!("account: {}{via}{expiry}", acc.login);
            if acc.status != "active" {
                println!("         it must sign in to beghu again, in a browser");
            }
            if from == From::File
                && let (Some(e), Some(entry)) = (s.expires_at, c.hosts.get_mut(&host))
                && entry.expires != e
            {
                entry.expires = e;
                let _ = c.save(&path);
            }
        }
        _ => println!("account: not signed in (`beghu login{}`)", host_flag(&host)),
    }
    println!(
        "host's build: {}; it serves beghu {} and answers {} and newer (schema {})",
        s.build, s.cli_version, s.min_cli, s.schema
    );
    Ok(())
}
