//! The PR view's recorded PR (`fixtures/pr-view/beghu-<n>/`): beghu's own PR, analysed by a real
//! agent at two heads (v1, then v2 once the owner records it). Every scale of the fixture holds
//! it in an `AdvanGrid/beghu` repo of its own installation, at its real number, with the issues
//! its description links at theirs: nothing renamed, so the analysis stays byte for byte what the
//! agent wrote. Fake GitHub serves the PR at v1's head, with v1's files and base; its `/push`
//! control call moves it to v2's.
//!
//! The same repo holds the tiler's two synthetic PRs ([`TILED`]), numbered above the real ones.

use serde_json::Value;

/// Each recorded `pr.json`, as the run pinned it: `(number, version, text)`.
const RECORDED: &[(u32, u32, &str)] = include!(concat!(env!("OUT_DIR"), "/recorded.rs"));

pub const OWNER: &str = "AdvanGrid";
pub const NAME: &str = "beghu";
/// `AdvanGrid/beghu`.
pub const REPO: &str = "AdvanGrid/beghu";
/// Past the org's repos, the twin repo's (+50) and the private one's (+60).
pub const REPO_ID: i64 = crate::FIRST_REPO_ID + 70;
/// Its own installation, as the twin repo has (that one is the org's + 1).
pub const INSTALLATION_ID: i64 = crate::ORG_INSTALLATION_ID + 2;

/// The tiler's synthetic PRs, `(number, version name)`: the recorded analysis tiled to #2627's
/// shape and to three times that, for the perf gates. Numbered above every real one.
pub const TILED: [(i64, &str); 2] = [(9_001, "tiled-1x"), (9_003, "tiled-3x")];

/// A recorded PR at one version: its pinned `pr.json`.
#[derive(Debug, Clone)]
pub struct Version {
    pub number: u32,
    pub version: u32,
    /// The text as committed, byte for byte.
    pub text: &'static str,
    pub pr: Value,
}

impl Version {
    pub fn head_sha(&self) -> &str {
        self.pr["headSha"].as_str().unwrap_or_default()
    }

    pub fn base_sha(&self) -> &str {
        self.pr["base"]["sha"].as_str().unwrap_or_default()
    }

    /// Its changed files: `(path, previous path, status, additions, deletions)`.
    pub fn files(&self) -> Vec<(String, Option<String>, String, i64, i64)> {
        self.pr["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| {
                (
                    f["path"].as_str().unwrap_or_default().to_owned(),
                    f["previousPath"].as_str().map(str::to_owned),
                    f["status"].as_str().unwrap_or_default().to_owned(),
                    f["additions"].as_i64().unwrap_or(0),
                    f["deletions"].as_i64().unwrap_or(0),
                )
            })
            .collect()
    }
}

/// Every recorded version, in (number, version) order.
pub fn versions() -> Vec<Version> {
    RECORDED
        .iter()
        .map(|&(number, version, text)| Version {
            number,
            version,
            text,
            pr: serde_json::from_str(text)
                .unwrap_or_else(|e| panic!("beghu-{number}/pr-v{version}.json: {e}")),
        })
        .collect()
}

/// The recorded PR's version `version`, when it's recorded.
pub fn version(number: u32, version: u32) -> Option<Version> {
    versions()
        .into_iter()
        .find(|v| v.number == number && v.version == version)
}

/// `fixtures/pr-view/`.
pub fn dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pr-view")
}

/// The committed analysis of recorded PR `number` at `version`, when it's recorded.
pub fn analysis_path(number: u32, version: u32) -> Option<std::path::PathBuf> {
    let p = dir().join(format!("beghu-{number}/analysis-v{version}.json"));
    p.exists().then_some(p)
}

/// The Fake GitHub control calls (`(path, body)`, in order) that take the recorded PR from
/// `from`'s state to `to`'s, as GitHub got there: outside edits for the PR's and its linked
/// issues' titles and descriptions that differ, a comment for each one `to`'s thread has and
/// `from`'s doesn't, then a push to `to`'s head with its files and base (a force push when going
/// back). An issue `from` doesn't serve is as the fixture made it: from the first version that
/// serves it. Nothing when the two are the same version.
pub fn moves(from: &Version, to: &Version) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    if from.number != to.number || from.version == to.version {
        return out;
    }
    let all = versions();
    let number = i64::from(to.number);
    let changed =
        |was: &Value, now: &Value, key: &str| (was[key] != now[key]).then(|| now[key].clone());
    let mut pr = serde_json::Map::new();
    if let Some(t) = changed(&from.pr, &to.pr, "title") {
        pr.insert("title".into(), t);
    }
    if let Some(b) = changed(&from.pr, &to.pr, "body") {
        pr.insert("body".into(), b);
    }
    if !pr.is_empty() {
        pr.insert("repo".into(), REPO.into());
        pr.insert("number".into(), number.into());
        out.push(("/edit", Value::Object(pr)));
    }
    let issue = |v: &Version, n: &Value| {
        v.pr["issues"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| {
                &i["number"] == n
                    && i["repo"]
                        .as_str()
                        .is_some_and(|r| r.eq_ignore_ascii_case(REPO))
            })
            .cloned()
    };
    for now in to.pr["issues"].as_array().into_iter().flatten() {
        if !now["repo"]
            .as_str()
            .is_some_and(|r| r.eq_ignore_ascii_case(REPO))
        {
            continue;
        }
        let n = &now["number"];
        let Some(was) = issue(from, n).or_else(|| all.iter().find_map(|v| issue(v, n))) else {
            continue;
        };
        let mut edit = serde_json::Map::new();
        for key in ["title", "body"] {
            if let Some(x) = changed(&was, now, key) {
                edit.insert(key.into(), x);
            }
        }
        if !edit.is_empty() {
            edit.insert("repo".into(), REPO.into());
            edit.insert("number".into(), n.clone());
            out.push(("/edit", Value::Object(edit)));
        }
        let had: Vec<&Value> = was["comments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| &c["body"])
            .collect();
        for c in now["comments"].as_array().into_iter().flatten() {
            if !had.contains(&&c["body"]) {
                out.push((
                    "/edit",
                    serde_json::json!({ "repo": REPO, "number": n, "comment": c["body"] }),
                ));
            }
        }
    }
    if from.head_sha() != to.head_sha() {
        let files: Vec<Value> = to
            .files()
            .into_iter()
            .map(|(path, previous, status, additions, deletions)| {
                serde_json::json!({
                    "filename": path, "previous_filename": previous, "status": status,
                    "additions": additions, "deletions": deletions,
                })
            })
            .collect();
        out.push((
            "/push",
            serde_json::json!({
                "repo": REPO, "number": number, "sha": to.head_sha(), "base_sha": to.base_sha(),
                "files": files, "force": to.version < from.version,
            }),
        ));
    }
    out
}
