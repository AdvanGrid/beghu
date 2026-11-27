//! The device flow's limits, so nobody can flood the control DB with logins or guess codes:
//!
//! - **Live logins.** At most [`CliConfig::logins_at_once`] (10,000) `beghu login`s waiting at
//!   once, and at most [`CliConfig::logins_per_client`] (20) from one client. A login stops
//!   counting once its poll ends it (approved, denied) or it expires. Over either cap, `POST
//!   /api/cli/login` answers `429 too_many_logins` with `Retry-After`: the seconds until the
//!   oldest login holding the cap expires.
//! - **Wrong codes.** A browser session that asks for [`CliConfig::wrong_codes`] (10) codes that
//!   aren't a live login's (`GET /api/cli/codes/{code}`, Approve, Deny) within
//!   [`CliConfig::wrong_codes_for`] (10 minutes) is answered `429 too_many_codes` on all three
//!   until the oldest of them is that old. A code is 20^8 (about 2.6 × 10^10) to guess.
//!
//! **The client** is the TCP peer's address: beghu reads no `X-Forwarded-For` or similar header
//! (nothing else in it does, and a header the edge doesn't overwrite is the caller's to forge).
//! An IPv6 address counts by its /64, which one host or home is usually given whole; an IPv4 one
//! (mapped into IPv6 or not) by itself. Behind a proxy every login comes from the proxy's
//! address, so the per-client cap is one more cap for everyone (docs/deploy.md, "The edge").
//!
//! **In memory**, not in the control DB: beghu is one process, and the counts only need to hold
//! while it runs. A restart forgets them, which lets in at most one more round of either: the
//! logins themselves still expire in 10 minutes, and a code guessed is still one in 2.6 × 10^10.
//!
//! [`CliConfig::logins_at_once`]: crate::config::CliConfig::logins_at_once
//! [`CliConfig::logins_per_client`]: crate::config::CliConfig::logins_per_client
//! [`CliConfig::wrong_codes`]: crate::config::CliConfig::wrong_codes
//! [`CliConfig::wrong_codes_for`]: crate::config::CliConfig::wrong_codes_for

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;

/// Who a request comes from, as the limits count them: see the module's doc.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Client {
    V4(std::net::Ipv4Addr),
    /// An IPv6 address's first 64 bits.
    V6(u64),
    /// No peer address (a server not started by [`crate::serve_until`]): all such count as one.
    Unknown,
}

impl Client {
    fn of(ip: IpAddr) -> Client {
        match ip {
            IpAddr::V4(v4) => Client::V4(v4),
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => Client::V4(v4),
                None => Client::V6((u128::from(v6) >> 64) as u64),
            },
        }
    }
}

impl std::fmt::Display for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Client::V4(a) => write!(f, "{a}"),
            Client::V6(p) => write!(f, "{}/64", Ipv6Addr::from(u128::from(*p) << 64)),
            Client::Unknown => f.write_str("an unknown address"),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Client {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(Client::Unknown, |c| Client::of(c.0.ip())))
    }
}

/// The counts. One lock, held only for a few map operations.
#[derive(Default)]
pub(crate) struct Limits(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// Each live login (by its device hash): its client and when it expires.
    logins: HashMap<Vec<u8>, (Client, i64)>,
    /// The live logins per client.
    per_client: HashMap<Client, usize>,
    /// Every login started, the oldest first (they all live as long, so this is their expiry
    /// order too): pruned from the front. One ended early stays here until then, gone from
    /// `logins`.
    by_expiry: VecDeque<(i64, Vec<u8>)>,
    /// Each browser session's wrong codes (by its id hash): when, the oldest first.
    wrong: HashMap<Vec<u8>, VecDeque<i64>>,
}

/// A login refused: try again after this long.
pub(crate) struct Full {
    pub retry_after: Duration,
}

impl Inner {
    fn prune(&mut self, now: i64) {
        while let Some((at, _)) = self.by_expiry.front()
            && *at <= now
        {
            let (_, device) = self.by_expiry.pop_front().expect("just seen");
            self.forget(&device);
        }
    }

    fn forget(&mut self, device: &[u8]) {
        if let Some((client, _)) = self.logins.remove(device)
            && let Some(n) = self.per_client.get_mut(&client)
        {
            *n -= 1;
            if *n == 0 {
                self.per_client.remove(&client);
            }
        }
    }
}

fn wait(until: i64, now: i64) -> Duration {
    Duration::from_secs((until - now).max(1) as u64)
}

impl Limits {
    /// Counts a new login from `client`, living until `expires_at`, unless a cap is reached.
    pub fn start_login(
        &self,
        client: Client,
        device: &[u8],
        now: i64,
        expires_at: i64,
        at_once: usize,
        per_client: usize,
    ) -> Result<(), Full> {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        g.prune(now);
        let mine = g.per_client.get(&client).copied().unwrap_or(0);
        if mine >= per_client {
            let oldest = g
                .logins
                .values()
                .filter(|(c, _)| *c == client)
                .map(|(_, at)| *at)
                .min()
                .unwrap_or(expires_at);
            return Err(Full {
                retry_after: wait(oldest, now),
            });
        }
        if g.logins.len() >= at_once {
            let oldest = g
                .by_expiry
                .iter()
                .find(|(at, d)| g.logins.get(d).is_some_and(|(_, e)| e == at))
                .map_or(expires_at, |(at, _)| *at);
            return Err(Full {
                retry_after: wait(oldest, now),
            });
        }
        g.logins.insert(device.to_owned(), (client, expires_at));
        *g.per_client.entry(client).or_default() += 1;
        g.by_expiry.push_back((expires_at, device.to_owned()));
        Ok(())
    }

    /// The login was never stored (its insert failed), or its poll ended it.
    pub fn end_login(&self, device: &[u8]) {
        self.0
            .lock()
            .expect("never poisoned: no panics while held")
            .forget(device);
    }

    /// Whether `session` may ask for another code: `Err` with the wait once it has asked for
    /// `most` wrong ones within `window`.
    pub fn may_try_code(
        &self,
        session: &[u8],
        now: i64,
        most: usize,
        window: Duration,
    ) -> Result<(), Full> {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        let since = now - window.as_secs() as i64;
        let Some(times) = g.wrong.get_mut(session) else {
            return Ok(());
        };
        while times.front().is_some_and(|t| *t <= since) {
            times.pop_front();
        }
        if times.is_empty() {
            g.wrong.remove(session);
            return Ok(());
        }
        if times.len() >= most {
            let oldest = *times.front().expect("not empty");
            return Err(Full {
                retry_after: wait(oldest + window.as_secs() as i64, now),
            });
        }
        Ok(())
    }

    /// `session` asked for a code that isn't a live login's.
    pub fn wrong_code(&self, session: &[u8], now: i64, window: Duration) {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        let since = now - window.as_secs() as i64;
        // Sessions that stopped guessing go, so the map holds only those within the window.
        g.wrong.retain(|_, t| t.back().is_some_and(|t| *t > since));
        g.wrong
            .entry(session.to_owned())
            .or_default()
            .push_back(now);
    }
}
