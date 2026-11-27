//! The beghu CLI's side of the server through its HTTP surface: the device flow and its codes,
//! the credential's life (90 days unused, dormancy, Disconnect, Revoke), the floor every CLI call
//! is held to (`426`, `409`, mid-run included), CLI runs, and the CLI's builds each deployment
//! serves. The CLI binary's own tests (`crates/cli/tests/`) drive the same through `beghu`.

mod common;

use common::*;
use serde_json::{Value, json};
use std::time::Duration;

/// `POST` a JSON body to the CLI's routes as the CLI sends it (its `User-Agent`), with `token`.
async fn cli_post(s: &Stack, path: &str, body: Value, token: Option<&str>) -> (u16, Value) {
    let mut req = s
        .http
        .post(format!("{}{path}", s.server))
        .header("user-agent", format!("beghu-cli/{}", beghu_server::MIN_CLI))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

async fn cli_get(s: &Stack, path: &str, ua: &str, token: Option<&str>) -> (u16, Value) {
    let mut req = s
        .http
        .get(format!("{}{path}", s.server))
        .header("user-agent", ua);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// A started `beghu login`: its answer.
async fn login(s: &Stack, name: &str) -> Value {
    let (status, started) = cli_post(s, "/api/cli/login", json!({ "name": name }), None).await;
    assert_eq!(status, 201, "{started}");
    started
}

async fn poll(s: &Stack, device: &str) -> (u16, Value) {
    cli_post(s, "/api/cli/login/poll", json!({ "device": device }), None).await
}

/// A CLI credential for `b`'s account, through the whole device flow.
async fn credential(s: &Stack, b: &Browser) -> String {
    let started = login(s, "a machine").await;
    let code = started["code"].as_str().unwrap();
    assert_eq!(s.decide_cli_login(b, code, true).await, 204);
    let (status, approved) = poll(s, started["device"].as_str().unwrap()).await;
    assert_eq!(status, 200, "{approved}");
    approved["token"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn the_device_flow_mints_a_credential_once_approved() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let started = login(&s, "  laptop  ").await;
    let (code, device) = (
        started["code"].as_str().unwrap(),
        started["device"].as_str().unwrap(),
    );
    // Eight letters with no vowels or look-alikes, shown in two fours.
    assert_eq!(code.len(), 9, "{started}");
    assert!(
        code.chars()
            .all(|c| c == '-' || "BCDFGHJKLMNPQRSTVWXZ".contains(c)),
        "{code}"
    );
    assert_eq!(
        started["url"],
        format!("{}/cli/login?code={code}", s.server)
    );
    assert_eq!(started["interval"], 1);
    assert_eq!(started["expiresIn"], 600);

    // Waiting.
    let (status, _) = poll(&s, device).await;
    assert_eq!(status, 202);

    // The confirm page reads it as typed: lower case, no dash. Only for a signed-in browser.
    let typed = code.replace('-', "").to_lowercase();
    let (status, shown) = s.api(&mut b, &format!("/api/cli/codes/{typed}")).await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!(
        (
            shown["code"].as_str(),
            shown["name"].as_str(),
            shown["state"].as_str()
        ),
        (Some(code), Some("laptop"), Some("pending"))
    );
    let (status, _) = s
        .api(&mut Browser::default(), &format!("/api/cli/codes/{code}"))
        .await;
    assert_eq!(status, 401);
    let (status, _) = s.api(&mut b, "/api/cli/codes/AAAA-AAAA").await;
    assert_eq!(status, 404, "not a code");

    assert_eq!(s.decide_cli_login(&b, &typed, true).await, 204);
    // Decided once.
    assert_eq!(s.decide_cli_login(&b, code, false).await, 404);
    let (status, approved) = poll(&s, device).await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["account"], "tomsj");
    let token = approved["token"].as_str().unwrap();
    assert!(token.starts_with("beghu_cli_"), "{token}");
    assert_eq!(token.len(), "beghu_cli_".len() + 43, "256 bits, base64url");
    // The poll that minted it ended the login.
    let (status, gone) = poll(&s, device).await;
    assert_eq!(
        (status, gone["error"].as_str()),
        (410, Some("login_expired"))
    );

    // Only its hash is stored.
    assert!(!contains(&db_bytes(&s.control_db()), token.as_bytes()));
    let (status, st) = cli_get(&s, "/api/cli/status", "beghu-cli/0.1.0", Some(token)).await;
    assert_eq!(status, 200, "{st}");
    assert_eq!(st["account"]["login"], "tomsj");
    assert_eq!(st["build"], BUILD);
}

#[tokio::test]
async fn a_denied_or_expired_login_ends_without_a_credential() {
    let s = start_with(|c| c.cli.login_for = Duration::from_secs(2)).await;
    let b = s.sign_in("tomsj").await;

    let denied = login(&s, "x").await;
    assert_eq!(
        s.decide_cli_login(&b, denied["code"].as_str().unwrap(), false)
            .await,
        204
    );
    let (status, body) = poll(&s, denied["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_denied"))
    );

    let expiring = login(&s, "y").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        s.decide_cli_login(&b, expiring["code"].as_str().unwrap(), true)
            .await,
        404
    );
    let (status, body) = poll(&s, expiring["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_expired"))
    );
}

#[tokio::test]
async fn every_cli_call_is_held_to_the_floor_mid_run_included() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let token = credential(&s, &b).await;

    // What the host says of itself: its floor is no newer than the CLI it serves (MIN_CLI and
    // crates/cli/Cargo.toml).
    let (status, st) = cli_get(&s, "/api/cli/status", "curl/8", None).await;
    assert_eq!(status, 200, "{st}");
    assert_eq!(st["account"], Value::Null);
    let v = |s: &str| beghu_server::CliVersion::parse(s).unwrap();
    assert_eq!(st["minCli"], beghu_server::MIN_CLI);
    assert!(v(st["minCli"].as_str().unwrap()) <= v(st["cliVersion"].as_str().unwrap()));

    let (status, started) = cli_post(
        &s,
        "/api/cli/runs",
        json!({ "owner": "AdvanGrid", "repo": "beghu", "number": RECORDED }),
        Some(&token),
    )
    .await;
    assert_eq!(status, 201, "{started}");
    let run = started["token"].as_str().unwrap();
    let file = format!("/api/runs/{run}/pr.json");

    // An older CLI, mid-run: told the floor and how to update.
    let (status, old) = cli_get(&s, &file, "beghu-cli/0.0.9", Some(&token)).await;
    assert_eq!((status, old["error"].as_str()), (426, Some("cli_too_old")));
    assert_eq!(old["minimum"], beghu_server::MIN_CLI);
    assert!(
        old["message"]
            .as_str()
            .unwrap()
            .contains(&format!("curl -fsSL {}/cli/install.sh | sh", s.server)),
        "{old}"
    );
    // A newer one: told the server's.
    let (status, new) = cli_get(&s, &file, "beghu-cli/99.0.0", Some(&token)).await;
    assert_eq!((status, new["error"].as_str()), (409, Some("cli_too_new")));
    assert_eq!(new["server"], st["cliVersion"]);
    // The run survives: the right CLI carries on in it.
    let ua = format!("beghu-cli/{}", st["cliVersion"].as_str().unwrap());
    let (status, pinned) = cli_get(&s, &file, &ua, Some(&token)).await;
    assert_eq!(status, 200, "{pinned}");
    assert_eq!(pinned["number"], RECORDED);
    // A CLI run's calls need the CLI's credential of its account, before anything else.
    let (status, body) = cli_get(&s, &file, &ua, None).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (401, Some("bad_credential"))
    );
    let ilze = s.sign_in("ilze-k").await;
    let other = credential(&s, &ilze).await;
    let (status, body) = cli_get(&s, &file, &ua, Some(&other)).await;
    assert_eq!((status, body["error"].as_str()), (401, Some("bad_token")));
}

#[tokio::test]
async fn a_cli_runs_instructions_name_its_commands() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let token = credential(&s, &b).await;
    let (status, started) = cli_post(
        &s,
        "/api/cli/runs",
        json!({ "owner": "AdvanGrid", "repo": "beghu", "number": RECORDED }),
        Some(&token),
    )
    .await;
    assert_eq!(status, 201, "{started}");
    let (run, id) = (
        started["token"].as_str().unwrap(),
        started["run"].as_str().unwrap(),
    );
    assert!(
        started["sizeLine"].as_str().unwrap().contains(" files, +"),
        "{started}"
    );
    let text = s
        .http
        .get(format!("{}/api/runs/{run}/instructions", s.server))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(text.contains(&format!("`.beghu/run-{id}/`")), "{text}");
    assert!(
        text.contains("`beghu analyse check analysis.json`"),
        "{text}"
    );
    assert!(!text.contains("/api/runs/"), "{text}");

    // Without a credential there's no CLI run to start; for a PR that isn't there, a 404.
    let (status, body) = cli_post(
        &s,
        "/api/cli/runs",
        json!({ "owner": "AdvanGrid", "repo": "beghu", "number": RECORDED }),
        None,
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (401, Some("bad_credential"))
    );
    let (status, _) = cli_post(
        &s,
        "/api/cli/runs",
        json!({ "owner": "AdvanGrid", "repo": "nope", "number": 1 }),
        Some(&token),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_credential_lives_until_unused_for_its_lifetime() {
    let s = start_with(|c| c.cli.unused_for = Duration::from_secs(4)).await;
    let mut b = s.sign_in("tomsj").await;
    let token = credential(&s, &b).await;
    let (_, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    assert_eq!(list[0]["name"], "a machine", "{list}");
    assert_eq!(
        list[0]["expiresAt"].as_i64().unwrap() - list[0]["lastUsedAt"].as_i64().unwrap(),
        4
    );
    // Signing out in the browser leaves it.
    s.post_form(&mut b, "/auth/logout", &[("all", "1")]).await;
    let (status, _) = cli_get(&s, "/api/cli/status", "curl/8", Some(&token)).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let (status, body) = cli_get(&s, "/api/cli/status", "curl/8", Some(&token)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (401, Some("bad_credential"))
    );
}

#[tokio::test]
async fn a_credential_dies_with_its_account_at_dormancy_and_disconnect() {
    let s = start_with(|c| {
        c.accounts_check_every = Duration::from_millis(100);
        c.dormant_after = Duration::from_secs(3);
        c.activity_every = Duration::ZERO;
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let id = s.api(&mut b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let token = credential(&s, &b).await;
    // A CLI call is the account's use, as a browser's is: wait without one.
    let mirror = s.data.join("mirrors").join(format!("{id}.db"));
    until(15.0, "the account dormant", || async {
        (!mirror.exists()).then_some(())
    })
    .await;
    let (status, body) = cli_get(&s, "/api/cli/status", "curl/8", Some(&token)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (401, Some("bad_credential"))
    );

    let mut ilze = s.sign_in("ilze-k").await;
    let theirs = credential(&s, &ilze).await;
    let me = s.api(&mut ilze, "/api/me").await.1;
    let account = me["account"]["id"].as_i64().unwrap().to_string();
    let res = s
        .post_form(&mut ilze, "/auth/disconnect", &[("account", &account)])
        .await;
    assert_eq!(res.status(), 303);
    let (status, _) = cli_get(&s, "/api/cli/status", "curl/8", Some(&theirs)).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn revoke_is_the_accounts_own() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let token = credential(&s, &b).await;
    let mut ilze = s.sign_in("ilze-k").await;
    let (_, list) = s.api(&mut b, "/api/cli/sign-ins").await;
    let id = list[0]["id"].as_str().unwrap().to_owned();
    // Another account's Revoke does nothing to it, and its list doesn't show it.
    assert_eq!(s.api(&mut ilze, "/api/cli/sign-ins").await.1, json!([]));
    let res = s
        .api_write(
            &ilze,
            reqwest::Method::DELETE,
            &format!("/api/cli/sign-ins/{id}"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert_eq!(
        cli_get(&s, "/api/cli/status", "curl/8", Some(&token))
            .await
            .0,
        200
    );
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
    assert_eq!(
        cli_get(&s, "/api/cli/status", "curl/8", Some(&token))
            .await
            .0,
        401
    );
    // From another site's page, refused before anything else.
    let res = s
        .http
        .delete(format!("{}/api/cli/sign-ins/{id}", s.server))
        .header("cookie", b.header())
        .header("x-beghu-account", b.account())
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn each_deployment_serves_its_own_cli_builds() {
    // None: 404s, and the version it answers for is its own source's.
    let s = start().await;
    for path in [
        "/cli/manifest.json",
        "/cli/install.sh",
        "/cli/linux-x86_64/beghu",
    ] {
        let res = s
            .http
            .get(format!("{}{path}", s.server))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404, "{path}");
    }
    drop(s);

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("version"), "0.3.1\n").unwrap();
    for (p, bytes) in [
        ("linux-x86_64", b"linux".as_slice()),
        ("macos-aarch64", b"mac"),
    ] {
        std::fs::create_dir_all(dir.path().join(p)).unwrap();
        std::fs::write(dir.path().join(p).join("beghu"), bytes).unwrap();
    }
    let at = dir.path().to_owned();
    let s = start_with(move |c| c.cli_dir = Some(at)).await;
    let res = s
        .http
        .get(format!("{}/cli/manifest.json", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-cache");
    let m: Value = res.json().await.unwrap();
    assert_eq!(
        m,
        json!({
            "version": "0.3.1",
            "build": BUILD,
            "binaries": {
                "linux-x86_64": {
                    "url": "/cli/linux-x86_64/beghu",
                    // sha256("linux")
                    "sha256": "caf90169eefa5f807d577486b9f795ab86ae2983c5c20806cff959117e90af18",
                    "size": 5,
                },
                "macos-aarch64": {
                    "url": "/cli/macos-aarch64/beghu",
                    "sha256": m["binaries"]["macos-aarch64"]["sha256"],
                    "size": 3,
                },
            },
        })
    );
    let res = s
        .http
        .get(format!("{}/cli/macos-aarch64/beghu", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    assert_eq!(res.headers()["cache-control"], "no-cache");
    assert_eq!(&res.bytes().await.unwrap()[..], b"mac");
    // Not built: not there.
    let res = s
        .http
        .get(format!("{}/cli/linux-aarch64/beghu", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    // The install script names this host and every build's SHA-256, and the WSL way on Windows.
    let sh = s
        .http
        .get(format!("{}/cli/install.sh", s.server))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(sh.starts_with("#!/bin/sh\n"), "{sh}");
    assert!(sh.contains(&format!("host='{}'", s.server)), "{sh}");
    assert!(sh.contains(m["binaries"]["macos-aarch64"]["sha256"].as_str().unwrap()));
    assert!(sh.contains("WSL"), "{sh}");
    assert!(
        sh.contains(&format!("beghu login --host {}", s.server)),
        "{sh}"
    );
    // The CLI it answers for is the one it serves.
    let (_, st) = cli_get(&s, "/api/cli/status", "curl/8", None).await;
    assert_eq!(st["cliVersion"], "0.3.1");
}

#[tokio::test]
async fn a_cli_dir_without_its_version_refuses_startup() {
    let mut s = start().await;
    let dir = tempfile::tempdir().unwrap();
    let at = dir.path().to_owned();
    let err = s
        .try_restart_with(move |c| c.cli_dir = Some(at))
        .await
        .unwrap_err();
    assert!(err.contains("BEGHU_CLI_DIR"), "{err}");
}

/// `POST /api/cli/login` as the CLI sends it, through an edge that says it came from `from`
/// (`header: value`): the whole answer.
async fn login_from(s: &Stack, name: &str, from: Option<(&str, &str)>) -> reqwest::Response {
    let mut req = s
        .http
        .post(format!("{}/api/cli/login", s.server))
        .header("user-agent", format!("beghu-cli/{}", beghu_server::MIN_CLI))
        .json(&json!({ "name": name }));
    if let Some((h, v)) = from {
        req = req.header(h, v);
    }
    req.send().await.unwrap()
}

/// A `429`'s `Retry-After`, in seconds.
fn retry_after(res: &reqwest::Response) -> u64 {
    res.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

/// With `BEGHU_CLIENT_IP_HEADER` set.
async fn start_counting_by(header: &'static str) -> Stack {
    start_with(|c| c.cli.client_ip_header = Some(header.parse().unwrap())).await
}

#[tokio::test]
async fn too_many_logins_waiting_from_one_client_are_refused_until_one_ends() {
    let s = start_counting_by("cf-connecting-ip").await;
    let b = s.sign_in("tomsj").await;
    let me = Some(("CF-Connecting-IP", "203.0.113.7"));
    let mut first = None;
    for i in 0..20 {
        let res = login_from(&s, &format!("machine {i}"), me).await;
        assert_eq!(res.status(), 201);
        first.get_or_insert(res.json::<Value>().await.unwrap());
    }
    let res = login_from(&s, "one too many", me).await;
    assert_eq!(res.status(), 429);
    // Until the oldest of them expires: at most a login's life (10 minutes).
    let wait = retry_after(&res);
    assert!((1..=600).contains(&wait), "{wait}");
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"], "too_many_logins", "{body}");
    // Another client isn't held back by this one, though both reach beghu from one peer.
    let other = Some(("CF-Connecting-IP", "198.51.100.1"));
    assert_eq!(login_from(&s, "another client", other).await.status(), 201);

    // One ended by its poll (denied here) makes room for one more.
    let first = first.unwrap();
    assert_eq!(
        s.decide_cli_login(&b, first["code"].as_str().unwrap(), false)
            .await,
        204
    );
    assert_eq!(poll(&s, first["device"].as_str().unwrap()).await.0, 410);
    assert_eq!(login_from(&s, "now there's room", me).await.status(), 201);
    assert_eq!(login_from(&s, "and full again", me).await.status(), 429);
}

#[tokio::test]
async fn a_client_is_its_ipv6_64_or_the_last_forwarded_address() {
    // IPv6 by its /64: one host or home.
    let s = start_with(|c| {
        c.cli.client_ip_header = Some("fly-client-ip".parse().unwrap());
        c.cli.logins_per_client = 2;
    })
    .await;
    let v6 = |a| Some(("Fly-Client-IP", a));
    assert_eq!(
        login_from(&s, "a", v6("2001:db8:1:2::1")).await.status(),
        201
    );
    assert_eq!(
        login_from(&s, "b", v6("2001:db8:1:2:ffff::9"))
            .await
            .status(),
        201
    );
    assert_eq!(
        login_from(&s, "c", v6("2001:db8:1:2::3")).await.status(),
        429
    );
    assert_eq!(
        login_from(&s, "d", v6("2001:db8:1:3::1")).await.status(),
        201
    );

    // X-Forwarded-For's last address is the edge's: the ones before it are the caller's to
    // forge, so changing them makes no new client.
    let s = start_with(|c| {
        c.cli.client_ip_header = Some("x-forwarded-for".parse().unwrap());
        c.cli.logins_per_client = 2;
    })
    .await;
    let xff = |a| Some(("X-Forwarded-For", a));
    assert_eq!(
        login_from(&s, "a", xff("10.0.0.1, 203.0.113.7"))
            .await
            .status(),
        201
    );
    assert_eq!(
        login_from(&s, "b", xff("10.0.0.2, 203.0.113.7"))
            .await
            .status(),
        201
    );
    assert_eq!(login_from(&s, "c", xff("203.0.113.7")).await.status(), 429);
    assert_eq!(
        login_from(&s, "d", xff("203.0.113.7, 203.0.113.8"))
            .await
            .status(),
        201
    );
    // Without a readable address, every such login is one client.
    assert_eq!(login_from(&s, "e", None).await.status(), 201);
    assert_eq!(
        login_from(&s, "f", xff("not an address")).await.status(),
        201
    );
    assert_eq!(login_from(&s, "g", None).await.status(), 429);
}

#[tokio::test]
async fn without_a_client_header_only_the_global_cap_holds_and_no_header_is_read() {
    // Unset, many logins from one client are let in: behind a proxy, beghu can't tell clients
    // apart, and a header naming a client is the caller's to forge.
    let s = start().await;
    let me = Some(("X-Forwarded-For", "203.0.113.7"));
    for i in 0..25 {
        let res = login_from(&s, &format!("machine {i}"), me).await;
        assert_eq!(res.status(), 201, "login {i}");
    }

    // The global cap holds for everyone, whatever address each one claims.
    let s = start_with(|c| {
        c.cli.logins_at_once = 2;
        c.cli.logins_per_client = 1;
    })
    .await;
    let claim = |a| Some(("CF-Connecting-IP", a));
    assert_eq!(
        login_from(&s, "a", claim("203.0.113.7")).await.status(),
        201
    );
    // A per-client cap of 1 isn't applied: there are no clients.
    assert_eq!(
        login_from(&s, "b", claim("203.0.113.7")).await.status(),
        201
    );
    let res = login_from(&s, "c", claim("198.51.100.1")).await;
    assert_eq!(res.status(), 429);
    assert!(retry_after(&res) >= 1);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"], "too_many_logins", "{body}");
}

#[tokio::test]
async fn a_browser_that_tries_too_many_wrong_codes_is_refused_for_a_while() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let real = login(&s, "a machine").await;
    let code = real["code"].as_str().unwrap();
    // A live login's code doesn't count.
    for _ in 0..12 {
        let (status, _) = s.api(&mut b, &format!("/api/cli/codes/{code}")).await;
        assert_eq!(status, 200);
    }
    // Ten wrong ones: codes no login holds, and things that can't be codes.
    for i in 0..10 {
        let wrong = if i % 2 == 0 { "BBBB-BBBB" } else { "nope" };
        let (status, _) = s.api(&mut b, &format!("/api/cli/codes/{wrong}")).await;
        assert_eq!(status, 404, "wrong code {i}");
    }
    // The next is refused, the right code included, and so are Approve and Deny.
    let res = s.get(&mut b, &format!("/api/cli/codes/{code}")).await;
    assert_eq!(res.status(), 429);
    let wait = retry_after(&res);
    assert!((1..=600).contains(&wait), "{wait}");
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"], "too_many_codes", "{body}");
    assert_eq!(s.decide_cli_login(&b, code, true).await, 429);
    assert_eq!(s.decide_cli_login(&b, code, false).await, 429);
    // The account is held back in its other browsers too: a new session gets no new tries.
    let mut again = s.sign_in("tomsj").await;
    let (status, _) = s.api(&mut again, &format!("/api/cli/codes/{code}")).await;
    assert_eq!(status, 429);
    // Another account isn't held back by this one's guesses.
    let mut other = s.sign_in("ilze-k").await;
    let (status, shown) = s.api(&mut other, &format!("/api/cli/codes/{code}")).await;
    assert_eq!((status, shown["state"].as_str()), (200, Some("pending")));
}

#[tokio::test]
async fn wrong_codes_asked_at_once_are_held_to_the_limit() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    // Forty at once: each holds its place in the count while it's answered, so exactly the ten
    // the limit allows get an answer.
    let asks = (0..40).map(|_| {
        s.http
            .get(format!("{}/api/cli/codes/BBBB-BBBB", s.server))
            .header("cookie", b.header())
            .send()
    });
    let mut statuses: Vec<u16> = futures_util::future::join_all(asks)
        .await
        .into_iter()
        .map(|r| r.unwrap().status().as_u16())
        .collect();
    statuses.sort_unstable();
    assert_eq!(
        statuses.iter().filter(|s| **s == 404).count(),
        10,
        "{statuses:?}"
    );
    assert_eq!(
        statuses.iter().filter(|s| **s == 429).count(),
        30,
        "{statuses:?}"
    );
}

#[tokio::test]
async fn a_machines_name_loses_its_control_and_bidi_characters() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let started = login(
        &s,
        "  build\u{202E}gpj.exe\n\t box \u{7}\u{2066}1\u{2069}  ",
    )
    .await;
    let (status, shown) = s
        .api(
            &mut b,
            &format!("/api/cli/codes/{}", started["code"].as_str().unwrap()),
        )
        .await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!(shown["name"], "buildgpj.exe box 1");
    // When it started, for the confirm page.
    let created = shown["createdAt"].as_i64().unwrap();
    assert_eq!(shown["expiresAt"].as_i64().unwrap() - created, 600);
    // Nothing printable left: it's named for what it is.
    let blank = login(&s, "\u{202E}\u{200F}\n").await;
    let (_, shown) = s
        .api(
            &mut b,
            &format!("/api/cli/codes/{}", blank["code"].as_str().unwrap()),
        )
        .await;
    assert_eq!(shown["name"], "unnamed machine");
}

#[tokio::test]
async fn an_approved_login_whose_account_disconnected_or_lost_access_mints_nothing() {
    let s = start().await;
    // Approved, then Disconnect before the CLI's next poll: the login ends with the account.
    let mut ilze = s.sign_in("ilze-k").await;
    let started = login(&s, "ilze's laptop").await;
    assert_eq!(
        s.decide_cli_login(&ilze, started["code"].as_str().unwrap(), true)
            .await,
        204
    );
    let account = s.api(&mut ilze, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap()
        .to_string();
    let res = s
        .post_form(&mut ilze, "/auth/disconnect", &[("account", &account)])
        .await;
    assert_eq!(res.status(), 303);
    // Signed in again before the poll: the account is active, and the login still mints nothing.
    let mut ilze = s.sign_in("ilze-k").await;
    assert_eq!(s.api(&mut ilze, "/api/me").await.0, 200);
    let (status, body) = poll(&s, started["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_account_gone"))
    );
    // The login is over.
    let (status, body) = poll(&s, started["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_expired"))
    );

    // Approved, then the account must sign in again (its grant revoked on GitHub): the poll
    // refuses to mint for it.
    let b = s.sign_in("tomsj").await;
    let started = login(&s, "tomsj's laptop").await;
    assert_eq!(
        s.decide_cli_login(&b, started["code"].as_str().unwrap(), true)
            .await,
        204
    );
    s.fake("POST", "/revoke", json!({ "login": "tomsj" })).await;
    until(10.0, "tomsj signed out by the revoke", || {
        let mut b = b.clone();
        let s = &s;
        async move { (s.api(&mut b, "/api/me").await.0 == 401).then_some(()) }
    })
    .await;
    let (status, body) = poll(&s, started["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_account_gone"))
    );
    // The login is over.
    let (status, _) = poll(&s, started["device"].as_str().unwrap()).await;
    assert_eq!(status, 410);
}

#[tokio::test]
async fn an_approved_login_whose_account_went_dormant_mints_nothing() {
    let s = start_with(|c| {
        c.accounts_check_every = Duration::from_millis(100);
        c.dormant_after = Duration::from_secs(3);
        c.activity_every = Duration::ZERO;
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let id = s.api(&mut b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let started = login(&s, "a machine").await;
    assert_eq!(
        s.decide_cli_login(&b, started["code"].as_str().unwrap(), true)
            .await,
        204
    );
    let mirror = s.data.join("mirrors").join(format!("{id}.db"));
    until(15.0, "the account dormant", || async {
        (!mirror.exists()).then_some(())
    })
    .await;
    let (status, body) = poll(&s, started["device"].as_str().unwrap()).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("login_account_gone"))
    );
}
