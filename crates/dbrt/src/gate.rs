//! The per-account gate in front of each mirror. Pure: events in, effects out, no I/O and no
//! clock of its own. `Mirrors` holds one per account, runs the effects and feeds the results back.
//!
//! - A mirror is checked on its first use after the process starts. Whoever arrives first
//!   triggers the job, and everyone after waits on the same one.
//! - An in-place migration runs all pending steps in one transaction. Requests, webhook applies
//!   and sweeps wait. After `status_after` the status slot says "Updating mirror…".
//! - A request still waiting at `request_timeout`, on the first open, a migration or a new empty
//!   mirror, is refused (503 with `retry-after`). Webhooks and sweeps keep waiting.
//! - A failed in-place migration is an error, not a rebuild: the file is unchanged and the mirror
//!   refuses every caller. A transient failure (disk full, I/O, busy), opening, migrating or
//!   creating, retries on the next use after a backoff that starts at `backoff` and doubles; any
//!   other failure stays until a new build. There's deliberately no retry timer: an account
//!   nobody uses stays in backoff until the migration walker (#114) exists to retry it.
//! - A missing file or a pending `.rebuild.sql` migration builds an empty mirror (then the
//!   import runs). A file newer than the build is refused.
//! - A delete (the account lost access) waits for the open, migration or creation under way,
//!   then deletes the file; until the account is revived every caller is refused, so nothing
//!   brings the mirror back meanwhile. A revived account's first use creates an empty mirror and
//!   asks for its import.

use crate::migrations::{MigError, Migration, Plan, plan};
use std::time::Duration;

/// Who is asking. Only requests give up after `request_timeout`; the others are queued work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Request,
    Webhook,
    Sweep,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub status_after: Duration,
    pub request_timeout: Duration,
    pub backoff: Duration,
    /// `retry-after` for a request that timed out waiting on a migration.
    pub retry_after: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            status_after: Duration::from_millis(200),
            request_timeout: Duration::from_secs(10),
            backoff: Duration::from_secs(30),
            retry_after: Duration::from_secs(2),
        }
    }
}

/// What the account's status slot shows; `None` when nothing is going on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// "Updating mirror…"
    Updating,
    /// The migration failed. `retry_in` is set for transient failures.
    Failed {
        error: String,
        retry_in: Option<Duration>,
    },
}

/// Why a caller was turned away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Waited `request_timeout` for the mirror to open, migrate or be created.
    StillUpdating { retry_after: Duration },
    /// A transient failure; the next try is after `retry_after`.
    Retrying {
        error: String,
        retry_after: Duration,
    },
    /// The migration failed and won't be retried by this build.
    Failed { error: String },
    /// The file is newer than this build.
    TooNew { db: u32, build: u32 },
    /// The mirror was deleted (or is being deleted) and the account not revived since.
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Closed,
    Opening,
    Migrating {
        from: u32,
        since: Duration,
    },
    Creating,
    Ready,
    /// A transient failure. `from` is the file's version, `None` if reading it failed.
    Backoff {
        from: Option<u32>,
        until: Duration,
        error: String,
    },
    Failed {
        error: String,
    },
    TooNew {
        db: u32,
        build: u32,
    },
    /// Deleting the file.
    Deleting,
    /// The file is gone (or its delete failed): every caller is refused until a revive.
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Someone wants the mirror. `id` names the waiter in `Serve`/`Refuse`.
    Use {
        id: u64,
        caller: Caller,
    },
    /// The result of `Effect::Open`: the file's `user_version`, `None` without a file.
    Opened(Result<Option<u32>, MigError>),
    Migrated(Result<(), MigError>),
    Created(Result<(), MigError>),
    /// Time passed; see `Gate::next_deadline`.
    Tick,
    /// Delete the mirror. `id` names who asked, in the `Serve` (deleted) or `Refuse` (the delete
    /// failed) that answers once it's done.
    Delete {
        id: u64,
    },
    /// The result of `Effect::Delete`.
    Deleted(Result<(), String>),
    /// The account may use its mirror again (it signed in again): the next use opens afresh.
    Revive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Read the file's version and answer with `Event::Opened`.
    Open,
    /// Run the in-place migrations and answer with `Event::Migrated`.
    Migrate {
        from: u32,
        to: u32,
    },
    /// Build an empty mirror over the file and answer with `Event::Created`.
    Create {
        why: String,
    },
    /// An empty mirror replaced the file: the import should run.
    NeedsImport {
        why: String,
    },
    Serve {
        id: u64,
    },
    Refuse {
        id: u64,
        why: Refusal,
    },
    Status(Option<Status>),
    /// Close every connection to the file, delete it, and answer with `Event::Deleted`.
    Delete,
}

#[derive(Debug, Clone)]
struct Waiter {
    id: u64,
    caller: Caller,
    since: Duration,
}

/// One account's gate. `now` is passed in with every call, as time since some fixed start.
#[derive(Debug)]
pub struct Gate {
    migs: &'static [Migration],
    cfg: Config,
    state: State,
    waiting: Vec<Waiter>,
    status: Option<Status>,
    attempts: u32,
    /// Who asked for the delete pending or under way.
    deleters: Vec<u64>,
    /// A revive came while the delete was pending or under way: reopen once it's done.
    revive: bool,
}

impl Gate {
    pub fn new(migs: &'static [Migration], cfg: Config) -> Gate {
        Gate {
            migs,
            cfg,
            state: State::Closed,
            waiting: Vec::new(),
            status: None,
            attempts: 0,
            deleters: Vec::new(),
            revive: false,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.state == State::Ready
    }

    pub fn handle(&mut self, now: Duration, ev: Event) -> Vec<Effect> {
        let mut fx = Vec::new();
        // A job's result while a delete waits for it: the delete goes next, and whoever waited
        // on the job is turned away.
        if !self.deleters.is_empty()
            && matches!(
                ev,
                Event::Opened(_) | Event::Migrated(_) | Event::Created(_)
            )
            && matches!(
                self.state,
                State::Opening | State::Migrating { .. } | State::Creating
            )
        {
            self.start_delete(&mut fx);
            return fx;
        }
        match ev {
            Event::Use { id, caller } => self.on_use(now, id, caller, &mut fx),
            Event::Opened(Err(e)) => self.failed(now, e, &mut fx),
            Event::Opened(Ok(v)) => match plan(v, self.migs) {
                Plan::Current => self.ready(&mut fx),
                Plan::InPlace { from, to } => {
                    self.state = State::Migrating { from, since: now };
                    fx.push(Effect::Migrate { from, to });
                }
                Plan::Create { why } => {
                    self.state = State::Creating;
                    fx.push(Effect::Create { why });
                }
                Plan::TooNew { db, build } => {
                    self.state = State::TooNew { db, build };
                    self.refuse_all(Refusal::TooNew { db, build }, &mut fx);
                }
            },
            Event::Migrated(Ok(())) => {
                self.attempts = 0;
                self.ready(&mut fx);
            }
            Event::Migrated(Err(e)) => self.failed(now, e, &mut fx),
            Event::Created(Ok(())) => {
                fx.push(Effect::NeedsImport {
                    why: "empty mirror created".into(),
                });
                self.ready(&mut fx);
            }
            Event::Created(Err(e)) => self.failed(now, e, &mut fx),
            Event::Tick => self.tick(now, &mut fx),
            Event::Delete { id } => {
                // A delete after a revive wins.
                self.revive = false;
                self.deleters.push(id);
                match self.state {
                    // The job under way ends first (see the top of `handle`).
                    State::Opening
                    | State::Migrating { .. }
                    | State::Creating
                    | State::Deleting => {}
                    _ => self.start_delete(&mut fx),
                }
            }
            Event::Deleted(r) => {
                self.state = if std::mem::take(&mut self.revive) {
                    State::Closed
                } else {
                    State::Deleted
                };
                for id in std::mem::take(&mut self.deleters) {
                    fx.push(match &r {
                        Ok(()) => Effect::Serve { id },
                        Err(error) => Effect::Refuse {
                            id,
                            why: Refusal::Failed {
                                error: error.clone(),
                            },
                        },
                    });
                }
            }
            // A delete pending (behind an open, migration or creation) or under way: reopen once
            // it's done.
            Event::Revive if !self.deleters.is_empty() => self.revive = true,
            Event::Revive => {
                if let State::Deleted = self.state {
                    self.state = State::Closed;
                }
            }
        }
        fx
    }

    /// Deletes the file now: nothing else is under way. Whoever waits is turned away.
    fn start_delete(&mut self, fx: &mut Vec<Effect>) {
        self.state = State::Deleting;
        self.attempts = 0;
        self.refuse_all(Refusal::Deleted, fx);
        self.set_status(None, fx);
        fx.push(Effect::Delete);
    }

    /// When the shell should next send `Event::Tick`.
    pub fn next_deadline(&self) -> Option<Duration> {
        let status = match self.state {
            State::Migrating { since, .. } if self.status.is_none() => {
                Some(since + self.cfg.status_after)
            }
            _ => None,
        };
        // Only the opening, migrating and creating states hold waiters.
        let timeout = self
            .waiting
            .iter()
            .filter(|w| w.caller == Caller::Request)
            .map(|w| w.since + self.cfg.request_timeout)
            .min();
        status.into_iter().chain(timeout).min()
    }

    fn on_use(&mut self, now: Duration, id: u64, caller: Caller, fx: &mut Vec<Effect>) {
        let waiter = Waiter {
            id,
            caller,
            since: now,
        };
        match self.state.clone() {
            State::Ready => fx.push(Effect::Serve { id }),
            State::Closed => {
                self.state = State::Opening;
                self.waiting.push(waiter);
                fx.push(Effect::Open);
            }
            State::Opening | State::Migrating { .. } | State::Creating => self.waiting.push(waiter),
            // A retry: the failure no longer stands, so the status slot clears and a retried
            // migration shows "Updating mirror…" again.
            State::Backoff {
                from: None, until, ..
            } if now >= until => {
                self.set_status(None, fx);
                self.state = State::Opening;
                self.waiting.push(waiter);
                fx.push(Effect::Open);
            }
            State::Backoff {
                from: Some(from),
                until,
                ..
            } if now >= until => {
                self.set_status(None, fx);
                self.state = State::Migrating { from, since: now };
                self.waiting.push(waiter);
                fx.push(Effect::Migrate {
                    from,
                    to: self.migs.len() as u32,
                });
            }
            State::Backoff { until, error, .. } => fx.push(Effect::Refuse {
                id,
                why: Refusal::Retrying {
                    error,
                    retry_after: until - now,
                },
            }),
            State::Failed { error } => fx.push(Effect::Refuse {
                id,
                why: Refusal::Failed { error },
            }),
            State::TooNew { db, build } => fx.push(Effect::Refuse {
                id,
                why: Refusal::TooNew { db, build },
            }),
            State::Deleting | State::Deleted => fx.push(Effect::Refuse {
                id,
                why: Refusal::Deleted,
            }),
        }
    }

    fn tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if let State::Migrating { since, .. } = self.state
            && self.status.is_none()
            && now >= since + self.cfg.status_after
        {
            self.set_status(Some(Status::Updating), fx);
        }
        let (late, keep) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|w| {
                w.caller == Caller::Request && now >= w.since + self.cfg.request_timeout
            });
        self.waiting = keep;
        for w in late {
            fx.push(Effect::Refuse {
                id: w.id,
                why: Refusal::StillUpdating {
                    retry_after: self.cfg.retry_after,
                },
            });
        }
    }

    fn ready(&mut self, fx: &mut Vec<Effect>) {
        self.state = State::Ready;
        self.set_status(None, fx);
        for w in std::mem::take(&mut self.waiting) {
            fx.push(Effect::Serve { id: w.id });
        }
    }

    fn failed(&mut self, now: Duration, e: MigError, fx: &mut Vec<Effect>) {
        let (why, status) = match e {
            MigError::Transient(error) => {
                self.attempts += 1;
                let wait = self.cfg.backoff * 2u32.saturating_pow(self.attempts - 1);
                let from = match self.state {
                    State::Migrating { from, .. } => Some(from),
                    _ => None,
                };
                self.state = State::Backoff {
                    from,
                    until: now + wait,
                    error: error.clone(),
                };
                (
                    Refusal::Retrying {
                        error: error.clone(),
                        retry_after: wait,
                    },
                    Status::Failed {
                        error,
                        retry_in: Some(wait),
                    },
                )
            }
            MigError::Failed(error) => {
                self.state = State::Failed {
                    error: error.clone(),
                };
                (
                    Refusal::Failed {
                        error: error.clone(),
                    },
                    Status::Failed {
                        error,
                        retry_in: None,
                    },
                )
            }
        };
        self.set_status(Some(status), fx);
        self.refuse_all(why, fx);
    }

    fn refuse_all(&mut self, why: Refusal, fx: &mut Vec<Effect>) {
        for w in std::mem::take(&mut self.waiting) {
            fx.push(Effect::Refuse {
                id: w.id,
                why: why.clone(),
            });
        }
    }

    fn set_status(&mut self, s: Option<Status>, fx: &mut Vec<Effect>) {
        if self.status != s {
            self.status = s.clone();
            fx.push(Effect::Status(s));
        }
    }
}
