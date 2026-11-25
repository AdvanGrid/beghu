//! What the PR panel's Analyse button shows (#177), read with the PR's detail: the PR's run, when
//! one is live or the last one expired, and a summary of its analysis, with how far the PR's head
//! has moved past the analysed one ("N behind"). The read never waits on GitHub. A failure to
//! read the account's `analyses.db` leaves the run and the analysis out, logged, and says so
//! (`run_unknown`), so the panel keeps what it showed rather than take the run as gone: the PR's
//! detail answers all the same.
//!
//! **"N behind"** is the analysed head's place in the PR's commit list (`GET …/pulls/{n}/commits`,
//! 250 commits at most), counted up to the head the mirror has. A read that finds the heads
//! differ and nothing kept for the pair says "counting" and starts a count in the background, one
//! per (account, PR, analysed head, current head) at a time and [`COUNTS_AT_ONCE`] in all. While
//! GitHub is down none starts: the pairs read meanwhile are counted once it's back. A count is
//! kept in `analyses.db`, so a new head costs one GitHub call however often the PR is opened, and
//! tells the account's streams (`analysis`), so the panel reads the PR again. An analysed head
//! that isn't in the list (force-pushed away) is kept as "outdated". So is a list GitHub refuses
//! (403, or a 404 while the PR is in sight): whether the App's Pull requests: read covers it
//! without Contents: read is unproven against real GitHub (spec #174, "Checks against real
//! GitHub"), so a refusal is logged once per process for each status. Nothing is kept when the
//! mirror's head isn't in the list: GitHub's REST list may lag the GraphQL head the mirror read
//! (tried again shortly, a few times), or the PR has more than the 250 commits it lists
//! ("outdated", not asked about again for a while). A rate limit rests the pair until GitHub's
//! wait is over, and a 301 (the repo renamed, its webhooks bringing the new name) for a minute,
//! "counting" meanwhile; a call that fails for another passing reason (no answer in time, a 5xx)
//! is tried again shortly, and a later read counts afresh.

use super::announce;
use super::runs::{Producer, deadline_of};
use crate::App;
use crate::github::Shown;
use serde::{Serialize, Serializer};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
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
    /// How many commits the PR's head is past `headSha`; `outdated` when that can't be counted;
    /// `counting` when it isn't yet (a count is on its way, or waits for GitHub, and its
    /// `analysis` event brings it). Absent when the analysis is at the PR's head (or the mirror
    /// has no head for it).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | \"outdated\" | \"counting\"")]
    pub behind: Option<Behind>,
}

/// How far the PR's head is past an analysis's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behind {
    Commits(i64),
    /// The analysed head isn't in the PR's commit list, or GitHub won't list it.
    Outdated,
    /// Not known yet: a count is on its way, or waits for GitHub (down, or a rate limit).
    Counting,
}

impl Serialize for Behind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Behind::Commits(n) => s.serialize_i64(*n),
            Behind::Outdated => s.serialize_str("outdated"),
            Behind::Counting => s.serialize_str("counting"),
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

/// The PR's panel, as read.
#[derive(Debug, Default)]
pub(crate) struct Panel {
    pub run: Option<PrRun>,
    pub analysis: Option<PrAnalysis>,
    /// The account's `analyses.db` couldn't be read: whether the PR has a run or an analysis
    /// isn't known.
    pub unknown: bool,
}

/// The PR's run and analysis for its panel. Nothing for an account that has no `analyses.db`
/// (it never started a run), which isn't made for the read; unknown when it can't be read.
pub(crate) async fn read(app: &App, pr: PanelPr<'_>) -> Panel {
    let account = pr.account;
    if !app.analyses().dbs.path(account).exists() {
        return Panel::default();
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
        Err(dbrt::Error::Deleted) => return Panel::default(),
        Err(e) => {
            eprintln!(
                "account {account}: reading the run and analysis of {}/{}#{number} for its panel: {e}; the PR's detail says it doesn't know them",
                pr.owner, pr.name
            );
            return Panel {
                unknown: true,
                ..Panel::default()
            };
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
    Panel {
        run,
        analysis,
        unknown: false,
    }
}

/// How far the PR's head is past `analysed`, as kept from a count; while none is, "counting"
/// with a count started for it, or as the pair's rest says.
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
    let key = CountKey {
        account,
        repo_id,
        number,
        analysed: analysed.to_owned(),
        head: head.to_owned(),
    };
    Some(start_count(app, key, pr.owner, pr.name))
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

/// How many counts call GitHub at once, across accounts. A count is one to three calls with the
/// account's own token, nothing a reader waits on: four keep a burst of PRs (a fixture's, a
/// reviewer opening many in a row) from spending GitHub's secondary limit, which counts
/// concurrent requests, while a PR's count still lands in seconds.
const COUNTS_AT_ONCE: usize = 4;
/// How long one call for the commit list waits for GitHub.
const COUNT_WITHIN: Duration = Duration::from_secs(10);
/// How many times a count is tried when it fails for a passing reason, the wait before the
/// second try (doubled for each one after), how long a PR past GitHub's list rests, and how long
/// one GitHub answered 301 for.
const COUNT_TRIES: u32 = 3;
const COUNT_RETRY: Duration = Duration::from_secs(2);
const PAST_LIST_RESTS: Duration = Duration::from_secs(10 * 60);
const MOVED_RESTS: Duration = Duration::from_secs(60);
/// The most commits GitHub lists for a PR ("Lists a maximum of 250 commits for a pull request").
const LISTED_AT_MOST: usize = 250;

/// The counts on their way, their turns at GitHub, and the pairs resting or waiting for GitHub to
/// be back. The app's, in [`super::Store`].
pub(crate) struct Counts {
    /// Each pair with a count on its way (`None`), or resting until when, read as what.
    at: Mutex<HashMap<CountKey, Option<(Instant, Behind)>>>,
    /// A count's turn at GitHub: see [`COUNTS_AT_ONCE`].
    turns: tokio::sync::Semaphore,
    /// The pairs read while GitHub was down, with their repo's owner and name: counted once it's
    /// back.
    after_down: Mutex<HashMap<CountKey, (String, String)>>,
}

impl Default for Counts {
    fn default() -> Counts {
        Counts {
            at: Mutex::default(),
            turns: tokio::sync::Semaphore::new(COUNTS_AT_ONCE),
            after_down: Mutex::default(),
        }
    }
}

impl Counts {
    /// Whether a count of `key` may start now; if not, what the pair reads as meanwhile. If so,
    /// it's on its way until its [`Counting`] guard drops.
    fn begins(&self, key: &CountKey) -> Result<(), Behind> {
        let mut all = self.at.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        all.retain(|_, rest| rest.is_none_or(|(until, _)| until > now));
        match all.get(key) {
            Some(None) => Err(Behind::Counting),
            Some(Some((_, shows))) => Err(*shows),
            None => {
                all.insert(key.clone(), None);
                Ok(())
            }
        }
    }
}

/// A count on its way: dropped (done, stopped by the drain, or panicked), the pair is free to be
/// counted again, or rests if the count said so.
struct Counting {
    app: App,
    key: CountKey,
    rest: Option<(Instant, Behind)>,
}

impl Counting {
    /// The count is done, and the pair rests as `rest` says.
    fn done(mut self, rest: Option<(Instant, Behind)>) {
        self.rest = rest;
    }
}

impl Drop for Counting {
    fn drop(&mut self) {
        let mut all = self
            .app
            .analyses()
            .counts
            .at
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match self.rest {
            Some(rest) => all.insert(self.key.clone(), Some(rest)),
            None => all.remove(&self.key),
        };
    }
}

/// Counts `key` in the background, unless a count of it is on its way or resting; while GitHub is
/// down, once it's back. What the pair reads as meanwhile.
fn start_count(app: &App, key: CountKey, owner: &str, name: &str) -> Behind {
    if app.github().is_down() {
        after_down(app, key, owner, name);
        return Behind::Counting;
    }
    if let Err(shows) = app.analyses().counts.begins(&key) {
        return shows;
    }
    let on_way = Counting {
        app: app.clone(),
        key,
        rest: None,
    };
    let (owner, name) = (owner.to_owned(), name.to_owned());
    app.spawn(move |app| async move {
        let Ok(_turn) = app.analyses().counts.turns.acquire().await else {
            return;
        };
        let rest = counted(&app, &on_way.key, &owner, &name).await;
        on_way.done(rest);
    });
    Behind::Counting
}

/// Keeps `key` to count once GitHub is back, with a job waiting for that if none is.
fn after_down(app: &App, key: CountKey, owner: &str, name: &str) {
    let mut waiting = app
        .analyses()
        .counts
        .after_down
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let first = waiting.is_empty();
    waiting.insert(key, (owner.to_owned(), name.to_owned()));
    if !first {
        return;
    }
    drop(waiting);
    app.spawn(|app| async move {
        let mut health = app.github().health();
        if health.wait_for(|down| !*down).await.is_err() {
            return;
        }
        let back = std::mem::take(
            &mut *app
                .analyses()
                .counts
                .after_down
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        for (key, (owner, name)) in back {
            start_count(&app, key, &owner, &name);
        }
    });
}

/// The count of `key`: kept and announced, or tried again for a passing failure. Until when the
/// pair isn't to be asked about again, if it rests, and what it reads as meanwhile.
async fn counted(app: &App, key: &CountKey, owner: &str, name: &str) -> Option<(Instant, Behind)> {
    let (account, number) = (key.account, key.number);
    let mut wait = COUNT_RETRY;
    for tries in 1..=COUNT_TRIES {
        if app.github().is_down() {
            return None;
        }
        let behind = match count(app, key, owner, name).await {
            Count::Kept(n) => n,
            Count::PastList => {
                return Some((Instant::now() + PAST_LIST_RESTS, Behind::Outdated));
            }
            Count::Rests(d, why) => {
                eprintln!(
                    "account {account}: counting how far {owner}/{name}#{number} is past its analysis: {why}; not asked again for {} s",
                    d.as_secs()
                );
                return Some((Instant::now() + d, Behind::Counting));
            }
            Count::Passing(why) => {
                eprintln!(
                    "account {account}: counting how far {owner}/{name}#{number} is past its analysis: {why}{}",
                    if tries < COUNT_TRIES {
                        "; tried again"
                    } else {
                        "; the next read counts again"
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
    /// Not to be asked for again for this long: a rate limit's wait, or a 301's rest.
    Rests(Duration, String),
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
        // Renamed since: its webhooks bring it under its new name.
        Ok(Shown::Moved) => return Count::Rests(MOVED_RESTS, "moved (301)".into()),
        Err(crate::tokens::Error::GitHub(crate::github::Error::Status(403))) => {
            return refused(&FORBIDDEN_LOGGED, "403");
        }
        Err(crate::tokens::Error::GitHub(crate::github::Error::RateLimited(d))) => {
            return Count::Rests(d, format!("GitHub's rate limit, for {} s", d.as_secs()));
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
