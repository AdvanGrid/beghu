//! `beghu`: configured from the environment only.
//!
//! - `PORT` (default 3000): plain HTTP on every interface.
//! - `BEGHU_BUILD_ID` (default `dev`): the git SHA in production.

use std::net::{Ipv6Addr, SocketAddr};

#[tokio::main]
async fn main() {
    let port = match std::env::var("PORT") {
        Err(_) => 3000,
        Ok(v) => v.parse::<u16>().unwrap_or_else(|_| {
            eprintln!("PORT must be a port number, got {v:?}");
            std::process::exit(2)
        }),
    };
    let build_id = std::env::var("BEGHU_BUILD_ID").unwrap_or_else(|_| "dev".into());
    let addr = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("can't listen on {addr}: {e}");
            std::process::exit(1)
        });
    eprintln!("beghu {build_id} listening on http://localhost:{port}");
    tokio::select! {
        r = beghu::serve(listener, beghu::Config::new(build_id)) => {
            if let Err(e) = r {
                eprintln!("server failed: {e}");
                std::process::exit(1);
            }
        }
        _ = shutdown() => eprintln!("shutting down"),
    }
}

async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("a SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
