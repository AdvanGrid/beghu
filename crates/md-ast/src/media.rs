//! Images and attachments (spec, "Markdown and media"): nothing a post shows loads from anywhere
//! but beghu.
//!
//! - An attachment, `https://github.com/user-attachments/assets/<uuid>`, loads through the
//!   attachment route, `/api/attachments/<uuid>`, which mints GitHub's short-lived URL for it
//!   with the viewer's token. So does a pasted minted URL
//!   (`https://private-user-images.githubusercontent.com/<user>/<n>-<uuid>.<ext>?jwt=…`, which a
//!   quote-reply copies out of GitHub's rendered HTML): it's dead 300 s after GitHub minted it,
//!   so it's routed by its UUID, and never fetched as written.
//! - Any other image loads through the signed image proxy, `/api/img?u=<url>&sig=<signature>`.
//!   The signature is the caller's ([`crate::Context::sign`]), the same for every viewer.
//! - A bare attachment URL alone in its paragraph is a `media` node: the attachment route
//!   decides, once it has minted the URL, whether it's a video or an image.
//!
//! Each image is listed in [`crate::Rendered::images`], with whether the post gives its size,
//! so the server can measure the ones it doesn't.

use ammonia::url::Url;

/// GitHub's attachment URLs.
const ATTACHMENTS: &str = "/user-attachments/assets/";
/// Where GitHub's minted attachment URLs point.
const MINTED_HOST: &str = "private-user-images.githubusercontent.com";

/// What an image is, and so where it loads from.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    /// An attachment, by its UUID (lowercase).
    Attachment(String),
    /// Anywhere else on the web: through the proxy.
    External(String),
}

impl Source {
    /// The URL its measurements are kept under: an attachment's canonical one on github.com,
    /// whichever way the post wrote it.
    pub fn key(&self) -> String {
        match self {
            Source::Attachment(uuid) => attachment_url(uuid),
            Source::External(url) => url.clone(),
        }
    }
}

/// An image a post shows, or a `media` node's attachment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    /// Its `src` in the AST.
    pub src: String,
    pub source: Source,
    /// The post gives its width and height in pixels: nothing to measure.
    pub sized: bool,
}

/// An attachment's canonical URL.
pub fn attachment_url(uuid: &str) -> String {
    format!("https://github.com{ATTACHMENTS}{uuid}")
}

/// The attachment route for `uuid`.
pub fn attachment_route(uuid: &str) -> String {
    format!("/api/attachments/{uuid}")
}

/// `s` if it's a UUID as GitHub writes them (8-4-4-4-12 hex digits), lowercased.
pub fn uuid(s: &str) -> Option<String> {
    let groups: Vec<&str> = s.split('-').collect();
    let ok = groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()));
    ok.then(|| s.to_ascii_lowercase())
}

/// The attachment a URL names, if it names one: `github.com/user-attachments/assets/<uuid>`, or
/// a minted `private-user-images` URL (`/<user>/<n>-<uuid>.<ext>`).
pub fn attachment(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    match url.host_str()? {
        "github.com" => uuid(url.path().strip_prefix(ATTACHMENTS)?),
        MINTED_HOST => {
            let file = url.path_segments()?.next_back()?;
            let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
            uuid(stem.get(stem.len().checked_sub(36)?..)?)
        }
        _ => None,
    }
}

/// Where an image at `url` (absolute, http or https) loads from: its `src`, and what it is.
pub fn route(url: &Url, sign: &dyn Fn(&str) -> String) -> (String, Source) {
    match attachment(url) {
        Some(uuid) => (attachment_route(&uuid), Source::Attachment(uuid)),
        None => {
            let u = url.to_string();
            let sig = sign(&u);
            let query = [("u", u.as_str()), ("sig", sig.as_str())];
            let src = format!(
                "/api/img?{}",
                ammonia::url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(query)
                    .finish()
            );
            (src, Source::External(u))
        }
    }
}

/// A size as an image's `width` or `height` gives it in pixels (`640`, `640px`), not a
/// percentage.
pub fn pixels(v: &str) -> Option<f64> {
    v.strip_suffix("px")
        .unwrap_or(v)
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
}
