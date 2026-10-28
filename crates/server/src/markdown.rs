//! Bodies and comments as the detail sends them: the compact AST from `md-ast`, and beside it
//! the `refs` map, which says which of the items the ASTs refer to are in the viewer's mirror,
//! and the `media` map, what the mirror knows of the images they show (`media/`). The AST never
//! depends on the mirror; only the maps do.
//!
//! Rendering happens outside any mirror read: a handler reads the posts' Markdown, lets the
//! connection go, renders them on the blocking pool ([`render`]), and then reads `refs`.
//!
//! **The cache.** One per process, shared by every account: a rendered post is kept under
//! (post kind, id, [`md_ast::VERSION`], its place, its digest). The AST is a
//! function of the Markdown and its place alone, and both are in the key, so two mirrors holding
//! a post differently can't be served each other's rendering, and an edit elsewhere on the issue
//! (a label, its state) leaves its body's entry as it was. The cache is an LRU bounded by the
//! bytes its entries take ([`CACHE_BYTES`]): each AST, stored as the JSON it goes out as, so a
//! hit costs neither a render nor a serialisation, and its key, references and bookkeeping.
//!
//! Two opens of a post neither finds cached render it once: the second waits on the first's
//! render. And no more posts render at once than there are CPUs.

use crate::App;
use crate::crypto::ImageKey;
use hashlink::LinkedHashMap;
use md_ast::{Context, Image, ItemRef};
use mirror_db::{QueryResult, Reader, q};
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use ts_rs::TS;

/// How many bytes of rendered posts the cache keeps at most.
pub const CACHE_BYTES: usize = 64 << 20;

/// A rendered body or comment: `[tag, attrs | 0, ...children]` nodes, text as strings. ts-rs
/// can't spell a variadic tuple, so a field of this type takes
/// `#[ts(type = "import(\"../md/ast\").Md")]`, the web app's own declaration of the shape.
#[derive(Clone)]
pub struct Md(Arc<Rendering>);

struct Rendering {
    /// The AST as it goes on the wire.
    ast: Box<RawValue>,
    /// What it refers to (see [`md_ast::Rendered::items`]).
    items: Vec<ItemRef>,
    /// The images it shows (see [`md_ast::Rendered::images`]).
    images: Vec<Image>,
}

impl Md {
    /// Every issue or PR the post refers to.
    pub fn items(&self) -> &[ItemRef] {
        &self.0.items
    }

    /// Every image the post shows.
    pub fn images(&self) -> &[Image] {
        &self.0.images
    }
}

impl Serialize for Md {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.ast.serialize(s)
    }
}

/// An item in the viewer's mirror that a body or comment refers to: enough for the link's state
/// icon and hover title, and its in-app route.
#[derive(Serialize, TS, Clone)]
#[ts(export)]
pub struct RefTarget {
    pub id: i64,
    /// `issue` or `pr`.
    pub kind: String,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    /// `completed`, `not_planned`, … once closed.
    pub state_reason: Option<String>,
}

/// `owner/repo#n`, lowercased, to what the mirror holds there. A reference not in it links to
/// GitHub.
pub type Refs = BTreeMap<String, RefTarget>;

/// The issue or PR posts belong to: a bare `#n` in them is in its repo, and relative links
/// resolve against its page on GitHub.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Place {
    pub owner: String,
    pub repo: String,
    pub number: i64,
}

impl From<&q::ItemDetailRow> for Place {
    fn from(i: &q::ItemDetailRow) -> Place {
        Place::new(&i.owner, &i.repo, i.number)
    }
}

impl From<&q::OpTargetRow> for Place {
    fn from(t: &q::OpTargetRow) -> Place {
        Place::new(&t.owner, &t.repo, t.number)
    }
}

impl Place {
    pub fn new(owner: &str, repo: &str, number: i64) -> Place {
        Place {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
        }
    }
}

/// An issue's body or a comment.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum PostKind {
    Body,
    Comment,
}

/// A post as the mirror holds it, to be rendered.
pub struct Post {
    pub kind: PostKind,
    /// The item's id for a body, the comment's for a comment.
    pub id: i64,
    pub md: String,
}

/// A rendered post.
pub struct RenderedPost {
    pub md: Md,
    /// Its digest: how a tab finds its own maybe-posted comment in the thread without the thread
    /// carrying every comment's source.
    pub digest: Digest,
}

/// A post's digest: the SHA-256 of its Markdown. On the wire, and in a field's TypeScript type
/// (`#[ts(type = "string")]`), it's the hash in lowercase hex.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Digest([u8; 32]);

impl Digest {
    pub fn of(md: &str) -> Digest {
        Digest(Sha256::digest(md.as_bytes()).into())
    }
}

impl std::fmt::Display for Digest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.iter().try_for_each(|b| write!(f, "{b:02x}"))
    }
}

impl Serialize for Digest {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

/// A rendered post's cache key. Nothing about the item it belongs to beyond its place: a label or
/// a state change leaves its body's rendering as it was.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    kind: PostKind,
    id: i64,
    version: u32,
    place: Place,
    digest: Digest,
}

/// What a cache entry holds besides its AST, its key and its references' names, about: the map's
/// node and links, the `Arc`'s counts, the `Box`es' and `Vec`s' headers.
const ENTRY_OVERHEAD: usize = 200;

/// The bytes `md` takes in the cache under `key`, about.
fn entry_size(key: &Key, md: &Md) -> usize {
    let items: usize = md
        .items()
        .iter()
        .map(|i| std::mem::size_of::<ItemRef>() + i.owner.len() + i.repo.len())
        .sum();
    let images: usize = md
        .images()
        .iter()
        .map(|i| std::mem::size_of::<Image>() + 2 * i.src.len())
        .sum();
    md.0.ast.get().len()
        + items
        + images
        + std::mem::size_of::<Key>()
        + key.place.owner.len()
        + key.place.repo.len()
        + ENTRY_OVERHEAD
}

/// A counting semaphore for blocking code: at most `n` holders at once.
struct Permits {
    free: Mutex<usize>,
    freed: Condvar,
}

impl Permits {
    fn new(n: usize) -> Permits {
        Permits {
            free: Mutex::new(n),
            freed: Condvar::new(),
        }
    }

    /// Runs `f` holding a permit, waiting for one first if none is free.
    fn with<T>(&self, f: impl FnOnce() -> T) -> T {
        let mut free = self.free.lock().unwrap_or_else(PoisonError::into_inner);
        while *free == 0 {
            free = self
                .freed
                .wait(free)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *free -= 1;
        drop(free);
        // Given back even if `f` panics.
        struct Give<'p>(&'p Permits);
        impl Drop for Give<'_> {
            fn drop(&mut self) {
                *self.0.free.lock().unwrap_or_else(PoisonError::into_inner) += 1;
                self.0.freed.notify_one();
            }
        }
        let _give = Give(self);
        f()
    }
}

/// Rendered posts, least recently used first, each with the bytes it takes.
type Entries = LinkedHashMap<Key, (Md, usize)>;

/// Rendered posts, least recently used first, with the bytes each takes and their sum; the
/// renders under way, which a second open of the same post waits on instead of rendering it
/// too; and the permits that bound how many render at once.
pub struct Cache {
    budget: usize,
    /// Signs the image proxy's URLs in the ASTs.
    images: Arc<ImageKey>,
    inner: Mutex<(Entries, usize)>,
    rendering: Mutex<HashMap<Key, Arc<OnceLock<Md>>>>,
    permits: Permits,
    /// How many posts it has rendered, hits not counted.
    renders: AtomicU64,
}

impl Cache {
    pub fn new(budget: usize, images: Arc<ImageKey>) -> Cache {
        Cache {
            budget,
            images,
            inner: Mutex::new((LinkedHashMap::new(), 0)),
            rendering: Mutex::new(HashMap::new()),
            // A render is CPU work: more at once than there are CPUs only queues in the OS.
            permits: Permits::new(std::thread::available_parallelism().map_or(4, usize::from)),
            renders: AtomicU64::new(0),
        }
    }

    /// How many posts it has rendered: every miss is one. Only the cache's own tests ask: no
    /// HTTP answer shows whether a post was rendered again.
    #[cfg(test)]
    fn renders(&self) -> u64 {
        self.renders.load(Ordering::Relaxed)
    }

    fn get(&self, key: &Key) -> Option<Md> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.0.to_back(key).map(|(md, _)| md.clone())
    }

    fn put(&self, key: Key, md: Md) {
        let size = entry_size(&key, &md);
        if size > self.budget {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let (map, bytes) = &mut *inner;
        if let Some((_, old)) = map.insert(key, (md, size)) {
            *bytes -= old;
        }
        *bytes += size;
        while *bytes > self.budget {
            let Some((_, (_, gone))) = map.pop_front() else {
                break;
            };
            *bytes -= gone;
        }
    }

    /// The post under `key`: from the cache, or from a render of it already under way, or
    /// rendered now and kept.
    fn render_cached(&self, key: Key, place: &Place, p: &Post) -> Md {
        let cell = {
            let mut rendering = self
                .rendering
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            // Looked up under the lock a finished render is taken off under, so a post is
            // either in the cache or under way here, never neither in between.
            if let Some(md) = self.get(&key) {
                return md;
            }
            rendering.entry(key.clone()).or_default().clone()
        };
        let mut mine = false;
        let md = cell
            .get_or_init(|| {
                mine = true;
                self.renders.fetch_add(1, Ordering::Relaxed);
                self.permits.with(|| render_one(place, p, &self.images))
            })
            .clone();
        if mine {
            self.put(key.clone(), md.clone());
            self.rendering
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&key);
        }
        md
    }

    /// `posts`, all in `place`, each from the cache if it holds it, else rendered and kept.
    /// Blocking: a render can take milliseconds.
    pub fn render(&self, place: &Place, posts: &[Post]) -> Vec<RenderedPost> {
        posts
            .iter()
            .map(|p| {
                let digest = Digest::of(&p.md);
                let key = Key {
                    kind: p.kind,
                    id: p.id,
                    version: md_ast::VERSION,
                    place: place.clone(),
                    digest,
                };
                RenderedPost {
                    md: self.render_cached(key, place, p),
                    digest,
                }
            })
            .collect()
    }
}

fn context<'p>(place: &'p Place, prefix: &'p str, sign: &'p dyn Fn(&str) -> String) -> Context<'p> {
    Context {
        owner: &place.owner,
        repo: &place.repo,
        number: place.number,
        id_prefix: prefix,
        sign,
    }
}

/// Plain text shows no images: nothing to sign.
fn unsigned(_: &str) -> String {
    String::new()
}

fn id_prefix(p: &Post) -> String {
    match p.kind {
        PostKind::Body => format!("md-b{}-", p.id),
        PostKind::Comment => format!("md-c{}-", p.id),
    }
}

fn to_md(r: md_ast::Rendered) -> Md {
    let ast = serde_json::value::to_raw_value(&r.ast).expect("an AST serialises");
    Md(Arc::new(Rendering {
        ast,
        items: r.items,
        images: r.images,
    }))
}

fn render_one(place: &Place, p: &Post, images: &ImageKey) -> Md {
    let prefix = id_prefix(p);
    let sign = |url: &str| images.sign(url);
    to_md(md_ast::render(&p.md, &context(place, &prefix, &sign)))
}

/// `p` as plain text, its references still links: as it shows when its rendering failed.
fn plain(place: &Place, p: &Post) -> RenderedPost {
    let prefix = id_prefix(p);
    RenderedPost {
        md: to_md(md_ast::plain(&p.md, &context(place, &prefix, &unsigned))),
        digest: Digest::of(&p.md),
    }
}

/// `posts`, rendered on the blocking pool (through the cache), in order. If that fails (the task
/// panicked, or the runtime is shutting down), each is plain text instead: a post is always
/// shown, and a posted comment is never a failure for want of its rendering.
pub async fn render(app: &App, place: Place, posts: Vec<Post>) -> Vec<RenderedPost> {
    let app = app.clone();
    let (place, posts) = (Arc::new(place), Arc::new(posts));
    let (p, ps) = (place.clone(), posts.clone());
    let done = tokio::task::spawn_blocking(move || app.renders().render(&p, &ps)).await;
    done.unwrap_or_else(|e| {
        eprintln!("rendering Markdown: {e}; shown as plain text");
        posts.iter().map(|post| plain(&place, post)).collect()
    })
}

/// The `refs` map for everything `posts` refer to.
pub fn refs<'m>(c: &Reader, posts: impl IntoIterator<Item = &'m Md>) -> QueryResult<Refs> {
    let mut seen = HashSet::new();
    let asked: Vec<(&str, &str, i64)> = posts
        .into_iter()
        .flat_map(Md::items)
        .filter(|i| seen.insert(i.key()))
        .map(|i| (i.owner.as_str(), i.repo.as_str(), i.number))
        .collect();
    if asked.is_empty() {
        return Ok(Refs::new());
    }
    let json = serde_json::to_string(&asked).expect("strings and numbers serialise");
    Ok(q::referenced_items(c, &json)?
        .into_iter()
        .map(|r| {
            let key = ItemRef {
                owner: r.owner,
                repo: r.repo,
                number: r.number,
            }
            .key();
            (
                key,
                RefTarget {
                    id: r.id,
                    kind: r.kind,
                    title: r.title,
                    state: r.state,
                    state_reason: r.state_reason,
                },
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    //! The cache, at crate level: no HTTP answer shows whether a post was rendered again.
    use super::*;

    fn place() -> Place {
        Place::new("acme", "web", 5)
    }

    fn key() -> Arc<ImageKey> {
        crate::crypto::Keys::derive(b"a test key that is at least 32 bytes long").images
    }

    fn comment(id: i64, md: &str) -> Post {
        Post {
            kind: PostKind::Comment,
            id,
            md: md.to_owned(),
        }
    }

    /// Opens `post` in `place` and says whether that rendered it (else the cache had it).
    fn rendered(cache: &Cache, place: &Place, post: Post) -> bool {
        let before = cache.renders();
        cache.render(place, &[post]);
        cache.renders() > before
    }

    #[test]
    fn a_post_rendered_again_comes_from_the_cache_until_it_changes() {
        let cache = Cache::new(CACHE_BYTES, key());
        assert!(rendered(&cache, &place(), comment(1, "See #2")));
        assert!(
            !rendered(&cache, &place(), comment(1, "See #2")),
            "the second open is a hit"
        );
        // Other text, or another place, is another rendering; nothing else about its issue is.
        assert!(rendered(&cache, &place(), comment(1, "See #3")));
        assert!(rendered(
            &cache,
            &Place::new("acme", "api", 5),
            comment(1, "See #2")
        ));
    }

    #[test]
    fn the_cache_forgets_the_least_recently_used_past_its_budget() {
        // Room for two posts of this size, not three.
        let probe = Cache::new(CACHE_BYTES, key());
        probe.render(&place(), &[comment(1, "aaaa")]);
        let size = probe.inner.lock().unwrap().1;
        let cache = Cache::new(2 * size + size / 2, key());
        rendered(&cache, &place(), comment(1, "aaaa"));
        rendered(&cache, &place(), comment(2, "bbbb"));
        // `a` is used again, so `b` is the one to go when `c` comes.
        assert!(!rendered(&cache, &place(), comment(1, "aaaa")));
        rendered(&cache, &place(), comment(3, "cccc"));
        assert!(!rendered(&cache, &place(), comment(1, "aaaa")));
        assert!(rendered(&cache, &place(), comment(2, "bbbb")));
    }

    #[test]
    fn many_tiny_posts_cannot_hold_more_than_the_budget() {
        // Each entry costs its key, its references and its bookkeeping, not only its AST's few
        // bytes: at least 200 bytes, so a 10,000-byte cache keeps at most 50.
        let cache = Cache::new(10_000, key());
        for id in 0..1_000 {
            rendered(&cache, &place(), comment(id, "a"));
        }
        // Newest first: a miss evicts the oldest, which is looked at last.
        let kept = (0..1_000)
            .rev()
            .filter(|id| !rendered(&cache, &place(), comment(*id, "a")))
            .count();
        assert!(kept <= 50, "{kept} kept");
    }

    #[test]
    fn concurrent_cold_opens_of_one_post_render_it_once() {
        let cache = Cache::new(CACHE_BYTES, key());
        // Long enough to render that the opens overlap.
        let md = "| a | b |\n|---|---|\n".to_owned() + &"| *x* | #1 |\n".repeat(3_000);
        let start = std::sync::Barrier::new(8);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    start.wait();
                    cache.render(&place(), &[comment(1, &md)]);
                });
            }
        });
        assert_eq!(cache.renders(), 1);
    }
}
