//! A stand-in for the web's image hosts, which are not GitHub: the arbitrary sites a post's
//! `![](https://…)` names, for beghu's image proxy and probes to fetch from. Nothing here models
//! GitHub, so it sits apart from the fake's GitHub surface (an allowed exception in AGENTS.md):
//! its own router under `/ext`, on the fake's API port only because a second origin would add a
//! port to every stack for no test that needs one. beghu reaches it only through
//! `BEGHU_DEV_IMAGE_HOSTS`, which startup refuses unless GitHub is a Fake GitHub on this machine.
//!
//! **The web's images** (`/ext/…`), for the image proxy and the probes: `img/<w>x<h>.png` (a PNG
//! of that size, with an `ETag`, `Last-Modified` and `Cache-Control: max-age=600`, answering 304
//! to a matching `If-None-Match`), `big.png` (11 MB of PNG, with `Content-Length`, or chunked
//! without one with `?chunked=1`), `page.html` (an HTML page), `redirect?to=<url>` (a 302),
//! `drip.png?ms=<n>` (a PNG sent a byte every `n` ms). Latency faults apply to these paths like
//! any other.

use crate::Fake;
use crate::attachments::png;
use axum::Router;
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use std::time::Duration;

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/ext/img/{file}", get(ext_png))
        .route("/ext/big.png", get(ext_big))
        .route("/ext/page.html", get(ext_page))
        .route("/ext/redirect", get(ext_redirect))
        .route("/ext/drip.png", get(ext_drip))
}

/// `/ext/img/<w>x<h>.png`.
async fn ext_png(Path(file): Path<String>, headers: HeaderMap) -> Response {
    let size = file
        .strip_suffix(".png")
        .and_then(|s| s.split_once('x'))
        .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
        .filter(|(w, h)| (1..=4096).contains(w) && (1..=4096).contains(h));
    let Some((w, h)) = size else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    let etag = format!("\"{w}x{h}\"");
    let mut hs = HeaderMap::new();
    hs.insert(header::ETAG, HeaderValue::from_str(&etag).expect("ascii"));
    hs.insert(
        header::LAST_MODIFIED,
        HeaderValue::from_static("Mon, 26 Oct 2026 10:00:00 GMT"),
    );
    hs.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("max-age=600"),
    );
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == etag.as_bytes())
    {
        return (StatusCode::NOT_MODIFIED, hs).into_response();
    }
    hs.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    (StatusCode::OK, hs, png(w, h, [0x3a, 0xa6, 0x6b])).into_response()
}

#[derive(Deserialize)]
struct Big {
    chunked: Option<u8>,
}

/// `/ext/big.png`: 11 MB.
async fn ext_big(Query(b): Query<Big>) -> Response {
    const SIZE: usize = 11 << 20;
    let head = png(1, 1, [0, 0, 0]);
    let chunks = (0..SIZE / 65_536).map(move |i| {
        Ok::<_, std::io::Error>(if i == 0 {
            axum::body::Bytes::from(head.clone())
        } else {
            axum::body::Bytes::from(vec![0u8; 65_536])
        })
    });
    let body = axum::body::Body::from_stream(futures_util::stream::iter(chunks));
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    if b.chunked.is_none() {
        // What the chunks add up to: the 1 × 1 PNG, then zeros.
        let len = png(1, 1, [0, 0, 0]).len() + (SIZE / 65_536 - 1) * 65_536;
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    }
    (StatusCode::OK, h, body).into_response()
}

async fn ext_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><title>Not an image</title><p>Hello",
    )
        .into_response()
}

#[derive(Deserialize)]
struct To {
    to: String,
}

async fn ext_redirect(Query(t): Query<To>) -> Response {
    match HeaderValue::from_str(&t.to) {
        Ok(v) => (StatusCode::FOUND, [(header::LOCATION, v)]).into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "bad to").into_response(),
    }
}

#[derive(Deserialize)]
struct Drip {
    ms: Option<u64>,
}

/// `/ext/drip.png?ms=<n>`: a 1 × 1 PNG, a byte every `n` ms.
async fn ext_drip(Query(d): Query<Drip>) -> Response {
    let every = Duration::from_millis(d.ms.unwrap_or(500));
    let bytes = png(1, 1, [0, 0, 0]);
    let body = futures_util::stream::unfold(0usize, move |i| {
        let bytes = bytes.clone();
        async move {
            if i >= bytes.len() {
                return None;
            }
            tokio::time::sleep(every).await;
            Some((
                Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(&bytes[i..=i])),
                i + 1,
            ))
        }
    });
    (
        [(header::CONTENT_TYPE, "image/png")],
        axum::body::Body::from_stream(body),
    )
        .into_response()
}
