//! Fake GitHub through its two HTTP surfaces: the GitHub side (OAuth web flow and REST) that
//! beghu talks to, and the control port that dev tooling and tests drive.

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::Digest as _;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CLIENT_ID: &str = "Iv1.test";
const CLIENT_SECRET: &str = "test-secret";
const CALLBACK: &str = "http://beghu.test/auth/callback";
const WEBHOOK_SECRET: &str = "test-webhook-secret";

/// The 1k fixture, generated once per test run.
fn fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached(
        fixture::Scale::K1,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

struct Fake {
    api: String,
    ctl: String,
    http: reqwest::Client,
    _dir: tempfile::TempDir,
}

async fn start() -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let cfg = fake_github::Config {
        fixture: fixture(),
        db: dir.path().join("truth.db"),
        client_id: CLIENT_ID.into(),
        client_secret: CLIENT_SECRET.into(),
        access_ttl: Duration::from_secs(8 * 3600),
        refresh_ttl: Duration::from_secs(15_897_600),
        webhook_url: None,
        webhook_secret: WEBHOOK_SECRET.into(),
        setup_url: None,
    };
    let fake = tokio::task::spawn_blocking(move || fake_github::Fake::open(cfg))
        .await
        .unwrap()
        .unwrap();
    let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ctl = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (api_addr, ctl_addr) = (api.local_addr().unwrap(), ctl.local_addr().unwrap());
    tokio::spawn(fake.serve(api, ctl));
    Fake {
        api: format!("http://{api_addr}"),
        ctl: format!("http://{ctl_addr}"),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        _dir: dir,
    }
}

fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier))
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    serde_urlencoded::from_str::<Vec<(String, String)>>(q)
        .unwrap()
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

impl Fake {
    fn authorize_url(&self, verifier: &str, extra: &str) -> String {
        format!(
            "{}/login/oauth/authorize?client_id={CLIENT_ID}&redirect_uri={}&state=st4te&code_challenge={}&code_challenge_method=S256{extra}",
            self.api,
            urlencode(CALLBACK),
            challenge(verifier)
        )
    }

    /// The authorize step for `login`, skipping the page: the code GitHub redirects back with.
    async fn code_for(&self, login: &str, verifier: &str) -> String {
        let res = self
            .http
            .get(self.authorize_url(verifier, &format!("&login={login}")))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 302);
        let to = res.headers()["location"].to_str().unwrap().to_owned();
        assert!(to.starts_with(CALLBACK), "{to}");
        assert_eq!(query_param(&to, "state").as_deref(), Some("st4te"));
        query_param(&to, "code").unwrap()
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Value {
        let mut all = vec![("client_id", CLIENT_ID), ("client_secret", CLIENT_SECRET)];
        all.extend_from_slice(form);
        let res = self
            .http
            .post(format!("{}/login/oauth/access_token", self.api))
            .header("accept", "application/json")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(serde_urlencoded::to_string(&all).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.json().await.unwrap()
    }

    async fn sign_in(&self, login: &str) -> Value {
        let code = self.code_for(login, "verifier-0123456789").await;
        self.token_request(&[
            ("code", &code),
            ("redirect_uri", CALLBACK),
            ("code_verifier", "verifier-0123456789"),
        ])
        .await
    }

    async fn refresh(&self, refresh_token: &Value) -> Value {
        self.token_request(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str().unwrap()),
        ])
        .await
    }

    async fn get(&self, path: &str, token: &Value) -> reqwest::Response {
        self.http
            .get(format!("{}{path}", self.api))
            .bearer_auth(token.as_str().unwrap())
            .send()
            .await
            .unwrap()
    }

    async fn login_of(&self, token: &Value) -> Option<String> {
        let res = self.get("/user", token).await;
        match res.status().as_u16() {
            200 => Some(res.json::<Value>().await.unwrap()["login"].as_str()?.into()),
            401 => None,
            s => panic!("GET /user: {s}"),
        }
    }

    async fn control(&self, method: reqwest::Method, path: &str, body: Value) -> Value {
        let res = self
            .http
            .request(method, format!("{}{path}", self.ctl))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{path}: {}", res.status());
        res.json().await.unwrap()
    }

    async fn state(&self) -> Value {
        self.http
            .get(format!("{}/state", self.ctl))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

fn urlencode(s: &str) -> String {
    serde_urlencoded::to_string([("", s)]).unwrap()[1..].to_owned()
}

#[tokio::test]
async fn the_authorize_page_lists_the_fixture_accounts_and_signs_in_the_one_picked() {
    let fake = start().await;
    let page = fake
        .http
        .get(fake.authorize_url("verifier-0123456789", ""))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    let html = page.text().await.unwrap();
    for login in ["tomsj", "ilze-k", "octo-ext"] {
        assert!(html.contains(&format!("login={login}")), "{login}: {html}");
    }

    let tokens = fake.sign_in("ilze-k").await;
    assert_eq!(tokens["token_type"], "bearer");
    assert_eq!(tokens["expires_in"], 28800);
    assert_eq!(tokens["refresh_token_expires_in"], 15_897_600);
    assert!(tokens["access_token"].as_str().unwrap().starts_with("ghu_"));
    assert!(
        tokens["refresh_token"]
            .as_str()
            .unwrap()
            .starts_with("ghr_")
    );
    assert_eq!(
        fake.login_of(&tokens["access_token"]).await.as_deref(),
        Some("ilze-k")
    );
}

#[tokio::test]
async fn a_code_works_once_and_only_with_its_pkce_verifier() {
    let fake = start().await;
    let code = fake.code_for("tomsj", "the-right-verifier-123").await;
    let wrong = fake
        .token_request(&[("code", &code), ("code_verifier", "another-verifier-456")])
        .await;
    assert_eq!(wrong["error"], "bad_verification_code");

    let code = fake.code_for("tomsj", "the-right-verifier-123").await;
    let ok = fake
        .token_request(&[("code", &code), ("code_verifier", "the-right-verifier-123")])
        .await;
    assert!(ok["access_token"].is_string(), "{ok}");
    let again = fake
        .token_request(&[("code", &code), ("code_verifier", "the-right-verifier-123")])
        .await;
    assert_eq!(again["error"], "bad_verification_code");

    let bad_secret = fake
        .http
        .post(format!("{}/login/oauth/access_token", fake.api))
        .header("accept", "application/json")
        .json(&json!({ "client_id": CLIENT_ID, "client_secret": "nope", "code": "x" }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(bad_secret["error"], "incorrect_client_credentials");
}

#[tokio::test]
async fn a_plain_pkce_challenge_never_redeems_since_github_only_does_s256() {
    let fake = start().await;
    let verifier = "plain-verifier-0123456789";
    let url = format!(
        "{}/login/oauth/authorize?client_id={CLIENT_ID}&redirect_uri={}&code_challenge={verifier}&code_challenge_method=plain&login=tomsj",
        fake.api,
        urlencode(CALLBACK),
    );
    let res = fake.http.get(url).send().await.unwrap();
    let to = res.headers()["location"].to_str().unwrap().to_owned();
    let code = query_param(&to, "code").unwrap();
    let out = fake
        .token_request(&[("code", &code), ("code_verifier", verifier)])
        .await;
    assert_eq!(out["error"], "bad_verification_code", "{out}");
}

#[tokio::test]
async fn a_refresh_token_is_single_use_and_retires_the_old_access_token() {
    let fake = start().await;
    let first = fake.sign_in("tomsj").await;
    let second = fake.refresh(&first["refresh_token"]).await;
    assert!(second["access_token"].is_string(), "{second}");
    assert_ne!(second["access_token"], first["access_token"]);
    assert_ne!(second["refresh_token"], first["refresh_token"]);

    assert_eq!(fake.login_of(&first["access_token"]).await, None);
    assert_eq!(
        fake.login_of(&second["access_token"]).await.as_deref(),
        Some("tomsj")
    );
    let reused = fake.refresh(&first["refresh_token"]).await;
    assert_eq!(reused["error"], "bad_refresh_token");
    assert!(reused.get("access_token").is_none());
    let third = fake.refresh(&second["refresh_token"]).await;
    assert!(third["access_token"].is_string(), "{third}");
    assert_eq!(
        fake.state().await["refreshes"],
        json!({ "ok": 2, "reused": 1 }),
        "the control port counts a spent refresh token coming back"
    );
    fake.control(reqwest::Method::POST, "/reset", json!({}))
        .await;
    assert_eq!(
        fake.state().await["refreshes"],
        json!({ "ok": 0, "reused": 0 })
    );
}

#[tokio::test]
async fn token_lifetimes_set_at_runtime_apply_to_new_tokens_and_expire_them_on_the_fake_clock() {
    // Lifetimes far longer than the test can take in real time, however loaded the machine:
    // only the fake's clock crosses them.
    const HOUR: i64 = 3600;
    const DAY: i64 = 24 * HOUR;
    let fake = start().await;
    fake.control(
        reqwest::Method::PUT,
        "/tokens",
        json!({ "access_ttl": HOUR, "refresh_ttl": DAY }),
    )
    .await;
    let a = fake.sign_in("tomsj").await;
    let b = fake.sign_in("tomsj").await;
    assert_eq!(a["expires_in"], HOUR);
    assert_eq!(a["refresh_token_expires_in"], DAY);
    assert_eq!(
        fake.login_of(&a["access_token"]).await.as_deref(),
        Some("tomsj")
    );

    // The fake's clock moves on: past the access tokens, well inside the refresh tokens.
    let past_access = 2 * HOUR;
    fake.control(
        reqwest::Method::PUT,
        "/clock",
        json!({ "offset": past_access }),
    )
    .await;
    assert_eq!(
        fake.state().await["clock"],
        json!({ "offset": past_access })
    );
    assert_eq!(fake.login_of(&a["access_token"]).await, None);
    assert!(fake.refresh(&b["refresh_token"]).await["access_token"].is_string());

    // And past the refresh tokens too.
    fake.control(reqwest::Method::PUT, "/clock", json!({ "offset": 2 * DAY }))
        .await;
    assert_eq!(
        fake.refresh(&a["refresh_token"]).await["error"],
        "bad_refresh_token"
    );
    fake.control(reqwest::Method::POST, "/reset", json!({}))
        .await;
    assert_eq!(fake.state().await["clock"], json!({ "offset": 0 }));
}

#[tokio::test]
async fn revoking_the_grant_ends_every_token_and_the_sign_in() {
    let fake = start().await;
    let tokens = fake.sign_in("ilze-k").await;
    fake.sign_in("tomsj").await;
    assert_eq!(fake.state().await["signed_in"], json!(["ilze-k", "tomsj"]));

    let res = fake
        .http
        .delete(format!("{}/applications/{CLIENT_ID}/grant", fake.api))
        .basic_auth(CLIENT_ID, Some(CLIENT_SECRET))
        .json(&json!({ "access_token": tokens["access_token"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    assert_eq!(fake.login_of(&tokens["access_token"]).await, None);
    assert_eq!(
        fake.refresh(&tokens["refresh_token"]).await["error"],
        "bad_refresh_token"
    );
    assert_eq!(fake.state().await["signed_in"], json!(["tomsj"]));

    // Revoking from "GitHub's settings", through the control port.
    fake.control(
        reqwest::Method::POST,
        "/revoke",
        json!({ "login": "tomsj" }),
    )
    .await;
    assert_eq!(fake.state().await["signed_in"], json!([]));
}

/// `(name, permissions)` of every repo an account sees through its installations.
async fn repos_seen_by(fake: &Fake, login: &str) -> Vec<(String, Value)> {
    let token = &fake.sign_in(login).await["access_token"];
    let inst: Value = fake
        .get("/user/installations", token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(inst["total_count"], 1, "{inst}");
    let inst = &inst["installations"][0];
    assert_eq!(inst["account"]["login"], "acme");
    assert_eq!(inst["account"]["type"], "Organization");
    let id = inst["id"].as_i64().unwrap();

    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let res = fake
            .get(
                &format!("/user/installations/{id}/repositories?per_page=4&page={page}"),
                token,
            )
            .await;
        assert_eq!(res.status(), 200);
        let has_next = res
            .headers()
            .get("link")
            .is_some_and(|l| l.to_str().unwrap().contains("rel=\"next\""));
        let body: Value = res.json().await.unwrap();
        for r in body["repositories"].as_array().unwrap() {
            assert_eq!(
                r["full_name"],
                format!("acme/{}", r["name"].as_str().unwrap())
            );
            out.push((
                r["name"].as_str().unwrap().to_owned(),
                r["permissions"].clone(),
            ));
        }
        if !has_next {
            assert_eq!(body["total_count"].as_u64().unwrap() as usize, out.len());
            return out;
        }
        page += 1;
    }
}

fn perms(admin: bool, maintain: bool, push: bool, triage: bool) -> Value {
    json!({ "admin": admin, "maintain": maintain, "push": push, "triage": triage, "pull": true })
}

#[tokio::test]
async fn installations_list_the_repos_each_account_sees_with_its_permissions() {
    let fake = start().await;

    let tomsj = repos_seen_by(&fake, "tomsj").await;
    assert_eq!(tomsj.len(), 10);
    assert!(
        tomsj
            .iter()
            .all(|(_, p)| *p == perms(true, true, true, true))
    );

    let ilze = repos_seen_by(&fake, "ilze-k").await;
    assert_eq!(ilze.len(), 10);
    let of = |name: &str| ilze.iter().find(|(n, _)| n == name).unwrap().1.clone();
    assert_eq!(of("web"), perms(false, false, true, true));
    assert_eq!(of("infra"), perms(false, false, false, true));
    assert_eq!(of("cli"), perms(false, false, false, false));

    let ext = repos_seen_by(&fake, "octo-ext").await;
    let names: Vec<&str> = ext.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["web", "docs"]);
    assert!(
        ext.iter()
            .all(|(_, p)| *p == perms(false, false, false, false))
    );
}

#[tokio::test]
async fn an_admin_can_change_or_remove_an_accounts_access_to_a_repo() {
    let fake = start().await;
    let put = |body: Value| fake.control(reqwest::Method::PUT, "/permissions", body);
    put(json!({ "login": "octo-ext", "repo": "acme/web", "role": null })).await;
    put(json!({ "login": "octo-ext", "repo": "docs", "role": "triage" })).await;
    let ext = repos_seen_by(&fake, "octo-ext").await;
    assert_eq!(ext, [("docs".to_owned(), perms(false, false, false, true))]);

    for bad in [
        json!({ "login": "nobody", "repo": "web", "role": null }),
        json!({ "login": "octo-ext", "repo": "nope", "role": null }),
        json!({ "login": "octo-ext", "repo": "web", "role": "owner" }),
    ] {
        let res = fake
            .http
            .put(format!("{}/permissions", fake.ctl))
            .json(&bad)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{bad}");
    }
}

#[tokio::test]
async fn the_api_refuses_requests_without_a_live_token() {
    let fake = start().await;
    let res = fake
        .http
        .get(format!("{}/user", fake.api))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let res = fake.get("/user", &json!("ghu_madeup")).await;
    assert_eq!(res.status(), 401);
    assert_eq!(
        res.json::<Value>().await.unwrap()["message"],
        "Bad credentials"
    );
}

#[tokio::test]
async fn the_next_n_calls_to_an_endpoint_fail_with_the_chosen_status() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/fail",
        json!({ "endpoint": "/user", "count": 2, "status": 429, "retry_after": 7 }),
    )
    .await;

    // Only the endpoint the rule names.
    assert_eq!(fake.get("/user/installations", token).await.status(), 200);
    for _ in 0..2 {
        let res = fake.get("/user", token).await;
        assert_eq!(res.status(), 429);
        assert_eq!(res.headers()["retry-after"], "7");
        assert_eq!(res.headers()["x-ratelimit-remaining"], "0");
    }
    assert_eq!(fake.get("/user", token).await.status(), 200);
    assert_eq!(fake.state().await["faults"]["fail"], json!([]));
}

#[tokio::test]
async fn a_latency_rule_slows_its_endpoint() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/latency",
        json!({ "endpoint": "GET /user", "ms": 400 }),
    )
    .await;
    let t = Instant::now();
    assert_eq!(fake.get("/user", token).await.status(), 200);
    assert!(
        t.elapsed() >= Duration::from_millis(400),
        "{:?}",
        t.elapsed()
    );
}

#[tokio::test]
async fn down_makes_github_unreachable_until_it_comes_back_up() {
    let fake = start().await;
    let token = fake.sign_in("tomsj").await["access_token"].clone();
    fake.control(
        reqwest::Method::POST,
        "/faults/down",
        json!({ "down": true }),
    )
    .await;
    // A new connection is refused outright; one kept alive gets a 503 and is closed.
    let fresh = reqwest::Client::new();
    let res = fresh
        .get(format!("{}/user", fake.api))
        .bearer_auth(token.as_str().unwrap())
        .send()
        .await;
    assert!(
        res.as_ref().is_err() || res.as_ref().unwrap().status() == 503,
        "{res:?}"
    );
    fake.control(
        reqwest::Method::POST,
        "/faults/down",
        json!({ "down": false }),
    )
    .await;
    assert_eq!(fake.login_of(&token).await.as_deref(), Some("tomsj"));
}

#[tokio::test]
async fn state_shows_sign_ins_and_fault_rules_and_reset_clears_both() {
    let fake = start().await;
    let token = fake.sign_in("tomsj").await["access_token"].clone();
    fake.control(
        reqwest::Method::POST,
        "/faults/fail",
        json!({ "endpoint": "*", "count": 3, "status": 502 }),
    )
    .await;
    fake.control(
        reqwest::Method::POST,
        "/faults/latency",
        json!({ "endpoint": "/user/installations", "ms": 50 }),
    )
    .await;
    let state = fake.state().await;
    assert_eq!(state["signed_in"], json!(["tomsj"]));
    assert_eq!(
        state["faults"],
        json!({
            "down": false,
            "latency": [{ "endpoint": "/user/installations", "ms": 50 }],
            "fail": [{ "endpoint": "*", "remaining": 3, "status": 502, "retry_after": null, "limit": null }],
            "rewrite": [],
        })
    );

    fake.control(reqwest::Method::POST, "/reset", json!({}))
        .await;
    let state = fake.state().await;
    assert_eq!(state["signed_in"], json!([]));
    assert_eq!(
        state["faults"],
        json!({ "down": false, "latency": [], "fail": [], "rewrite": [] })
    );
    assert_eq!(fake.login_of(&token).await, None);
}

impl Fake {
    async fn fail_next(&self, endpoint: &str, status: u16) {
        self.control(
            reqwest::Method::POST,
            "/faults/fail",
            json!({ "endpoint": endpoint, "status": status }),
        )
        .await;
    }

    /// The status of an unauthenticated `GET path`: a fault rule's status if one matches it.
    async fn status_of(&self, path: &str) -> u16 {
        let res = self.http.get(format!("{}{path}", self.api)).send().await;
        res.unwrap().status().as_u16()
    }
}

#[tokio::test]
async fn a_trailing_slash_on_the_rule_or_the_call_doesnt_change_what_matches() {
    let fake = start().await;
    fake.fail_next("/user/", 502).await;
    assert_eq!(fake.status_of("/user").await, 502);
    fake.fail_next("/user", 503).await;
    assert_eq!(fake.status_of("/user/").await, 503);
}

#[tokio::test]
async fn a_star_in_a_rule_s_path_stands_for_exactly_one_segment() {
    let fake = start().await;
    fake.fail_next("GET /repos/*/issues/*/comments", 502).await;
    assert_ne!(fake.status_of("/repos/acme/issues/5").await, 502);
    assert_ne!(
        fake.status_of("/repos/acme/web/issues/5/comments").await,
        502
    );
    assert_ne!(fake.status_of("/repos/acme/issues/5/comments/9").await, 502);
    assert_eq!(fake.status_of("/repos/acme/issues/5/comments").await, 502);
}

#[tokio::test]
async fn a_star_at_the_end_of_a_rule_s_path_covers_everything_under_it() {
    let fake = start().await;
    fake.fail_next("/repos/*/issues/*", 502).await;
    assert_ne!(fake.status_of("/repos/acme/issues").await, 502);
    assert_eq!(fake.status_of("/repos/acme/issues/5/comments/9").await, 502);
}

#[tokio::test]
async fn clearing_one_endpoint_s_faults_leaves_the_others() {
    let fake = start().await;
    let mine = "POST /repos/acme/web/issues/1/comments";
    let theirs = "POST /repos/acme/web/issues/2/comments";
    for endpoint in [mine, theirs] {
        fake.fail_next(endpoint, 502).await;
        fake.control(
            reqwest::Method::POST,
            "/faults/latency",
            json!({ "endpoint": endpoint, "ms": 100 }),
        )
        .await;
        fake.control(
            reqwest::Method::POST,
            "/faults/rewrite",
            json!({ "endpoint": endpoint, "count": 1, "raw": "{" }),
        )
        .await;
    }
    // Spelled differently, it's the same endpoint.
    fake.control(
        reqwest::Method::DELETE,
        "/faults",
        json!({ "endpoint": "post /repos/acme/web/issues/1/comments/" }),
    )
    .await;
    let faults = &fake.state().await["faults"];
    for kind in ["fail", "latency", "rewrite"] {
        let left: Vec<&str> = faults[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["endpoint"].as_str().unwrap())
            .collect();
        assert_eq!(left, [theirs], "{kind}");
    }
}

#[tokio::test]
async fn when_several_fail_rules_match_the_first_added_wins() {
    let fake = start().await;
    fake.fail_next("*", 502).await;
    fake.fail_next("GET /user", 429).await;
    assert_eq!(fake.status_of("/user").await, 502);
    assert_eq!(fake.status_of("/user").await, 429);
}

#[tokio::test]
async fn rules_are_stored_normalised_so_spellings_of_one_endpoint_replace_each_other() {
    let fake = start().await;
    let latency = |endpoint: &str, ms: u64| {
        fake.control(
            reqwest::Method::POST,
            "/faults/latency",
            json!({ "endpoint": endpoint, "ms": ms }),
        )
    };
    latency("GET /user", 50).await;
    latency("get /user/", 70).await;
    assert_eq!(
        fake.state().await["faults"]["latency"],
        json!([{ "endpoint": "GET /user", "ms": 70 }])
    );
    latency("get /user/", 0).await;
    assert_eq!(fake.state().await["faults"]["latency"], json!([]));

    fake.fail_next("get /user/", 502).await;
    assert_eq!(
        fake.state().await["faults"]["fail"][0]["endpoint"],
        "GET /user"
    );
    assert_eq!(fake.status_of("/user").await, 502);
}

// --- webhooks -------------------------------------------------------------------------------

/// One delivery as the App's webhook URL received it.
struct Received {
    at: Instant,
    event: String,
    guid: String,
    signature: String,
    body: Vec<u8>,
}

impl Received {
    fn payload(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// A webhook receiver standing in for beghu, with the fake pointed at it.
async fn receiver(fake: &Fake) -> tokio::sync::mpsc::UnboundedReceiver<Received> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let app = axum::Router::new().route(
        "/webhook",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let tx = tx.clone();
                async move {
                    let h = |n: &str| headers[n].to_str().unwrap().to_owned();
                    let _ = tx.send(Received {
                        at: Instant::now(),
                        event: h("x-github-event"),
                        guid: h("x-github-delivery"),
                        signature: h("x-hub-signature-256"),
                        body: body.to_vec(),
                    });
                    axum::http::StatusCode::ACCEPTED
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/webhook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    fake.control(reqwest::Method::PUT, "/webhooks", json!({ "url": url }))
        .await;
    rx
}

impl Fake {
    async fn edit(&self, edit: Value) -> Value {
        self.control(reqwest::Method::POST, "/edit", edit).await
    }
}

/// Every delivery that arrives within `wait`.
async fn received_for(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Received>,
    wait: Duration,
) -> Vec<Received> {
    let deadline = tokio::time::Instant::now() + wait;
    let mut out = Vec::new();
    while let Ok(Some(r)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        out.push(r);
    }
    out
}

#[tokio::test]
async fn an_outside_edit_sends_its_signed_webhooks_about_a_second_later() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // From a known start: open, without the label.
    fake.edit(json!({ "repo": "web", "number": 1, "state": "open", "remove_labels": ["bug"] }))
        .await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let sent = Instant::now();
    let edited = fake
        .edit(json!({
            "repo": "acme/web", "number": 1, "as": "ilze-k",
            "title": "Renamed outside beghu", "state": "closed", "state_reason": "not_planned",
            "add_labels": ["bug"], "comment": "Closing: not ours",
        }))
        .await;
    assert_eq!(edited["deliveries"], 4);
    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    let actions: Vec<(String, String)> = got
        .iter()
        .map(|r| {
            (
                r.event.clone(),
                r.payload()["action"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        actions,
        [
            ("issues".into(), "edited".into()),
            ("issues".into(), "closed".into()),
            ("issues".into(), "labeled".into()),
            ("issue_comment".into(), "created".into()),
        ]
    );
    let first = got[0].at.duration_since(sent);
    assert!(
        (Duration::from_millis(900)..Duration::from_millis(1800)).contains(&first),
        "{first:?}"
    );
    for r in &got {
        // GitHub's signature: HMAC-SHA256 of the body under the webhook secret.
        assert_eq!(
            r.signature,
            fake_github::sign_webhook(WEBHOOK_SECRET, &r.body)
        );
        let p = r.payload();
        assert_eq!(p["repository"]["full_name"], "acme/web");
        assert_eq!(p["sender"]["login"], "ilze-k");
        assert!(p["installation"]["id"].as_i64().is_some());
        // Each carries the issue as the whole edit left it.
        let issue = &p["issue"];
        assert_eq!(issue["number"], 1);
        assert_eq!(issue["title"], "Renamed outside beghu");
        assert_eq!(issue["state"], "closed");
        assert_eq!(issue["state_reason"], "not_planned");
        assert!(
            issue["labels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l["name"] == "bug")
        );
        assert_eq!(issue["updated_at"], edited["issue"]["updated_at"]);
    }
    let edited = got[0].payload();
    assert!(edited["changes"]["title"]["from"].is_string());
    assert_eq!(got[2].payload()["label"]["name"], "bug");
    let comment = &got[3].payload()["comment"];
    assert_eq!(comment["body"], "Closing: not ours");
    assert_eq!(comment["user"]["login"], "ilze-k");
    let guids: std::collections::HashSet<_> = got.iter().map(|r| r.guid.clone()).collect();
    assert_eq!(guids.len(), 4, "every delivery has its own GUID");
}

#[tokio::test]
async fn a_deliverys_owner_type_installation_and_author_association_come_from_the_fixture() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // An org member and an outside collaborator comment on the same issue.
    for login in ["ilze-k", "octo-ext"] {
        fake.edit(json!({ "repo": "web", "number": 1, "as": login, "comment": "Seen." }))
            .await;
    }
    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    assert_eq!(got.len(), 2);
    let association: Vec<Value> = got
        .iter()
        .map(|r| r.payload()["comment"]["author_association"].clone())
        .collect();
    assert_eq!(association, [json!("MEMBER"), json!("COLLABORATOR")]);
    for r in &got {
        let p = r.payload();
        // acme is an organization: the App's installation on it says so.
        assert_eq!(p["repository"]["owner"]["type"], "Organization");
        // GitHub's legacy global ID for an installation: base64 of `023:IntegrationInstallation<id>`.
        let id = p["installation"]["id"].as_i64().unwrap();
        let node_id = base64::engine::general_purpose::STANDARD
            .decode(p["installation"]["node_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            String::from_utf8(node_id).unwrap(),
            format!("023:IntegrationInstallation{id}")
        );
    }
}

#[tokio::test]
async fn an_edit_naming_what_github_doesnt_have_is_refused_and_sends_nothing() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    for bad in [
        json!({ "repo": "acme/nope", "number": 1, "title": "x" }),
        json!({ "repo": "web", "number": 999_999, "title": "x" }),
        json!({ "repo": "web", "number": 1, "add_labels": ["no-such-label"] }),
        json!({ "repo": "web", "number": 1, "as": "nobody", "title": "x" }),
    ] {
        let res = fake
            .http
            .post(format!("{}/edit", fake.ctl))
            .json(&bad)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{bad}");
    }
    assert!(
        received_for(&mut rx, Duration::from_millis(1500))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn webhook_faults_drop_duplicate_delay_and_reorder_the_next_deliveries() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let title = |n: i64| json!({ "repo": "web", "number": 1, "title": format!("title {n}") });
    let titles = |got: &[Received]| -> Vec<String> {
        got.iter()
            .map(|r| r.payload()["issue"]["title"].as_str().unwrap().to_owned())
            .collect()
    };

    // Drop: the next delivery never comes.
    fake.control(
        reqwest::Method::POST,
        "/faults/webhooks",
        json!({ "drop": 1 }),
    )
    .await;
    fake.edit(title(1)).await;
    fake.edit(title(2)).await;
    let got = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(titles(&got), ["title 2"]);

    // Duplicate: sent twice under one GUID, as a redelivery would be.
    fake.control(
        reqwest::Method::POST,
        "/faults/webhooks",
        json!({ "duplicate": 1 }),
    )
    .await;
    fake.edit(title(3)).await;
    let got = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(titles(&got), ["title 3", "title 3"]);
    assert_eq!(got[0].guid, got[1].guid);

    // Reorder: a batch of three goes out newest first.
    fake.control(
        reqwest::Method::POST,
        "/faults/webhooks",
        json!({ "reorder": 3 }),
    )
    .await;
    for n in 4..=6 {
        fake.edit(title(n)).await;
    }
    let got = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(titles(&got), ["title 6", "title 5", "title 4"]);

    // Delay: every delivery waits that much longer.
    fake.control(
        reqwest::Method::POST,
        "/faults/webhooks",
        json!({ "delay_ms": 1000 }),
    )
    .await;
    let sent = Instant::now();
    fake.edit(title(7)).await;
    let got = received_for(&mut rx, Duration::from_millis(2800)).await;
    assert_eq!(titles(&got), ["title 7"]);
    assert!(got[0].at.duration_since(sent) >= Duration::from_millis(1900));

    // The state shows the rules; clearing them restores plain deliveries.
    let state = fake.state().await;
    assert_eq!(state["webhooks"]["faults"]["delay_ms"], 1000);
    assert!(
        state["webhooks"]["url"]
            .as_str()
            .unwrap()
            .ends_with("/webhook")
    );
    fake.control(reqwest::Method::DELETE, "/faults", json!({}))
        .await;
    let sent = Instant::now();
    fake.edit(title(8)).await;
    let got = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(titles(&got), ["title 8"]);
    assert!(got[0].at.duration_since(sent) < Duration::from_millis(1800));
}

impl Fake {
    /// A page of `GET /app/hook/deliveries` with the App's JWT: the items and the `Link` header.
    async fn deliveries(&self, query: &str) -> (Vec<Value>, Option<String>) {
        self.deliveries_as(&dev_jwt(), query).await
    }

    async fn deliveries_as(&self, jwt: &str, query: &str) -> (Vec<Value>, Option<String>) {
        let res = self
            .http
            .get(format!("{}/app/hook/deliveries{query}", self.api))
            .bearer_auth(jwt)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let link = res
            .headers()
            .get("link")
            .map(|l| l.to_str().unwrap().to_owned());
        (res.json().await.unwrap(), link)
    }
}

#[tokio::test]
async fn the_apps_deliveries_list_every_attempt_and_a_failed_one_can_be_redelivered() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let title = |t: &str| json!({ "repo": "web", "number": 1, "title": t });
    fake.control(
        reqwest::Method::POST,
        "/faults/webhooks",
        json!({ "drop": 1 }),
    )
    .await;
    fake.edit(title("lost")).await;
    fake.edit(title("delivered")).await;
    let got = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(got.len(), 1);

    // Newest first, in GitHub's shape; the lost one failed.
    let (items, _) = fake.deliveries("?per_page=100").await;
    assert_eq!(items.len(), 2, "{items:?}");
    let (ok, failed) = (&items[0], &items[1]);
    assert_eq!(ok["guid"], got[0].guid.as_str());
    assert_eq!(ok["status"], "OK");
    assert_eq!(ok["status_code"], 202);
    assert_eq!(ok["redelivery"], false);
    assert_eq!(ok["event"], "issues");
    assert_eq!(ok["action"], "edited");
    assert_eq!(ok["installation_id"], 41000001);
    assert!(ok["repository_id"].is_i64());
    assert!(ok["delivered_at"].as_str().unwrap().ends_with('Z'));
    assert_ne!(failed["status"], "OK");
    assert_eq!(
        fake.deliveries("?status=failure").await.0,
        vec![failed.clone()]
    );

    // Redelivered under its own GUID, with its payload as first sent.
    let res = fake
        .http
        .post(format!(
            "{}/app/hook/deliveries/{}/attempts",
            fake.api, failed["id"]
        ))
        .bearer_auth(dev_jwt())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 202);
    let again = received_for(&mut rx, Duration::from_millis(1800)).await;
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].guid, failed["guid"].as_str().unwrap());
    assert_eq!(again[0].payload()["issue"]["title"], "lost");
    let (items, _) = fake.deliveries("").await;
    assert_eq!(items[0]["redelivery"], true);
    assert_eq!(items[0]["status"], "OK");

    // Without the App's JWT, nothing.
    let res = fake
        .http
        .get(format!("{}/app/hook/deliveries", fake.api))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn deliveries_page_by_cursor_and_are_kept_for_three_days() {
    let fake = start().await;
    let _rx = receiver(&fake).await;
    for n in 0..3 {
        fake.edit(json!({ "repo": "web", "number": 1, "title": format!("t{n}") }))
            .await;
    }
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let (first, link) = fake.deliveries("?per_page=2").await;
    assert_eq!(first.len(), 2);
    let next = link.expect("a next page");
    let url = next.split(['<', '>']).nth(1).unwrap();
    let cursor = query_param(url, "cursor").unwrap();
    let (rest, link) = fake
        .deliveries(&format!("?per_page=2&cursor={cursor}"))
        .await;
    assert_eq!(rest.len(), 1);
    assert_eq!(link, None);
    assert!(rest[0]["id"].as_i64() < first[1]["id"].as_i64());

    // Three days on, they're gone, and so is redelivering them. (The App's clock moves on too.)
    let offset = 3 * 24 * 3600 + 60;
    fake.control(reqwest::Method::PUT, "/clock", json!({ "offset": offset }))
        .await;
    let now = unix_now() + offset;
    let jwt = app_jwt(now - 60, now + 540, fake_github::DEV_APP_KEY);
    assert_eq!(fake.deliveries_as(&jwt, "").await.0, Vec::<Value>::new());
    let res = fake
        .http
        .post(format!(
            "{}/app/hook/deliveries/{}/attempts",
            fake.api, first[0]["id"]
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// A JWT for the dev App, good for 9 minutes, as an App makes one.
fn dev_jwt() -> String {
    let now = unix_now();
    app_jwt(now - 60, now + 540, fake_github::DEV_APP_KEY)
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_apps_own_jwt_mints_an_installation_token_and_it_reads_only_that_installation() {
    let fake = start().await;
    let mint = |jwt: String| {
        fake.http
            .post(format!(
                "{}/app/installations/41000001/access_tokens",
                fake.api
            ))
            .bearer_auth(jwt)
            .send()
    };
    let now = unix_now();
    let stranger = app_jwt(now - 60, now + 540, include_str!("other-key.pem"));
    assert_eq!(mint(stranger).await.unwrap().status(), 401);
    let res = mint(dev_jwt()).await.unwrap();
    assert_eq!(res.status(), 201);
    let token = res.json::<Value>().await.unwrap()["token"].clone();
    assert!(token.as_str().unwrap().starts_with("ghs_"), "{token}");

    // The org's repos, through the org's installation; not the newcomer's private repo.
    assert_eq!(
        fake.get("/repos/acme/web/labels", &token).await.status(),
        200
    );
    assert_eq!(
        fake.get("/repos/newcomer/notes/labels", &token)
            .await
            .status(),
        404
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_suspended_installation_still_lists_but_mints_nothing_and_its_tokens_stop_working() {
    let fake = start().await;
    let mint = || {
        fake.http
            .post(format!(
                "{}/app/installations/41000001/access_tokens",
                fake.api
            ))
            .bearer_auth(dev_jwt())
            .send()
    };
    let token = mint().await.unwrap().json::<Value>().await.unwrap()["token"].clone();
    let user = fake.sign_in("tomsj").await["access_token"].clone();
    let installations = || async {
        let res = fake.get("/user/installations", &user).await;
        res.json::<Value>().await.unwrap()["installations"][0].clone()
    };
    assert_eq!(installations().await["suspended_at"], Value::Null);

    fake.control(
        reqwest::Method::POST,
        "/suspend",
        json!({ "login": "acme" }),
    )
    .await;
    let i = installations().await;
    assert!(i["suspended_at"].is_string(), "{i}");
    let refused = mint().await.unwrap();
    assert_eq!(refused.status(), 403);
    assert_eq!(
        refused.json::<Value>().await.unwrap()["message"],
        "This installation has been suspended"
    );
    assert_eq!(
        fake.get("/repos/acme/web/labels", &token).await.status(),
        401
    );

    fake.control(
        reqwest::Method::POST,
        "/unsuspend",
        json!({ "login": "acme" }),
    )
    .await;
    assert_eq!(installations().await["suspended_at"], Value::Null);
    assert_eq!(mint().await.unwrap().status(), 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn suspending_sends_the_installation_with_who_suspended_it() {
    let fake = start().await;
    let res = fake
        .http
        .post(format!("{}/apps/beghu-dev/installations/new", fake.api))
        .form(&[("login", "newcomer"), ("target", "newcomer")])
        .send()
        .await
        .unwrap();
    assert!(res.status().is_redirection() || res.status().is_success());
    let mut rx = receiver(&fake).await;
    for action in ["suspend", "unsuspend"] {
        fake.control(
            reqwest::Method::POST,
            &format!("/{action}"),
            json!({ "login": "newcomer" }),
        )
        .await;
        let sent = received_for(&mut rx, Duration::from_millis(1800)).await;
        let p = sent
            .iter()
            .map(Received::payload)
            .find(|p| p["action"] == action)
            .unwrap_or_else(|| panic!("no installation {action} delivery"));
        let by = &p["installation"]["suspended_by"];
        match action {
            "suspend" => assert_eq!(by["login"], "newcomer", "{p}"),
            _ => assert_eq!(by, &Value::Null, "{p}"),
        }
        assert!(
            p["installation"]
                .as_object()
                .unwrap()
                .contains_key("suspended_by"),
            "{p}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn graphqls_rate_limit_names_the_callers_installation() {
    let fake = start().await;
    // newcomer installs the App: an installation of its own, not the org's.
    let res = fake
        .http
        .post(format!("{}/apps/beghu-dev/installations/new", fake.api))
        .form(&[("login", "newcomer"), ("target", "newcomer")])
        .send()
        .await
        .unwrap();
    assert!(res.status().is_redirection() || res.status().is_success());
    let user = fake.sign_in("newcomer").await["access_token"].clone();
    let listed = fake.get("/user/installations", &user).await;
    let id = listed.json::<Value>().await.unwrap()["installations"][0]["id"]
        .as_i64()
        .unwrap();
    assert_ne!(id, 41_000_001);
    let token = fake
        .http
        .post(format!("{}/app/installations/{id}/access_tokens", fake.api))
        .bearer_auth(dev_jwt())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    fake.control(
        reqwest::Method::POST,
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "status": 200, "limit": "graphql", "retry_after": 1, "count": 1 }),
    )
    .await;
    let answer: Value = fake
        .http
        .post(format!("{}/graphql", fake.api))
        .bearer_auth(&token)
        .json(&json!({ "query": "{ viewer { login } }" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(answer["errors"][0]["type"], "RATE_LIMITED", "{answer}");
    assert_eq!(
        answer["errors"][0]["message"],
        format!("API rate limit already exceeded for installation ID {id}."),
        "{answer}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rest_since_is_exclusive_as_githubs_is() {
    let fake = start().await;
    let token = fake
        .http
        .post(format!(
            "{}/app/installations/41000001/access_tokens",
            fake.api
        ))
        .bearer_auth(dev_jwt())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["token"]
        .clone();
    let base = "/repos/acme/web/issues?state=all&sort=updated&direction=asc&per_page=100";
    let ids = |v: &Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_i64().unwrap())
            .collect()
    };
    let first = fake.get(base, &token).await.json::<Value>().await.unwrap();
    let oldest = &first[0];
    let at = oldest["updated_at"].as_str().unwrap();
    // "Only issues updated after the given time" (/rest/issues/issues#list-repository-issues).
    let after = fake
        .get(&format!("{base}&since={at}"), &token)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        !ids(&after).contains(&oldest["id"].as_i64().unwrap()),
        "{at}"
    );
    let comments = "/repos/acme/web/issues/comments?sort=updated&direction=asc&per_page=100";
    let first = fake
        .get(comments, &token)
        .await
        .json::<Value>()
        .await
        .unwrap();
    let at = first[0]["updated_at"].as_str().unwrap();
    let after = fake
        .get(&format!("{comments}&since={at}"), &token)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        !ids(&after).contains(&first[0]["id"].as_i64().unwrap()),
        "{at}"
    );
}

impl Fake {
    /// A token for the fixture's first installation, minted with the App's JWT.
    async fn installation_token_value(&self) -> Value {
        self.http
            .post(format!(
                "{}/app/installations/41000001/access_tokens",
                self.api
            ))
            .bearer_auth(dev_jwt())
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["token"]
            .clone()
    }
}

fn header_i64(res: &reqwest::Response, name: &str) -> i64 {
    res.headers()[name].to_str().unwrap().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unchanged_answer_to_a_conditional_request_is_a_304_that_costs_nothing() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    // What changed since the fixture's "now": nothing yet, as a sweep's probe asks.
    let path = "/repos/acme/web/issues?state=all&sort=updated&direction=asc&per_page=100&since=2026-10-02T00:00:00Z";
    let first = fake.get(path, &token).await;
    assert_eq!(first.status(), 200);
    assert_eq!(first.headers()["x-ratelimit-resource"], "core");
    assert_eq!(header_i64(&first, "x-ratelimit-limit"), 5000);
    let used = header_i64(&first, "x-ratelimit-used");
    let tag = first.headers()["etag"].to_str().unwrap().to_owned();
    assert!(tag.starts_with("W/\""), "{tag}");
    let again = fake
        .http
        .get(format!("{}{path}", fake.api))
        .bearer_auth(token.as_str().unwrap())
        .header("if-none-match", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 304);
    assert_eq!(header_i64(&again, "x-ratelimit-used"), used);
    assert_eq!(again.bytes().await.unwrap().len(), 0);
    assert_eq!(fake.state().await["not_modified"], 1);
    // A change makes it a 200 again, which costs a call.
    fake.edit(json!({ "repo": "web", "number": 1, "title": "changed" }))
        .await;
    let changed = fake
        .http
        .get(format!("{}{path}", fake.api))
        .bearer_auth(token.as_str().unwrap())
        .header("if-none-match", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), 200);
    assert_eq!(header_i64(&changed, "x-ratelimit-used"), used + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_tokens_owner_spends_its_own_quota_and_rate_limit_reports_it() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let rate = |t: Value| {
        let fake = &fake;
        async move {
            fake.get("/rate_limit", &t)
                .await
                .json::<Value>()
                .await
                .unwrap()["resources"]
                .clone()
        }
    };
    let before = rate(token.clone()).await;
    fake.get("/repos/acme/web/labels?per_page=1", &token).await;
    let after = rate(token.clone()).await;
    assert_eq!(
        after["core"]["used"].as_i64().unwrap(),
        before["core"]["used"].as_i64().unwrap() + 1
    );
    // `/rate_limit` itself costs nothing, and GraphQL is its own resource.
    assert_eq!(after["graphql"]["used"], before["graphql"]["used"]);

    // As if others had spent most of it: every owner reads at most what's left.
    fake.control(reqwest::Method::PUT, "/quota", json!({ "remaining": 900 }))
        .await;
    let res = fake.get("/repos/acme/web/labels?per_page=1", &token).await;
    assert_eq!(res.status(), 200);
    assert_eq!(header_i64(&res, "x-ratelimit-remaining"), 900);
    assert_eq!(rate(token.clone()).await["graphql"]["remaining"], 900);
    // None left: GitHub's primary rate limit.
    fake.control(reqwest::Method::PUT, "/quota", json!({ "remaining": 0 }))
        .await;
    let res = fake.get("/repos/acme/web/labels?per_page=1", &token).await;
    assert_eq!(res.status(), 403);
    assert_eq!(header_i64(&res, "x-ratelimit-remaining"), 0);
    // In GitHub's words, naming the owner.
    assert_eq!(
        res.json::<Value>().await.unwrap()["message"],
        "API rate limit exceeded for installation ID 41000001."
    );
    fake.control(reqwest::Method::PUT, "/quota", json!({ "remaining": null }))
        .await;
    let res = fake.get("/repos/acme/web/labels?per_page=1", &token).await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn the_users_installations_page_as_github_pages_them() {
    let fake = start().await;
    let user = fake.sign_in("tomsj").await["access_token"].clone();
    let res = fake
        .get("/user/installations?per_page=1&page=1", &user)
        .await;
    assert!(
        res.headers().get("link").is_none(),
        "one installation, one page"
    );
    let body = res.json::<Value>().await.unwrap();
    assert_eq!(body["total_count"], 1);
    assert_eq!(body["installations"].as_array().unwrap().len(), 1);
    let past = fake
        .get("/user/installations?per_page=1&page=2", &user)
        .await;
    let body = past.json::<Value>().await.unwrap();
    assert_eq!(
        (body["total_count"].clone(), body["installations"].clone()),
        (json!(1), json!([]))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn graphql_holds_githubs_limits_on_page_size_and_node_ids() {
    let fake = start().await;
    let token = fake.sign_in("tomsj").await["access_token"].clone();
    let ask = |query: &str, variables: Value| {
        fake.http
            .post(format!("{}/graphql", fake.api))
            .bearer_auth(token.as_str().unwrap())
            .json(&json!({ "query": query, "variables": variables }))
            .send()
    };
    let too_many = ask(
        "query ImportIssues($owner: String!) { repository(owner: $owner, name: \"web\") { issues(first: 101) { nodes { id } } } }",
        json!({ "owner": "acme", "name": "web", "states": ["OPEN"] }),
    )
    .await
    .unwrap();
    let body: Value = too_many.json().await.unwrap();
    assert_eq!(body["errors"][0]["type"], "EXCESSIVE_PAGINATION", "{body}");
    assert!(body.get("data").is_none(), "{body}");

    let ids: Vec<String> = (0..101).map(|i| format!("I_kw{i}")).collect();
    let body: Value = ask(
        "query ImportComments($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        json!({ "ids": ids }),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(body["errors"][0]["type"], "EXCESSIVE_PAGINATION", "{body}");

    // A page within the limits, and an id nobody has: null, with GitHub's NOT_FOUND beside it.
    let body: Value = ask(
        "query ImportIssues($owner: String!, $name: String!, $states: [IssueState!]!, $after: String) { repository(owner: $owner, name: $name) { issues(first: 100) { nodes { id } } } }",
        json!({ "owner": "acme", "name": "web", "states": ["OPEN"] }),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        body["data"]["repository"]["issues"]["nodes"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        body["data"]["repository"]["issues"]["pageInfo"]["hasNextPage"],
        true
    );
    let body: Value = ask(
        "query ImportComments($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        json!({ "ids": ["I_nobody"] }),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(body["data"]["nodes"], json!([null]), "{body}");
    assert_eq!(body["errors"][0]["type"], "NOT_FOUND", "{body}");
}

// --- REST writes ----------------------------------------------------------------------------

impl Fake {
    /// A REST call on the GitHub side with `token`; the status and the JSON body.
    async fn rest(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &Value,
        body: Value,
    ) -> (u16, Value) {
        let res = self
            .http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(token.as_str().unwrap())
            .json(&body)
            .send()
            .await
            .unwrap();
        (
            res.status().as_u16(),
            res.json().await.unwrap_or(Value::Null),
        )
    }
}

#[tokio::test]
async fn a_rest_comment_answers_201_with_the_comment_and_sends_the_same_webhook_as_an_edit() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let token = &fake.sign_in("ilze-k").await["access_token"];
    let (status, c) = fake
        .rest(
            reqwest::Method::POST,
            "/repos/acme/web/issues/1/comments",
            token,
            json!({ "body": "Looked into it." }),
        )
        .await;
    assert_eq!(status, 201, "{c}");
    assert_eq!(c["body"], "Looked into it.");
    assert_eq!(c["user"]["login"], "ilze-k");
    assert!(c["id"].as_i64().is_some());
    assert!(
        c["issue_url"]
            .as_str()
            .unwrap()
            .ends_with("/repos/acme/web/issues/1")
    );

    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].event, "issue_comment");
    let p = got[0].payload();
    assert_eq!(p["action"], "created");
    assert_eq!(p["comment"], c);
    assert_eq!(p["issue"]["number"], 1);
    assert_eq!(p["sender"]["login"], "ilze-k");
    assert_eq!(
        got[0].signature,
        fake_github::sign_webhook(WEBHOOK_SECRET, &got[0].body)
    );

    // No body is GitHub's validation failure, and no repo the user can see is a 404.
    let (status, _) = fake
        .rest(
            reqwest::Method::POST,
            "/repos/acme/web/issues/1/comments",
            token,
            json!({}),
        )
        .await;
    assert_eq!(status, 422);
    let outsider = &fake.sign_in("octo-ext").await["access_token"];
    let (status, _) = fake
        .rest(
            reqwest::Method::POST,
            "/repos/acme/api/issues/1/comments",
            outsider,
            json!({ "body": "hi" }),
        )
        .await;
    assert_eq!(status, 404);
    assert!(
        received_for(&mut rx, Duration::from_millis(1500))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn closing_and_reopening_answers_the_stored_issue_and_sends_issues_closed_then_reopened() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    fake.edit(json!({ "repo": "web", "number": 2, "state": "open" }))
        .await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let token = &fake.sign_in("ilze-k").await["access_token"];
    let patch = |body: Value| {
        fake.rest(
            reqwest::Method::PATCH,
            "/repos/acme/web/issues/2",
            token,
            body,
        )
    };

    let (status, issue) = patch(json!({ "state": "closed", "state_reason": "not_planned" })).await;
    assert_eq!(status, 200, "{issue}");
    assert_eq!(issue["state"], "closed");
    assert_eq!(issue["state_reason"], "not_planned");
    assert!(issue["closed_at"].is_string());
    let (status, issue) = patch(json!({ "state": "open" })).await;
    assert_eq!(status, 200, "{issue}");
    assert_eq!(issue["state"], "open");
    assert_eq!(issue["state_reason"], "reopened");
    assert_eq!(issue["closed_at"], Value::Null);

    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    let actions: Vec<_> = got
        .iter()
        .map(|r| {
            (
                r.event.as_str(),
                r.payload()["action"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        actions,
        [("issues", "closed".into()), ("issues", "reopened".into())]
    );
    assert_eq!(got[1].payload()["issue"], issue);
    assert_eq!(got[0].payload()["sender"]["login"], "ilze-k");

    // A bad state is GitHub's validation failure, and a field the fake doesn't model is refused
    // loudly rather than ignored.
    assert_eq!(patch(json!({ "state": "shut" })).await.0, 422);
    assert_eq!(patch(json!({ "labels": ["bug"] })).await.0, 422);
}

#[tokio::test]
async fn read_on_someone_elses_issue_may_comment_but_not_close_it() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // Read on `web`; the fixture's issues are by other users.
    let token = &fake.sign_in("octo-ext").await["access_token"];
    let (status, body) = fake
        .rest(
            reqwest::Method::PATCH,
            "/repos/acme/web/issues/3",
            token,
            json!({ "state": "closed" }),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(body["message"], "Resource not accessible by integration");
    let (status, _) = fake
        .rest(
            reqwest::Method::POST,
            "/repos/acme/web/issues/3/comments",
            token,
            json!({ "body": "Seeing this too." }),
        )
        .await;
    assert_eq!(status, 201);
    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(got.len(), 1, "only the comment is sent");
    assert_eq!(got[0].event, "issue_comment");
    assert_eq!(got[0].payload()["issue"]["number"], 3);
}

#[tokio::test]
async fn triage_on_someone_elses_issue_closes_it_but_its_title_edit_is_silently_dropped() {
    let fake = start().await;
    // Triage on `infra`.
    let token = &fake.sign_in("ilze-k").await["access_token"];
    fake.edit(json!({ "repo": "infra", "number": 1, "state": "open", "title": "Before" }))
        .await;
    let (status, issue) = fake
        .rest(
            reqwest::Method::PATCH,
            "/repos/acme/infra/issues/1",
            token,
            json!({ "state": "closed", "title": "After" }),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(issue["state"], "closed");
    assert_eq!(issue["title"], "Before");
}

#[tokio::test]
async fn rate_limit_answers_without_a_token_and_follows_the_faults() {
    let fake = start().await;
    let res = fake
        .http
        .get(format!("{}/rate_limit", fake.api))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["resources"]["core"]["limit"], 5000);
    assert_eq!(body["rate"]["remaining"], 5000);
    fake.fail_next("/rate_limit", 502).await;
    assert_eq!(fake.status_of("/rate_limit").await, 502);
}

// --- faults for the write path ----------------------------------------------------------------

#[tokio::test]
async fn a_latency_rule_with_a_count_slows_only_the_next_calls() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/latency",
        json!({ "endpoint": "GET /user", "ms": 600, "count": 1 }),
    )
    .await;
    assert_eq!(
        fake.state().await["faults"]["latency"],
        json!([{ "endpoint": "GET /user", "ms": 600, "remaining": 1 }])
    );
    let t = Instant::now();
    assert_eq!(fake.get("/user", token).await.status(), 200);
    assert!(
        t.elapsed() >= Duration::from_millis(600),
        "{:?}",
        t.elapsed()
    );
    // Used up: the next call goes through undelayed. (Timing it would only measure the machine.)
    assert_eq!(fake.state().await["faults"]["latency"], json!([]));
    assert_eq!(fake.get("/user", token).await.status(), 200);
    assert_eq!(fake.state().await["faults"]["latency"], json!([]));
}

#[tokio::test]
async fn a_reset_rule_drops_the_connection_without_an_answer_and_without_acting() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/fail",
        json!({ "endpoint": "PATCH /repos/*/*/issues/*", "reset": true }),
    )
    .await;
    let res = fake
        .http
        .patch(format!("{}/repos/acme/web/issues/2", fake.api))
        .bearer_auth(token.as_str().unwrap())
        .json(&json!({ "state": "closed" }))
        .send()
        .await;
    let e = res.expect_err("no answer");
    assert!(!e.is_connect() && !e.is_timeout(), "{e:?}");
    // GitHub never acted on it: the next call finds the issue as it was, and changes it.
    let (status, issue) = fake
        .rest(
            reqwest::Method::PATCH,
            "/repos/acme/web/issues/2",
            token,
            json!({ "state": "closed" }),
        )
        .await;
    assert_eq!(status, 200, "{issue}");
    assert_eq!(fake.state().await["faults"]["fail"], json!([]));
    // A rule needs a status or a reset.
    let res = fake
        .http
        .post(format!("{}/faults/fail", fake.ctl))
        .json(&json!({ "endpoint": "/user" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn a_secondary_rate_limit_answers_as_github_documents_it() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/fail",
        json!({ "endpoint": "/user", "status": 403, "limit": "secondary", "count": 2 }),
    )
    .await;
    // Without retry-after, and with requests left in the primary limit.
    let res = fake.get("/user", token).await;
    assert_eq!(res.status(), 403);
    assert!(res.headers().get("retry-after").is_none());
    assert_ne!(
        res.headers()
            .get("x-ratelimit-remaining")
            .map(|v| v.to_str().unwrap()),
        Some("0")
    );
    // As many left as `/rate_limit` says: the primary limit isn't what ran out.
    let remaining = res.headers()["x-ratelimit-remaining"]
        .to_str()
        .unwrap()
        .to_owned();
    let body: Value = res.json().await.unwrap();
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("secondary rate limit"),
        "{body}"
    );
    assert_eq!(
        body["documentation_url"],
        "https://docs.github.com/free-pro-team@latest/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits"
    );
    let limits: Value = fake.get("/rate_limit", token).await.json().await.unwrap();
    assert_eq!(
        limits["resources"]["core"]["remaining"].to_string(),
        remaining
    );
    // A bare 429 is GitHub's "too many requests", with no headers to say for how long.
    fake.fail_next("/user/installations", 429).await;
    let res = fake.get("/user/installations", token).await;
    assert_eq!(res.status(), 429);
    assert!(res.headers().get("retry-after").is_none());
    assert!(res.headers().get("x-ratelimit-remaining").is_none());
}

#[tokio::test]
async fn a_rewrite_rule_with_raw_replaces_the_whole_answer_though_the_call_did_its_work() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/rewrite",
        json!({ "endpoint": "POST /repos/*/*/issues/*/comments", "raw": "{\"id\": 1, \"bo" }),
    )
    .await;
    let res = fake
        .http
        .post(format!("{}/repos/acme/web/issues/1/comments", fake.api))
        .bearer_auth(token.as_str().unwrap())
        .json(&json!({ "body": "Cut short on the way back" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    assert_eq!(res.text().await.unwrap(), "{\"id\": 1, \"bo");
    // The comment was posted all the same: its webhook comes.
    let got = received_for(&mut rx, Duration::from_millis(2500)).await;
    assert!(
        got.iter().any(|r| r.event == "issue_comment"
            && String::from_utf8_lossy(&r.body).contains("Cut short on the way back")),
        "no issue_comment webhook for the comment"
    );
    assert_eq!(fake.state().await["faults"]["rewrite"], json!([]));
}

#[tokio::test]
async fn a_rewrite_rule_changes_the_body_the_next_answers_carry() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    fake.control(
        reqwest::Method::POST,
        "/faults/rewrite",
        json!({ "endpoint": "POST /repos/*/*/issues/*/comments", "body": "As GitHub keeps it" }),
    )
    .await;
    let post = |text: &'static str| {
        fake.rest(
            reqwest::Method::POST,
            "/repos/acme/web/issues/1/comments",
            token,
            json!({ "body": text }),
        )
    };
    let (status, c) = post("As sent").await;
    assert_eq!(status, 201);
    assert_eq!(c["body"], "As GitHub keeps it");
    let (_, c) = post("As sent again").await;
    assert_eq!(c["body"], "As sent again");
    assert_eq!(fake.state().await["faults"]["rewrite"], json!([]));
}

#[tokio::test]
async fn a_repo_answers_with_the_user_s_permissions_on_it() {
    let fake = start().await;
    let ilze = &fake.sign_in("ilze-k").await["access_token"];
    let res = fake.get("/repos/acme/cli", ilze).await;
    assert_eq!(res.status(), 200);
    let repo: Value = res.json().await.unwrap();
    assert_eq!(repo["full_name"], "acme/cli");
    assert_eq!(
        repo["permissions"],
        json!({ "admin": false, "maintain": false, "push": false, "triage": false, "pull": true })
    );
    let res = fake.get("/repos/acme/web", ilze).await;
    assert_eq!(
        res.json::<Value>().await.unwrap()["permissions"]["push"],
        true
    );
    // A role an admin changes shows at once.
    fake.control(
        reqwest::Method::PUT,
        "/permissions",
        json!({ "login": "ilze-k", "repo": "cli", "role": "triage" }),
    )
    .await;
    let res = fake.get("/repos/acme/cli", ilze).await;
    assert_eq!(
        res.json::<Value>().await.unwrap()["permissions"]["triage"],
        true
    );
    // A private repo the user can't see is a 404, as on GitHub.
    let outsider = &fake.sign_in("octo-ext").await["access_token"];
    assert_eq!(fake.get("/repos/acme/api", outsider).await.status(), 404);
}

/// A fixture issue with no relationships: `(repo#number, id, node id)`.
fn unlinked(i: usize) -> (String, i64, String) {
    let path = fixture().with_file_name(format!("fixture-1k-{}.json", fixture::GENERATOR_HASH));
    let summary: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let u = &summary["unlinked"][i];
    (
        format!("{}#{}", u["repo"].as_str().unwrap(), u["number"]),
        u["id"].as_i64().unwrap(),
        u["node_id"].as_str().unwrap().to_owned(),
    )
}

/// The first fixture issues in `repo` with no relationships, as [`unlinked`] gives them.
fn unlinked_in(repo: &str) -> Vec<(String, i64, String)> {
    (0..14)
        .map(unlinked)
        .filter(|(r, _, _)| r.starts_with(&format!("{repo}#")))
        .collect()
}

/// An edit of the issue `target` (`repo#n`), with `fields`.
fn edit_of(target: &str, fields: Value) -> Value {
    let (repo, number) = target.split_once('#').unwrap();
    let mut e = json!({ "repo": repo, "number": number.parse::<i64>().unwrap() });
    for (k, v) in fields.as_object().unwrap() {
        e[k] = v.clone();
    }
    e
}

/// `(event, action, repo, the keys the payload carries besides the envelope)` of each delivery.
fn shapes(got: &[Received]) -> Vec<(String, String, String, Vec<String>)> {
    got.iter()
        .map(|r| {
            let p = r.payload();
            let mut keys: Vec<String> = p
                .as_object()
                .unwrap()
                .keys()
                .filter(|k| {
                    !["action", "repository", "sender", "installation"].contains(&k.as_str())
                })
                .cloned()
                .collect();
            keys.sort();
            (
                r.event.clone(),
                p["action"].as_str().unwrap().to_owned(),
                p["repository"]["name"].as_str().unwrap().to_owned(),
                keys,
            )
        })
        .collect()
}

fn keys(k: &[&str]) -> Vec<String> {
    k.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn a_sub_issue_or_dependency_change_sends_a_delivery_per_side_and_across_repos_each_omits_the_other_issue()
 {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let web = unlinked_in("web");
    let api = unlinked_in("api");
    let (parent, child, blocked) = (&web[0].0, &web[1].0, &web[2].0);
    let blocker = &api[0].0;

    fake.edit(edit_of(parent, json!({ "add_sub_issue": child })))
        .await;
    fake.edit(edit_of(blocked, json!({ "add_blocked_by": blocker })))
        .await;
    fake.edit(edit_of(blocked, json!({ "remove_blocked_by": blocker })))
        .await;
    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    let both_subs = keys(&[
        "parent_issue",
        "parent_issue_id",
        "sub_issue",
        "sub_issue_id",
    ]);
    assert_eq!(
        shapes(&got),
        [
            (
                "sub_issues".into(),
                "sub_issue_added".into(),
                "web".into(),
                both_subs.clone()
            ),
            (
                "sub_issues".into(),
                "parent_issue_added".into(),
                "web".into(),
                both_subs
            ),
            (
                "issue_dependencies".into(),
                "blocked_by_added".into(),
                "web".into(),
                keys(&["blocked_issue", "blocked_issue_id"])
            ),
            (
                "issue_dependencies".into(),
                "blocking_added".into(),
                "api".into(),
                keys(&["blocking_issue", "blocking_issue_id"])
            ),
            (
                "issue_dependencies".into(),
                "blocked_by_removed".into(),
                "web".into(),
                keys(&["blocked_issue", "blocked_issue_id"])
            ),
            (
                "issue_dependencies".into(),
                "blocking_removed".into(),
                "api".into(),
                keys(&["blocking_issue", "blocking_issue_id"])
            ),
        ]
    );
    let sub = got[0].payload();
    assert_eq!(sub["parent_issue_id"], web[0].1);
    assert_eq!(sub["sub_issue_id"], web[1].1);
    assert_eq!(sub["sub_issue"]["id"], web[1].1);
    assert_eq!(got[2].payload()["blocked_issue_id"], web[2].1);
    assert_eq!(got[3].payload()["blocking_issue_id"], api[0].1);
}

#[tokio::test]
async fn relates_to_sends_one_delivery_within_a_repo_one_per_repo_across_and_none_where_the_app_isnt_installed()
 {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let web = unlinked_in("web");
    let api = unlinked_in("api");
    let summary: Value = serde_json::from_str(
        &std::fs::read_to_string(
            fixture().with_file_name(format!("fixture-1k-{}.json", fixture::GENERATOR_HASH)),
        )
        .unwrap(),
    )
    .unwrap();
    let stub = format!("partner-sdk#{}", summary["stub_numbers"][0]);

    for other in [&web[1].0, &api[0].0, &stub] {
        fake.edit(edit_of(&web[0].0, json!({ "add_relates_to": other })))
            .await;
    }
    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    let own = keys(&["issue", "issue_id"]);
    assert_eq!(
        shapes(&got),
        [
            (
                "issue_relates_to".into(),
                "relates_to_added".into(),
                "web".into(),
                keys(&["issue", "issue_id", "related_issue", "related_issue_id"])
            ),
            (
                "issue_relates_to".into(),
                "relates_to_added".into(),
                "web".into(),
                own.clone()
            ),
            (
                "issue_relates_to".into(),
                "relates_to_added".into(),
                "api".into(),
                own.clone()
            ),
            // partner-sdk has no installation: only web hears of it.
            (
                "issue_relates_to".into(),
                "relates_to_added".into(),
                "web".into(),
                own
            ),
        ]
    );
    // Within a repo, `issue` is the side the change was made from.
    assert_eq!(got[0].payload()["issue_id"], web[0].1);
    assert_eq!(got[0].payload()["related_issue_id"], web[1].1);
    assert_eq!(got[2].payload()["issue_id"], api[0].1);
}

#[tokio::test]
async fn a_relationship_github_would_refuse_is_refused_and_sends_nothing() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let web = unlinked_in("web");
    let (a, b, c) = (&web[0].0, &web[1].0, &web[2].0);
    // a > b, and c blocked by a.
    fake.edit(edit_of(a, json!({ "add_sub_issue": b }))).await;
    fake.edit(edit_of(c, json!({ "add_blocked_by": a }))).await;
    received_for(&mut rx, Duration::from_millis(1500)).await;

    for (target, ask) in [
        // Itself.
        (a, json!({ "add_relates_to": a })),
        // A second parent.
        (c, json!({ "add_sub_issue": b })),
        // A loop.
        (b, json!({ "add_sub_issue": a })),
        (a, json!({ "add_blocked_by": c })),
        // A duplicate.
        (c, json!({ "add_blocked_by": a })),
        // A sub-issue that isn't one.
        (a, json!({ "remove_sub_issue": c })),
        // Nothing there.
        (a, json!({ "add_blocked_by": "web#999999" })),
    ] {
        let res = fake
            .http
            .post(format!("{}/edit", fake.ctl))
            .json(&edit_of(target, ask.clone()))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{target} {ask}");
    }
    // Removing a dependency or a relates-to link that isn't there succeeds, quietly.
    let done = fake
        .edit(edit_of(
            b,
            json!({ "remove_blocked_by": c, "remove_relates_to": a }),
        ))
        .await;
    assert_eq!(done["deliveries"], 0);
    assert!(
        received_for(&mut rx, Duration::from_millis(1500))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn sub_issues_nest_at_most_8_levels() {
    let fake = start().await;
    let mut chain: Vec<String> = unlinked_in("web").into_iter().map(|u| u.0).collect();
    chain.extend(unlinked_in("api").into_iter().map(|u| u.0).take(1));
    // web#0 > web#1 > … > web#7: 8 levels.
    for w in chain[..8].windows(2) {
        fake.edit(edit_of(&w[0], json!({ "add_sub_issue": w[1] })))
            .await;
    }
    let res = fake
        .http
        .post(format!("{}/edit", fake.ctl))
        .json(&edit_of(&chain[7], json!({ "add_sub_issue": chain[8] })))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

/// The dev App's JWT: RS256 over `{iat, exp, iss}` with its private key.
fn app_jwt(iat: i64, exp: i64, key_pem: &str) -> String {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let der: String = key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(der)
        .unwrap();
    let key = ring::rsa::KeyPair::from_der(&der).unwrap();
    let msg = format!(
        "{}.{}",
        b64.encode(br#"{"alg":"RS256","typ":"JWT"}"#),
        b64.encode(
            json!({ "iat": iat, "exp": exp, "iss": fake_github::DEV_APP_ID.to_string() })
                .to_string()
        )
    );
    let mut sig = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        msg.as_bytes(),
        &mut sig,
    )
    .unwrap();
    format!("{msg}.{}", b64.encode(sig))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

const EDGES: &str = "query IssueEdges($id: ID!, $sub: Boolean!, $blocks: Boolean!, $relates: Boolean!) { node(id: $id) { ... on Issue { databaseId } } }";

impl Fake {
    async fn installation_token(&self, jwt: &str) -> reqwest::Response {
        self.http
            .post(format!(
                "{}/app/installations/41000001/access_tokens",
                self.api
            ))
            .bearer_auth(jwt)
            .send()
            .await
            .unwrap()
    }

    async fn edges(&self, token: &str, node_id: &str) -> Value {
        let res = self
            .http
            .post(format!("{}/graphql", self.api))
            .bearer_auth(token)
            .json(&json!({
                "query": EDGES,
                "variables": { "id": node_id, "sub": true, "blocks": true, "relates": true },
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.json().await.unwrap()
    }
}

#[tokio::test]
async fn the_app_trades_a_signed_jwt_for_an_installation_token() {
    let fake = start().await;
    let now = unix_now();
    let res = fake
        .installation_token(&app_jwt(now - 30, now + 540, fake_github::DEV_APP_KEY))
        .await;
    assert_eq!(res.status(), 201);
    let body: Value = res.json().await.unwrap();
    assert!(body["token"].as_str().unwrap().starts_with("ghs_"));
    assert!(body["expires_at"].is_string());

    // Expired, over 10 minutes long, signed with another key, or not a JWT: each a 401 with
    // GitHub's error body. Its message text is unverified (#118), so only its shape is checked.
    let other = include_str!("other-key.pem");
    for (jwt, what) in [
        (
            app_jwt(now - 700, now - 100, fake_github::DEV_APP_KEY),
            "expired",
        ),
        (
            app_jwt(now, now + 1200, fake_github::DEV_APP_KEY),
            "too long",
        ),
        (app_jwt(now - 30, now + 540, other), "another key"),
        ("not.a.jwt".to_owned(), "not a JWT"),
    ] {
        let res = fake.installation_token(&jwt).await;
        assert_eq!(res.status(), 401, "{what}");
        let body: Value = res.json().await.unwrap();
        assert!(body["message"].is_string(), "{what}: {body}");
        assert_eq!(body["status"], "401", "{what}");
    }
}

#[tokio::test]
async fn graphql_shows_an_issues_edges_only_where_the_token_can_see_the_other_end() {
    let fake = start().await;
    let web = unlinked_in("web");
    let api = unlinked_in("api");
    let summary: Value = serde_json::from_str(
        &std::fs::read_to_string(
            fixture().with_file_name(format!("fixture-1k-{}.json", fixture::GENERATOR_HASH)),
        )
        .unwrap(),
    )
    .unwrap();
    let stub = format!("partner-sdk#{}", summary["stub_numbers"][0]);
    let (me, node) = (&web[0].0, &web[0].2);
    fake.edit(edit_of(
        me,
        json!({ "add_sub_issue": web[1].0, "add_blocked_by": api[0].0, "add_relates_to": stub }),
    ))
    .await;
    fake.edit(edit_of(&web[2].0, json!({ "add_sub_issue": me })))
        .await;

    let now = unix_now();
    let res = fake
        .installation_token(&app_jwt(now - 30, now + 540, fake_github::DEV_APP_KEY))
        .await;
    let token = res.json::<Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let got = fake.edges(&token, node).await;
    let issue = &got["data"]["node"];
    assert_eq!(issue["databaseId"], web[0].1);
    assert_eq!(issue["parent"]["databaseId"], web[2].1);
    assert_eq!(issue["subIssues"]["nodes"][0]["databaseId"], web[1].1);
    assert_eq!(issue["blockedBy"]["nodes"][0]["databaseId"], api[0].1);
    assert_eq!(issue["blockedBy"]["nodes"][0]["repository"]["name"], "api");
    assert_eq!(issue["blocking"]["nodes"], json!([]));
    // The App isn't installed on partner-sdk, but it's public.
    let rel = &issue["relatesTo"]["nodes"][0];
    assert_eq!(rel["repository"]["name"], "partner-sdk");
    assert_eq!(rel["repository"]["isPrivate"], false);
    assert_eq!(
        rel["state"].as_str().map(|s| s == "OPEN" || s == "CLOSED"),
        Some(true)
    );

    // octo-ext sees web and docs, and partner-sdk (public), but not api: that end is left out.
    let user = fake.sign_in("octo-ext").await["access_token"]
        .as_str()
        .unwrap()
        .to_owned();
    let got = fake.edges(&user, node).await;
    let issue = &got["data"]["node"];
    assert_eq!(issue["blockedBy"]["nodes"], json!([]));
    assert_eq!(issue["subIssues"]["nodes"][0]["databaseId"], web[1].1);
    assert_eq!(issue["relatesTo"]["nodes"].as_array().unwrap().len(), 1);
    // And an issue in api isn't there at all: `node` is null, with GitHub's NOT_FOUND error on
    // it (docs/research/issue-edge-cases.md).
    let got = fake.edges(&user, &api[0].2).await;
    assert_eq!(got["data"]["node"], Value::Null);
    assert_eq!(got["errors"][0]["type"], "NOT_FOUND");
    assert_eq!(got["errors"][0]["path"], json!(["node"]));
    // Nor is an id GitHub never had.
    let got = fake.edges(&user, "I_unknown").await;
    assert_eq!(got["data"]["node"], Value::Null);
    assert_eq!(got["errors"][0]["type"], "NOT_FOUND");

    // The control port counts the calls by the kind of token they came with, and by operation.
    let calls = &fake.state().await["graphql"];
    assert_eq!(
        (&calls["installation"], &calls["user"]),
        (&json!(1), &json!(3))
    );
    assert_eq!(calls["operations"], json!({ "IssueEdges": 4 }));
}

#[tokio::test]
async fn graphql_pages_relates_to_100_at_a_time_newest_first() {
    let fake = start().await;
    let web = unlinked_in("web");
    let (me, node) = (&web[0].0, &web[0].2);
    // 101 links: web issues by number, skipping what GitHub refuses (PRs, itself).
    let mut linked = 0;
    for n in 1.. {
        let res = fake
            .http
            .post(format!("{}/edit", fake.ctl))
            .json(&edit_of(
                me,
                json!({ "add_relates_to": format!("web#{n}") }),
            ))
            .send()
            .await
            .unwrap();
        linked += usize::from(res.status().is_success());
        if linked == 101 {
            break;
        }
    }
    let now = unix_now();
    let token = fake
        .installation_token(&app_jwt(now - 30, now + 540, fake_github::DEV_APP_KEY))
        .await
        .json::<Value>()
        .await
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let page = |after: Value| {
        let (http, api, token) = (fake.http.clone(), fake.api.clone(), token.clone());
        async move {
            let res = http
                .post(format!("{api}/graphql"))
                .bearer_auth(token)
                .json(&json!({
                    "query": EDGES,
                    "variables": {
                        "id": node, "sub": false, "blocks": false, "relates": true,
                        "relatesAfter": after,
                    },
                }))
                .send()
                .await
                .unwrap();
            res.json::<Value>().await.unwrap()["data"]["node"]["relatesTo"].clone()
        }
    };
    let first = page(Value::Null).await;
    let nodes = first["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 100);
    assert_eq!(first["pageInfo"]["hasNextPage"], true);
    let second = page(first["pageInfo"]["endCursor"].clone()).await;
    assert_eq!(second["pageInfo"]["hasNextPage"], false);
    let rest = second["nodes"].as_array().unwrap();
    assert_eq!(rest.len(), 1);
    // Newest first: the links went in by ascending number.
    let numbers: Vec<i64> = nodes
        .iter()
        .chain(rest)
        .map(|n| n["number"].as_i64().unwrap())
        .collect();
    let mut newest_first = numbers.clone();
    newest_first.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(numbers, newest_first);
}

#[tokio::test]
async fn an_installation_token_gets_the_permissions_asked_for_within_the_apps() {
    let fake = start().await;
    let now = unix_now();
    let jwt = app_jwt(now - 30, now + 540, fake_github::DEV_APP_KEY);
    let mint = |body: Value| {
        let (http, api, jwt) = (fake.http.clone(), fake.api.clone(), jwt.clone());
        async move {
            http.post(format!("{api}/app/installations/41000001/access_tokens"))
                .bearer_auth(jwt)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };

    // Without a body: everything the installation has.
    let all: Value = fake.installation_token(&jwt).await.json().await.unwrap();
    assert_eq!(
        all["permissions"],
        json!({ "issues": "write", "metadata": "read", "pull_requests": "read" })
    );
    // Narrowed to what's asked.
    let res = mint(json!({ "permissions": { "issues": "read" } })).await;
    assert_eq!(res.status(), 201);
    let narrow: Value = res.json().await.unwrap();
    assert_eq!(narrow["permissions"], json!({ "issues": "read" }));
    // A body that isn't JSON: GitHub's 400.
    let res = fake
        .http
        .post(format!(
            "{}/app/installations/41000001/access_tokens",
            fake.api
        ))
        .bearer_auth(&jwt)
        .body("{permissions")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["message"], "Problems parsing JSON");
    // More than the installation has: GitHub's 422.
    for body in [
        json!({ "permissions": { "administration": "write" } }),
        json!({ "permissions": { "pull_requests": "write" } }),
    ] {
        assert_eq!(mint(body.clone()).await.status(), 422, "{body}");
    }
    // The control port lists each token minted, with its permissions.
    let state = fake.state().await;
    let minted: Vec<&Value> = state["installation_tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["permissions"])
        .collect();
    assert_eq!(minted, [&all["permissions"], &narrow["permissions"]]);
}

impl Fake {
    /// A GraphQL operation with an installation token: the whole answer.
    async fn query(&self, token: &Value, op: &str, variables: Value) -> Value {
        let res = self
            .http
            .post(format!("{}/graphql", self.api))
            .bearer_auth(token.as_str().unwrap())
            .json(&json!({ "query": format!("query {op} {{ … }}"), "operationName": op, "variables": variables }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.json().await.unwrap()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sweeps_queries_count_list_ids_and_read_edges_in_batches() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let web = unlinked_in("web");
    let (parent, a, b) = (&web[0], &web[1], &web[2]);
    let mut rx = receiver(&fake).await;
    fake.edit(edit_of(&parent.0, json!({ "add_sub_issue": a.0 })))
        .await;
    fake.edit(edit_of(&parent.0, json!({ "add_sub_issue": b.0 })))
        .await;

    let ids = |v: &Value, field: &str| -> Vec<i64> {
        v["data"]["repository"][field]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["databaseId"].as_i64().unwrap())
            .collect()
    };
    let mut issues = Vec::new();
    let mut after = Value::Null;
    loop {
        let page = fake
            .query(
                &token,
                "SweepIssueIds",
                json!({ "owner": "acme", "name": "web", "after": after }),
            )
            .await;
        issues.extend(ids(&page, "issues"));
        let info = &page["data"]["repository"]["issues"]["pageInfo"];
        if info["hasNextPage"] != true {
            assert_eq!(
                page["data"]["repository"]["issues"]["totalCount"]
                    .as_u64()
                    .unwrap() as usize,
                issues.len()
            );
            break;
        }
        after = info["endCursor"].clone();
    }
    assert!(
        issues.contains(&parent.1) && issues.len() > 100,
        "{}",
        issues.len()
    );
    let prs = fake
        .query(
            &token,
            "SweepPullIds",
            json!({ "owner": "acme", "name": "web", "after": null }),
        )
        .await;
    assert!(!ids(&prs, "pullRequests").is_empty());
    assert!(
        ids(&prs, "pullRequests")
            .iter()
            .all(|id| !issues.contains(id))
    );

    // Counts: every state, issues and PRs apart, by the repo's node id.
    let user = &fake.sign_in("tomsj").await["access_token"];
    let repo: Value = fake
        .get("/repos/acme/web", user)
        .await
        .json()
        .await
        .unwrap();
    let counts = fake
        .query(&token, "SweepCounts", json!({ "ids": [repo["node_id"]] }))
        .await;
    let n = &counts["data"]["nodes"][0];
    assert_eq!(n["databaseId"], repo["id"]);
    assert_eq!(
        n["issues"]["totalCount"].as_u64().unwrap() as usize,
        issues.len()
    );
    assert!(n["pullRequests"]["totalCount"].as_u64().unwrap() > 0);

    // Edges, for many issues at once; a reorder moves a child up and sends no webhook.
    let vars = json!({ "ids": [parent.2, a.2], "sub": true, "blocks": false, "relates": false });
    let got = fake.query(&token, "SweepEdges", vars.clone()).await;
    let children = |v: &Value| -> Vec<i64> {
        v["data"]["nodes"][0]["subIssues"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["databaseId"].as_i64().unwrap())
            .collect()
    };
    assert_eq!(children(&got), [a.1, b.1]);
    assert_eq!(got["data"]["nodes"][0]["id"], parent.2.as_str());
    assert_eq!(got["data"]["nodes"][1]["parent"]["databaseId"], parent.1);
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let sent = fake
        .edit(edit_of(&parent.0, json!({ "prioritize_sub_issue": b.0 })))
        .await;
    assert_eq!(sent["deliveries"], 0);
    assert!(
        received_for(&mut rx, Duration::from_millis(1500))
            .await
            .is_empty()
    );
    assert_eq!(
        children(&fake.query(&token, "SweepEdges", vars).await),
        [b.1, a.1]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_label_and_milestone_read_by_their_own_urls_are_404s_once_gone() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let list = |path: &'static str| {
        let (fake, token) = (&fake, &token);
        async move { fake.get(path, token).await.json::<Value>().await.unwrap() }
    };
    let comment = list("/repos/acme/web/issues/comments?sort=updated&direction=asc&per_page=1")
        .await[0]
        .clone();
    let label = list("/repos/acme/web/labels?per_page=1").await[0].clone();
    let milestone = list("/repos/acme/web/milestones?state=all&per_page=1").await[0].clone();
    let one = |path: String| {
        let (fake, token) = (&fake, &token);
        async move {
            let res = fake.get(&path, token).await;
            let status = res.status().as_u16();
            (status, res.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let id = comment["id"].as_i64().unwrap();
    assert_eq!(
        one(format!("/repos/acme/web/issues/comments/{id}")).await,
        (200, comment)
    );
    // Labels are found by name, whatever its case, escaped as a path segment.
    let name = label["name"]
        .as_str()
        .unwrap()
        .to_uppercase()
        .replace(' ', "%20");
    assert_eq!(
        one(format!("/repos/acme/web/labels/{name}")).await,
        (200, label)
    );
    let number = milestone["number"].as_i64().unwrap();
    assert_eq!(
        one(format!("/repos/acme/web/milestones/{number}")).await,
        (200, milestone)
    );
    for path in [
        "/repos/acme/web/issues/comments/1",
        "/repos/acme/web/labels/no-such-label",
        "/repos/acme/web/milestones/9999",
    ] {
        assert_eq!(one(path.to_owned()).await.0, 404, "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_created_or_renamed_sends_its_label_delivery() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let created = fake
        .control(
            reqwest::Method::POST,
            "/label",
            json!({ "repo": "web", "name": "needs-design", "color": "112233" }),
        )
        .await;
    let id = created["id"].as_i64().unwrap();
    fake.control(
        reqwest::Method::POST,
        "/label",
        json!({ "repo": "web", "name": "needs-design", "rename": "needs-ux" }),
    )
    .await;
    let got = received_for(&mut rx, Duration::from_millis(2500)).await;
    let said: Vec<(String, Value, Value, Value)> = got
        .iter()
        .map(|r| {
            let p = r.payload();
            (
                r.event.clone(),
                p["action"].clone(),
                json!([p["label"]["id"], p["label"]["name"], p["label"]["color"]]),
                p["changes"].clone(),
            )
        })
        .collect();
    assert_eq!(
        said,
        [
            (
                "label".to_owned(),
                json!("created"),
                json!([id, "needs-design", "112233"]),
                Value::Null
            ),
            (
                "label".to_owned(),
                json!("edited"),
                json!([id, "needs-ux", "112233"]),
                json!({ "name": { "from": "needs-design" } })
            ),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_item_updated_between_pages_slides_the_next_one_past_the_page_boundary() {
    // GitHub's `updated` lists page by offset: the fake's do too, so a sweep can be shown the
    // skip it has to survive.
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let base = "/repos/acme/web/issues?state=all&sort=updated&direction=asc&per_page=100";
    let ids = |v: Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_i64().unwrap())
            .collect()
    };
    let page = |n: u32| {
        let (fake, token) = (&fake, &token);
        async move {
            ids(fake
                .get(&format!("{base}&page={n}"), token)
                .await
                .json::<Value>()
                .await
                .unwrap())
        }
    };
    let (first, second) = (page(1).await, page(2).await);
    let number = fake.get(base, &token).await.json::<Value>().await.unwrap()[0]["number"]
        .as_i64()
        .unwrap();
    fake.edit(json!({ "repo": "web", "number": number, "title": "Updated between pages" }))
        .await;
    let after = page(2).await;
    assert_eq!(after[..99], second[1..], "the second page moved up by one");
    assert!(!first.contains(&second[0]) && !after.contains(&second[0]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_graphql_query_costs_what_githubs_formula_says() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let used = |query: &'static str, vars: Value| {
        let (fake, token) = (&fake, &token);
        async move {
            let res = fake
                .http
                .post(format!("{}/graphql", fake.api))
                .bearer_auth(token.as_str().unwrap())
                .json(&json!({ "query": query, "variables": vars }))
                .send()
                .await
                .unwrap();
            header_i64(&res, "x-ratelimit-used")
        }
    };
    let ids: Vec<String> = (0..100).map(|n| format!("I_{n}")).collect();
    let mut last = 0;
    // The research's worked examples (docs/research/mirror-import-and-reconciliation.md §1).
    for (query, vars, cost) in [
        // One connection of 100: 1 request, rounded up to the minimum of 1.
        (
            "query ImportIssues($owner: String!, $name: String!, $after: String) {
              repository(owner: $owner, name: $name) {
                issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } }
              }
            }",
            json!({ "owner": "acme", "name": "web" }),
            1,
        ),
        // Labels and assignees under each of 100 issues: 1 + 200 = 201 requests, 2 points.
        (
            "query ImportIssues($owner: String!, $name: String!) {
              repository(owner: $owner, name: $name) {
                issues(first: 100) { nodes { id labels(first: 20) { nodes { name } }
                  assignees(first: 10) { nodes { login } } } }
              }
            }",
            json!({ "owner": "acme", "name": "web" }),
            2,
        ),
        // `nodes(ids:)` of 100 with three edge lists, one left out: 1 + 300 = 301, 3 points.
        (
            "query SweepEdges($ids: [ID!]!, $relates: Boolean!) {
              nodes(ids: $ids) { ... on Issue { ...Ends relatesTo(first: 100) @include(if: $relates) { nodes { id } } } }
            }
            fragment Ends on Issue { subIssues(first: 100) { nodes { id } } blocking(first: 50) { nodes { id } } blockedBy(first: 50) { nodes { id } } }",
            json!({ "ids": ids, "relates": false }),
            3,
        ),
    ] {
        let now = used(query, vars).await;
        assert_eq!(now - last, cost, "{query}");
        last = now;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_an_issue_sends_issues_deleted_and_github_no_longer_counts_it_or_links_it() {
    let fake = start().await;
    let token = fake.installation_token_value().await;
    let web = unlinked_in("web");
    let (parent, doomed) = (&web[0], &web[1]);
    let mut rx = receiver(&fake).await;
    fake.edit(edit_of(&parent.0, json!({ "add_sub_issue": doomed.0 })))
        .await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let user = &fake.sign_in("tomsj").await["access_token"];
    let repo: Value = fake
        .get("/repos/acme/web", user)
        .await
        .json()
        .await
        .unwrap();
    let issues = || async {
        fake.query(&token, "SweepCounts", json!({ "ids": [repo["node_id"]] }))
            .await["data"]["nodes"][0]["issues"]["totalCount"]
            .as_i64()
            .unwrap()
    };
    let before = issues().await;

    let sent = fake
        .edit(edit_of(&doomed.0, json!({ "delete": true })))
        .await;
    assert_eq!(sent["deliveries"], 1, "{sent}");
    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    assert_eq!(
        shapes(&got),
        [(
            "issues".into(),
            "deleted".into(),
            "web".into(),
            keys(&["issue"])
        )]
    );
    assert_eq!(got[0].payload()["issue"]["id"], doomed.1);
    assert_eq!(issues().await, before - 1);
    let edges = fake
        .query(
            &token,
            "SweepEdges",
            json!({ "ids": [parent.2], "sub": true, "blocks": false, "relates": false }),
        )
        .await;
    assert_eq!(
        edges["data"]["nodes"][0]["subIssues"]["nodes"],
        json!([]),
        "{edges}"
    );
    // Gone: a second delete has nothing to delete.
    let res = fake
        .http
        .post(format!("{}/edit", fake.ctl))
        .json(&edit_of(&doomed.0, json!({ "delete": true })))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

// --- labels, assignees and milestone ------------------------------------------------------------

/// The `issues` deliveries' actions and what each names (a label's or milestone's name, an
/// assignee's login), in the order they came.
fn issue_actions(got: &[Received]) -> Vec<(String, String)> {
    got.iter()
        .filter(|r| r.event == "issues")
        .map(|r| {
            let p = r.payload();
            let what = match p["action"].as_str().unwrap() {
                "labeled" | "unlabeled" => p["label"]["name"].clone(),
                "assigned" | "unassigned" => p["assignee"]["login"].clone(),
                "milestoned" | "demilestoned" => p["milestone"]["title"].clone(),
                _ => Value::Null,
            };
            (
                p["action"].as_str().unwrap().to_owned(),
                what.as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn names(labels: &Value) -> Vec<&str> {
    labels
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn labels_are_added_and_removed_by_name_with_triage_and_answer_the_labels_left() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // Triage on `infra`; start from an issue without the two labels.
    fake.edit(json!({ "repo": "infra", "number": 4, "remove_labels": ["p0", "good first issue"] }))
        .await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let token = &fake.sign_in("ilze-k").await["access_token"];
    let issue = "/repos/acme/infra/issues/4";

    let (status, labels) = fake
        .rest(
            reqwest::Method::POST,
            &format!("{issue}/labels"),
            token,
            json!({ "labels": ["p0"] }),
        )
        .await;
    assert_eq!(status, 200, "{labels}");
    assert!(names(&labels).contains(&"p0"), "{labels}");
    // A bare array of names, as GitHub also takes; a name with a space is one path segment.
    let (status, labels) = fake
        .rest(
            reqwest::Method::POST,
            &format!("{issue}/labels"),
            token,
            json!(["good first issue"]),
        )
        .await;
    assert_eq!(status, 200, "{labels}");
    assert!(names(&labels).contains(&"good first issue"));
    let (status, left) = fake
        .rest(
            reqwest::Method::DELETE,
            &format!("{issue}/labels/good%20first%20issue"),
            token,
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{left}");
    assert!(names(&left).contains(&"p0"));
    assert!(!names(&left).contains(&"good first issue"));
    // Removing a label the issue doesn't have is GitHub's 404, in its documented body: what tells
    // it from a 404 for an issue or repo the user can't see ("Not Found").
    let (status, body) = fake
        .rest(
            reqwest::Method::DELETE,
            &format!("{issue}/labels/good%20first%20issue"),
            token,
            Value::Null,
        )
        .await;
    assert_eq!(
        (status, body),
        (
            404,
            json!({
                "message": "Label does not exist",
                "documentation_url": "https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue",
                "status": "404",
            })
        )
    );

    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(
        issue_actions(&got),
        [
            ("labeled".into(), "p0".into()),
            ("labeled".into(), "good first issue".into()),
            ("unlabeled".into(), "good first issue".into()),
        ]
    );
    assert_eq!(got[0].payload()["sender"]["login"], "ilze-k");

    // A label the repo doesn't have would be created by GitHub, which the fake doesn't model.
    let (status, _) = fake
        .rest(
            reqwest::Method::POST,
            &format!("{issue}/labels"),
            token,
            json!({ "labels": ["brand new"] }),
        )
        .await;
    assert_eq!(status, 422);
}

#[tokio::test]
async fn read_gets_403_on_labels_assignees_and_someone_elses_milestone() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // Read on `web`; the fixture's issues are by other users.
    let token = &fake.sign_in("octo-ext").await["access_token"];
    let issue = "/repos/acme/web/issues/3";
    for (method, path, body) in [
        (
            reqwest::Method::POST,
            format!("{issue}/labels"),
            json!({ "labels": ["bug"] }),
        ),
        (
            reqwest::Method::DELETE,
            format!("{issue}/labels/bug"),
            Value::Null,
        ),
        (
            reqwest::Method::POST,
            format!("{issue}/assignees"),
            json!({ "assignees": ["tomsj"] }),
        ),
        (
            reqwest::Method::DELETE,
            format!("{issue}/assignees"),
            json!({ "assignees": ["tomsj"] }),
        ),
        (
            reqwest::Method::PATCH,
            issue.to_owned(),
            json!({ "milestone": 3 }),
        ),
    ] {
        let (status, body) = fake.rest(method.clone(), &path, token, body).await;
        assert_eq!(status, 403, "{method} {path}: {body}");
        assert_eq!(body["message"], "Resource not accessible by integration");
    }
    assert!(
        received_for(&mut rx, Duration::from_millis(1500))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn assignees_are_whoever_can_be_assigned_and_anyone_else_is_silently_ignored() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    let res = fake
        .get("/repos/acme/web/assignees?per_page=100", token)
        .await;
    assert_eq!(res.status(), 200);
    let listed: Vec<String> = res
        .json::<Value>()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["login"].as_str().unwrap().to_owned())
        .collect();
    // The org's members, and the users the fixture assigns; not a Read outside collaborator.
    assert!(listed.contains(&"tomsj".to_owned()), "{listed:?}");
    assert!(listed.contains(&"ilze-k".to_owned()));
    assert!(listed.contains(&"anna-b".to_owned()));
    assert!(!listed.contains(&"octo-ext".to_owned()));
    let mut sorted = listed.clone();
    sorted.sort_by_key(|l| l.to_lowercase());
    assert_eq!(listed, sorted);
    // Paged as GitHub pages.
    let res = fake
        .get("/repos/acme/web/assignees?per_page=2", token)
        .await;
    assert!(
        res.headers()["link"]
            .to_str()
            .unwrap()
            .contains("rel=\"next\"")
    );

    let issue = "/repos/acme/web/issues/5";
    fake.rest(
        reqwest::Method::DELETE,
        &format!("{issue}/assignees"),
        token,
        json!({ "assignees": ["ilze-k"] }),
    )
    .await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let (status, i) = fake
        .rest(
            reqwest::Method::POST,
            &format!("{issue}/assignees"),
            token,
            json!({ "assignees": ["ilze-k", "octo-ext"] }),
        )
        .await;
    assert_eq!(status, 201, "{i}");
    let logins = |i: &Value| -> Vec<String> {
        i["assignees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["login"].as_str().unwrap().to_owned())
            .collect()
    };
    assert!(logins(&i).contains(&"ilze-k".to_owned()));
    assert!(!logins(&i).contains(&"octo-ext".to_owned()));
    let (status, i) = fake
        .rest(
            reqwest::Method::DELETE,
            &format!("{issue}/assignees"),
            token,
            json!({ "assignees": ["ilze-k"] }),
        )
        .await;
    assert_eq!(status, 200, "{i}");
    assert!(!logins(&i).contains(&"ilze-k".to_owned()));
    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(
        issue_actions(&got),
        [
            ("assigned".into(), "ilze-k".into()),
            ("unassigned".into(), "ilze-k".into()),
        ]
    );
}

#[tokio::test]
async fn a_milestone_is_set_by_number_and_cleared_with_null() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    // Triage on `infra`.
    let token = &fake.sign_in("ilze-k").await["access_token"];
    let patch = |body: Value| {
        fake.rest(
            reqwest::Method::PATCH,
            "/repos/acme/infra/issues/6",
            token,
            body,
        )
    };
    patch(json!({ "milestone": null })).await;
    received_for(&mut rx, Duration::from_millis(1500)).await;
    let (status, i) = patch(json!({ "milestone": 3 })).await;
    assert_eq!(status, 200, "{i}");
    assert_eq!(i["milestone"]["number"], 3);
    let title = i["milestone"]["title"].as_str().unwrap().to_owned();
    let (status, i) = patch(json!({ "milestone": null })).await;
    assert_eq!(status, 200, "{i}");
    assert_eq!(i["milestone"], Value::Null);
    // A number the repo has no milestone for is GitHub's validation failure.
    assert_eq!(patch(json!({ "milestone": 99 })).await.0, 422);
    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(
        issue_actions(&got),
        [
            ("milestoned".into(), title.clone()),
            ("demilestoned".into(), title),
        ]
    );
}

#[tokio::test]
async fn a_label_rename_sends_label_edited_and_lists_by_its_new_name() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let done = fake
        .control(
            reqwest::Method::POST,
            "/label",
            json!({ "repo": "web", "name": "ux", "rename": "design" }),
        )
        .await;
    assert_eq!(done["label"]["name"], "design");
    let got = received_for(&mut rx, Duration::from_secs(2)).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].event, "label");
    let p = got[0].payload();
    assert_eq!(p["action"], "edited");
    assert_eq!(p["label"]["name"], "design");
    assert_eq!(p["changes"], json!({ "name": { "from": "ux" } }));
    let token = &fake.sign_in("tomsj").await["access_token"];
    let labels: Value = fake
        .get("/repos/acme/web/labels?per_page=100", token)
        .await
        .json()
        .await
        .unwrap();
    assert!(names(&labels).contains(&"design"));
    assert!(!names(&labels).contains(&"ux"));
}

#[tokio::test]
async fn whoever_can_be_assigned_follows_their_access_not_what_they_are_assigned_to() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    // An outside collaborator with Write can be assigned, and is.
    fake.control(
        reqwest::Method::PUT,
        "/permissions",
        json!({ "login": "octo-ext", "repo": "web", "role": "write" }),
    )
    .await;
    let issue = "/repos/acme/web/issues/5";
    let (status, i) = fake
        .rest(
            reqwest::Method::POST,
            &format!("{issue}/assignees"),
            token,
            json!({ "assignees": ["octo-ext"] }),
        )
        .await;
    assert_eq!(status, 201, "{i}");
    assert!(i["assignees"].to_string().contains("octo-ext"), "{i}");
    // Down to Read, still assigned: no longer someone who can be assigned.
    fake.control(
        reqwest::Method::PUT,
        "/permissions",
        json!({ "login": "octo-ext", "repo": "web", "role": "read" }),
    )
    .await;
    let res = fake
        .get("/repos/acme/web/assignees?per_page=100", token)
        .await;
    let listed = res.json::<Value>().await.unwrap().to_string();
    assert!(!listed.contains("\"octo-ext\""), "{listed}");
}

#[tokio::test]
async fn the_assignee_list_answers_304_to_its_own_etag_until_it_changes() {
    let fake = start().await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    let path = "/repos/acme/web/assignees?per_page=100";
    let conditional = |etag: &str| {
        fake.http
            .get(format!("{}{path}", fake.api))
            .bearer_auth(token.as_str().unwrap())
            .header("if-none-match", etag)
    };
    let first = fake.get(path, token).await;
    assert_eq!(first.status(), 200);
    let etag = first.headers()["etag"].to_str().unwrap().to_owned();
    // Unchanged: 304, which GitHub doesn't count against the rate limit.
    let again = conditional(&etag).send().await.unwrap();
    assert_eq!(again.status(), 304);
    assert_eq!(again.headers()["etag"].to_str().unwrap(), etag);
    assert_eq!(
        fake.state().await["assignees"],
        json!({ "full": 1, "not_modified": 1 })
    );
    // Someone new can be assigned: the list, under a new ETag.
    fake.control(
        reqwest::Method::PUT,
        "/permissions",
        json!({ "login": "octo-ext", "repo": "web", "role": "write" }),
    )
    .await;
    let changed = conditional(&etag).send().await.unwrap();
    assert_eq!(changed.status(), 200);
    assert_ne!(changed.headers()["etag"].to_str().unwrap(), etag);
    assert!(changed.text().await.unwrap().contains("\"octo-ext\""));
}

#[tokio::test]
async fn a_deleted_issue_answers_410_as_on_github_and_sends_issues_deleted() {
    let fake = start().await;
    let mut rx = receiver(&fake).await;
    let token = &fake.sign_in("tomsj").await["access_token"];
    let (status, before) = fake
        .rest(
            reqwest::Method::GET,
            "/repos/acme/web/issues/1",
            token,
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{before}");

    fake.control(
        reqwest::Method::POST,
        "/edit",
        json!({ "repo": "web", "number": 1, "as": "tomsj", "delete": true }),
    )
    .await;
    let (status, gone) = fake
        .rest(
            reqwest::Method::GET,
            "/repos/acme/web/issues/1",
            token,
            Value::Null,
        )
        .await;
    assert_eq!(
        (status, &gone["message"]),
        (410, &json!("This issue was deleted"))
    );
    // A number the repo never had is still a 404.
    let (status, _) = fake
        .rest(
            reqwest::Method::GET,
            "/repos/acme/web/issues/999999",
            token,
            Value::Null,
        )
        .await;
    assert_eq!(status, 404);

    let got = received_for(&mut rx, Duration::from_secs(3)).await;
    assert_eq!(got.len(), 1);
    let p = got[0].payload();
    assert_eq!(
        (got[0].event.as_str(), &p["action"]),
        ("issues", &json!("deleted"))
    );
    assert_eq!(p["issue"]["id"], before["id"]);
    assert_eq!(p["sender"]["login"], "tomsj");
}
