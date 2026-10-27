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
async fn token_lifetimes_set_at_runtime_expire_tokens_within_seconds() {
    let fake = start().await;
    fake.control(
        reqwest::Method::PUT,
        "/tokens",
        json!({ "access_ttl": 1, "refresh_ttl": 10 }),
    )
    .await;
    let a = fake.sign_in("tomsj").await;
    let b = fake.sign_in("tomsj").await;
    assert_eq!(a["expires_in"], 1);
    assert_eq!(a["refresh_token_expires_in"], 10);
    assert_eq!(
        fake.login_of(&a["access_token"]).await.as_deref(),
        Some("tomsj")
    );

    // The fake's clock moves on: past the access tokens, well inside the refresh tokens.
    fake.control(reqwest::Method::PUT, "/clock", json!({ "offset": 3 }))
        .await;
    assert_eq!(fake.state().await["clock"], json!({ "offset": 3 }));
    assert_eq!(fake.login_of(&a["access_token"]).await, None);
    assert!(fake.refresh(&b["refresh_token"]).await["access_token"].is_string());

    // And past the refresh tokens too.
    fake.control(reqwest::Method::PUT, "/clock", json!({ "offset": 12 }))
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
            "fail": [{ "endpoint": "*", "remaining": 3, "status": 502, "retry_after": null }],
        })
    );

    fake.control(reqwest::Method::POST, "/reset", json!({}))
        .await;
    let state = fake.state().await;
    assert_eq!(state["signed_in"], json!([]));
    assert_eq!(
        state["faults"],
        json!({ "down": false, "latency": [], "fail": [] })
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
