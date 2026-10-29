//! beghu's contract check: keeps Fake GitHub honest. It sends the fake's request set to GitHub
//! (or to a Fake GitHub, to check the check) and diffs each answer's shape (fields and types,
//! not values) with the fake's recorded templates (`crates/fake-github/templates/`).
//!
//! - The read run (nightly in CI) reads busy repos with read-only installation tokens, and
//!   reads webhook payloads back from the App's delivery log.
//! - The write run (weekly, and on changes to the fake's templates or beghu's GitHub client)
//!   makes each of beghu's writes on the sandbox and undoes it in the same run.
//! - Drift goes to the one "Contract drift" issue on the sandbox; webhook events and actions
//!   unseen for 14 days are listed there as coverage gaps.
//!
//! The binary (`cargo run -p contract -- help`) is what `./dev-ctl contract` and
//! `.github/workflows/contract.yml` run.

pub mod check;
pub mod http;
pub mod record;
pub mod report;
pub mod run;
pub mod shape;
pub mod templates;

use check::{Checker, Mode};
use run::Setup;
use std::path::Path;

/// Which run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
}

/// What a run ended with.
#[derive(Debug)]
pub struct Outcome {
    pub checker: Checker,
    /// The report, as Markdown.
    pub report: String,
    /// Drift, or a sandbox left changed: the run fails.
    pub failed: bool,
    /// The coverage gaps (read run only).
    pub gaps: Vec<String>,
    /// The drift issue's number, when the report was posted.
    pub issue: Option<i64>,
}

/// Runs `kind` against `setup`, checking with the templates in `dir`; with `report`, posts to
/// the drift issue on the sandbox.
pub async fn run(kind: Kind, setup: &Setup, dir: &Path, report: bool) -> Result<Outcome, String> {
    let templates = templates::Templates::load(dir)?;
    let mut c = Checker::new(templates, setup.mode);
    match kind {
        Kind::Read => run::read(setup, &mut c).await?,
        Kind::Write => run::write(setup, &mut c).await?,
    }
    let http = http::Http::new(&setup.api, &setup.web);
    let report = match report {
        true => Some(run::sandbox_token(setup, &mut c).await?),
        false => None,
    };
    let report = report.as_deref();
    let target = match setup.mode {
        Mode::GitHub => format!("GitHub ({})", setup.api),
        Mode::Fake => format!("Fake GitHub ({})", setup.api),
    };
    let run_name = match kind {
        Kind::Read => "read",
        Kind::Write => "write",
    };
    // The last-seen times so far live in the drift issue: read them before reckoning gaps.
    let mut state = report::State::default();
    if let Some(token) = report
        && let Some((_, _, body)) = report::find_issue(&http, token, &setup.sandbox).await?
    {
        state = report::read_state(&body);
    }
    let gaps = match kind {
        Kind::Read => {
            for (pair, at) in &c.found.seen {
                if state.last_seen.get(pair).is_none_or(|old| old < at) {
                    state.last_seen.insert(pair.clone(), at.clone());
                }
            }
            Some(report::gaps(&c.templates.webhook_pairs(), &state.last_seen))
        }
        Kind::Write => None,
    };
    let md = report::markdown(run_name, &target, &c.found, gaps.as_deref());
    let failed = !c.found.drift.is_empty() || !c.found.left_changed.is_empty();
    let fingerprint = failed.then(|| {
        let mut lines: Vec<String> = c
            .found
            .drift
            .iter()
            .map(|d| format!("{} {}", d.template, d.what))
            .chain(c.found.left_changed.iter().cloned())
            .collect();
        lines.sort();
        lines.dedup();
        report::fingerprint(&lines)
    });
    match fingerprint {
        Some(f) => state.drift.insert(run_name.to_owned(), f),
        None => state.drift.remove(run_name),
    };
    if let Some(g) = &gaps {
        state.gaps = g.iter().map(|(p, _)| p.clone()).collect();
    }
    let issue = match report {
        Some(token) => {
            Some(report::post(&http, token, &setup.sandbox, run_name, &md, failed, &state).await?)
        }
        None => None,
    };
    Ok(Outcome {
        gaps: state.gaps.clone(),
        checker: c,
        report: md,
        failed,
        issue,
    })
}
