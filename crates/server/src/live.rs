//! Live push: `GET /api/stream`, one server-sent event stream per tab.
//!
//! - `ids` (`{"ids":[…]}`): one per mirror transaction that changed what the account sees.
//! - `defs` (`{}`): a repo's labels or milestones changed while no item carrying them did: what
//!   offers them (the filter bar, the detail's pickers) reads again; rows needn't.
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
//! - `switched` (`{"account":…,"sign_in_again":…}`): the tab's account is no longer the one it
//!   can use, and the stream ends. Pushed to every stream of a browser session when its active
//!   account changes (a switch, a sign-in, a sign-out or Disconnect in another tab), with the
//!   account now active (`null` once none is signed in); and to an account's streams when it
//!   lost access (`sign_in_again`). A stream opened for another account than the active one
//!   (`?account=`, the stream's `X-Beghu-Account`: an `EventSource` can't send headers), for an
//!   account that must sign in again, or once the session ended gets one at once, never a 401
//!   or 409 the tab couldn't read.
//! - A heartbeat comment every 15 s keeps the connection alive through the edge.
//!
//! Each account has one broadcast channel, created with its first stream and dropped with its
//! last, so a mirror write fans out to that account's streams and no one else's. Each browser
//! session has one too, for `switched`; a sign-in, which gives the session a new id, moves the
//! channel to it ([`Hub::rekey_session`]).

use crate::App;
use crate::auth::Refusal;
use crate::error::ApiError;
use crate::import::ImportStatus;
use crate::reconcile::SyncStatus;
use axum::extract::{Query, State};
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
    /// A label or milestone itself changed, and no item carrying it: what offers them reads
    /// again.
    Defs,
    /// The import's status changed: this is it now.
    Status(Option<ImportStatus>),
    /// The tab's account is no longer the one it can use.
    Switched(StreamSwitched),
    /// The sync state changed: the stream reads it as the event goes out.
    Sync,
}

impl Push {
    /// `switched`: the browser session's active account is now `account` (`None`: none is
    /// signed in), or, with `sign_in_again`, the tab's account `account` lost access.
    pub fn switched(account: Option<i64>, sign_in_again: bool) -> Push {
        Push::Switched(StreamSwitched {
            account,
            sign_in_again,
        })
    }
}

/// The `switched` event's data.
#[derive(Serialize, TS, Debug, Clone, PartialEq)]
#[ts(export)]
pub struct StreamSwitched {
    /// The browser session's active account now; `null` once none is signed in.
    pub account: Option<i64>,
    /// The tab's account lost access to GitHub (a revoke, a refused refresh): it must sign in
    /// again.
    pub sign_in_again: bool,
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

/// A browser session's channel. Shared, so a sign-in can move it to the session's new id while
/// its streams keep it.
type SessionChannel = Arc<broadcast::Sender<Push>>;

/// Every account's broadcast channel, and every browser session's, while it has streams.
#[derive(Default)]
pub struct Hub {
    accounts: Mutex<HashMap<i64, broadcast::Sender<Push>>>,
    /// By the session id's hash.
    sessions: Mutex<HashMap<Vec<u8>, SessionChannel>>,
}

impl Hub {
    /// A new stream for `account`'s tab in browser session `session`, creating their channels
    /// if this is the first.
    pub fn subscribe(self: &Arc<Self>, account: i64, session: &[u8]) -> Subscription {
        let rx = {
            let mut all = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
            all.entry(account)
                .or_insert_with(|| broadcast::channel(BUFFER).0)
                .subscribe()
        };
        let (session_rx, channel) = {
            let mut all = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let channel = all
                .entry(session.to_vec())
                .or_insert_with(|| Arc::new(broadcast::channel(BUFFER).0))
                .clone();
            (channel.subscribe(), channel)
        };
        Subscription {
            rx: Some(rx),
            session_rx: Some(session_rx),
            session: channel,
            hub: self.clone(),
            account,
        }
    }

    /// Whether `account` has a stream open.
    pub fn has_streams(&self, account: i64) -> bool {
        self.accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&account)
    }

    /// Sends `push` to `account`'s streams; with none open, it goes nowhere.
    pub fn publish(&self, account: i64, push: Push) {
        let all = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = all.get(&account) {
            let _ = tx.send(push);
        }
    }

    /// Sends `push` to the streams of the browser session `session` (its id's hash).
    pub fn publish_session(&self, session: &[u8], push: Push) {
        let all = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = all.get(session) {
            let _ = tx.send(push);
        }
    }

    /// The browser session `old` has a new id, `new` (a sign-in): its streams hear what's sent
    /// to `new` from now on.
    pub fn rekey_session(&self, old: &[u8], new: &[u8]) {
        let mut all = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(channel) = all.remove(old) {
            all.insert(new.to_vec(), channel);
        }
    }
}

/// One stream's place in its account's channel and its browser session's. Dropping the last
/// one of either drops that channel.
pub struct Subscription {
    /// Always `Some` until the drop takes it.
    rx: Option<broadcast::Receiver<Push>>,
    /// Always `Some` until the drop takes it.
    session_rx: Option<broadcast::Receiver<Push>>,
    session: SessionChannel,
    hub: Arc<Hub>,
    account: i64,
}

impl Subscription {
    /// The next push, from the account's channel or the session's; `Reset` in place of
    /// anything missed by falling behind.
    pub async fn next(&mut self) -> Push {
        let (Some(rx), Some(session)) = (&mut self.rx, &mut self.session_rx) else {
            return std::future::pending().await;
        };
        let got = tokio::select! {
            r = rx.recv() => r,
            r = session.recv() => r,
        };
        match got {
            Ok(p) => p,
            Err(broadcast::error::RecvError::Lagged(_)) => Push::Reset,
            // The senders live in the hub (or, moved out of it, here) for as long as this
            // subscription does.
            Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        {
            let mut all = self.hub.accounts.lock().unwrap_or_else(|e| e.into_inner());
            // Dropped under the lock, so two streams closing at once can't each count the other.
            drop(self.rx.take());
            if all
                .get(&self.account)
                .is_some_and(|tx| tx.receiver_count() == 0)
            {
                all.remove(&self.account);
            }
        }
        let mut all = self.hub.sessions.lock().unwrap_or_else(|e| e.into_inner());
        drop(self.session_rx.take());
        if self.session.receiver_count() == 0 {
            all.retain(|_, c| !Arc::ptr_eq(c, &self.session));
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
        Push::Defs => Event::default().event("defs").data("{}"),
        // Sent through `status_event`, which reads the sync state.
        Push::Status(_) | Push::Sync => Event::default().event("status").data("{}"),
        Push::Switched(sw) => Event::default()
            .event("switched")
            .data(serde_json::to_string(sw).expect("plain struct")),
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

#[derive(serde::Deserialize)]
pub struct StreamQuery {
    /// The tab's account (`X-Beghu-Account`, which an `EventSource` can't send as a header).
    account: Option<i64>,
}

/// A stream that says only `push` (a `switched`), then ends.
fn once(push: Push) -> Response {
    let once = futures_util::stream::once(async move { Ok::<_, Infallible>(event(&push)) });
    Sse::new(once).into_response()
}

/// `GET /api/stream`. It lets itself in ([`auth::admit`](crate::auth::admit)), so a tab whose
/// stream (re)opens once its account can't be used hears why as an event, as a live one would,
/// rather than an error an `EventSource` can't read: a `switched` to the session's active
/// account (the tab is on another), asking the tab's account to sign in again (it lost access),
/// or with no account (the session ended). Then the stream ends.
pub async fn stream(
    State(app): State<App>,
    Query(sq): Query<StreamQuery>,
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
    let claimed = sq.account.map(|a| a.to_string());
    let admitted = match crate::auth::admit(&app, &headers, claimed.as_deref(), false).await {
        Ok(a) => a,
        Err(r) => {
            let hint = r.hint(&headers);
            let mut res = match r {
                Refusal::SignedOut => once(Push::switched(None, false)),
                Refusal::SignInAgain(account) => once(Push::switched(Some(account), true)),
                Refusal::Switched(active) => once(Push::switched(Some(active), false)),
                r => ApiError::from(r).into_response(),
            };
            // The browser's next load is on the session's active account.
            res.headers_mut()
                .extend(hint.map(|c| (axum::http::header::SET_COOKIE, c)));
            return res;
        }
    };
    let s = admitted.session;
    // Subscribed before the first event, so nothing published after the `reset` is missed. Every
    // `reset` (the first, and one in place of pushes missed by falling behind) is followed by the
    // status slot's state, read after it, so a change is either in it or pushed after; `null`
    // too, so a tab that reconnects after an import ended stops showing it.
    let sub = app.hub().subscribe(s.account, &s.id_hash);
    let health = app.github().health();
    let draining = app.drain_watch();
    let (imports, account) = (app.clone(), s.account);
    /// Where a stream is: its opening `reset`, the status slot's state, GitHub's state, then
    /// whatever comes; every later `reset` is followed by the status slot's state too.
    enum Step {
        Reset,
        Status {
            opening: bool,
        },
        GitHub,
        Live,
        /// After a `switched`: the stream ends.
        End,
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
                    Step::End => return None,
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
                            // The tab's own account signed in again, or became active again:
                            // nothing changed for it.
                            Some(Push::Switched(sw))
                                if sw.account == Some(account) && !sw.sign_in_again =>
                            {
                                (Event::default().comment("still yours"), Step::Live)
                            }
                            Some(p @ Push::Switched(_)) => (event(&p), Step::End),
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
    for c in admitted.cookies {
        res.headers_mut().append(axum::http::header::SET_COOKIE, c);
    }
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
        let mut slow = hub.subscribe(1, b"session");
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
            let (a, b) = (hub.subscribe(1, b"one"), hub.subscribe(1, b"two"));
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
            let all = hub.accounts.lock().unwrap();
            assert!(
                all.get(&1).is_none(),
                "a channel with {} receivers outlived its streams",
                all[&1].receiver_count()
            );
            assert!(hub.sessions.lock().unwrap().is_empty());
        }
    }
}
