//! The two media routes. Both need a session, take a turn of the session's upstream fetches, and
//! stream the bytes through with `nosniff` and `Content-Security-Policy: sandbox`, so whatever
//! comes back can't run as a page on beghu's origin.
//!
//! - `GET /api/attachments/:uuid`: mints the attachment's URL for the viewer (a 404 from GitHub
//!   is a 404 here), and passes `Range` through, so a video seeks (206). Its turn lasts until
//!   GitHub's headers are in, not the whole stream: a paused video keeps its stream open. A held
//!   URL GitHub refuses has expired: it's minted again, once; a range past the end is GitHub's
//!   416, with its `Content-Range`. Only GitHub's minted host is fetched, and no redirect is
//!   followed. `private, max-age=86400`: the bytes behind a UUID never change, but a viewer who
//!   loses access to the post should stop seeing them within a day.
//! - `GET /api/img?u=&sig=`: `u` must carry beghu's signature, which only a rendered post hands
//!   out. Fetched through the guard (`guard.rs`), image types only, conditional requests passed
//!   through, and `max-age` clamped to between an hour and a year (a day when the image's host
//!   says nothing).

use super::fetch::Failure;
use super::mint::{self, MintError};
use super::probe::{is_attachment_type, is_image_type};
use crate::App;
use crate::auth::Session;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use serde::Deserialize;
use tokio::time::Instant;

/// A media route's failure: each kind its own status. The browser shows the post's placeholder
/// whichever it is; the body says why in a word or two, for whoever looks, never with an
/// upstream URL.
#[derive(Debug)]
pub enum MediaError {
    /// 404: no such attachment the viewer can see.
    NotFound,
    /// 400: a malformed request.
    BadRequest(&'static str),
    /// 403: the URL doesn't carry beghu's signature.
    BadSignature,
    /// 403: the guard refused the URL or a redirect.
    Blocked,
    /// 413: over the size cap.
    TooLarge,
    /// 415: not a type the route serves.
    NotImage,
    /// 504: upstream too slow.
    Timeout,
    /// 502: upstream failed, or answered this status.
    Upstream(String),
}

impl From<Failure> for MediaError {
    fn from(f: Failure) -> MediaError {
        match f {
            Failure::Blocked => MediaError::Blocked,
            Failure::Timeout => MediaError::Timeout,
            Failure::Redirects => MediaError::Upstream("too many redirects".into()),
            Failure::Unreachable(e) => MediaError::Upstream(e),
        }
    }
}

impl IntoResponse for MediaError {
    fn into_response(self) -> Response {
        let (status, why) = match self {
            MediaError::NotFound => (StatusCode::NOT_FOUND, "no such attachment".to_owned()),
            MediaError::BadRequest(why) => (StatusCode::BAD_REQUEST, why.to_owned()),
            MediaError::BadSignature => (StatusCode::FORBIDDEN, "bad signature".to_owned()),
            MediaError::Blocked => (StatusCode::FORBIDDEN, "blocked".to_owned()),
            MediaError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too large".to_owned()),
            MediaError::NotImage => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "not an image".to_owned(),
            ),
            MediaError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "upstream timed out".to_owned()),
            MediaError::Upstream(e) => {
                // The detail stays in the log: it may name a minted URL, good to anyone for 300 s.
                eprintln!("media: upstream failed: {e}");
                (StatusCode::BAD_GATEWAY, "upstream failed".to_owned())
            }
        };
        (
            status,
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            why,
        )
            .into_response()
    }
}

/// Copies `names` from `from` to `to`, those present.
fn pass(from: &HeaderMap, to: &mut HeaderMap, names: &[header::HeaderName]) {
    for n in names {
        if let Some(v) = from.get(n) {
            to.insert(n.clone(), v.clone());
        }
    }
}

/// The headers every media answer carries.
fn sealed(h: &mut HeaderMap) {
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
}

fn length(h: &HeaderMap) -> Option<u64> {
    h.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

/// A video's type from its file's extension, for one GitHub rendered as a video.
fn video_type(url: &Url) -> &'static str {
    match url
        .path()
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "video/mp4",
    }
}

pub async fn attachment(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
    headers: HeaderMap,
) -> Result<Response, MediaError> {
    let uuid = md_ast::uuid(&raw).ok_or(MediaError::NotFound)?;
    let turn = app.media().limiter.turn(&s.id_hash).await;
    let mut ask = HeaderMap::new();
    pass(&headers, &mut ask, &[header::RANGE, header::IF_RANGE]);
    let mut fresh = false;
    let (res, minted) = loop {
        let minted = match app.media().held(s.account, &uuid) {
            Some(m) => m,
            None => {
                fresh = true;
                match mint::for_viewer(&app, s.account, &uuid).await {
                    Ok(m) => m,
                    Err(MintError::NotFound) => return Err(MediaError::NotFound),
                    Err(MintError::Failed(e)) => return Err(MediaError::Upstream(e)),
                }
            }
        };
        if !minted
            .url
            .as_str()
            .starts_with(&format!("{}/", app.cfg().github.attachments_url))
        {
            return Err(MediaError::Upstream("minted somewhere else".into()));
        }
        let res = app
            .media()
            .fetch
            .minted(minted.url.clone(), ask.clone())
            .await?;
        match res.status().as_u16() {
            200 | 206 => break (res, minted),
            // A range past the end: GitHub's answer, with the length it gives.
            416 => {
                let mut h = HeaderMap::new();
                pass(res.headers(), &mut h, &[header::CONTENT_RANGE]);
                h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                sealed(&mut h);
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, h).into_response());
            }
            // Past its 300 s, GitHub's minted URL is a 404: mint it again, once.
            400 | 403 | 404 | 410 if !fresh => {
                app.media().held.forget(s.account, &uuid);
            }
            404 => return Err(MediaError::NotFound),
            st => return Err(MediaError::Upstream(format!("GitHub answered {st}"))),
        }
    };
    let cfg = &app.media().fetch.cfg;
    if length(res.headers()).is_some_and(|n| n > cfg.attachment_max) {
        return Err(MediaError::TooLarge);
    }
    let up = res.headers();
    let ct = match up.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        Some(t) if is_attachment_type(t) => {
            HeaderValue::from_str(t).map_err(|_| MediaError::NotImage)?
        }
        _ if minted.video => HeaderValue::from_static(video_type(&minted.url)),
        _ => return Err(MediaError::NotImage),
    };
    let mut h = HeaderMap::new();
    pass(
        up,
        &mut h,
        &[
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::ETAG,
            header::LAST_MODIFIED,
        ],
    );
    // Spec #86's value. A minted attachment's path is its uuid, and GitHub never changes what a
    // uuid names, so a year is safe for the bytes; the cost is that a viewer who later loses
    // access to the repo keeps what their browser already holds for that long. A day
    // (`private, max-age=86400`) would bound that, at the price of re-fetching (and re-minting)
    // every attachment daily; the owner may choose to amend #86 to it.
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    let video = ct.to_str().is_ok_and(|t| t.starts_with("video/")) || minted.video;
    h.insert(header::CONTENT_TYPE, ct);
    sealed(&mut h);
    let status = res.status();
    let fetch = &app.media().fetch;
    let body = if video {
        // A video's turn ends once the headers are in: a video the viewer paused stops reading
        // its stream, which then neither ends nor counts as idle, and would hold the turn for as
        // long as the tab stays open, starving the session's images.
        drop(turn);
        fetch.stream(res, cfg.attachment_max, None, ())
    } else {
        // An image holds its turn until its body is done, as the image proxy's do.
        fetch.stream(res, cfg.attachment_max, None, turn)
    };
    Ok((status, h, body).into_response())
}

#[derive(Deserialize)]
pub struct ImageQuery {
    u: Option<String>,
    sig: Option<String>,
}

/// `max-age` from the image host's `Cache-Control`, clamped to between an hour and a year; a
/// day when it says none.
fn max_age(h: &HeaderMap) -> u64 {
    const HOUR: u64 = 60 * 60;
    let given = h
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .and_then(|cc| {
            cc.split(',')
                .filter_map(|d| d.trim().strip_prefix("max-age="))
                .find_map(|v| v.trim_matches('"').parse::<u64>().ok())
        });
    given.unwrap_or(24 * HOUR).clamp(HOUR, 365 * 24 * HOUR)
}

pub async fn image(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(q): Query<ImageQuery>,
    headers: HeaderMap,
) -> Result<Response, MediaError> {
    let (Some(u), Some(sig)) = (q.u, q.sig) else {
        return Err(MediaError::BadRequest("u and sig are required"));
    };
    if !app.keys().images.verify(&u, &sig) {
        return Err(MediaError::BadSignature);
    }
    let url = Url::parse(&u).map_err(|_| MediaError::BadRequest("u isn't a URL"))?;
    let turn = app.media().limiter.turn(&s.id_hash).await;
    let cfg = app.media().fetch.cfg.clone();
    let by = Instant::now() + cfg.image_total;
    let mut ask = HeaderMap::new();
    pass(
        &headers,
        &mut ask,
        &[header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE],
    );
    ask.insert(header::ACCEPT, HeaderValue::from_static("image/*"));
    let res = app.media().fetch.guarded(url, ask, by).await?;
    let up = res.headers().clone();
    let mut h = HeaderMap::new();
    pass(&up, &mut h, &[header::ETAG, header::LAST_MODIFIED]);
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(&format!("private, max-age={}", max_age(&up)))
            .expect("a number is a header value"),
    );
    sealed(&mut h);
    match res.status().as_u16() {
        304 => return Ok((StatusCode::NOT_MODIFIED, h).into_response()),
        200 => {}
        st => return Err(MediaError::Upstream(format!("upstream answered {st}"))),
    }
    let ct = up
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|t| is_image_type(t))
        .ok_or(MediaError::NotImage)?;
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(ct).map_err(|_| MediaError::NotImage)?,
    );
    if length(&up).is_some_and(|n| n > cfg.image_max) {
        return Err(MediaError::TooLarge);
    }
    pass(&up, &mut h, &[header::CONTENT_LENGTH]);
    let body = app.media().fetch.stream(res, cfg.image_max, Some(by), turn);
    Ok((StatusCode::OK, h, body).into_response())
}
