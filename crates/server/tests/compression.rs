//! beghu compresses what it sends, as the edge passes encodings through unchanged: the API and
//! the shell on the fly (br or gzip, whichever the browser accepts), and the built assets from
//! the `.br` and `.gz` files the web build writes next to them.

mod common;

use common::{Browser, start};
use std::io::Read as _;

/// GET `path` as `b`, accepting `encoding`: the response's `content-encoding`, `vary` and raw
/// body.
async fn fetch(
    s: &common::Stack,
    b: &Browser,
    path: &str,
    encoding: &str,
) -> (u16, Option<String>, String, Vec<u8>) {
    let mut req = s
        .http
        .get(format!("{}{path}", s.server))
        .header("accept-encoding", encoding);
    if !b.cookies.is_empty() {
        req = req.header("cookie", b.header());
    }
    let res = req.send().await.unwrap();
    let h = |name: &str| {
        res.headers()
            .get_all(name)
            .iter()
            .map(|v| v.to_str().unwrap().to_owned())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (status, enc, vary) = (
        res.status().as_u16(),
        res.headers()
            .get("content-encoding")
            .map(|v| v.to_str().unwrap().to_owned()),
        h("vary"),
    );
    (status, enc, vary, res.bytes().await.unwrap().to_vec())
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn unbrotli(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    brotli::Decompressor::new(bytes, 4096)
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn api_responses_are_compressed_with_the_encoding_the_browser_accepts() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (status, enc, _, plain) = fetch(&s, &b, "/api/issues", "identity").await;
    assert_eq!((status, enc), (200, None));
    let page: serde_json::Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 100);

    for (accept, want, decode) in [
        ("gzip", "gzip", gunzip as fn(&[u8]) -> Vec<u8>),
        ("gzip, deflate, br, zstd", "br", unbrotli),
    ] {
        let (status, enc, vary, body) = fetch(&s, &b, "/api/issues", accept).await;
        assert_eq!(status, 200);
        assert_eq!(enc.as_deref(), Some(want), "accepting {accept}");
        assert!(vary.contains("accept-encoding"), "vary: {vary}");
        assert!(
            body.len() * 4 < plain.len(),
            "{want}: {} bytes of {}",
            body.len(),
            plain.len()
        );
        assert_eq!(decode(&body), plain, "{want}");
    }

    let (status, enc, _, _) = fetch(&s, &b, "/api/me", "br").await;
    assert_eq!((status, enc.as_deref()), (200, Some("br")));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_is_compressed_too() {
    let s = start().await;
    let (status, enc, vary, body) = fetch(&s, &Browser::default(), "/", "gzip").await;
    assert_eq!((status, enc.as_deref()), (200, Some("gzip")));
    assert!(vary.contains("accept-encoding"), "vary: {vary}");
    let html = String::from_utf8(gunzip(&body)).unwrap();
    assert!(html.contains(r#"href="/api/me""#), "{html}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_built_asset_is_served_from_its_precompressed_sibling() {
    let mut s = start().await;
    let assets = s.web.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let js = "export const greeting = 'hello';\n".repeat(50);
    std::fs::write(assets.join("index-abc123.js"), &js).unwrap();
    // Not what compressing `js` gives: shows the file is served, not compressed on the fly.
    let mut br = Vec::new();
    brotli::CompressorReader::new(&b"// the build's own .br\n"[..], 4096, 11, 22)
        .read_to_end(&mut br)
        .unwrap();
    std::fs::write(assets.join("index-abc123.js.br"), &br).unwrap();
    // A start copies its build's assets to the volume, which serves them.
    s.restart_with(|_| {}).await;

    let b = Browser::default();
    let (status, enc, vary, body) = fetch(&s, &b, "/assets/index-abc123.js", "gzip, br").await;
    assert_eq!((status, enc.as_deref()), (200, Some("br")));
    assert_eq!(body, br);
    assert!(vary.contains("accept-encoding"), "vary: {vary}");

    // No `.gz` sibling: a gzip-only browser gets the file as it is.
    let (status, enc, _, body) = fetch(&s, &b, "/assets/index-abc123.js", "gzip").await;
    assert_eq!((status, enc), (200, None));
    assert_eq!(body, js.as_bytes());
}
