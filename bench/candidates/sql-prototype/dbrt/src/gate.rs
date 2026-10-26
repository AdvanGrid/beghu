//! The per-account gate in front of each mirror. Pure: events in, effects out, no I/O. The
//! server would hold one `Account` per connected account behind a mutex; the shell (the TUI, or
//! the real server) runs the effects and feeds the results back as events.
//!
//! Policy, as prototyped:
//! - A mirror migrates on its first use after a (re)start. Whoever arrives first triggers it,
//!   and everyone after waits on the same job.
//! - While an in-place migration runs: requests and webhook applies wait. After 200 ms the
//!   account's SSE streams get an "Updating mirror…" status (the bottom-bar slot). A request
//!   waiting 10 s gets a 503 with `retry-after`, so the client retries quietly.
//! - A rebuild (needed by a `.rebuild.sql` migration, a deterministic in-place failure, a missing
//!   file or a file newer than the build) creates an empty mirror and starts the import.
//!   Requests are served from it straight away, with the "Importing" status, as on first sign-in;
//!   webhooks apply to it; sweeps skip it.
//! - A transient failure (disk full, I/O) keeps the old file and backs off 30 s, doubling.
//!   Requests get 503, webhooks stay queued in the control DB, sweeps skip.
//! - Dormant accounts (no session for 30 days): the nightly sweep deletes the mirror rather
//!   than migrating it, but only while nothing is running or waiting on it, and a request
//!   clears dormant. Webhooks for an account without a mirror are skipped; its next sign-in
//!   imports fresh.

use crate::migrations::{Kind, MigError, Plan, plan};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Caller { Request, Webhook, Sweep }

#[derive(Debug, Clone, PartialEq)]
pub enum State {
    /// Not opened since this process started.
    Closed,
    Opening,
    Ready { version: u32 },
    Migrating { from: u32, to: u32, since: u64 },
    Recreating { why: String },
    Importing { since: u64 },
    Backoff { version: u32, until: u64, error: String },
    NoMirror,
    /// Creating an empty mirror failed: a bug in this build. The build-time check runs every
    /// migration on an empty database, so this shouldn't ship.
    Broken { error: String },
}

#[derive(Debug, Clone)]
pub struct Waiter { pub id: u64, pub caller: Caller, pub since: u64 }

#[derive(Debug, Clone)]
pub struct Account {
    pub state: State,
    pub waiting: Vec<Waiter>,
    pub dormant: bool,
    pub status: Option<String>,
    pub attempts: u32,
}

#[derive(Debug, Clone)]
pub struct Config { pub status_after: u64, pub request_timeout: u64, pub backoff: u64 }

impl Default for Config {
    fn default() -> Self { Config { status_after: 200, request_timeout: 10_000, backoff: 30_000 } }
}

#[derive(Debug, Clone)]
pub enum Event {
    Use(String, Caller),
    Opened(String, Option<u32>),
    InPlaceDone(String, Result<(), MigError>),
    Recreated(String, Result<(), String>),
    ImportDone(String),
    Tick(u64),
    /// A deploy: the process restarts as a build that knows `kinds[..binary]`.
    Restart(u32),
    NightlySweep,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open(String),
    RunInPlace { acct: String, from: u32, to: u32 },
    Recreate { acct: String, why: String },
    StartImport(String),
    Delete(String),
    Serve { acct: String, id: u64, caller: Caller, waited: u64, note: String },
    Reject { acct: String, id: u64, caller: Caller, why: String },
    Skip { acct: String, caller: Caller, why: String },
    Status(String, Option<String>),
}

pub struct Gate {
    pub now: u64,
    pub binary: u32,
    pub kinds: Vec<Kind>,
    pub accounts: BTreeMap<String, Account>,
    pub cfg: Config,
    next: u64,
}

impl Gate {
    pub fn new(kinds: Vec<Kind>, binary: u32, accounts: &[(&str, bool)]) -> Gate {
        let accounts = accounts.iter().map(|(a, dormant)| (a.to_string(), Account { state: State::Closed, waiting: vec![], dormant: *dormant, status: None, attempts: 0 })).collect();
        Gate { now: 0, binary, kinds, accounts, cfg: Config::default(), next: 1 }
    }

    pub fn handle(&mut self, ev: Event) -> Vec<Effect> {
        let mut fx = Vec::new();
        match ev {
            Event::Use(a, caller) => self.on_use(&a, caller, &mut fx),
            Event::Opened(a, v) => {
                let kinds = &self.kinds[..self.binary as usize];
                match plan(v, kinds, self.binary) {
                    Plan::Current => {
                        self.acct(&a).state = State::Ready { version: self.binary };
                        self.release(&a, &mut fx, "");
                    }
                    Plan::InPlace { from, to } => {
                        self.acct(&a).state = State::Migrating { from, to, since: self.now };
                        fx.push(Effect::RunInPlace { acct: a, from, to });
                    }
                    Plan::Rebuild { why } => self.recreate(&a, why, &mut fx),
                }
            }
            Event::InPlaceDone(a, Ok(())) => {
                let to = match self.acct(&a).state { State::Migrating { to, .. } => to, _ => self.binary };
                let ac = self.acct(&a);
                ac.state = State::Ready { version: to };
                ac.attempts = 0;
                self.status(&a, None, &mut fx);
                self.release(&a, &mut fx, "after migrating");
            }
            Event::InPlaceDone(a, Err(MigError::Deterministic(e))) => self.recreate(&a, format!("in-place failed: {e}"), &mut fx),
            Event::InPlaceDone(a, Err(MigError::Transient(e))) => {
                let (now, backoff) = (self.now, self.cfg.backoff);
                let version = match self.acct(&a).state { State::Migrating { from, .. } => from, _ => 0 };
                let ac = self.acct(&a);
                ac.attempts += 1;
                let until = now + backoff * 2u64.pow(ac.attempts - 1);
                ac.state = State::Backoff { version, until, error: e };
                self.status(&a, Some(format!("Mirror update failed; retrying in {} s", (until - now) / 1000)), &mut fx);
                self.reject_all(&a, "transient migration failure", &mut fx);
            }
            Event::Recreated(a, Ok(())) => {
                self.acct(&a).state = State::Importing { since: self.now };
                fx.push(Effect::StartImport(a.clone()));
                self.status(&a, Some("Importing".into()), &mut fx);
                let waiting = std::mem::take(&mut self.acct(&a).waiting);
                for w in waiting {
                    self.importing_use(&a, w, &mut fx);
                }
            }
            Event::Recreated(a, Err(error)) => {
                self.acct(&a).state = State::Broken { error: error.clone() };
                self.status(&a, Some(format!("Mirror can't be created: {error}")), &mut fx);
                self.reject_all(&a, "broken build", &mut fx);
            }
            Event::ImportDone(a) => {
                self.acct(&a).state = State::Ready { version: self.binary };
                self.status(&a, None, &mut fx);
            }
            Event::Tick(ms) => {
                self.now += ms;
                let names: Vec<String> = self.accounts.keys().cloned().collect();
                for a in names {
                    let (now, cfg) = (self.now, self.cfg.clone());
                    let ac = self.acct(&a);
                    if let State::Migrating { since, .. } = ac.state
                        && now - since >= cfg.status_after
                        && ac.status.is_none()
                    {
                        self.status(&a, Some("Updating mirror…".into()), &mut fx);
                    }
                    let ac = self.acct(&a);
                    let (late, keep): (Vec<Waiter>, Vec<Waiter>) = ac.waiting.drain(..).partition(|w| w.caller == Caller::Request && now - w.since >= cfg.request_timeout);
                    ac.waiting = keep;
                    for w in late {
                        fx.push(Effect::Reject { acct: a.clone(), id: w.id, caller: w.caller, why: "503 mirror_updating, retry-after: 2".into() });
                    }
                }
            }
            Event::Restart(binary) => {
                self.binary = binary;
                for ac in self.accounts.values_mut() {
                    ac.state = State::Closed;
                    ac.waiting.clear();
                    ac.status = None;
                    ac.attempts = 0;
                }
            }
            Event::NightlySweep => {
                let names: Vec<String> = self.accounts.keys().cloned().collect();
                for a in names {
                    self.on_use(&a, Caller::Sweep, &mut fx);
                }
            }
        }
        fx
    }

    fn acct(&mut self, a: &str) -> &mut Account {
        self.accounts.get_mut(a).unwrap()
    }

    fn status(&mut self, a: &str, s: Option<String>, fx: &mut Vec<Effect>) {
        let ac = self.acct(a);
        if ac.status != s {
            ac.status = s.clone();
            fx.push(Effect::Status(a.into(), s));
        }
    }

    fn wait(&mut self, a: &str, caller: Caller) {
        let w = Waiter { id: self.next, caller, since: self.now };
        self.next += 1;
        self.acct(a).waiting.push(w);
    }

    fn release(&mut self, a: &str, fx: &mut Vec<Effect>, note: &str) {
        let now = self.now;
        for w in std::mem::take(&mut self.acct(a).waiting) {
            fx.push(Effect::Serve { acct: a.into(), id: w.id, caller: w.caller, waited: now - w.since, note: note.into() });
        }
    }

    fn reject_all(&mut self, a: &str, why: &str, fx: &mut Vec<Effect>) {
        for w in std::mem::take(&mut self.acct(a).waiting) {
            fx.push(reject(a, w.id, w.caller, why));
        }
    }

    fn recreate(&mut self, a: &str, why: String, fx: &mut Vec<Effect>) {
        self.acct(a).state = State::Recreating { why: why.clone() };
        fx.push(Effect::Recreate { acct: a.into(), why });
    }

    fn importing_use(&mut self, a: &str, w: Waiter, fx: &mut Vec<Effect>) {
        let waited = self.now - w.since;
        fx.push(match w.caller {
            Caller::Sweep => Effect::Skip { acct: a.into(), caller: w.caller, why: "import running".into() },
            Caller::Request => Effect::Serve { acct: a.into(), id: w.id, caller: w.caller, waited, note: "partial rows, status Importing".into() },
            Caller::Webhook => Effect::Serve { acct: a.into(), id: w.id, caller: w.caller, waited, note: "applied to the new mirror".into() },
        });
    }

    fn on_use(&mut self, a: &str, caller: Caller, fx: &mut Vec<Effect>) {
        let (now, binary) = (self.now, self.binary);
        let ac = self.acct(a);
        if caller == Caller::Request {
            ac.dormant = false; // a request means a live session: the account is back
        }
        let idle = ac.waiting.is_empty() && matches!(ac.state, State::Closed | State::Ready { .. } | State::NoMirror | State::Backoff { .. } | State::Broken { .. });
        if ac.dormant && caller == Caller::Sweep && idle {
            if ac.state != State::NoMirror {
                ac.state = State::NoMirror;
                fx.push(Effect::Delete(a.into()));
            }
            fx.push(Effect::Skip { acct: a.into(), caller, why: "dormant: mirror deleted, not migrated".into() });
            return;
        }
        match ac.state.clone() {
            State::Closed => {
                ac.state = State::Opening;
                self.wait(a, caller);
                fx.push(Effect::Open(a.into()));
            }
            State::Opening | State::Migrating { .. } | State::Recreating { .. } => self.wait(a, caller),
            State::Ready { .. } => {
                let id = self.next;
                self.next += 1;
                fx.push(Effect::Serve { acct: a.into(), id, caller, waited: 0, note: String::new() });
            }
            State::Importing { .. } => {
                let w = Waiter { id: self.next, caller, since: now };
                self.next += 1;
                self.importing_use(a, w, fx);
            }
            State::Backoff { version, until, .. } if now >= until => {
                ac.state = State::Migrating { from: version, to: binary, since: now };
                self.wait(a, caller);
                fx.push(Effect::RunInPlace { acct: a.into(), from: version, to: binary });
            }
            State::Backoff { .. } | State::Broken { .. } => {
                let id = self.next;
                self.next += 1;
                fx.push(reject(a, id, caller, "mirror unavailable"));
            }
            State::NoMirror => match caller {
                Caller::Request => {
                    self.wait(a, caller);
                    self.recreate(a, "signed in again after the mirror was deleted".into(), fx);
                }
                _ => fx.push(Effect::Skip { acct: a.into(), caller, why: "no mirror".into() }),
            },
        }
    }
}

fn reject(a: &str, id: u64, caller: Caller, why: &str) -> Effect {
    let why = match caller {
        Caller::Request => format!("503 retry-after ({why})"),
        Caller::Webhook => format!("deferred: delivery stays queued in the control DB ({why})"),
        Caller::Sweep => format!("skipped ({why})"),
    };
    Effect::Reject { acct: a.into(), id, caller, why }
}
