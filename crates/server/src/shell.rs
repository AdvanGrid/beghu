//! The SPA shell: the built `index.html`, generated per URL with `<link rel=preload>` for the
//! data that URL shows first, so the fetches start alongside the JS. It holds nothing about the
//! account, so it's cacheable (`private, max-age=300`: by the browser, never by a shared cache,
//! which would keep a build's shell past a deploy) and the same for everyone.
//!
//! The preloads must match the client's fetches byte for byte (`web/src/api.ts`): `/api/me`,
//! `/api/facets` (the filter bar's suggestions), `/api/issues` with the page's own query string
//! (`/api/tree` in Tree mode, `mode=tree`: the tree's first fetch, as a tab with no expand state
//! kept for the query makes it), and on an issue's URL (`/:owner/:repo/issues/:number`, or
//! `/pull/:number` for a PR, as on GitHub) that issue's detail, `/api/at/:owner/:repo/:number`.
//! `web/vite.config.ts` applies the same rule in dev, where Vite serves the
//! shell.
//!
//! An issue's URL also gets `<link rel=modulepreload>` for the issue panel's chunk, so a cold deep
//! link fetches it alongside the entry instead of after it; a Tree mode URL, for the tree's. The
//! chunks' hashed names come from the build's Vite manifest, read once at startup.
//!
//! A PR view's URL (`/:owner/:repo/pull/:number/view`) shows no list or filter bar, so it gets
//! neither's preload: `/api/me`, the PR's detail and its analysis graph
//! (`/api/:owner/:repo/pulls/:number/analysis`), and the view's chunk with the chunks it imports.
//! A cold open is then shell → (entry ∥ chunk ∥ graph) → draw.
//!
//! The shell names the build it belongs to (`<meta name="beghu-build">`, the server's build id),
//! since its scripts are that build's. A tab compares it with the `X-Beghu-Build` of beghu's
//! answers and of its stream's opening `reset`: once the server runs another build (a deploy),
//! the tab's next navigation loads the document afresh (`web/src/build.ts`).

use crate::App;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use std::path::Path;

/// Where the per-URL preloads go in the template.
pub const MARKER: &str = "<!--beghu:preload-->";

/// The issue panel's source module, as the Vite manifest keys it (`web/src/router.tsx` imports it
/// lazily).
const PANEL_MODULE: &str = "src/IssuePanel.tsx";
/// Tree mode's source module (`web/src/Root.tsx` imports it lazily).
const TREE_MODULE: &str = "src/IssueTree.tsx";
/// The PR view's source module (`web/src/router.tsx` imports it lazily).
const VIEW_MODULE: &str = "src/pr-view/View.tsx";

/// The built web app's shell: the template and what it preloads besides data.
pub struct Shell {
    template: String,
    /// The issue panel's chunk, `assets/IssuePanel-<hash>.js`.
    panel_chunk: String,
    /// Tree mode's chunk, `assets/IssueTree-<hash>.js`.
    tree_chunk: String,
    /// The PR view's chunk, `assets/View-<hash>.js`, then the chunks it imports statically
    /// (code it shares with the PR panel's), the entry's aside.
    view_chunks: Vec<String>,
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
        // The view's chunk and what it imports, at any depth, but the entry (first-load JS).
        let mut view_chunks = vec![chunk(VIEW_MODULE)?];
        let mut todo = vec![VIEW_MODULE.to_owned()];
        let mut seen = std::collections::HashSet::from([VIEW_MODULE.to_owned()]);
        while let Some(module) = todo.pop() {
            for import in manifest[&module]["imports"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(key) = import.as_str() else { continue };
                if manifest[key]["isEntry"].as_bool() == Some(true) || !seen.insert(key.to_owned())
                {
                    continue;
                }
                view_chunks.push(chunk(key)?);
                todo.push(key.to_owned());
            }
        }
        Ok(Shell {
            template,
            panel_chunk: chunk(PANEL_MODULE)?,
            tree_chunk: chunk(TREE_MODULE)?,
            view_chunks,
        })
    }

    /// The shell for an app URL's path and query string, as build `build`'s.
    fn render(&self, path: &str, query: Option<&str>, build: &str) -> String {
        let mut tags = format!(
            r#"<meta name="beghu-build" content="{}">"#,
            escape_attr(build)
        );
        if view_at(path).is_some() {
            tags.push_str(&view_preloads(path));
            for c in &self.view_chunks {
                tags.push_str(&format!(
                    r#"<link rel="modulepreload" crossorigin href="/{}">"#,
                    escape_attr(c)
                ));
            }
            return self.template.replacen(MARKER, &tags, 1);
        }
        tags.push_str(&preloads(path, query));
        // The route the app matches renders the panel, whether or not the issue is one the
        // server will find.
        if issue_at(path).is_some() {
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

/// Whether an app URL's query string shows the list as a tree: Tree mode (`mode=tree`) or Focus
/// view on an issue (`mode=focus` with `focus=`), as the web app reads it (`modeOf` in
/// `web/src/query.ts`). Both are the tree's chunk and `/api/tree`.
fn tree_mode(query: Option<&str>) -> bool {
    query.is_some_and(|q| {
        let has = |f: &dyn Fn(&str) -> bool| q.split('&').any(f);
        has(&|p| p == "mode=tree")
            || (has(&|p| p == "mode=focus") && has(&|p| p.starts_with("focus=")))
    })
}

/// An issue's URL as the app's route matches it (`web/src/router.tsx`): its owner, repo and number,
/// each one non-empty segment, with `issues` or `pull` between, as on GitHub.
fn issue_at(path: &str) -> Option<(&str, &str, &str)> {
    let mut parts = path.strip_prefix('/')?.split('/');
    let (owner, repo, kind, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let whole = parts.next().is_none() && [owner, repo, number].iter().all(|p| !p.is_empty());
    (whole && matches!(kind, "issues" | "pull")).then_some((owner, repo, number))
}

/// A PR view's URL as the app's route matches it (`web/src/router.tsx`): its owner, repo and
/// number, each one non-empty segment.
fn view_at(path: &str) -> Option<(&str, &str, &str)> {
    let mut parts = path.strip_prefix('/')?.split('/');
    let (owner, repo, kind, number, view) = (
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next()?,
    );
    let whole = parts.next().is_none() && [owner, repo, number].iter().all(|p| !p.is_empty());
    (whole && kind == "pull" && view == "view").then_some((owner, repo, number))
}

/// Whether a URL segment names an owner or repo as GitHub would, so the app's escaping of it is
/// the shell's.
fn plain_name(n: &str) -> bool {
    n.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn preload_tag(href: &str) -> String {
    format!(
        r#"<link rel="preload" href="{}" as="fetch" crossorigin>"#,
        escape_attr(href)
    )
}

/// A PR view's data preloads: `/api/me`, and for a plain owner, repo and number in range the PR's
/// detail and its analysis graph, in the form the app fetches (`web/src/analysis.ts`).
fn view_preloads(path: &str) -> String {
    let mut hrefs = vec![String::from("/api/me")];
    if let Some((owner, repo, number)) = view_at(path)
        .filter(|(owner, repo, number)| {
            plain_name(owner) && plain_name(repo) && number.bytes().all(|b| b.is_ascii_digit())
        })
        .and_then(|(owner, repo, number)| Some((owner, repo, number.parse::<i64>().ok()?)))
    {
        hrefs.push(format!("/api/at/{owner}/{repo}/{number}"));
        hrefs.push(format!("/api/{owner}/{repo}/pulls/{number}/analysis"));
    }
    hrefs.iter().map(|h| preload_tag(h)).collect()
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
    // In the canonical form the app fetches (`/acme/web/issues/007` opens number 7). Anything
    // that isn't a number in range, or names an owner or repo GitHub wouldn't (whose escaping
    // might differ from the app's), gets no preload.
    if let Some((owner, repo, number)) = issue_at(path)
        .filter(|(owner, repo, number)| {
            plain_name(owner) && plain_name(repo) && number.bytes().all(|b| b.is_ascii_digit())
        })
        .and_then(|(owner, repo, number)| Some((owner, repo, number.parse::<i64>().ok()?)))
    {
        hrefs.push(format!("/api/at/{owner}/{repo}/{number}"));
    }
    hrefs.iter().map(|h| preload_tag(h)).collect()
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
    // The app is behind sign-in: a search engine has nothing to index here (the public site,
    // `site.rs`, is what it should find).
    res.headers_mut().insert(
        HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex"),
    );
    res
}
