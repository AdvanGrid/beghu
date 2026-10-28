//! Relationship writes: from webhooks, and from the read-backs that follow them. The same
//! scheduler runs the PR read-backs (`pulls.rs`), one at a time per PR, which bring a PR's own
//! fields and its linked PRs (`closes` edges, replaced as a set by [`replace`]).
//!
//! A relationship delivery carries no timestamp, so it can't be ordered against others the way
//! an issue's `updated_at` orders issue deliveries. Within a repo it names both ends and is
//! applied at once ([`apply_delivery`]); then, once every account has applied it, that issue's
//! edges of that kind are read back from GitHub about 2 s later (debounced) and replace the set
//! ([`Refetcher`]). Across repos a delivery carries only its own repo's issue, so the read-back
//! runs at once: it is usually the only way to learn the other end. (A cross-repo delivery that
//! does name the other end's id is applied by id too: a removal wherever it is, an addition for an
//! account whose mirror holds that end in a repo it syncs.) Every delivery schedules one after
//! it is applied everywhere, so whatever order deliveries arrive or apply in, the last read-back
//! starts after the last delivery and leaves GitHub's state. A delivery is marked processed only
//! once a read-back that started after it has landed or been given up, so one still waiting when
//! the process stops is replayed, and read back, at the next start.
//!
//! The same read-backs, one per issue, also read an issue itself (`GET …/issues/{n}`, one call)
//! after a delivery a mirror couldn't order against what it has (`webhook.rs`, `upsert_issue`):
//! GitHub's answer is written to every account syncing the repo, as the issue is now. And after a
//! transfer into a synced repo they read the new issue's comment thread (`GET …/comments`), which
//! replaces the one the mirror moved over from the old issue.
//!
//! A read-back GitHub fails is tried again on [`Config::read_back_retries`](crate::Config);
//! past the last of them, or when no try can do better (the installation is gone, or the issue
//! has more relates-to than a read-back follows), every account syncing the repo is marked
//! `needs_resync`, for a sweep to read what was missed. An issue GitHub can't show the
//! installation (deleted since, or out of sight) marks only the accounts whose mirror still holds
//! it; one GitHub answers with a 301 (transferred since) marks none, since its transfer's own
//! deliveries move it.
//!
//! A rate limit is none of those failures: it pauses the installation's background reads
//! (`reconcile::Budgets`, which the sweeps and the poller honour too), and the read-back is tried
//! again once the pause is over, however long that takes, never given up for it. A read-back due
//! while its installation is paused waits the pause out before it reads.
//!
//! The read-back is fetched once, with the App's installation token, and written to every account
//! syncing the issue's repo; a read-back never spends an account's own token. The installation
//! token sees only its installation's repos and public ones, so an edge into a private repo an
//! account syncs through another installation (another owner) is missing from it, not gone: the
//! account keeps it. Such an edge comes only from a delivery that names its other end, or from a
//! sweep: a delivery that leaves it unknown marks the account `needs_resync` (see
//! [`webhook`]). Isolation: an end in a repo the account doesn't sync is kept only if
//! the repo is public, and then as a stub; any other end is dropped for that account, never
//! stored. An item deleted by a webhook never gets an edge again. A stub no edge references any
//! more is deleted.

use crate::github::Shown;
use crate::import::writes::{CommentData, write_comments};
use crate::installations::{Installations, Scope};
use crate::jobs::Jobs;
use crate::live::{Hub, Push};
use crate::reconcile::Budgets;
use crate::webhook;
use control_db::Control;
use mirror_db::{Caller, Mirrors, q};
use rusqlite::Transaction;
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, oneshot};
use tokio::task::AbortHandle;
use tokio::time::Instant;

/// Past this many ids, a push is a `reset` (as for webhooks).
const MAX_IDS: usize = 256;

/// How long after a delivery within a repo its edges are read back.
pub const REFETCH_AFTER: Duration = Duration::from_secs(2);

/// The longest a steady stream of deliveries holds a read-back off, from the first of them.
const MAX_DEBOUNCE: Duration = Duration::from_secs(10);

/// How many times in a row an issue is read again because GitHub's answer still says otherwise
/// than the mirror. Past it the read-back is given up, its accounts marked for resync: answers
/// that never settle (one the mirror can't take, say) aren't read forever.
const MAX_REREADS: usize = 5;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    /// Parent → child.
    Sub,
    /// Blocker → blocked.
    Blocks,
    /// Smaller id → larger id.
    Relates,
    /// PR → the issue it closes: a linked PR, read back with the PR (`pulls.rs`), never by
    /// `IssueEdges`.
    Closes,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Sub => "sub",
            Kind::Blocks => "blocks",
            Kind::Relates => "relates",
            Kind::Closes => "closes",
        }
    }
}

/// The issue a read-back reads.
#[derive(Clone, Debug)]
pub struct Subject {
    pub id: i64,
    pub node_id: String,
    pub number: i64,
    pub repo: i64,
    pub installation: i64,
}

/// What a read-back reads of its issue.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ReadBack {
    /// Its edges of one kind (not `Closes`, which is read with the PR).
    Edges(Kind),
    /// The issue itself: its fields, labels and assignees.
    Issue,
    /// Its linked PRs in repos an account syncing it doesn't sync (`pulls.rs`): what only the
    /// issue's side shows of them.
    LinkedPulls,
    /// Its comment thread, after a transfer brought it into a synced repo (`webhook.rs`).
    Comments,
}

impl std::fmt::Display for ReadBack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadBack::Edges(k) => write!(f, "{} edges", k.name()),
            ReadBack::Issue => f.write_str("fields"),
            ReadBack::LinkedPulls => f.write_str("linked PRs"),
            ReadBack::Comments => f.write_str("comments"),
        }
    }
}

/// A read-back to run: something of an issue, or a PR (`pulls.rs`).
#[derive(Clone, Debug)]
enum Task {
    Item(Subject, ReadBack),
    Pull(crate::pulls::Pull),
}

/// One read-back per issue and what it reads, and per PR, runs at a time.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Key {
    Item(i64, ReadBack),
    /// A PR by its repo and number: what every signal about it names.
    Pull(i64, i64),
}

impl Task {
    fn key(&self) -> Key {
        match self {
            Task::Item(s, what) => Key::Item(s.id, *what),
            Task::Pull(p) => Key::Pull(p.repo, p.number),
        }
    }

    /// The repo whose accounts a read-back given up on are marked for resync.
    fn repo(&self) -> i64 {
        match self {
            Task::Item(s, _) => s.repo,
            Task::Pull(p) => p.repo,
        }
    }

    /// The installation whose token reads it, and whose rate limits it honours.
    fn installation(&self) -> i64 {
        match self {
            Task::Item(s, _) => s.installation,
            Task::Pull(p) => p.installation,
        }
    }
}

impl std::fmt::Display for Task {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Task::Item(s, what) => write!(f, "issue {}'s {what}", s.id),
            Task::Pull(p) => write!(f, "PR {}/{}#{}", p.owner, p.name, p.number),
        }
    }
}

/// One edge a delivery names: `src → dst` of `kind`, added or removed.
pub struct Edge {
    pub kind: Kind,
    pub src: i64,
    pub dst: i64,
    pub add: bool,
}

/// Applies an edge a delivery names, in one account's transaction. The items whose rows or
/// detail changed.
pub fn apply_delivery(tx: &Transaction, seq: i64, e: &Edge) -> rusqlite::Result<Vec<i64>> {
    let kind = e.kind.name();
    let ends = [e.src, e.dst];
    // Newer than what a sweep under way read of either end.
    for id in ends {
        q::touch_edges(tx, id, seq)?;
    }
    let mut touched: BTreeSet<i64> = ends.into_iter().collect();
    let changed = if e.add {
        if e.kind == Kind::Sub
            && let Some(old) = q::detach_child(tx, e.dst, e.src)?
        {
            // Its old parent's edges changed too.
            q::touch_edges(tx, old, seq)?;
            touched.insert(old);
            q::prune_stubs(tx, &[old])?;
        }
        q::add_edge(tx, kind, e.src, e.dst, seq)? > 0
    } else {
        let gone = q::remove_edge(tx, kind, e.src, e.dst)? > 0;
        q::prune_stubs(tx, &ends)?;
        gone
    };
    if !changed {
        return Ok(Vec::new());
    }
    with_neighbours(tx, touched)
}

/// Every item at the other end of any of `id`'s edges.
pub fn ends_of(tx: &Transaction, id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut ends = BTreeSet::new();
    for kind in ["sub", "blocks", "relates", "closes"] {
        for e in q::edges_of(tx, kind, id)? {
            ends.insert(if e.src_id == id { e.dst_id } else { e.src_id });
        }
    }
    Ok(ends.into_iter().collect())
}

/// `ids` and the items that show something of them: their ancestors (progress) and what they
/// block and are blocked by.
pub fn with_neighbours(tx: &Transaction, ids: BTreeSet<i64>) -> rusqlite::Result<Vec<i64>> {
    let list: Vec<i64> = ids.iter().copied().collect();
    let mut all = ids;
    all.extend(q::neighbours(tx, &list)?);
    Ok(all.into_iter().collect())
}

/// The read-back of one issue's edges, debounced per issue and kind. Dropping it stops every
/// read-back still waiting or running: their deliveries stay unprocessed for the next start.
pub struct Refetcher(Arc<Inner>);

pub(crate) struct Inner {
    pub(crate) control: Arc<Control>,
    pub(crate) mirrors: Mirrors,
    pub(crate) hub: Arc<Hub>,
    pub(crate) installations: Arc<Installations>,
    /// Each installation's rate-limit pause, shared with the sweeps and the poller.
    budgets: Arc<Budgets>,
    /// The waits between tries of a read-back GitHub fails; past the last, it gives up.
    retries: Vec<Duration>,
    /// Where the workers run, so the drain stops them (see `jobs.rs`).
    jobs: Jobs,
    /// The read-backs waiting or running, by issue and what they read, and by PR.
    pending: Mutex<HashMap<Key, Pending>>,
    /// The app, set once it's made: a thread read back has its images measured.
    app: std::sync::OnceLock<crate::WeakApp>,
}

struct Pending {
    /// When the next read-back is due; none while one runs with nothing after it.
    due: Option<Instant>,
    /// `due` is a debounce's, which a later delivery within the repo may push back. An at-once
    /// read-back's or a retry's it only ever brings forward.
    debounced: bool,
    /// When the first delivery the next read-back waits for arrived: the debounce never pushes
    /// `due` past [`MAX_DEBOUNCE`] from it.
    first: Instant,
    /// What to read, as the latest delivery named it.
    subject: Task,
    /// How many tries in a row GitHub has failed. A delivery may bring the next try forward but
    /// doesn't start the count again: only a read-back that lands does.
    failures: usize,
    /// How many issue read-backs in a row found the mirror still saying otherwise than GitHub
    /// (see [`MAX_REREADS`]).
    rereads: usize,
    /// Wakes the worker when a delivery brings `due` forward while it waits.
    wake: Arc<Notify>,
    /// The deliveries the next read-back answers for: each hears once it has landed or been
    /// given up.
    waiting: Vec<oneshot::Sender<()>>,
    /// The worker, stopped with the refetcher.
    worker: Option<AbortHandle>,
}

impl Drop for Refetcher {
    fn drop(&mut self) {
        let all = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
        for w in all.values().filter_map(|p| p.worker.as_ref()) {
            w.abort();
        }
    }
}

impl Refetcher {
    pub fn new(
        control: Arc<Control>,
        mirrors: Mirrors,
        hub: Arc<Hub>,
        installations: Arc<Installations>,
        budgets: Arc<Budgets>,
        retries: Vec<Duration>,
        jobs: Jobs,
    ) -> Refetcher {
        Refetcher(Arc::new(Inner {
            control,
            mirrors,
            hub,
            installations,
            budgets,
            retries,
            jobs,
            pending: Mutex::default(),
            app: std::sync::OnceLock::new(),
        }))
    }

    /// Hands the refetcher the app it's part of, once the app is made.
    pub(crate) fn set_app(&self, app: crate::WeakApp) {
        let _ = self.0.app.set(app);
    }

    /// Reads `what` of `subject` back from GitHub: at once, or after [`REFETCH_AFTER`] (each new
    /// call within it starts the delay again, up to [`MAX_DEBOUNCE`] from the first). One
    /// read-back per issue and `what` runs at a time; a call while one runs queues one more after
    /// it. The receiver hears once a read-back that started after this call has landed or been
    /// given up; it errs if the refetcher stops first.
    pub fn schedule(
        &self,
        subject: Subject,
        kind: ReadBack,
        at_once: bool,
    ) -> oneshot::Receiver<()> {
        schedule(&self.0, subject, kind, at_once)
    }

    /// Reads PR `pull` back (`pulls.rs`), as [`Refetcher::schedule`] does an issue: one
    /// read-back per PR at a time.
    pub fn schedule_pull(&self, pull: crate::pulls::Pull, at_once: bool) -> oneshot::Receiver<()> {
        enqueue(&self.0, Task::Pull(pull), at_once)
    }
}

/// [`Refetcher::schedule`], from inside a read-back too.
fn schedule(
    inner: &Arc<Inner>,
    subject: Subject,
    kind: ReadBack,
    at_once: bool,
) -> oneshot::Receiver<()> {
    enqueue(inner, Task::Item(subject, kind), at_once)
}

/// Schedules `subject`'s read-back, as [`Refetcher::schedule`] says.
fn enqueue(inner: &Arc<Inner>, subject: Task, at_once: bool) -> oneshot::Receiver<()> {
    let (done, heard) = oneshot::channel();
    let now = Instant::now();
    let key = subject.key();
    let mut all = inner.pending.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = all.get_mut(&key) {
        if p.due.is_none() {
            p.first = now;
        }
        let due = if at_once {
            now
        } else {
            (now + REFETCH_AFTER).min(p.first + MAX_DEBOUNCE)
        };
        let (next, debounced) = match p.due {
            Some(d) if (at_once || !p.debounced) && d <= due => (d, p.debounced),
            _ => (due, !at_once),
        };
        let sooner = p.due.is_some_and(|d| next < d);
        p.due = Some(next);
        p.debounced = debounced;
        p.subject = subject;
        p.waiting.push(done);
        if sooner {
            p.wake.notify_one();
        }
        return heard;
    }
    let due = if at_once { now } else { now + REFETCH_AFTER };
    let worker = inner.jobs.spawn(worker(inner.clone(), key)).abort_handle();
    all.insert(
        key,
        Pending {
            due: Some(due),
            debounced: !at_once,
            first: now,
            subject,
            failures: 0,
            rereads: 0,
            wake: Arc::default(),
            waiting: vec![done],
            worker: Some(worker),
        },
    );
    heard
}

/// Runs the read-backs for one issue and `what`, or one PR, until none is due.
async fn worker(inner: Arc<Inner>, key: Key) {
    loop {
        let (due, subject, wake, answers) = {
            let mut all = inner.pending.lock().unwrap_or_else(|e| e.into_inner());
            let Some(p) = all.get_mut(&key) else { return };
            let Some(mut due) = p.due else {
                all.remove(&key);
                return;
            };
            // GitHub asked the installation to wait (a rate limit): the read-back waits it out.
            if let Some(wait) = inner.budgets.get(p.subject.installation()).paused() {
                due = due.max(Instant::now() + wait);
                p.due = Some(due);
            }
            if due > Instant::now() {
                (Some(due), p.subject.clone(), p.wake.clone(), Vec::new())
            } else {
                p.due = None;
                let answers = std::mem::take(&mut p.waiting);
                (None, p.subject.clone(), p.wake.clone(), answers)
            }
        };
        let Some(due) = due else {
            let tried = match &subject {
                Task::Item(s, ReadBack::Edges(kind)) => refetch(&inner, s, *kind).await,
                Task::Item(s, ReadBack::Issue) => reread(&inner, s).await,
                Task::Item(s, ReadBack::Comments) => rethread(&inner, s).await,
                Task::Item(s, ReadBack::LinkedPulls) => {
                    crate::pulls::refetch_linked(&inner, s).await
                }
                Task::Pull(p) => crate::pulls::refetch(&inner, p).await,
            };
            conclude(&inner, key, &subject, tried, answers).await;
            continue;
        };
        // A delivery may bring the read-back forward meanwhile.
        tokio::select! {
            () = tokio::time::sleep_until(due) => {}
            () = wake.notified() => {}
        }
    }
}

/// Why a read-back didn't land.
pub(crate) enum Failure {
    /// GitHub failed, or the control DB did: worth trying again.
    Retry(String),
    /// Nothing to try again: the installation is gone, say.
    GiveUp(String),
    /// GitHub's rate limit: the installation's background reads pause this long, and the
    /// read-back is tried again after it, however often (a rate limit lifts).
    Limited(Duration),
}

/// A call GitHub failed, as a read-back's failure: a rate limit pauses, anything else is worth
/// trying again.
pub(crate) fn failure(e: crate::github::CallError) -> Failure {
    use crate::github::CallError;
    match e {
        CallError::RateLimited(wait) => Failure::Limited(wait),
        CallError::SecondaryLimit => Failure::Limited(crate::reconcile::SECONDARY_WAIT),
        e => Failure::Retry(e.to_string()),
    }
}

/// After one try at a read-back: schedules the next try of a failed one (unless a delivery
/// since already asked for one), with the deliveries it answers for still waiting on it. Past
/// the last of the retries, or when there's nothing to try again, gives up and marks every
/// account syncing the repo for resync: a sweep will read what it missed. A read-back that
/// landed or was given up tells the deliveries it answers for.
async fn conclude(
    inner: &Inner,
    key: Key,
    s: &Task,
    tried: Result<(), Failure>,
    answers: Vec<oneshot::Sender<()>>,
) {
    let why = {
        let mut all = inner.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(p) = all.get_mut(&key) else { return };
        match tried {
            Ok(()) => {
                p.failures = 0;
                None
            }
            Err(Failure::Retry(why)) => match inner.retries.get(p.failures) {
                Some(wait) => {
                    p.failures += 1;
                    let retry = Instant::now() + *wait;
                    if p.due.is_none_or(|d| retry < d) {
                        p.due = Some(retry);
                        p.debounced = false;
                    }
                    p.waiting.extend(answers);
                    eprintln!("edges: reading {s} failed, trying again in {wait:?}: {why}");
                    return;
                }
                None => {
                    p.failures = 0;
                    Some(format!("failed {} times: {why}", inner.retries.len() + 1))
                }
            },
            Err(Failure::GiveUp(why)) => {
                p.failures = 0;
                Some(why)
            }
            Err(Failure::Limited(wait)) => {
                inner.budgets.pause(s.installation(), wait);
                let retry = Instant::now() + wait;
                if p.due.is_none_or(|d| d < retry) {
                    p.due = Some(retry);
                    p.debounced = false;
                }
                p.waiting.extend(answers);
                eprintln!("edges: reading {s} was rate limited, trying again in {wait:?}");
                return;
            }
        }
    };
    if let Some(why) = why {
        let repo = s.repo();
        eprintln!(
            "edges: giving up reading {s} ({why}); marking the accounts syncing repo {repo} for resync"
        );
        let what = format!("reading who syncs repo {repo}");
        for account in webhook::syncing(&inner.control, repo, &what).await {
            webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
        }
    }
    for a in answers {
        // A delivery that stopped listening has nothing left to settle.
        let _ = a.send(());
    }
}

/// One end of a relationship or a linked PR, with its repository: [`End`].
macro_rules! end_fragment {
    () => {
        "\nfragment End on Issue {
  id databaseId number title state
  repository { databaseId id name owner { login } isPrivate }
}"
    };
}
pub(crate) use end_fragment;

/// `IssueEdges`: an issue's relationships of the kinds asked for, each end with its repository.
/// GitHub caps sub-issues at 100 and dependencies at 50 of each kind, so one page holds them;
/// relates-to has no documented cap and is paged, `$relatesAfter` naming the page before.
const QUERY: &str = concat!(
    "query IssueEdges($id: ID!, $sub: Boolean!, $blocks: Boolean!, $relates: Boolean!, $relatesAfter: String) {
  node(id: $id) {
    ... on Issue {
      databaseId
      parent @include(if: $sub) { ...End }
      subIssues(first: 100) @include(if: $sub) { nodes { ...End } }
      blockedBy(first: 50) @include(if: $blocks) { nodes { ...End } }
      blocking(first: 50) @include(if: $blocks) { nodes { ...End } }
      relatesTo(first: 100, after: $relatesAfter) @include(if: $relates) {
        pageInfo { hasNextPage endCursor }
        nodes { ...End }
      }
    }
  }
}",
    end_fragment!()
);

#[derive(Deserialize)]
struct Data {
    node: Option<Node>,
}

/// An issue's relationships as `IssueEdges` (and the sweeps' `SweepEdges`) answer them.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Node {
    parent: Option<End>,
    sub_issues: Option<Nodes>,
    blocked_by: Option<Nodes>,
    blocking: Option<Nodes>,
    relates_to: Option<Nodes>,
}

impl Node {
    /// Whether its relates-to goes on past the page read.
    pub(crate) fn more_relates(&self) -> bool {
        self.relates_to
            .as_ref()
            .and_then(|r| r.page_info.as_ref())
            .is_some_and(|p| p.has_next_page)
    }
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Nodes {
    #[serde(default)]
    pub(crate) nodes: Vec<Option<End>>,
    pub(crate) page_info: Option<PageInfo>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageInfo {
    pub(crate) has_next_page: bool,
    pub(crate) end_cursor: Option<String>,
}

/// The most pages of relates-to one read-back follows: 10,000 links.
const MAX_PAGES: usize = 100;

impl Nodes {
    fn ends(self) -> impl Iterator<Item = End> {
        self.nodes.into_iter().flatten()
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct End {
    id: String,
    pub(crate) database_id: i64,
    number: i64,
    title: String,
    state: String,
    repository: EndRepo,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndRepo {
    database_id: i64,
    id: String,
    name: String,
    owner: Owner,
    is_private: bool,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Owner {
    pub(crate) login: String,
}

impl From<&crate::import::shapes::Target> for End {
    fn from(t: &crate::import::shapes::Target) -> End {
        End {
            id: t.id.clone(),
            database_id: t.database_id,
            number: t.number,
            title: t.title.clone(),
            state: t.state.clone(),
            repository: EndRepo {
                database_id: t.repository.database_id,
                id: t.repository.id.clone(),
                name: t.repository.name.clone(),
                owner: Owner {
                    login: t.repository.owner.login.clone(),
                },
                is_private: t.repository.is_private,
            },
        }
    }
}

/// An issue's edges of one kind as GitHub has them: `(src, dst, end)`, the end being the other
/// issue, with sub-issues in GitHub's order.
pub(crate) struct Fetched {
    pub(crate) edges: Vec<(i64, i64, End)>,
}

/// A read-back token for `s`'s installation.
pub(crate) async fn token(inner: &Inner, s: &Subject) -> Result<String, Failure> {
    match inner
        .installations
        .token(s.installation, Scope::ReadBack)
        .await
    {
        Ok(t) => Ok(t),
        // The installation is gone (GitHub answers 404 for its token): no try will do better.
        Err(crate::github::Error::Status(404)) => Err(Failure::GiveUp(format!(
            "installation {} is gone",
            s.installation
        ))),
        Err(e) => Err(failure(e.into())),
    }
}

/// The accounts syncing `repo`, or a failure worth trying again.
async fn targets(inner: &Inner, repo: i64) -> Result<Vec<i64>, Failure> {
    inner
        .control
        .read(move |c| control_db::q::fan_out_targets(c, repo))
        .await
        .map_err(|e| Failure::Retry(format!("reading who syncs repo {repo} failed: {e}")))
}

/// Reads issue `s` itself with the App's installation token (one `GET`) and writes it to every
/// account syncing its repo, as GitHub has it now: over the mirror's row unless that is newer, a
/// deleted item never written again, a repo no longer synced not written at all. One that
/// overwrote a row of its own second is read again after the debounce (a change of that second
/// may have come after GitHub answered), until a read finds the mirror as it says, or for
/// [`MAX_REREADS`] reads in a row: then it's given up, its accounts marked for resync.
async fn reread(inner: &Arc<Inner>, s: &Subject) -> Result<(), Failure> {
    let repo = s.repo;
    let targets = targets(inner, repo).await?;
    // Where the repo is, as a mirror syncing it names it.
    let mut place = None;
    for &account in &targets {
        if let Ok(Some(r)) = inner
            .mirrors
            .read(account, Caller::Webhook, move |c| q::repo_state(c, repo))
            .await
        {
            place = Some((r.owner, r.name));
            break;
        }
    }
    let Some((owner, name)) = place else {
        // No mirror syncs it any more: nothing to write.
        return Ok(());
    };
    let issue = {
        let _turn = inner.installations.read_turn(s.installation).await;
        let token = token(inner, s).await?;
        let gh = inner.installations.github();
        match gh.issue(&token, &owner, &name, s.number).await {
            Ok(i) => i,
            Err(e) => {
                if matches!(e, crate::github::Error::Unauthorized) {
                    inner
                        .installations
                        .drop_token(s.installation, Scope::ReadBack, &token);
                }
                return Err(failure(e.into()));
            }
        }
    };
    let issue = match issue {
        Shown::It(i) if i.id() == s.id => i,
        // Transferred since: its own deliveries (`issues.transferred` here, `issues.opened`
        // where it went) move it, so there's nothing missed to sweep for. Were both lost, the
        // count check finds the old one gone.
        Shown::Moved => {
            eprintln!(
                "edges: issue {} was transferred; its transfer's deliveries move it",
                s.id
            );
            return Ok(());
        }
        // Deleted, a number GitHub now answers with another issue, or out of sight.
        _ => {
            unseen_subject(inner, s, &targets).await;
            return Ok(());
        }
    };
    let issue = Arc::new(issue);
    let mut again = false;
    for account in targets {
        let read = issue.clone();
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                if !crate::import::synced(tx, repo)? {
                    return Ok((Vec::new(), false));
                }
                let w = webhook::write_issue(tx, repo, &read, seq)?;
                if !w.changed {
                    return Ok((Vec::new(), w.reread));
                }
                Ok((with_neighbours(tx, BTreeSet::from([read.id()]))?, w.reread))
            })
            .await;
        if let Ok((_, true)) = &written {
            again = true;
        }
        match written.map(|(ids, _)| ids) {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) if ids.len() > MAX_IDS => inner.hub.publish(account, Push::Reset),
            Ok(ids) => inner.hub.publish(account, Push::Ids(ids.into())),
            // The account lost access and its mirror is deleted: nothing to repair.
            Err(mirror_db::Error::Deleted) => {}
            Err(e) => {
                eprintln!(
                    "edges: writing issue {} as read again failed for account {account}: {e}",
                    s.id
                );
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
            }
        }
    }
    let settled_never = {
        let mut all = inner.pending.lock().unwrap_or_else(|e| e.into_inner());
        all.get_mut(&Key::Item(s.id, ReadBack::Issue))
            .is_some_and(|p| {
                p.rereads = if again { p.rereads + 1 } else { 0 };
                let over = p.rereads >= MAX_REREADS;
                if over {
                    p.rereads = 0;
                }
                over
            })
    };
    if settled_never {
        return Err(Failure::GiveUp(format!(
            "GitHub's answer still said otherwise than the mirror after {MAX_REREADS} reads in a row"
        )));
    }
    if again {
        drop(schedule(inner, s.clone(), ReadBack::Issue, false));
    }
    Ok(())
}

impl Inner {
    /// Measures the images in `posts`, written to `account`'s mirror, in the background, as a
    /// webhook's are; what they find pushes `item` again. Nothing waits for them.
    pub(crate) fn measure(
        &self,
        account: i64,
        item: i64,
        posts: Vec<crate::media::probe::Incoming>,
    ) {
        let Some(app) = self.app.get().and_then(crate::WeakApp::upgrade) else {
            return;
        };
        self.jobs.spawn(async move {
            crate::media::probe::ingest(&app, account, posts, Duration::ZERO, Some(item)).await;
        });
    }
}

/// Reads issue `s`'s comment thread with the App's installation token (`GET …/comments`, paged)
/// and makes it the thread every account syncing its repo holds: GitHub's comments written under
/// the usual `updated_at` guard, and any comment of the issue the mirror holds that GitHub
/// doesn't list forgotten, unless something wrote it after the read began (each account's last
/// transaction before it). A transfer moves the old issue's comments onto the new one by their
/// ids; whether GitHub keeps those ids is unmeasured (docs/research/issue-edge-cases.md), and
/// this leaves the thread right either way. An issue GitHub no longer shows (transferred again,
/// deleted) has nothing to read: its own deliveries say what happened. The images in a thread
/// that changed are measured after (`media/probe.rs`), as a webhook's are.
async fn rethread(inner: &Arc<Inner>, s: &Subject) -> Result<(), Failure> {
    let repo = s.repo;
    let targets = targets(inner, repo).await?;
    let mut starts = HashMap::new();
    let mut place = None;
    for &account in &targets {
        let read = inner
            .mirrors
            .read(account, Caller::Webhook, move |c| {
                Ok((q::current_seq(c)?, q::repo_state(c, repo)?))
            })
            .await;
        match read {
            Ok((start, r)) => {
                starts.insert(account, start);
                if let Some(r) = r.filter(|_| place.is_none()) {
                    place = Some((r.owner, r.name));
                }
            }
            // The account lost access and its mirror is deleted: nothing to write there.
            Err(mirror_db::Error::Deleted) => {}
            Err(e) => {
                return Err(Failure::Retry(format!(
                    "reading account {account}'s mirror: {e}"
                )));
            }
        }
    }
    let Some((owner, name)) = place else {
        // No mirror syncs it any more: nothing to write.
        return Ok(());
    };
    let read = {
        let _turn = inner.installations.read_turn(s.installation).await;
        let token = token(inner, s).await?;
        let gh = inner.installations.github();
        match gh.issue_comments(&token, &owner, &name, s.number).await {
            Ok(r) => r,
            Err(e) => {
                if matches!(e, crate::github::Error::Unauthorized) {
                    inner
                        .installations
                        .drop_token(s.installation, Scope::ReadBack, &token);
                }
                return Err(failure(e.into()));
            }
        }
    };
    let Shown::It(listed) = read else {
        return Ok(());
    };
    let item = s.id;
    let thread: Arc<Vec<CommentData>> = Arc::new(
        listed
            .into_iter()
            .map(|c| CommentData::from_rest(item, c))
            .collect(),
    );
    for account in targets {
        let Some(&start) = starts.get(&account) else {
            continue;
        };
        let posts: Vec<_> = thread.iter().map(CommentData::incoming).collect();
        let thread = thread.clone();
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                if !crate::import::synced(tx, repo)? || q::item_repos(tx, &[item])?.is_empty() {
                    return Ok(false);
                }
                let mut changed = !write_comments(tx, seq, &thread)?.is_empty();
                let listed: HashSet<i64> = thread.iter().map(|c| c.id).collect();
                for c in q::item_comment_seqs(tx, item)? {
                    if !listed.contains(&c.id) && c.seq <= start {
                        changed |= webhook::forget_comment(tx, item, c.id, seq)?;
                    }
                }
                Ok(changed)
            })
            .await;
        match written {
            Ok(false) => {}
            Ok(true) => {
                inner.hub.publish(account, Push::Ids(vec![item].into()));
                inner.measure(account, item, posts);
            }
            // The account lost access and its mirror is deleted: nothing to repair.
            Err(mirror_db::Error::Deleted) => {}
            Err(e) => {
                eprintln!(
                    "edges: writing issue {item}'s comments as read again failed for account {account}: {e}"
                );
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
            }
        }
    }
    Ok(())
}

/// Reads `s`'s edges of `kind` with the App's installation token: what the installation sees.
async fn fetch(inner: &Inner, s: &Subject, kind: Kind) -> Result<Option<Fetched>, Failure> {
    let _turn = inner.installations.read_turn(s.installation).await;
    let token = token(inner, s).await?;
    read_edges(s, kind, |vars| {
        let token = &token;
        async move {
            match inner
                .installations
                .github()
                .graphql::<Data>(token, "IssueEdges", QUERY, vars)
                .await
            {
                Ok(d) => Ok(d),
                Err(e) => {
                    if matches!(e, crate::github::Error::Unauthorized) {
                        inner
                            .installations
                            .drop_token(s.installation, Scope::ReadBack, token);
                    }
                    Err(failure(e.into()))
                }
            }
        }
    })
    .await
}

/// Reads `s`'s edges of `kind` through `query`, which runs `IssueEdges` with the variables given.
/// `None` when GitHub shows no such issue to the token.
async fn read_edges<F, Fut>(s: &Subject, kind: Kind, query: F) -> Result<Option<Fetched>, Failure>
where
    F: Fn(serde_json::Value) -> Fut,
    Fut: Future<Output = Result<Data, Failure>>,
{
    let vars = |after: Option<&str>| {
        json!({
            "id": s.node_id,
            "sub": kind == Kind::Sub,
            "blocks": kind == Kind::Blocks,
            "relates": kind == Kind::Relates,
            "relatesAfter": after,
        })
    };
    // Deleted, transferred, or out of the token's sight: nothing to read.
    let Some(mut node) = query(vars(None)).await?.node else {
        return Ok(None);
    };
    // The rest of the relates-to pages, each appended to the first.
    if let Some(rel) = node.relates_to.as_mut() {
        for _ in 1..MAX_PAGES {
            let Some(PageInfo {
                has_next_page: true,
                end_cursor: Some(after),
            }) = rel.page_info.take()
            else {
                break;
            };
            let Some(next) = query(vars(Some(&after)))
                .await?
                .node
                .and_then(|n| n.relates_to)
            else {
                // Gone between pages: the next read-back will see it.
                return Err(Failure::Retry(format!(
                    "issue {} went away while its relates-to was paged",
                    s.id
                )));
            };
            rel.nodes.extend(next.nodes);
            rel.page_info = next.page_info;
        }
        // As many next time: no try will do better.
        if rel.page_info.as_ref().is_some_and(|p| p.has_next_page) {
            return Err(Failure::GiveUp(format!(
                "issue {} has over {MAX_PAGES} pages of relates-to",
                s.id
            )));
        }
    }
    Ok(Some(fetched(s.id, kind, node)))
}

/// Issue `me`'s edges of `kind` in `node` as GitHub answered them: `(src, dst, end)`, with
/// sub-issues in GitHub's order.
pub(crate) fn fetched(me: i64, kind: Kind, node: Node) -> Fetched {
    let mut edges = Vec::new();
    match kind {
        Kind::Sub => {
            if let Some(p) = node.parent {
                edges.push((p.database_id, me, p));
            }
            for c in node.sub_issues.unwrap_or_default().ends() {
                edges.push((me, c.database_id, c));
            }
        }
        Kind::Blocks => {
            for b in node.blocked_by.unwrap_or_default().ends() {
                edges.push((b.database_id, me, b));
            }
            for b in node.blocking.unwrap_or_default().ends() {
                edges.push((me, b.database_id, b));
            }
        }
        Kind::Relates => {
            for o in node.relates_to.unwrap_or_default().ends() {
                let other = o.database_id;
                edges.push((me.min(other), me.max(other), o));
            }
        }
        // Read with the PR, never by `IssueEdges`.
        Kind::Closes => {}
    }
    Fetched { edges }
}

/// Reads the edges back and writes them to every account syncing the issue's repo.
async fn refetch(inner: &Inner, s: &Subject, kind: Kind) -> Result<(), Failure> {
    let fetched = fetch(inner, s, kind).await?;
    let targets = targets(inner, s.repo).await?;
    let Some(fetched) = fetched else {
        // GraphQL says only "not found". Transferred since (its old number a 301), its transfer's
        // deliveries move it, and the read-back has nothing to miss.
        if transferred(inner, s, &targets).await {
            eprintln!(
                "edges: issue {} was transferred; its transfer's deliveries move it",
                s.id
            );
            return Ok(());
        }
        unseen_subject(inner, s, &targets).await;
        return Ok(());
    };
    let fetched = Arc::new(fetched);
    for account in targets {
        let synced: HashSet<i64> = match inner
            .control
            .read(move |c| control_db::q::synced_repo_ids(c, account))
            .await
        {
            Ok(ids) => ids.into_iter().collect(),
            Err(e) => {
                eprintln!("edges: reading account {account}'s repos failed: {e}");
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
                continue;
            }
        };
        let (id, installation, read) = (s.id, s.installation, fetched.clone());
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                let r = replace(tx, seq, kind, installation, id, &read, &synced)?;
                // Newer than what a sweep under way read of it, and of every item whose edges
                // this changed.
                q::touch_edges(tx, id, seq)?;
                for &end in &r.touched {
                    q::touch_edges(tx, end, seq)?;
                }
                Ok(r.ids)
            })
            .await;
        match written {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) if ids.len() > MAX_IDS => inner.hub.publish(account, Push::Reset),
            Ok(ids) => inner.hub.publish(account, Push::Ids(ids.into())),
            // The account lost access and its mirror is deleted: nothing to repair.
            Err(mirror_db::Error::Deleted) => {}
            Err(e) => {
                eprintln!(
                    "edges: writing issue {id}'s {} edges failed for account {account}: {e}",
                    kind.name()
                );
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
            }
        }
    }
    Ok(())
}

/// Whether GitHub answers `s`'s number with a 301: transferred since. Asked of REST (one `GET`),
/// since GraphQL answers a transferred issue's node as it does a deleted one's. False when it
/// can't tell.
async fn transferred(inner: &Inner, s: &Subject, targets: &[i64]) -> bool {
    let repo = s.repo;
    let mut place = None;
    for &account in targets {
        if let Ok(Some(r)) = inner
            .mirrors
            .read(account, Caller::Webhook, move |c| q::repo_state(c, repo))
            .await
        {
            place = Some((r.owner, r.name));
            break;
        }
    }
    let Some((owner, name)) = place else {
        return false;
    };
    let _turn = inner.installations.read_turn(s.installation).await;
    let Ok(token) = token(inner, s).await else {
        return false;
    };
    let gh = inner.installations.github();
    matches!(
        gh.issue(&token, &owner, &name, s.number).await,
        Ok(Shown::Moved)
    )
}

/// GitHub has no issue `s` for the installation. Deleted or transferred since the delivery, it
/// has nothing left to read: done, for an account whose mirror no longer holds it either. An
/// account that still holds it is missing something only a sweep can tell, and is marked for
/// resync.
async fn unseen_subject(inner: &Inner, s: &Subject, targets: &[i64]) {
    let id = s.id;
    for &account in targets {
        let held = inner
            .mirrors
            .read(account, Caller::Webhook, move |c| {
                Ok(!q::item_repos(c, &[id])?.is_empty())
            })
            .await;
        // Held, or unknown; not a mirror deleted since (the account lost access).
        if !matches!(held, Ok(false) | Err(mirror_db::Error::Deleted)) {
            eprintln!(
                "edges: installation {} can't see issue {id}, which account {account} holds; marking it for resync",
                s.installation
            );
            webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
        }
    }
}

/// What [`replace`] changed.
#[derive(Default)]
pub(crate) struct Replaced {
    /// The items whose rows or detail changed; none when nothing did.
    pub ids: Vec<i64>,
    /// The items whose edges it changed (added, removed, moved to another parent, or reordered),
    /// `id` among them when any did: a read-back stamps them.
    pub touched: Vec<i64>,
    /// The ends of the edges it added or removed: empty when it only reordered sub-issues or
    /// refreshed a stub's title, which GitHub sends no webhook for.
    pub moved: Vec<i64>,
}

/// Every item whose edges of `kind` replacing `id`'s with `f` may change: `id`, the ends `f`
/// reads, and the ends the mirror holds. A write since a sweep read `f` to any of them makes
/// what it read stale.
pub(crate) fn ends(
    tx: &Transaction,
    kind: Kind,
    id: i64,
    f: &Fetched,
) -> rusqlite::Result<BTreeSet<i64>> {
    let mut out = BTreeSet::from([id]);
    for (src, dst, _) in &f.edges {
        out.extend([*src, *dst]);
    }
    for e in q::edges_of(tx, kind.name(), id)? {
        out.extend([e.src_id, e.dst_id]);
    }
    Ok(out)
}

/// Replaces `id`'s edges of `kind` with the fetched ones this account may hold. Read with
/// `installation`'s token; `synced` is the account's synced repos.
pub(crate) fn replace(
    tx: &Transaction,
    seq: i64,
    kind: Kind,
    installation: i64,
    id: i64,
    f: &Fetched,
    synced: &HashSet<i64>,
) -> rusqlite::Result<Replaced> {
    let name = kind.name();
    let old: HashSet<(i64, i64)> = q::edges_of(tx, name, id)?
        .into_iter()
        .map(|e| (e.src_id, e.dst_id))
        .collect();
    // Only what this account may see: its synced repos, the repos it can see but didn't pick
    // (its visible repos: an installation reaches them and so does the account), and public
    // ones. An end outside the synced repos is kept as a stub.
    let mut visible = HashMap::new();
    let mut may_see = |repo: i64| -> rusqlite::Result<bool> {
        if let Some(v) = visible.get(&repo) {
            return Ok(*v);
        }
        let v = q::repo_state(tx, repo)?.is_some_and(|r| r.installation_id.is_some());
        visible.insert(repo, v);
        Ok(v)
    };
    let mut new: Vec<&(i64, i64, End)> = Vec::new();
    for e in &f.edges {
        let r = &e.2.repository;
        if synced.contains(&r.database_id) || !r.is_private || may_see(r.database_id)? {
            new.push(e);
        }
    }
    let keep: HashSet<(i64, i64)> = new.iter().map(|(s, d, _)| (*s, *d)).collect();
    // Read with `installation`'s token, which sees only its own installation's repos and public
    // ones: an end in a private repo this account syncs through another installation (another
    // owner) is missing from the read-back, not gone, and such an edge stays.
    let others: Vec<i64> = old
        .iter()
        .map(|&(src, dst)| if src == id { dst } else { src })
        .collect();
    let unseen: HashSet<i64> = q::item_repos(tx, &others)?
        .into_iter()
        .filter(|r| {
            synced.contains(&r.repo_id)
                && r.private
                && r.installation_id.is_some_and(|i| i != installation)
        })
        .map(|r| r.id)
        .collect();
    let mut changed = false;
    // The ends of the edges added or removed, and of those reordered.
    let (mut moved, mut reordered): (BTreeSet<i64>, BTreeSet<i64>) = Default::default();
    let mut ends: BTreeSet<i64> = BTreeSet::new();
    for &(src, dst) in old.difference(&keep) {
        if unseen.contains(&src) || unseen.contains(&dst) {
            continue;
        }
        if q::remove_edge(tx, name, src, dst)? > 0 {
            changed = true;
            moved.extend([src, dst]);
        }
        ends.extend([src, dst]);
    }
    let mut position = 0.0;
    for (src, dst, end) in new {
        // An end outside the synced repos is a stub, its title and state as just read.
        if !synced.contains(&end.repository.database_id) {
            let r = &end.repository;
            q::upsert_stub_repo(
                tx,
                r.database_id,
                &r.id,
                &r.owner.login,
                &r.name,
                r.is_private,
            )?;
            let state = if end.state.eq_ignore_ascii_case("open") {
                "open"
            } else {
                "closed"
            };
            changed |= q::upsert_stub(
                tx,
                end.database_id,
                &end.id,
                r.database_id,
                end.number,
                "issue",
                &end.title,
                state,
                seq,
            )? > 0;
            changed |= q::set_stub_place(tx, end.database_id, r.database_id, end.number, seq)? > 0;
        }
        // A child has one parent: GitHub's wins.
        if kind == Kind::Sub
            && let Some(other) = q::detach_child(tx, *dst, *src)?
        {
            changed = true;
            moved.extend([other, *dst]);
            ends.insert(other);
        }
        if !old.contains(&(*src, *dst)) && q::add_edge(tx, name, *src, *dst, seq)? > 0 {
            changed = true;
            moved.extend([*src, *dst]);
        }
        // Sub-issues take GitHub's order, 1..n, under this issue.
        if kind == Kind::Sub && *src == id {
            position += 1.0;
            if q::set_position(tx, id, *dst, position, seq)? > 0 {
                changed = true;
                reordered.extend([*src, *dst]);
            }
        }
        ends.extend([*src, *dst]);
    }
    let stale: Vec<i64> = ends.iter().copied().collect();
    q::prune_stubs(tx, &stale)?;
    if !changed {
        return Ok(Replaced::default());
    }
    let mut touched: BTreeSet<i64> = moved.union(&reordered).copied().collect();
    touched.insert(id);
    ends.insert(id);
    Ok(Replaced {
        ids: with_neighbours(tx, ends)?,
        touched: touched.into_iter().collect(),
        moved: moved.into_iter().collect(),
    })
}
