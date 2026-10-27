//! `beghu`: configured from the environment only (see `Config::from_env`).
//!
//! - `PORT` (default 3000): plain HTTP on every interface.
//! - `BEGHU_BUILD_ID` (default `dev`): the git SHA in production.
//! - `BEGHU_PUBLIC_URL`, `BEGHU_DATA_DIR`, `BEGHU_TOKEN_KEY`, `GITHUB_CLIENT_ID`,
//!   `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
//!   (required); `GITHUB_API_URL`, `GITHUB_WEB_URL`, `BEGHU_WEB_DIR`, `BEGHU_MIRROR_CONNECTIONS`
//!   (optional).
//!
//! SIGTERM (or Ctrl-C) drains for up to 25 s, finishing the writes in flight, then exits; a second
//! one exits at once. Webhook deliveries still waiting on a relationship read-back aren't waited
//! for: they're replayed at the next start (see `serve_until`).

use std::net::{Ipv6Addr, SocketAddr};

fn fail(msg: &str, code: i32) -> ! {
    eprintln!("{msg}");
    std::process::exit(code)
}

#[tokio::main]
async fn main() {
    let port = match std::env::var("PORT") {
        Err(_) => 3000,
        Ok(v) => v
            .parse::<u16>()
            .unwrap_or_else(|_| fail(&format!("PORT must be a port number, got {v:?}"), 2)),
    };
    let cfg = beghu::Config::from_env().unwrap_or_else(|e| fail(&e, 2));
    let build_id = cfg.build_id.clone();
    let app = beghu::App::open(cfg).await.unwrap_or_else(|e| fail(&e, 1));
    let addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| fail(&format!("can't listen on {addr}: {e}"), 1));
    eprintln!("beghu {build_id} listening on http://localhost:{port}");
    if let Err(e) = beghu::serve_until(listener, app, signals()).await {
        fail(&format!("server failed: {e}"), 1);
    }
    eprintln!("stopped");
}

/// Each SIGTERM or Ctrl-C, as it comes.
fn signals() -> tokio::sync::mpsc::UnboundedReceiver<()> {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("a SIGTERM handler");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            if tx.send(()).is_err() {
                break;
            }
        }
    });
    rx
}
