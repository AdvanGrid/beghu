//! Hashes everything that decides a fixture's bytes: this crate's source, mirror-db's
//! migrations and queries, and the planner's statistics (dbrt's `PRAGMA optimize` mask in its
//! pool, and the indexes mirror-db's lib has sampled in full). The hash names cached fixture
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
        here.join("../../crates/dbrt/src/pool.rs"),
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
