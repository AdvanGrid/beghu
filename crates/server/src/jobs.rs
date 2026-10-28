//! Background jobs, and how the drain stops them (its step 4).
//!
//! Every task beghu runs in the background is spawned through [`Jobs`]: the import (its rounds
//! and each round's per-repo tasks), the relationship read-backs, the webhook dispatcher with its
//! lanes, settles, requeue and pruning, the accounts' re-reads of their repos and roles, the
//! unsyncs and reconciles a repo pick starts, writes (ops) and the role re-reads they start,
//! token refreshes, the hourly control-DB backup and asset pruning, the accounts' daily check
//! and the migration walker; and reconciliation's
//! redelivery, the sweeps' scheduler and each installation's sweeps and probes. Once the drain calls [`Jobs::stop`], no job starts, each running one is dropped
//! at its next await, and the drain waits until all of them have ended (or its deadline).
//!
//! Stopping a job doesn't stop a database transaction it has under way: that runs whole on a
//! blocking thread, and ends after the job does. So stopping the jobs is not what keeps the
//! volume still after the drain. The databases do that: the drain's checkpoint seals them first
//! (any later write fails with `Error::Sealed`), lets the write in flight finish, and only then
//! folds the WAL (`serve_until`).
//!
//! # The contract every job keeps (reconciliation's sweeps and probes included)
//!
//! - **A job is cancelled at any await.** Nothing it holds between two awaits may need finishing
//!   that the next start can't pick up.
//! - **A job saves its cursor in the same transaction as its data.** A job that works through
//!   something in steps (pages, repos, deliveries) records how far it got in the transaction
//!   that writes the step, so a stop between two steps resumes at the right place, and a stop
//!   mid-step leaves the step undone, whole. Where the cursor and its data are in different
//!   databases (a sweep's probe keeps its `since` in the control DB, what it read in the
//!   mirrors), the data is written first and the cursor after: a stop between the two only
//!   reads the step again.
//! - **A job's children use the tracked spawn**: [`Jobs::spawn`], or [`Jobs::set`] for a
//!   `JoinSet`. A plain `tokio::spawn` outlives the drain, which then neither stops nor waits for
//!   it. [`Jobs::spawn_whole`] is for the rare child that mustn't be cut at an await (a token
//!   refresh, which spends a single-use token): the drain waits for it instead, to its deadline.
//!   Once the drain has stopped the jobs, `spawn_whole` refuses: its caller answers that beghu is
//!   restarting, having spent nothing.
//!
//! Outside `Jobs`, on purpose: the drain's own signal listener; GitHub's down-probe
//! (`github.rs`), which only calls GitHub and touches no file; and the database runtime's own
//! tasks (opening and migrating mirrors, closing idle connections), which the seal stops from
//! writing.
//!
//! What a stopped job leaves undone is picked up at the next start: an import a restart cut short
//! resumes, and a webhook delivery not yet settled (its read-back included) is replayed.

use std::future::Future;
use std::sync::{Arc, RwLock};
use tokio::task::{AbortHandle, Id, JoinError, JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Clone, Default)]
pub struct Jobs {
    stop: CancellationToken,
    running: TaskTracker,
    /// Held to read while a whole job is checked against the stop and spawned, and to write
    /// while the drain stops the jobs: no whole job slips in after the drain has looked.
    stopping: Arc<RwLock<()>>,
}

impl Jobs {
    /// Runs `job` until it ends or the drain stops it. The handle gives `None` for a job the
    /// drain stopped, or never started because the drain had begun.
    pub fn spawn<F>(&self, job: F) -> JoinHandle<Option<F::Output>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.running.spawn(self.stoppable(job))
    }

    /// Runs `job` to its end: the drain doesn't cut it at an await, but waits for it (up to its
    /// deadline). Only for work that spends something it can't get back if cut short. `None`,
    /// and `job` never starts, once the drain has stopped the jobs: nothing would wait for it,
    /// and the databases it would write to are about to be sealed.
    pub fn spawn_whole<F>(&self, job: F) -> Option<JoinHandle<F::Output>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let _open = self.stopping.read().unwrap_or_else(|e| e.into_inner());
        (!self.stop.is_cancelled()).then(|| self.running.spawn(job))
    }

    /// A `JoinSet` whose tasks are jobs: the drain stops them and waits for them, as for
    /// [`Jobs::spawn`]. Dropping the set aborts its tasks.
    pub fn set<T: Send + 'static>(&self) -> JobSet<T> {
        JobSet {
            jobs: self.clone(),
            set: JoinSet::new(),
        }
    }

    /// `job`, ending early (as `None`) once the drain stops the jobs.
    fn stoppable<F>(&self, job: F) -> impl Future<Output = Option<F::Output>> + use<F>
    where
        F: Future,
    {
        let stop = self.stop.clone();
        async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => None,
                out = job => Some(out),
            }
        }
    }

    /// Stops every job at its next await, and waits until all have ended, or until `until`.
    /// Whether they all ended in time.
    pub async fn stop(&self, until: tokio::time::Instant) -> bool {
        {
            let _stopping = self.stopping.write().unwrap_or_else(|e| e.into_inner());
            self.stop.cancel();
            self.running.close();
        }
        tokio::time::timeout_at(until, self.running.wait())
            .await
            .is_ok()
    }
}

/// A `JoinSet` of jobs (see [`Jobs::set`]). A task the drain stopped gives `None`.
pub struct JobSet<T> {
    jobs: Jobs,
    set: JoinSet<Option<T>>,
}

impl<T: Send + 'static> JobSet<T> {
    pub fn spawn<F>(&mut self, job: F) -> AbortHandle
    where
        F: Future<Output = T> + Send + 'static,
    {
        let job = self.jobs.running.track_future(self.jobs.stoppable(job));
        self.set.spawn(job)
    }

    pub async fn join_next(&mut self) -> Option<Result<Option<T>, JoinError>> {
        self.set.join_next().await
    }

    pub async fn join_next_with_id(&mut self) -> Option<Result<(Id, Option<T>), JoinError>> {
        self.set.join_next_with_id().await
    }
}

#[cfg(test)]
mod tests {
    use super::Jobs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    // An exception to "tests go through public seams" (AGENTS.md): every caller of
    // `spawn_whole` (a token refresh) runs inside a job, which the drain stops at its next await,
    // so it reaches `spawn_whole` after the stop only in a race no request can be timed into.
    #[tokio::test]
    async fn a_whole_job_is_refused_once_the_jobs_have_stopped() {
        let jobs = Jobs::default();
        assert!(jobs.stop(tokio::time::Instant::now()).await);
        let ran = Arc::new(AtomicBool::new(false));
        let r = ran.clone();
        let job = jobs.spawn_whole(async move { r.store(true, Ordering::SeqCst) });
        assert!(job.is_none());
        tokio::task::yield_now().await;
        assert!(!ran.load(Ordering::SeqCst));
    }
}
