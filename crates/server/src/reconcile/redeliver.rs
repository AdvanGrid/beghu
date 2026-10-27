//! The redelivery job, GitHub's documented pattern
//! (`/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook`):
//! list the App's deliveries back to where each installation was last checked, group them by
//! GUID, and redeliver every GUID with no OK attempt that never reached beghu. Its first run, at
//! startup, covers the downtime.
//!
//! A GUID asked for (or refused) stays outstanding until a later run sees it arrive: the next
//! run reads the log back to the oldest outstanding one, so a redelivery that fails is asked for
//! again.
//!
//! An installation gets a full sweep of its repos instead when redelivery can't be trusted to
//! cover its gap: its oldest unrecovered delivery is older than `outage_after` (2.5 days, inside
//! GitHub's 3-day log, so nothing expires mid-way), or it hasn't been checked for that long
//! (deliveries from then may already be gone), or, at startup, it has no checkpoint at all. So
//! does one with more unrecovered deliveries than `redeliver_cap`: a sweep costs less than a
//! storm of redeliveries. So does one with a delivery gone from the log by the time it's asked
//! for (a 404). A run asks for at most `redeliver_cap` redeliveries in all, and stops asking at
//! GitHub's rate limit, waiting it out before the next run.
//!
//! An installation whose full sweep of every repo is still owed keeps its checkpoint until it's
//! done (which then counts as checked to where it began), so a restart, which forgets the sweep,
//! finds the reason for it again.

use super::Error;
use crate::App;
use crate::webhook::parse_time;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

/// How far back the first check of an installation looks: GitHub's sample's day.
const FIRST_LOOK: i64 = 24 * 60 * 60;

/// The redelivery job: a run now, then every [`ReconcileConfig::redeliver_every`]. A job (see
/// `jobs.rs`): a run cut at an await leaves the checkpoints as the last whole run wrote them, so
/// the next start reads the log from there again.
///
/// [`ReconcileConfig::redeliver_every`]: crate::config::ReconcileConfig::redeliver_every
pub(super) async fn job(app: App) {
    let mut startup = true;
    loop {
        let limited = match run(&app, startup).await {
            Ok(limited) => limited,
            // The drain sealed the databases, and is about to stop this job.
            Err(e) if e.sealed() => return,
            Err(Error::GitHub(crate::github::Error::RateLimited(wait))) => {
                eprintln!(
                    "redelivery: GitHub's rate limit; waiting {} s",
                    wait.as_secs()
                );
                Some(wait)
            }
            Err(e) => {
                eprintln!("redelivery: {e}");
                None
            }
        };
        startup = false;
        let every = app.reconcile().cfg().redeliver_every;
        tokio::time::sleep(every.max(limited.unwrap_or_default())).await;
    }
}

/// One GUID's attempts, as the log has them.
#[derive(Default)]
struct Guid {
    ok: bool,
    /// The newest attempt: what a redelivery names.
    newest: Option<(i64, i64)>,
    /// When the first attempt was made.
    oldest: Option<i64>,
    installation: Option<i64>,
}

/// A delivery that never reached beghu: when GitHub first tried it, the attempt a redelivery
/// names, and its GUID. Ordered oldest first.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Missed {
    oldest: i64,
    attempt: i64,
    guid: String,
}

/// One run. `Some(wait)` when GitHub's rate limit stopped it short: the next run waits that out.
async fn run(app: &App, startup: bool) -> Result<Option<Duration>, Error> {
    let now = crate::now();
    let cfg = app.reconcile().cfg().clone();
    let outage = cfg.outage_after.as_secs() as i64;
    let overlap = cfg.redeliver_overlap.as_secs() as i64;
    let targets = super::targets(app).await?;
    let repos: BTreeMap<i64, Vec<i64>> = targets
        .iter()
        .map(|(i, ts)| (*i, ts.iter().map(|t| t.id).collect()))
        .collect();
    let checkpoints: HashMap<i64, control_db::q::CheckpointsRow> = app
        .control()
        .read(control_db::q::checkpoints)
        .await?
        .into_iter()
        .map(|c| (c.installation_id, c))
        .collect();
    // From when each installation's deliveries are read, and which get a full sweep instead.
    let mut from: HashMap<i64, i64> = HashMap::new();
    let mut sweep: BTreeSet<i64> = BTreeSet::new();
    for installation in repos.keys() {
        let cp = checkpoints.get(installation);
        // A full sweep of every repo covers what came before it began.
        let checked = cp.and_then(|c| {
            c.redelivery_checked_at
                .max(c.last_full_sweep_at)
                .or(c.last_webhook_at)
        });
        match checked {
            None if startup && cp.and_then(|c| c.last_full_sweep_at).is_none() => {
                eprintln!(
                    "redelivery: installation {installation} has no checkpoint; sweeping it whole"
                );
                sweep.insert(*installation);
            }
            None => {
                from.insert(*installation, now - FIRST_LOOK);
            }
            Some(t) if now - t > outage => {
                eprintln!(
                    "redelivery: installation {installation} unchecked for {} h; sweeping it whole",
                    (now - t) / 3600
                );
                sweep.insert(*installation);
            }
            Some(t) => {
                let outstanding = cp.and_then(|c| c.redelivery_from).unwrap_or(t);
                from.insert(*installation, outstanding.min(t) - overlap);
            }
        }
    }
    // The oldest delivery each installation still waits to see arrive.
    let mut outstanding: HashMap<i64, i64> = HashMap::new();
    let mut limited = None;
    let mut redelivered = 0;
    if let Some(cutoff) = from.values().min().copied() {
        let failed = missed(app, &from, cutoff).await?;
        let gh = app.github();
        let mut left = cfg.redeliver_cap;
        for (installation, list) in failed {
            if list.first().is_some_and(|m| now - m.oldest > outage) {
                eprintln!(
                    "redelivery: installation {installation}'s oldest missed delivery is over {} h old; sweeping it whole",
                    outage / 3600
                );
                sweep.insert(installation);
                continue;
            }
            if list.len() > cfg.redeliver_cap {
                eprintln!(
                    "redelivery: installation {installation} missed {} deliveries, over {}; sweeping it whole",
                    list.len(),
                    cfg.redeliver_cap
                );
                sweep.insert(installation);
                continue;
            }
            for m in list {
                if sweep.contains(&installation) {
                    break;
                }
                if limited.is_some() || left == 0 {
                    // Asked for by a later run.
                    outstanding.entry(installation).or_insert(m.oldest);
                    continue;
                }
                // A JWT lives for minutes; minted for each call, it never expires mid-run.
                let asked = match app.installations().jwt() {
                    Ok(jwt) => gh.redeliver(&jwt, m.attempt).await,
                    Err(e) => Err(e),
                };
                match asked {
                    Ok(()) => {
                        redelivered += 1;
                        left -= 1;
                    }
                    // Gone from the log since it was listed: what it held comes only from a sweep.
                    Err(crate::github::Error::Status(404)) => {
                        eprintln!(
                            "redelivery: {} is gone from GitHub's log; sweeping installation {installation} whole",
                            m.guid
                        );
                        sweep.insert(installation);
                        continue;
                    }
                    Err(crate::github::Error::RateLimited(wait)) => {
                        eprintln!(
                            "redelivery: GitHub's rate limit while redelivering; the rest wait {} s",
                            wait.as_secs()
                        );
                        limited = Some(wait);
                    }
                    Err(e) => eprintln!("redelivery: redelivering {}: {e}", m.guid),
                }
                // Outstanding until a later run sees it arrive.
                outstanding.entry(installation).or_insert(m.oldest);
            }
        }
    }
    if redelivered > 0 {
        eprintln!("redelivery: asked GitHub to redeliver {redelivered} deliveries");
    }
    let r = app.reconcile();
    for installation in &sweep {
        outstanding.remove(installation);
        // Asked for already, and still owed: once is enough.
        if let Some(repos) = repos.get(installation)
            && !r.with(|s| s.whole.contains_key(installation))
        {
            r.ask_installation(*installation, repos, now);
        }
    }
    // One that still owes a full sweep isn't checked past what it owes it for: a restart, which
    // forgets the sweep, finds the reason again.
    let checked: Vec<i64> = r.with(|s| {
        repos
            .keys()
            .filter(|i| !s.whole.contains_key(i))
            .copied()
            .collect()
    });
    app.control()
        .write(move |tx| {
            for i in checked {
                control_db::q::set_redelivery_checked(tx, i, now, outstanding.get(&i).copied())?;
            }
            Ok(())
        })
        .await?;
    Ok(limited)
}

/// The deliveries since `from` (per installation) that never reached beghu, by installation,
/// oldest first. The log is read back, newest first, to `cutoff`.
async fn missed(
    app: &App,
    from: &HashMap<i64, i64>,
    cutoff: i64,
) -> Result<BTreeMap<i64, Vec<Missed>>, Error> {
    let gh = app.github();
    let mut guids: HashMap<String, Guid> = HashMap::new();
    let mut cursor: Option<String> = None;
    loop {
        let jwt = app.installations().jwt()?;
        let (page, next) = gh.hook_deliveries(&jwt, cursor.as_deref()).await?;
        let mut older = false;
        for d in &page {
            let at = parse_time(&d.delivered_at).unwrap_or(0);
            older |= at < cutoff;
            let g = guids.entry(d.guid.clone()).or_default();
            g.ok |= d.status == "OK";
            if g.newest.is_none_or(|(_, t)| at > t) {
                g.newest = Some((d.id, at));
            }
            g.oldest = Some(g.oldest.map_or(at, |o| o.min(at)));
            g.installation = g.installation.or(d.installation_id);
        }
        match next {
            Some(n) if !older && !page.is_empty() => cursor = Some(n),
            _ => break,
        }
    }
    let mut failed: BTreeMap<i64, Vec<Missed>> = BTreeMap::new();
    for (guid, g) in guids {
        let (Some(installation), Some((attempt, _)), Some(oldest)) =
            (g.installation, g.newest, g.oldest)
        else {
            continue;
        };
        let Some(since) = from.get(&installation) else {
            continue;
        };
        if g.ok || oldest < *since {
            continue;
        }
        let gu = guid.clone();
        let received = app
            .control()
            .read(move |c| control_db::q::delivery_received(c, &gu))
            .await?;
        if !received {
            failed.entry(installation).or_default().push(Missed {
                oldest,
                attempt,
                guid,
            });
        }
    }
    for list in failed.values_mut() {
        list.sort();
    }
    Ok(failed)
}
