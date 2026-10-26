//! The beghu server. So far it only answers `/healthz`; the API, webhooks and jobs land here.

use axum::Router;
use axum::http::HeaderValue;
use axum::response::IntoResponse;
use axum::routing::get;
use std::sync::Arc;

pub struct Config {
    /// `BEGHU_BUILD_ID`: the git SHA in production.
    pub build_id: String,
}

impl Config {
    pub fn new(build_id: impl Into<String>) -> Config {
        Config {
            build_id: build_id.into(),
        }
    }
}

pub fn router(cfg: Config) -> Router {
    let cfg = Arc::new(cfg);
    Router::new().route("/healthz", get(move || healthz(cfg.clone())))
}

/// Serves until the listener fails or the task is dropped.
pub async fn serve(listener: tokio::net::TcpListener, cfg: Config) -> std::io::Result<()> {
    axum::serve(listener, router(cfg)).await
}

/// Liveness: the build id, and no database.
async fn healthz(cfg: Arc<Config>) -> impl IntoResponse {
    let build = HeaderValue::from_str(&cfg.build_id).unwrap_or(HeaderValue::from_static("invalid"));
    (
        [("x-beghu-build", build)],
        axum::Json(serde_json::json!({ "build": cfg.build_id })),
    )
}
