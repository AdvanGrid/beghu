//! The view's data, for the browser session's account only:
//!
//! - `GET /api/{owner}/{repo}/pulls/{n}/analysis`: the graph, the stored blob as is (brotli or
//!   gzip, by `accept-encoding`; inflated for a client that takes neither). `ETag:
//!   "<id>.v<version>"` and `Cache-Control: private, no-cache`, so a revisit revalidates and gets
//!   a `304`. `404` (`no_analysis`) when the PR has none.
//! - `GET /api/{owner}/{repo}/pulls/{n}/analysis/{id}/v{version}/claims`: the claims, the URL
//!   the graph names, `private, max-age=31536000, immutable`. Any other analysis or version is a
//!   `404`: the graph names the current one.
//!
//! Both read the analysis at this build's schema, migrating it first ([`stored::current`]); a
//! failed migration answers 500 (`migration_failed`). `private` keeps them out of shared caches,
//! as every other API answer's `no-store` does.

use super::PrKey;
use super::runs::{pr_number, readable_repo};
use super::stored;
use crate::App;
use crate::auth::Session;
use crate::error::ApiError;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

/// How a blob goes out.
#[derive(Clone, Copy, PartialEq)]
enum Coding {
    Br,
    Gzip,
    Identity,
}

/// The best of brotli and gzip the client takes, by `accept-encoding` (a `q=0` refuses one).
fn coding(headers: &HeaderMap) -> Coding {
    let accepts = |name: &str| {
        headers
            .get_all(header::ACCEPT_ENCODING)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|part| {
                let mut it = part.split(';');
                let coding = it.next().unwrap_or("").trim();
                let q = it
                    .find_map(|p| p.trim().strip_prefix("q="))
                    .and_then(|q| q.trim().parse::<f32>().ok())
                    .unwrap_or(1.0);
                (coding.eq_ignore_ascii_case(name) || coding == "*") && q > 0.0
            })
    };
    if accepts("br") {
        Coding::Br
    } else if accepts("gzip") {
        Coding::Gzip
    } else {
        Coding::Identity
    }
}

/// The PR the route names, for the session's account: `None` when the account can't read the
/// repo.
async fn pr(
    app: &App,
    account: i64,
    owner: &str,
    name: &str,
    number: &str,
) -> Result<PrKey, ApiError> {
    let number = pr_number(number)?;
    let repo = readable_repo(app, account, owner, name)
        .await?
        .ok_or(ApiError::NoAnalysis)?;
    Ok(PrKey {
        account,
        repo_id: repo.id,
        number,
    })
}

/// Which blob.
#[derive(Clone, Copy)]
enum Part {
    Graph,
    Claims,
}

/// The blob, encoded as the client takes it.
async fn blob(app: &App, pr: &PrKey, id: &str, part: Part, c: Coding) -> Result<Vec<u8>, ApiError> {
    let id = id.to_owned();
    let gz = c != Coding::Br;
    let got = app
        .analyses()
        .dbs
        .read(pr.account, move |conn| {
            Ok(match (part, gz) {
                (Part::Graph, false) => analysis_db::q::graph_br(conn, &id)?,
                (Part::Graph, true) => analysis_db::q::graph_gz(conn, &id)?,
                (Part::Claims, false) => analysis_db::q::claims_br(conn, &id)?,
                (Part::Claims, true) => analysis_db::q::claims_gz(conn, &id)?,
            })
        })
        .await?
        // An upload replaced it since the row was read.
        .ok_or(ApiError::NoAnalysis)?;
    if c == Coding::Identity {
        return tokio::task::spawn_blocking(move || stored::gunzip(&got))
            .await
            .map_err(|_| ApiError::Internal("inflating an analysis panicked".into()))?
            .map_err(ApiError::Internal);
    }
    Ok(got)
}

fn respond(body: Vec<u8>, c: Coding, etag: Option<&str>, cache: &'static str) -> Response {
    let mut res = (StatusCode::OK, body).into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    match c {
        Coding::Br => {
            h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
        }
        Coding::Gzip => {
            h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        }
        Coding::Identity => {}
    }
    h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Some(tag) = etag.and_then(|t| HeaderValue::from_str(t).ok()) {
        h.insert(header::ETAG, tag);
    }
    res
}

/// `GET /api/{owner}/{repo}/pulls/{n}/analysis`.
pub async fn graph(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path((owner, name, number)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pr = pr(&app, s.account, &owner, &name, &number).await?;
    let meta = stored::current(&app, &pr)
        .await?
        .ok_or(ApiError::NoAnalysis)?;
    let etag = format!("\"{}.v{}\"", meta.id, meta.version);
    const CACHE: &str = "private, no-cache";
    let matched = headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|t| t.trim().trim_start_matches("W/") == etag);
    if matched {
        let mut res = StatusCode::NOT_MODIFIED.into_response();
        let h = res.headers_mut();
        h.insert(header::ETAG, HeaderValue::from_str(&etag).expect("ASCII"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE));
        h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
        return Ok(res);
    }
    let c = coding(&headers);
    let body = blob(&app, &pr, &meta.id, Part::Graph, c).await?;
    Ok(respond(body, c, Some(&etag), CACHE))
}

/// `GET /api/{owner}/{repo}/pulls/{n}/analysis/{id}/v{version}/claims`.
pub async fn claims(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path((owner, name, number, id, version)): Path<(String, String, String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pr = pr(&app, s.account, &owner, &name, &number).await?;
    let version: i64 = version
        .strip_prefix('v')
        .and_then(|v| v.parse().ok())
        .ok_or(ApiError::NoAnalysis)?;
    let meta = stored::current(&app, &pr)
        .await?
        .ok_or(ApiError::NoAnalysis)?;
    if meta.id != id || meta.version != version {
        return Err(ApiError::NoAnalysis);
    }
    let c = coding(&headers);
    let body = blob(&app, &pr, &meta.id, Part::Claims, c).await?;
    Ok(respond(
        body,
        c,
        None,
        "private, max-age=31536000, immutable",
    ))
}
