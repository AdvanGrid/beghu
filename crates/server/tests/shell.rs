//! The SPA shell: account-free, cached for 5 minutes, and generated per URL with preloads for
//! `/api/me`, the filter bar's facets, that URL's list page and the issue it opens, so the data
//! fetches start alongside the JS. An issue's URL also modulepreloads the issue panel's chunk, so
//! it loads alongside the entry instead of after it; a Tree mode URL (`mode=tree`) preloads the
//! tree's first fetch and its chunk instead of the list page, as a Focus view URL on an issue
//! (`mode=focus&focus=`) does. A PR view's URL preloads `/api/me`, the PR's detail and its
//! analysis graph, and modulepreloads the view's chunk and the chunks it imports, with no list or
//! facets. It names its build, so the tab running it can tell when the server has moved on to
//! another (a deploy).

mod common;

use common::{Browser, PANEL_CHUNK, SHARED_CHUNK, TREE_CHUNK, VIEW_CHUNK, start};

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_preloads_api_me_the_facets_the_urls_list_page_and_its_issue_and_caches_for_five_minutes()
 {
    let s = start().await;
    let res = s.get(&mut Browser::default(), "/issues").await;
    assert_eq!(res.status(), 200);
    // The browser only: a shared cache (the edge) would keep serving a build's shell past a deploy.
    assert_eq!(res.headers()["cache-control"], "private, max-age=300");
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
            "/acme/web/issues/12?label=bug&q=a%20b",
        )
        .await;
    assert_eq!(res.status(), 200);
    let html = res.text().await.unwrap();
    assert!(
        html.contains(r#"href="/api/issues?label=bug&amp;q=a%20b""#),
        "the list page of this URL: {html}"
    );
    assert!(
        html.contains(r#"<link rel="preload" href="/api/at/acme/web/12" as="fetch" crossorigin>"#),
        "the issue this URL opens: {html}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_is_the_same_whoever_asks() {
    let s = start().await;
    let mut signed_in = s.sign_in("tomsj").await;
    let a = s
        .get(&mut Browser::default(), "/issues?x=1")
        .await
        .text()
        .await
        .unwrap();
    let res = s.get(&mut signed_in, "/issues?x=1").await;
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
            .filter(|h| h.starts_with("/api/at/"))
            .collect()
    };
    for (url, want) in [
        // Leading zeros name the same issue: the app fetches it without them.
        ("/acme/web/issues/007", vec!["/api/at/acme/web/7"]),
        ("/acme/web/issues/7", vec!["/api/at/acme/web/7"]),
        // A PR's URL, as on GitHub.
        ("/acme/web/pull/7", vec!["/api/at/acme/web/7"]),
        ("/acme/web.js/issues/7", vec!["/api/at/acme/web.js/7"]),
        // Not an issue number: the app fetches nothing to preload.
        ("/acme/web/issues/7x", vec![]),
        ("/acme/web/issues/99999999999999999999", vec![]),
        // Names GitHub wouldn't give a repo, whose escaping the app's might not match.
        ("/acme/w%20b/issues/7", vec![]),
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
    // Any issue the route matches: the panel shows even one the server won't find.
    for url in [
        "/acme/web/issues/1",
        "/acme/web/issues/007?label=bug",
        "/acme/web/pull/1",
        "/acme/web/issues/x",
    ] {
        assert!(html(url).await.contains(&tag), "{url}: {tag}");
    }
    for url in ["/issues", "/issues?label=bug"] {
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

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_names_the_build_it_belongs_to() {
    let mut s = start().await;
    let tag = |build: &str| format!(r#"<meta name="beghu-build" content="{build}">"#);
    let html = s.get(&mut Browser::default(), "/acme/web/issues/1").await;
    assert!(html.text().await.unwrap().contains(&tag(common::BUILD)));

    // A deploy: the shell's build is the server's, so a tab knows what it runs.
    s.restart_with(|c| c.build_id = "next-build".into()).await;
    let html = s
        .get(&mut Browser::default(), "/issues")
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains(&tag("next-build")), "{html}");
}

/// Every route the app has (`web/src/router.tsx`) gets the shell: a tab loads any of them afresh
/// once beghu runs a new build (`web/src/build.ts`), or when a route's code failed to load.
#[tokio::test(flavor = "multi_thread")]
async fn every_app_route_gets_the_shell() {
    let s = start().await;
    for path in [
        "/issues",
        "/acme/web/issues/1",
        "/acme/web/pull/1",
        "/acme/web/pull/1/view",
        "/acme/web/pull/1/view?sel=part:api",
        "/new",
        "/new?repo=acme%2Fweb",
        "/repos",
        "/prefs",
    ] {
        let res = s.get(&mut Browser::default(), path).await;
        assert_eq!(res.status(), 200, "{path}");
        assert!(
            res.text()
                .await
                .unwrap()
                .contains(r#"<meta name="beghu-build""#),
            "{path}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tree_mode_url_preloads_the_tree_and_its_chunk_in_place_of_the_list_page() {
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
    let tree = format!(r#"<link rel="modulepreload" crossorigin href="/{TREE_CHUNK}">"#);
    for (url, data) in [
        ("/issues?mode=tree", "/api/tree?mode=tree"),
        (
            "/acme/web/issues/7?q=label%3Abug&mode=tree",
            "/api/tree?q=label%3Abug&amp;mode=tree",
        ),
        // Focus view on an issue reads the tree too.
        (
            "/acme/web/issues/7?mode=focus&focus=acme/web/7&chain=blocking",
            "/api/tree?mode=focus&amp;focus=acme/web/7&amp;chain=blocking",
        ),
    ] {
        let page = html(url).await;
        let tag = format!(r#"<link rel="preload" href="{data}" as="fetch" crossorigin>"#);
        assert!(page.contains(&tag), "{url}: {tag} in {page}");
        assert!(page.contains(&tree), "{url}");
        assert!(!page.contains("/api/issues?"), "{url}");
    }
    // The list, a mode that only starts with `tree`, and Focus view on no issue get neither.
    for url in [
        "/issues",
        "/issues?q=is%3Aopen",
        "/issues?mode=treex",
        "/issues?mode=focus",
    ] {
        let page = html(url).await;
        assert!(!page.contains("/api/tree"), "{url}");
        assert!(!page.contains(&tree), "{url}");
    }
}

/// The PR view's path (`/:owner/:repo/pull/:number/view`, web/src/router.tsx) gets the shell,
/// with its own preloads: `/api/me`, the PR's detail and its analysis graph (as
/// web/src/analysis.ts fetches them), and the view's chunk with the chunk it imports; no list
/// page or facets, which the view doesn't show, and not the issue panel's chunk.
#[tokio::test(flavor = "multi_thread")]
async fn a_pr_view_url_preloads_the_pr_its_graph_and_the_views_chunks_and_no_list() {
    let s = start().await;
    let html = |url: &'static str| {
        let s = &s;
        async move {
            let res = s.get(&mut Browser::default(), url).await;
            assert_eq!(res.status(), 200, "{url}");
            assert_eq!(res.headers()["cache-control"], "private, max-age=300");
            res.text().await.unwrap()
        }
    };
    let preload =
        |href: &str| format!(r#"<link rel="preload" href="{href}" as="fetch" crossorigin>"#);
    let module = |chunk: &str| format!(r#"<link rel="modulepreload" crossorigin href="/{chunk}">"#);
    for url in [
        "/acme/web/pull/12/view",
        "/acme/web/pull/012/view?sel=part:api&lens=data",
    ] {
        let page = html(url).await;
        for tag in [
            preload("/api/me"),
            preload("/api/at/acme/web/12"),
            preload("/api/acme/web/pulls/12/analysis"),
            module(VIEW_CHUNK),
            module(SHARED_CHUNK),
        ] {
            assert!(page.contains(&tag), "{url}: {tag} in {page}");
        }
        assert!(page.contains(r#"<meta name="beghu-build""#), "{url}");
        for absent in [
            "/api/issues",
            "/api/facets",
            "/api/tree",
            PANEL_CHUNK,
            "assets/index-test.js",
        ] {
            assert!(!page.contains(absent), "{url}: {absent} in {page}");
        }
    }
    // A number that isn't one, or a name the app would escape: the view's code and `/api/me`,
    // and no read the app wouldn't make.
    for url in ["/acme/web/pull/x/view", "/acme/we%20b/pull/1/view"] {
        let page = html(url).await;
        assert!(page.contains(&module(VIEW_CHUNK)), "{url}");
        assert!(page.contains(&preload("/api/me")), "{url}");
        assert!(!page.contains("/api/at/"), "{url}: {page}");
        assert!(!page.contains("/analysis"), "{url}: {page}");
    }
}
