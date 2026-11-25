//! What the PR panel's Analyse button shows (#177), read with the PR's detail: the PR's run, when
//! one is live or the last one expired, and a summary of its analysis, with how far the PR's head
//! has moved past the analysed one ("N behind"). The read never waits on GitHub, and a failure to
//! read the account's `analyses.db` leaves the run and the analysis out, logged: the PR's detail
//! answers all the same.
//!
//! **"N behind"** is the analysed head's place in the PR's commit list (`GET …/pulls/{n}/commits`,
//! 250 commits at most), counted up to the head the mirror has. A read that finds the heads
//! differ and nothing kept for the pair says "outdated" and starts a count in the background, one
//! per (account, PR, analysed head, current head) at a time, none while GitHub is down. A count
//! is kept in `analyses.db`, so a new head costs one GitHub call however often the PR is opened,
//! and tells the account's streams (`analysis`), so the panel reads the PR again. An analysed head
//! that isn't in the list (force-pushed away) is kept as "outdated". So is a list GitHub refuses
//! (403, or a 404 while the PR is in sight): whether the App's Pull requests: read covers it
//! without Contents: read is unproven against real GitHub (spec #174, "Checks against real
//! GitHub"), so a refusal is logged once per process for each status. Nothing is kept when the
//! mirror's head isn't in the list: GitHub's REST list may lag the GraphQL head the mirror read
//! (tried again shortly, a few times), or the PR has more than the 250 commits it lists ("outdated",
//! not asked about again for a while). A call that fails for a passing reason (no answer in time,
//! a rate limit, a 301) is tried again the same way, and a later read counts afresh.

use super::announce;
use super::runs::{Producer, deadline_of};
use crate::App;
use crate::github::Shown;
use serde::{Serialize, Serializer};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use ts_rs::TS;

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
    /// When the run started (Unix seconds): an analysis made since was uploaded by it.
    pub started_at: i64,
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
    /// counted, or isn't yet (a count is on its way, and its `analysis` event brings it);
    /// absent when the analysis is at the PR's head (or the mirror has no head for it).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | \"outdated\"")]
    pub behind: Option<Behind>,
}

/// How far the PR's head is past an analysis's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behind {
    Commits(i64),
    /// The analysed head isn't in the PR's commit list, the list couldn't be read, or it's being
    /// counted.
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
/// (it never started a run), which isn't made for the read, nor when it can't be read.
pub(crate) async fn read(app: &App, pr: PanelPr<'_>) -> (Option<PrRun>, Option<PrAnalysis>) {
    let account = pr.account;
    if !app.analyses().dbs.path(account).exists() {
        return (None, None);
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
        Err(dbrt::Error::Deleted) => return (None, None),
        Err(e) => {
            eprintln!(
                "account {account}: reading the run and analysis of {}/{}#{number} for its panel: {e}; the PR's detail shows neither",
                pr.owner, pr.name
            );
            return (None, None);
        }
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
            started_at: r.created_at,
            expires_at,
        })
    });
    let analysis = match analysis {
        None => None,
        Some(a) => {
            let behind = behind(app, &pr, &a.head_sha).await;
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
    (run, analysis)
}

/// How far the PR's head is past `analysed`, as kept from a count; "outdated" while none is,
/// with a count started for it.
async fn behind(app: &App, pr: &PanelPr<'_>, analysed: &str) -> Option<Behind> {
    let head = pr.head_sha?;
    if head == analysed {
        return None;
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
        Ok(Some(kept)) => return shown(kept),
        Ok(None) => {}
        Err(dbrt::Error::Deleted) => return None,
        Err(e) => {
            eprintln!(
                "account {account}: reading how far {}/{}#{number} is past its analysis: {e}; it reads as outdated for now",
                pr.owner, pr.name
            );
            return Some(Behind::Outdated);
        }
    }
    start_count(
        app,
        CountKey {
            account,
            repo_id,
            number,
            analysed: analysed.to_owned(),
            head: head.to_owned(),
        },
        pr.owner,
        pr.name,
    );
    Some(Behind::Outdated)
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

/// What one count is of: the account's PR, its analysed head and its head as the mirror has it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CountKey {
    pub account: i64,
    pub repo_id: i64,
    pub number: i64,
    pub analysed: String,
    pub head: String,
}

/// How long one call for the commit list waits for GitHub.
const COUNT_WITHIN: Duration = Duration::from_secs(10);
/// How many times a count is tried when it fails for a passing reason, the wait before the
/// second try (doubled for each one after), and how long a PR past GitHub's list rests.
const COUNT_TRIES: u32 = 3;
const COUNT_RETRY: Duration = Duration::from_secs(2);
const PAST_LIST_RESTS: Duration = Duration::from_secs(10 * 60);
/// The most commits GitHub lists for a PR ("Lists a maximum of 250 commits for a pull request").
const LISTED_AT_MOST: usize = 250;

/// Counts `key` in the background, unless a count of it is on its way or resting, or GitHub is
/// down (the next read starts one).
fn start_count(app: &App, key: CountKey, owner: &str, name: &str) {
    if app.github().is_down() || !app.analyses().count_begins(&key) {
        return;
    }
    let (owner, name) = (owner.to_owned(), name.to_owned());
    app.spawn(move |app| async move {
        let rest = counted(&app, &key, &owner, &name).await;
        app.analyses().count_done(&key, rest);
    });
}

/// The count of `key`: kept and announced, or tried again for a passing failure. When the pair
/// isn't to be asked about again before some time.
async fn counted(app: &App, key: &CountKey, owner: &str, name: &str) -> Option<std::time::Instant> {
    let (account, number) = (key.account, key.number);
    let mut wait = COUNT_RETRY;
    for tries in 1..=COUNT_TRIES {
        if app.github().is_down() {
            return None;
        }
        let behind = match count(app, key, owner, name).await {
            Count::Kept(n) => n,
            Count::PastList => {
                return Some(std::time::Instant::now() + PAST_LIST_RESTS);
            }
            Count::Passing(why) => {
                eprintln!(
                    "account {account}: counting how far {owner}/{name}#{number} is past its analysis: {why}; it reads as outdated for now{}",
                    if tries < COUNT_TRIES {
                        ", and is tried again"
                    } else {
                        ""
                    }
                );
                if tries < COUNT_TRIES {
                    tokio::time::sleep(wait).await;
                    wait *= 2;
                }
                continue;
            }
        };
        let k = key.clone();
        let kept = app
            .analyses()
            .dbs
            .write(account, move |tx| {
                analysis_db::q::put_behind(tx, k.repo_id, k.number, &k.analysed, &k.head, behind)
            })
            .await;
        match kept {
            Ok(_) => announce(app, account, &format!("{owner}/{name}"), number, None),
            Err(dbrt::Error::Deleted) => {}
            Err(e) => eprintln!(
                "account {account}: keeping how far {owner}/{name}#{number} is past its analysis: {e}"
            ),
        }
        return None;
    }
    None
}

/// A count from GitHub.
enum Count {
    /// To keep: commits behind, or `None` for "outdated" (the analysed head isn't in the list, or
    /// GitHub won't list it).
    Kept(Option<i64>),
    /// The mirror's head is past the 250 commits GitHub lists: "outdated", kept nowhere.
    PastList,
    /// It failed for a passing reason, or GitHub's list doesn't have the mirror's head yet:
    /// nothing to keep.
    Passing(String),
}

/// Whether GitHub refusing to list a PR's commits has been logged since startup: a 403 (no
/// permission for it), and a 404.
static FORBIDDEN_LOGGED: AtomicBool = AtomicBool::new(false);
static NOT_FOUND_LOGGED: AtomicBool = AtomicBool::new(false);

/// Counts from GitHub's list of the PR's commits, with the account's own token.
async fn count(app: &App, key: &CountKey, owner: &str, name: &str) -> Count {
    let gh = app.github().clone();
    let (o, n, number) = (owner.to_owned(), name.to_owned(), key.number);
    let call = app.tokens().with_token(key.account, |token| {
        let (gh, o, n) = (gh.clone(), o.clone(), n.clone());
        async move { gh.pull_commits(&token, &o, &n, number).await }
    });
    let listed = match tokio::time::timeout(COUNT_WITHIN, call).await {
        Err(_) => return Count::Passing(format!("no answer within {COUNT_WITHIN:?}")),
        Ok(r) => r,
    };
    let refused = |logged: &AtomicBool, why: &str| {
        if !logged.swap(true, Ordering::Relaxed) {
            eprintln!(
                "analyses: GitHub refused the commit list of {owner}/{name}#{number} ({why}): the App may need more than Pull requests: read for it. PRs behind their analysis read as outdated, with no count (logged once for a {why})"
            );
        }
        Count::Kept(None)
    };
    let shas = match listed {
        Ok(Shown::It(shas)) => shas,
        Ok(Shown::Gone) => return refused(&NOT_FOUND_LOGGED, "404"),
        // Transferred since: its webhooks bring it under its new name.
        Ok(Shown::Moved) => return Count::Passing("moved (301)".into()),
        Err(crate::tokens::Error::GitHub(crate::github::Error::Status(403))) => {
            return refused(&FORBIDDEN_LOGGED, "403");
        }
        Err(e) => return Count::Passing(e.to_string()),
    };
    let Some(to) = shas.iter().position(|s| *s == key.head) else {
        if shas.len() >= LISTED_AT_MOST {
            return Count::PastList;
        }
        return Count::Passing("GitHub doesn't list the PR's head yet".into());
    };
    match shas.iter().position(|s| *s == key.analysed) {
        None => Count::Kept(None),
        Some(at) => Count::Kept(Some(to.saturating_sub(at) as i64)),
    }
}
