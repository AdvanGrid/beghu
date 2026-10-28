//! `POST /webhook`: GitHub's deliveries. The handler checks the signature, records the delivery
//! (deduped by `X-GitHub-Delivery`), answers 2xx at once and queues it. A delivery acked but not
//! yet processed when the process stopped is still `processed_at IS NULL` in the control DB, and
//! [`resume`] queues it again at startup.
//!
//! Applying fans out: a dispatcher reads each delivery once, in the order received, and hands it
//! to a lane per active connected account that syncs its repo. Each lane writes its account's
//! mirror in delivery order, one transaction (one `seq`) per delivery, followed by one push to
//! that account's streams; lanes run independently, so a slow or failing mirror holds up only its
//! own account. A failed write marks that account `needs_resync` (its status slot says sync is
//! degraded, and a sweep repairs it: `reconcile.rs`) and its lane carries on. The
//! last lane to finish a delivery marks it processed, which clears its payload (a relationship
//! delivery waits first for the read-back it schedules to land or be given up, so a process that
//! stops in between replays it at the next start); processed
//! deliveries are kept [`Config::deliveries_kept_for`](crate::Config) (GitHub's three-day
//! redelivery window and a day's margin) to dedupe redeliveries, then pruned. Deliveries GitHub
//! couldn't make (beghu down, or the answer lost) come back through the redelivery job
//! (`reconcile/redeliver.rs`).
//!
//! Order holds through a failing control DB: each call that decides what happens next (who a
//! delivery fans out to, marking an account `needs_resync`) is retried until it lands, and the
//! dispatcher or the lane waits on it, so nothing behind it is applied first. Marking a delivery
//! processed is retried the same way, off to the side. A lane's queue is bounded: a delivery that
//! finds it full is dropped for that account, which is marked `needs_resync` instead.
//!
//! A delivery is in flight from its ack (or its requeue) until it's processed or given up. A lane
//! that dies (a panic) gives up what it held: those deliveries stay unprocessed, the account is
//! marked `needs_resync`, and a fresh lane takes its next deliveries. Every minute, any delivery
//! unprocessed for over 30 s and not in flight is queued again, so nothing waits for a restart.
//!
//! Handled here: `issues`, `issue_comment`, `label`, `milestone`, `repository`, the
//! relationship events `sub_issues`, `issue_dependencies` and `issue_relates_to` (see `edges.rs`),
//! and a PR's `pull_request` and `pull_request_review`, which write nothing themselves: the PR is
//! read back at once, its own fields and the issues it closes (`pulls.rs`). Comments and
//! milestones are guarded by `updated_at` (newer or equal wins), so a replay or an
//! older delivery that arrives late changes nothing. Items too, but `updated_at` is in whole
//! seconds and picks made within one share it, so an equal one is applied only when it says what
//! the mirror has (a replay: nothing to do); `labeled`, `unlabeled`, `assigned` and `unassigned`
//! apply only the one label or assignee they name; and what can't be ordered is read again from
//! GitHub (see [`upsert_issue`]). A webhook delete is recorded, and an older delivery that arrives
//! after it never brings the row back. Labels carry no `updated_at`: a `label` delivery sets the
//! label as it is now (the last one applied wins), and an issue's payload only adds the labels the
//! mirror lacks, never renames one, since it may predate a rename. Two renames of one label
//! delivered out of order leave the older name until a sweep. `installation` and
//! `installation_repositories` go to the accounts' re-read of their visible repos (repos.rs), which
//! unsyncs what the App no longer reaches. `github_app_authorization` `revoked` (a user revoked
//! beghu in GitHub's settings) sends a connected account down the lost-access path (accounts.rs).
//! Other events are acked and dropped until their slices handle them.
//!
//! The rare ones (docs/research/issue-edge-cases.md): a transfer comes as `issues.opened` with
//! `changes.old_issue` in the new repo and `issues.transferred` in the old one, in either order
//! (GitHub sends `opened` first), and either one applies it whole ([`transfer`]): the new issue
//! written, every relationship of the old id moved onto it (GitHub sends no `sub_issues`
//! delivery for them), the old id deleted for good and recorded as moved, which the detail
//! answers with; then the new issue's thread is read back from GitHub (`edges.rs`), since whether
//! GitHub keeps the comments' ids is unmeasured. The other one then finds it done. A conversion to a discussion is just
//! `issues.locked` and `issues.closed`. `repository` `archived` and `unarchived` set the repo's
//! flag. Payloads are parsed leniently: GitHub keeps adding fields, and unknown ones are ignored.

use crate::App;
use crate::edges::{self, Edge, Kind, ReadBack, Refetcher, Subject};
use crate::jobs::Jobs;
use crate::live::{Hub, Push};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use control_db::Control;
use hmac::{Hmac, Mac};
use mirror_db::{Caller, Mirrors, q};
use rusqlite::Transaction;
use serde::Deserialize;
use sha2::Sha256;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// GitHub's payloads go up to 25 MB.
pub const MAX_BODY: usize = 25 * 1024 * 1024;

/// Past this many ids, a push is a `reset`: the tab refetches what it shows either way, and the
/// event stays small.
pub(crate) const MAX_IDS: usize = 256;

/// The waits between the first tries of a failing control-DB call (about 8 s in all, on top of
/// each try's own busy timeout); after them, it's tried every [`RETRY_EVERY`] until it lands.
const RETRIES: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const RETRY_EVERY: Duration = Duration::from_secs(30);

/// How many deliveries a lane holds before the next one for its account is dropped and the
/// account marked `needs_resync`.
const LANE_QUEUE: usize = 1024;

/// How often unprocessed deliveries that nothing holds are queued again, and how long one must
/// have waited first (so one that is between its ack and the queue is never taken twice).
const REQUEUE_EVERY: Duration = Duration::from_secs(60);
const REQUEUE_AFTER: Duration = Duration::from_secs(30);

/// How often processed deliveries past their keep are pruned (also once at startup).
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);

/// One stored delivery, on its way to the dispatcher.
pub struct Delivery {
    guid: String,
    event: String,
    payload: Vec<u8>,
    /// When beghu received it, in Unix milliseconds; one read back from the control DB, which
    /// keeps seconds, counts from the start of its second (the earliest it can have come in).
    received_at: i64,
}

/// The GUIDs of the deliveries this process holds: queued, being applied, or being marked
/// processed. What the requeue leaves alone. Each holder counts: a webhook request holds its
/// GUID from before storing it, and two requests can carry the same GUID at once.
#[derive(Default)]
struct InFlight(Mutex<HashMap<String, usize>>);

impl InFlight {
    /// Takes `guid` if nothing holds it; false if something does.
    fn claim(&self, guid: &str) -> bool {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if held.contains_key(guid) {
            return false;
        }
        held.insert(guid.to_owned(), 1);
        true
    }

    /// Holds `guid` alongside anything else that does.
    fn hold(&self, guid: &str) {
        *self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(guid.to_owned())
            .or_default() += 1;
    }

    /// Lets go of one hold on `guid`.
    fn release(&self, guid: &str) {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = held.get_mut(guid) {
            *n -= 1;
            if *n == 0 {
                held.remove(guid);
            }
        }
    }
}

/// Queues `d` for the dispatcher, which releases its hold once it's done. If the dispatcher has
/// stopped (the server is shutting down), says so and lets go of the hold: the delivery stays
/// unprocessed in the control DB for the next start.
fn enqueue(tx: &mpsc::UnboundedSender<Delivery>, in_flight: &InFlight, d: Delivery) {
    if let Err(mpsc::error::SendError(d)) = tx.send(d) {
        eprintln!(
            "webhooks: the dispatcher has stopped; {} waits for the next start",
            d.guid
        );
        in_flight.release(&d.guid);
    }
}

/// The queue into the dispatcher. Made before the server serves, so a delivery that comes in
/// before [`resume`] waits in it, behind the ones [`resume`] puts first. The drain stops the
/// dispatcher, its lanes, the requeue and the pruning (they're jobs); anything not finished stays
/// unprocessed in the control DB for the next start.
pub struct Queue {
    tx: mpsc::UnboundedSender<Delivery>,
    in_flight: Arc<InFlight>,
    /// The dispatcher's end, until [`resume`] starts it.
    rx: Mutex<Option<mpsc::UnboundedReceiver<Delivery>>>,
}

impl Queue {
    pub fn new() -> Queue {
        let (tx, rx) = mpsc::unbounded_channel();
        Queue {
            tx,
            in_flight: Arc::default(),
            rx: Mutex::new(Some(rx)),
        }
    }
}

/// What applying a delivery writes to and pushes through.
#[derive(Clone)]
pub struct Sinks {
    pub control: Arc<Control>,
    pub mirrors: Mirrors,
    pub hub: Arc<Hub>,
    /// Where installation changes go: the accounts' repo re-reads (repos.rs) follow them.
    pub installs: mpsc::UnboundedSender<InstallChange>,
    /// Where an account that revoked its authorization goes (`accounts::lost_access`).
    pub lost: crate::tokens::Lost,
    /// Reads relationships back from GitHub after their deliveries.
    pub edges: Arc<Refetcher>,
    /// What the dispatcher, its lanes and their settles run as.
    pub jobs: Jobs,
    /// The app, for measuring a post's images before its push (`media/probe.rs`).
    pub app: Option<crate::App>,
}

/// An `installation` or `installation_repositories` delivery: the App's reach changed. Its rows
/// come and go through the accounts' re-read of their visible repos, never as deletes recorded
/// in `deleted`, since installing again brings back the same ids.
#[derive(Debug)]
pub struct InstallChange {
    /// The repos the App no longer reaches through the installation.
    pub removed: Vec<i64>,
    /// Who made the change (installed, suspended, picked its repos): their repos are re-read at
    /// once, so the picker they're on shows it.
    pub sender: Option<i64>,
}

impl InstallChange {
    fn parse(event: &str, payload: &[u8]) -> Option<InstallChange> {
        #[derive(Deserialize)]
        struct Repo {
            id: i64,
        }
        #[derive(Deserialize)]
        struct Sender {
            id: i64,
        }
        #[derive(Deserialize)]
        struct P {
            #[serde(default)]
            action: String,
            sender: Option<Sender>,
            #[serde(default)]
            repositories: Vec<Repo>,
            #[serde(default)]
            repositories_removed: Vec<Repo>,
        }
        let p: P = serde_json::from_slice(payload).ok()?;
        let removed = match (event, p.action.as_str()) {
            ("installation", "deleted" | "suspend") => p.repositories,
            ("installation_repositories", "removed") => p.repositories_removed,
            ("installation" | "installation_repositories", _) => Vec::new(),
            _ => return None,
        };
        Some(InstallChange {
            removed: removed.into_iter().map(|r| r.id).collect(),
            sender: p.sender.map(|s| s.id),
        })
    }
}

/// The user who revoked the App's authorization, from a `github_app_authorization` `revoked`
/// delivery: their tokens no longer work.
fn revoked_by(event: &str, payload: &[u8]) -> Option<i64> {
    #[derive(Deserialize)]
    struct Sender {
        id: i64,
    }
    #[derive(Deserialize)]
    struct P {
        action: String,
        sender: Sender,
    }
    if event != "github_app_authorization" {
        return None;
    }
    let p: P = serde_json::from_slice(payload).ok()?;
    (p.action == "revoked").then_some(p.sender.id)
}

/// A connected account revoked beghu's authorization: it lost access. Marked only if it's active
/// and its tokens were issued before beghu received the revoke (`received_at`, Unix ms): a revoke
/// applied late, or replayed at startup, after the account signed in again is about the old
/// grant and leaves the new one alone. Anyone else (never signed in to beghu) is nothing to
/// beghu. Retried until the control DB takes it, so nothing behind it is applied first.
async fn revoked(sinks: &Sinks, account: i64, received_at: i64) {
    let control = sinks.control.clone();
    let marked = until_ok("marking an account that revoked beghu", || {
        let control = control.clone();
        async move {
            control
                .write(move |tx| {
                    let marked =
                        control_db::q::lose_access_if_issued_before(tx, account, received_at)? > 0;
                    if marked {
                        control_db::q::revoke_tokens(tx, account)?;
                    }
                    Ok(marked)
                })
                .await
        }
    })
    .await;
    if marked {
        let _ = sinks.lost.send(account);
    }
}

/// Starts the dispatcher with every delivery acked but not processed before this start first,
/// oldest first, ahead of any that came in since the server began serving (those wait in the
/// queue, which holds them, so they aren't taken twice). An unprocessed delivery that a request
/// holds at that moment (GitHub redelivering it, between the request's hold and its finding the
/// delivery already stored) is skipped too, and waits for the requeue, up to a minute. Then
/// the requeue, and the pruning of processed deliveries older than `kept_for`. They all run as
/// jobs, which the drain stops; what they leave unprocessed waits in the control DB for the next
/// start. Called once, after the server serves.
pub async fn resume(
    queue: &Queue,
    sinks: Sinks,
    kept_for: Duration,
) -> Result<(), control_db::Error> {
    let rx = queue
        .rx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .expect("the dispatcher resumes once");
    let pending = sinks
        .control
        .read(|c| control_db::q::pending_deliveries(c, i64::MAX))
        .await?;
    let in_flight = queue.in_flight.clone();
    // One a request holds came in since the server began serving: it's in the queue, or (a
    // redelivery of one already stored) left for the requeue.
    let resumed: Vec<Delivery> = pending
        .into_iter()
        .filter(|d| in_flight.claim(&d.guid))
        .map(|d| Delivery {
            guid: d.guid,
            event: d.event,
            payload: d.payload,
            received_at: d.received_at * 1000,
        })
        .collect();
    if !resumed.is_empty() {
        eprintln!(
            "webhooks: resuming {} unprocessed deliveries",
            resumed.len()
        );
    }
    let jobs = sinks.jobs.clone();
    let control = sinks.control.clone();
    jobs.spawn(async move {
        loop {
            prune(&control, kept_for).await;
            tokio::time::sleep(PRUNE_EVERY).await;
        }
    });
    jobs.spawn(requeue(
        sinks.control.clone(),
        in_flight.clone(),
        queue.tx.clone(),
    ));
    jobs.spawn(dispatch(sinks, in_flight, resumed, rx));
    Ok(())
}

/// Deletes the processed deliveries received more than `kept_for` ago: past GitHub's
/// redelivery window, their GUIDs no longer need deduping.
async fn prune(control: &Control, kept_for: Duration) {
    let before = crate::now() - kept_for.as_secs() as i64;
    match control
        .write(move |tx| control_db::q::prune_deliveries(tx, before))
        .await
    {
        Ok(0) => {}
        Ok(n) => eprintln!("webhooks: pruned {n} processed deliveries"),
        Err(e) => eprintln!("webhooks: pruning deliveries failed: {e}"),
    }
}

/// Every [`REQUEUE_EVERY`], queues again each delivery unprocessed for over [`REQUEUE_AFTER`]
/// that nothing in this process holds: one a lane gave up, oldest first.
async fn requeue(
    control: Arc<Control>,
    in_flight: Arc<InFlight>,
    tx: mpsc::UnboundedSender<Delivery>,
) {
    loop {
        tokio::time::sleep(REQUEUE_EVERY).await;
        let before = crate::now() - REQUEUE_AFTER.as_secs() as i64;
        let pending = match control
            .read(move |c| control_db::q::pending_delivery_guids(c, before))
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("webhooks: reading unprocessed deliveries failed: {e}");
                continue;
            }
        };
        // Only the deliveries it takes are read in full: the rest are on their way already.
        for guid in pending {
            if !in_flight.claim(&guid) {
                continue;
            }
            let g = guid.clone();
            match control
                .read(move |c| control_db::q::pending_delivery(c, &g))
                .await
            {
                Ok(Some(d)) => {
                    eprintln!("webhooks: queueing {} {guid} again", d.event);
                    enqueue(
                        &tx,
                        &in_flight,
                        Delivery {
                            guid,
                            event: d.event,
                            payload: d.payload,
                            received_at: d.received_at * 1000,
                        },
                    );
                }
                // Processed since the GUIDs were read.
                Ok(None) => in_flight.release(&guid),
                Err(e) => {
                    eprintln!("webhooks: reading delivery {guid} failed: {e}");
                    in_flight.release(&guid);
                }
            }
        }
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the body under the webhook secret,
/// compared in constant time.
fn signed(secret: &[u8], headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(hex) = header(headers, "x-hub-signature-256").and_then(|s| s.strip_prefix("sha256="))
    else {
        return false;
    };
    let Some(sig) = unhex(hex) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("any key length");
    mac.update(body);
    mac.verify_slice(&sig).is_ok()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

pub async fn receive(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if !signed(app.cfg().webhook_secret.as_bytes(), &headers, &body) {
        return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
    }
    let (Some(guid), Some(event)) = (
        header(&headers, "x-github-delivery"),
        header(&headers, "x-github-event"),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            "X-GitHub-Delivery and X-GitHub-Event are required",
        )
            .into_response();
    };
    let installation = serde_json::from_slice::<Envelope>(&body)
        .ok()
        .and_then(|e| e.installation)
        .map(|i| i.id);
    let received_at = crate::now_ms();
    let (g, e, payload, now) = (
        guid.to_owned(),
        event.to_owned(),
        body.to_vec(),
        received_at / 1000,
    );
    // Held from before it's stored, so the requeue never takes it on the way to the queue. The
    // request that stores it hands its hold on to the queue; any other lets go of its own.
    let queue = app.webhooks();
    queue.in_flight.hold(guid);
    let stored = app
        .control()
        .write(move |tx| {
            let new = control_db::q::insert_delivery(tx, &g, &e, installation, &payload, now)? > 0;
            if let Some(i) = installation {
                control_db::q::touch_checkpoint(tx, i, now)?;
            }
            Ok(new)
        })
        .await;
    if !matches!(stored, Ok(true)) {
        queue.in_flight.release(guid);
    }
    match stored {
        Ok(true) => {
            enqueue(
                &queue.tx,
                &queue.in_flight,
                Delivery {
                    guid: guid.to_owned(),
                    event: event.to_owned(),
                    payload: body.to_vec(),
                    received_at,
                },
            );
            StatusCode::ACCEPTED.into_response()
        }
        // Seen before: already applied, queued, or left for the requeue.
        Ok(false) => StatusCode::OK.into_response(),
        Err(e) => {
            // GitHub records the failure, and redelivery tries again.
            eprintln!("webhooks: storing delivery {guid} failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// One delivery on its way through the lanes it fans out to.
struct Job {
    guid: String,
    event: String,
    change: RepoChange,
    /// Lanes still to finish it; the last one settles it.
    left: AtomicUsize,
    /// A lane gave it up: it stays unprocessed for the requeue.
    given_up: AtomicBool,
    accounts: usize,
    started: Instant,
    control: Arc<Control>,
    in_flight: Arc<InFlight>,
    /// Reads a relationship delivery's edges back once every account has applied it, and its
    /// issue when a mirror couldn't order it ([`Written::reread`]).
    edges: Arc<Refetcher>,
    /// Some account's mirror couldn't order the delivery's issue: it's read again.
    reread: AtomicBool,
    /// Some account's mirror took a transferred issue in with the thread it had: its comments
    /// are read again.
    rethread: AtomicBool,
    /// What its settle runs as.
    jobs: Jobs,
}

/// One account's share of a [`Job`]. However it ends (applied, dropped on a full queue, or lost
/// with a dead lane) dropping it counts the account done; one never [`finished`](Self::finish)
/// gives the delivery up.
struct Ticket {
    job: Arc<Job>,
    finished: bool,
}

impl Ticket {
    fn new(job: &Arc<Job>) -> Ticket {
        Ticket {
            job: job.clone(),
            finished: false,
        }
    }

    /// The account has it, or has it recorded as `needs_resync`.
    fn finish(mut self) {
        self.finished = true;
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.finished {
            self.job.given_up.store(true, Ordering::Release);
        }
        if self.job.left.fetch_sub(1, Ordering::AcqRel) == 1 {
            let job = self.job.clone();
            // No runtime only while it shuts down, when the delivery stays unprocessed anyway.
            if tokio::runtime::Handle::try_current().is_ok() {
                // Only now, with the delivery in every account's mirror (or given up there), so
                // no lagging lane can apply it over the read-back. Each lane applies in delivery
                // order, so whatever came before it is in too.
                let mut read_backs: Vec<_> = job.change.refetch(&job.edges).into_iter().collect();
                if job.reread.load(Ordering::Acquire)
                    && let Some(subject) = job.change.reread()
                {
                    read_backs.push(job.edges.schedule(subject, ReadBack::Issue, false));
                }
                if job.rethread.load(Ordering::Acquire)
                    && let Some(subject) = job.change.reread()
                {
                    read_backs.push(job.edges.schedule(subject, ReadBack::Comments, true));
                }
                let jobs = job.jobs.clone();
                jobs.spawn(async move {
                    if job.given_up.load(Ordering::Acquire) {
                        eprintln!(
                            "webhooks: {} {} left unprocessed, to be queued again",
                            job.event, job.guid
                        );
                        job.in_flight.release(&job.guid);
                        return;
                    }
                    eprintln!(
                        "webhooks: {} {} applied to {} account(s) in {} ms",
                        job.event,
                        job.guid,
                        job.accounts,
                        job.started.elapsed().as_millis()
                    );
                    // Settled only once its read-back has landed or been given up: a process
                    // that stops first leaves it unprocessed, and the next start replays it.
                    let mut stopped = false;
                    for r in read_backs {
                        stopped |= r.await.is_err();
                    }
                    if stopped {
                        eprintln!(
                            "webhooks: {} {} stopped before its read-back finished; it waits for the next start",
                            job.event, job.guid
                        );
                        job.in_flight.release(&job.guid);
                        return;
                    }
                    settle(&job.control, &job.in_flight, &job.guid).await;
                });
            }
        }
    }
}

/// Marks the delivery processed (and drops its payload), retrying a failing control DB until it
/// lands, then lets it go. Off to the side: lanes carry on meanwhile.
async fn settle(control: &Control, in_flight: &InFlight, guid: &str) {
    until_ok(&format!("marking {guid} processed"), || {
        let (guid, now) = (guid.to_owned(), crate::now());
        control.write(move |tx| control_db::q::mark_processed(tx, &guid, now))
    })
    .await;
    in_flight.release(guid);
}

/// A lane: the sender into its queue, and its task, to tell it from a newer lane for the same
/// account.
struct Lane {
    tx: mpsc::Sender<Ticket>,
    task: tokio::task::Id,
}

/// Reads each delivery once, `resumed` first, and hands it to the lane of every account it
/// fans out to.
async fn dispatch(
    sinks: Sinks,
    in_flight: Arc<InFlight>,
    resumed: Vec<Delivery>,
    mut rx: mpsc::UnboundedReceiver<Delivery>,
) {
    // One lane per account that has had a delivery since this start: a handful of teammates.
    // Dropped with the dispatcher, which aborts them.
    let mut lanes: HashMap<i64, Lane> = HashMap::new();
    let mut running = sinks.jobs.set();
    let mut resumed = resumed.into_iter();
    loop {
        let d = match resumed.next() {
            Some(d) => d,
            None => tokio::select! {
                d = rx.recv() => match d {
                    Some(d) => d,
                    None => return,
                },
                Some(ended) = running.join_next_with_id() => {
                    lane_ended(&sinks, &mut lanes, ended).await;
                    continue;
                }
            },
        };
        let started = Instant::now();
        if let Some(account) = revoked_by(&d.event, &d.payload) {
            revoked(&sinks, account, d.received_at).await;
            spawn_settle(&sinks, &in_flight, d.guid);
            continue;
        }
        if let Some(change) = InstallChange::parse(&d.event, &d.payload) {
            let _ = sinks.installs.send(change);
            spawn_settle(&sinks, &in_flight, d.guid);
            continue;
        }
        let change = match RepoChange::parse(&d.event, &d.payload) {
            Ok(Some(c)) => c,
            Ok(None) => {
                spawn_settle(&sinks, &in_flight, d.guid);
                continue;
            }
            Err(e) => {
                eprintln!("webhooks: {} {} unreadable: {e}", d.event, d.guid);
                spawn_settle(&sinks, &in_flight, d.guid);
                continue;
            }
        };
        let repo = change.repo;
        // Waited out here, so no later delivery goes ahead of this one.
        let targets = syncing(&sinks.control, repo, &format!("fanning out {}", d.guid)).await;
        if targets.is_empty() {
            spawn_settle(&sinks, &in_flight, d.guid);
            continue;
        }
        let job = Arc::new(Job {
            guid: d.guid,
            event: d.event,
            change,
            left: AtomicUsize::new(targets.len()),
            given_up: AtomicBool::new(false),
            accounts: targets.len(),
            started,
            control: sinks.control.clone(),
            in_flight: in_flight.clone(),
            edges: sinks.edges.clone(),
            reread: AtomicBool::new(false),
            rethread: AtomicBool::new(false),
            jobs: sinks.jobs.clone(),
        });
        for account in targets {
            let mut ticket = Ticket::new(&job);
            loop {
                let lane = lanes.entry(account).or_insert_with(|| {
                    let (tx, rx) = mpsc::channel(LANE_QUEUE);
                    let task = running.spawn(lane(sinks.clone(), account, rx)).id();
                    Lane { tx, task }
                });
                match lane.tx.try_send(ticket) {
                    Ok(()) => break,
                    Err(mpsc::error::TrySendError::Full(t)) => {
                        eprintln!(
                            "webhooks: account {account}'s queue is full; dropping {} {} for it",
                            job.event, job.guid
                        );
                        mark_for_resync(&sinks.control, &sinks.hub, account).await;
                        t.finish();
                        break;
                    }
                    // Its lane died with deliveries in hand: a new one takes this one.
                    Err(mpsc::error::TrySendError::Closed(t)) => {
                        eprintln!("webhooks: account {account}'s lane stopped; starting another");
                        lanes.remove(&account);
                        mark_for_resync(&sinks.control, &sinks.hub, account).await;
                        ticket = t;
                    }
                }
            }
        }
    }
}

fn spawn_settle(sinks: &Sinks, in_flight: &Arc<InFlight>, guid: String) {
    let (control, in_flight) = (sinks.control.clone(), in_flight.clone());
    sinks
        .jobs
        .spawn(async move { settle(&control, &in_flight, &guid).await });
}

/// A lane's task ended, which only a panic does while the dispatcher runs (or the drain, which
/// stops the dispatcher too): what it held is given up, so its account may now be missing
/// deliveries that a later one doesn't cover.
async fn lane_ended(
    sinks: &Sinks,
    lanes: &mut HashMap<i64, Lane>,
    ended: Result<(tokio::task::Id, Option<()>), tokio::task::JoinError>,
) {
    let task = match &ended {
        Ok((id, _)) => *id,
        Err(e) => e.id(),
    };
    let Some(account) = lanes.iter().find(|(_, l)| l.task == task).map(|(a, _)| *a) else {
        return;
    };
    eprintln!("webhooks: account {account}'s lane stopped ({ended:?}); starting another");
    lanes.remove(&account);
    mark_for_resync(&sinks.control, &sinks.hub, account).await;
}

/// Why an account may miss a relationship change for good.
#[derive(Clone, Copy)]
enum Hidden {
    /// The delivery came without an installation: nothing reads the other end back.
    NoReadBack,
    /// The other end is in a private repo the account syncs through another installation, which
    /// the delivery's installation token can't see. Neither can a sweep.
    OtherInstallation,
}

/// One account's deliveries, applied to its mirror in the order they were received.
async fn lane(sinks: Sinks, account: i64, mut rx: mpsc::Receiver<Ticket>) {
    while let Some(ticket) = rx.recv().await {
        apply(&sinks, account, &ticket.job).await;
        ticket.finish();
    }
}

/// Writes the delivery to one account's mirror and pushes what changed. A failed write marks the
/// account `needs_resync`, for a sweep to repair; the lane waits until that's recorded. A deleted
/// mirror (the account lost access) is nothing to repair.
async fn apply(sinks: &Sinks, account: i64, job: &Arc<Job>) {
    let j = job.clone();
    let written = sinks
        .mirrors
        .write(account, Caller::Webhook, move |tx, seq| {
            Ok((j.change.write(tx, seq)?, j.change.hidden(tx)?))
        })
        .await;
    match written {
        Ok((
            Written {
                ids,
                defined,
                reread,
                repo,
                rethread,
            },
            hidden,
        )) => {
            if reread {
                job.reread.store(true, Ordering::Release);
            }
            if rethread {
                job.rethread.store(true, Ordering::Release);
            }
            let push = if repo || ids.len() > MAX_IDS {
                Some(Push::Reset)
            } else if !ids.is_empty() {
                Some(Push::Ids(ids.into()))
            } else if defined {
                // A label or milestone that no item carries still changes what the filter bar
                // and the detail's pickers offer.
                Some(Push::Defs)
            } else {
                None
            };
            // A post that came in: its images are measured before the push, for a little while.
            // Off the lane, so the account's next delivery doesn't wait on the measuring.
            let posts: Vec<_> = match (&push, job.change.item()) {
                (Some(Push::Ids(_)), Some(_)) if sinks.app.is_some() => job
                    .change
                    .posts()
                    .into_iter()
                    .filter(|p| crate::media::probe::may_show_images(&p.post.md))
                    .collect(),
                _ => Vec::new(),
            };
            match (push, &sinks.app) {
                (Some(push), Some(app)) if !posts.is_empty() => {
                    let (app, hub, item) = (app.clone(), sinks.hub.clone(), job.change.item());
                    sinks.jobs.spawn(async move {
                        let wait = app.cfg().media.webhook_wait;
                        crate::media::probe::ingest(&app, account, posts, wait, item).await;
                        hub.publish(account, push);
                    });
                }
                (Some(push), _) => sinks.hub.publish(account, push),
                (None, _) => {}
            }
            match hidden {
                // A sweep reads with the same installation tokens and can't find the other end
                // either: marking the account would leave it degraded for good, and its full
                // sweeps repeating. The mirror keeps what it has of the edge.
                Some(Hidden::OtherInstallation) => eprintln!(
                    "webhooks: {} {} names an end in a private repo account {account} syncs through another installation; no token beghu reads with shows it",
                    job.event, job.guid
                ),
                Some(Hidden::NoReadBack) => {
                    eprintln!(
                        "webhooks: {} {} names an end and no installation to read it back with; marking account {account} for resync",
                        job.event, job.guid
                    );
                    mark_for_resync(&sinks.control, &sinks.hub, account).await;
                }
                None => {}
            }
        }
        // The account lost access and its mirror is deleted (or being deleted): nothing to
        // repair. Signing in again imports afresh.
        Err(mirror_db::Error::Deleted) => {}
        Err(e) => {
            eprintln!(
                "webhooks: delivery {} failed for account {account}: {e}",
                job.guid
            );
            mark_for_resync(&sinks.control, &sinks.hub, account).await;
        }
    }
}

/// The accounts syncing `repo`, read until the control DB lets it through; `what` names the read
/// in the log.
pub(crate) async fn syncing(control: &Control, repo: i64, what: &str) -> Vec<i64> {
    until_ok(what, || {
        control.read(move |c| control_db::q::fan_out_targets(c, repo))
    })
    .await
}

/// Marks the account `needs_resync`: its mirror missed a change, which a sweep will repair. Its
/// tabs hear it as the status slot's "sync degraded" (see `reconcile`).
/// Tried again as [`until_ok`] does, except once the drain has sealed the control DB: then the
/// mark is left to the next start, whose redelivery and sweeps find what it was for.
pub(crate) async fn mark_for_resync(control: &Control, hub: &Hub, account: i64) {
    let mut waits = RETRIES.iter().copied();
    loop {
        let now = crate::now();
        match control
            .write(move |tx| control_db::q::set_needs_resync(tx, account, now))
            .await
        {
            Ok(_) => break,
            Err(control_db::Error::Sealed) => return,
            Err(e) => {
                let wait = waits.next().unwrap_or(RETRY_EVERY);
                eprintln!(
                    "webhooks: marking account {account} for resync failed, trying again in {wait:?}: {e}"
                );
                tokio::time::sleep(wait).await;
            }
        }
    }
    hub.publish(account, Push::Sync);
}

/// Runs `call` until the control DB lets it through: again after each of [`RETRIES`], then
/// every [`RETRY_EVERY`], logging each failure as `what`.
pub(crate) async fn until_ok<T, F>(what: &str, mut call: impl FnMut() -> F) -> T
where
    F: Future<Output = Result<T, control_db::Error>>,
{
    let mut waits = RETRIES.iter().copied();
    loop {
        match call().await {
            Ok(v) => return v,
            Err(e) => {
                let wait = waits.next().unwrap_or(RETRY_EVERY);
                eprintln!("webhooks: {what} failed, trying again in {wait:?}: {e}");
                tokio::time::sleep(wait).await;
            }
        }
    }
}

// --- payloads, parsed leniently: unknown fields are ignored and optional ones default ----------

#[derive(Deserialize)]
struct Envelope {
    installation: Option<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: i64,
}

/// A repo as deliveries carry it: the delivery's own, and a transfer's other end.
#[derive(Deserialize)]
struct Repository {
    id: i64,
    /// `owner/name`: where a PR read-back reads.
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    name: String,
    owner: Option<Owner>,
    #[serde(default)]
    private: bool,
}

/// The PR a `pull_request` or `pull_request_review` delivery is about: only its number is kept.
#[derive(Deserialize)]
struct PullRef {
    number: i64,
}

#[derive(Deserialize)]
struct Owner {
    login: String,
}

/// A transfer's `changes`: `issues.opened` in the destination names the old issue and repo,
/// `issues.transferred` in the source the new ones.
#[derive(Deserialize)]
struct Moves {
    old_issue: Option<Issue>,
    new_issue: Option<Issue>,
    new_repository: Option<Repository>,
}

#[derive(Deserialize)]
pub(crate) struct User {
    id: i64,
    pub login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Label {
    id: i64,
    pub name: String,
    #[serde(default)]
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Milestone {
    id: i64,
    pub number: i64,
    title: String,
    state: String,
    due_on: Option<String>,
    updated_at: Option<String>,
}

/// An issue as GitHub's webhooks and REST answers carry it.
#[derive(Deserialize)]
pub(crate) struct Issue {
    id: i64,
    #[serde(default)]
    node_id: String,
    number: i64,
    title: String,
    body: Option<String>,
    pub state: String,
    pub state_reason: Option<String>,
    #[serde(default)]
    locked: bool,
    user: Option<User>,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    pub assignees: Vec<User>,
    pub milestone: Option<Milestone>,
    #[serde(default)]
    comments: i64,
    created_at: Option<String>,
    updated_at: String,
    closed_at: Option<String>,
    pull_request: Option<serde_json::Value>,
    /// Which repo it's in, to tell a same-repo relationship delivery from a cross-repo one.
    repository_url: Option<String>,
    /// The GitHub issue type: `null` (or, from an older payload, absent) when untyped.
    #[serde(rename = "type")]
    issue_type: Option<IssueType>,
}

impl Issue {
    pub(crate) fn id(&self) -> i64 {
        self.id
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    /// The body: GitHub's `null` for none is empty.
    pub(crate) fn body(&self) -> &str {
        self.body.as_deref().unwrap_or("")
    }
}

/// An issue's `type` (GitHub's issue-type object); only its name is kept.
#[derive(Deserialize)]
struct IssueType {
    name: String,
}

/// A comment as GitHub's webhooks and REST answers carry it.
#[derive(Deserialize)]
pub(crate) struct Comment {
    pub id: i64,
    #[serde(default)]
    node_id: String,
    pub user: Option<User>,
    #[serde(default)]
    pub body: String,
    pub created_at: Option<String>,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct Payload {
    #[serde(default)]
    action: String,
    repository: Option<Repository>,
    issue: Option<Issue>,
    comment: Option<Comment>,
    label: Option<Label>,
    /// An `assigned` or `unassigned` delivery's user.
    assignee: Option<User>,
    milestone: Option<Milestone>,
    installation: Option<Installation>,
    /// What an action changed. Read only for a transfer's ([`Moves`]): every other action's
    /// `changes` is left as it came.
    changes: Option<serde_json::Value>,
    // Relationship deliveries: `sub_issues`, `issue_dependencies` and `issue_relates_to`.
    parent_issue: Option<Issue>,
    parent_issue_id: Option<i64>,
    sub_issue: Option<Issue>,
    sub_issue_id: Option<i64>,
    blocked_issue: Option<Issue>,
    blocked_issue_id: Option<i64>,
    blocking_issue: Option<Issue>,
    blocking_issue_id: Option<i64>,
    related_issue: Option<Issue>,
    related_issue_id: Option<i64>,
    // `pull_request` and `pull_request_review` deliveries.
    pull_request: Option<PullRef>,
}

/// One delivery's change to a repo, ready to write to each account's mirror.
struct RepoChange {
    repo: i64,
    /// The installation it came through: an issue read again after it is read with its token.
    installation: Option<i64>,
    change: Change,
}

enum Change {
    /// The issue as the action left it, and the one label or assignee the action put on or took
    /// off, if it's one that does.
    Issue {
        issue: Issue,
        delta: Option<Delta>,
    },
    IssueDeleted(i64),
    Comment {
        issue: Issue,
        comment: Comment,
    },
    CommentDeleted {
        issue: Issue,
        comment: i64,
    },
    Label(Label),
    LabelDeleted(i64),
    Milestone(Milestone),
    MilestoneDeleted(i64),
    Relationship(Relationship),
    /// A PR changed (or was reviewed): it is read back, nothing written from the payload.
    Pull {
        owner: String,
        name: String,
        number: i64,
        installation: Option<i64>,
    },
    Transfer(Transfer),
    /// `repository` `archived` (true) or `unarchived` (false).
    Archived(bool),
}

/// An issue transferred to another repo, from either of its deliveries (they come in either
/// order): `issues.opened` in the destination, with `changes.old_issue`, or `issues.transferred`
/// in the source, with `changes.new_issue`. The new issue has a new id, node id and number.
struct Transfer {
    /// The issue's id before the transfer.
    old: i64,
    /// The issue it became.
    new: Issue,
    /// The repo it's in now.
    to: Repository,
}

/// A relationship delivery: the issue in the delivery's repo whose edges changed, and the edge
/// itself when the delivery names the other end's id.
struct Relationship {
    subject: Issue,
    kind: Kind,
    /// Within a repo it applies as is. Across repos a removal applies by id wherever it is, and an
    /// addition only for an account whose mirror holds the other end in a repo it syncs: that
    /// account may see it, and only then.
    edge: Option<Edge>,
    /// Both ends are in the delivery's repo: its read-back can wait out the debounce.
    same_repo: bool,
    installation: Option<i64>,
}

impl Relationship {
    /// From a relationship delivery to `installation`: `subject` is its repo's issue; `other`
    /// and `other_id` the other end, as far as the payload has it; `edge` orders
    /// `(subject, other)` as `src → dst`.
    fn new(
        installation: Option<i64>,
        kind: Kind,
        add: bool,
        subject: Option<Issue>,
        other: Option<Issue>,
        other_id: Option<i64>,
        edge: fn(i64, i64) -> (i64, i64),
    ) -> Option<Relationship> {
        let subject = subject?;
        let same_repo = other.as_ref().is_some_and(|o| {
            o.repository_url.is_some() && o.repository_url == subject.repository_url
        });
        let edge = match other_id.or(other.as_ref().map(|o| o.id)) {
            Some(o) if o != subject.id => {
                let (src, dst) = edge(subject.id, o);
                Some(Edge {
                    kind,
                    src,
                    dst,
                    add,
                })
            }
            _ => None,
        };
        Some(Relationship {
            subject,
            kind,
            edge,
            same_repo,
            installation,
        })
    }
}

impl Relationship {
    /// The edge as this account's mirror may apply it: within a repo; across repos a removal, or
    /// an addition whose other end the mirror holds in a repo it syncs.
    fn applicable(&self, tx: &Transaction) -> rusqlite::Result<Option<&Edge>> {
        let Some(e) = &self.edge else {
            return Ok(None);
        };
        if self.same_repo || !e.add {
            return Ok(Some(e));
        }
        let other = if e.src == self.subject.id {
            e.dst
        } else {
            e.src
        };
        let held = q::item_repos(tx, &[other])?.iter().any(|r| r.synced);
        Ok(held.then_some(e))
    }

    /// Whether this account may miss the change for good, and why. Across repos, what the
    /// delivery doesn't apply is left to the read-back, which reads with the delivery's
    /// installation token: blind to a private repo the account syncs through another installation
    /// (another owner). The account's own token is never spent on it.
    fn hidden(&self, tx: &Transaction) -> rusqlite::Result<Option<Hidden>> {
        if self.same_repo || self.applicable(tx)?.is_some() {
            return Ok(None);
        }
        Ok(match self.installation {
            Some(i) if q::syncs_beyond_installation(tx, i)? => Some(Hidden::OtherInstallation),
            Some(_) => None,
            None => Some(Hidden::NoReadBack),
        })
    }
}

/// What a change wrote to one account's mirror.
#[derive(Debug, PartialEq)]
struct Written {
    /// The items whose rows read differently now.
    ids: Vec<i64>,
    /// A label or milestone itself changed: what the pickers and the filter bar offer.
    defined: bool,
    /// The delivery's issue disagrees with the mirror in a way `updated_at` can't settle: it's
    /// to be read again from GitHub.
    reread: bool,
    /// A repo itself changed (archived, or no longer): what `/api/me` says of it, and what every
    /// view may offer.
    repo: bool,
    /// A transfer brought an issue into a synced repo with the thread it had (or none): its
    /// comments are to be read again from GitHub ([`ReadBack::Comments`]).
    rethread: bool,
}

impl From<Vec<i64>> for Written {
    fn from(ids: Vec<i64>) -> Written {
        Written {
            ids,
            defined: false,
            reread: false,
            repo: false,
            rethread: false,
        }
    }
}

impl RepoChange {
    /// The issue or PR whose posts the change brings in, if it brings any.
    fn item(&self) -> Option<i64> {
        match &self.change {
            Change::Issue { issue, .. } | Change::Comment { issue, .. } => Some(issue.id),
            Change::Transfer(t) => Some(t.new.id),
            _ => None,
        }
    }

    /// The posts the change brings in, to measure the images of: an issue's body (a transferred
    /// issue's under its new id), or a comment. A transferred issue's comments are the
    /// read-back's (`edges.rs`, `ReadBack::Comments`), which measures them as it writes them.
    fn posts(&self) -> Vec<crate::media::probe::Incoming> {
        use crate::markdown::{Post, PostKind};
        use crate::media::probe::Incoming;
        match &self.change {
            Change::Issue { issue, .. } | Change::Transfer(Transfer { new: issue, .. }) => {
                vec![Incoming {
                    item: issue.id,
                    post: Post {
                        kind: PostKind::Body,
                        id: issue.id,
                        md: issue.body.clone().unwrap_or_default(),
                    },
                    node: issue.node_id.clone(),
                }]
            }
            Change::Comment { issue, comment } => vec![Incoming {
                item: issue.id,
                post: Post {
                    kind: PostKind::Comment,
                    id: comment.id,
                    md: comment.body.clone(),
                },
                node: comment.node_id.clone(),
            }],
            _ => Vec::new(),
        }
    }

    /// The change a delivery carries; `None` for events and actions not handled here.
    fn parse(event: &str, payload: &[u8]) -> Result<Option<RepoChange>, serde_json::Error> {
        if !matches!(
            event,
            "issues"
                | "issue_comment"
                | "label"
                | "milestone"
                | "sub_issues"
                | "issue_dependencies"
                | "issue_relates_to"
                | "pull_request"
                | "pull_request_review"
                | "repository"
        ) {
            return Ok(None);
        }
        let mut p: Payload = serde_json::from_slice(payload)?;
        let Some(repository) = p.repository.take() else {
            return Ok(None);
        };
        let repo = repository.id;
        let moves = if event == "issues" && matches!(p.action.as_str(), "opened" | "transferred") {
            p.changes
                .take()
                .map(serde_json::from_value::<Moves>)
                .transpose()?
        } else {
            None
        };
        let action = std::mem::take(&mut p.action);
        let installation = p.installation.as_ref().map(|i| i.id);
        // The one label or assignee the action names; a payload without it is taken whole.
        let delta = match action.as_str() {
            "labeled" | "unlabeled" => p.label.take().map(|label| Delta::Label {
                label,
                on: action == "labeled",
            }),
            "assigned" | "unassigned" => p.assignee.take().map(|user| Delta::Assignee {
                user,
                on: action == "assigned",
            }),
            _ => None,
        };
        let add = action.ends_with("_added");
        let rel = add || action.ends_with("_removed");
        let change = match (event, action.as_str()) {
            ("sub_issues", a) if rel && a.starts_with("sub_issue_") => {
                let (s, o, oid) = (p.parent_issue.take(), p.sub_issue.take(), p.sub_issue_id);
                Relationship::new(installation, Kind::Sub, add, s, o, oid, |me, o| (me, o))
                    .map(Change::Relationship)
            }
            ("sub_issues", a) if rel && a.starts_with("parent_issue_") => {
                let (s, o, oid) = (p.sub_issue.take(), p.parent_issue.take(), p.parent_issue_id);
                Relationship::new(installation, Kind::Sub, add, s, o, oid, |me, o| (o, me))
                    .map(Change::Relationship)
            }
            ("issue_dependencies", a) if rel && a.starts_with("blocked_by_") => {
                let (s, o, oid) = (
                    p.blocked_issue.take(),
                    p.blocking_issue.take(),
                    p.blocking_issue_id,
                );
                Relationship::new(installation, Kind::Blocks, add, s, o, oid, |me, o| (o, me))
                    .map(Change::Relationship)
            }
            ("issue_dependencies", a) if rel && a.starts_with("blocking_") => {
                let (s, o, oid) = (
                    p.blocking_issue.take(),
                    p.blocked_issue.take(),
                    p.blocked_issue_id,
                );
                Relationship::new(installation, Kind::Blocks, add, s, o, oid, |me, o| (me, o))
                    .map(Change::Relationship)
            }
            ("issue_relates_to", _) if rel => {
                let (s, o, oid) = (p.issue.take(), p.related_issue.take(), p.related_issue_id);
                Relationship::new(installation, Kind::Relates, add, s, o, oid, |me, o| {
                    (me.min(o), me.max(o))
                })
                .map(Change::Relationship)
            }
            ("sub_issues" | "issue_dependencies" | "issue_relates_to", _) => None,
            ("issues", "transferred") => match (p.issue, moves) {
                (
                    Some(old),
                    Some(Moves {
                        new_issue: Some(new),
                        new_repository: Some(to),
                        ..
                    }),
                ) => Some(Change::Transfer(Transfer {
                    old: old.id,
                    new,
                    to,
                })),
                _ => None,
            },
            // A transferred issue arriving in its new repo.
            ("issues", "opened") if moves.as_ref().is_some_and(|m| m.old_issue.is_some()) => {
                match (moves.and_then(|m| m.old_issue), p.issue) {
                    (Some(old), Some(new)) => Some(Change::Transfer(Transfer {
                        old: old.id,
                        new,
                        to: repository,
                    })),
                    _ => None,
                }
            }
            ("issues", "deleted") => p.issue.map(|i| Change::IssueDeleted(i.id)),
            // Every other action carries the whole issue as that action left it: `typed` and
            // `untyped` too, whose `issue.type` is the new type (null once untyped).
            ("issues", _) => p.issue.map(|issue| Change::Issue { issue, delta }),
            ("issue_comment", "deleted") => match (p.issue, p.comment) {
                (Some(issue), Some(c)) => Some(Change::CommentDeleted {
                    issue,
                    comment: c.id,
                }),
                _ => None,
            },
            ("issue_comment", _) => match (p.issue, p.comment) {
                (Some(issue), Some(comment)) => Some(Change::Comment { issue, comment }),
                _ => None,
            },
            ("label", "deleted") => p.label.map(|l| Change::LabelDeleted(l.id)),
            ("label", _) => p.label.map(Change::Label),
            ("milestone", "deleted") => p.milestone.map(|m| Change::MilestoneDeleted(m.id)),
            ("milestone", _) => p.milestone.map(Change::Milestone),
            // A push to the branch, or merge-queue and auto-merge bookkeeping, changes nothing
            // the mirror holds.
            (
                "pull_request",
                "synchronize"
                | "enqueued"
                | "dequeued"
                | "auto_merge_enabled"
                | "auto_merge_disabled",
            ) => None,
            ("pull_request" | "pull_request_review", _) => {
                match (p.pull_request, repository.full_name.split_once('/')) {
                    (Some(pr), Some((owner, name))) => Some(Change::Pull {
                        owner: owner.to_owned(),
                        name: name.to_owned(),
                        number: pr.number,
                        installation,
                    }),
                    _ => None,
                }
            }
            ("repository", "archived") => Some(Change::Archived(true)),
            ("repository", "unarchived") => Some(Change::Archived(false)),
            _ => None,
        };
        Ok(change.map(|change| RepoChange {
            repo,
            installation,
            change,
        }))
    }

    /// The issue to read again from GitHub when the delivery disagreed with a mirror in a way
    /// `updated_at` can't settle (see [`upsert_issue`]): the delivery's issue, read with its
    /// installation's token.
    fn reread(&self) -> Option<Subject> {
        let (issue, repo) = match &self.change {
            Change::Issue { issue, .. }
            | Change::Comment { issue, .. }
            | Change::CommentDeleted { issue, .. } => (issue, self.repo),
            Change::Relationship(r) => (&r.subject, self.repo),
            // The new issue, in the repo it's in now.
            Change::Transfer(t) => (&t.new, t.to.id),
            _ => return None,
        };
        let Some(installation) = self.installation else {
            eprintln!(
                "webhooks: a delivery for issue {} names no installation; it can't be read again",
                issue.id
            );
            return None;
        };
        Some(Subject {
            id: issue.id,
            node_id: issue.node_id.clone(),
            number: issue.number,
            repo,
            installation,
        })
    }

    /// Schedules the read-back a delivery calls for, if any. A relationship delivery's: its repo's
    /// issue and the kind, at once when the other end is in another repo (or the delivery didn't
    /// say). A PR's: the PR, at once.
    fn refetch(&self, edges: &Refetcher) -> Option<tokio::sync::oneshot::Receiver<()>> {
        if let Change::Pull {
            owner,
            name,
            number,
            installation,
        } = &self.change
        {
            let Some(installation) = *installation else {
                eprintln!(
                    "webhooks: a delivery for PR {owner}/{name}#{number} names no installation; no read-back"
                );
                return None;
            };
            let pull = crate::pulls::Pull {
                repo: self.repo,
                owner: owner.clone(),
                name: name.clone(),
                number: *number,
                installation,
            };
            return Some(edges.schedule_pull(pull, true));
        }
        let Change::Relationship(r) = &self.change else {
            return None;
        };
        let Some(installation) = r.installation else {
            eprintln!(
                "webhooks: a relationship delivery for issue {} names no installation; no read-back",
                r.subject.id
            );
            return None;
        };
        let subject = Subject {
            id: r.subject.id,
            node_id: r.subject.node_id.clone(),
            number: r.subject.number,
            repo: self.repo,
            installation,
        };
        Some(edges.schedule(subject, ReadBack::Edges(r.kind), !r.same_repo))
    }

    /// Whether this account may miss a relationship change for good, and why
    /// ([`Relationship::hidden`]).
    fn hidden(&self, tx: &Transaction) -> rusqlite::Result<Option<Hidden>> {
        match &self.change {
            Change::Relationship(r) => r.hidden(tx),
            _ => Ok(None),
        }
    }

    /// Writes the change in one account's transaction; the ids of the items whose rows it
    /// changed (none when the guard kept everything as it was), and of the items that show
    /// something of them (an ancestor's progress, a blocked issue's chips), and whether a label
    /// or milestone itself changed. A repo the mirror no longer syncs (a pick unsynced it after
    /// the fan-out) gets nothing: the import's own check.
    fn write(&self, tx: &Transaction, seq: i64) -> rusqlite::Result<Written> {
        let repo = self.repo;
        if !crate::import::synced(tx, repo)? {
            return Ok(Vec::new().into());
        }
        let definition = |ids: Vec<i64>, defined: bool| Written {
            ids,
            defined,
            ..Vec::new().into()
        };
        let issue_ids = |w: Wrote, ids: Vec<i64>| Written {
            ids,
            reread: w.reread,
            ..Vec::new().into()
        };
        Ok(match &self.change {
            Change::Issue { issue, delta } => {
                let source = delta.as_ref().map_or(Source::Delivery, Source::Delta);
                let w = upsert_issue(tx, repo, issue, seq, source)?;
                let ids = if w.changed {
                    edges::with_neighbours(tx, BTreeSet::from([issue.id]))?
                } else {
                    Vec::new()
                };
                issue_ids(w, ids)
            }
            Change::IssueDeleted(id) => delete_item(tx, *id)?.into(),
            Change::Transfer(t) => {
                let (w, ids, rethread) = transfer(tx, t, seq)?;
                Written {
                    rethread,
                    ..issue_ids(w, ids)
                }
            }
            Change::Archived(archived) => Written {
                repo: q::set_repo_archived(tx, repo, *archived)? > 0,
                ..Vec::new().into()
            },
            Change::Relationship(r) => {
                let mut ids = BTreeSet::new();
                let w = upsert_issue(tx, repo, &r.subject, seq, Source::Delivery)?;
                if w.changed {
                    ids.extend(edges::with_neighbours(tx, BTreeSet::from([r.subject.id]))?);
                }
                if let Some(e) = r.applicable(tx)? {
                    ids.extend(edges::apply_delivery(tx, seq, e)?);
                }
                issue_ids(w, ids.into_iter().collect())
            }
            Change::Comment { issue, comment } => {
                let w = upsert_issue(tx, repo, issue, seq, Source::Delivery)?;
                let comment_changed = write_comment(tx, issue.id, comment, seq)?;
                let ids = ids_if(w.changed || comment_changed, issue.id);
                issue_ids(w, ids)
            }
            Change::CommentDeleted { issue, comment } => {
                let w = upsert_issue(tx, repo, issue, seq, Source::Delivery)?;
                let changed = delete_comment(tx, issue.id, *comment, seq)? || w.changed;
                issue_ids(w, ids_if(changed, issue.id))
            }
            Change::Label(l) => {
                let written = q::upsert_label(
                    tx,
                    l.id,
                    repo,
                    &l.name,
                    &l.color,
                    l.description.as_deref(),
                    seq,
                )? > 0;
                definition(q::label_items(tx, l.id)?, written)
            }
            Change::LabelDeleted(id) => {
                let (ids, gone) = delete_label(tx, *id)?;
                definition(ids, gone)
            }
            Change::Milestone(m) => {
                if upsert_milestone(tx, repo, m)? {
                    definition(q::milestone_items(tx, m.id)?, true)
                } else {
                    Vec::new().into()
                }
            }
            Change::MilestoneDeleted(id) => {
                let (ids, gone) = delete_milestone(tx, *id, seq)?;
                definition(ids, gone)
            }
            Change::Pull { .. } => Vec::new().into(),
        })
    }
}

/// Applies a transfer, from either of its deliveries, in either order, any number of times: the
/// new issue is written (as a stub where the mirror doesn't sync its repo but holds links to the
/// old one, and may see the repo), every relationship of the old id now names the new one, and
/// the old id is deleted for good, recorded as moved to the new one. The second of the two
/// deliveries finds it done, unless it brings a newer issue. What changed (none for a replay),
/// the ids whose rows or detail read differently, and whether the new issue's thread is to be
/// read again: it came into a synced repo with the comments the old id had, kept by their ids,
/// which GitHub may not keep (unmeasured: docs/research/issue-edge-cases.md), or with none.
fn transfer(tx: &Transaction, t: &Transfer, seq: i64) -> rusqlite::Result<(Wrote, Vec<i64>, bool)> {
    let (old, new) = (t.old, &t.new);
    let held_old = !q::item_repos(tx, &[old])?.is_empty();
    let mut ids: BTreeSet<i64> = BTreeSet::new();
    if held_old {
        ids.extend(edges::with_neighbours(tx, BTreeSet::from([old]))?);
    }
    let full = crate::import::synced(tx, t.to.id)?;
    let wrote = if full {
        upsert_issue(tx, t.to.id, new, seq, Source::Delivery)?
    } else {
        if held_old && !edges::ends_of(tx, old)?.is_empty() && may_see(tx, &t.to)? {
            let owner = t.to.owner.as_ref().map_or("", |o| o.login.as_str());
            q::upsert_stub_repo(tx, t.to.id, &t.to.node_id, owner, &t.to.name, t.to.private)?;
            let state = if new.state == "open" {
                "open"
            } else {
                "closed"
            };
            q::upsert_stub(
                tx,
                new.id,
                &new.node_id,
                t.to.id,
                new.number,
                "issue",
                &new.title,
                state,
                seq,
            )?;
            q::set_stub_place(tx, new.id, t.to.id, new.number, seq)?;
        }
        Wrote::default()
    };
    if held_old && !q::item_repos(tx, &[new.id])?.is_empty() {
        q::repoint_children(tx, old, new.id, seq)?;
        q::repoint_edges(tx, old, new.id, seq)?;
        if full {
            q::move_comments(tx, old, new.id, seq)?;
            q::recount_last_commented(tx, new.id, seq)?;
        }
        // Newer than what a sweep under way read of either end.
        q::touch_edges(tx, new.id, seq)?;
        for end in edges::ends_of(tx, new.id)? {
            q::touch_edges(tx, end, seq)?;
        }
    }
    ids.extend(delete_item(tx, old)?);
    let owner = t.to.owner.as_ref().map_or("", |o| o.login.as_str());
    q::record_moved(tx, old, new.id, owner, &t.to.name, new.number, &new.title)?;
    if !held_old && !wrote.changed {
        return Ok((wrote, Vec::new(), false));
    }
    ids.extend(edges::with_neighbours(tx, BTreeSet::from([new.id]))?);
    Ok((wrote, ids.into_iter().collect(), full))
}

/// Whether the account may hold a stub in `repo`: it can see it (an installation reaches it), or
/// anyone can.
fn may_see(tx: &Transaction, repo: &Repository) -> rusqlite::Result<bool> {
    Ok(!repo.private || q::repo_state(tx, repo.id)?.is_some_and(|r| r.installation_id.is_some()))
}

/// Deletes an issue or PR and everything hanging off it, for good: the id stays deleted whatever
/// arrives after. The ids that showed something of it (none if the mirror didn't hold it).
pub(crate) fn delete_item(tx: &Transaction, id: i64) -> rusqlite::Result<Vec<i64>> {
    q::record_deleted(tx, "item", id)?;
    forget_item(tx, id)
}

/// Removes an item from the mirror without recording it as deleted, so a later delivery or
/// sweep that has it brings it back: a sweep's inference from what GitHub didn't list. What
/// showed something of it, if the mirror held it.
pub(crate) fn forget_item(tx: &Transaction, id: i64) -> rusqlite::Result<Vec<i64>> {
    // Whatever showed something of it, before its edges go.
    let shown = edges::with_neighbours(tx, BTreeSet::from([id]))?;
    let ends = edges::ends_of(tx, id)?;
    let gone = q::delete_item(tx, id)? > 0;
    q::clear_item_labels(tx, id)?;
    q::clear_item_assignees(tx, id)?;
    q::delete_item_comments(tx, id)?;
    q::delete_item_edges(tx, id)?;
    q::prune_stubs(tx, &ends)?;
    Ok(if gone { shown } else { Vec::new() })
}

/// Deletes a comment on `issue` for good; true if the mirror held it.
pub(crate) fn delete_comment(
    tx: &Transaction,
    issue: i64,
    comment: i64,
    seq: i64,
) -> rusqlite::Result<bool> {
    q::record_deleted(tx, "comment", comment)?;
    forget_comment(tx, issue, comment, seq)
}

/// Removes a comment from the mirror without recording it as deleted: a sweep's, which never
/// keeps a later delivery of it out. True if the mirror held it.
pub(crate) fn forget_comment(
    tx: &Transaction,
    issue: i64,
    comment: i64,
    seq: i64,
) -> rusqlite::Result<bool> {
    if q::delete_comment(tx, comment)? > 0 {
        q::recount_last_commented(tx, issue, seq)?;
        return Ok(true);
    }
    Ok(false)
}

/// Deletes a label for good; the items that had it, and whether the mirror held it.
pub(crate) fn delete_label(tx: &Transaction, id: i64) -> rusqlite::Result<(Vec<i64>, bool)> {
    q::record_deleted(tx, "label", id)?;
    let ids = q::label_items(tx, id)?;
    q::unlink_label(tx, id)?;
    let gone = q::delete_label(tx, id)? > 0;
    Ok((ids, gone))
}

/// Deletes a milestone for good; the items that had it, and whether the mirror held it.
pub(crate) fn delete_milestone(
    tx: &Transaction,
    id: i64,
    seq: i64,
) -> rusqlite::Result<(Vec<i64>, bool)> {
    q::record_deleted(tx, "milestone", id)?;
    let ids = q::milestone_items(tx, id)?;
    q::clear_milestone(tx, id, seq)?;
    let gone = q::delete_milestone(tx, id)? > 0;
    Ok((ids, gone))
}

/// Writes an issue GitHub answered with, to a read or to one of beghu's own writes: the issue as
/// it is, so it wins over the mirror's unless the mirror's is newer (see [`upsert_issue`]). Its
/// webhooks then find it in place: an equal `updated_at` saying the same is a no-op. One that
/// overwrote a row of its own second saying otherwise asks for the issue to be read again
/// ([`Wrote::reread`]): a change of that second may have come after GitHub answered.
pub(crate) fn write_issue(
    tx: &Transaction,
    repo: i64,
    issue: &Issue,
    seq: i64,
) -> rusqlite::Result<Wrote> {
    upsert_issue(tx, repo, issue, seq, Source::Read)
}

/// Writes a comment on `issue` from GitHub's answer to one of beghu's own writes, as its
/// `issue_comment` webhook would: false if the mirror already had it as new or newer. The issue's
/// own row (its count and `updated_at`) waits for that webhook, which carries it.
pub(crate) fn write_comment(
    tx: &Transaction,
    issue: i64,
    comment: &Comment,
    seq: i64,
) -> rusqlite::Result<bool> {
    if let Some(u) = &comment.user {
        q::upsert_user(tx, u.id, &u.login, u.avatar_url.as_deref())?;
    }
    let updated = time(&comment.updated_at);
    let created = comment.created_at.as_deref().map_or(updated, time);
    let written = q::upsert_comment(
        tx,
        comment.id,
        &comment.node_id,
        issue,
        comment.user.as_ref().map(|u| u.id),
        &comment.body,
        created,
        updated,
        seq,
    )? > 0;
    if written {
        q::bump_last_commented(tx, issue, created, seq)?;
    }
    Ok(written)
}

/// Puts `label` (from GitHub's answer to one of beghu's own writes) on `item`: the label is added
/// to the repo's if the mirror lacks it, never renamed (as from an issue payload). False if the
/// item had it already.
pub(crate) fn link_label(
    tx: &Transaction,
    repo: i64,
    item: i64,
    label: &Label,
    seq: i64,
) -> rusqlite::Result<bool> {
    q::add_label(
        tx,
        label.id,
        repo,
        &label.name,
        &label.color,
        label.description.as_deref(),
        seq,
    )?;
    let linked = q::link_item_label(tx, item, label.id)? > 0;
    if linked {
        q::touch_item(tx, item, seq)?;
    }
    Ok(linked)
}

/// Takes the repo's label called `name` (as GitHub compares names, ignoring case) off `item`,
/// after GitHub did at beghu's request. False if the item didn't have it.
pub(crate) fn unlink_label(
    tx: &Transaction,
    repo: i64,
    item: i64,
    name: &str,
    seq: i64,
) -> rusqlite::Result<bool> {
    let Some(label) = q::repo_label_named(tx, repo, name)? else {
        return Ok(false);
    };
    let unlinked = q::unlink_item_label(tx, item, label.id)? > 0;
    if unlinked {
        q::touch_item(tx, item, seq)?;
    }
    Ok(unlinked)
}

/// `[id]` if its row changed, else nothing.
fn ids_if(changed: bool, id: i64) -> Vec<i64> {
    if changed { vec![id] } else { Vec::new() }
}

/// False when the mirror already had the milestone as new or newer, or it was deleted.
fn upsert_milestone(tx: &Transaction, repo: i64, m: &Milestone) -> rusqlite::Result<bool> {
    let due = m.due_on.as_deref().map(time);
    let updated = m.updated_at.as_deref().map(time);
    Ok(q::upsert_milestone(tx, m.id, repo, m.number, &m.title, &m.state, due, updated)? > 0)
}

/// A delivery's one change to an issue's labels or assignees (`labeled`, `unlabeled`,
/// `assigned`, `unassigned`), from its `label` or `assignee`.
pub(crate) enum Delta {
    Label { label: Label, on: bool },
    Assignee { user: User, on: bool },
}

/// Where an issue payload comes from, which decides how it meets the mirror's row.
#[derive(Clone, Copy)]
pub(crate) enum Source<'a> {
    /// A delivery whose action carries the whole issue as that action left it.
    Delivery,
    /// A delivery naming the one label or assignee its action put on or took off.
    Delta(&'a Delta),
    /// GitHub's answer to a read or to one of beghu's own writes: the issue as it is.
    Read,
}

/// What writing an issue payload did to one mirror.
#[derive(Default, Debug, PartialEq, Clone, Copy)]
pub(crate) struct Wrote {
    /// The item's row reads differently.
    pub changed: bool,
    /// The payload disagrees with the mirror in a way `updated_at` can't settle.
    pub reread: bool,
}

impl From<bool> for Wrote {
    /// A write that settles itself: changed or not, nothing to read again.
    fn from(changed: bool) -> Wrote {
        Wrote {
            changed,
            reread: false,
        }
    }
}

/// Writes an issue payload against the mirror's row, by `updated_at` (in whole seconds, so picks
/// made within one second share it, and their deliveries may arrive in any order):
///
/// - Newer (or an item the mirror lacks): written. A `Delta` delivery writes the issue's own
///   fields and its one change; its other labels and assignees are as of its action, maybe before
///   a change of the same second the mirror already has, so they're only compared, and a
///   difference has the issue read again. Picks of different labels or people commute.
/// - Equal: a payload saying what the mirror has (for a `Delta`, its one change is in place) is a
///   replay, a no-op. One that says otherwise can't be ordered: it's not written, and the issue
///   is read again ([`Wrote::reread`]): a milestone set twice, a label toggled, two edits within
///   one second. A `Read` is GitHub's answer, maybe from before a change of its own second that
///   the mirror already has: written, and the issue read again once the second has settled, so
///   a later read converges on GitHub's last word for that second.
/// - Older: nothing, unless it's a `Delta` whose change the mirror lacks (a newer `Delta`
///   delivery carries only its own change): read again.
///
/// A deleted item is never written again (the upserts' own check). An update SETs only the
/// columns whose values changed, so it rewrites only their indexes (see `webhooks.sql`).
fn upsert_issue(
    tx: &Transaction,
    repo: i64,
    i: &Issue,
    seq: i64,
    source: Source,
) -> rusqlite::Result<Wrote> {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let order = match q::item_version(tx, i.id)? {
        Some(v) if !v.is_stub => v.updated_at.map(|t| time(&i.updated_at).cmp(&t)),
        _ => None,
    };
    let unchanged = |reread: bool| Wrote {
        changed: false,
        reread,
    };
    match (order, source) {
        (Some(Greater), Source::Delta(d)) => {
            if !write_fields(tx, repo, i, seq, false)? {
                return Ok(unchanged(false));
            }
            apply_delta(tx, repo, i.id, d, seq)?;
            Ok(Wrote {
                changed: true,
                reread: !same_sets(tx, i)?,
            })
        }
        (None | Some(Greater), _) => write_whole(tx, repo, i, seq, false),
        (Some(Equal), Source::Read) if !same_content(tx, i)? => {
            let w = write_whole(tx, repo, i, seq, true)?;
            Ok(Wrote {
                reread: w.changed,
                ..w
            })
        }
        (Some(Equal), Source::Delivery) => Ok(unchanged(!same_content(tx, i)?)),
        (Some(Equal | Less), Source::Delta(d)) => Ok(unchanged(!applied(tx, i.id, d)?)),
        (Some(Equal | Less), _) => Ok(unchanged(false)),
    }
}

/// The payload's issue type: never a PR's, as the import leaves it.
fn issue_type(i: &Issue) -> Option<&str> {
    i.issue_type
        .as_ref()
        .filter(|_| i.pull_request.is_none())
        .map(|t| t.name.as_str())
}

/// Writes the issue's own fields (`same_wins`: over an equal `updated_at` too), with its author
/// and milestone, not its labels or assignees. False when the guard kept the row as it was, or
/// the item was deleted.
fn write_fields(
    tx: &Transaction,
    repo: i64,
    i: &Issue,
    seq: i64,
    same_wins: bool,
) -> rusqlite::Result<bool> {
    let kind = if i.pull_request.is_some() {
        "pr"
    } else {
        "issue"
    };
    let issue_type = issue_type(i);
    let author = i.user.as_ref().map(|u| u.id);
    let created = i.created_at.as_deref().map(time);
    let updated = time(&i.updated_at);
    let closed = i.closed_at.as_deref().map(time);
    let applied = q::upsert_item(
        tx,
        i.id,
        &i.node_id,
        repo,
        i.number,
        kind,
        &i.title,
        i.body.as_deref(),
        &i.state,
        i.state_reason.as_deref(),
        i.locked,
        author,
        i.milestone.as_ref().map(|m| m.id),
        created,
        updated,
        closed,
        i.comments,
        issue_type,
        seq,
        same_wins,
    )? > 0;
    if !applied {
        return Ok(false);
    }
    // A new row was inserted whole and these match nothing; an existing one gets what changed.
    q::set_item_place(tx, i.id, repo, i.number)?;
    q::unstub_item(tx, i.id)?;
    q::set_item_text(tx, i.id, &i.title, i.body.as_deref())?;
    q::set_item_kind(tx, i.id, kind)?;
    q::set_item_state(tx, i.id, &i.state, closed)?;
    q::set_item_created(tx, i.id, created)?;
    q::set_item_updated(tx, i.id, updated)?;
    q::set_item_author(tx, i.id, author)?;
    q::set_item_comments(tx, i.id, i.comments)?;
    q::set_item_type(tx, i.id, issue_type)?;
    if let Some(u) = &i.user {
        q::upsert_user(tx, u.id, &u.login, u.avatar_url.as_deref())?;
    }
    if let Some(m) = &i.milestone {
        upsert_milestone(tx, repo, m)?;
    }
    Ok(true)
}

/// Writes the whole issue, its labels and assignees replaced by the payload's.
fn write_whole(
    tx: &Transaction,
    repo: i64,
    i: &Issue,
    seq: i64,
    same_wins: bool,
) -> rusqlite::Result<Wrote> {
    if !write_fields(tx, repo, i, seq, same_wins)? {
        return Ok(Wrote::default());
    }
    q::clear_item_labels(tx, i.id)?;
    for l in &i.labels {
        q::add_label(
            tx,
            l.id,
            repo,
            &l.name,
            &l.color,
            l.description.as_deref(),
            seq,
        )?;
        q::link_item_label(tx, i.id, l.id)?;
    }
    q::clear_item_assignees(tx, i.id)?;
    for a in &i.assignees {
        q::upsert_user(tx, a.id, &a.login, a.avatar_url.as_deref())?;
        q::add_item_assignee(tx, i.id, a.id)?;
    }
    Ok(Wrote {
        changed: true,
        reread: false,
    })
}

/// Puts a delivery's one label or assignee on the item, or takes it off.
fn apply_delta(
    tx: &Transaction,
    repo: i64,
    item: i64,
    d: &Delta,
    seq: i64,
) -> rusqlite::Result<()> {
    match d {
        Delta::Label { label: l, on: true } => {
            q::add_label(
                tx,
                l.id,
                repo,
                &l.name,
                &l.color,
                l.description.as_deref(),
                seq,
            )?;
            q::link_item_label(tx, item, l.id)?;
        }
        Delta::Label { label, on: false } => {
            q::unlink_item_label(tx, item, label.id)?;
        }
        Delta::Assignee { user: u, on: true } => {
            q::upsert_user(tx, u.id, &u.login, u.avatar_url.as_deref())?;
            q::add_item_assignee(tx, item, u.id)?;
        }
        Delta::Assignee { user, on: false } => {
            q::remove_item_assignee(tx, item, user.id)?;
        }
    }
    Ok(())
}

/// Whether the mirror has the delivery's one change in place.
fn applied(tx: &Transaction, item: i64, d: &Delta) -> rusqlite::Result<bool> {
    Ok(match d {
        Delta::Label { label, on } => q::item_label_ids(tx, item)?.contains(&label.id) == *on,
        Delta::Assignee { user, on } => q::item_assignee_ids(tx, item)?.contains(&user.id) == *on,
    })
}

/// Whether the mirror's labels and assignees for the item are the payload's. A label a webhook
/// deleted is left out: the mirror never takes it back, so an answer still naming it (GitHub's,
/// from before the delete) differs in nothing a read again could settle.
fn same_sets(tx: &Transaction, i: &Issue) -> rusqlite::Result<bool> {
    let mut labels = Vec::with_capacity(i.labels.len());
    for l in &i.labels {
        if !q::is_deleted(tx, "label", l.id)? {
            labels.push(l.id);
        }
    }
    let ids = |mut v: Vec<i64>| -> Vec<i64> {
        v.sort_unstable();
        v.dedup();
        v
    };
    Ok(q::item_label_ids(tx, i.id)? == ids(labels)
        && q::item_assignee_ids(tx, i.id)? == ids(i.assignees.iter().map(|u| u.id).collect()))
}

/// The payload's milestone as the mirror can have it: none for one a webhook deleted.
fn live_milestone(tx: &Transaction, i: &Issue) -> rusqlite::Result<Option<i64>> {
    match &i.milestone {
        Some(m) if !q::is_deleted(tx, "milestone", m.id)? => Ok(Some(m.id)),
        _ => Ok(None),
    }
}

/// Whether the mirror's row says what the payload says: its own fields, labels and assignees.
fn same_content(tx: &Transaction, i: &Issue) -> rusqlite::Result<bool> {
    let Some(m) = q::item_content(tx, i.id)? else {
        return Ok(false);
    };
    let same = m.title == i.title
        && m.body.as_deref() == i.body.as_deref()
        && m.state == i.state
        && m.state_reason.as_deref() == i.state_reason.as_deref()
        && m.locked == i.locked
        && m.author_id == i.user.as_ref().map(|u| u.id)
        && m.milestone_id == live_milestone(tx, i)?
        && m.created_at == i.created_at.as_deref().map(time)
        && m.closed_at == i.closed_at.as_deref().map(time)
        && m.comments_count == i.comments
        && m.issue_type.as_deref() == issue_type(i);
    Ok(same && same_sets(tx, i)?)
}

/// GitHub's RFC 3339 timestamps (`2026-10-13T08:22:19Z`, or with an offset or fractional
/// seconds) as Unix seconds; 0 for one that doesn't parse.
pub(crate) fn time(s: &str) -> i64 {
    parse_time(s).unwrap_or(0)
}

/// Unix seconds as GitHub writes times (`2026-10-13T08:22:19Z`).
pub(crate) fn rfc3339(secs: i64) -> String {
    // Days from the civil calendar (Howard Hinnant's algorithm), as `parse_time` reads them.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub(crate) fn parse_time(s: &str) -> Option<i64> {
    // Every slice below is by byte offset, which is safe only on ASCII.
    if !s.is_ascii() {
        return None;
    }
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> { s.get(from..from + len)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hh, mm, ss) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        rest = frac.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "Z" | "z" | "" => 0,
        o if o.len() == 6 => {
            let sign = match &o[..1] {
                "+" => 1,
                "-" => -1,
                _ => return None,
            };
            sign * (o[1..3].parse::<i64>().ok()? * 3600 + o[4..6].parse::<i64>().ok()? * 60)
        }
        _ => return None,
    };
    // Days from the civil calendar (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

#[cfg(test)]
mod tests {
    use super::{RepoChange, Written, parse_time, rfc3339};
    use mirror_db::q;

    // An exception to "tests go through public seams" (AGENTS.md): a delivery is fanned out from
    // `synced_repos` and applied later on the account's lane, and a pick that unsyncs the repo
    // can land in between. No public seam can hold a delivery between the two (through
    // `/webhook` the fan-out and the apply follow each other at once), so the window can't be
    // opened from outside, and the apply's own check is tested here instead, on the fixture's
    // mirror, whose `partner-sdk` repo isn't synced.
    #[test]
    fn a_change_for_a_repo_the_mirror_no_longer_syncs_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture::cached(fixture::Scale::K1, dir.path()).unwrap();
        let mut c = rusqlite::Connection::open(fixture).unwrap();
        const PARTNER_SDK: i64 = 9_000_100;
        let issue = serde_json::json!({
            "action": "opened",
            "repository": { "id": PARTNER_SDK },
            "issue": {
                "id": 3_990_000_000i64, "node_id": "I_late", "number": 9_999, "title": "Late",
                "body": "", "state": "open", "state_reason": null, "locked": false,
                "user": { "id": 1000, "login": "tomsj", "avatar_url": null }, "labels": [],
                "assignees": [], "milestone": null, "comments": 0,
                "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z",
                "closed_at": null,
            },
        });
        let label = serde_json::json!({
            "action": "created",
            "repository": { "id": PARTNER_SDK },
            "label": { "id": 5_999_999, "name": "late", "color": "ffffff", "description": null },
        });
        let tx = c.transaction().unwrap();
        for (event, payload) in [("issues", issue), ("label", label)] {
            let change = RepoChange::parse(event, &serde_json::to_vec(&payload).unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(
                change.write(&tx, 99).unwrap(),
                Written::from(Vec::new()),
                "{event}"
            );
        }
        assert!(
            q::item_by_number(&tx, PARTNER_SDK, 9_999)
                .unwrap()
                .is_none()
        );
        assert!(
            q::repo_label_named(&tx, PARTNER_SDK, "late")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn github_timestamps_read_as_unix_seconds() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        // The fixture's "now".
        assert_eq!(parse_time("2026-10-01T00:00:00Z"), Some(1_790_812_800));
        assert_eq!(parse_time("2024-02-29T12:34:56Z"), Some(1_709_210_096));
        assert_eq!(parse_time("2024-02-29T14:34:56+02:00"), Some(1_709_210_096));
        assert_eq!(parse_time("2024-02-29T12:34:56.789Z"), Some(1_709_210_096));
        assert_eq!(parse_time("yesterday"), None);
    }

    #[test]
    fn unix_seconds_write_as_github_writes_times() {
        for t in [0, 1_709_210_096, 1_790_812_800, 951_782_400] {
            assert_eq!(parse_time(&rfc3339(t)), Some(t), "{t}");
        }
        assert_eq!(rfc3339(1_790_812_800), "2026-10-01T00:00:00Z");
    }

    #[test]
    fn a_timestamp_with_non_ascii_in_it_reads_as_none_without_panicking() {
        for s in [
            "2024-02-29T12:34:56é",
            "2024-02-29T12:34:5éZ",
            "2024-02-29T12:34:56+0é:0",
            "2024-02-29T12:34:56+é000",
            "2024-02-29T12:34:56.9é",
            "2024-ö2-29T12:34:56Z",
        ] {
            assert_eq!(parse_time(s), None, "{s}");
        }
    }
}
