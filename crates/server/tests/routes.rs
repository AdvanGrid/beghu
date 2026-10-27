//! What a path beghu doesn't serve gets. An unknown `/api/` path is a JSON 404 the client turns
//! into `Gone`, signed in or not; anything else unknown is a plain 404, as the SPA has no route
//! there for a shell to show. A deep link to an issue gets the shell, signed out too (`shell.rs`).

mod common;

use common::{BUILD, Browser, start};

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_path_outside_the_api_is_a_plain_404() {
    let s = start().await;
    let mut signed_in = s.sign_in("tomsj").await;
    for path in ["/nope", "/robots.txt", "/issues", "/issues/1/extra"] {
        for b in [&mut Browser::default(), &mut signed_in] {
            let res = s.get(b, path).await;
            assert_eq!(res.status(), 404, "{path}");
            assert!(res.headers().get("x-beghu-build").is_none(), "{path}");
            assert_ne!(
                res.headers()
                    .get("cache-control")
                    .map(|v| v.to_str().unwrap()),
                Some("no-store"),
                "{path}"
            );
            let body = res.text().await.unwrap();
            assert!(!body.contains("signed_out"), "{path}: {body}");
            assert!(!body.contains("beghu:preload"), "{path}: {body}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_api_path_is_a_json_404_signed_in_or_not() {
    let s = start().await;
    let mut signed_in = s.sign_in("tomsj").await;
    for path in ["/api/nope", "/api/issues/x/y", "/api"] {
        for b in [&mut Browser::default(), &mut signed_in] {
            let res = s.get(b, path).await;
            assert_eq!(res.status(), 404, "{path}");
            assert_eq!(res.headers()["cache-control"], "no-store", "{path}");
            assert_eq!(res.headers()["x-beghu-build"], BUILD, "{path}");
            let body: serde_json::Value = res.json().await.unwrap();
            assert_eq!(body["error"], "not_found", "{path}: {body}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_not_modified_asset_keeps_its_cache_headers() {
    let mut s = start().await;
    let assets = s.web.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("index-abc123.js"), "export {};\n").unwrap();
    // A start copies its build's assets to the volume, which serves them.
    s.restart_with(|_| {}).await;
    let url = format!("{}/assets/index-abc123.js", s.server);

    let first = s.http.get(&url).send().await.unwrap();
    assert_eq!(first.status(), 200);
    let modified = first.headers()["last-modified"].clone();

    let res = s
        .http
        .get(&url)
        .header("if-modified-since", modified)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 304);
    assert_eq!(
        res.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(res.headers()["vary"], "accept-encoding");
}
