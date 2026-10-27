//! The SPA shell: account-free, cached for 5 minutes, and generated per URL with preloads for
//! `/api/me`, the filter bar's facets, that URL's list page and the issue it opens, so the data
//! fetches start alongside the JS. An issue's URL also modulepreloads the issue panel's chunk, so
//! it loads alongside the entry instead of after it.

mod common;

use common::{Browser, PANEL_CHUNK, start};

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_preloads_api_me_the_facets_the_urls_list_page_and_its_issue_and_caches_for_five_minutes()
 {
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
        html.contains(r#"<link rel="preload" href="/api/facets" as="fetch" crossorigin>"#),
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
    assert!(
        html.contains(
            r#"<link rel="preload" href="/api/issues/3000040375" as="fetch" crossorigin>"#
        ),
        "the issue this URL opens: {html}"
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

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_url_preloads_the_issue_the_app_will_fetch() {
    let s = start().await;
    let preloads = |html: &str| -> Vec<String> {
        html.split(r#"<link rel="preload" href=""#)
            .skip(1)
            .map(|l| l.split('"').next().unwrap().to_owned())
            .filter(|h| h.starts_with("/api/issues/"))
            .collect()
    };
    for (url, want) in [
        // Leading zeros name the same issue: the app fetches it without them.
        ("/issues/007", vec!["/api/issues/7"]),
        ("/issues/7", vec!["/api/issues/7"]),
        // Not an issue id: the app fetches nothing to preload.
        ("/issues/7x", vec![]),
        ("/issues/", vec![]),
        ("/issues/99999999999999999999", vec![]),
    ] {
        let html = s
            .get(&mut Browser::default(), url)
            .await
            .text()
            .await
            .unwrap();
        assert_eq!(preloads(&html), want, "{url}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_url_modulepreloads_the_panel_chunk_and_the_list_does_not() {
    let s = start().await;
    let html = |url: &'static str| {
        let s = &s;
        async move {
            s.get(&mut Browser::default(), url)
                .await
                .text()
                .await
                .unwrap()
        }
    };
    let tag = format!(r#"<link rel="modulepreload" crossorigin href="/{PANEL_CHUNK}">"#);
    // Any id the route matches: the panel shows even an issue the server won't find.
    for url in ["/issues/1", "/issues/007?label=bug", "/issues/x"] {
        assert!(html(url).await.contains(&tag), "{url}: {tag}");
    }
    for url in ["/", "/?label=bug"] {
        assert!(!html(url).await.contains("modulepreload"), "{url}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_web_build_without_its_vite_manifest_stops_startup_and_says_so() {
    let mut s = start().await;
    std::fs::remove_file(s.web.join(".vite").join("manifest.json")).unwrap();
    let err = s.try_restart_with(|_| {}).await.unwrap_err();
    assert!(err.contains(".vite/manifest.json"), "{err}");
}
