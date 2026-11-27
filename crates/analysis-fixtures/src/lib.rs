//! The PR view's committed analyses, in `fixtures/pr-view/`:
//!
//! - **Recordings** (`beghu-<n>/pr-v1.json`, `analysis-v1.json`, and `-v2` once recorded): a real
//!   agent's analysis of beghu's own PR, saved by [`record`] from the `analyses.db` that accepted
//!   it: the run's pinned `pr.json` and the upload's body, both byte for byte. Never hand-edited,
//!   never rewritten: a recording keeps the schema version it was written in, and every reader
//!   migrates it.
//! - **Cases** (`cases/<feature>.json`): small hand-written analyses of the same PR at v1's head,
//!   each for a feature the recordings lack (the coverage test, `tests/coverage.rs`). A case for
//!   a feature only a later analysis has (`carried`, "Since the last analysis") is named
//!   `cases/<feature>.after-v1.json`: it's of the PR at v2's head (v2's `pr.json`), as a later
//!   analysis is of a later push, and it's checked, and uploaded, as a later analysis after v1,
//!   its `carried` naming v1's IDs.
//!
//! [`GitReader`] reads the analysed commits out of a git repo by SHA, for the full validator's
//! snippet check in CI (`analysis-fixtures check`).

use analysis::{CodeSide, Context, EntryKind, PinnedPr, Previous, PreviousIds, Reader, Vocabulary};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `fixtures/pr-view/`.
pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pr-view")
}

/// The suffix of a case that is a later analysis after v1: `cases/<feature>.after-v1.json`.
pub const AFTER_V1: &str = ".after-v1";

/// One committed analysis and the `pr.json` its run pinned (a case's is v1's, an `.after-v1`
/// case's v2's).
#[derive(Debug, Clone)]
pub struct Committed {
    /// `beghu-191/analysis-v1.json`, `cases/rule-breaks.json`: relative to [`dir`].
    pub name: String,
    pub analysis: PathBuf,
    pub pr: PathBuf,
    /// The analysis this one is uploaded after, whose IDs its `carried` names: v1's, for v2 and
    /// for a case named `<feature>.after-v1.json`. `None` for a first analysis.
    pub previous: Option<PathBuf>,
}

impl Committed {
    /// What this analysis's `carried` is checked against, as the server checks a later upload:
    /// the IDs and vocabulary of the one it follows, migrated, or none for a first analysis.
    pub fn previous_ids(&self) -> Result<Previous, String> {
        let Some(path) = &self.previous else {
            return Ok(Previous::None);
        };
        let ctx = Context {
            changed_files: None,
            previous: Previous::Unknown,
        };
        let a = analysis::validate(&read(path), &ctx, None)
            .analysis
            .ok_or_else(|| format!("{} doesn't pass the shape check", path.display()))?;
        Ok(Previous::Some {
            ids: PreviousIds::of(&a),
            vocabulary: Vocabulary::of(&a),
        })
    }

    /// What a case is filed under: its file's name without `.json` or `.after-v1`.
    pub fn feature(&self) -> Option<&str> {
        let stem = self.name.strip_prefix("cases/")?.strip_suffix(".json")?;
        Some(stem.strip_suffix(AFTER_V1).unwrap_or(stem))
    }
}

impl Committed {
    pub fn analysis_text(&self) -> String {
        read(&self.analysis)
    }

    pub fn pinned(&self) -> PinnedPr {
        serde_json::from_str(&read(&self.pr))
            .unwrap_or_else(|e| panic!("{}: {e}", self.pr.display()))
    }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// The recorded PR's folder (`beghu-<n>`), and the versions recorded in it (1, then 2).
pub fn recordings() -> Vec<(u32, Vec<u32>)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir()).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(n) = name.strip_prefix("beghu-").and_then(|n| n.parse().ok()) else {
            continue;
        };
        let versions = (1..=2)
            .filter(|v| e.path().join(format!("analysis-v{v}.json")).exists())
            .collect();
        out.push((n, versions));
    }
    out.sort();
    out
}

/// Every committed recording and case, recordings first.
pub fn committed() -> Vec<Committed> {
    let mut out = Vec::new();
    let (mut v1_pr, mut v2_pr) = (None, None);
    for (n, versions) in recordings() {
        for v in versions {
            let folder = dir().join(format!("beghu-{n}"));
            let pr = folder.join(format!("pr-v{v}.json"));
            if v == 1 {
                v1_pr.get_or_insert(pr.clone());
            } else {
                v2_pr.get_or_insert(pr.clone());
            }
            out.push(Committed {
                name: format!("beghu-{n}/analysis-v{v}.json"),
                analysis: folder.join(format!("analysis-v{v}.json")),
                pr,
                previous: (v == 2).then(|| folder.join("analysis-v1.json")),
            });
        }
    }
    let mut cases: Vec<PathBuf> = std::fs::read_dir(dir().join("cases"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    cases.sort();
    for c in cases {
        let v1: PathBuf = v1_pr.clone().expect("cases are of the recorded PR at v1");
        let name = format!("cases/{}", c.file_name().unwrap().to_string_lossy());
        let after = name.ends_with(&format!("{AFTER_V1}.json"));
        let pr = if after {
            v2_pr
                .clone()
                .unwrap_or_else(|| panic!("{name} is at v2's head, and v2 isn't recorded"))
        } else {
            v1.clone()
        };
        let previous = after.then(|| v1.with_file_name("analysis-v1.json"));
        out.push(Committed {
            name,
            analysis: c,
            pr,
            previous,
        });
    }
    out
}

/// The repo whose PR the recordings are of: beghu's own.
pub const RECORDED_REPO: &str = "AdvanGrid/beghu";

/// What [`record`] found: the run's pinned `pr.json` and the accepted upload, both as stored.
pub struct Recorded {
    pub pr: String,
    pub analysis: String,
    pub head_sha: String,
    pub number: i64,
}

/// The run `run`'s pinned `pr.json` and the upload it made, from the `analyses.db` at `db` (`run`
/// may be the run's ID or the accepted analysis's, which the server's log names). The file is
/// read through SQLite's online backup ([`analysis_db::snapshot`]), so a live server's file and
/// a read-only copy (but one with a WAL left over) are both read and left alone. Only a run on the recorded PR's repo,
/// `AdvanGrid/beghu`, is a recording: any other is refused.
pub fn record(db: &Path, run: &str) -> Result<Recorded, String> {
    let conn = analysis_db::snapshot(db).map_err(|e| format!("{}: {e}", db.display()))?;
    let an = analysis_db::q::recorded_analysis(&conn, run)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!("no accepted analysis of run {run} in {} that's still its PR's (none was accepted, or a later run's replaced it)", db.display())
        })?;
    let row = analysis_db::q::run(&conn, &an.run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("analysis {} names run {}, which is gone", an.id, an.run_id))?;
    let repo = format!("{}/{}", row.owner, row.name);
    if !repo.eq_ignore_ascii_case(RECORDED_REPO) {
        return Err(format!(
            "run {} is on {repo}#{}: only a run on {RECORDED_REPO} is recorded (fixtures/pr-view/ holds beghu's own PR)",
            an.run_id, row.number
        ));
    }
    let pr = row
        .pinned
        .ok_or_else(|| format!("run {} never pinned its PR", an.run_id))?;
    let gz = an.upload_gz.ok_or_else(|| {
        format!("analysis {} was stored before beghu kept upload bodies: record it again from a new run", an.id)
    })?;
    let mut text = String::new();
    flate2::read::MultiGzDecoder::new(&gz[..])
        .read_to_string(&mut text)
        .map_err(|e| format!("the stored upload doesn't inflate: {e}"))?;
    Ok(Recorded {
        pr,
        analysis: text,
        head_sha: an.head_sha,
        number: row.number,
    })
}

/// The base and head commits of an analysis, read from the git repo at `repo` by SHA: no
/// checkout. Each side's tree is listed once; each file is read once.
pub struct GitReader {
    repo: PathBuf,
    base: String,
    head: String,
    trees: RefCell<HashMap<CodeSide, Option<Listing>>>,
    files: RefCell<HashMap<(CodeSide, String), Option<String>>>,
}

#[derive(Clone)]
struct Listing {
    files: Vec<String>,
    dirs: HashSet<String>,
}

impl GitReader {
    pub fn new(repo: &Path, base: &str, head: &str) -> GitReader {
        GitReader {
            repo: repo.to_owned(),
            base: base.to_owned(),
            head: head.to_owned(),
            trees: RefCell::default(),
            files: RefCell::default(),
        }
    }

    fn sha(&self, side: CodeSide) -> &str {
        match side {
            CodeSide::Base => &self.base,
            CodeSide::Head => &self.head,
        }
    }

    fn git(&self, args: &[&str]) -> Option<Vec<u8>> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.repo)
            .args(args)
            .output()
            .ok()?;
        out.status.success().then_some(out.stdout)
    }

    fn listing(&self, side: CodeSide) -> Option<Listing> {
        self.trees
            .borrow_mut()
            .entry(side)
            .or_insert_with(|| {
                let out = self.git(&[
                    "ls-tree",
                    "-r",
                    "-t",
                    "-z",
                    "--format=%(objecttype) %(path)",
                    self.sha(side),
                ])?;
                let mut l = Listing {
                    files: Vec::new(),
                    dirs: HashSet::new(),
                };
                for entry in out.split(|&b| b == 0).filter(|e| !e.is_empty()) {
                    let entry = String::from_utf8_lossy(entry);
                    match entry.split_once(' ') {
                        Some(("tree", p)) => {
                            l.dirs.insert(p.to_owned());
                        }
                        Some(("blob", p)) => l.files.push(p.to_owned()),
                        // Submodules (`commit`) are neither.
                        _ => {}
                    }
                }
                Some(l)
            })
            .clone()
    }

    /// Whether `sha` is an ancestor of (or is) `of` in the repo.
    pub fn reachable(repo: &Path, sha: &str, of: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["merge-base", "--is-ancestor", sha, of])
            .status()
            .is_ok_and(|s| s.success())
    }
}

impl Reader for GitReader {
    fn read(&self, side: CodeSide, path: &str) -> Option<String> {
        if let Some(hit) = self.files.borrow().get(&(side, path.to_owned())) {
            return hit.clone();
        }
        let text = self
            .listing(side)
            .filter(|l| l.files.iter().any(|f| f == path))
            .and_then(|_| self.git(&["cat-file", "blob", &format!("{}:{path}", self.sha(side))]))
            .and_then(|b| String::from_utf8(b).ok());
        self.files
            .borrow_mut()
            .insert((side, path.to_owned()), text.clone());
        text
    }

    fn kind(&self, side: CodeSide, path: &str) -> Option<EntryKind> {
        let l = self.listing(side)?;
        if l.dirs.contains(path) {
            Some(EntryKind::Dir)
        } else if l.files.iter().any(|f| f == path) {
            Some(EntryKind::File)
        } else {
            None
        }
    }

    fn tracked(&self, side: CodeSide) -> Option<Vec<String>> {
        self.listing(side).map(|l| l.files)
    }
}
