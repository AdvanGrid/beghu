//! The device flow's limits, so nobody can flood the control DB with logins or guess codes:
//!
//! - **Live logins.** At most [`CliConfig::logins_at_once`] (10,000) `beghu login`s waiting at
//!   once, and, when beghu knows who a client is (below), at most
//!   [`CliConfig::logins_per_client`] (20) from one client. A login stops counting once its poll
//!   ends it (approved, denied) or it expires. Over either cap, `POST /api/cli/login` answers `429
//!   too_many_logins` with `Retry-After`: the seconds until the oldest login holding the cap
//!   expires.
//! - **Wrong codes.** A browser session, or an account across all its sessions, that asks for
//!   [`CliConfig::wrong_codes`] (10) codes that aren't a live login's (`GET
//!   /api/cli/codes/{code}`, Approve, Deny) within [`CliConfig::wrong_codes_for`] (10 minutes) is
//!   answered `429 too_many_codes` on all three until the oldest of them is that old. Each ask
//!   holds its place in the count while it's answered, so asks at once can't all slip in under
//!   the limit. A code is 20^8 (about 2.6 × 10^10) to guess.
//!
//! **The client** is the address in the header [`CliConfig::client_ip_header`]
//! (`BEGHU_CLIENT_IP_HEADER`) names: one the edge overwrites with the address it was called from
//! (`CF-Connecting-IP`, `Fly-Client-IP`, or `X-Forwarded-For`, of which the last address counts,
//! the one the edge appended). An IPv6 address counts by its /64, which one host or home is
//! usually given whole; an IPv4 one (mapped into IPv6 or not) by itself. A request without a
//! readable address there counts as one client with every other such. Unset, beghu has no
//! per-client cap and reads no such header: behind the proxy docs/deploy.md asks for, the TCP
//! peer is the proxy, which would make the per-client cap one more cap for everyone, and a
//! header the edge doesn't overwrite is the caller's to forge. The global cap still holds, which
//! keeps the control DB's logins bounded (docs/deploy.md, "The edge").
//!
//! **In memory**, not in the control DB: beghu is one process, and the counts only need to hold
//! while it runs. A restart forgets them, which lets in at most one more round of either: the
//! logins themselves still expire in 10 minutes, and a code guessed is still one in 2.6 × 10^10.
//! Every lookup under the lock is O(log n) in the logins or the guessers, and both are bounded:
//! the logins by the global cap, the guessers by the signed-in sessions that guessed within the
//! window, each holding at most [`CliConfig::wrong_codes`] times.
//!
//! [`CliConfig::logins_at_once`]: crate::config::CliConfig::logins_at_once
//! [`CliConfig::logins_per_client`]: crate::config::CliConfig::logins_per_client
//! [`CliConfig::client_ip_header`]: crate::config::CliConfig::client_ip_header
//! [`CliConfig::wrong_codes`]: crate::config::CliConfig::wrong_codes
//! [`CliConfig::wrong_codes_for`]: crate::config::CliConfig::wrong_codes_for

use crate::App;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::Duration;

/// Who a request comes from, as the limits count them: see the module's doc.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Client {
    V4(std::net::Ipv4Addr),
    /// An IPv6 address's first 64 bits.
    V6(u64),
    /// The header is set but holds no address beghu can read: all such count as one.
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

    /// The client a header's value names: its last comma-separated address (X-Forwarded-For's
    /// last hop is the edge's; the single-address headers have only the one).
    fn from_header(value: Option<&[u8]>) -> Client {
        value
            .and_then(|v| std::str::from_utf8(v).ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|a| a.trim().parse::<IpAddr>().ok())
            .map_or(Client::Unknown, Client::of)
    }
}

impl std::fmt::Display for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Client::V4(a) => write!(f, "{a}"),
            Client::V6(p) => write!(f, "{}/64", Ipv6Addr::from(u128::from(*p) << 64)),
            Client::Unknown => f.write_str("an unreadable client address"),
        }
    }
}

/// The request's client, or `None` when beghu isn't told who clients are
/// ([`CliConfig::client_ip_header`](crate::config::CliConfig::client_ip_header) unset).
pub(crate) struct ClientOf(pub Option<Client>);

impl FromRequestParts<App> for ClientOf {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        Ok(ClientOf(app.cfg().cli.client_ip_header.as_ref().map(|h| {
            // The last of the header's lines, as of its addresses: the edge's own.
            Client::from_header(
                parts
                    .headers
                    .get_all(h)
                    .iter()
                    .next_back()
                    .map(|v| v.as_bytes()),
            )
        })))
    }
}

/// Who is held to the wrong-code limit: each browser session, and each account across all of
/// its sessions.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Guesser {
    /// A session, by its id's hash.
    Session(Vec<u8>),
    /// An account, by its GitHub user id.
    Account(i64),
}

type Device = Vec<u8>;

/// The counts. One lock, held only for a few map and set operations.
#[derive(Default)]
pub(crate) struct Limits(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// Each live login (by its device hash): its client, if counted by one, and when it expires.
    logins: HashMap<Device, (Option<Client>, i64)>,
    /// The live logins, the soonest to expire first.
    by_expiry: BTreeSet<(i64, Device)>,
    /// Each client's live logins, the soonest to expire first.
    per_client: HashMap<Client, BTreeSet<(i64, Device)>>,
    /// Each guesser's wrong codes, and the asks being answered: when, the oldest first.
    wrong: HashMap<Guesser, VecDeque<i64>>,
    /// Each guesser in `wrong` by its latest time there, the stalest first.
    wrong_by_latest: BTreeSet<(i64, Guesser)>,
}

/// A login refused: try again after this long.
pub(crate) struct Full {
    pub retry_after: Duration,
}

impl Inner {
    fn prune_logins(&mut self, now: i64) {
        while let Some((at, _)) = self.by_expiry.first()
            && *at <= now
        {
            let (_, device) = self.by_expiry.pop_first().expect("just seen");
            self.forget(&device);
        }
    }

    fn forget(&mut self, device: &[u8]) {
        let Some((client, at)) = self.logins.remove(device) else {
            return;
        };
        let key = (at, device.to_owned());
        self.by_expiry.remove(&key);
        if let Some(c) = client
            && let Some(set) = self.per_client.get_mut(&c)
        {
            set.remove(&key);
            if set.is_empty() {
                self.per_client.remove(&c);
            }
        }
    }

    /// Drops the wrong codes older than `since`, and the guessers left with none.
    fn prune_wrong(&mut self, since: i64) {
        while let Some((latest, _)) = self.wrong_by_latest.first()
            && *latest <= since
        {
            let (_, g) = self.wrong_by_latest.pop_first().expect("just seen");
            self.wrong.remove(&g);
        }
    }

    /// `g`'s times after a change: `wrong_by_latest` follows its latest, and a guesser with none
    /// goes.
    fn relatest(&mut self, g: &Guesser, before: Option<i64>) {
        let after = self.wrong.get(g).and_then(|t| t.back().copied());
        if before == after {
            return;
        }
        if let Some(b) = before {
            self.wrong_by_latest.remove(&(b, g.clone()));
        }
        match after {
            Some(a) => {
                self.wrong_by_latest.insert((a, g.clone()));
            }
            None => {
                self.wrong.remove(g);
            }
        }
    }
}

fn wait(until: i64, now: i64) -> Duration {
    Duration::from_secs((until - now).max(1) as u64)
}

impl Limits {
    /// Counts a new login from `client` (when clients are counted), living until `expires_at`,
    /// unless a cap is reached.
    pub fn start_login(
        &self,
        client: Option<Client>,
        device: &[u8],
        now: i64,
        expires_at: i64,
        at_once: usize,
        per_client: usize,
    ) -> Result<(), Full> {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        g.prune_logins(now);
        if let Some(c) = client
            && let Some(set) = g.per_client.get(&c)
            && set.len() >= per_client
        {
            let oldest = set.first().map_or(expires_at, |(at, _)| *at);
            return Err(Full {
                retry_after: wait(oldest, now),
            });
        }
        if g.logins.len() >= at_once {
            let oldest = g.by_expiry.first().map_or(expires_at, |(at, _)| *at);
            return Err(Full {
                retry_after: wait(oldest, now),
            });
        }
        let key = (expires_at, device.to_owned());
        g.logins.insert(device.to_owned(), (client, expires_at));
        if let Some(c) = client {
            g.per_client.entry(c).or_default().insert(key.clone());
        }
        g.by_expiry.insert(key);
        Ok(())
    }

    /// The login was never stored (its insert failed), or its poll ended it.
    pub fn end_login(&self, device: &[u8]) {
        self.0
            .lock()
            .expect("never poisoned: no panics while held")
            .forget(device);
    }

    /// Whether `guessers` may ask for another code: `Err` with the wait once any of them has
    /// asked for `most` wrong ones within `window`. Let in, the ask holds its place in each one's
    /// count, as a wrong code at `now`, until [`Limits::not_wrong`] gives it back.
    pub fn try_code(
        &self,
        guessers: &[Guesser],
        now: i64,
        most: usize,
        window: Duration,
    ) -> Result<(), Full> {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        let since = now - window.as_secs() as i64;
        g.prune_wrong(since);
        for who in guessers {
            let Some(times) = g.wrong.get_mut(who) else {
                continue;
            };
            let before = times.back().copied();
            while times.front().is_some_and(|t| *t <= since) {
                times.pop_front();
            }
            let (len, oldest) = (times.len(), times.front().copied());
            g.relatest(who, before);
            if len >= most {
                return Err(Full {
                    retry_after: wait(oldest.expect("not empty") + window.as_secs() as i64, now),
                });
            }
        }
        for who in guessers {
            let before = g.wrong.get(who).and_then(|t| t.back().copied());
            g.wrong.entry(who.clone()).or_default().push_back(now);
            g.relatest(who, before);
        }
        Ok(())
    }

    /// The ask let in by [`Limits::try_code`] at `at` found a live login's code: its place in
    /// each count is given back.
    pub fn not_wrong(&self, guessers: &[Guesser], at: i64) {
        let mut g = self.0.lock().expect("never poisoned: no panics while held");
        for who in guessers {
            let Some(times) = g.wrong.get_mut(who) else {
                continue;
            };
            let before = times.back().copied();
            // Any one of the times at `at`: they're all alike.
            if let Some(i) = times.iter().rposition(|t| *t == at) {
                times.remove(i);
            }
            g.relatest(who, before);
        }
    }
}
