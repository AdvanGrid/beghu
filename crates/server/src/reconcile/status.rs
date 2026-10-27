//! The account's sync as the status slot shows it: healthy (`null`), "sync degraded · Resync"
//! or "resyncing…".

use super::Reconcile;
use crate::App;
use serde::Serialize;
use ts_rs::TS;

/// What the status slot shows of sync: `null` on the wire while it's healthy.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct SyncStatus {
    /// Changes are known to have been missed: "sync degraded · Resync".
    pub degraded: bool,
    /// A Resync (or a repair) is running: "resyncing…".
    pub resyncing: bool,
    /// When Resync can next be asked for (Unix seconds); `null` when it can now.
    #[ts(type = "number | null")]
    pub resync_at: Option<i64>,
}

impl Reconcile {
    /// The account's sync as the status slot shows it; `marked`: it's `needs_resync`, and
    /// `asked_at`: when the connected account last asked for a Resync.
    fn status_of(&self, account: i64, marked: bool, asked_at: Option<i64>) -> Option<SyncStatus> {
        let now = crate::now();
        let every = self.cfg.resync_every.as_secs() as i64;
        let resync_at = asked_at.map(|t| t + every).filter(|t| *t > now);
        self.with(|s| {
            let a = s.accounts.get(&account);
            let degraded = marked || a.is_some_and(|a| !a.dirty.is_empty());
            let resyncing = a.is_some_and(|a| !a.waiting.is_empty());
            (degraded || resyncing).then_some(SyncStatus {
                degraded,
                resyncing,
                resync_at,
            })
        })
    }
}

/// The account's sync state: `None` while sync is healthy.
pub async fn status(app: &App, account: i64) -> Option<SyncStatus> {
    let row = app
        .control()
        .read(move |c| control_db::q::account(c, account))
        .await
        .ok()
        .flatten();
    let marked = row.as_ref().is_some_and(|a| a.needs_resync);
    app.reconcile()
        .status_of(account, marked, row.and_then(|a| a.resync_asked_at))
}
