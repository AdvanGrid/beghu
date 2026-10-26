//! The SPA shell: the built `index.html`, generated per URL with `<link rel=preload>` for the
//! data that URL shows first, so the fetches start alongside the JS. It holds nothing about the
//! account, so it's cacheable (`max-age=300`) and the same for everyone.
//!
//! The preloads must match the client's fetches byte for byte (`web/src/api.ts`): `/api/me`, and
//! `/api/issues` with the page's own query string. `web/vite.config.ts` applies the same rule in
//! dev, where Vite serves the shell.

use crate::App;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

/// Where the per-URL preloads go in the template.
pub const MARKER: &str = "<!--beghu:preload-->";

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The preload tags for an app URL's query string.
pub fn preloads(query: Option<&str>) -> String {
    let list = match query.filter(|q| !q.is_empty()) {
        Some(q) => format!("/api/issues?{q}"),
        None => "/api/issues".into(),
    };
    [String::from("/api/me"), list]
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
    let Some(template) = app.shell_template() else {
        return (
            StatusCode::NOT_FOUND,
            "No web build here: in dev, open the app through Vite (./dev-ctl status).",
        )
            .into_response();
    };
    let html = template.replacen(MARKER, &preloads(uri.query()), 1);
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
        HeaderValue::from_static("max-age=300"),
    );
    res
}
