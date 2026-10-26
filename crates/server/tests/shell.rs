//! The SPA shell: account-free, cached for 5 minutes, and generated per URL with preloads for
//! `/api/me` and that URL's list page, so the data fetches start alongside the JS.

mod common;

use common::{Browser, start};

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_preloads_api_me_and_the_urls_list_page_and_caches_for_five_minutes() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "max-age=300");
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(res.headers().get("set-cookie").is_none());
    let html = res.text().await.unwrap();
    assert!(
        html.contains(r#"<link rel="preload" href="/api/me" as="fetch" crossorigin>"#),
        "{html}"
    );
    assert!(
        html.contains(r#"<link rel="preload" href="/api/issues" as="fetch" crossorigin>"#),
        "{html}"
    );

    let res = s
        .get(
            &mut Browser::default(),
            "/issues/3000040375?label=bug&q=a%20b",
        )
        .await;
    assert_eq!(res.status(), 200);
    let html = res.text().await.unwrap();
    assert!(
        html.contains(r#"href="/api/issues?label=bug&amp;q=a%20b""#),
        "the list page of this URL: {html}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_is_the_same_whoever_asks() {
    let s = start().await;
    let mut signed_in = s.sign_in("tomsj").await;
    let a = s
        .get(&mut Browser::default(), "/?x=1")
        .await
        .text()
        .await
        .unwrap();
    let res = s.get(&mut signed_in, "/?x=1").await;
    assert!(res.headers().get("set-cookie").is_none());
    assert_eq!(res.text().await.unwrap(), a);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_asset_is_a_404_never_the_shell() {
    let s = start().await;
    let res = s
        .get(&mut Browser::default(), "/assets/index-deadbeef.js")
        .await;
    assert_eq!(res.status(), 404);
}
