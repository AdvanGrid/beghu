//! What the PR panel's Analyse button shows (#177), read with the PR's detail: the PR's run, when
//! one is live or the last one expired, and a summary of its analysis, with how far the PR's head
//! has moved past the analysed one ("N behind").
//!
//! **"N behind"** is the analysed head's place in the PR's commit list (`GET …/pulls/{n}/commits`,
//! 250 commits at most), counted from the head the mirror has: the commits after the analysed
//! head, up to the mirror's head (or to the list's end when the mirror's head isn't in it). It's
//! counted when the detail is read and the heads differ, then kept in `analyses.db` per (analysed
//! head, current head), so a new head costs one GitHub call however often the PR is opened. An
//! analysed head that isn't in the list (force-pushed away) is "outdated". So is one GitHub won't
//! list the commits for (403, or a 404 while the PR is in sight): whether the App's Pull requests:
//! read covers the list without Contents: read is unproven against real GitHub (spec #174,
//! "Checks against real GitHub"), so a refusal is kept as "outdated", logged once per process. A
//! call that fails for a passing reason (GitHub down, a rate limit, no answer in time) says
//! "outdated" too, unkept, and the next read counts again.

use super::runs::{Producer, deadline_of};
use crate::App;
use crate::error::ApiError;
use serde::{Serialize, Serializer};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use ts_rs::TS;

/// How long a count waits for GitHub before it says "outdated" for this read.
const COUNT_WITHIN: Duration = Duration::from_secs(10);

/// The PR's run, as the panel shows it.
#[derive(Serialize, TS, Debug, Clone, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PrRun {
    /// The run's ID: what the tab keeps the run's prompt under, for Copy again.
    pub id: String,
    /// Who started it: the PR panel's button, or the beghu CLI.
    #[ts(type = "\"button\" | \"cli\"")]
    pub producer: &'static str,
    /// `waiting` for an agent's first fetch, `attached` (an agent fetched, the run pinned the PR),
    /// or `expired`: no run is live, and the last one expired.
    #[ts(type = "\"waiting\" | \"attached\" | \"expired\"")]
    pub state: &'static str,
    /// The head SHA the run pinned, once attached.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned_sha: Option<String>,
    /// The run's last call (Unix seconds), once attached.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_heard: Option<i64>,
    /// How many errors the last upload had when it was refused; 0 when it wasn't, or there was
    /// none.
    pub refused: i64,
    /// When the run expires as it stands (Unix seconds); for `expired`, when it did.
    pub expires_at: i64,
}

/// The PR's analysis, as the panel shows it.
#[derive(Serialize, TS, Debug, Clone, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PrAnalysis {
    pub id: String,
    /// The head it was made at.
    pub head_sha: String,
    /// Unix seconds.
    pub created_at: i64,
    pub parts: i64,
    pub purposes: i64,
    pub conflicts: i64,
    /// How many commits the PR's head is past `headSha`, or `outdated` when that can't be
    /// counted; absent when the analysis is at the PR's head (or the mirror has no head for it).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | \"outdated\"")]
    pub behind: Option<Behind>,
}

/// How far the PR's head is past an analysis's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behind {
    Commits(i64),
    /// The analysed head isn't in the PR's commit list, or the list couldn't be read.
    Outdated,
}

impl Serialize for Behind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Behind::Commits(n) => s.serialize_i64(*n),
            Behind::Outdated => s.serialize_str("outdated"),
        }
    }
}

/// The PR whose panel is read: the account's repo by id and name, its number, and its head as
/// the mirror has it.
pub(crate) struct PanelPr<'a> {
    pub account: i64,
    pub repo_id: i64,
    pub owner: &'a str,
    pub name: &'a str,
    pub number: i64,
    pub head_sha: Option<&'a str>,
}

/// The PR's run and analysis for its panel. Nothing for an account that has no `analyses.db`
/// (it never started a run), which isn't made for the read.
pub(crate) async fn read(
    app: &App,
    pr: PanelPr<'_>,
) -> Result<(Option<PrRun>, Option<PrAnalysis>), ApiError> {
    let account = pr.account;
    if !app.analyses().dbs.path(account).exists() {
        return Ok((None, None));
    }
    let (repo_id, number) = (pr.repo_id, pr.number);
    let read = app
        .analyses()
        .dbs
        .read(account, move |c| {
            Ok((
                analysis_db::q::latest_run(c, repo_id, number)?,
                analysis_db::q::analysis_summary(c, repo_id, number)?,
            ))
        })
        .await;
    let (run, analysis) = match read {
        Ok(r) => r,
        // Deleted since (dormant, or disconnected): nothing left of it.
        Err(dbrt::Error::Deleted) => return Ok((None, None)),
        Err(e) => return Err(e.into()),
    };
    let lifetimes = &app.cfg().runs;
    let now = crate::now();
    let run = run.and_then(|r| {
        let expires_at = deadline_of(lifetimes, r.created_at, r.attached_at, r.last_heard_at);
        let state = match (r.state.as_str(), r.ended_reason.as_deref()) {
            // Its timer ends it at its deadline, and may not have yet.
            ("waiting" | "attached", _) if now >= expires_at => "expired",
            ("waiting", _) => "waiting",
            ("attached", _) => "attached",
            (_, Some("expired")) => "expired",
            // Ended otherwise: by the user, superseded by nothing newer, or revoked.
            _ => return None,
        };
        let attached = r.attached_at.is_some();
        Some(PrRun {
            id: r.id,
            producer: Producer::from_db(&r.producer).as_str(),
            state,
            pinned_sha: r.pinned_head,
            last_heard: attached.then_some(r.last_heard_at),
            refused: r.refused_errors.unwrap_or(0),
            expires_at,
        })
    });
    let analysis = match analysis {
        None => None,
        Some(a) => {
            let behind = behind(app, &pr, &a.head_sha).await?;
            Some(PrAnalysis {
                id: a.id,
                head_sha: a.head_sha,
                created_at: a.created_at,
                parts: a.parts,
                purposes: a.purposes,
                conflicts: a.conflicts,
                behind,
            })
        }
    };
    Ok((run, analysis))
}

/// How far the PR's head is past `analysed`: kept from an earlier read, or counted now.
async fn behind(app: &App, pr: &PanelPr<'_>, analysed: &str) -> Result<Option<Behind>, ApiError> {
    let Some(head) = pr.head_sha else {
        return Ok(None);
    };
    if head == analysed {
        return Ok(None);
    }
    let (account, repo_id, number) = (pr.account, pr.repo_id, pr.number);
    let (a, h) = (analysed.to_owned(), head.to_owned());
    let kept = app
        .analyses()
        .dbs
        .read(account, move |c| {
            analysis_db::q::behind_of(c, repo_id, number, &a, &h)
        })
        .await;
    match kept {
        Ok(Some(kept)) => return Ok(shown(kept)),
        Ok(None) => {}
        Err(dbrt::Error::Deleted) => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let counted = match count(app, pr, analysed, head).await {
        Count::Kept(n) => n,
        Count::Passing(why) => {
            eprintln!(
                "account {account}: counting how far {}/{}#{number} is past its analysis: {why}; it reads as outdated for now",
                pr.owner, pr.name
            );
            return Ok(Some(Behind::Outdated));
        }
    };
    let (a, h) = (analysed.to_owned(), head.to_owned());
    if let Err(e) = app
        .analyses()
        .dbs
        .write(account, move |tx| {
            analysis_db::q::put_behind(tx, repo_id, number, &a, &h, counted)
        })
        .await
    {
        eprintln!(
            "account {account}: keeping how far {}/{}#{number} is past its analysis: {e}",
            pr.owner, pr.name
        );
    }
    Ok(shown(counted))
}

/// What's kept, as the panel shows it: 0 (the mirror's head is at or before the analysed one) is
/// at head, and `None` outdated.
fn shown(kept: Option<i64>) -> Option<Behind> {
    match kept {
        Some(0) => None,
        Some(n) => Some(Behind::Commits(n)),
        None => Some(Behind::Outdated),
    }
}

/// A count from GitHub.
enum Count {
    /// To keep: commits behind, or `None` for "outdated" (the analysed head isn't in the list, or
    /// GitHub won't list it).
    Kept(Option<i64>),
    /// It failed for a passing reason: nothing to keep.
    Passing(String),
}

/// Whether GitHub refused to list a PR's commits has been logged since startup.
static REFUSAL_LOGGED: AtomicBool = AtomicBool::new(false);

/// Counts from GitHub's list of the PR's commits, with the account's own token.
async fn count(app: &App, pr: &PanelPr<'_>, analysed: &str, head: &str) -> Count {
    let gh = app.github().clone();
    let (o, n, number) = (pr.owner.to_owned(), pr.name.to_owned(), pr.number);
    let call = app.tokens().with_token(pr.account, |token| {
        let (gh, o, n) = (gh.clone(), o.clone(), n.clone());
        async move { gh.pull_commits(&token, &o, &n, number).await }
    });
    let listed = match tokio::time::timeout(COUNT_WITHIN, call).await {
        Err(_) => return Count::Passing(format!("no answer within {COUNT_WITHIN:?}")),
        Ok(r) => r,
    };
    let refused = |why: String| {
        if !REFUSAL_LOGGED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "analyses: GitHub refused the commit list of {}/{}#{number} ({why}): the App may need more than Pull requests: read for it. PRs behind their analysis read as outdated, with no count (logged once)",
                pr.owner, pr.name
            );
        }
        Count::Kept(None)
    };
    let shas = match listed {
        Ok(crate::github::Shown::It(shas)) => shas,
        Ok(_) => return refused("404".into()),
        Err(crate::tokens::Error::GitHub(crate::github::Error::Status(403))) => {
            return refused("403".into());
        }
        Err(e) => return Count::Passing(e.to_string()),
    };
    let Some(at) = shas.iter().position(|s| s == analysed) else {
        return Count::Kept(None);
    };
    let to = shas
        .iter()
        .position(|s| s == head)
        .unwrap_or(shas.len().saturating_sub(1));
    Count::Kept(Some(to.saturating_sub(at) as i64))
}
