//! Hashes everything that decides a fixture's bytes: this crate's source, mirror-db's
//! migrations and queries, the PR view's committed analyses (`fixtures/pr-view/`: the recorded
//! PR's `pr-v*.json` make the `AdvanGrid/beghu` repo, and the tiler reads the analyses), the
//! analysis crate (the tiler migrates and checks through it), and the planner's statistics (dbrt's `PRAGMA optimize` mask in
//! `dbrt/src/stats.rs`, and the indexes mirror-db's lib has sampled in full). Keep the list in
//! step with the fixture cache key in `.github/workflows/perf.yml`. The hash names cached fixture
//! files, so changing any of them regenerates the fixture.

use std::path::{Path, PathBuf};

fn main() {
    let here = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mirror = here.join("../../crates/mirror-db");
    let inputs = [
        here.join("src"),
        here.join("Cargo.toml"),
        mirror.join("migrations"),
        mirror.join("queries"),
        mirror.join("src/lib.rs"),
        here.join("../../crates/dbrt/src/stats.rs"),
        here.join("../../fixtures/pr-view"),
        here.join("../../crates/analysis/src"),
        here.join("../../crates/analysis/Cargo.toml"),
    ];
    let mut files = Vec::new();
    for p in &inputs {
        println!("cargo::rerun-if-changed={}", p.display());
        collect(p, &mut files);
    }
    files.sort();
    // FNV-1a, 64-bit: stable across Rust versions, unlike `DefaultHasher`.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for f in &files {
        let rel = f
            .strip_prefix(here.join("../.."))
            .unwrap_or(f)
            .to_string_lossy()
            .into_owned();
        for b in rel
            .bytes()
            .chain([0])
            .chain(std::fs::read(f).unwrap())
            .chain([0])
        {
            h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    println!("cargo::rustc-env=FIXTURE_GENERATOR_HASH={:012x}", h >> 16);
    recorded(&here.join("../../fixtures/pr-view"));
}

/// `$OUT_DIR/recorded.rs`: every recorded PR's `pr-v*.json`, embedded, as
/// `[(number, version, text)]`. A version not recorded yet (v2, before the owner records it) is
/// simply absent.
fn recorded(dir: &Path) {
    let mut found = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(n) = name
            .strip_prefix("beghu-")
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        for v in 1..=2u32 {
            let p = e.path().join(format!("pr-v{v}.json"));
            if p.exists() {
                found.push((n, v, p.canonicalize().unwrap()));
            }
        }
    }
    found.sort();
    let mut out = String::from("&[\n");
    for (n, v, p) in found {
        out.push_str(&format!(
            "    ({n}, {v}, include_str!({:?})),\n",
            p.display().to_string()
        ));
    }
    out.push_str("]\n");
    let dest = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("recorded.rs");
    std::fs::write(dest, out).unwrap();
}

fn collect(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_dir() {
        for e in std::fs::read_dir(p).unwrap() {
            collect(&e.unwrap().path(), out);
        }
    } else if p.is_file() {
        out.push(p.to_path_buf());
    }
}
