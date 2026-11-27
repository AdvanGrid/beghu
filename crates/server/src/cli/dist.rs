//! Each deployment serves its own CLI, built from the same commit as the server:
//!
//! - `/cli/{os}-{arch}/beghu`: the binary, for `linux-x86_64`, `linux-aarch64` (static musl),
//!   `macos-aarch64` and `macos-x86_64`, from `BEGHU_CLI_DIR` (the image's `/app/cli`, written by
//!   its `cli` stage);
//! - `/cli/manifest.json`: the CLI's version, this server's build, and each binary's SHA-256 and
//!   size, which `beghu update` checks its download against;
//! - `/cli/install.sh`: `curl -fsSL https://{host}/cli/install.sh | sh` installs the binary for
//!   the machine to `~/.local/bin` (or `$BEGHU_INSTALL_DIR`), checked against the same SHA-256s,
//!   written into it.
//!
//! The binaries are hashed once, at startup. None of these answers depend on who asks; each is
//! `no-cache`, since a deploy changes them under the same URL.

use super::CliVersion;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// The platforms the image builds, as `{os}-{arch}` (Rust's `std::env::consts` names).
pub const PLATFORMS: [&str; 4] = [
    "linux-x86_64",
    "linux-aarch64",
    "macos-aarch64",
    "macos-x86_64",
];

const INSTALL_SH: &str = include_str!("install.sh");

/// The CLI builds a deployment serves.
pub struct Builds {
    pub version: CliVersion,
    /// Each platform's binary, as served.
    pub binaries: Vec<(&'static str, PathBuf)>,
    manifest: String,
    install: String,
}

/// One binary, as `manifest.json` lists it.
#[derive(Serialize)]
struct Binary {
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Serialize)]
struct Manifest {
    version: String,
    build: String,
    binaries: BTreeMap<&'static str, Binary>,
}

impl Builds {
    /// Reads `dir`: `version` and each platform's `<platform>/beghu`, hashing them. No
    /// `version`, an unreadable one, or no binary at all is an error that should stop startup.
    /// Blocking: hashing reads every binary.
    pub fn load(dir: &Path, build: &str, host: &str) -> Result<Builds, String> {
        let path = dir.join("version");
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("BEGHU_CLI_DIR: can't read {}: {e}", path.display()))?;
        let version = CliVersion::parse(&raw).ok_or_else(|| {
            format!(
                "BEGHU_CLI_DIR: {} isn't a semver: {:?}",
                path.display(),
                raw.trim()
            )
        })?;
        let mut binaries = Vec::new();
        let mut listed = BTreeMap::new();
        for p in PLATFORMS {
            let file = dir.join(p).join("beghu");
            if !file.exists() {
                continue;
            }
            let (sha256, size) = hash(&file)?;
            listed.insert(
                p,
                Binary {
                    url: format!("/cli/{p}/beghu"),
                    sha256,
                    size,
                },
            );
            binaries.push((p, file));
        }
        if binaries.is_empty() {
            return Err(format!(
                "BEGHU_CLI_DIR: {} holds no <os>-<arch>/beghu ({})",
                dir.display(),
                PLATFORMS.join(", ")
            ));
        }
        let cases: String = listed
            .iter()
            .map(|(p, b)| format!("  {p}) want={} ;;\n", b.sha256))
            .collect();
        let manifest = serde_json::to_string_pretty(&Manifest {
            version: version.to_string(),
            build: build.to_owned(),
            binaries: listed,
        })
        .expect("plain data");
        let install = script(host, &version.to_string(), build, cases.trim_end());
        Ok(Builds {
            version,
            binaries,
            manifest,
            install,
        })
    }
}

/// `install.sh`, for this host and its builds.
fn script(host: &str, version: &str, build: &str, cases: &str) -> String {
    let login = if host == super::DEFAULT_HOST {
        String::new()
    } else {
        format!(" --host {host}")
    };
    INSTALL_SH
        .replace("@HOST@", host)
        .replace("@VERSION@", version)
        .replace("@BUILD@", build)
        .replace("@LOGIN_HOST@", &login)
        .replace("@SHA256S@", cases)
}

/// A file's SHA-256 (hex) and size.
fn hash(path: &Path) -> Result<(String, u64), String> {
    let failed = crate::io_failed("read", path);
    let mut f = std::fs::File::open(path).map_err(&failed)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(&failed)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        size += n as u64;
    }
    let hex = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((hex, size))
}

fn no_cache(content_type: &'static str, body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        body,
    )
        .into_response()
}

/// Without `BEGHU_CLI_DIR`, every `/cli/` download is this.
fn none() -> Response {
    (
        StatusCode::NOT_FOUND,
        "This beghu serves no CLI builds (BEGHU_CLI_DIR isn't set).\n",
    )
        .into_response()
}

/// `GET /cli/manifest.json`.
pub fn manifest(builds: Option<&Builds>) -> Response {
    match builds {
        Some(b) => no_cache("application/json", b.manifest.clone()),
        None => none(),
    }
}

/// `GET /cli/install.sh`.
pub fn install(builds: Option<&Builds>) -> Response {
    match builds {
        Some(b) => no_cache("text/x-shellscript; charset=utf-8", b.install.clone()),
        None => none(),
    }
}

/// A binary's answer gets `no-cache` (its URL serves the next deploy's build too) and a name to
/// save it as.
pub async fn binary_headers(mut res: Response) -> Response {
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        let h = res.headers_mut();
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        h.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"beghu\""),
        );
    }
    res
}
