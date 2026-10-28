//! Images, attachments and video (#100): the attachment route and the image proxy, and the
//! probes that size images before the browser loads them. Posts are written on Fake GitHub (an
//! outside edit, or a comment posted through beghu), with attachments uploaded there and the
//! web's images served by its stand-in image host; the signed URLs come from the rendered posts,
//! as a browser gets them.

mod common;

use common::{Browser, Stack, start, start_with};
use serde_json::{Value, json};
use sha2::Digest as _;
use std::time::{Duration, Instant};

fn digest(md: &str) -> String {
    sha2::Sha256::digest(md.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The first open issue in `repo` on the list.
async fn issue_in(s: &Stack, b: &mut Browser, repo: &str) -> Value {
    let (status, page) = s
        .api(b, &format!("/api/issues?q=is%3Aopen+repo%3A{repo}"))
        .await;
    assert_eq!(status, 200, "{page}");
    page["rows"][0].clone()
}

/// The comment with `md` on issue `t`, once it's in the thread, and its page's `media` map.
async fn until_comment(s: &Stack, b: &mut Browser, t: &Value, md: &str) -> (Value, Value) {
    let d = digest(md);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let path = format!("/api/issues/{}/comments?order=newest", t["id"]);
        let (status, page) = s.api(b, &path).await;
        if status == 200
            && let Some(c) = page["comments"]
                .as_array()
                .and_then(|cs| cs.iter().find(|c| c["digest"] == d))
        {
            return (c.clone(), page["media"].clone());
        }
        assert!(
            Instant::now() < deadline,
            "the comment didn't arrive: {page}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Writes `md` as a comment on `t` on GitHub (an outside edit, with its webhook), and returns it
/// as the thread shows it, with its page's `media` map.
async fn comment(s: &Stack, b: &mut Browser, t: &Value, md: &str) -> (Value, Value) {
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
        .await;
    until_comment(s, b, t, md).await
}

/// Every `img` and `media` node's attributes in a post's AST, depth first.
fn media_nodes(ast: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    fn walk(v: &Value, out: &mut Vec<(String, Value)>) {
        let Some(a) = v.as_array() else { return };
        if let Some(tag @ ("img" | "media" | "source")) = a.first().and_then(Value::as_str) {
            out.push((tag.to_owned(), a[1].clone()));
        }
        a.iter().for_each(|k| walk(k, out));
    }
    walk(ast, &mut out);
    out
}

fn srcs(ast: &Value) -> Vec<String> {
    media_nodes(ast)
        .into_iter()
        .filter_map(|(_, a)| a["src"].as_str().map(str::to_owned))
        .collect()
}

/// Uploads a file to Fake GitHub, as the editor would: `{uuid, url, markdown}`.
async fn upload(s: &Stack, body: Value) -> Value {
    s.fake("POST", "/attachments", body).await
}

/// GETs a media URL (a `src` from a post) as `b`, with `headers`.
async fn get(s: &Stack, b: &Browser, src: &str, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut req = s
        .http
        .get(format!("{}{src}", s.server))
        .header("cookie", b.header());
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    req.send().await.unwrap()
}

/// A PNG's size, from its header.
fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "a PNG");
    let n = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
    (n(16), n(20))
}

fn header<'r>(res: &'r reqwest::Response, name: &str) -> &'r str {
    res.headers()
        .get(name)
        .map(|v| v.to_str().unwrap())
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_attachment_loads_for_its_viewer_and_is_404_to_anyone_who_cannot_read_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // `api`: a private repo the outside collaborator can't see.
    let t = issue_in(&s, &mut b, "api").await;
    let up = upload(&s, json!({ "kind": "image", "width": 64, "height": 48 })).await;
    let uuid = up["uuid"].as_str().unwrap();
    let (c, _) = comment(&s, &mut b, &t, up["markdown"].as_str().unwrap()).await;
    let nodes = media_nodes(&c["body"]);
    let (tag, img) = &nodes[0];
    assert_eq!(tag, "img");
    // The uploader's size goes out as written; the image loads through beghu.
    assert_eq!(img["src"], format!("/api/attachments/{uuid}"));
    assert_eq!(
        (&img["width"], &img["height"]),
        (&json!("64"), &json!("48"))
    );
    assert!(img.get("orig").is_none(), "{img}");

    let res = get(&s, &b, &format!("/api/attachments/{uuid}"), &[]).await;
    assert_eq!(res.status(), 200);
    assert_eq!(header(&res, "content-type"), "image/png");
    assert_eq!(
        header(&res, "cache-control"),
        "private, max-age=31536000, immutable"
    );
    assert_eq!(header(&res, "x-content-type-options"), "nosniff");
    assert_eq!(header(&res, "content-security-policy"), "sandbox");
    assert_eq!(png_size(&res.bytes().await.unwrap()), (64, 48));

    // A minted URL pasted back into a post (a quote-reply copies GitHub's rendered HTML) is dead
    // within 300 s: it's routed by its UUID instead, and loads while the mirror holds the
    // attachment in another post.
    let pasted = format!(
        "> ![Image](https://private-user-images.githubusercontent.com/1/2-{uuid}.png?jwt=eyJx.eyJ5.c2ln)"
    );
    let (q, _) = comment(&s, &mut b, &t, &pasted).await;
    assert_eq!(srcs(&q["body"]), [format!("/api/attachments/{uuid}")]);

    // The outside collaborator can't read the issue, so GitHub mints nothing for them.
    let mut ext = s.sign_in("octo-ext").await;
    let (status, _) = s.api(&mut ext, &format!("/api/issues/{}", t["id"])).await;
    assert_ne!(status, 200);
    let res = get(&s, &ext, &format!("/api/attachments/{uuid}"), &[]).await;
    assert_eq!(res.status(), 404);

    // Signed out: no session, no bytes.
    let res = s
        .http
        .get(format!("{}/api/attachments/{uuid}", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    // A UUID no post holds.
    let res = get(
        &s,
        &b,
        "/api/attachments/00000000-0000-4000-8000-000000000000",
        &[],
    )
    .await;
    assert_eq!(res.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_video_seeks_through_range_and_a_seek_after_the_minted_url_expires_mints_again() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let up = upload(&s, json!({ "kind": "video" })).await;
    let uuid = up["uuid"].as_str().unwrap();
    // The editor puts a video's bare URL on its own line: a media node, which minting found to
    // be a video.
    let md = format!("Here's the bug:\n\n{}\n", up["markdown"].as_str().unwrap());
    let (c, media) = comment(&s, &mut b, &t, &md).await;
    let src = format!("/api/attachments/{uuid}");
    assert_eq!(
        media_nodes(&c["body"]),
        [("media".to_owned(), json!({ "src": src, "href": up["url"] }))]
    );
    // Its frame size too, read from its first bytes, so its box is kept before it loads.
    assert_eq!(
        media[&src],
        json!({ "w": 320, "h": 180, "type": "video/webm" }),
        "{media}"
    );

    let whole = get(&s, &b, &src, &[]).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(header(&whole, "accept-ranges"), "bytes");
    let all = whole.bytes().await.unwrap();
    let len = all.len();

    let part = get(&s, &b, &src, &[("range", "bytes=100-199")]).await;
    assert_eq!(part.status(), 206);
    assert_eq!(
        header(&part, "content-range"),
        format!("bytes 100-199/{len}")
    );
    assert_eq!(header(&part, "content-type"), "video/webm");
    assert_eq!(part.bytes().await.unwrap(), all[100..200]);
    // Past the end: GitHub's 416, with the length.
    let past = get(&s, &b, &src, &[("range", &format!("bytes={}-", len + 10))]).await;
    assert_eq!(past.status(), 416);
    assert_eq!(header(&past, "content-range"), format!("bytes */{len}"));

    // GitHub's minted URL lives 300 s: past that it's a 404, and the next seek mints a fresh one.
    s.fake("PUT", "/clock", json!({ "offset": 301 })).await;
    let later = get(&s, &b, &src, &[("range", "bytes=1000-")]).await;
    assert_eq!(later.status(), 206);
    assert_eq!(
        header(&later, "content-range"),
        format!("bytes 1000-{}/{len}", len - 1)
    );
    assert_eq!(later.bytes().await.unwrap(), all[1000..]);
}

/// A comment on `t` showing each of `urls` as an image, and each image's `src`, in order.
async fn images(s: &Stack, b: &mut Browser, t: &Value, urls: &[String]) -> Vec<String> {
    let md: String = urls.iter().map(|u| format!("![x]({u})\n")).collect();
    let (c, _) = comment(s, b, t, &md).await;
    let srcs = srcs(&c["body"]);
    assert_eq!(srcs.len(), urls.len(), "{}", c["body"]);
    srcs
}

#[tokio::test(flavor = "multi_thread")]
async fn the_image_proxy_refuses_unsafe_targets_on_every_hop_bad_signatures_and_missing_sessions() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let ctl = s.fake_ctl.trim_start_matches("http://").to_owned();
    let ctl_port = ctl.rsplit_once(':').unwrap().1;
    let fake = &s.fake_api;
    let refused = [
        // Loopback: Fake GitHub's control port, which the dev allowance doesn't cover.
        format!("http://{ctl}/state"),
        format!("http://0.0.0.0:{ctl_port}/state"),
        // A name that resolves to loopback.
        "http://localhost/x.png".to_owned(),
        // Private, link-local (the cloud metadata address), CGNAT.
        "http://10.0.0.1/x.png".to_owned(),
        "http://192.168.1.1/x.png".to_owned(),
        "http://169.254.169.254/latest/meta-data".to_owned(),
        "http://100.64.0.1/x.png".to_owned(),
        "http://100.127.255.254/x.png".to_owned(),
        // IPv6 loopback, link-local, unique local, and IPv4 inside IPv6.
        "http://[::1]/x.png".to_owned(),
        "http://[fe80::1]/x.png".to_owned(),
        "http://[fd00::1]/x.png".to_owned(),
        "http://[::ffff:a00:1]/x.png".to_owned(),
        "http://[64:ff9b::a00:1]/x.png".to_owned(),
        "http://[64:ff9b:1::a00:1]/x.png".to_owned(),
        "http://[::ffff:0:7f00:1]/x.png".to_owned(),
        // Benchmarking and ORCHID in IPv6, the old 6to4 relay in IPv4.
        "http://[2001:2::1]/x.png".to_owned(),
        "http://[2001:10::1]/x.png".to_owned(),
        "http://192.88.99.1/x.png".to_owned(),
        // Loopback written as a number, and in hex.
        "http://2130706433/x.png".to_owned(),
        "http://0x7f.1/x.png".to_owned(),
        // A port other than 80 or 443.
        "http://example.com:8080/x.png".to_owned(),
        // A redirect from an allowed host to a refused one: checked on the hop.
        format!("{fake}/ext/redirect?to=http://{ctl}/state"),
        // A redirect to a name that resolves to loopback.
        format!("{fake}/ext/redirect?to=http://localhost/x.png"),
    ];
    let mut urls: Vec<String> = refused.to_vec();
    urls.push(format!("{fake}/ext/img/10x10.png"));
    urls.push(format!("{fake}/ext/page.html"));
    let srcs = images(&s, &mut b, &t, &urls).await;
    for (url, src) in refused.iter().zip(&srcs) {
        assert!(src.starts_with("/api/img?"), "{src}");
        let res = get(&s, &b, src, &[]).await;
        assert_eq!(res.status(), 403, "{url}");
        assert_eq!(res.text().await.unwrap(), "blocked", "{url}");
    }
    let good = &srcs[refused.len()];
    let res = get(&s, &b, good, &[]).await;
    assert_eq!(res.status(), 200);
    assert_eq!(header(&res, "content-type"), "image/png");
    assert_eq!(header(&res, "x-content-type-options"), "nosniff");
    assert_eq!(header(&res, "content-security-policy"), "sandbox");
    // The host says 10 minutes: at least an hour.
    assert_eq!(header(&res, "cache-control"), "private, max-age=3600");
    let etag = header(&res, "etag").to_owned();
    assert_eq!(png_size(&res.bytes().await.unwrap()), (10, 10));
    // A revalidation passes through: 304.
    let res = get(&s, &b, good, &[("if-none-match", &etag)]).await;
    assert_eq!(res.status(), 304);
    // Not an image.
    let res = get(&s, &b, &srcs[refused.len() + 1], &[]).await;
    assert_eq!(res.status(), 415);

    // The signature covers the URL: another URL, or another signature, is refused.
    let (path, sig) = good.split_once("&sig=").unwrap();
    let other = format!("{path}&sig={}", "A".repeat(sig.len()));
    assert_eq!(get(&s, &b, &other, &[]).await.status(), 403);
    let moved = good.replace("10x10", "11x11");
    assert_eq!(get(&s, &b, &moved, &[]).await.status(), 403);
    let unsigned = path.to_owned();
    assert_eq!(get(&s, &b, &unsigned, &[]).await.status(), 400);
    // No session.
    let res = s
        .http
        .get(format!("{}{good}", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_image_proxy_cuts_at_the_size_cap_and_gives_up_past_its_waits() {
    let s = start_with(|cfg| {
        cfg.media.image_max = 100_000;
        cfg.media.image_total = Duration::from_secs(1);
        cfg.media.first_byte = Duration::from_millis(500);
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    let urls = [
        format!("{fake}/ext/big.png"),
        format!("{fake}/ext/big.png?chunked=1"),
        format!("{fake}/ext/drip.png?ms=200"),
        format!("{fake}/ext/img/12x12.png"),
    ];
    // Sized, so no probe fetches them: only the requests below do.
    let md: String = urls
        .iter()
        .map(|u| format!("<img width=\"5\" height=\"5\" src=\"{u}\">\n"))
        .collect();
    let (c, _) = comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);

    // `Content-Length` over the cap: refused before a byte.
    assert_eq!(get(&s, &b, &srcs[0], &[]).await.status(), 413);
    // No length given: cut at the cap, the response ending short.
    let res = get(&s, &b, &srcs[1], &[]).await;
    assert_eq!(res.status(), 200);
    let mut got = 0;
    let mut body = res.bytes_stream();
    let mut failed = false;
    use futures_util::StreamExt as _;
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(c) => got += c.len(),
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(failed, "the response ended as if whole");
    assert!(got <= 100_000, "{got} bytes past the cap");
    // A body that dribbles past the total time is cut too.
    let started = Instant::now();
    let res = get(&s, &b, &srcs[2], &[]).await;
    assert_eq!(res.status(), 200);
    assert!(
        res.bytes().await.is_err(),
        "the slow body ended as if whole"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    // An image host that doesn't answer in time.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "GET /ext/img/*", "ms": 3000 }),
    )
    .await;
    assert_eq!(get(&s, &b, &srcs[3], &[]).await.status(), 504);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seventh_fetch_in_a_session_waits_for_a_turn_rather_than_failing_across_both_routes() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    // Sized, so no probe fetches them: four images from the web and three attachments.
    let mut md: String = (1..=4)
        .map(|i| format!("<img width=\"5\" height=\"5\" src=\"{fake}/ext/img/{i}x{i}.png\">\n"))
        .collect();
    for i in 1..=3 {
        let up = upload(&s, json!({ "kind": "image", "width": i, "height": i })).await;
        md.push_str(&format!("{}\n", up["markdown"].as_str().unwrap()));
    }
    let (c, _) = comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);
    assert_eq!(srcs.len(), 7);
    for endpoint in ["GET /ext/img/*", "GET /private-user-images/*"] {
        s.fake(
            "POST",
            "/faults/latency",
            json!({ "endpoint": endpoint, "ms": 600 }),
        )
        .await;
    }
    let started = Instant::now();
    let all = futures_util::future::join_all(srcs.iter().map(|src| get(&s, &b, src, &[]))).await;
    let elapsed = started.elapsed();
    for res in all {
        assert_eq!(res.status(), 200);
    }
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(state["media"]["peak"], 6, "{}", state["media"]);
    // The seventh waited for one of the first six to finish.
    assert!(elapsed >= Duration::from_millis(1200), "{elapsed:?}");
}

/// The `ids` pushes on `stream` for the next `wait`, as each push's ids.
async fn pushes_for(stream: &mut common::Stream, wait: Duration) -> Vec<Vec<i64>> {
    stream
        .events_for(wait)
        .await
        .iter()
        .filter(|e| e.event == "ids")
        .map(common::ids_of)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_webhooks_push_waits_for_its_images_sizes_and_late_ones_push_again() {
    let s = start_with(|cfg| {
        // Long enough for the slow image host below, on a busy machine.
        cfg.media.webhook_wait = Duration::from_secs(3);
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let id = t["id"].as_i64().unwrap();
    let fake = &s.fake_api;
    // Slower than a detail waits (100 ms): only the webhook's wait can have sized it.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "GET /ext/img/*", "ms": 600 }),
    )
    .await;
    let mut stream = s.stream(&b).await;
    stream.reset().await;
    let md = format!("![shot]({fake}/ext/img/123x45.png)");
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
        .await;
    let first = stream.event_within(Duration::from_secs(10)).await.unwrap();
    assert_eq!(common::ids_of(&first), [id]);
    let (c, media) = until_comment(&s, &mut b, &t, &md).await;
    let src = &srcs(&c["body"])[0];
    assert_eq!(
        media[src],
        json!({ "w": 123, "h": 45, "type": "image/png" }),
        "{media}"
    );
    // Sized before the push: no second one.
    assert!(
        pushes_for(&mut stream, Duration::from_secs(2))
            .await
            .is_empty(),
        "a push after the sizes landed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_detail_waits_briefly_for_sizes_and_ones_that_land_later_push_the_issue_again() {
    let s = start_with(|cfg| {
        cfg.media.webhook_wait = Duration::from_millis(100);
        cfg.media.detail_wait = Duration::from_millis(100);
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let id = t["id"].as_i64().unwrap();
    let fake = &s.fake_api;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "GET /ext/img/*", "ms": 1500 }),
    )
    .await;
    let mut stream = s.stream(&b).await;
    stream.reset().await;
    let md = format!(
        "![a]({fake}/ext/img/80x60.png) and <img width=\"300\" src=\"{fake}/ext/img/90x30.png\">"
    );
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
        .await;
    // The webhook's push goes once its wait is up, the sizes not in yet.
    let first = stream.event_within(Duration::from_secs(10)).await.unwrap();
    assert_eq!(common::ids_of(&first), [id]);
    let (c, media) = until_comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);
    assert!(media.as_object().is_none_or(|m| m.is_empty()), "{media}");
    // When they land, the issue is pushed once more, and the thread has them.
    let later = pushes_for(&mut stream, Duration::from_secs(6)).await;
    assert_eq!(later, [vec![id]]);
    let (_, media) = until_comment(&s, &mut b, &t, &md).await;
    assert_eq!(
        media[&srcs[0]],
        json!({ "w": 80, "h": 60, "type": "image/png" })
    );
    // Only a width written: its height follows from the image's own proportions.
    assert_eq!(
        media[&srcs[1]],
        json!({ "w": 90, "h": 30, "type": "image/png" })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_known_not_to_load_says_why_before_the_browser_asks() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    let urls = [
        format!("{fake}/ext/big.png"),
        format!("{fake}/ext/page.html"),
        "http://10.0.0.1/x.png".to_owned(),
    ];
    let srcs = images(&s, &mut b, &t, &urls).await;
    // The webhook measured them before its push; the detail says why each won't load.
    let deadline = Instant::now() + Duration::from_secs(10);
    let media = loop {
        let path = format!("/api/issues/{}/comments?order=newest", t["id"]);
        let (_, page) = s.api(&mut b, &path).await;
        if srcs.iter().all(|src| page["media"].get(src).is_some()) {
            break page["media"].clone();
        }
        assert!(Instant::now() < deadline, "{page}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(media[&srcs[0]]["unavailable"], "too_large", "{media}");
    assert_eq!(media[&srcs[1]]["unavailable"], "not_image", "{media}");
    assert_eq!(media[&srcs[2]]["unavailable"], "blocked", "{media}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_posted_through_beghu_is_sized_when_its_detail_opens() {
    let s = start_with(|cfg| {
        cfg.media.detail_wait = Duration::from_secs(3);
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    let up = upload(&s, json!({ "kind": "image", "width": 30, "height": 20 })).await;
    let uuid = up["uuid"].as_str().unwrap();
    // A bare attachment and an external image, neither sized in the post.
    let md = format!(
        "{}\n\n![b]({fake}/ext/img/41x17.png)\n",
        up["url"].as_str().unwrap()
    );
    let res = s
        .api_write(&b, reqwest::Method::POST, "/api/ops")
        .json(&json!({
            "op_id": "6f1c1b7e-8a51-4c43-9c1e-5b1c1d0e2f3a",
            "op": { "kind": "comment", "issue": t["id"], "body": md },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    // Its own write lands it in the mirror; GitHub's webhook then changes nothing. The detail
    // measures what it shows.
    let (c, media) = until_comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);
    assert_eq!(srcs[0], format!("/api/attachments/{uuid}"));
    assert_eq!(
        media[&srcs[0]],
        json!({ "w": 30, "h": 20, "type": "image/png" })
    );
    assert_eq!(
        media[&srcs[1]],
        json!({ "w": 41, "h": 17, "type": "image/png" })
    );
}

/// How many minted and `/ext` media requests Fake GitHub has answered.
async fn media_served(s: &Stack) -> u64 {
    let state = s.fake("GET", "/state", Value::Null).await;
    state["media"]["served"].as_u64().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_import_measures_the_attachments_in_bodies_and_comments_a_hundred_posts_a_mint() {
    let s = common::start_fresh().await;
    // Open issues in `web` with low ids: one page of bodies, one chunk of threads.
    let targets: Vec<Value> = common::summary()["unlinked"].as_array().unwrap()[..6].to_vec();
    // No webhooks: only the import brings these posts in.
    s.fake("PUT", "/webhooks", json!({ "url": null })).await;
    // Bare attachments (no size given, so each is probed): in three bodies, and in 101 comments
    // across three threads, more than one mint call takes.
    let mut posts = 0;
    for t in &targets[..3] {
        let up = upload(&s, json!({ "kind": "image", "width": 21, "height": 13 })).await;
        let body = format!("Before:\n\n{}\n", up["url"].as_str().unwrap());
        s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": body }))
            .await;
        posts += 1;
    }
    for i in 0..101 {
        let t = &targets[3 + i % 3];
        let up = upload(&s, json!({ "kind": "image", "width": 8, "height": 5 })).await;
        let md = format!("{}\n", up["url"].as_str().unwrap());
        s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
            .await;
        posts += 1;
    }
    let mut b = s.sign_in("tomsj").await;
    let (status, picker) = s.api(&mut b, "/api/repos").await;
    assert_eq!(status, 200, "{picker}");
    let web = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "web")
        .unwrap()["id"]
        .clone();
    let res = s
        .api_write(&b, reqwest::Method::PUT, "/api/repos")
        .json(&json!({ "repos": [web] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // Nothing opens a detail: only the import's probes fetch the attachments, each once.
    let deadline = Instant::now() + Duration::from_secs(120);
    while media_served(&s).await < posts {
        assert!(
            Instant::now() < deadline,
            "the import probed {} of {posts} attachments",
            media_served(&s).await
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let state = s.fake("GET", "/state", Value::Null).await;
    // The bodies' page mints once; the 101 comments take two calls of at most 100 posts.
    assert!(
        state["graphql"]["operations"]["MintAttachments"].as_u64() >= Some(3),
        "{}",
        state["graphql"]
    );
    // What they found is in the mirror: a detail shows it without measuring anything.
    let (status, d) = s
        .api(&mut b, &format!("/api/issues/{}", targets[0]["id"]))
        .await;
    assert_eq!(status, 200, "{d}");
    let src = srcs(&d["body"])[0].clone();
    assert_eq!(
        d["media"][&src],
        json!({ "w": 21, "h": 13, "type": "image/png" }),
        "{d}"
    );
    assert_eq!(media_served(&s).await, posts);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_import_measures_the_attachments_in_closed_threads_with_the_installations_mints() {
    let s = common::start_fresh().await;
    // Closed issues: their threads come in through the import's REST pass over the repo's
    // comments, not phase 3's GraphQL threads.
    let targets: Vec<Value> = common::summary()["unlinked_closed"]
        .as_array()
        .unwrap()
        .to_vec();
    s.fake("PUT", "/webhooks", json!({ "url": null })).await;
    let mut posts = 0;
    for i in 0..4 {
        let t = &targets[i % targets.len()];
        let up = upload(&s, json!({ "kind": "image", "width": 9 + i, "height": 4 })).await;
        let md = format!("{}\n", up["url"].as_str().unwrap());
        s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
            .await;
        posts += 1;
    }
    let mut b = s.sign_in("tomsj").await;
    let (status, picker) = s.api(&mut b, "/api/repos").await;
    assert_eq!(status, 200, "{picker}");
    let web = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "web")
        .unwrap()["id"]
        .clone();
    let before = s.fake("GET", "/state", Value::Null).await;
    let res = s
        .api_write(&b, reqwest::Method::PUT, "/api/repos")
        .json(&json!({ "repos": [web] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    // Nothing opens a detail: only the import's probes fetch the attachments.
    let deadline = Instant::now() + Duration::from_secs(120);
    while media_served(&s).await < posts {
        assert!(
            Instant::now() < deadline,
            "the import probed {} of {posts} closed threads' attachments",
            media_served(&s).await
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let after = s.fake("GET", "/state", Value::Null).await;
    let mints = |st: &Value| {
        st["graphql"]["operations"]["MintAttachments"]
            .as_u64()
            .unwrap_or(0)
    };
    // Minted in a batch, with the installation's token: no viewer's GraphQL call made them.
    assert!(mints(&after) > mints(&before), "{}", after["graphql"]);
    assert!(
        mints(&after) - mints(&before) < posts,
        "{}",
        after["graphql"]
    );
    assert_eq!(
        after["graphql"]["user"], before["graphql"]["user"],
        "{}",
        after["graphql"]
    );
    // A detail shows what they found without measuring anything.
    let path = format!("/api/issues/{}/comments?order=newest", targets[0]["id"]);
    let (status, page) = s.api(&mut b, &path).await;
    assert_eq!(status, 200, "{page}");
    let src = srcs(&page["comments"][0]["body"])[0].clone();
    assert_eq!(page["media"][&src]["type"], "image/png", "{page}");
    assert_eq!(media_served(&s).await, posts);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transferred_issues_body_and_thread_are_measured_as_the_transfer_lands() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = common::summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["repo"] == "web")
        .unwrap()
        .clone();
    // Written with their deliveries lost: only the transfer brings these posts in.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    let body = upload(&s, json!({ "kind": "image", "width": 17, "height": 6 })).await;
    let reply = upload(&s, json!({ "kind": "image", "width": 6, "height": 17 })).await;
    let md = |up: &Value| format!("{}\n", up["url"].as_str().unwrap());
    s.edit(json!({ "repo": "web", "number": t["number"], "body": md(&body) }))
        .await;
    s.edit(json!({ "repo": "web", "number": t["number"], "comment": md(&reply) }))
        .await;
    let served = media_served(&s).await;
    let moved = s
        .fake(
            "POST",
            "/transfer",
            json!({ "repo": "web", "number": t["number"], "to": "docs" }),
        )
        .await;
    let new = moved["issue"]["id"].as_i64().unwrap();
    // Nothing opens a detail: the transfer's own deliveries and its thread's read-back measure
    // the body and the comment.
    let deadline = Instant::now() + Duration::from_secs(30);
    while media_served(&s).await < served + 2 {
        assert!(
            Instant::now() < deadline,
            "the transfer measured {} of 2 attachments",
            media_served(&s).await - served
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (status, d) = s.api(&mut b, &format!("/api/issues/{new}")).await;
    assert_eq!(status, 200, "{d}");
    let src = srcs(&d["body"])[0].clone();
    assert_eq!(
        d["media"][&src],
        json!({ "w": 17, "h": 6, "type": "image/png" }),
        "{d}"
    );
    let path = format!("/api/issues/{new}/comments?order=newest");
    let (status, page) = s.api(&mut b, &path).await;
    assert_eq!(status, 200, "{page}");
    let src = srcs(&page["comments"][0]["body"])[0].clone();
    assert_eq!(
        page["media"][&src],
        json!({ "w": 6, "h": 17, "type": "image/png" }),
        "{page}"
    );
    assert_eq!(media_served(&s).await, served + 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prs_body_is_measured_as_its_read_back_lands() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (status, page) = s
        .api(&mut b, "/api/issues?q=is%3Apr+is%3Aopen+repo%3Aacme%2Fweb")
        .await;
    assert_eq!(status, 200, "{page}");
    let pr = page["rows"][0].clone();
    let up = upload(&s, json!({ "kind": "image", "width": 23, "height": 5 })).await;
    let served = media_served(&s).await;
    // GitHub's `pull_request` delivery: beghu reads the PR back, body and all.
    let body = format!("Screenshot:\n\n{}\n", up["url"].as_str().unwrap());
    s.edit(json!({ "repo": "web", "number": pr["number"], "body": body }))
        .await;
    let deadline = Instant::now() + Duration::from_secs(30);
    while media_served(&s).await < served + 1 {
        assert!(Instant::now() < deadline, "the PR's body wasn't measured");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (status, d) = s.api(&mut b, &format!("/api/issues/{}", pr["id"])).await;
    assert_eq!(status, 200, "{d}");
    let src = srcs(&d["body"])[0].clone();
    assert_eq!(
        d["media"][&src],
        json!({ "w": 23, "h": 5, "type": "image/png" }),
        "{d}"
    );
    assert_eq!(media_served(&s).await, served + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_posts_with_slow_images_is_not_pushed_one_wait_after_another() {
    // The default wait (300 ms) for each post's images.
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (status, page) = s.api(&mut b, "/api/issues?q=is%3Aopen+repo%3Aweb").await;
    assert_eq!(status, 200, "{page}");
    let issues: Vec<Value> = page["rows"].as_array().unwrap()[..8].to_vec();
    let fake = &s.fake_api;
    // Slower than the wait: each post's push waits all of it.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "GET /ext/img/*", "ms": 2000 }),
    )
    .await;
    let mut stream = s.stream(&b).await;
    stream.reset().await;
    for (i, t) in issues.iter().enumerate() {
        let md = format!("![x]({fake}/ext/img/{}x7.png)", 30 + i);
        s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
            .await;
    }
    // When each issue's first push came.
    let mut first: std::collections::HashMap<i64, Instant> = Default::default();
    let deadline = Instant::now() + Duration::from_secs(15);
    while first.len() < issues.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        let Some(ev) = stream.event_within(left).await else {
            panic!("pushes for {} of {} issues", first.len(), issues.len());
        };
        if ev.event == "ids" {
            for id in common::ids_of(&ev) {
                first.entry(id).or_insert_with(Instant::now);
            }
        }
    }
    let (earliest, latest) = (first.values().min().unwrap(), first.values().max().unwrap());
    // One account's deliveries apply in order: had each waited on the last one's images, the
    // eighth push would come seven waits (2.1 s) after the first.
    let spread = latest.duration_since(*earliest);
    assert!(spread < Duration::from_millis(1200), "{spread:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_default_webhook_wait_is_enough_for_a_prompt_image_host() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    let mut stream = s.stream(&b).await;
    stream.reset().await;
    let md = format!("![shot]({fake}/ext/img/77x33.png)");
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
        .await;
    let first = stream.event_within(Duration::from_secs(10)).await.unwrap();
    assert_eq!(common::ids_of(&first), [t["id"].as_i64().unwrap()]);
    let (c, media) = until_comment(&s, &mut b, &t, &md).await;
    let src = &srcs(&c["body"])[0];
    assert_eq!(
        media[src],
        json!({ "w": 77, "h": 33, "type": "image/png" }),
        "{media}"
    );
    // Rendering, reading and measuring fit in the 300 ms: no second push.
    assert!(
        pushes_for(&mut stream, Duration::from_secs(2))
            .await
            .is_empty(),
        "a push after the sizes landed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn paused_videos_hold_no_turns_that_the_sessions_images_wait_for() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    // Long enough that its stream can't sit whole in the sockets' buffers.
    let up = upload(&s, json!({ "kind": "video", "size": 48 << 20 })).await;
    let uuid = up["uuid"].as_str().unwrap();
    let md = format!(
        "{}\n\n<img width=\"5\" height=\"5\" src=\"{fake}/ext/img/9x9.png\">\n",
        up["url"].as_str().unwrap()
    );
    let (c, _) = comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);
    // As many videos as the session has turns, each paused after its first bytes: the browser
    // stops reading, and the stream stays open.
    let mut paused = Vec::new();
    for _ in 0..6 {
        let res = get(&s, &b, &format!("/api/attachments/{uuid}"), &[]).await;
        assert_eq!(res.status(), 200);
        paused.push(res);
    }
    let res = tokio::time::timeout(Duration::from_secs(5), get(&s, &b, &srcs[1], &[]))
        .await
        .expect("the image waited behind the paused videos");
    assert_eq!(res.status(), 200);
    assert_eq!(png_size(&res.bytes().await.unwrap()), (9, 9));
    drop(paused);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attachment_images_body_holds_its_turn_until_it_is_read() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let fake = &s.fake_api;
    // Sized, so no probe fetches it, and long enough that its stream can't sit whole in the
    // sockets' buffers.
    let up = upload(
        &s,
        json!({ "kind": "image", "width": 4, "height": 4, "size": 48 << 20 }),
    )
    .await;
    let uuid = up["uuid"].as_str().unwrap();
    let md = format!(
        "{}\n\n<img width=\"5\" height=\"5\" src=\"{fake}/ext/img/9x9.png\">\n",
        up["markdown"].as_str().unwrap()
    );
    let (c, _) = comment(&s, &mut b, &t, &md).await;
    let srcs = srcs(&c["body"]);
    // As many images as the session has turns, each stalled in its body: the browser has its
    // headers, and reads no further.
    let mut stalled = Vec::new();
    for _ in 0..6 {
        let res = get(&s, &b, &format!("/api/attachments/{uuid}"), &[]).await;
        assert_eq!(res.status(), 200);
        assert_eq!(header(&res, "content-type"), "image/png");
        stalled.push(res);
    }
    let seventh = tokio::spawn({
        let (server, http, cookie, src) = (
            s.server.clone(),
            s.http.clone(),
            b.header(),
            srcs[1].clone(),
        );
        async move {
            http.get(format!("{server}{src}"))
                .header("cookie", cookie)
                .send()
                .await
                .unwrap()
                .status()
        }
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        !seventh.is_finished(),
        "a seventh fetch ran beside six bodies still streaming"
    );
    drop(stalled);
    let status = tokio::time::timeout(Duration::from_secs(5), seventh)
        .await
        .expect("the seventh fetch took a turn once the bodies ended")
        .unwrap();
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attachment_mints_from_another_post_when_github_fails_on_the_first_that_holds_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let t = issue_in(&s, &mut b, "web").await;
    let up = upload(&s, json!({ "kind": "image", "width": 12, "height": 7 })).await;
    let uuid = up["uuid"].as_str().unwrap();
    let md = up["markdown"].as_str().unwrap();
    comment(&s, &mut b, &t, md).await;
    comment(&s, &mut b, &t, &format!("Again:\n\n{md}")).await;
    // GitHub fails on both: a 502 that names no upstream URL.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/issues/comments/*", "count": 2, "status": 502 }),
    )
    .await;
    let res = get(&s, &b, &format!("/api/attachments/{uuid}"), &[]).await;
    assert_eq!(res.status(), 502);
    assert_eq!(res.text().await.unwrap(), "upstream failed");
    // GitHub fails on the first post the route asks it for; the other one mints.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/issues/comments/*", "count": 1, "status": 502 }),
    )
    .await;
    let res = get(&s, &b, &format!("/api/attachments/{uuid}"), &[]).await;
    assert_eq!(res.status(), 200);
    assert_eq!(png_size(&res.bytes().await.unwrap()), (12, 7));
}

#[tokio::test(flavor = "multi_thread")]
async fn one_accounts_failed_mint_does_not_keep_another_account_from_measuring() {
    let s = start().await;
    let mut a = s.sign_in("tomsj").await;
    let mut other = s.sign_in("ilze-k").await;
    let t = issue_in(&s, &mut a, "web").await;
    let up = upload(&s, json!({ "kind": "image", "width": 19, "height": 11 })).await;
    let md = format!("{}\n", up["url"].as_str().unwrap());
    // The webhook reaches the other account's mirror only after tomsj's detail has tried.
    s.fake("POST", "/faults/webhooks", json!({ "delay_ms": 3000 }))
        .await;
    let res = s
        .api_write(&a, reqwest::Method::POST, "/api/ops")
        .json(&json!({
            "op_id": "0b5b8f3e-2a51-4c43-9c1e-5b1c1d0e2f3a",
            "op": { "kind": "comment", "issue": t["id"], "body": md },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    // GitHub fails tomsj's mint: his detail measures nothing.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/issues/comments/*", "count": 1, "status": 502 }),
    )
    .await;
    let (c, media) = until_comment(&s, &mut a, &t, &md).await;
    let src = srcs(&c["body"])[0].clone();
    assert!(media.get(&src).is_none(), "{media}");
    // The other account's webhook mints with the installation's token, and measures it.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (_, media) = until_comment(&s, &mut other, &t, &md).await;
        if media.get(&src).is_some() {
            assert_eq!(
                media[&src],
                json!({ "w": 19, "h": 11, "type": "image/png" })
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "never measured for the other account"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
