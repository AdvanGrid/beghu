//! The events-feed poller: each synced repo's issue events feed
//! (`GET /repos/{owner}/{repo}/issues/events`), read about every
//! [`ReconcileConfig::feed_every`](crate::ReconcileConfig) while any active account syncing the
//! repo has a live stream open, and by the 5-minute probe for a repo with none (`schedule.rs`).
//! Each read is conditional on the last answer's ETag, so an unchanged feed is a 304 that costs
//! nothing. A changed feed is read on, page by page (`Link: next`), until a page holds an event
//! the last read saw, up to [`MAX_PAGES`]: a burst of events between two reads isn't lost off
//! the first page.
//!
//! It catches what no webhook says (spec #86, "Events-feed poller"; research #69):
//!
//! - `connected` and `disconnected` on a PR: a link made or removed in GitHub's Development
//!   sidebar. The PR is read back (`pulls.rs`), its closing references with it.
//! - The same events on an issue, which name no PR. A PR in a synced repo gets the PR-side event
//!   in its own repo's feed; one in a repo the account doesn't sync is seen only from here, so
//!   the issue's linked PRs from such repos are read back (`pulls::refetch_linked`) and kept as
//!   stubs.
//! - `sub_issue_*` and `parent_issue_*`, while a stream is live: a backup for a `sub_issues`
//!   delivery that never came, which repairs it within seconds for whoever is looking. The issue's
//!   sub-issue edges are read back (`edges.rs`). The 5-minute probe leaves them to the sub-issue
//!   order sweep, which also tells the accounts their sync is degraded.
//!
//! Every other event is ignored. GitHub's feed ids don't follow its order, and an event can show
//! up late, behind newer ones: so an event is new when its id wasn't on the pages read before (no
//! high-water mark), and each is acted on once. The first read of a repo since this process
//! started has no page before it: it acts on every link event on its first page (a link has no
//! other trace; one read-back per PR or issue however many it names), and on the sub-issue events
//! from the last few minutes before the start (the sweeps cover anything older).
//!
//! Its reads honour GitHub's rate limits as the sweeps do: an installation GitHub asked to wait,
//! or whose core quota is below a fifth, isn't polled until then, and a rate limit the poller
//! meets pauses the installation's sweeps and probes too (`Budget`), and the read-backs it
//! schedules wait it out. Its calls keep a failure streak of their own (`GitHub::poll_if_changed`):
//! its answers never tell the server GitHub is up, and only three of its failures in a row say it's
//! down.
//!
//! The seen ids and the ETag live in memory: a restart reads each feed afresh.

use crate::App;
use crate::edges::{Kind, ReadBack, Subject};
use crate::github::{CallError, Fetched};
use crate::installations::Scope;
use crate::pulls::Pull;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::Target;

/// GitHub's largest page: the feed is read one page at a time.
const PAGE: usize = 100;

/// How far before this process started a repo's first read still acts on sub-issue events, in
/// seconds.
const BEFORE_START: i64 = 5 * 60;

/// The most pages one read follows before it stops looking for the last read's events: 1,000
/// events. Past it, what's older is the sweeps'.
const MAX_PAGES: usize = 10;

/// What the poller keeps of each repo's feed.
pub(crate) struct Feed {
    /// When this process started, Unix seconds.
    started: i64,
    repos: Mutex<HashMap<i64, Seen>>,
}

#[derive(Default)]
struct Seen {
    etag: Option<String>,
    /// The ids on the pages last read.
    ids: HashSet<i64>,
}

impl Default for Feed {
    fn default() -> Self {
        Feed {
            started: crate::now(),
            repos: Mutex::default(),
        }
    }
}

impl Feed {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<i64, Seen>) -> T) -> T {
        f(&mut self.repos.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[derive(Deserialize)]
struct Event {
    id: i64,
    #[serde(default)]
    event: String,
    created_at: Option<String>,
    issue: Option<EventIssue>,
}

#[derive(Deserialize)]
struct EventIssue {
    id: i64,
    #[serde(default)]
    node_id: String,
    number: i64,
    pull_request: Option<serde_json::Value>,
}

/// Whether any active account syncing `t` has a live stream open.
pub(crate) fn live(app: &App, t: &Target) -> bool {
    t.accounts.iter().any(|a| app.hub().has_streams(*a))
}

/// The poller: a job (see `jobs.rs`), stopped by the drain at its next await.
pub(crate) async fn poller(app: App) {
    loop {
        tokio::time::sleep(app.reconcile().cfg().feed_every).await;
        // While GitHub is down, nothing to ask.
        if app.github().is_down() {
            continue;
        }
        let targets = match super::targets(&app).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("feed: reading the synced repos: {e}");
                continue;
            }
        };
        let all: HashSet<i64> = targets.values().flatten().map(|t| t.id).collect();
        app.reconcile()
            .feed
            .with(|r| r.retain(|id, _| all.contains(id)));
        for (&installation, ts) in targets.iter() {
            for t in ts.iter().filter(|t| live(&app, t)) {
                // Down since the last repo's read: only the down-probe says when it's back.
                if app.github().is_down() {
                    break;
                }
                if let Err(e) = poll(&app, installation, t, true).await {
                    eprintln!("feed: {}/{}: {e}", t.owner, t.name);
                }
            }
        }
    }
}

/// Reads `t`'s feed once, with `installation`'s token, and acts on what's new: sub-issue events
/// too with `sub_issues`. Skipped while the installation's background reads hold off (`Budget`).
pub(crate) async fn poll(
    app: &App,
    installation: i64,
    t: &Target,
    sub_issues: bool,
) -> Result<(), String> {
    let r = app.reconcile();
    let b = r.budget(installation);
    if b.paused().is_some() {
        return Ok(());
    }
    if b.holds_off_core() {
        // Low until its reset, as last read: asked again now and then (`/rate_limit` costs
        // nothing), as the sweeps do, so polling resumes once other work stops spending it.
        if b.read
            .is_none_or(|t| t.elapsed() >= super::sweep::BUDGET_FRESH)
        {
            super::Sweeper::new(app.clone(), installation)
                .read_budget()
                .await;
        }
        if r.budget(installation).holds_off_core() {
            return Ok(());
        }
    }
    let installations = app.installations();
    let token = installations
        .token(installation, Scope::ReadBack)
        .await
        .map_err(|e| e.to_string())?;
    let feed = &r.feed;
    let (etag, before, cold) = feed.with(|r| match r.get(&t.id) {
        Some(s) => (s.etag.clone(), s.ids.clone(), false),
        None => (None, HashSet::new(), true),
    });
    let path = |page: usize| {
        format!(
            "/repos/{}/{}/issues/events?per_page={PAGE}&page={page}",
            t.owner, t.name
        )
    };
    let mut events: Vec<Event> = Vec::new();
    let mut first_etag = None;
    for page in 1..=MAX_PAGES {
        let asked = if page == 1 { etag.as_deref() } else { None };
        let read = app
            .github()
            .poll_if_changed(&token, &path(page), asked)
            .await;
        let (fetched, more) = match read {
            Ok((f, quota, more)) => {
                if let Some(q) = quota {
                    r.set_budget(installation, |b| b.core = Some(q));
                }
                (f, more)
            }
            Err(CallError::Unauthorized) => {
                installations.drop_token(installation, Scope::ReadBack, &token);
                return Err("GitHub refused the installation's token".into());
            }
            Err(CallError::RateLimited(w)) => {
                r.pause(installation, w);
                return Err(format!("rate limited for {w:?}"));
            }
            Err(CallError::SecondaryLimit) => {
                r.pause(installation, super::sweep::SECONDARY_WAIT);
                return Err("secondary rate limit".into());
            }
            Err(e) => return Err(e.to_string()),
        };
        let Fetched::Fresh { body, etag } = fetched else {
            return Ok(());
        };
        if page == 1 {
            first_etag = etag;
        }
        let got: Vec<Event> =
            serde_json::from_value(body).map_err(|e| format!("{}: {e}", path(page)))?;
        // The last read's events reached: what follows is older. A cold read has nothing to
        // reach, and acts on its first page only.
        let reached = cold || got.iter().any(|e| before.contains(&e.id));
        events.extend(got);
        if reached || !more {
            break;
        }
        if page == MAX_PAGES {
            eprintln!(
                "feed: {}/{}: over {MAX_PAGES} pages of events since the last read; only the nightly full sweep covers the rest for sidebar links",
                t.owner, t.name
            );
        }
    }
    let started = feed.started;
    let new: Vec<&Event> = feed.with(|r| {
        let seen = r.entry(t.id).or_default();
        let new = events
            .iter()
            .filter(|e| {
                if !cold {
                    return !before.contains(&e.id);
                }
                // A link has no other trace; a sub-issue event older than the start is the
                // sweeps'.
                matches!(e.event.as_str(), "connected" | "disconnected")
                    || e.created_at
                        .as_deref()
                        .and_then(crate::webhook::parse_time)
                        .is_some_and(|at| at >= started - BEFORE_START)
            })
            .collect();
        seen.ids = events.iter().map(|e| e.id).collect();
        seen.etag = first_etag;
        new
    });
    act(app, installation, t, sub_issues, &new);
    Ok(())
}

/// Schedules the read-backs `new` events call for: each PR and issue once, however many of its
/// events are new.
fn act(app: &App, installation: i64, t: &Target, sub_issues: bool, new: &[&Event]) {
    let (mut pulls, mut linked, mut subs) = (HashSet::new(), HashSet::new(), HashSet::new());
    for e in new {
        let Some(issue) = &e.issue else { continue };
        let subject = || Subject {
            id: issue.id,
            node_id: issue.node_id.clone(),
            number: issue.number,
            repo: t.id,
            installation,
        };
        // Each answer lands on its own; nothing waits for it here.
        match e.event.as_str() {
            "connected" | "disconnected" if issue.pull_request.is_some() => {
                if pulls.insert(issue.number) {
                    let pull = Pull {
                        repo: t.id,
                        owner: t.owner.clone(),
                        name: t.name.clone(),
                        number: issue.number,
                        installation,
                    };
                    drop(app.edges().schedule_pull(pull, true));
                }
            }
            "connected" | "disconnected" => {
                if linked.insert(issue.id) {
                    drop(app.edges().schedule(subject(), ReadBack::LinkedPulls, true));
                }
            }
            "sub_issue_added"
            | "sub_issue_removed"
            | "parent_issue_added"
            | "parent_issue_removed"
                if sub_issues && subs.insert(issue.id) =>
            {
                drop(
                    app.edges()
                        .schedule(subject(), ReadBack::Edges(Kind::Sub), true),
                );
            }
            _ => {}
        }
    }
}
