//! `beghu`: configured from the environment only (see `Config::from_env`).
//!
//! - `PORT` (default 3000): plain HTTP on every interface.
//! - `BEGHU_BUILD_ID` (default `dev`): the git SHA in production; the image requires it.
//! - `BEGHU_PUBLIC_URL`, `BEGHU_DATA_DIR`, `BEGHU_TOKEN_KEY`, `GITHUB_CLIENT_ID`,
//!   `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
//!   (required); `GITHUB_API_URL`, `GITHUB_WEB_URL`, `GITHUB_APP_SLUG`, `BEGHU_WEB_DIR`,
//!   `BEGHU_MIRROR_CONNECTIONS` (optional). docs/deploy.md has the full list.
//!
//! SIGTERM (or Ctrl-C) drains for up to 25 s, finishing the writes in flight and stopping the
//! jobs, then checkpoints the WALs (within those 25 s) and exits; a second one exits at once.
//! Webhook deliveries still waiting on a relationship read-back aren't waited for: they're
//! replayed at the next start (see `serve_until`). docs/deploy.md ("Stopping") has the figures.

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
    // First, so a SIGTERM during the startup is kept for the drain (as PID 1 in a container, an
    // unhandled one would be ignored), which begins as soon as the server serves.
    let signals = signals();
    // Startup in its order (see `beghu::Opened`): up to listening, serve, then the rest.
    let opened = beghu::App::open(cfg).await.unwrap_or_else(|e| fail(&e, 1));
    let addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| fail(&format!("can't listen on {addr}: {e}"), 1));
    eprintln!("beghu {build_id} listening on http://localhost:{port}");
    let serving = tokio::spawn(beghu::serve_until(listener, opened.app(), signals));
    opened.start().await.unwrap_or_else(|e| fail(&e, 1));
    match serving.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => fail(&format!("server failed: {e}"), 1),
        Err(e) => fail(&format!("server panicked: {e}"), 1),
    }
    eprintln!("stopped");
    // Now, rather than by returning: dropping the runtime would wait for every blocking thread,
    // a checkpoint that overran the drain's budget among them.
    std::process::exit(0)
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
