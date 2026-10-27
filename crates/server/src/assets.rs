//! The web build's hashed assets, kept on the volume so a tab still running the previous build
//! can load the chunks it hasn't yet.
//!
//! At startup the build's `assets/` (with their `.br` and `.gz` siblings) are copied to
//! `BEGHU_DATA_DIR/assets/`, skipping files already there whole (a hashed name is its content;
//! one that differs, cut short by a full disk, is written again), and the build's file list goes
//! to `BEGHU_DATA_DIR/builds/<build id>.json`, merged with the list already there if the id was
//! deployed before (another image under the same id: its tabs still load the first one's
//! chunks). Any other build still current is marked superseded now. `/assets/*` is served from
//! the volume, so an old build's files outlive its image.
//!
//! Pruning runs at startup and whenever a superseded build's time is up: a build superseded more
//! than [`Config::assets_kept_for`] ago (a day) is dropped, then every file no remaining build
//! lists is deleted.
//!
//! [`Config::assets_kept_for`]: crate::Config::assets_kept_for

use crate::io_failed as failed;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One build's record in `builds/`.
#[derive(Serialize, Deserialize)]
struct Build {
    /// Its files under `assets/`, siblings included.
    files: BTreeSet<String>,
    /// When a later build replaced it (Unix seconds); `None` while it's the one running.
    superseded_at: Option<i64>,
}

/// The volume's assets and build records.
#[derive(Clone)]
pub struct Assets {
    /// `BEGHU_DATA_DIR/assets`: what `/assets/*` serves.
    pub dir: PathBuf,
    builds: PathBuf,
    kept_for: Duration,
}

impl Assets {
    pub fn new(data_dir: &Path, kept_for: Duration) -> Assets {
        Assets {
            dir: data_dir.join("assets"),
            builds: data_dir.join("builds"),
            kept_for,
        }
    }

    /// Copies the build in `web_dir` to the volume as `build`, the one now running, marks the
    /// others superseded, and prunes; when the next prune is due, as [`Assets::prune`] says.
    /// Blocks. An error should stop startup.
    pub fn install(&self, web_dir: &Path, build: &str, now: i64) -> Result<Option<i64>, String> {
        let src = web_dir.join("assets");
        let mut files = BTreeSet::new();
        if src.exists() {
            walk(&src, &mut |rel, from| {
                copy_whole(from, &self.dir.join(rel))?;
                files.insert(rel.to_owned());
                Ok(())
            })?;
        }
        mkdir(&self.builds)?;
        for (id, mut b) in self.records()? {
            if id == build {
                files.extend(b.files);
            } else if b.superseded_at.is_none() {
                b.superseded_at = Some(now);
                self.write(&id, &b)?;
            }
        }
        self.write(
            build,
            &Build {
                files,
                superseded_at: None,
            },
        )?;
        self.prune(now)
    }

    /// Drops the builds superseded more than `kept_for` before `now` and deletes the files no
    /// remaining build lists. When the next build's time is up (Unix seconds), if one is
    /// superseded.
    pub fn prune(&self, now: i64) -> Result<Option<i64>, String> {
        let kept = self.kept_for.as_secs() as i64;
        let mut listed = BTreeSet::new();
        let mut next = None::<i64>;
        for (id, b) in self.records()? {
            match b.superseded_at {
                Some(at) if at + kept <= now => {
                    let path = self.record(&id);
                    std::fs::remove_file(&path).map_err(failed("delete", &path))?;
                }
                at => {
                    if let Some(at) = at {
                        next = Some(next.map_or(at + kept, |n| n.min(at + kept)));
                    }
                    listed.extend(b.files);
                }
            }
        }
        let mut present = BTreeSet::new();
        if self.dir.exists() {
            walk(&self.dir, &mut |rel, _| {
                present.insert(rel.to_owned());
                Ok(())
            })?;
        }
        for f in present.difference(&listed) {
            let path = self.dir.join(f);
            std::fs::remove_file(&path).map_err(failed("delete", &path))?;
        }
        Ok(next)
    }

    fn record(&self, id: &str) -> PathBuf {
        self.builds.join(format!("{id}.json"))
    }

    /// Every build record, by build id.
    fn records(&self) -> Result<Vec<(String, Build)>, String> {
        let list = failed("list", &self.builds);
        let entries = std::fs::read_dir(&self.builds).map_err(&list)?;
        let mut out = Vec::new();
        for e in entries {
            let e = e.map_err(&list)?;
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            let raw = std::fs::read_to_string(e.path()).map_err(failed("read", &e.path()))?;
            let b = serde_json::from_str(&raw)
                .map_err(|err| format!("{} isn't a build record: {err}", e.path().display()))?;
            out.push((id.to_owned(), b));
        }
        Ok(out)
    }

    /// Writes a build's record whole or not at all.
    fn write(&self, id: &str, b: &Build) -> Result<(), String> {
        let path = self.record(id);
        let json = serde_json::to_vec_pretty(b).map_err(|e| e.to_string())?;
        write_whole(&path, &json)
    }
}

/// How long after a failed prune the next is tried.
const RETRY_PRUNE_AFTER: i64 = 60 * 60;

/// Prunes whenever a superseded build's time is up, until the drain stops it. Each start prunes
/// in [`Assets::install`], and only a start supersedes a build, so with none superseded there's
/// nothing to wait for.
pub async fn job(assets: Assets, mut next: Option<i64>) {
    while let Some(at) = next {
        let wait = (at - crate::now()).max(0) as u64;
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let a = assets.clone();
        next = match tokio::task::spawn_blocking(move || a.prune(crate::now())).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                eprintln!("assets: pruning: {e}");
                Some(crate::now() + RETRY_PRUNE_AFTER)
            }
            Err(_) => Some(crate::now() + RETRY_PRUNE_AFTER),
        };
    }
}

/// Calls `f` with every file under `dir`: its path relative to `dir` (`/`-separated) and its
/// full path.
fn walk(dir: &Path, f: &mut impl FnMut(&str, &Path) -> Result<(), String>) -> Result<(), String> {
    fn go(
        dir: &Path,
        prefix: &str,
        f: &mut impl FnMut(&str, &Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let list = failed("list", dir);
        for e in std::fs::read_dir(dir).map_err(&list)? {
            let e = e.map_err(&list)?;
            let rel = format!("{prefix}{}", e.file_name().to_string_lossy());
            if e.file_type().map_err(&list)?.is_dir() {
                go(&e.path(), &format!("{rel}/"), f)?;
            } else {
                f(&rel, &e.path())?;
            }
        }
        Ok(())
    }
    go(dir, "", f)
}

/// Copies `from` to `to` unless `to` already holds the same bytes.
fn copy_whole(from: &Path, to: &Path) -> Result<(), String> {
    let bytes = std::fs::read(from).map_err(failed("read", from))?;
    if std::fs::read(to).is_ok_and(|there| there == bytes) {
        return Ok(());
    }
    if let Some(dir) = to.parent() {
        mkdir(dir)?;
    }
    write_whole(to, &bytes)
}

fn mkdir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(failed("create", dir))
}

/// Writes `bytes` to `path` whole or not at all, even across a power cut.
fn write_whole(path: &Path, bytes: &[u8]) -> Result<(), String> {
    dbrt::copy::write_whole(path, |tmp| std::fs::write(tmp, bytes)).map_err(failed("write", path))
}
