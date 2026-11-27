//! An issue's or PR's body history, for Diff mode: `GET /api/issues/:id/history`, every earlier
//! version of the body, newest first, each rendered, with the `refs` and `media` of them all.
//!
//! GitHub's REST API has no edit history; GraphQL's `userContentEdits` lists a body's revisions,
//! newest first, each `diff` holding the whole body as of that revision (not a patch), with
//! `editedAt` and `editor`. The newest one is the current body, and an issue never edited has
//! none. It's read on demand, with the viewer's token (as `pickers.rs` reads who can be assigned),
//! 100 per page, and kept in the account's mirror (`body_history`, `body_revisions`) under the
//! digest of the mirror's body it was read for: an open while the body is unchanged reads no
//! GitHub, and the first open after any change to it (a webhook, a sweep, beghu's own edit) reads
//! it again. No webhook or sweep code knows of the cache.
//!
//! What's kept, and sent: the revisions that differ from the mirror's body (the newest, which is
//! the current body, goes), with a run of revisions of one body kept as its oldest (when that
//! body came about), at most [`KEPT`] of the newest. A revision deleted from the history
//! (`deletedAt` set, `diff` null) is kept, as `deleted` with no body. `includes_created` says the
//! oldest one sent is the body as the issue was created.
//!
//! The versions render as bodies do (`markdown::render`, through its cache: the key has the
//! digest, so each version is its own entry), and their `refs` and `media` are one union. Images
//! aren't probed and nothing waits for probes: an image only an old version shows has its usual
//! placeholder until something else measures it.

use crate::App;
use crate::auth::Session;
use crate::detail::{issue_id, readable};
use crate::error::ApiError;
use crate::markdown::{self, Digest, Md, Place, Post, PostKind, Refs};
use crate::media::Media;
use crate::media::probe;
use crate::{github, tokens};
use axum::Json;
use axum::extract::{Extension, Path, State};
use mirror_db::{Caller, q};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

/// The most revisions kept and sent: the newest.
const KEPT: usize = 200;

/// The most pages of 100 revisions one read follows.
const MAX_PAGES: usize = 20;

/// The selection both of the node's types share.
macro_rules! edits_selection {
    () => {
        "includesCreatedEdit
      userContentEdits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { editedAt deletedAt editor { login } diff }
      }"
    };
}

/// `BodyHistory`: a page of an issue's or PR's body revisions, newest first.
pub(crate) const QUERY: &str = concat!(
    "query BodyHistory($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue {
      ",
    edits_selection!(),
    "
    }
    ... on PullRequest {
      ",
    edits_selection!(),
    "
    }
  }
}"
);

/// An issue's or PR's body history.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct BodyHistory {
    /// The digest of the body the history is of, as the detail's `body_digest`: the current
    /// version, which `revisions` doesn't repeat.
    #[ts(type = "string")]
    pub body_digest: Digest,
    /// The oldest revision is the body as the issue was created. False when GitHub didn't
    /// record it, or more revisions exist than are sent.
    pub includes_created: bool,
    /// The earlier versions, newest first. Empty for a body never edited.
    pub revisions: Vec<BodyRevision>,
    /// The items in the mirror that any version refers to.
    pub refs: Refs,
    /// What's known of the images any version shows, by `src`.
    pub media: Media,
}

/// One earlier version of a body.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct BodyRevision {
    /// When it was made: Unix seconds.
    pub edited_at: i64,
    /// Who made it, by login; `null` for a deleted GitHub account.
    pub editor: Option<String>,
    /// Deleted from the history on GitHub: no body.
    pub deleted: bool,
    /// The body as of this revision, rendered; `null` when deleted.
    #[ts(type = "import(\"../md/ast\").Md | null")]
    pub body: Option<Md>,
}

/// A revision as kept, its body not rendered.
#[derive(Clone, Debug)]
struct Raw {
    edited_at: i64,
    editor: Option<String>,
    body: Option<String>,
    deleted: bool,
}

#[derive(Deserialize)]
struct Data {
    node: Option<Node>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    #[serde(default)]
    includes_created_edit: bool,
    user_content_edits: Option<Edits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Edits {
    #[serde(default)]
    nodes: Vec<Option<Edit>>,
    page_info: Option<PageInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Edit {
    edited_at: String,
    deleted_at: Option<String>,
    editor: Option<Login>,
    diff: Option<String>,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

/// What GitHub listed: every revision read, newest first, whether it reaches back to the body as
/// created, and whether pages were left unread.
struct Listed {
    edits: Vec<Raw>,
    includes_created: bool,
    more: bool,
}

pub async fn history(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
) -> Result<Json<BodyHistory>, ApiError> {
    let id = issue_id(&raw)?;
    let account = s.account;
    let (item, node_id, cached) = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let item = match readable(c, id)? {
                Ok(item) => item,
                Err(e) => return Ok(Err(e)),
            };
            let node = q::item_node_id(c, id)?;
            let digest = Digest::of(item.body.as_deref().unwrap_or_default()).to_string();
            let cached = match q::body_history(c, id)? {
                Some(h) if h.for_digest == digest => Some((
                    h.includes_created,
                    q::body_revisions(c, id)?
                        .into_iter()
                        .map(|r| Raw {
                            edited_at: r.edited_at,
                            editor: r.editor,
                            body: r.body,
                            deleted: r.deleted,
                        })
                        .collect::<Vec<_>>(),
                )),
                _ => None,
            };
            Ok(Ok((item, node, cached)))
        })
        .await??;
    let body = item.body.clone().unwrap_or_default();
    let body_digest = Digest::of(&body);
    let (includes_created, revisions) = match cached {
        Some(c) => c,
        None => {
            let node_id = node_id.ok_or(ApiError::Gone)?;
            if app.github().is_down() {
                return Err(ApiError::GitHubDown(
                    "GitHub is unreachable; try again once it's back".into(),
                ));
            }
            let listed = list(&app, account, &node_id)
                .await
                .map_err(read_failure)?
                .ok_or(ApiError::Gone)?;
            let kept = keep(listed, &body);
            store(&app, account, id, body_digest, &kept).await;
            kept
        }
    };
    // Rendered as the body is, each version its own cache entry by its digest.
    let posts = revisions
        .iter()
        .filter_map(|r| r.body.clone())
        .map(|md| Post {
            kind: PostKind::Body,
            id,
            md,
        })
        .collect();
    let mut rendered = markdown::render(&app, Place::from(&item), posts)
        .await
        .into_iter();
    let revisions: Vec<BodyRevision> = revisions
        .into_iter()
        .map(|r| BodyRevision {
            edited_at: r.edited_at,
            editor: r.editor,
            deleted: r.deleted,
            body: r.body.and_then(|_| rendered.next()).map(|p| p.md),
        })
        .collect();
    let mds: Vec<Md> = revisions.iter().filter_map(|r| r.body.clone()).collect();
    let (refs, media) = if mds
        .iter()
        .any(|m| !m.items().is_empty() || !m.images().is_empty())
    {
        app.mirrors()
            .read(account, Caller::Request, move |c| {
                let images: Vec<_> = mds.iter().flat_map(Md::images).collect();
                Ok((markdown::refs(c, &mds)?, probe::media_of(c, &images)?))
            })
            .await?
    } else {
        (Refs::new(), Media::new())
    };
    Ok(Json(BodyHistory {
        body_digest,
        includes_created,
        revisions,
        refs,
        media,
    }))
}

/// Every revision of `node`'s body GitHub lists (up to [`MAX_PAGES`] pages), with the account's
/// token; `None` when GitHub shows the token no such node (deleted, transferred, out of sight).
async fn list(app: &App, account: i64, node: &str) -> Result<Option<Listed>, tokens::Error> {
    let gh = app.github().clone();
    app.tokens()
        .with_token(account, |token| {
            let (gh, node) = (gh.clone(), node.to_owned());
            async move {
                let mut listed = Listed {
                    edits: Vec::new(),
                    includes_created: false,
                    more: false,
                };
                let mut after: Option<String> = None;
                for page in 0..MAX_PAGES {
                    let data: Data = gh
                        .graphql(
                            &token,
                            "BodyHistory",
                            QUERY,
                            json!({ "id": node, "after": after }),
                        )
                        .await?;
                    let Some(n) = data.node else { return Ok(None) };
                    if page == 0 {
                        listed.includes_created = n.includes_created_edit;
                    }
                    let Some(edits) = n.user_content_edits else {
                        break;
                    };
                    listed
                        .edits
                        .extend(edits.nodes.into_iter().flatten().map(|e| {
                            let deleted = e.deleted_at.is_some();
                            Raw {
                                edited_at: crate::webhook::parse_time(&e.edited_at).unwrap_or(0),
                                editor: e.editor.map(|l| l.login),
                                body: if deleted {
                                    None
                                } else {
                                    Some(e.diff.unwrap_or_default())
                                },
                                deleted,
                            }
                        }));
                    match edits.page_info {
                        Some(PageInfo {
                            has_next_page: true,
                            end_cursor: Some(next),
                        }) => {
                            after = Some(next);
                            listed.more = page + 1 == MAX_PAGES;
                        }
                        _ => break,
                    }
                }
                Ok(Some(listed))
            }
        })
        .await
}

/// A body as compared: GitHub's text may end its lines in `\r\n` where the mirror's doesn't.
fn same(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
}

/// The revisions worth showing beside `current`, newest first: those that differ from it, a run
/// of revisions of one body as its oldest, at most [`KEPT`]; and whether the oldest kept is the
/// body as created.
fn keep(listed: Listed, current: &str) -> (bool, Vec<Raw>) {
    let differs = |r: &Raw| r.deleted || !same(r.body.as_deref().unwrap_or_default(), current);
    let created_kept = listed.edits.last().is_some_and(differs);
    let mut kept: Vec<Raw> = Vec::new();
    for r in listed.edits.into_iter().filter(differs) {
        match kept.last_mut() {
            Some(last)
                if !last.deleted
                    && !r.deleted
                    && same(
                        last.body.as_deref().unwrap_or_default(),
                        r.body.as_deref().unwrap_or_default(),
                    ) =>
            {
                *last = r
            }
            _ => kept.push(r),
        }
    }
    let includes_created =
        listed.includes_created && created_kept && !listed.more && kept.len() <= KEPT;
    kept.truncate(KEPT);
    (includes_created, kept)
}

/// Keeps `kept` as item `id`'s history for the body of `digest`. A failure is only said: the
/// read answers all the same, and the next one reads GitHub again.
async fn store(app: &App, account: i64, id: i64, digest: Digest, kept: &(bool, Vec<Raw>)) {
    let (includes_created, revisions) = (kept.0, kept.1.clone());
    let digest = digest.to_string();
    let done = app
        .mirrors()
        .write(account, Caller::Request, move |tx, _seq| {
            q::put_body_history(tx, id, &digest, crate::now(), includes_created)?;
            q::clear_body_revisions(tx, id)?;
            for (position, r) in revisions.iter().enumerate() {
                q::put_body_revision(
                    tx,
                    id,
                    position as i64,
                    r.edited_at,
                    r.editor.as_deref(),
                    r.body.as_deref(),
                    r.deleted,
                )?;
            }
            Ok(())
        })
        .await;
    if let Err(e) = done {
        eprintln!("history: account {account}: keeping item {id}'s body history: {e}");
    }
}

/// How reading the history from GitHub failed, for Diff mode to say.
fn read_failure(e: tokens::Error) -> ApiError {
    match e {
        tokens::Error::SignInAgain | tokens::Error::GitHub(github::Error::Unauthorized) => {
            ApiError::SignedOut
        }
        tokens::Error::GitHub(github::Error::RateLimited(retry_after)) => {
            ApiError::RateLimited { retry_after }
        }
        tokens::Error::GitHub(github::Error::Status(404 | 410)) => ApiError::Gone,
        tokens::Error::GitHub(github::Error::Status(403)) => {
            ApiError::Refused("GitHub didn't show this body's history".into())
        }
        tokens::Error::GitHub(
            github::Error::Network(_) | github::Error::Unsent(_) | github::Error::Status(500..=599),
        ) => ApiError::GitHubDown("GitHub didn't answer; try again".into()),
        // Signed out, restarting (the drain stopped the token's refresh), a sealed database, an
        // answer that couldn't be read.
        e => e.into(),
    }
}
