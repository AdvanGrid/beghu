//! The public site: the landing page (`/`), `/pricing`, `/privacy`, `/terms` and whatever else
//! `web/site/` holds, prerendered to static HTML by the web build (`web/site/build.ts`), with
//! `robots.txt` and `sitemap.xml`. They hold nothing about the account, so a shared cache may
//! keep them (`public, max-age=300`), and they are the same whether or not the browser is signed
//! in: `/` is the landing page for everyone, never the app (which is at `/issues`).
//!
//! The build writes `site/pages.json` (each page's path and file) next to the files. They name
//! beghu's own origin (canonical URLs, Open Graph, the sitemap) as [`ORIGIN`], since a build
//! doesn't know where it will be served; it's filled in from `BEGHU_PUBLIC_URL` once, at
//! startup.

use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Where the build writes beghu's origin, as `web/site/build.ts` does.
pub const ORIGIN: &str = "%BEGHU_ORIGIN%";

/// The first path segments the server answers itself: no page may take one.
const RESERVED: &[&str] = &[
    "issues", "new", "repos", "prefs", "api", "auth", "assets", "webhook", "healthz", "readyz",
];

/// One file the site serves, as it goes out.
#[derive(Clone)]
pub struct File {
    body: Bytes,
    content_type: &'static str,
    etag: HeaderValue,
}

/// The prerendered pages, with their origin filled in, and `robots.txt` and `sitemap.xml`.
pub struct Site {
    files: Vec<(String, File)>,
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    file: String,
}

impl Site {
    /// Reads `site/` from a web build, filling in `origin`. A missing or malformed file, or a
    /// page on a path the server answers itself, is an error that should stop startup.
    pub fn load(web: &Path, origin: &str) -> Result<Site, String> {
        let dir = web.join("site");
        let read = |name: &str| {
            let path = dir.join(name);
            std::fs::read_to_string(&path)
                .map_err(|e| format!("BEGHU_WEB_DIR: can't read {}: {e}", path.display()))
        };
        let pages: Vec<Entry> = serde_json::from_str(&read("pages.json")?)
            .map_err(|e| format!("BEGHU_WEB_DIR: site/pages.json isn't a page list: {e}"))?;
        let mut files = Vec::new();
        for p in pages {
            let segment = p.path.strip_prefix('/').unwrap_or("/");
            let plain = segment
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            let file_ok = !p.file.contains(['/', '\\']) && p.file.ends_with(".html");
            if !plain || RESERVED.contains(&segment) || !file_ok {
                return Err(format!(
                    "BEGHU_WEB_DIR: site/pages.json names {} ({}), which the site can't serve",
                    p.path, p.file
                ));
            }
            if files.iter().any(|(path, _)| *path == p.path) {
                return Err(format!(
                    "BEGHU_WEB_DIR: site/pages.json names {} twice",
                    p.path
                ));
            }
            let body = read(&p.file)?;
            files.push((p.path, file(&body, origin, "text/html; charset=utf-8")));
        }
        files.push((
            "/robots.txt".into(),
            file(&read("robots.txt")?, origin, "text/plain; charset=utf-8"),
        ));
        files.push((
            "/sitemap.xml".into(),
            file(&read("sitemap.xml")?, origin, "application/xml"),
        ));
        Ok(Site { files })
    }

    /// Every path the site answers, with what it sends.
    pub fn files(&self) -> impl Iterator<Item = (&str, &File)> {
        self.files.iter().map(|(path, f)| (path.as_str(), f))
    }
}

fn file(body: &str, origin: &str, content_type: &'static str) -> File {
    let body = Bytes::from(body.replace(ORIGIN, origin));
    let hash = Sha256::digest(&body);
    let tag: String = hash[..12].iter().map(|b| format!("{b:02x}")).collect();
    File {
        body,
        content_type,
        etag: HeaderValue::from_str(&format!("\"{tag}\"")).expect("hex is a valid header"),
    }
}

impl File {
    /// The file, or a 304 when the browser already holds it.
    pub fn respond(&self, headers: &HeaderMap) -> Response {
        let cache = HeaderValue::from_static("public, max-age=300");
        let held = headers
            .get_all(header::IF_NONE_MATCH)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|t| {
                let t = t.trim();
                t == "*" || t.trim_start_matches("W/").as_bytes() == self.etag.as_bytes()
            });
        if held {
            return (
                StatusCode::NOT_MODIFIED,
                [
                    (header::ETAG, self.etag.clone()),
                    (header::CACHE_CONTROL, cache),
                ],
            )
                .into_response();
        }
        (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(self.content_type),
                ),
                (header::ETAG, self.etag.clone()),
                (header::CACHE_CONTROL, cache),
            ],
            self.body.clone(),
        )
            .into_response()
    }
}
