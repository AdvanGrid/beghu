//! `cargo run --release -p fixture -- [--scale 1k|20k|50k|all] [--out DIR]`
//!
//! Prints the path of each fixture mirror, generating it only if this generator hasn't already.

use fixture::{Scale, cached};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let mut scales = vec![Scale::K20];
    let mut out = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../data"));
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match (a.as_str(), args.next()) {
            ("--scale", Some(s)) if s == "all" => scales = Scale::ALL.to_vec(),
            ("--scale", Some(s)) => {
                scales = vec![Scale::parse(&s).unwrap_or_else(|| {
                    fail(&format!("unknown scale {s:?}; use 1k, 20k, 50k or all"))
                })]
            }
            ("--out", Some(d)) => out = PathBuf::from(d),
            _ => fail("usage: fixture [--scale 1k|20k|50k|all] [--out DIR]"),
        }
    }
    for scale in scales {
        let started = Instant::now();
        match cached(scale, &out) {
            Ok(path) => {
                eprintln!(
                    "{}: ready in {:.1} s",
                    scale.name(),
                    started.elapsed().as_secs_f32()
                );
                println!("{}", path.display());
            }
            Err(e) => fail(&format!("{}: {e}", scale.name())),
        }
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}
