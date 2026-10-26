//! Signing in: the GitHub App web flow with PKCE and `state`, the `__Host-beghu_sid` session
//! cookie, and a signed-out API answering 401 so the client can send the user to sign in.

mod common;

use common::{Browser, SID, contains, db_bytes, location, query_param, start};

#[tokio::test(flavor = "multi_thread")]
async fn healthz_names_the_build_without_a_session() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/healthz").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-beghu-build"], common::BUILD);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_api_call_is_a_401_that_is_never_cached() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/api/me").await;
    assert_eq!(res.status(), 401);
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert_eq!(res.headers()["x-beghu-build"], common::BUILD);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["error"], "signed_out");
}

#[tokio::test(flavor = "multi_thread")]
async fn login_sends_the_browser_to_github_with_pkce_and_state_and_passes_login_through() {
    let s = start().await;
    let res = s
        .get(
            &mut Browser::default(),
            "/auth/login?next=/issues/5&login=tomsj",
        )
        .await;
    assert_eq!(res.status(), 302);
    let to = location(&res);
    assert!(to.contains("/login/oauth/authorize?"), "{to}");
    assert_eq!(
        query_param(&to, "client_id").as_deref(),
        Some(common::CLIENT_ID)
    );
    assert_eq!(
        query_param(&to, "redirect_uri"),
        Some(format!("{}/auth/callback", s.server))
    );
    assert_eq!(
        query_param(&to, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(
        query_param(&to, "code_challenge").map(|c| c.len()),
        Some(43)
    );
    assert!(query_param(&to, "state").is_some_and(|st| st.len() >= 32));
    assert_eq!(query_param(&to, "login").as_deref(), Some("tomsj"));
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_lands_on_next_with_a_session_cookie_and_api_me_names_the_account() {
    let s = start().await;
    let mut b = Browser::default();
    let (visited, res) = s
        .follow(
            &mut b,
            "/auth/login?next=%2Fissues%2F5%3Fq%3Dx&login=ilze-k",
        )
        .await;
    assert_eq!(
        visited.last().unwrap(),
        &format!("{}/issues/5?q=x", s.server)
    );
    assert!(res.status().is_success());

    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["account"]["login"], "ilze-k");
    assert_eq!(me["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(me["comment_order"], "newest");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_session_cookie_is_256_random_bits_http_only_secure_lax_for_30_days() {
    let s = start().await;
    let mut b = Browser::default();
    let res = s.get(&mut b, "/auth/login?login=tomsj").await;
    let authorize = location(&res);
    let back = s.http.get(&authorize).send().await.unwrap();
    let res = s.get(&mut b, &location(&back)).await;
    assert_eq!(res.status(), 302);
    let sid = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .find(|v| v.starts_with(&format!("{SID}=")))
        .expect("a session cookie");
    let attrs: Vec<&str> = sid.split(';').map(str::trim).collect();
    for want in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(attrs.contains(&want), "{sid}");
    }
    assert!(
        !attrs
            .iter()
            .any(|a| a.to_ascii_lowercase().starts_with("domain=")),
        "a __Host- cookie has no Domain: {sid}"
    );
    let value = attrs[0].strip_prefix(&format!("{SID}=") as &str).unwrap();
    // 256 bits in unpadded base64url.
    assert_eq!(value.len(), 43, "{value}");
    assert!(
        value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    );

    let other = s.sign_in("tomsj").await;
    assert_ne!(other.cookies[SID], value, "each browser gets its own");
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_on_a_browser_with_a_session_gives_it_a_new_session_id_and_the_old_one_stops_working()
 {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let before = b.cookies[SID].clone();

    let (_, res) = s.follow(&mut b, "/auth/login?login=ilze-k").await;
    assert!(res.status().is_success(), "{}", res.status());
    let after = b.cookies[SID].clone();
    assert_ne!(after, before, "the session id is rotated at sign-in");

    // The session carries on under the new id, with both accounts.
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["account"]["login"], "ilze-k");
    let mut logins: Vec<_> = me["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["login"].as_str().unwrap().to_owned())
        .collect();
    logins.sort();
    assert_eq!(logins, ["ilze-k", "tomsj"]);

    // Whoever held the old id (planted or stolen before sign-in) holds nothing.
    let mut stale = Browser::default();
    stale.cookies.insert(SID.into(), before);
    let (status, body) = s.api(&mut stale, "/api/me").await;
    assert_eq!(status, 401);
    assert_eq!(body["error"], "signed_out");
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_on_a_browser_whose_session_expired_starts_with_only_the_new_account() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    // The session runs out (30 days unused). Written straight to the control DB, through its
    // own `touch_session` query, because no seam can do it: the server reads the system clock,
    // which a test can't turn forward, and waiting a month isn't an option. Only the expiry
    // changes; everything after it goes through HTTP.
    use base64::Engine as _;
    use sha2::Digest as _;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&b.cookies[SID])
        .unwrap();
    let id_hash = sha2::Sha256::digest(&raw).to_vec();
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    control_db::q::touch_session(&db, &id_hash, 0, 1).unwrap();
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);

    let (_, res) = s.follow(&mut b, "/auth/login?login=ilze-k").await;
    assert!(res.status().is_success(), "{}", res.status());
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["accounts"], serde_json::json!([me["account"]]), "{me}");
    assert_eq!(me["account"]["login"], "ilze-k");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_control_db_holds_neither_the_session_cookie_nor_a_plain_github_token() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let bytes = db_bytes(&s.control_db());
    assert!(!bytes.is_empty());
    let sid = &b.cookies[SID];
    assert!(!contains(&bytes, sid.as_bytes()), "the cookie is stored");
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sid)
        .unwrap();
    assert!(!contains(&bytes, &raw), "the cookie's bytes are stored");
    // GitHub's user tokens are `ghu_…` and `ghr_…`: only their ciphertext is kept.
    assert!(!contains(&bytes, b"ghu_"));
    assert!(!contains(&bytes, b"ghr_"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_callback_without_the_state_this_browser_started_is_refused() {
    let s = start().await;
    let mut attacker = Browser::default();
    let res = s.get(&mut attacker, "/auth/login?login=tomsj").await;
    let back = s.http.get(location(&res)).send().await.unwrap();
    let callback = location(&back);

    // The victim never started a sign-in: no state cookie.
    let mut victim = Browser::default();
    let res = s.get(&mut victim, &callback).await;
    assert_eq!(res.status(), 400);
    assert!(!victim.cookies.contains_key(SID));

    // A forged state with the right cookie fails too.
    let forged = callback.replace(
        &format!("state={}", query_param(&callback, "state").unwrap()),
        "state=forged",
    );
    let res = s.get(&mut attacker.clone(), &forged).await;
    assert_eq!(res.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn next_only_ever_leads_back_into_beghu() {
    let s = start().await;
    for next in [
        "//evil.example/x",
        "https://evil.example/",
        "/\\evil.example",
        "issues",
    ] {
        let mut b = Browser::default();
        let path = format!(
            "/auth/login?login=tomsj&next={}",
            serde_urlencoded::to_string([("n", next)]).unwrap()[2..].to_owned()
        );
        let (visited, _) = s.follow(&mut b, &path).await;
        assert_eq!(visited.last().unwrap(), &format!("{}/", s.server), "{next}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_next_with_non_ascii_text_still_lands_back_on_that_page() {
    let s = start().await;
    let mut b = Browser::default();
    let (visited, res) = s
        .follow(
            &mut b,
            "/auth/login?login=tomsj&next=%2F%3Fq%3D%C4%BCoti%20%C4%A3%C4%ABti%26x%3D1",
        )
        .await;
    assert!(res.status().is_success(), "{}", res.status());
    let last = visited.last().unwrap();
    let path = last.strip_prefix(&s.server).unwrap();
    assert_eq!(
        common::query_param(path, "q").as_deref(),
        Some("ļoti ģīti"),
        "{last}"
    );
    assert_eq!(common::query_param(path, "x").as_deref(), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn github_failing_mid_sign_in_says_so_and_offers_to_start_again_for_the_same_page() {
    let s = start().await;
    s.fake(
        "POST",
        "/faults/fail",
        serde_json::json!({ "endpoint": "POST /login/oauth/access_token", "status": 502 }),
    )
    .await;
    let mut b = Browser::default();
    let (_, res) = s
        .follow(&mut b, "/auth/login?login=tomsj&next=/issues/7")
        .await;
    assert_eq!(res.status(), 502);
    assert!(!b.cookies.contains_key(SID));
    let html = res.text().await.unwrap();
    assert!(html.contains("GitHub didn't answer"), "{html}");
    assert!(
        html.contains(r#"href="/auth/login?next=%2Fissues%2F7" rel="external""#),
        "{html}"
    );

    // The fault is spent: starting again signs in and lands on the same page.
    let (visited, _) = s
        .follow(&mut b, "/auth/login?login=tomsj&next=/issues/7")
        .await;
    assert_eq!(visited.last().unwrap(), &format!("{}/issues/7", s.server));
}
