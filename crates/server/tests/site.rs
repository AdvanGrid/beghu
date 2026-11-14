//! The public site: the prerendered pages (`web/site/`) at their paths, `/` among them, the same
//! for everyone whether signed in or not, cacheable by anyone, with beghu's origin filled in;
//! `robots.txt` and the sitemap beside them. The app is at `/issues` and tells crawlers to keep
//! out.

mod common;

use common::{Browser, start};

#[tokio::test(flavor = "multi_thread")]
async fn the_landing_page_is_the_same_for_everyone_and_any_cache_may_keep_it() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "public, max-age=300");
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(res.headers().get("set-cookie").is_none());
    let html = res.text().await.unwrap();
    assert!(html.contains("The landing page"), "{html}");

    // Signed in, `/` is still the landing page: no redirect to the app.
    let mut signed_in = s.sign_in("tomsj").await;
    let res = s.get(&mut signed_in, "/").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), html);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_names_beghus_own_origin() {
    let s = start().await;
    let html = s
        .get(&mut Browser::default(), "/pricing")
        .await
        .text()
        .await
        .unwrap();
    let canonical = format!(r#"<link rel="canonical" href="{}/pricing">"#, s.server);
    assert!(html.contains(&canonical), "{html}");
    assert!(!html.contains("%BEGHU_ORIGIN%"), "{html}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_the_browser_holds_is_a_304() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/").await;
    let etag = res.headers()["etag"].to_str().unwrap().to_owned();
    let again = s
        .http
        .get(format!("{}/", s.server))
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 304);
    assert_eq!(again.headers()["etag"], etag.as_str());
    assert_eq!(again.headers()["cache-control"], "public, max-age=300");

    // Another page's tag doesn't match.
    let other = s
        .http
        .get(format!("{}/pricing", s.server))
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn robots_and_the_sitemap_point_crawlers_at_the_site() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/robots.txt").await;
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/plain")
    );
    let robots = res.text().await.unwrap();
    assert!(
        robots.contains(&format!("Sitemap: {}/sitemap.xml", s.server)),
        "{robots}"
    );

    let res = s.get(&mut Browser::default(), "/sitemap.xml").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "application/xml");
    let sitemap = res.text().await.unwrap();
    assert!(
        sitemap.contains(&format!("<loc>{}/</loc>", s.server)),
        "{sitemap}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_is_at_issues_and_asks_not_to_be_indexed() {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/issues").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-robots-tag"], "noindex");
    assert!(
        res.text()
            .await
            .unwrap()
            .contains(r#"<meta name="beghu-build""#)
    );
    // A path that is neither the site's nor the app's is a plain 404.
    let res = s.get(&mut Browser::default(), "/nothing-here").await;
    assert_eq!(res.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_web_build_without_its_site_stops_startup_and_says_so() {
    let mut s = start().await;
    std::fs::remove_file(s.web.join("site").join("pages.json")).unwrap();
    let err = s.try_restart_with(|_| {}).await.unwrap_err();
    assert!(err.contains("site/pages.json"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_site_page_on_one_of_the_apps_paths_stops_startup() {
    let mut s = start().await;
    std::fs::write(
        s.web.join("site").join("pages.json"),
        r#"[{"path":"/issues","file":"index.html"}]"#,
    )
    .unwrap();
    let err = s.try_restart_with(|_| {}).await.unwrap_err();
    assert!(err.contains("/issues"), "{err}");
}
