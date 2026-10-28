//! The image proxy's address guard (SSRF): a post can name any URL, so before each hop the URL
//! must be http(s) on port 80 or 443, and its host must resolve only to public addresses. The
//! connection goes to the address the check passed, never to a second lookup: the resolver
//! below is the HTTP client's, and an IP literal is checked as written (the client never asks a
//! resolver about one).
//!
//! Refused: unspecified, loopback, private, link-local, CGNAT (100.64/10), multicast,
//! documentation, benchmarking, 6to4 relay and reserved ranges, and their IPv6 forms (unique
//! local, link-local, the rest of `::/8`, and the IETF's 2001::/23; IPv4-mapped, NAT64 and 6to4
//! addresses are judged by the IPv4 address they carry).
//!
//! In dev and tests, `BEGHU_DEV_IMAGE_HOSTS` names loopback `ip:port`s that pass as written:
//! Fake GitHub's image host.

use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// A URL or an address the guard refuses.
#[derive(Debug)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "blocked: {}", self.0)
    }
}

impl std::error::Error for Blocked {}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // CGNAT, 100.64.0.0/10.
        || (a == 100 && (b & 0xc0) == 64)
        // IETF protocol assignments, 192.0.0.0/24.
        || (a == 192 && b == 0 && c == 0)
        // The old 6to4 relay anycast, 192.88.99.0/24.
        || (a == 192 && b == 88 && c == 99)
        // Benchmarking, 198.18.0.0/15.
        || (a == 198 && (b & 0xfe) == 18)
        // Reserved, 240.0.0.0/4.
        || a >= 240)
}

/// The IPv4 address in the low 32 bits.
fn low_v4(ip: Ipv6Addr) -> Ipv4Addr {
    let [.., a, b] = ip.segments();
    Ipv4Addr::from((u32::from(a) << 16) | u32::from(b))
}

/// Whether `ip` is a public address: one the proxy may connect to.
pub fn public(ip: IpAddr) -> bool {
    let v6 = match ip {
        IpAddr::V4(v4) => return public_v4(v4),
        IpAddr::V6(v6) => v6,
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = v6.segments();
    match s {
        // NAT64's well-known prefix, 64:ff9b::/96: the IPv4 address it reaches.
        [0x64, 0xff9b, 0, 0, 0, 0, ..] => public_v4(low_v4(v6)),
        // The rest of ::/8, after the arm above on purpose: 64:ff9b::/96 is inside ::/8, and
        // this arm would refuse it if it came first. Unspecified, loopback, IPv4-compatible, IPv4-translated
        // (`::ffff:0:a.b.c.d`), local-use NAT64 (64:ff9b:1::/48), and reserved.
        [first, ..] if first < 0x100 => false,
        // 6to4, 2002::/16: the IPv4 address in bits 16..48.
        [0x2002, hi, lo, ..] => public_v4(Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo))),
        // IETF protocol assignments, 2001::/23: Teredo (2001::/32), benchmarking (2001:2::/48),
        // ORCHID (2001:10::/28, 2001:20::/28) among them; and documentation, 2001:db8::/32.
        [0x2001, second, ..] if second < 0x200 || second == 0xdb8 => false,
        // Documentation, 3fff::/20.
        [0x3fff, second, ..] if second < 0x1000 => false,
        // Discard-only, 100::/64.
        [0x100, 0, 0, 0, ..] => false,
        [first, ..] => {
            !(v6.is_multicast()
                // Unique local, fc00::/7.
                || (first & 0xfe00) == 0xfc00
                // Link-local, fe80::/10, and the old site-local, fec0::/10.
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0)
        }
    }
}

/// Checks a URL before a hop: http(s), no credentials, and port 80 or 443 on a host name or a
/// public IP literal; or one of the `dev` hosts, as written.
pub fn check(url: &Url, dev: &[SocketAddr]) -> Result<(), Blocked> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Blocked(format!("scheme {}", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Blocked("credentials in the URL".into()));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| Blocked("no port".into()))?;
    let literal = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => None,
        None => return Err(Blocked("no host".into())),
    };
    if let Some(ip) = literal
        && dev.contains(&SocketAddr::new(ip, port))
    {
        return Ok(());
    }
    if port != 80 && port != 443 {
        return Err(Blocked(format!("port {port}")));
    }
    match literal {
        Some(ip) if !public(ip) => Err(Blocked(format!("address {ip}"))),
        _ => Ok(()),
    }
}

/// The client's resolver: a host's public addresses, or [`Blocked`] if it has none.
pub struct Resolver;

impl Resolve for Resolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public: Vec<SocketAddr> = found.into_iter().filter(|a| public(a.ip())).collect();
            if public.is_empty() {
                return Err(Box::new(Blocked(format!("{host} has no public address")))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// Whether `e` (an HTTP client error) is the guard's refusal.
pub fn is_blocked(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if err.is::<Blocked>() {
            return true;
        }
        cur = err.source();
    }
    false
}
