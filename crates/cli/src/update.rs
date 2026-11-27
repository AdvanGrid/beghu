//! `beghu update`, and the update a `426` makes by itself: download the host's build for this
//! platform (`/cli/{os}-{arch}/beghu`), check its SHA-256 and size against the host's
//! `/cli/manifest.json`, write it to a new file beside this binary and rename it over (atomic:
//! the old one runs on until it exits), then sync the folder. Neither fetch follows a redirect.
//! It installs exactly the host's build, newer or older.

use crate::account::{credentials, host_for};
use crate::http::{self, Api};
use crate::store;
use crate::{Args, Fail};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    binaries: BTreeMap<String, Binary>,
}

#[derive(Deserialize)]
struct Binary {
    url: String,
    sha256: String,
    size: u64,
}

pub enum Installed {
    /// Replaced: `exe` is where (as it was found before the rename).
    Updated {
        from: String,
        to: String,
        exe: PathBuf,
    },
    /// This binary is the host's build already.
    Already { version: String },
}

pub enum Error {
    /// This binary's folder can't be written: it can't replace itself.
    NotWritable(PathBuf),
    Fail(Fail),
}

impl From<Fail> for Error {
    fn from(f: Fail) -> Self {
        Error::Fail(f)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Installs `host`'s build over this binary.
pub async fn install(host: &str) -> Result<Installed, Error> {
    // Before the rename: on Linux the path the kernel gives a replaced binary ends " (deleted)".
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| Fail::msg(format!("can't find this binary's own file: {e}")))?;
    let api = Api::without_redirects(host)?;
    let res = api.get("/cli/manifest.json").await?;
    if res.status != 200 {
        return Err(Fail::msg(format!("{host} serves no CLI builds: {}", res.why())).into());
    }
    let m: Manifest = res.json("the CLI's manifest")?;
    let platform = http::platform();
    let Some(b) = m.binaries.get(&platform) else {
        return Err(Fail::msg(format!(
            "{host} serves no beghu build for {platform} (it has {})",
            m.binaries.keys().cloned().collect::<Vec<_>>().join(", ")
        ))
        .into());
    };
    let mine =
        std::fs::read(&exe).map_err(|e| Fail::msg(format!("can't read {}: {e}", exe.display())))?;
    if hex(&Sha256::digest(&mine)) == b.sha256 {
        return Ok(Installed::Already { version: m.version });
    }
    let (mut f, tmp) = match store::temp_beside(&exe, 0o755) {
        Ok(made) => made,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(Error::NotWritable(exe));
        }
        Err(e) => {
            return Err(Fail::msg(format!("can't write beside {}: {e}", exe.display())).into());
        }
    };
    let done = async {
        let res = api.get(&b.url).await?;
        if res.status != 200 {
            return Err(Fail::msg(format!(
                "{host} didn't serve {}: {}",
                b.url,
                res.why()
            )));
        }
        let got = hex(&Sha256::digest(&res.bytes));
        if res.bytes.len() as u64 != b.size || got != b.sha256 {
            return Err(Fail::msg(format!(
                "the download from {host} isn't the build its manifest names (SHA-256 {got}, not {})",
                b.sha256
            )));
        }
        let failed = |e: std::io::Error| Fail::msg(format!("can't write {}: {e}", tmp.display()));
        f.write_all(&res.bytes).map_err(failed)?;
        f.sync_all().map_err(failed)?;
        store::rename_durably(&tmp, &exe).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                Fail::msg(format!("can't replace {}: {e}", exe.display()))
            }
            _ => failed(e),
        })
    }
    .await;
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(Installed::Updated {
        from: http::VERSION.to_owned(),
        to: m.version,
        exe,
    })
}

/// `beghu update [--host URL]`.
pub async fn command(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--host"], &[])?;
    let (_, c) = credentials()?;
    let host = host_for(a.opt("--host"), &c)?;
    match install(&host).await {
        Ok(Installed::Updated { from, to, .. }) => {
            println!("updated beghu {from} \u{2192} {to} from {host}");
            Ok(())
        }
        Ok(Installed::Already { version }) => {
            println!("beghu {version} is {host}'s build already");
            Ok(())
        }
        Err(Error::NotWritable(p)) => Err(Fail::msg(format!(
            "can't replace {} (its folder isn't writable): reinstall with `curl -fsSL {host}/cli/install.sh | sh`",
            p.display()
        ))),
        Err(Error::Fail(f)) => Err(f),
    }
}
