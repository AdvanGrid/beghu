//! Measuring images, so a thread doesn't jump as they load (spec, "Image dims").
//!
//! An image the post gives no size for (no `width` and `height`), and every bare attachment (a
//! `media` node, which could be a video), is probed: `Range: bytes=0-65535` and `imagesize` (or,
//! for a video, `video.rs`) read its size from the first bytes, and the answer's type and length
//! say what it is. The finding goes into the account's mirror, `image_dims`, keyed by the SHA-256
//! of the image's URL (an attachment's canonical one): its size and type, or why it can't be
//! shown (`too_large`, `not_image`, `blocked`), which the browser then never asks for. Only
//! what's measured is stored, never bytes. An external image is fetched through the image proxy's
//! guard and limits; an attachment is minted first (`mint.rs`).
//!
//! When: as a post comes in (the import, after each page, the closed threads' REST pass
//! included, so their attachments mint in batches with the installation's token; a webhook, whose
//! push waits up to [`MediaConfig::webhook_wait`](crate::config::MediaConfig) for them; a
//! read-back of a PR or of a transferred issue's thread, which waits for nothing), and as a
//! detail is asked for with images still unmeasured, the sweeps' and anything else's (it waits up
//! to [`MediaConfig::detail_wait`](crate::config::MediaConfig)). Findings that land after the
//! wait send the item's tabs one more push.
//!
//! A probe of one URL runs once at a time across the process, however many accounts and requests
//! want it, and what it found is remembered for a while: a failure that may pass (a timeout, a
//! 5xx) isn't stored in a mirror, and isn't tried again for [`RETRY_AFTER`]. An attachment one
//! account couldn't mint isn't remembered at all: minting is that account's, and another's may
//! succeed.

use super::mint::{self, Minted};
use crate::App;
use crate::live::Push;
use hashlink::LinkedHashMap;
use md_ast::{Image, Source};
use mirror_db::{Caller, q};
use reqwest::Url;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderMap, HeaderValue, RANGE};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How much of an image a probe reads: enough for every format's header `imagesize` knows.
const HEAD: usize = 65_536;

/// How long a probe's finding is remembered in memory, a lasting one or not.
const REMEMBER: Duration = Duration::from_secs(10 * 60);
/// How long after a failure that may pass a probe of the same URL is tried again.
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many findings are remembered at most.
const REMEMBERED: usize = 4096;
/// How many probes run at once, across the process.
const AT_ONCE: usize = 8;

/// The image types the image proxy serves.
pub const IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
    "image/bmp",
    "image/x-icon",
];

/// Whether the image proxy serves `content_type` (its media type, parameters aside).
pub fn is_image_type(content_type: &str) -> bool {
    let t = content_type.split(';').next().unwrap_or("").trim();
    IMAGE_TYPES.iter().any(|a| a.eq_ignore_ascii_case(t))
}

/// Whether the attachment route serves `content_type`: an image or a video.
pub fn is_attachment_type(content_type: &str) -> bool {
    let t = content_type.split(';').next().unwrap_or("").trim();
    let t = t.to_ascii_lowercase();
    t.starts_with("image/") || t.starts_with("video/")
}

/// The key an image's measurements are kept under.
pub type Hash = [u8; 32];

pub fn hash(url: &str) -> Hash {
    Sha256::digest(url.as_bytes()).into()
}

fn hex(h: &Hash) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a probe found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub content_type: Option<String>,
    /// Why it can't be shown: `too_large`, `not_image` or `blocked`.
    pub unavailable: Option<String>,
}

impl Finding {
    fn unavailable(why: &str) -> Finding {
        Finding {
            width: None,
            height: None,
            content_type: None,
            unavailable: Some(why.to_owned()),
        }
    }
}

/// What the server knows of an image a post shows: in the `media` map beside the posts, by the
/// image's `src`.
#[derive(serde::Serialize, ts_rs::TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct MediaInfo {
    /// Its natural width in pixels, once measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub w: Option<i64>,
    /// Its natural height in pixels, once measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub h: Option<i64>,
    /// Its type as served (`image/png`, `video/webm`): a `media` node is a video for `video/*`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content_type: Option<String>,
    /// Known in advance not to load, and why: `too_large`, `not_image` or `blocked`. The browser
    /// never asks for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unavailable: Option<String>,
}

impl From<&Finding> for MediaInfo {
    fn from(f: &Finding) -> MediaInfo {
        MediaInfo {
            w: f.width,
            h: f.height,
            content_type: f.content_type.clone(),
            unavailable: f.unavailable.clone(),
        }
    }
}

/// The `media` map: by `src`, what's known of the images the posts beside it show.
pub type Media = BTreeMap<String, MediaInfo>;

/// One image to measure, and where its post is (for minting an attachment).
#[derive(Clone, Debug)]
pub struct Todo {
    pub hash: Hash,
    pub what: What,
}

impl Todo {
    /// Measuring `image`, in the post with node id `node` if known.
    pub fn of(image: &Image, node: Option<String>) -> Todo {
        Todo {
            hash: hash(&image.source.key()),
            what: match &image.source {
                Source::Attachment(uuid) => What::Attachment {
                    uuid: uuid.clone(),
                    node,
                },
                Source::External(url) => What::External(url.clone()),
            },
        }
    }
}

#[derive(Clone, Debug)]
pub enum What {
    External(String),
    /// An attachment: minted with the installation's token from the post with this node id, or
    /// with the viewer's from any post holding it (`None`).
    Attachment {
        uuid: String,
        node: Option<String>,
    },
}

/// The probes' shared state: what's in flight, what was found lately, and the turns.
pub struct Probes {
    /// The images each account has a measuring run under way for: a second run that wants one
    /// waits on it rather than writing and pushing it again.
    owned: Mutex<HashSet<(i64, Hash)>>,
    inflight: Mutex<HashMap<Hash, Arc<tokio::sync::OnceCell<Option<Finding>>>>>,
    recent: Mutex<LinkedHashMap<Hash, (Option<Finding>, Instant)>>,
    turns: Arc<tokio::sync::Semaphore>,
}

impl Default for Probes {
    fn default() -> Self {
        Probes {
            owned: Mutex::default(),
            inflight: Mutex::default(),
            recent: Mutex::new(LinkedHashMap::new()),
            turns: Arc::new(tokio::sync::Semaphore::new(AT_ONCE)),
        }
    }
}

impl Probes {
    /// What was found lately for `h`: `Some(None)` for a failure that may pass, not yet due to be
    /// tried again.
    fn remembered(&self, h: &Hash) -> Option<Option<Finding>> {
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        let (found, at) = recent.get(h)?.clone();
        let keep = if found.is_some() {
            REMEMBER
        } else {
            RETRY_AFTER
        };
        if at.elapsed() > keep {
            recent.remove(h);
            return None;
        }
        Some(found)
    }

    fn remember(&self, h: Hash, found: Option<Finding>) {
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.insert(h, (found, Instant::now()));
        while recent.len() > REMEMBERED {
            recent.pop_front();
        }
    }

    /// `h`'s finding: remembered, or from the probe in flight, or from `probe` run now.
    async fn once<F>(&self, h: Hash, probe: F) -> Option<Finding>
    where
        F: std::future::Future<Output = Option<Finding>>,
    {
        if let Some(found) = self.remembered(&h) {
            return found;
        }
        let cell = self
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(h)
            .or_default()
            .clone();
        let found = cell
            .get_or_init(|| async {
                let _turn = self.turns.acquire().await;
                let found = probe.await;
                self.remember(h, found.clone());
                found
            })
            .await
            .clone();
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if inflight.get(&h).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&h);
        }
        found
    }
}

/// The type in `h`, if any.
fn content_type(h: &HeaderMap) -> Option<String> {
    h.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(|v| {
        v.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
    })
}

/// The whole length of what a 200 or 206 answer is part of.
fn full_length(h: &HeaderMap, partial: bool) -> Option<u64> {
    if partial {
        let range = h.get(CONTENT_RANGE)?.to_str().ok()?;
        range.rsplit_once('/')?.1.parse().ok()
    } else {
        h.get(CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
    }
}

/// Measures the first bytes of `res`, with `cap` the most it may be and `ok` the types allowed.
async fn read_size(
    app: &App,
    res: reqwest::Response,
    cap: u64,
    ok: fn(&str) -> bool,
    by: tokio::time::Instant,
) -> Option<Finding> {
    let status = res.status().as_u16();
    if status != 200 && status != 206 {
        return None;
    }
    let ct = content_type(res.headers());
    if !ct.as_deref().is_some_and(ok) {
        return Some(Finding::unavailable("not_image"));
    }
    if full_length(res.headers(), status == 206).is_some_and(|n| n > cap) {
        return Some(Finding::unavailable("too_large"));
    }
    let head = app.media().fetch.head_bytes(res, HEAD, by).await.ok()?;
    let size = match imagesize::blob_size(&head) {
        Ok(s) => Some((s.width as i64, s.height as i64)),
        Err(_) => super::video::size(&head),
    };
    Some(Finding {
        width: size.map(|s| s.0),
        height: size.map(|s| s.1),
        content_type: ct,
        unavailable: None,
    })
}

fn range() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(RANGE, HeaderValue::from_static("bytes=0-65535"));
    h
}

/// Probes an image a post names, through the guard.
async fn probe_external(app: &App, url: &str) -> Option<Finding> {
    let Ok(url) = Url::parse(url) else {
        return Some(Finding::unavailable("blocked"));
    };
    let cfg = app.media().fetch.cfg.clone();
    let by = tokio::time::Instant::now() + cfg.image_total;
    match app.media().fetch.guarded(url, range(), by).await {
        Ok(res) => read_size(app, res, cfg.image_max, is_image_type, by).await,
        Err(f) => f.lasting().map(Finding::unavailable),
    }
}

/// Probes an attachment at its minted URL.
async fn probe_minted(app: &App, m: &Minted) -> Option<Finding> {
    let cfg = app.media().fetch.cfg.clone();
    let by = tokio::time::Instant::now() + cfg.first_byte + cfg.idle;
    match app.media().fetch.minted(m.url.clone(), range()).await {
        Ok(res) => read_size(app, res, cfg.attachment_max, is_attachment_type, by).await,
        Err(_) => None,
    }
}

/// GitHub rendered `m` as a video: its type is a video's, whatever the file server said (a
/// `.mov` can come as `application/octet-stream`), by the file's extension.
fn as_minted(m: &Minted, f: Finding) -> Finding {
    let is_video = f
        .content_type
        .as_deref()
        .is_some_and(|t| t.starts_with("video/"));
    if !m.video || is_video || f.unavailable.as_deref().is_some_and(|u| u != "not_image") {
        return f;
    }
    let ext = m
        .url
        .path()
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase());
    let t = match ext.as_deref() {
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "video/mp4",
    };
    Finding {
        content_type: Some(t.to_owned()),
        unavailable: None,
        ..f
    }
}

/// The `Todo`s for `images` that `account`'s mirror has no finding for yet. `node`: the node id of
/// the post they're in, when known.
pub async fn unmeasured(
    app: &App,
    account: i64,
    images: Vec<(Image, Option<String>)>,
) -> Vec<Todo> {
    let todo: Vec<Todo> = images
        .into_iter()
        .filter(|(i, _)| !i.sized)
        .map(|(i, node)| Todo::of(&i, node))
        .collect();
    if todo.is_empty() {
        return todo;
    }
    let hashes: Vec<String> = todo.iter().map(|t| hex(&t.hash)).collect();
    let json = serde_json::to_string(&hashes).expect("strings serialise");
    let known: HashSet<Vec<u8>> = app
        .mirrors()
        .read(account, Caller::Sweep, move |c| q::image_dims(c, &json))
        .await
        .map(|rows| rows.into_iter().map(|r| r.url_hash).collect())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    todo.into_iter()
        .filter(|t| !known.contains(t.hash.as_slice()) && seen.insert(t.hash))
        .collect()
}

/// What `account`'s mirror knows of `images`, by `src`.
pub fn media_of(c: &mirror_db::Reader, images: &[&Image]) -> mirror_db::QueryResult<Media> {
    if images.is_empty() {
        return Ok(Media::new());
    }
    let hashes: Vec<String> = images.iter().map(|i| hex(&hash(&i.source.key()))).collect();
    let json = serde_json::to_string(&hashes).expect("strings serialise");
    let rows: HashMap<Vec<u8>, MediaInfo> = q::image_dims(c, &json)?
        .into_iter()
        .map(|r| {
            (
                r.url_hash,
                MediaInfo {
                    w: r.width,
                    h: r.height,
                    content_type: r.content_type,
                    unavailable: r.unavailable_reason,
                },
            )
        })
        .collect();
    Ok(images
        .iter()
        .filter_map(|i| {
            rows.get(hash(&i.source.key()).as_slice())
                .map(|m| (i.src.clone(), m.clone()))
        })
        .collect())
}

/// Where a measuring run is: what's landed, and whether its waiter gave up waiting.
#[derive(Default)]
struct Progress {
    landed: HashMap<Hash, Finding>,
    gave_up: bool,
    /// Findings written after the waiter gave up.
    late: bool,
}

/// Gives back an account's claim on the images a measuring run owned, however the run ends.
struct Claim {
    app: App,
    account: i64,
    hashes: Vec<Hash>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut owned = self
            .app
            .media()
            .probes
            .owned
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for h in &self.hashes {
            owned.remove(&(self.account, *h));
        }
    }
}

/// How often a run waiting on another's images looks for them.
const LOOK_EVERY: Duration = Duration::from_millis(25);

/// Measures `todo` for `account` in a job, writing each finding to the mirror as it lands. Waits
/// up to `wait` and returns the findings that landed by then; if more land after it, `item`'s
/// tabs (if given) get one more push once the last has. An image another run for the account is
/// already measuring is left to that run, which writes and pushes it; this one only waits for it.
/// `installation` mints attachments that name their post; the others are minted with the
/// viewer's token.
pub async fn measure(
    app: &App,
    account: i64,
    item: Option<i64>,
    installation: Option<i64>,
    todo: Vec<Todo>,
    wait: Duration,
) -> HashMap<Hash, Finding> {
    if todo.is_empty() {
        return HashMap::new();
    }
    let probes = &app.media().probes;
    let (mine, theirs): (Vec<Todo>, Vec<Todo>) = {
        let mut owned = probes.owned.lock().unwrap_or_else(|e| e.into_inner());
        todo.into_iter()
            .partition(|t| owned.insert((account, t.hash)))
    };
    let progress = Arc::new(Mutex::new(Progress::default()));
    let (done_tx, mut done_rx) = tokio::sync::watch::channel(mine.is_empty());
    if !mine.is_empty() {
        let p = progress.clone();
        app.spawn(move |app| async move {
            let _claim = Claim {
                app: app.clone(),
                account,
                hashes: mine.iter().map(|t| t.hash).collect(),
            };
            run(&app, account, installation, mine, &p).await;
            let late = {
                let p = p.lock().unwrap_or_else(|e| e.into_inner());
                p.gave_up && p.late
            };
            if let (true, Some(item)) = (late, item) {
                app.hub().publish(account, Push::Ids(Arc::from([item])));
            }
            let _ = done_tx.send(true);
        });
    }
    let others_in = || theirs.iter().all(|t| probes.remembered(&t.hash).is_some());
    let _ = tokio::time::timeout(wait, async {
        let _ = done_rx.wait_for(|d| *d).await;
        while !others_in() {
            tokio::time::sleep(LOOK_EVERY).await;
        }
    })
    .await;
    let mut landed = {
        let mut p = progress.lock().unwrap_or_else(|e| e.into_inner());
        p.gave_up = true;
        p.landed.clone()
    };
    for t in theirs {
        if let Some(Some(f)) = probes.remembered(&t.hash) {
            landed.insert(t.hash, f);
        }
    }
    landed
}

/// Mints what needs minting, probes everything, and writes each finding as it lands.
async fn run(
    app: &App,
    account: i64,
    installation: Option<i64>,
    todo: Vec<Todo>,
    progress: &Mutex<Progress>,
) {
    // Attachments named by their post, minted together with the installation's token.
    let mut by_node: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for t in &todo {
        if let (
            What::Attachment {
                uuid,
                node: Some(n),
            },
            Some(_),
        ) = (&t.what, installation)
        {
            by_node.entry(n.clone()).or_default().push(uuid.clone());
        }
    }
    let minted = match installation {
        Some(inst) if !by_node.is_empty() => {
            let wanted: Vec<(String, Vec<String>)> = by_node.into_iter().collect();
            mint::for_probes(app, inst, &wanted).await
        }
        _ => HashMap::new(),
    };
    let minted = Arc::new(minted);
    let probes = todo.into_iter().map(|t| {
        let minted = minted.clone();
        async move {
            let probes = &app.media().probes;
            let found = match &t.what {
                What::External(url) => probes.once(t.hash, probe_external(app, url)).await,
                // Lately measured for any account: no need to mint.
                What::Attachment { .. } if probes.remembered(&t.hash).is_some() => {
                    probes.remembered(&t.hash).flatten()
                }
                What::Attachment { uuid, node } => {
                    let m = match minted.get(uuid) {
                        Some(m) => Some(m.clone()),
                        // Not minted with the installation's token: the viewer's.
                        None if node.is_none() || installation.is_none() => {
                            mint::for_viewer(app, account, uuid).await.ok()
                        }
                        None => None,
                    };
                    // Minting is this account's: one it couldn't do isn't remembered, so
                    // another account's probe of the same attachment still mints and measures.
                    match m {
                        Some(m) => {
                            probes
                                .once(t.hash, async {
                                    probe_minted(app, &m).await.map(|f| as_minted(&m, f))
                                })
                                .await
                        }
                        None => None,
                    }
                }
            };
            (t.hash, found)
        }
    });
    use futures_util::StreamExt as _;
    let mut found = futures_util::stream::iter(probes).buffer_unordered(AT_ONCE);
    while let Some((h, f)) = found.next().await {
        let Some(f) = f else { continue };
        let row = f.clone();
        let wrote = app
            .mirrors()
            .write(account, Caller::Sweep, move |tx, _| {
                q::put_image_dims(
                    tx,
                    &h,
                    row.width,
                    row.height,
                    row.content_type.as_deref(),
                    row.unavailable.as_deref(),
                )
            })
            .await;
        if let Err(e) = wrote {
            eprintln!("media: account {account}: writing a probe's finding: {e}");
            continue;
        }
        let mut p = progress.lock().unwrap_or_else(|e| e.into_inner());
        if p.gave_up {
            p.late = true;
        }
        p.landed.insert(h, f);
    }
}

/// Whether `md` may show an image at all: a cheap look before rendering it to find out.
pub fn may_show_images(md: &str) -> bool {
    md.contains("![")
        || md.contains("user-attachments/assets/")
        || (md.contains('<') && {
            let lower = md.to_ascii_lowercase();
            lower.contains("<img") || lower.contains("<source")
        })
}

/// A post that came in (from a webhook or the import), to measure the images of.
pub struct Incoming {
    /// The issue or PR it's on.
    pub item: i64,
    pub post: crate::markdown::Post,
    /// Its node id: what minting with the installation's token asks GitHub for.
    pub node: String,
}

/// Measures the images in `posts` that `account`'s mirror has no finding for, waiting up to
/// `wait`. Findings that land later push `push` (the item a webhook changed), if given.
pub async fn ingest(
    app: &App,
    account: i64,
    posts: Vec<Incoming>,
    wait: Duration,
    push: Option<i64>,
) {
    let posts: Vec<Incoming> = posts
        .into_iter()
        .filter(|p| may_show_images(&p.post.md))
        .collect();
    if posts.is_empty() {
        return;
    }
    // Each item's place, and the installation that mints for it.
    let items: Vec<i64> = posts.iter().map(|p| p.item).collect();
    let places = app
        .mirrors()
        .read(account, Caller::Sweep, move |c| {
            let mut out = HashMap::new();
            for id in items {
                if let Some(p) = q::item_place(c, id)? {
                    out.insert(id, p);
                }
            }
            Ok(out)
        })
        .await
        .unwrap_or_default();
    let mut by_item: BTreeMap<i64, Vec<Incoming>> = BTreeMap::new();
    for p in posts {
        by_item.entry(p.item).or_default().push(p);
    }
    let mut images = Vec::new();
    let mut installation = None;
    for (item, posts) in by_item {
        let Some(place) = places.get(&item) else {
            continue;
        };
        installation = installation.or(place.installation_id);
        let nodes: Vec<String> = posts.iter().map(|p| p.node.clone()).collect();
        let rendered = crate::markdown::render(
            app,
            crate::markdown::Place::new(&place.owner, &place.repo, place.number),
            posts.into_iter().map(|p| p.post).collect(),
        )
        .await;
        for (r, node) in rendered.into_iter().zip(nodes) {
            images.extend(
                r.md.images()
                    .iter()
                    .map(|i| (i.clone(), Some(node.clone()))),
            );
        }
    }
    let todo = unmeasured(app, account, images).await;
    if !todo.is_empty() {
        measure(app, account, push, installation, todo, wait).await;
    }
}
