//! `pr-fixtures`: the PR view's fixture PRs, for `./dev-ctl` and the perf harness, which drive a
//! stack over HTTP and need what the fixture knows.
//!
//! ```text
//! pr-fixtures versions
//!     Every recorded version and tile, as JSON: [{name, repo, number, version?, headSha,
//!     analysis, pr}] (paths), the tiles written first into --out (default perf/data).
//! pr-fixtures moves NUMBER FROM TO
//!     The Fake GitHub control calls that move recorded PR NUMBER from version FROM's state to
//!     TO's, as JSON: [{path, body}].
//! pr-fixtures tile [--out DIR]
//!     Writes the tiles (if this generator hasn't) and prints their paths.
//! pr-fixtures layout
//!     Writes the layout suite's graphs (each tile's drawable graph) into
//!     fixtures/pr-view/layout/, to commit: the tiler's test fails while they differ.
//! ```

use fixture::{recorded, tile};
use serde_json::{Value, json};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../data")));
    match args.first().map(String::as_str) {
        Some("versions") => {
            let mut all: Vec<Value> = recorded::versions()
                .iter()
                .map(|v| {
                    json!({
                        "name": v.version.to_string(),
                        "repo": recorded::REPO,
                        "number": v.number,
                        "version": v.version,
                        "headSha": v.head_sha(),
                        "analysis": recorded::analysis_path(v.number, v.version),
                        "pr": recorded::dir().join(format!("beghu-{}/pr-v{}.json", v.number, v.version)),
                    })
                })
                .collect();
            for (name, number, analysis, pr) in tiles(&out) {
                let head = serde_json::from_str::<Value>(&std::fs::read_to_string(&pr).unwrap())
                    .unwrap()["headSha"]
                    .clone();
                all.push(json!({
                    "name": name, "repo": recorded::REPO, "number": number, "headSha": head,
                    "analysis": analysis, "pr": pr,
                }));
            }
            println!("{}", Value::Array(all));
        }
        Some("moves") => {
            let n = |i: usize| -> u32 {
                args.get(i)
                    .and_then(|a| a.parse().ok())
                    .unwrap_or_else(|| fail("usage: pr-fixtures moves NUMBER FROM TO"))
            };
            let (number, from, to) = (n(1), n(2), n(3));
            let v = |version| {
                recorded::version(number, version)
                    .unwrap_or_else(|| fail(&format!("#{number} v{version} isn't recorded")))
            };
            let calls: Vec<Value> = recorded::moves(&v(from), &v(to))
                .into_iter()
                .map(|(path, body)| json!({ "path": path, "body": body }))
                .collect();
            println!("{}", Value::Array(calls));
        }
        Some("tile") => {
            for (name, number, analysis, pr) in tiles(&out) {
                println!("{name} #{number}: {} {}", analysis.display(), pr.display());
            }
        }
        Some("layout") => {
            let dir = tile::layout_dir();
            std::fs::create_dir_all(&dir)
                .unwrap_or_else(|e| fail(&format!("{}: {e}", dir.display())));
            for (name, text) in
                tile::layout_graphs().unwrap_or_else(|e| fail(&format!("tiling: {e}")))
            {
                let path = dir.join(name);
                std::fs::write(&path, text)
                    .unwrap_or_else(|e| fail(&format!("{}: {e}", path.display())));
                println!("{}", path.display());
            }
        }
        _ => fail("usage: pr-fixtures versions|moves NUMBER FROM TO|tile [--out DIR]|layout"),
    }
}

fn tiles(out: &std::path::Path) -> Vec<(&'static str, i64, PathBuf, PathBuf)> {
    tile::cached(out).unwrap_or_else(|e| fail(&format!("tiling: {e}")))
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}
