//! Attachments, as GitHub serves them to an App (#62, #67, measured). The web's image hosts,
//! which aren't GitHub, have their own stand-in (`web_hosts.rs`).
//!
//! **Uploads.** `POST /attachments` on the control port uploads a file as someone would through
//! GitHub's editor: `{"as"?: login, "kind": "image" | "video", "width"?, "height"?, "name"?,
//! "size"?}`. An image is a PNG of that size (default 640 × 360); a video is a short WebM
//! (320 × 180). Either is padded out to `size` bytes if given (a PNG's decoders ignore what
//! follows its end), for a file too long to sit whole in the sockets' buffers. The answer is `{uuid, url, markdown}`: the
//! `github.com/user-attachments/assets/<uuid>` URL and the Markdown the editor would write
//! (`<img width height alt src>` for an image, the bare URL on its own line for a video), to put
//! in a post with `POST /edit`.
//!
//! **Minting.** The plain `github.com/user-attachments/assets/<uuid>` URL serves nothing to an
//! App's tokens (404, the fallback here too). A post's rendered HTML is where GitHub mints a URL
//! for each attachment in it, good for 300 s and for whoever holds it:
//! `<origin>/private-user-images/<uploader id>/<n>-<uuid>.<ext>?jwt=…` here, where GitHub's host
//! is `private-user-images.githubusercontent.com`. The HTML comes from REST's `body_html` (an
//! issue or comment read as `application/vnd.github.html+json`) and GraphQL's `bodyHTML`
//! (`MintAttachments`, `nodes(ids:)` over issues, PRs and comments). GitHub renders the whole
//! post; the fake renders only what beghu takes from it, the attachments: an image as
//! `<a href=M><img src=M></a>`, a video as `<details><summary>name</summary><video src=M>`; the
//! rest is the Markdown as escaped text. A token that can't read the post gets GitHub's 404 (REST)
//! or `null` and `NOT_FOUND` (GraphQL), so it mints nothing.
//!
//! The minted URL serves the bytes with `Range` (206, `Content-Range`, `Accept-Ranges: bytes`)
//! and answers 404 once it's past its `exp` on the fake's clock (`PUT /clock` moves it on).
//!
//! `/state` counts the requests these minted URLs and the web hosts' stand-in answered, and the
//! most that were in flight at once (`media`).

use crate::Fake;
use crate::api::{self, Token, can_see};
use axum::Router;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use fake_db::q;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// A minted URL's lifetime: GitHub's.
const MINTED_TTL: i64 = 300;

/// The video every video upload is: 2 s of WebM (VP8), 320 × 180.
const SAMPLE_WEBM: &[u8] = include_bytes!("sample.webm");

/// The minted URLs' signing key and the media requests' counts.
pub(crate) struct Media {
    key: [u8; 32],
    in_flight: AtomicUsize,
    peak: AtomicUsize,
    served: AtomicU64,
}

impl Default for Media {
    fn default() -> Self {
        use rand::RngCore as _;
        let mut key = [0u8; 32];
        rand::rng().fill_bytes(&mut key);
        Media {
            key,
            in_flight: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            served: AtomicU64::new(0),
        }
    }
}

impl Media {
    pub(crate) fn snapshot(&self) -> Value {
        json!({
            "served": self.served.load(Ordering::Relaxed),
            "peak": self.peak.load(Ordering::Relaxed),
        })
    }

    pub(crate) fn clear(&self) {
        self.served.store(0, Ordering::Relaxed);
        self.peak.store(0, Ordering::Relaxed);
    }

    fn sign(&self, payload: &str) -> String {
        let mut m = Hmac::<Sha256>::new_from_slice(&self.key).expect("any key length");
        m.update(payload.as_bytes());
        b64(&m.finalize().into_bytes())
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
}

pub(crate) fn router() -> Router<Fake> {
    Router::new().route("/private-user-images/{user}/{file}", get(minted))
}

/// Counts the media requests in flight, and the most at once. Outermost, so a latency fault's
/// wait counts too.
pub(crate) async fn count(State(fake): State<Fake>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !(path.starts_with("/ext/") || path.starts_with("/private-user-images/")) {
        return next.run(req).await;
    }
    let m = &fake.state().media;
    let now = m.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
    m.peak.fetch_max(now, Ordering::SeqCst);
    let res = next.run(req).await;
    m.in_flight.fetch_sub(1, Ordering::SeqCst);
    m.served.fetch_add(1, Ordering::Relaxed);
    res
}

/// A PNG of `w` × `h`, one colour.
pub(crate) fn png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().expect("a PNG header writes to memory");
        let row: Vec<u8> = (0..w).flat_map(|_| rgb).collect();
        let mut data = Vec::with_capacity(row.len() * h as usize);
        for _ in 0..h {
            data.extend_from_slice(&row);
        }
        writer
            .write_image_data(&data)
            .expect("PNG data writes to memory");
    }
    out
}

#[derive(Deserialize)]
pub(crate) struct Upload {
    #[serde(rename = "as")]
    login: Option<String>,
    kind: String,
    width: Option<u32>,
    height: Option<u32>,
    name: Option<String>,
    /// The file's length in bytes: the PNG or sample video, padded out (a longer file, as far
    /// as its size goes). Up to 64 MB.
    size: Option<usize>,
}

/// `POST /attachments` (control port).
pub(crate) async fn upload(
    State(fake): State<Fake>,
    axum::Json(u): axum::Json<Upload>,
) -> Response {
    let (w, h) = (
        u.width.unwrap_or(640).clamp(1, 4096),
        u.height.unwrap_or(360).clamp(1, 4096),
    );
    let (mut bytes, content_type, default_name) = match u.kind.as_str() {
        "image" => (png(w, h, [0x2f, 0x6f, 0xd6]), "image/png", "Image"),
        "video" => (SAMPLE_WEBM.to_vec(), "video/webm", "screen-recording.webm"),
        other => {
            return crate::control::bad_request(format!("kind is image or video, not {other:?}"));
        }
    };
    bytes.resize(u.size.unwrap_or(0).clamp(bytes.len(), 64 << 20), 0);
    let uuid = new_uuid();
    let name = u.name.unwrap_or_else(|| default_name.to_owned());
    let (id, n) = (uuid.clone(), name.clone());
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let uploader = match u.login.as_deref() {
                Some(l) => q::account_by_login(tx, l)?.map(|a| a.id),
                None => q::accounts(tx)?.first().map(|a| a.id),
            };
            let Some(uploader) = uploader else {
                return Ok(Err("no such fixture account".to_owned()));
            };
            q::add_attachment(tx, &id, uploader, &n, content_type, &bytes)?;
            Ok(Ok(()))
        })
        .await;
    match done {
        Ok(Ok(())) => {}
        Ok(Err(why)) => return crate::control::bad_request(why),
        Err(e) => return api::internal(e),
    }
    let url = format!("https://github.com/user-attachments/assets/{uuid}");
    let markdown = match u.kind.as_str() {
        "image" => format!("<img width=\"{w}\" height=\"{h}\" alt=\"{name}\" src=\"{url}\" />"),
        _ => url.clone(),
    };
    axum::Json(json!({ "uuid": uuid, "url": url, "markdown": markdown })).into_response()
}

fn new_uuid() -> String {
    use rand::RngCore as _;
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn ext_of(content_type: &str) -> &'static str {
    match content_type {
        "video/webm" => "webm",
        "video/mp4" => "mp4",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The origin a request came to: where the fake's minted URLs point.
pub(crate) fn origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    format!("http://{host}")
}

/// A post's `body_html` as far as the fake renders it: its attachments with freshly minted URLs,
/// the rest as escaped text.
pub(crate) fn body_html(
    fake: &Fake,
    c: &rusqlite::Connection,
    md: &str,
    origin: &str,
) -> rusqlite::Result<String> {
    const ASSETS: &str = "https://github.com/user-attachments/assets/";
    let mut out = String::from("<p dir=\"auto\">");
    let mut at = 0;
    for (start, _) in md.match_indices(ASSETS) {
        if start < at {
            continue;
        }
        let uuid_at = start + ASSETS.len();
        let Some(uuid) = md.get(uuid_at..uuid_at + 36) else {
            continue;
        };
        let Some(a) = q::attachment(c, uuid)? else {
            continue;
        };
        out.push_str(&escape(&md[at..start]));
        let exp = fake.now() + MINTED_TTL;
        let path = format!(
            "/private-user-images/{}/1-{uuid}.{}",
            a.uploader_id,
            ext_of(&a.content_type)
        );
        let payload = b64(json!({ "path": path, "exp": exp, "nbf": fake.now() })
            .to_string()
            .as_bytes());
        let jwt = format!("{payload}.{}", fake.state().media.sign(&payload));
        let m = format!("{origin}{path}?jwt={jwt}");
        if a.content_type.starts_with("video/") {
            out.push_str(&format!(
                "<details open=\"\" class=\"details-reset\"><summary>{}</summary><video src=\"{m}\" data-canonical-src=\"{m}\" controls=\"controls\" muted=\"muted\"></video></details>",
                escape(&a.name)
            ));
        } else {
            out.push_str(&format!(
                "<a target=\"_blank\" rel=\"noopener noreferrer\" href=\"{m}\"><img src=\"{m}\" alt=\"{}\" style=\"max-width: 100%;\"></a>",
                escape(&a.name)
            ));
        }
        at = uuid_at + 36;
    }
    out.push_str(&escape(&md[at..]));
    out.push_str("</p>");
    Ok(out)
}

/// Whether `headers` ask for GitHub's rendered HTML (`html+json`, or `full+json`).
pub(crate) fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("html+json") || a.contains("full+json"))
}

/// GraphQL `MintAttachments(ids)`: each issue's, PR's or comment's `bodyHTML`, the ones the token
/// can read; `null` and `NOT_FOUND` for the rest.
pub(crate) fn mint_nodes(
    fake: &Fake,
    c: &rusqlite::Connection,
    token: Token,
    ids: &[String],
    origin: &str,
) -> rusqlite::Result<Value> {
    let mut nodes = Vec::new();
    let mut errs = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let found = match q::item_by_node(c, id)? {
            Some(item) if can_see(c, token, item.repo_id)? => Some((
                if item.kind == "pr" {
                    "PullRequest"
                } else {
                    "Issue"
                },
                q::item_body(c, item.id)?.unwrap_or_default(),
            )),
            Some(_) => None,
            None => match q::comment_by_node(c, id)? {
                Some(cm) if can_see(c, token, cm.repo_id)? => Some(("IssueComment", cm.body)),
                _ => None,
            },
        };
        match found {
            Some((typename, md)) => nodes.push(json!({
                "__typename": typename,
                "id": id,
                "bodyHTML": body_html(fake, c, &md, origin)?,
            })),
            None => {
                nodes.push(Value::Null);
                errs.push(json!({
                    "type": "NOT_FOUND",
                    "path": ["nodes", i],
                    "locations": [],
                    "message": format!("Could not resolve to a node with the global id of '{id}'"),
                }));
            }
        }
    }
    Ok(if errs.is_empty() {
        json!({ "data": { "nodes": nodes } })
    } else {
        json!({ "data": { "nodes": nodes }, "errors": errs })
    })
}

#[derive(Deserialize)]
struct Jwt {
    jwt: Option<String>,
}

/// `Range: bytes=…` over `len` bytes: the span asked for, `Err` for one out of range.
fn range(headers: &HeaderMap, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = headers
        .get(header::RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let span = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (a, "") => (a.parse().ok()?, len.checked_sub(1)?),
        (a, b) => (
            a.parse().ok()?,
            b.parse::<u64>().ok()?.min(len.checked_sub(1)?),
        ),
    };
    Some(if span.0 <= span.1 && span.1 < len {
        Ok(span)
    } else {
        Err(())
    })
}

/// A minted URL: the attachment's bytes until its `exp`, with `Range`.
async fn minted(
    State(fake): State<Fake>,
    Path((user, file)): Path<(String, String)>,
    Query(j): Query<Jwt>,
    headers: HeaderMap,
) -> Response {
    let path = format!("/private-user-images/{user}/{file}");
    let valid = j.jwt.as_deref().and_then(|jwt| {
        let (payload, sig) = jwt.split_once('.')?;
        (fake.state().media.sign(payload) == sig).then_some(())?;
        let claims: Value = serde_json::from_slice(&unb64(payload)?).ok()?;
        (claims["path"] == path && claims["exp"].as_i64()? >= fake.now()).then_some(())
    });
    let not_found = || (StatusCode::NOT_FOUND, "Not Found").into_response();
    if valid.is_none() {
        return not_found();
    }
    let stem = file.rsplit_once('.').map_or(file.as_str(), |(s, _)| s);
    let Some(uuid) = stem.get(stem.len().saturating_sub(36)..).map(str::to_owned) else {
        return not_found();
    };
    let found = fake
        .state()
        .truth
        .read(move |c| q::attachment(c, &uuid))
        .await;
    let a = match found {
        Ok(Some(a)) => a,
        Ok(None) => return not_found(),
        Err(e) => return api::internal(e),
    };
    let len = a.bytes.len() as u64;
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&a.content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    match range(&headers, len) {
        None => (StatusCode::OK, h, a.bytes).into_response(),
        Some(Ok((from, to))) => {
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {from}-{to}/{len}")).expect("ascii"),
            );
            let part = a.bytes[from as usize..=to as usize].to_vec();
            (StatusCode::PARTIAL_CONTENT, h, part).into_response()
        }
        Some(Err(())) => {
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{len}")).expect("ascii"),
            );
            (StatusCode::RANGE_NOT_SATISFIABLE, h).into_response()
        }
    }
}
