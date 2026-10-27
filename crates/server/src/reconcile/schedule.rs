//! The sweeps' scheduler: every tick, the repairs due, the nightly full sweeps, and one job per
//! installation that sweeps its repos in turn.

use super::resync::resync_account;
use super::*;

/// The sweeps' scheduler: a look at what's due every tick (the first one a tick after the
/// start, once the redelivery job has had its first say), and whenever a full sweep is asked for.
/// A job (see `jobs.rs`): the drain stops it at its next await, and the installations' sweep
/// jobs it started with it.
pub(super) async fn schedule(app: App) {
    loop {
        let tick = app.reconcile().cfg.tick;
        tokio::select! {
            () = tokio::time::sleep(tick) => {}
            () = app.reconcile().wake.notified() => {}
        }
        match self::tick(&app).await {
            Ok(()) => {}
            // The drain sealed the databases, and is about to stop this job.
            Err(e) if e.sealed() => return,
            Err(e) => eprintln!("reconcile: {e}"),
        }
    }
}

/// Where in the day `installation`'s nightly sweep falls: a hash of its id, spread over
/// `every` seconds.
fn slot(installation: i64, every: i64) -> i64 {
    // splitmix64's finaliser: neighbouring ids land far apart.
    let mut x = installation as u64;
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 31;
    (x % every.max(1) as u64) as i64
}

/// When an installation whose last full sweep (or sign of life) was at `last` is next due: its
/// own time of day, at least half of `every` after the last.
fn nightly_due(installation: i64, last: i64, every: i64) -> i64 {
    let every = every.max(1);
    let base = last + every / 2;
    base + (slot(installation, every) - base).rem_euclid(every)
}

/// One look at what's due: repairs, nightly full sweeps, and a job for each installation with
/// none running.
async fn tick(app: &App) -> Result<(), Error> {
    let r = app.reconcile();
    let now = crate::now();
    let marked = app
        .control()
        .read(control_db::q::needs_resync_accounts)
        .await?;
    let after = r.cfg.repair_after.as_secs() as i64;
    for m in marked {
        let account = m.github_user_id;
        // Marked before marks had a time: due now.
        if m.needs_resync_at.unwrap_or(0) + after > now {
            continue;
        }
        let (waiting, left) = r.with(|s| {
            let a = s.accounts.get(&account);
            (
                a.is_some_and(|a| !a.waiting.is_empty()),
                a.and_then(|a| a.repair.as_ref()).map(|r| r.left.clone()),
            )
        });
        match left {
            _ if waiting => {}
            // A repair with repos still owed (each backing off after failing): those due now.
            Some(left) if !left.is_empty() => {
                let due = r.repairable(&left);
                if !due.is_empty() {
                    r.ask_full(&due, Some(account));
                }
            }
            _ => {
                eprintln!("reconcile: account {account} missed changes; repairing it");
                match resync_account(app, account, false).await {
                    Ok(()) => {}
                    Err(e) if e.sealed() => return Err(e),
                    Err(e) => eprintln!("reconcile: account {account}'s repair: {e}"),
                }
            }
        }
    }
    let all = targets(app).await?;
    // A full sweep asked for a repo no sweep reads any more (unsynced, or importing since) is
    // over: the import reads it whole.
    let swept: HashSet<i64> = all.values().flatten().map(|t| t.id).collect();
    let stale: Vec<(i64, BTreeSet<i64>)> = r.with(|s| {
        let gone: Vec<i64> = s
            .full
            .keys()
            .filter(|id| !swept.contains(id))
            .copied()
            .collect();
        let stale = gone
            .into_iter()
            .filter_map(|id| s.full.remove(&id).map(|by| (id, by)))
            .collect();
        // What's kept of repos and installations no sweep reads, and of accounts with nothing
        // under way, goes.
        s.repos.retain(|id, _| swept.contains(id));
        s.suspects.retain(|x| swept.contains(&x.repo));
        s.unlisted_labels.retain(|id, _| swept.contains(id));
        s.failing.retain(|id, _| swept.contains(id));
        s.accounts.retain(|_, a| !a.idle());
        stale
    });
    r.budgets.retain(|i| all.contains_key(&i));
    for (repo, by) in stale {
        r.done_full(app, repo, by, Outcome::Done).await;
    }
    settle(app).await;
    let checkpoints: HashMap<i64, control_db::q::CheckpointsRow> = app
        .control()
        .read(control_db::q::checkpoints)
        .await?
        .into_iter()
        .map(|c| (c.installation_id, c))
        .collect();
    let every = r.cfg.full_every.as_secs() as i64;
    for (installation, ts) in all.iter() {
        let Some(cp) = checkpoints.get(installation) else {
            continue;
        };
        let Some(last) = cp
            .last_full_sweep_at
            .or(cp.last_webhook_at)
            .or(cp.redelivery_checked_at)
        else {
            continue;
        };
        // One still pending (a repo of it keeps failing) covers the nights until the next is
        // due: then every repo is asked for again, so the others aren't held back by it.
        let asked = r.with(|s| s.whole.get(installation).map(|w| w.asked));
        let last = asked.map_or(last, |a| a.max(last));
        if nightly_due(*installation, last, every) <= now {
            eprintln!("reconcile: installation {installation}: its nightly full sweep");
            let repos: Vec<i64> = ts.iter().map(|t| t.id).collect();
            r.ask_installation(*installation, &repos, now);
        }
    }
    // A repo whose sweep failed keeps its installation's sweep from being done: it's swept again
    // once its backoff has passed.
    let at = Instant::now();
    for (installation, ts) in all.iter() {
        let due: Vec<i64> = r.with(|s| {
            if !s.whole.contains_key(installation) {
                return Vec::new();
            }
            ts.iter()
                .map(|t| t.id)
                .filter(|id| !s.full.contains_key(id))
                .filter(|id| s.failing.get(id).is_some_and(|f| f.until <= at))
                .collect()
        });
        if !due.is_empty() {
            r.ask_full(&due, None);
        }
    }
    for (installation, ts) in all.iter() {
        let installation = *installation;
        if r.with(|s| s.busy.insert(installation)) {
            let ts = ts.clone();
            app.spawn(move |app| async move {
                // Its own job: a panic ends this one, not the scheduler.
                let job = app.spawn(move |app| job(app, installation, ts));
                if let Err(e) = job.await {
                    eprintln!("reconcile: installation {installation}'s sweeps panicked: {e}");
                }
                app.reconcile().with(|s| s.busy.remove(&installation));
            });
        }
    }
    Ok(())
}

/// Settles the suspects whose grace is over: one whose ends no delivery (nor its read-back) has
/// stamped since the sweep wrote them was missed by the webhooks.
async fn settle(app: &App) {
    let r = app.reconcile();
    let now = Instant::now();
    let due: Vec<Suspect> = r.with(|s| {
        let (due, wait) = std::mem::take(&mut s.suspects)
            .into_iter()
            .partition(|x| x.due <= now);
        s.suspects = wait;
        due
    });
    for x in due {
        let (touched, seq) = (x.touched, x.seq);
        let landed = app
            .mirrors()
            .read(x.account, mirror_db::Caller::Sweep, move |c| {
                match &touched {
                    Touched::Ends(ids) => {
                        for &id in ids {
                            if mirror_db::q::edges_seq(c, id)? > seq {
                                return Ok(true);
                            }
                        }
                    }
                    Touched::Labels(ids) => {
                        for &id in ids {
                            if mirror_db::q::label_landed(c, id, seq)? {
                                return Ok(true);
                            }
                        }
                    }
                }
                Ok(false)
            })
            .await;
        match landed {
            Ok(false) => r.missed(app, x.account, x.repo),
            Ok(true) => {}
            Err(e) => eprintln!(
                "reconcile: account {}: settling a sweep's changes: {e}",
                x.account
            ),
        }
    }
}

/// One full sweep of `t`, once one of the [`ReconcileConfig::full_sweeps_at_once`] slots is
/// free. False when the drain's seal cut it short.
async fn full_sweep(app: &App, sweeper: &Sweeper, t: &Target, by: BTreeSet<i64>) -> bool {
    let r = app.reconcile();
    let _slot = r.full_slots.acquire().await;
    let started = Instant::now();
    let outcome = match sweeper.full(t).await {
        Ok(missed) => {
            eprintln!(
                "reconcile: {}/{}: full sweep in {} ms",
                t.owner,
                t.name,
                started.elapsed().as_millis()
            );
            for a in t.accounts.iter().filter(|a| !missed.contains(a)) {
                r.clean(app, *a, t.id);
            }
            Outcome::Done
        }
        // Asked again at the next start: by the marks it leaves, redelivery and the sweeps' own
        // clocks.
        Err(sweep::Stop::Sealed) => Outcome::Cut,
        Err(sweep::Stop::Failed(e)) => {
            eprintln!("reconcile: {}/{}: full sweep failed: {e}", t.owner, t.name);
            Outcome::Failed
        }
    };
    r.done_full(app, t.id, by, outcome).await;
    if outcome == Outcome::Cut {
        return false;
    }
    r.with(|s| {
        let c = s.repos.entry(t.id).or_default();
        let now = Instant::now();
        c.probed = Some(now);
        c.counted = Some(now);
    });
    true
}

/// `installation`'s repo `id` as sweeps read it now: `None` once no active account syncs it
/// (or the targets can't be read).
async fn current(app: &App, installation: i64, id: i64) -> Option<Target> {
    targets(app)
        .await
        .ok()?
        .get(&installation)?
        .iter()
        .find(|t| t.id == id)
        .cloned()
}

/// One installation's due sweeps, repo by repo. Each repo is looked up again before it's swept:
/// one unsynced while the round runs gets nothing more from it.
async fn job(app: App, installation: i64, targets: Vec<Target>) {
    let r = app.reconcile();
    let sweeper = Sweeper::new(app.clone(), installation);
    let (probe_every, count_every) = (r.cfg.probe_every, r.cfg.count_every);
    let mut counts = Vec::new();
    for id in targets.iter().map(|t| t.id) {
        let Some(t) = current(&app, installation, id).await else {
            continue;
        };
        if let Some(by) = r.take_full(t.id) {
            if !full_sweep(&app, &sweeper, &t, by).await {
                return;
            }
            continue;
        }
        let clock = r.with(|s| s.repos.get(&t.id).copied().unwrap_or_default());
        if clock.probed.is_none_or(|p| p.elapsed() >= probe_every) {
            match sweeper.probe(&t).await {
                Ok(()) | Err(sweep::Stop::Failed(_)) => {}
                Err(sweep::Stop::Sealed) => return,
            }
            // A repo with a live stream has its feed read every couple of seconds already.
            if !super::feed::live(&app, &t)
                && let Err(e) = super::feed::poll(&app, installation, &t, false).await
            {
                eprintln!("reconcile: {}/{}: its events feed: {e}", t.owner, t.name);
            }
            r.with(|s| s.repos.entry(t.id).or_default().probed = Some(Instant::now()));
        }
        // Every repo, idle or not: what the mirror's own writes show can't tell a repo GitHub
        // changed without a webhook (a reorder, a lost deletion), and both cost about a GraphQL
        // point per 100 repos or parents.
        if clock.counted.is_none_or(|c| c.elapsed() >= count_every) {
            counts.push(t.id);
        }
    }
    if !counts.is_empty() {
        let mut ts = Vec::new();
        for &id in &counts {
            ts.extend(current(&app, installation, id).await);
        }
        let refs: Vec<&Target> = ts.iter().collect();
        match sweeper.counts(&refs).await {
            Ok(mismatched) => {
                for &id in &counts {
                    let Some(c) = mismatched.get(&id) else {
                        continue;
                    };
                    let Some(t) = current(&app, installation, id).await else {
                        continue;
                    };
                    // The same mismatch as at the last id sweep, which didn't settle it (GitHub
                    // counts what its id lists don't show, say): sweeping again won't either.
                    if r.with(|s| s.repos.get(&id).and_then(|c| c.id_swept)) == Some(*c) {
                        continue;
                    }
                    eprintln!("reconcile: {}/{}: {c}; sweeping its ids", t.owner, t.name);
                    if let Err(sweep::Stop::Sealed) = sweeper.id_sweep(&t).await {
                        return;
                    }
                    r.with(|s| s.repos.entry(id).or_default().id_swept = Some(*c));
                }
            }
            Err(sweep::Stop::Sealed) => return,
            Err(sweep::Stop::Failed(e)) => eprintln!("reconcile: the count check failed: {e}"),
        }
        for id in counts {
            let Some(t) = current(&app, installation, id).await else {
                continue;
            };
            if let Err(sweep::Stop::Sealed) = sweeper.order(&t).await {
                return;
            }
            r.with(|s| s.repos.entry(id).or_default().counted = Some(Instant::now()));
        }
    }
    // Every repo of an installation asked for at once is done (none still asked for, none
    // failed): its checkpoint.
    let finished = r.with(|s| {
        let pending = targets
            .iter()
            .any(|t| s.full.contains_key(&t.id) || s.failing.contains_key(&t.id));
        match s.whole.get(&installation) {
            Some(w) if !pending => {
                let at = w.at;
                s.whole.remove(&installation);
                Some(at)
            }
            _ => None,
        }
    });
    if let Some(at) = finished
        && let Err(e) = app
            .control()
            .write(move |tx| control_db::q::set_full_sweep(tx, installation, at))
            .await
    {
        eprintln!("reconcile: installation {installation}'s checkpoint: {e}");
    }
}
