//! Relationship writes: from webhooks, and from the read-backs that follow them.
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
//! A read-back GitHub fails is tried again on [`Config::read_back_retries`](crate::Config);
//! past the last of them, or when no try can do better (the installation is gone, or the issue
//! has more relates-to than a read-back follows), every account syncing the repo is marked
//! `needs_resync`, for a sweep to read what was missed. An issue GitHub can't show the
//! installation (deleted or transferred since) marks only the accounts whose mirror still holds
//! it.
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

use crate::installations::Installations;
use crate::live::{Hub, Push};
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

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    /// Parent → child.
    Sub,
    /// Blocker → blocked.
    Blocks,
    /// Smaller id → larger id.
    Relates,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Sub => "sub",
            Kind::Blocks => "blocks",
            Kind::Relates => "relates",
        }
    }
}

/// The issue whose edges a read-back reads.
#[derive(Clone, Debug)]
pub struct Subject {
    pub id: i64,
    pub node_id: String,
    pub repo: i64,
    pub installation: i64,
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
    let mut touched: BTreeSet<i64> = ends.into_iter().collect();
    let changed = if e.add {
        if e.kind == Kind::Sub
            && let Some(old) = q::detach_child(tx, e.dst, e.src)?
        {
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

struct Inner {
    control: Arc<Control>,
    mirrors: Mirrors,
    hub: Arc<Hub>,
    installations: Arc<Installations>,
    /// The waits between tries of a read-back GitHub fails; past the last, it gives up.
    retries: Vec<Duration>,
    /// The read-backs waiting or running, by issue and kind.
    pending: Mutex<HashMap<(i64, Kind), Pending>>,
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
    /// The issue as the latest delivery named it.
    subject: Subject,
    /// How many tries in a row GitHub has failed. A delivery may bring the next try forward but
    /// doesn't start the count again: only a read-back that lands does.
    failures: usize,
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
        retries: Vec<Duration>,
    ) -> Refetcher {
        Refetcher(Arc::new(Inner {
            control,
            mirrors,
            hub,
            installations,
            retries,
            pending: Mutex::default(),
        }))
    }

    /// Reads `subject`'s edges of `kind` back from GitHub: at once, or after
    /// [`REFETCH_AFTER`] (each new call within it starts the delay again, up to
    /// [`MAX_DEBOUNCE`] from the first). One read-back per issue and kind runs at a time; a call
    /// while one runs queues one more after it. The receiver hears once a read-back that started
    /// after this call has landed or been given up; it errs if the refetcher stops first.
    pub fn schedule(&self, subject: Subject, kind: Kind, at_once: bool) -> oneshot::Receiver<()> {
        let (done, heard) = oneshot::channel();
        let now = Instant::now();
        let key = (subject.id, kind);
        let mut all = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
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
        let worker = tokio::spawn(worker(self.0.clone(), key)).abort_handle();
        all.insert(
            key,
            Pending {
                due: Some(due),
                debounced: !at_once,
                first: now,
                subject,
                failures: 0,
                wake: Arc::default(),
                waiting: vec![done],
                worker: Some(worker),
            },
        );
        heard
    }
}

/// Runs the read-backs for one issue and kind until none is due.
async fn worker(inner: Arc<Inner>, key: (i64, Kind)) {
    loop {
        let (due, subject, wake, answers) = {
            let mut all = inner.pending.lock().unwrap_or_else(|e| e.into_inner());
            let Some(p) = all.get_mut(&key) else { return };
            let Some(due) = p.due else {
                all.remove(&key);
                return;
            };
            if due > Instant::now() {
                (Some(due), p.subject.clone(), p.wake.clone(), Vec::new())
            } else {
                p.due = None;
                let answers = std::mem::take(&mut p.waiting);
                (None, p.subject.clone(), p.wake.clone(), answers)
            }
        };
        let Some(due) = due else {
            let tried = refetch(&inner, &subject, key.1).await;
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
enum Failure {
    /// GitHub failed, or the control DB did: worth trying again.
    Retry(String),
    /// Nothing to try again: the installation is gone, say.
    GiveUp(String),
}

/// After one try at a read-back: schedules the next try of a failed one (unless a delivery
/// since already asked for one), with the deliveries it answers for still waiting on it. Past
/// the last of the retries, or when there's nothing to try again, gives up and marks every
/// account syncing the repo for resync: a sweep will read what it missed. A read-back that
/// landed or was given up tells the deliveries it answers for.
async fn conclude(
    inner: &Inner,
    key: (i64, Kind),
    s: &Subject,
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
                    eprintln!(
                        "edges: reading issue {}'s {} edges failed, trying again in {wait:?}: {why}",
                        s.id,
                        key.1.name()
                    );
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
        }
    };
    if let Some(why) = why {
        eprintln!(
            "edges: giving up reading issue {}'s {} edges ({why}); marking the accounts syncing repo {} for resync",
            s.id,
            key.1.name(),
            s.repo
        );
        let repo = s.repo;
        let what = format!("reading who syncs repo {repo}");
        for account in webhook::syncing(&inner.control, repo, &what).await {
            webhook::mark_for_resync(&inner.control, account).await;
        }
    }
    for a in answers {
        // A delivery that stopped listening has nothing left to settle.
        let _ = a.send(());
    }
}

/// `IssueEdges`: an issue's relationships of the kinds asked for, each end with its repository.
/// GitHub caps sub-issues at 100 and dependencies at 50 of each kind, so one page holds them;
/// relates-to has no documented cap and is paged, `$relatesAfter` naming the page before.
const QUERY: &str = "query IssueEdges($id: ID!, $sub: Boolean!, $blocks: Boolean!, $relates: Boolean!, $relatesAfter: String) {
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
}
fragment End on Issue {
  id databaseId number title state
  repository { databaseId id name owner { login } isPrivate }
}";

#[derive(Deserialize)]
struct Data {
    node: Option<Node>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Node {
    parent: Option<End>,
    sub_issues: Option<Nodes>,
    blocked_by: Option<Nodes>,
    blocking: Option<Nodes>,
    relates_to: Option<Nodes>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Nodes {
    #[serde(default)]
    nodes: Vec<Option<End>>,
    page_info: Option<PageInfo>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
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
struct End {
    id: String,
    database_id: i64,
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
struct Owner {
    login: String,
}

/// An issue's edges of one kind as GitHub has them: `(src, dst, end)`, the end being the other
/// issue, with sub-issues in GitHub's order.
struct Fetched {
    edges: Vec<(i64, i64, End)>,
}

/// Reads `s`'s edges of `kind` with the App's installation token: what the installation sees.
async fn fetch(inner: &Inner, s: &Subject, kind: Kind) -> Result<Option<Fetched>, Failure> {
    let _turn = inner.installations.read_turn(s.installation).await;
    let token = match inner.installations.token(s.installation).await {
        Ok(t) => t,
        // The installation is gone (GitHub answers 404 for its token): no try will do better.
        Err(crate::github::Error::Status(404)) => {
            return Err(Failure::GiveUp(format!(
                "installation {} is gone",
                s.installation
            )));
        }
        Err(e) => return Err(Failure::Retry(e.to_string())),
    };
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
                        inner.installations.forget(s.installation);
                    }
                    Err(Failure::Retry(e.to_string()))
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
    let me = s.id;
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
    }
    Ok(Some(Fetched { edges }))
}

/// Reads the edges back and writes them to every account syncing the issue's repo.
async fn refetch(inner: &Inner, s: &Subject, kind: Kind) -> Result<(), Failure> {
    let fetched = fetch(inner, s, kind).await?;
    let repo = s.repo;
    let targets = match inner
        .control
        .read(move |c| control_db::q::fan_out_targets(c, repo))
        .await
    {
        Ok(t) => t,
        Err(e) => {
            return Err(Failure::Retry(format!(
                "reading who syncs repo {repo} failed: {e}"
            )));
        }
    };
    let Some(fetched) = fetched else {
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
                webhook::mark_for_resync(&inner.control, account).await;
                continue;
            }
        };
        let (id, installation, read) = (s.id, s.installation, fetched.clone());
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                replace(tx, seq, kind, installation, id, &read, &synced)
            })
            .await;
        match written {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) if ids.len() > MAX_IDS => inner.hub.publish(account, Push::Reset),
            Ok(ids) => inner.hub.publish(account, Push::Ids(ids.into())),
            Err(e) => {
                eprintln!(
                    "edges: writing issue {id}'s {} edges failed for account {account}: {e}",
                    kind.name()
                );
                webhook::mark_for_resync(&inner.control, account).await;
            }
        }
    }
    Ok(())
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
        if !matches!(held, Ok(false)) {
            eprintln!(
                "edges: installation {} can't see issue {id}, which account {account} holds; marking it for resync",
                s.installation
            );
            webhook::mark_for_resync(&inner.control, account).await;
        }
    }
}

/// Replaces `id`'s edges of `kind` with the fetched ones this account may hold. The items whose
/// rows or detail changed; none when nothing did.
fn replace(
    tx: &Transaction,
    seq: i64,
    kind: Kind,
    installation: i64,
    id: i64,
    f: &Fetched,
    synced: &HashSet<i64>,
) -> rusqlite::Result<Vec<i64>> {
    let name = kind.name();
    let old: HashSet<(i64, i64)> = q::edges_of(tx, name, id)?
        .into_iter()
        .map(|e| (e.src_id, e.dst_id))
        .collect();
    // Only what this account may see: its synced repos, and public ones.
    // TODO(#91): #86 keeps an end "visible to that account or public", and visible is wider
    // than synced: a repo the account can see but didn't pick. The mirror has no record of that
    // set yet (its `repos` rows with `synced = 0` are stubs' repos too, so they can't tell).
    // Once repo picking records it, keep an end whose repo is in it (as a stub, like a public
    // one) here, and add a test: an account that sees a private repo it doesn't sync keeps a
    // relationship into it as a stub, while an account that can't see that repo doesn't.
    let new: Vec<&(i64, i64, End)> = f
        .edges
        .iter()
        .filter(|(_, _, e)| synced.contains(&e.repository.database_id) || !e.repository.is_private)
        .collect();
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
    let mut ends: BTreeSet<i64> = BTreeSet::new();
    for &(src, dst) in old.difference(&keep) {
        if unseen.contains(&src) || unseen.contains(&dst) {
            continue;
        }
        changed |= q::remove_edge(tx, name, src, dst)? > 0;
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
            ends.insert(other);
        }
        if !old.contains(&(*src, *dst)) {
            changed |= q::add_edge(tx, name, *src, *dst, seq)? > 0;
        }
        // Sub-issues take GitHub's order, 1..n, under this issue.
        if kind == Kind::Sub && *src == id {
            position += 1.0;
            changed |= q::set_position(tx, id, *dst, position, seq)? > 0;
        }
        ends.extend([*src, *dst]);
    }
    let stale: Vec<i64> = ends.iter().copied().collect();
    q::prune_stubs(tx, &stale)?;
    if !changed {
        return Ok(Vec::new());
    }
    ends.insert(id);
    with_neighbours(tx, ends)
}
