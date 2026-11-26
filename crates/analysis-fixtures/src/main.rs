//! `analysis-fixtures`: the PR view's committed analyses (`fixtures/pr-view/`).
//!
//! ```text
//! analysis-fixtures record --db FILE [--db FILE…] --run ID [--version 1|2]
//!     Saves run ID's pinned pr.json and its accepted upload (or the analysis ID's), byte for
//!     byte, from the first analyses.db that has it, as
//!     fixtures/pr-view/beghu-<n>/pr-v<N>.json and analysis-v<N>.json. Without --version: v1 when
//!     the PR has no recording yet, else v2. Recording v1 again deletes v2: the two are replaced
//!     together (./dev-ctl analysis record runs this).
//! analysis-fixtures check [--repo DIR] [--reachable-from REF]
//!     The full validator, snippet check included, on every committed recording and case, against
//!     the real commits read from the git repo at DIR (default: this one) by SHA, on their
//!     migrated form. With --reachable-from, each analysed SHA must also be an ancestor of REF.
//!     Exit 1 on any error (CI's `pr-view-fixtures` job).
//! analysis-fixtures shas
//!     The commits the committed analyses name, one per line: what CI fetches by SHA first.
//! ```

use analysis::{Context, Previous, validate};
use analysis_fixtures::{GitReader, committed, dir, record};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let dbs: Vec<PathBuf> = args
        .windows(2)
        .filter(|w| w[0] == "--db")
        .map(|w| PathBuf::from(&w[1]))
        .collect();
    let out = match args.first().map(String::as_str) {
        Some("record") => match flag("--run") {
            Some(run) if !dbs.is_empty() => run_record(&dbs, &run, flag("--version")),
            _ => Err(USAGE.into()),
        },
        Some("check") => check(
            &flag("--repo").map_or_else(|| dir().join("../.."), PathBuf::from),
            flag("--reachable-from").as_deref(),
        ),
        Some("shas") => shas(),
        _ => Err(USAGE.into()),
    };
    match out {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "usage: analysis-fixtures record --db FILE [--db FILE…] --run ID [--version 1|2]\n       analysis-fixtures check [--repo DIR] [--reachable-from REF]\n       analysis-fixtures shas";

/// Every commit a committed analysis names (its base and head), once each, one per line.
fn shas() -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for c in committed() {
        let v: serde_json::Value =
            serde_json::from_str(&c.analysis_text()).map_err(|e| format!("{}: {e}", c.name))?;
        for k in ["baseSha", "headSha"] {
            if let Some(sha) = v["pr"][k].as_str()
                && seen.insert(sha.to_owned())
            {
                println!("{sha}");
            }
        }
    }
    Ok(())
}

fn run_record(dbs: &[PathBuf], run: &str, version: Option<String>) -> Result<(), String> {
    let mut why = Vec::new();
    let mut found = None;
    for db in dbs {
        match record(db, run) {
            Ok(got) => {
                found = Some(got);
                break;
            }
            Err(e) => why.push(e),
        }
    }
    let got = found.ok_or_else(|| why.join("\n"))?;
    let folder = dir().join(format!("beghu-{}", got.number));
    let v1 = folder.join("analysis-v1.json").exists();
    let version = match version.as_deref() {
        None if v1 => 2,
        None => 1,
        Some("1") => 1,
        Some("2") if v1 => 2,
        Some("2") => return Err("there's no v1 to record v2 after: record v1 first".into()),
        Some(v) => return Err(format!("--version is 1 or 2, not {v}")),
    };
    // The upload must be what the server accepted for that pr.json: check it as the server does,
    // before anything is written.
    let pinned: analysis::PinnedPr =
        serde_json::from_str(&got.pr).map_err(|e| format!("the pinned pr.json: {e}"))?;
    let ctx = Context {
        changed_files: Some(pinned.files.iter().map(|f| f.path.clone()).collect()),
        previous: Previous::Unknown,
    };
    let checked = validate(&got.analysis, &ctx, None);
    if !checked.report.errors.is_empty() {
        return Err(format!(
            "the stored upload doesn't validate:\n{}",
            serde_json::to_string_pretty(&checked.report.errors).unwrap()
        ));
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    if version == 1 {
        for f in ["pr-v2.json", "analysis-v2.json"] {
            if std::fs::remove_file(folder.join(f)).is_ok() {
                eprintln!("deleted {f}: v1 and v2 are recorded together");
            }
        }
    }
    for (name, text) in [
        (format!("pr-v{version}.json"), &got.pr),
        (format!("analysis-v{version}.json"), &got.analysis),
    ] {
        let p = folder.join(&name);
        std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))?;
        println!("{}", p.display());
    }
    eprintln!(
        "recorded run {run} as v{version} of #{} at {}; run the coverage test (cargo test -p analysis-fixtures)",
        got.number, got.head_sha
    );
    Ok(())
}

fn check(repo: &Path, reachable_from: Option<&str>) -> Result<(), String> {
    let all = committed();
    if all.is_empty() {
        return Err(format!("nothing committed under {}", dir().display()));
    }
    let mut failed = 0;
    for c in &all {
        let pinned = c.pinned();
        // A later analysis's `carried` is checked against the one before it, migrated, as the
        // server did when it took it.
        let prev = c.previous_ids()?;
        let ctx = Context {
            changed_files: Some(pinned.files.iter().map(|f| f.path.clone()).collect()),
            previous: prev,
        };
        let text = c.analysis_text();
        let shas: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", c.name))?;
        let base = shas["pr"]["baseSha"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let head = shas["pr"]["headSha"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let mut problems = Vec::new();
        for sha in [&base, &head] {
            if !GitReader::reachable(repo, sha, sha) {
                problems.push(format!(
                    "commit {sha} isn't in {} (fetch it by SHA first)",
                    repo.display()
                ));
            } else if let Some(r) = reachable_from
                && !GitReader::reachable(repo, sha, r)
            {
                problems.push(format!("commit {sha} isn't reachable from {r}"));
            }
        }
        if head != pinned.head_sha {
            problems.push(format!(
                "its head {head} isn't the pinned pr.json's {}",
                pinned.head_sha
            ));
        }
        let reader = GitReader::new(repo, &base, &head);
        let out = validate(&text, &ctx, Some(&reader));
        for e in &out.report.errors {
            problems.push(format!("{} {}: {}", e.rule, e.path, e.message));
        }
        if problems.is_empty() {
            println!(
                "ok   {} ({} warnings{})",
                c.name,
                out.report.warnings.len(),
                out.from_version
                    .filter(|v| *v < analysis::VERSION)
                    .map(|v| format!(", migrated from v{v}"))
                    .unwrap_or_default()
            );
            for w in &out.report.warnings {
                println!("     warning {} {}: {}", w.rule, w.path, w.message);
            }
        } else {
            failed += 1;
            println!("FAIL {}", c.name);
            for p in problems {
                println!("     {p}");
            }
        }
    }
    match failed {
        0 => Ok(()),
        n => Err(format!("{n} of {} committed analyses failed", all.len())),
    }
}
