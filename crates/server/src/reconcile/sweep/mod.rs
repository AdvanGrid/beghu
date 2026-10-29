//! The sweeps of one installation's repos: GitHub read once with the installation's token, and
//! written to every active account syncing the repo, through the import's writers (under the
//! webhooks' guards). Each read first waits while the installation's quota for it is below a
//! fifth; a rate limit is waited out, a 5xx or a dropped call tried a few times, and anything
//! else fails that repo's sweep, which the next round tries again.
//!
//! - `budget.rs`: the wait for the installation's quota;
//! - `probes.rs`: the 5-minute `since` probes;
//! - `ids.rs`: the 15-minute count check and the id sweep;
//! - `relationships.rs`: the sub-issue order sweep, and every relationship read back;
//! - `full.rs`: the full sweep with diff.

mod budget;
mod full;
mod ids;
mod probes;
mod relationships;

/// The sweeps' GraphQL documents, by operation name (`crate::GRAPHQL_DOCUMENTS`).
pub(super) const GRAPHQL: [(&str, &str); 4] = [
    ("SweepEdges", relationships::SWEEP_EDGES),
    ("SweepCounts", ids::SWEEP_COUNTS),
    ("SweepIssueIds", ids::SWEEP_ISSUE_IDS),
    ("SweepPullIds", ids::SWEEP_PULL_IDS),
];

use super::{Budget, Error, Touched};
use crate::App;
use crate::edges::{self, Kind, ReadBack, Subject};
use crate::github::{CallError, Fetched, Quota};
use crate::import::shapes::{
    Conn, GqlIssue, IMPORT_ISSUES, IMPORT_LABELS, IMPORT_PULL_DETAILS, Named, PullDetails,
    RestComment, RestIssue,
};
use crate::import::writes::{
    CommentData, ItemData, PrData, publish, write_comments, write_item, write_synced,
};
use crate::installations::Scope;
use crate::webhook::{parse_time, rfc3339, time};
use mirror_db::{Caller, q};
use rusqlite::Transaction;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// GitHub's page size, and `nodes(ids:)`'s limit.
const PAGE: usize = 100;
/// A probe reads again this far behind the newest change it saw: GitHub's `updated_at` can
/// land a few seconds out of order (docs/research/mirror-import-and-reconciliation.md §4).
const OVERLAP: i64 = 5 * 60;
/// How often `/rate_limit` is asked when the quota's last reading is older.
pub(crate) const BUDGET_FRESH: Duration = Duration::from_secs(60);
/// How long a secondary rate limit that names no wait is waited out: GitHub asks for at least a
/// minute.
pub(crate) const SECONDARY_WAIT: Duration = Duration::from_secs(60);
/// 5xx and dropped calls tried this many times before the sweep of the repo fails.
const TRANSIENT_TRIES: u32 = 5;

/// A repo to sweep: as the mirrors know it, and the active accounts syncing it.
#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub id: i64,
    pub node_id: String,
    pub owner: String,
    pub name: String,
    pub accounts: Vec<i64>,
}

impl Target {
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// A repo's issue and PR counts on GitHub and in a mirror, when they differ.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Counts {
    pub issues: i64,
    pub prs: i64,
    pub held_issues: i64,
    pub held_prs: i64,
}

impl std::fmt::Display for Counts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "GitHub has {} issues and {} PRs, a mirror {} and {}",
            self.issues, self.prs, self.held_issues, self.held_prs
        )
    }
}

/// Why a sweep stopped short. (The drain stops a sweep without either: it's a job, dropped at
/// its next await, see `jobs.rs`.)
pub(crate) enum Stop {
    /// The drain sealed the databases: a sweep a write of which was refused leaves what it
    /// didn't write for the next start, failing nothing.
    Sealed,
    /// GitHub (or the control DB) failed it; the next round tries again.
    Failed(Error),
}

impl From<control_db::Error> for Stop {
    fn from(e: control_db::Error) -> Self {
        match e {
            control_db::Error::Sealed => Stop::Sealed,
            e => Stop::Failed(Error::Db(e)),
        }
    }
}

/// An answer GitHub gave that the sweep can't read.
fn malformed(e: impl std::fmt::Display) -> Stop {
    Stop::Failed(Error::Malformed(e.to_string()))
}

/// What a read spends: REST's quota, or GraphQL's.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Resource {
    Core,
    Graphql,
}

pub(crate) struct Sweeper {
    app: App,
    installation: i64,
}

/// A REST page as the sweeps read it: its items, and the ETag of the first.
struct Listed<T> {
    items: Vec<T>,
    etag: Option<String>,
}

/// The pages of a REST list in `updated` order, ascending, read by `since` rather than by page
/// number. GitHub pages these lists by offset: an item updated while they're read moves to the
/// end, and the item after the page boundary slides onto a page already read, unseen. Each page
/// here asks again from a second before the newest item read (`since` is exclusive), so an item
/// updated meanwhile is read again at the end and nothing unread moves before the reader. Only a
/// full page of one second's items moves on by page number.
struct Updated {
    base: String,
    since: Option<i64>,
    page: u32,
    /// Asked again from a later `since` than the list's own.
    moved: bool,
    done: bool,
}

impl Updated {
    fn new(base: String, since: Option<i64>) -> Updated {
        Updated {
            base,
            since,
            page: 1,
            moved: false,
            done: false,
        }
    }

    /// Whether the next page is the list's first, as first asked.
    fn first(&self) -> bool {
        self.page == 1 && !self.moved
    }

    /// The next page's path; `None` once the list is through.
    fn next_path(&self) -> Option<String> {
        if self.done {
            return None;
        }
        let mut path = self.base.clone();
        if let Some(s) = self.since {
            path.push_str(&format!("&since={}", rfc3339(s)));
        }
        if self.page > 1 {
            path.push_str(&format!("&page={}", self.page));
        }
        Some(path)
    }

    /// A page was read, its items updated at these times.
    fn read(&mut self, updated: &[i64]) {
        if updated.len() < PAGE {
            self.done = true;
            return;
        }
        let last = updated.iter().copied().max().unwrap_or(i64::MIN);
        if self.since.is_none_or(|s| last - 1 > s) {
            self.since = Some(last - 1);
            self.page = 1;
            self.moved = true;
        } else {
            self.page += 1;
        }
    }
}

impl Sweeper {
    pub fn new(app: App, installation: i64) -> Sweeper {
        Sweeper { app, installation }
    }

    fn reconcile(&self) -> &crate::reconcile::Reconcile {
        self.app.reconcile()
    }

    /// Runs `call` with the installation's token, within its budget, until it passes or fails
    /// for good.
    async fn call<T, F, Fut>(&self, resource: Resource, call: F) -> Result<T, Stop>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<(T, Option<Quota>), CallError>>,
    {
        let (mut auth_tries, mut transient) = (0, 0);
        let mut backoff = Duration::from_secs(1);
        loop {
            self.wait_for_budget(resource).await;
            let installations = self.app.installations();
            let out = match installations.token(self.installation, Scope::Import).await {
                Ok(t) => match call(t.clone()).await {
                    Err(CallError::Unauthorized) => {
                        installations.drop_token(self.installation, Scope::Import, &t);
                        Err(CallError::Unauthorized)
                    }
                    other => other,
                },
                Err(e) => Err(e.into()),
            };
            let wait = match out {
                Ok((v, q)) => {
                    self.note(resource, q);
                    return Ok(v);
                }
                Err(CallError::Unauthorized) if auth_tries < 2 => {
                    auth_tries += 1;
                    continue;
                }
                Err(CallError::RateLimited(w)) => {
                    self.reconcile().pause(self.installation, w);
                    w
                }
                Err(CallError::SecondaryLimit) => {
                    self.reconcile().pause(self.installation, SECONDARY_WAIT);
                    SECONDARY_WAIT
                }
                Err(e) if e.is_transient() && transient + 1 < TRANSIENT_TRIES => {
                    transient += 1;
                    let w = backoff;
                    backoff *= 2;
                    w
                }
                Err(e) => return Err(Stop::Failed(Error::Call(e))),
            };
            tokio::time::sleep(wait).await;
        }
    }

    async fn graphql(
        &self,
        op: &'static str,
        query: &'static str,
        vars: Value,
    ) -> Result<Value, Stop> {
        let gh = self.app.github();
        self.call(Resource::Graphql, |token| {
            let vars = vars.clone();
            async move { gh.graphql_quota(&token, op, query, vars).await }
        })
        .await
    }

    /// A REST page (`path` has its query string), conditional on `etag`: `None` when it's
    /// unchanged.
    async fn rest<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        etag: Option<&str>,
    ) -> Result<Option<Listed<T>>, Stop> {
        let gh = self.app.github();
        let fetched = self
            .call(Resource::Core, |token| async move {
                gh.rest_if_changed(&token, path, etag).await
            })
            .await?;
        match fetched {
            Fetched::NotModified => Ok(None),
            Fetched::Fresh { body, etag } => {
                let items: Vec<T> =
                    serde_json::from_value(body).map_err(|e| malformed(format!("{path}: {e}")))?;
                Ok(Some(Listed { items, etag }))
            }
        }
    }

    /// One REST resource; `None` when GitHub answers 404 (or 410) for it.
    async fn one<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<Option<T>, Stop> {
        let gh = self.app.github();
        let fetched = self
            .call(Resource::Core, |token| async move {
                match gh.rest_if_changed(&token, path, None).await {
                    Err(CallError::NotFound) => Ok((None, None)),
                    Ok((f, q)) => Ok((Some(f), q)),
                    Err(e) => Err(e),
                }
            })
            .await?;
        match fetched {
            Some(Fetched::Fresh { body, .. }) => serde_json::from_value(body)
                .map(Some)
                .map_err(|e| malformed(format!("{path}: {e}"))),
            Some(Fetched::NotModified) => Err(malformed(format!("{path}: a 304 nobody asked for"))),
            None => Ok(None),
        }
    }

    /// Every page of a REST list that pages by `page`.
    async fn all_pages<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<Vec<T>, Stop> {
        let mut out = Vec::new();
        for page in 1.. {
            let Some(got) = self.rest::<T>(&format!("{path}&page={page}"), None).await? else {
                break;
            };
            let n = got.items.len();
            out.extend(got.items);
            if n < PAGE {
                break;
            }
        }
        Ok(out)
    }

    /// One transaction per account syncing `t`, each through `f` (given the account), skipped
    /// for an account that no longer syncs it. The ids each changed go to its tabs; when
    /// `missed` says those were changes the webhooks missed, the account's sync is degraded.
    /// The accounts with misses.
    async fn write<F, M>(
        &self,
        t: &Target,
        what: &str,
        f: F,
        missed: M,
    ) -> Result<HashSet<i64>, Stop>
    where
        F: Fn(&Transaction, i64, i64) -> rusqlite::Result<Vec<i64>> + Clone + Send + Sync + 'static,
        M: Fn(&[i64]) -> bool,
    {
        let written = self
            .write_each(t, what, move |tx, seq, account| {
                Ok((f(tx, seq, account)?, ()))
            })
            .await?;
        let mut out = HashSet::new();
        for (account, ids, ()) in written {
            if !ids.is_empty() && missed(&ids) {
                self.reconcile().missed(&self.app, account, t.id);
                out.insert(account);
            }
        }
        Ok(out)
    }

    /// One transaction per account syncing `t`, each through `f` (given the transaction and the
    /// account), skipped for an account that no longer syncs it: the ids each changed go to its
    /// tabs. Each account written, with the ids and what else `f` said. An account whose write
    /// failed is marked for resync; a write the drain's seal refused stops the sweep instead
    /// (`Stop::Sealed`), marking nothing: what the sweep would have written, the next start's
    /// sweeps read again, since a cursor is saved only once its data is written.
    async fn write_each<F, T>(
        &self,
        t: &Target,
        what: &str,
        f: F,
    ) -> Result<Vec<(i64, Vec<i64>, T)>, Stop>
    where
        F: Fn(&Transaction, i64, i64) -> rusqlite::Result<(Vec<i64>, T)>
            + Clone
            + Send
            + Sync
            + 'static,
        T: Default + Send + 'static,
    {
        let mut out = Vec::new();
        for &account in &t.accounts {
            let f = f.clone();
            let written = write_synced(&self.app, account, Caller::Sweep, t.id, move |tx, seq| {
                f(tx, seq, account)
            })
            .await;
            match written {
                Ok((ids, more)) => {
                    publish(&self.app, account, ids.clone());
                    out.push((account, ids, more));
                }
                Err(mirror_db::Error::Sealed) => return Err(Stop::Sealed),
                Err(e) => {
                    eprintln!(
                        "reconcile: {}: writing {what} for account {account}: {e}",
                        t.full_name()
                    );
                    crate::webhook::mark_for_resync(self.app.control(), self.app.hub(), account)
                        .await;
                }
            }
        }
        Ok(out)
    }

    /// Whether a change GitHub made at `updated` (Unix seconds) is old enough that its webhook
    /// should have landed.
    fn overdue(&self, updated: i64) -> bool {
        updated <= crate::now() - self.reconcile().cfg().webhook_grace.as_secs() as i64
    }

    /// Each account's last transaction, before a sweep that deletes what GitHub no longer has.
    async fn seqs(&self, t: &Target) -> HashMap<i64, i64> {
        let mut out = HashMap::new();
        for &a in &t.accounts {
            if let Ok(s) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, |c| q::current_seq(c))
                .await
            {
                out.insert(a, s);
            }
        }
        out
    }
}

/// Whether the mirror holds `repo` as sweeps read it: synced, and not importing (an account that
/// just unsynced it, or is importing it, holds too little to compare with GitHub).
fn swept(c: &rusqlite::Connection, repo: i64) -> rusqlite::Result<bool> {
    Ok(q::repo_state(c, repo)?.is_some_and(|r| r.synced && !r.importing))
}

/// Whether GitHub's item is newer than the mirror's (or the mirror holds a stub of it, or
/// nothing): a sweep writes only those, so what it writes is a change.
fn newer(tx: &Transaction, it: &ItemData) -> rusqlite::Result<bool> {
    Ok(match q::item_updated(tx, it.id)? {
        Some(held) => held.is_stub || held.updated_at.is_none_or(|u| u < it.updated),
        None => true,
    })
}
