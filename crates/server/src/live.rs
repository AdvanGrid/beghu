//! Live push: `GET /api/stream`, one server-sent event stream per tab.
//!
//! - `ids` (`{"ids":[…]}`): one per mirror transaction that changed what the account sees.
//! - `reset`: refetch everything shown. Every stream opens with one, so a change that landed
//!   between the tab's data response and the stream opening is never missed; a stream that falls
//!   more than [`BUFFER`] events behind gets one in place of what it missed.
//! - `status` (`{"import":…,"sync":…}`): what the status slot shows, whenever it changes: the
//!   import's phase and progress, `null` once it's done; and the sync state ("sync degraded ·
//!   Resync", "resyncing…"), `null` while sync is healthy. Every `reset` is followed by the
//!   current one, `null`s included, so a tab that missed the change (it was reconnecting) catches
//!   up.
//! - `github` (`{"state":"up"|"down"}`): whether GitHub is answering, process-wide. Sent right
//!   after the opening `reset` and its `status`, then on every change; while it's down the tab
//!   pauses writes.
//! - A heartbeat comment every 15 s keeps the connection alive through the edge.
//!
//! Each account has one broadcast channel, created with its first stream and dropped with its
//! last, so a mirror write fans out to that account's streams and no one else's.

use crate::App;
use crate::auth::Session;
use crate::error::ApiError;
use crate::import::ImportStatus;
use crate::reconcile::SyncStatus;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use ts_rs::TS;

/// How many events a stream may fall behind before it gets a `reset` instead.
pub const BUFFER: usize = 256;

/// What a mirror write tells the account's tabs.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    /// These items changed: a comment change names its issue.
    Ids(Arc<[i64]>),
    /// Refetch everything shown.
    Reset,
    /// The import's status changed: this is it now.
    Status(Option<ImportStatus>),
    /// The sync state changed: the stream reads it as the event goes out.
    Sync,
}

/// The `status` event's data.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct StreamStatus {
    /// The import running, if any.
    pub import: Option<ImportStatus>,
    /// Sync degraded, or resyncing; `null` while sync is healthy.
    pub sync: Option<SyncStatus>,
}

/// The `ids` event's data.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct StreamIds {
    pub ids: Vec<i64>,
}

/// The `github` event's data.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct StreamGitHub {
    pub state: GitHubState,
}

#[derive(Serialize, TS, Clone, Copy)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GitHubState {
    Up,
    Down,
}

fn github_event(down: bool) -> Event {
    let state = if down {
        GitHubState::Down
    } else {
        GitHubState::Up
    };
    Event::default()
        .event("github")
        .data(serde_json::to_string(&StreamGitHub { state }).expect("plain struct"))
}

/// Every account's broadcast channel, while it has streams.
#[derive(Default)]
pub struct Hub(Mutex<HashMap<i64, broadcast::Sender<Push>>>);

impl Hub {
    /// A new stream for `account`, creating its channel if this is the first.
    pub fn subscribe(self: &Arc<Self>, account: i64) -> Subscription {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let rx = all
            .entry(account)
            .or_insert_with(|| broadcast::channel(BUFFER).0)
            .subscribe();
        Subscription {
            rx: Some(rx),
            hub: self.clone(),
            account,
        }
    }

    /// Sends `push` to `account`'s streams; with none open, it goes nowhere.
    pub fn publish(&self, account: i64, push: Push) {
        let all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = all.get(&account) {
            let _ = tx.send(push);
        }
    }
}

/// One stream's place in its account's channel. Dropping the last one drops the channel.
pub struct Subscription {
    /// Always `Some` until the drop takes it.
    rx: Option<broadcast::Receiver<Push>>,
    hub: Arc<Hub>,
    account: i64,
}

impl Subscription {
    /// The next push; `Reset` in place of anything missed by falling behind.
    pub async fn next(&mut self) -> Push {
        let Some(rx) = &mut self.rx else {
            return std::future::pending().await;
        };
        match rx.recv().await {
            Ok(p) => p,
            Err(broadcast::error::RecvError::Lagged(_)) => Push::Reset,
            // The sender lives in the hub for as long as this subscription does.
            Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut all = self.hub.0.lock().unwrap_or_else(|e| e.into_inner());
        // Dropped under the lock, so two streams closing at once can't each count the other.
        drop(self.rx.take());
        if all
            .get(&self.account)
            .is_some_and(|tx| tx.receiver_count() == 0)
        {
            all.remove(&self.account);
        }
    }
}

fn event(push: &Push) -> Event {
    match push {
        Push::Ids(ids) => Event::default()
            .event("ids")
            .data(serde_json::to_string(&StreamIds { ids: ids.to_vec() }).expect("plain struct")),
        // An event with no data is never dispatched by EventSource.
        Push::Reset => Event::default().event("reset").data("{}"),
        // Sent through `status_event`, which reads the sync state.
        Push::Status(_) | Push::Sync => Event::default().event("status").data("{}"),
    }
}

/// The status slot's state for `account`: the `status` event, with `import` as pushed (each of
/// the import's steps is told, in order), or as it is now.
async fn status_event(app: &App, account: i64, import: Option<Option<ImportStatus>>) -> Event {
    let status = StreamStatus {
        import: import.unwrap_or_else(|| app.imports().status(account)),
        sync: crate::reconcile::status(app, account).await,
    };
    Event::default()
        .event("status")
        .data(serde_json::to_string(&status).expect("plain struct"))
}

pub async fn stream(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    headers: HeaderMap,
) -> Response {
    // From beghu's own pages: no `Origin` (a same-origin `EventSource` sends none) or beghu's.
    if !crate::auth::from_beghu(&app, &headers, true) {
        return ApiError::Forbidden("This stream is only for beghu's own pages".into())
            .into_response();
    }
    if app.draining() {
        return ApiError::Unavailable {
            retry_after: std::time::Duration::from_secs(1),
            why: "beghu is restarting".into(),
        }
        .into_response();
    }
    // Subscribed before the first event, so nothing published after the `reset` is missed. Every
    // `reset` (the first, and one in place of pushes missed by falling behind) is followed by the
    // status slot's state, read after it, so a change is either in it or pushed after; `null`
    // too, so a tab that reconnects after an import ended stops showing it.
    let sub = app.hub().subscribe(s.account);
    let health = app.github().health();
    let draining = app.drain_watch();
    let (imports, account) = (app.clone(), s.account);
    /// Where a stream is: its opening `reset`, the status slot's state, GitHub's state, then
    /// whatever comes; every later `reset` is followed by the status slot's state too.
    enum Step {
        Reset,
        Status { opening: bool },
        GitHub,
        Live,
    }
    // The stream ends when the drain starts: the tab reconnects to the next server.
    let events = futures_util::stream::unfold(
        (sub, health, draining, Step::Reset),
        move |(mut sub, mut health, mut draining, step)| {
            let imports = imports.clone();
            async move {
                let (ev, next) = match step {
                    Step::Reset => (event(&Push::Reset), Step::Status { opening: true }),
                    Step::Status { opening } => (
                        status_event(&imports, account, None).await,
                        if opening { Step::GitHub } else { Step::Live },
                    ),
                    Step::GitHub => (github_event(*health.borrow_and_update()), Step::Live),
                    Step::Live => {
                        let push = tokio::select! {
                            push = sub.next() => Some(push),
                            // A closed channel (never, while the app lives) leaves only the pushes.
                            Ok(()) = health.changed() => None,
                            _ = draining.wait_for(|d| *d) => return None,
                        };
                        match push {
                            Some(Push::Status(import)) => (
                                status_event(&imports, account, Some(import)).await,
                                Step::Live,
                            ),
                            Some(Push::Sync) => {
                                (status_event(&imports, account, None).await, Step::Live)
                            }
                            Some(Push::Reset) => {
                                (event(&Push::Reset), Step::Status { opening: false })
                            }
                            Some(p) => (event(&p), Step::Live),
                            None => {
                                let down = *health.borrow_and_update();
                                (github_event(down), Step::Live)
                            }
                        }
                    }
                };
                Some((Ok::<_, Infallible>(ev), (sub, health, draining, next)))
            }
        },
    );
    let mut res = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(app.cfg().stream_heartbeat)
                .text("heartbeat"),
        )
        .into_response();
    // The edge must not buffer the stream.
    res.headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}

// Through `/api/stream` (tests/live.rs) a stream can't be made to fall behind: the socket's
// buffers drain the channel faster than any test can fill it. So the one path only a lagging
// stream takes is tested here, at the hub.
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_stream_that_falls_more_than_the_buffer_behind_gets_a_reset() {
        let hub = Arc::new(Hub::default());
        let mut slow = hub.subscribe(1);
        for id in 0..=BUFFER as i64 {
            hub.publish(1, Push::Ids(Arc::from([id])));
        }
        assert_eq!(slow.next().await, Push::Reset);
        // Then it carries on from the oldest push still buffered.
        assert_eq!(slow.next().await, Push::Ids(Arc::from([1])));
    }

    // Reads the hub's map: through `/api/stream` two streams can't be made to close at the same
    // instant, and a leaked channel has no effect a client could see.
    #[test]
    fn the_channel_goes_with_the_last_stream_even_when_streams_close_at_once() {
        for _ in 0..5_000 {
            let hub = Arc::new(Hub::default());
            let (a, b) = (hub.subscribe(1), hub.subscribe(1));
            let together = Arc::new(std::sync::Barrier::new(2));
            let other = {
                let together = together.clone();
                std::thread::spawn(move || {
                    together.wait();
                    drop(a);
                })
            };
            together.wait();
            drop(b);
            other.join().unwrap();
            let all = hub.0.lock().unwrap();
            assert!(
                all.get(&1).is_none(),
                "a channel with {} receivers outlived its streams",
                all[&1].receiver_count()
            );
        }
    }
}
