//! `POST /webhook`: GitHub's deliveries. The handler checks the signature, records the delivery
//! (deduped by `X-GitHub-Delivery`), answers 2xx at once and queues it. A delivery acked but not
//! yet processed when the process stopped is still `processed_at IS NULL` in the control DB, and
//! [`resume`] queues it again at startup.
//!
//! Applying fans out: a dispatcher reads each delivery once, in the order received, and hands it
//! to a lane per active connected account that syncs its repo. Each lane writes its account's
//! mirror in delivery order, one transaction (one `seq`) per delivery, followed by one push to
//! that account's streams; lanes run independently, so a slow or failing mirror holds up only its
//! own account. A failed write marks that account `needs_resync` and its lane carries on. The
//! last lane to finish a delivery marks it processed, which clears its payload (a relationship
//! delivery waits first for the read-back it schedules to land or be given up, so a process that
//! stops in between replays it at the next start); processed
//! deliveries are kept [`Config::deliveries_kept_for`](crate::Config) (GitHub's three-day
//! redelivery window and a day's margin) to dedupe redeliveries, then pruned.
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
//! Handled here: `issues`, `issue_comment`, `label`, `milestone`, and the relationship events
//! `sub_issues`, `issue_dependencies` and `issue_relates_to` (see `edges.rs`). Items, comments and
//! milestones are guarded by `updated_at` (newer or equal wins), so a replay or an older delivery
//! that arrives late changes nothing. A webhook delete is recorded, and an older delivery that
//! arrives after it never brings the row back. Labels carry no `updated_at`: a `label` delivery
//! sets the label as it is now (the last one applied wins), and an issue's payload only adds the
//! labels the mirror lacks, never renames one, since it may predate a rename. Two renames of one
//! label delivered out of order leave the older name until a sweep. Other events are acked and
//! dropped until their slices handle them.

use crate::App;
use crate::edges::{self, Edge, Kind, Refetcher, Subject};
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
use tokio::task::{JoinHandle, JoinSet};

/// GitHub's payloads go up to 25 MB.
pub const MAX_BODY: usize = 25 * 1024 * 1024;

/// Past this many ids, a push is a `reset`: the tab refetches what it shows either way, and the
/// event stays small.
const MAX_IDS: usize = 256;

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

/// The queue into the dispatcher. Dropping it (with the server) stops the dispatcher, its lanes,
/// the requeue and the pruning; anything not finished stays unprocessed in the control DB for
/// the next start.
pub struct Queue {
    tx: mpsc::UnboundedSender<Delivery>,
    in_flight: Arc<InFlight>,
    tasks: [JoinHandle<()>; 3],
}

impl Drop for Queue {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// What applying a delivery writes to and pushes through.
#[derive(Clone)]
pub struct Sinks {
    pub control: Arc<Control>,
    pub mirrors: Mirrors,
    pub hub: Arc<Hub>,
    /// Reads relationships back from GitHub after their deliveries.
    pub edges: Arc<Refetcher>,
}

/// Starts the dispatcher with every delivery acked but not processed before this start queued
/// first, oldest first, then the requeue and the pruning of processed deliveries older than
/// `kept_for`. Call before the server listens, so the resumed deliveries go ahead of new ones.
pub async fn resume(sinks: Sinks, kept_for: Duration) -> Result<Queue, control_db::Error> {
    let pending = sinks
        .control
        .read(|c| control_db::q::pending_deliveries(c, i64::MAX))
        .await?;
    if !pending.is_empty() {
        eprintln!(
            "webhooks: resuming {} unprocessed deliveries",
            pending.len()
        );
    }
    let in_flight = Arc::new(InFlight::default());
    let (tx, rx) = mpsc::unbounded_channel();
    for d in pending {
        in_flight.claim(&d.guid);
        enqueue(
            &tx,
            &in_flight,
            Delivery {
                guid: d.guid,
                event: d.event,
                payload: d.payload,
            },
        );
    }
    let prune = {
        let control = sinks.control.clone();
        tokio::spawn(async move {
            loop {
                prune(&control, kept_for).await;
                tokio::time::sleep(PRUNE_EVERY).await;
            }
        })
    };
    let requeue = tokio::spawn(requeue(
        sinks.control.clone(),
        in_flight.clone(),
        tx.clone(),
    ));
    Ok(Queue {
        tx,
        in_flight: in_flight.clone(),
        tasks: [tokio::spawn(dispatch(sinks, in_flight, rx)), prune, requeue],
    })
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
    let (g, e, payload, now) = (
        guid.to_owned(),
        event.to_owned(),
        body.to_vec(),
        crate::now(),
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
    /// Reads a relationship delivery's edges back once every account has applied it.
    edges: Arc<Refetcher>,
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
            // None only while the runtime shuts down, when the delivery stays unprocessed anyway.
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                // Only now, with the delivery in every account's mirror (or given up there), so
                // no lagging lane can apply it over the read-back. Each lane applies in delivery
                // order, so whatever came before it is in too.
                let read_back = job
                    .change
                    .refetch()
                    .map(|(subject, kind, at_once)| job.edges.schedule(subject, kind, at_once));
                rt.spawn(async move {
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
                    if let Some(read_back) = read_back
                        && read_back.await.is_err()
                    {
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

/// Reads each delivery once and hands it to the lane of every account it fans out to.
async fn dispatch(
    sinks: Sinks,
    in_flight: Arc<InFlight>,
    mut rx: mpsc::UnboundedReceiver<Delivery>,
) {
    // One lane per account that has had a delivery since this start: a handful of teammates.
    // Dropped with the dispatcher, which aborts them.
    let mut lanes: HashMap<i64, Lane> = HashMap::new();
    let mut running = JoinSet::new();
    loop {
        let d = tokio::select! {
            d = rx.recv() => match d {
                Some(d) => d,
                None => return,
            },
            Some(ended) = running.join_next_with_id() => {
                lane_ended(&sinks, &mut lanes, ended).await;
                continue;
            }
        };
        let started = Instant::now();
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
                        mark_for_resync(&sinks.control, account).await;
                        t.finish();
                        break;
                    }
                    // Its lane died with deliveries in hand: a new one takes this one.
                    Err(mpsc::error::TrySendError::Closed(t)) => {
                        eprintln!("webhooks: account {account}'s lane stopped; starting another");
                        lanes.remove(&account);
                        mark_for_resync(&sinks.control, account).await;
                        ticket = t;
                    }
                }
            }
        }
    }
}

fn spawn_settle(sinks: &Sinks, in_flight: &Arc<InFlight>, guid: String) {
    let (control, in_flight) = (sinks.control.clone(), in_flight.clone());
    tokio::spawn(async move { settle(&control, &in_flight, &guid).await });
}

/// A lane's task ended, which only a panic does while the dispatcher runs: what it held is given
/// up, so its account may now be missing deliveries that a later one doesn't cover.
async fn lane_ended(
    sinks: &Sinks,
    lanes: &mut HashMap<i64, Lane>,
    ended: Result<(tokio::task::Id, ()), tokio::task::JoinError>,
) {
    let task = match &ended {
        Ok((id, ())) => *id,
        Err(e) => e.id(),
    };
    let Some(account) = lanes.iter().find(|(_, l)| l.task == task).map(|(a, _)| *a) else {
        return;
    };
    eprintln!("webhooks: account {account}'s lane stopped ({ended:?}); starting another");
    lanes.remove(&account);
    mark_for_resync(&sinks.control, account).await;
}

/// One account's deliveries, applied to its mirror in the order they were received.
async fn lane(sinks: Sinks, account: i64, mut rx: mpsc::Receiver<Ticket>) {
    while let Some(ticket) = rx.recv().await {
        apply(&sinks, account, &ticket.job).await;
        ticket.finish();
    }
}

/// Writes the delivery to one account's mirror and pushes what changed. A failed write marks the
/// account `needs_resync`, for a sweep to repair; the lane waits until that's recorded.
async fn apply(sinks: &Sinks, account: i64, job: &Arc<Job>) {
    let j = job.clone();
    let written = sinks
        .mirrors
        .write(account, Caller::Webhook, move |tx, seq| {
            Ok((j.change.write(tx, seq)?, j.change.hidden(tx)?))
        })
        .await;
    match written {
        Ok((ids, hidden)) => {
            if ids.len() > MAX_IDS {
                sinks.hub.publish(account, Push::Reset);
            } else if !ids.is_empty() {
                sinks.hub.publish(account, Push::Ids(ids.into()));
            }
            if hidden {
                eprintln!(
                    "webhooks: {} {} names an end no installation token shows account {account}; marking it for resync",
                    job.event, job.guid
                );
                mark_for_resync(&sinks.control, account).await;
            }
        }
        Err(e) => {
            eprintln!(
                "webhooks: delivery {} failed for account {account}: {e}",
                job.guid
            );
            mark_for_resync(&sinks.control, account).await;
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

pub(crate) async fn mark_for_resync(control: &Control, account: i64) {
    until_ok(&format!("marking account {account} for resync"), || {
        control.write(move |tx| control_db::q::set_needs_resync(tx, account))
    })
    .await;
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

#[derive(Deserialize)]
struct Repository {
    id: i64,
}

#[derive(Deserialize)]
pub(crate) struct User {
    id: i64,
    pub login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct Label {
    id: i64,
    name: String,
    #[serde(default)]
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct Milestone {
    id: i64,
    number: i64,
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
    assignees: Vec<User>,
    milestone: Option<Milestone>,
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
    milestone: Option<Milestone>,
    installation: Option<Installation>,
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
}

/// One delivery's change to a repo, ready to write to each account's mirror.
struct RepoChange {
    repo: i64,
    change: Change,
}

enum Change {
    Issue(Issue),
    IssueDeleted(i64),
    Comment { issue: Issue, comment: Comment },
    CommentDeleted { issue: Issue, comment: i64 },
    Label(Label),
    LabelDeleted(i64),
    Milestone(Milestone),
    MilestoneDeleted(i64),
    Relationship(Relationship),
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

    /// Whether this account may miss the change for good. Across repos, what the delivery
    /// doesn't apply is left to the read-back, which reads with the delivery's installation
    /// token: blind to a private repo the account syncs through another installation (another
    /// owner). Only a sweep can find an end there; the account's own token is never spent on it.
    fn hidden(&self, tx: &Transaction) -> rusqlite::Result<bool> {
        if self.same_repo || self.applicable(tx)?.is_some() {
            return Ok(false);
        }
        match self.installation {
            Some(i) => q::syncs_beyond_installation(tx, i),
            // No read-back at all.
            None => Ok(true),
        }
    }
}

impl RepoChange {
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
        ) {
            return Ok(None);
        }
        let mut p: Payload = serde_json::from_slice(payload)?;
        let Some(repo) = p.repository.map(|r| r.id) else {
            return Ok(None);
        };
        let action = std::mem::take(&mut p.action);
        let installation = p.installation.as_ref().map(|i| i.id);
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
            // Transfers re-point relationships and come with their own slice.
            ("issues", "transferred") => None,
            ("issues", "deleted") => p.issue.map(|i| Change::IssueDeleted(i.id)),
            // Every other action carries the whole issue as it is now: `typed` and `untyped`
            // too, whose `issue.type` is the new type (null once untyped).
            ("issues", _) => p.issue.map(Change::Issue),
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
            _ => None,
        };
        Ok(change.map(|change| RepoChange { repo, change }))
    }

    /// The read-back a relationship delivery calls for: its repo's issue, the kind, and whether
    /// it runs at once (the other end is in another repo, or the delivery didn't say).
    fn refetch(&self) -> Option<(Subject, Kind, bool)> {
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
        Some((
            Subject {
                id: r.subject.id,
                node_id: r.subject.node_id.clone(),
                repo: self.repo,
                installation,
            },
            r.kind,
            !r.same_repo,
        ))
    }

    /// Whether this account may miss a relationship change for good, so that only a sweep can
    /// repair it ([`Relationship::hidden`]).
    fn hidden(&self, tx: &Transaction) -> rusqlite::Result<bool> {
        match &self.change {
            Change::Relationship(r) => r.hidden(tx),
            _ => Ok(false),
        }
    }

    /// Writes the change in one account's transaction; the ids of the items whose rows it
    /// changed (none when the guard kept everything as it was), and of the items that show
    /// something of them (an ancestor's progress, a blocked issue's chips).
    fn write(&self, tx: &Transaction, seq: i64) -> rusqlite::Result<Vec<i64>> {
        let repo = self.repo;
        Ok(match &self.change {
            Change::Issue(i) => {
                if upsert_issue(tx, repo, i, seq)? {
                    edges::with_neighbours(tx, BTreeSet::from([i.id]))?
                } else {
                    Vec::new()
                }
            }
            Change::IssueDeleted(id) => {
                q::record_deleted(tx, "item", *id)?;
                // Whatever showed something of it, before its edges go.
                let shown = edges::with_neighbours(tx, BTreeSet::from([*id]))?;
                let ends = edges::ends_of(tx, *id)?;
                let gone = q::delete_item(tx, *id)? > 0;
                q::clear_item_labels(tx, *id)?;
                q::clear_item_assignees(tx, *id)?;
                q::delete_item_comments(tx, *id)?;
                q::delete_item_edges(tx, *id)?;
                q::prune_stubs(tx, &ends)?;
                if gone { shown } else { Vec::new() }
            }
            Change::Relationship(r) => {
                let mut ids = BTreeSet::new();
                if upsert_issue(tx, repo, &r.subject, seq)? {
                    ids.extend(edges::with_neighbours(tx, BTreeSet::from([r.subject.id]))?);
                }
                if let Some(e) = r.applicable(tx)? {
                    ids.extend(edges::apply_delivery(tx, seq, e)?);
                }
                ids.into_iter().collect()
            }
            Change::Comment { issue, comment } => {
                let issue_changed = upsert_issue(tx, repo, issue, seq)?;
                let comment_changed = write_comment(tx, issue.id, comment, seq)?;
                ids_if(issue_changed || comment_changed, issue.id)
            }
            Change::CommentDeleted { issue, comment } => {
                let mut changed = upsert_issue(tx, repo, issue, seq)?;
                q::record_deleted(tx, "comment", *comment)?;
                if q::delete_comment(tx, *comment)? > 0 {
                    q::recount_last_commented(tx, issue.id, seq)?;
                    changed = true;
                }
                ids_if(changed, issue.id)
            }
            Change::Label(l) => {
                q::upsert_label(tx, l.id, repo, &l.name, &l.color, l.description.as_deref())?;
                q::label_items(tx, l.id)?
            }
            Change::LabelDeleted(id) => {
                q::record_deleted(tx, "label", *id)?;
                let ids = q::label_items(tx, *id)?;
                q::unlink_label(tx, *id)?;
                q::delete_label(tx, *id)?;
                ids
            }
            Change::Milestone(m) => {
                if upsert_milestone(tx, repo, m)? {
                    q::milestone_items(tx, m.id)?
                } else {
                    Vec::new()
                }
            }
            Change::MilestoneDeleted(id) => {
                q::record_deleted(tx, "milestone", *id)?;
                let ids = q::milestone_items(tx, *id)?;
                q::clear_milestone(tx, *id, seq)?;
                q::delete_milestone(tx, *id)?;
                ids
            }
        })
    }
}

/// Writes an issue from GitHub's answer to one of beghu's own writes, as its webhook would (under
/// the `updated_at` guard): false if the mirror already had it as new or newer.
pub(crate) fn write_issue(
    tx: &Transaction,
    repo: i64,
    issue: &Issue,
    seq: i64,
) -> rusqlite::Result<bool> {
    upsert_issue(tx, repo, issue, seq)
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

/// Writes the issue under the `updated_at` guard; with it, its labels, assignees, author and
/// milestone. False when the mirror already had it as new or newer. An update SETs only the
/// columns whose values changed, so it rewrites only their indexes (see `webhooks.sql`).
fn upsert_issue(tx: &Transaction, repo: i64, i: &Issue, seq: i64) -> rusqlite::Result<bool> {
    let pr = i.pull_request.is_some();
    let kind = if pr { "pr" } else { "issue" };
    // Never on a PR, as the import leaves it.
    let issue_type = i
        .issue_type
        .as_ref()
        .filter(|_| !pr)
        .map(|t| t.name.as_str());
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
    q::clear_item_labels(tx, i.id)?;
    for l in &i.labels {
        q::add_label(tx, l.id, repo, &l.name, &l.color, l.description.as_deref())?;
        q::link_item_label(tx, i.id, l.id)?;
    }
    q::clear_item_assignees(tx, i.id)?;
    for a in &i.assignees {
        q::upsert_user(tx, a.id, &a.login, a.avatar_url.as_deref())?;
        q::add_item_assignee(tx, i.id, a.id)?;
    }
    Ok(true)
}

/// GitHub's RFC 3339 timestamps (`2026-10-13T08:22:19Z`, or with an offset or fractional
/// seconds) as Unix seconds; 0 for one that doesn't parse.
pub(crate) fn time(s: &str) -> i64 {
    parse_time(s).unwrap_or(0)
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
    use super::parse_time;

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
