//! `fake-github serve --fixture <mirror.db> --db <truth.db> [--port 3100] [--control-port 3101]
//!   [--client-id ID] [--client-secret SECRET] [--access-ttl 8h] [--refresh-ttl 184d]
//!   [--webhook-url URL] [--webhook-secret SECRET]`
//!
//! `fake-github pristine-mirrors --fixture <mirror.db> --db <truth.db> --dir <mirrors dir>`
//! writes a pristine mirror for each fixture account that sees every fixture repo, and prints
//! `<login> <path>` for each.
//!
//! Lifetimes take a number of seconds or a suffix: `30s`, `5m`, `8h`, `184d`.

use fake_github::{Config, Fake};
use std::path::PathBuf;
use std::time::Duration;

const USAGE: &str = "usage:
  fake-github serve --fixture FILE --db FILE [--port 3100] [--control-port 3101]
                    [--client-id ID] [--client-secret SECRET] [--access-ttl 8h] [--refresh-ttl 184d]
                    [--webhook-url URL] [--webhook-secret SECRET]
  fake-github pristine-mirrors --fixture FILE --db FILE --dir DIR";

fn fail(msg: &str) -> ! {
    eprintln!("{msg}\n{USAGE}");
    std::process::exit(2)
}

fn duration(s: &str) -> Duration {
    let (n, unit) = match s.find(|c: char| !c.is_ascii_digit()) {
        Some(i) => s.split_at(i),
        None => (s, "s"),
    };
    let n: u64 = n
        .parse()
        .unwrap_or_else(|_| fail(&format!("bad duration {s:?}")));
    let secs = match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86_400,
        _ => fail(&format!("bad duration {s:?}")),
    };
    if secs == 0 {
        fail("lifetimes are at least 1 second");
    }
    Duration::from_secs(secs)
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| fail("no command"));
    let mut fixture = None;
    let mut db = None;
    let mut dir = None;
    let mut port: u16 = 3100;
    let mut control_port: u16 = 3101;
    let mut client_id = "Iv1.fakegithub".to_owned();
    let mut client_secret = "fake-github-secret".to_owned();
    let mut access_ttl = fake_github::ACCESS_TTL;
    let mut refresh_ttl = fake_github::REFRESH_TTL;
    let mut webhook_url = None;
    let mut webhook_secret = "fake-github-webhook-secret".to_owned();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .unwrap_or_else(|| fail(&format!("{flag} needs a value")));
        let port_of = |v: &str| {
            v.parse()
                .unwrap_or_else(|_| fail(&format!("bad port {v:?}")))
        };
        match flag.as_str() {
            "--fixture" => fixture = Some(PathBuf::from(value)),
            "--db" => db = Some(PathBuf::from(value)),
            "--dir" => dir = Some(PathBuf::from(value)),
            "--port" => port = port_of(&value),
            "--control-port" => control_port = port_of(&value),
            "--client-id" => client_id = value,
            "--client-secret" => client_secret = value,
            "--access-ttl" => access_ttl = duration(&value),
            "--refresh-ttl" => refresh_ttl = duration(&value),
            "--webhook-url" => webhook_url = Some(value),
            "--webhook-secret" => webhook_secret = value,
            _ => fail(&format!("unknown flag {flag}")),
        }
    }
    let fixture = fixture.unwrap_or_else(|| fail("--fixture is required"));
    let db = db.unwrap_or_else(|| fail("--db is required"));
    match cmd.as_str() {
        "serve" => {
            let cfg = Config {
                fixture,
                db,
                client_id,
                client_secret,
                access_ttl,
                refresh_ttl,
                webhook_url,
                webhook_secret,
            };
            let fake = tokio::task::spawn_blocking(move || Fake::open(cfg))
                .await
                .expect("opening the truth")
                .unwrap_or_else(|e| {
                    eprintln!("can't open the truth: {e}");
                    std::process::exit(1)
                });
            let bind = |p: u16| async move {
                tokio::net::TcpListener::bind(("127.0.0.1", p))
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("can't listen on 127.0.0.1:{p}: {e}");
                        std::process::exit(1)
                    })
            };
            let (api, ctl) = (bind(port).await, bind(control_port).await);
            eprintln!(
                "fake-github listening on http://127.0.0.1:{port} (control http://127.0.0.1:{control_port})"
            );
            tokio::select! {
                r = fake.serve(api, ctl) => if let Err(e) = r {
                    eprintln!("fake-github failed: {e}");
                    std::process::exit(1);
                },
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm() => {}
            }
        }
        "pristine-mirrors" => {
            let dir = dir.unwrap_or_else(|| fail("--dir is required"));
            match fake_github::pristine_mirrors(&fixture, &db, &dir).await {
                Ok(written) => {
                    for (login, path) in written {
                        println!("{login} {}", path.display());
                    }
                }
                Err(e) => {
                    eprintln!("can't write pristine mirrors: {e}");
                    std::process::exit(1)
                }
            }
        }
        _ => fail(&format!("unknown command {cmd}")),
    }
}

async fn sigterm() {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut s) => {
            s.recv().await;
        }
        Err(_) => std::future::pending().await,
    }
}
