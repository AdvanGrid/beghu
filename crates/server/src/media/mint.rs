//! Minting: GitHub serves a private attachment only at a URL it mints into a post's rendered
//! HTML, good for 300 s and for whoever holds it. No token fetches the plain
//! `github.com/user-attachments/assets/<uuid>` URL for an App (#62, measured), so beghu reads the
//! HTML of the post that holds the attachment and takes the URL from there.
//!
//! - For the attachment route, with the viewer's user token, one post at a time (REST
//!   `body_html`): GitHub answering 404 means the viewer can't read the post, and the route
//!   answers 404 too. A minted URL is kept in memory for its viewer, well under its 300 s.
//! - For the probes at ingest, with the repo's installation token, up to 100 posts a call
//!   (GraphQL `nodes(ids:)` `bodyHTML`, cost 1), measured straight away.
//!
//! The minted URL also says what the attachment is: GitHub renders a video as `<video src=…>`.

use crate::App;
use crate::installations::Scope;
use mirror_db::{Caller, q};
use reqwest::Url;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a minted URL is used for: GitHub's 300 s, less a margin for a slow fetch.
pub const KEEP_FOR: Duration = Duration::from_secs(240);

/// How many posts one GraphQL mint asks for: GitHub's most in `nodes(ids:)`.
const BATCH: usize = 100;

/// An attachment's minted URL.
#[derive(Clone, Debug)]
pub struct Minted {
    pub url: Url,
    /// GitHub rendered it as a video.
    pub video: bool,
}

/// The minted URL for attachment `uuid` in a post's `html`, if GitHub put one there: a URL under
/// `prefix` (where GitHub mints them) whose file name ends with the UUID.
pub fn find(html: &str, uuid: &str, prefix: &str) -> Option<Minted> {
    let prefix = format!("{}/", prefix.trim_end_matches('/'));
    for (at, _) in html.match_indices(&prefix) {
        let rest = &html[at..];
        let end = rest
            .find(|c: char| matches!(c, '"' | '\'' | '<' | '>') || c.is_whitespace())
            .unwrap_or(rest.len());
        let Ok(url) = Url::parse(&rest[..end].replace("&amp;", "&")) else {
            continue;
        };
        let names = url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .map(|file| file.rsplit_once('.').map_or(file, |(stem, _)| stem))
            .is_some_and(|stem| stem.to_ascii_lowercase().ends_with(uuid));
        if !names || !url.as_str().starts_with(&prefix) {
            continue;
        }
        // The tag the URL is an attribute of.
        let video = html[..at].rfind('<').is_some_and(|lt| {
            html[lt + 1..]
                .get(..5)
                .is_some_and(|t| t.eq_ignore_ascii_case("video"))
        });
        return Some(Minted { url, video });
    }
    None
}

/// Why the viewer's mint failed.
#[derive(Debug)]
pub enum MintError {
    /// No post the viewer can read holds it: the mirror has none, or GitHub answered 404 for each.
    NotFound,
    /// GitHub or the mirror failed.
    Failed(String),
}

/// The minted URL for attachment `uuid`, as `account` may see it: from memory, or minted now
/// from the first post in the account's mirror that holds it and that GitHub shows them.
/// `Failed` only when GitHub failed on a holder and none minted.
pub async fn for_viewer(app: &App, account: i64, uuid: &str) -> Result<Minted, MintError> {
    if let Some(m) = app.media().held(account, uuid) {
        return Ok(m);
    }
    let phrase = format!("\"{}\"", uuid.replace('-', " "));
    let needle = format!("user-attachments/assets/{uuid}");
    let holders = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            q::attachment_holders(c, &phrase, &needle)
        })
        .await
        .map_err(|e| MintError::Failed(e.to_string()))?;
    let prefix = app.cfg().github.attachments_url.clone();
    // A holder GitHub failed on (not a 404) may be the only one the viewer can't read, or a
    // blip: the next holder is asked all the same, and only if none mints is it a failure.
    let mut failed = None;
    for h in holders {
        let path = match h.comment_id {
            Some(c) => format!("/repos/{}/{}/issues/comments/{c}", h.owner, h.repo),
            None => format!("/repos/{}/{}/issues/{}", h.owner, h.repo, h.number),
        };
        let gh = app.github().clone();
        let html = app
            .tokens()
            .with_token(account, |t| {
                let (gh, path) = (gh.clone(), path.clone());
                async move { gh.body_html(&t, &path).await }
            })
            .await;
        let html = match html {
            Ok(html) => html,
            Err(e) => {
                failed = Some(format!("{e:?}"));
                continue;
            }
        };
        if let Some(m) = html.and_then(|html| find(&html, uuid, &prefix)) {
            app.media().hold(account, uuid, &m);
            return Ok(m);
        }
    }
    Err(failed.map_or(MintError::NotFound, MintError::Failed))
}

/// `MintAttachments`: each post's rendered HTML, where GitHub mints its attachments' URLs.
pub(super) const MINT_ATTACHMENTS: &str = "query MintAttachments($ids: [ID!]!) { nodes(ids: $ids) { __typename \
    ... on Issue { id bodyHTML } ... on PullRequest { id bodyHTML } \
    ... on IssueComment { id bodyHTML } } }";

/// Mints the attachments `wanted` names, post by post (`node id → UUIDs`), with
/// `installation`'s token, [`BATCH`] posts a call: the URLs found, by UUID. A failed call leaves
/// its posts' attachments out: they're measured when a detail shows them.
pub async fn for_probes(
    app: &App,
    installation: i64,
    wanted: &[(String, Vec<String>)],
) -> HashMap<String, Minted> {
    let prefix = app.cfg().github.attachments_url.clone();
    let mut out = HashMap::new();
    for batch in wanted.chunks(BATCH) {
        let token = match app.installations().token(installation, Scope::Import).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("media: no token for installation {installation} to mint with: {e}");
                return out;
            }
        };
        let ids: Vec<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
        let data = match app
            .github()
            .graphql_data(
                &token,
                "MintAttachments",
                MINT_ATTACHMENTS,
                serde_json::json!({ "ids": ids }),
            )
            .await
        {
            Ok(d) => d,
            Err(e) => {
                eprintln!("media: minting {} posts' attachments: {e:?}", batch.len());
                continue;
            }
        };
        let nodes = data["nodes"].as_array().cloned().unwrap_or_default();
        for ((_, uuids), node) in batch.iter().zip(nodes) {
            let html = node["bodyHTML"].as_str().unwrap_or_default();
            for uuid in uuids {
                if let Some(m) = find(html, uuid, &prefix) {
                    out.insert(uuid.clone(), m);
                }
            }
        }
    }
    out
}

/// Minted URLs held per viewer and attachment, until they're due to expire.
#[derive(Default)]
pub struct Held(std::sync::Mutex<HashMap<(i64, String), (Minted, Instant)>>);

impl Held {
    pub fn get(&self, account: i64, uuid: &str) -> Option<Minted> {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        held.retain(|_, (_, until)| *until > now);
        held.get(&(account, uuid.to_owned()))
            .map(|(m, _)| m.clone())
    }

    pub fn put(&self, account: i64, uuid: &str, m: &Minted) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
            (account, uuid.to_owned()),
            (m.clone(), Instant::now() + KEEP_FOR),
        );
    }

    /// GitHub refused the held URL: it expired early, or was revoked.
    pub fn forget(&self, account: i64, uuid: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(account, uuid.to_owned()));
    }
}
