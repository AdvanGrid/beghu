//! The SPA shell: the built `index.html`, generated per URL with `<link rel=preload>` for the
//! data that URL shows first, so the fetches start alongside the JS. It holds nothing about the
//! account, so it's cacheable (`private, max-age=300`: by the browser, never by a shared cache,
//! which would keep a build's shell past a deploy) and the same for everyone.
//!
//! The preloads must match the client's fetches byte for byte (`web/src/api.ts`): `/api/me`,
//! `/api/facets` (the filter bar's suggestions), `/api/issues` with the page's own query string
//! (`/api/tree` in Tree mode, `mode=tree`: the tree's first fetch, as a tab with no expand state
//! kept for the query makes it), and on an issue's URL (`/issues/:id`) that issue's detail,
//! `/api/issues/:id`. `web/vite.config.ts` applies the same rule in dev, where Vite serves the
//! shell.
//!
//! An issue's URL also gets `<link rel=modulepreload>` for the issue panel's chunk, so a cold deep
//! link fetches it alongside the entry instead of after it; a Tree mode URL, for the tree's. The
//! chunks' hashed names come from the build's Vite manifest, read once at startup.
//!
//! The shell names the build it belongs to (`<meta name="beghu-build">`, the server's build id),
//! since its scripts are that build's. A tab compares it with the `X-Beghu-Build` of beghu's
//! answers and of its stream's opening `reset`: once the server runs another build (a deploy),
//! the tab's next navigation loads the document afresh (`web/src/build.ts`).

use crate::App;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use std::path::Path;

/// Where the per-URL preloads go in the template.
pub const MARKER: &str = "<!--beghu:preload-->";

/// The issue panel's source module, as the Vite manifest keys it (`web/src/router.tsx` imports it
/// lazily).
const PANEL_MODULE: &str = "src/IssuePanel.tsx";
/// Tree mode's source module (`web/src/Root.tsx` imports it lazily).
const TREE_MODULE: &str = "src/IssueTree.tsx";

/// The built web app's shell: the template and what it preloads besides data.
pub struct Shell {
    template: String,
    /// The issue panel's chunk, `assets/IssuePanel-<hash>.js`.
    panel_chunk: String,
    /// Tree mode's chunk, `assets/IssueTree-<hash>.js`.
    tree_chunk: String,
}

impl Shell {
    /// Reads `index.html` and `.vite/manifest.json` from a `vite build` output directory. Either
    /// one missing, or not as the build writes it, is an error that should stop startup.
    pub fn load(dir: &Path) -> Result<Shell, String> {
        let path = dir.join("index.html");
        let template = std::fs::read_to_string(&path)
            .map_err(|e| format!("BEGHU_WEB_DIR: can't read {}: {e}", path.display()))?;
        if !template.contains(MARKER) {
            return Err(format!(
                "BEGHU_WEB_DIR: {} has no {MARKER} marker",
                path.display()
            ));
        }
        let path = dir.join(".vite").join("manifest.json");
        let bad = |why: String| {
            format!(
                "BEGHU_WEB_DIR: {} {why} (is this a `vite build` output with build.manifest on?)",
                path.display()
            )
        };
        let raw = std::fs::read_to_string(&path).map_err(|e| bad(format!("can't be read: {e}")))?;
        let manifest: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| bad(format!("isn't JSON: {e}")))?;
        let chunk = |module: &str| {
            manifest[module]["file"]
                .as_str()
                .filter(|f| f.starts_with("assets/") && f.ends_with(".js"))
                .map(str::to_owned)
                .ok_or_else(|| bad(format!("names no assets/*.js chunk for {module}")))
        };
        Ok(Shell {
            template,
            panel_chunk: chunk(PANEL_MODULE)?,
            tree_chunk: chunk(TREE_MODULE)?,
        })
    }

    /// The shell for an app URL's path and query string, as build `build`'s.
    fn render(&self, path: &str, query: Option<&str>, build: &str) -> String {
        let mut tags = format!(
            r#"<meta name="beghu-build" content="{}">"#,
            escape_attr(build)
        );
        tags.push_str(&preloads(path, query));
        // The route the app matches (`/issues/:id`, one non-empty segment) renders the panel,
        // whether or not the id is one the server will find.
        if path
            .strip_prefix("/issues/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
        {
            tags.push_str(&format!(
                r#"<link rel="modulepreload" crossorigin href="/{}">"#,
                escape_attr(&self.panel_chunk)
            ));
        }
        if tree_mode(query) {
            tags.push_str(&format!(
                r#"<link rel="modulepreload" crossorigin href="/{}">"#,
                escape_attr(&self.tree_chunk)
            ));
        }
        self.template.replacen(MARKER, &tags, 1)
    }
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Whether an app URL's query string shows the list in Tree mode (`mode=tree`), as the web app
/// reads it (`modeOf` in `web/src/query.ts`).
fn tree_mode(query: Option<&str>) -> bool {
    query.is_some_and(|q| q.split('&').any(|p| p == "mode=tree"))
}

/// The data preload tags for an app URL's path and query string.
fn preloads(path: &str, query: Option<&str>) -> String {
    let route = if tree_mode(query) {
        "/api/tree"
    } else {
        "/api/issues"
    };
    let list = match query.filter(|q| !q.is_empty()) {
        Some(q) => format!("{route}?{q}"),
        None => route.into(),
    };
    let mut hrefs = vec![String::from("/api/me"), String::from("/api/facets"), list];
    // In the canonical form the app fetches (`/issues/007` opens issue 7). Anything that isn't
    // an id in range gets no preload.
    if let Some(id) = path
        .strip_prefix("/issues/")
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|id| id.parse::<i64>().ok())
    {
        hrefs.push(format!("/api/issues/{id}"));
    }
    hrefs
        .iter()
        .map(|href| {
            format!(
                r#"<link rel="preload" href="{}" as="fetch" crossorigin>"#,
                escape_attr(href)
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

pub async fn shell(State(app): State<App>, OriginalUri(uri): OriginalUri) -> Response {
    let Some(shell) = app.shell() else {
        return (
            StatusCode::NOT_FOUND,
            "No web build here: in dev, open the app through Vite (./dev-ctl status).",
        )
            .into_response();
    };
    let html = shell.render(uri.path(), uri.query(), &app.cfg().build_id);
    let mut res = (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        html,
    )
        .into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    res
}
