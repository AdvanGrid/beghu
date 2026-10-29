//! Images, attachments and video in posts (spec, "Markdown and media"; #100). Nothing a post
//! shows loads from anywhere but beghu, and beghu stores no bytes of it.
//!
//! - `GET /api/attachments/:uuid` (`routes.rs`): a GitHub attachment, minted for the viewer
//!   (`mint.rs`) and streamed through with `Range` support.
//! - `GET /api/img?u=&sig=` (`routes.rs`): any other image, through a signed, session-only proxy
//!   with an address guard on every hop (`guard.rs`).
//! - Both stream through the same limits (`fetch.rs`), and share [`MediaConfig::per_session`]
//!   upstream fetches per browser session: more wait their turn ([`Limiter`]). An image holds its
//!   turn until its bytes are through (it has a total time); an attachment only until GitHub's
//!   headers are in, since a paused video holds its stream open indefinitely.
//! - The probes measure images before the browser loads them (`probe.rs`), so the thread keeps
//!   still.

mod fetch;
mod guard;
mod mint;

/// `MintAttachments`, the document the attachment mint sends (`crate::GRAPHQL_DOCUMENTS`).
pub(crate) const MINT_ATTACHMENTS: &str = mint::MINT_ATTACHMENTS;
pub mod probe;
mod routes;
mod video;

pub use probe::Media;
pub use routes::{attachment, image};

use crate::config::MediaConfig;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The media routes' and probes' shared state.
pub struct State {
    pub(crate) fetch: fetch::Fetcher,
    pub(crate) probes: probe::Probes,
    limiter: Limiter,
    held: mint::Held,
}

impl State {
    pub fn new(cfg: MediaConfig) -> State {
        State {
            limiter: Limiter::new(cfg.per_session),
            fetch: fetch::Fetcher::new(cfg),
            probes: probe::Probes::default(),
            held: mint::Held::default(),
        }
    }

    /// A minted URL held for `account`'s view of `uuid`.
    fn held(&self, account: i64, uuid: &str) -> Option<mint::Minted> {
        self.held.get(account, uuid)
    }

    fn hold(&self, account: i64, uuid: &str, m: &mint::Minted) {
        self.held.put(account, uuid, m);
    }
}

/// Each browser session's upstream fetches: at most `per` at once, across both routes; the rest
/// wait in turn. A session's semaphore lives while anything holds or waits on it.
struct Limiter {
    per: usize,
    sessions: Mutex<HashMap<Vec<u8>, Weak<Semaphore>>>,
}

impl Limiter {
    fn new(per: usize) -> Limiter {
        Limiter {
            per: per.max(1),
            sessions: Mutex::default(),
        }
    }

    /// A turn for the session `id_hash` names, once one is free.
    async fn turn(&self, id_hash: &[u8]) -> OwnedSemaphorePermit {
        let sem = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            match sessions.get(id_hash).and_then(Weak::upgrade) {
                Some(sem) => sem,
                None => {
                    sessions.retain(|_, s| s.strong_count() > 0);
                    let sem = Arc::new(Semaphore::new(self.per));
                    sessions.insert(id_hash.to_vec(), Arc::downgrade(&sem));
                    sem
                }
            }
        };
        sem.acquire_owned()
            .await
            .expect("the semaphore is never closed")
    }
}
