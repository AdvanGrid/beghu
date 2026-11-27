//! Body revisions: what GraphQL's `userContentEdits` lists on an issue or PR (`graphql.rs`,
//! `BodyHistory`), newest first, each the whole body as of that revision with its editor and
//! time. GitHub records one on every body change, so the fake does too, in `fake_body_edits`:
//! outside edits (`POST /edit`) and beghu's own `PATCH`es both go through [`record`]. An issue
//! never edited has none; its first edit records the body as it was created first
//! (`includesCreatedEdit`), as GitHub's list then holds it, and then the new body, which is the
//! current body from then on.
//!
//! The fixture has no history of its own, so a fresh truth seeds some ([`seed`]): on the synced
//! repos' issues and PRs numbered 3, 8, 13, … up to 58 whose body has three or more paragraphs,
//! one to three earlier versions each, made from the current body: a paragraph reworded (the
//! version before the current one), the last paragraph not yet written (the one before that) and
//! a note paragraph since dropped (the original). Every third such item with three earlier
//! versions has its middle one deleted from the history.
//!
//! `POST /history/delete {repo, number, revision, as?}` on the control port deletes one revision
//! from the history, as "Delete revision from history" does on GitHub: `revision` counts from the
//! newest, 0. It keeps its place with `deletedAt` set and no `diff`. GitHub sends no webhook for
//! it, and neither does the fake.

use crate::Fake;
use crate::api;
use crate::control::bad_request;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use fake_db::q;
use serde::Deserialize;
use serde_json::json;

/// Records issue `id`'s body changing from `before` (the issue's row before the change) to
/// `body`, by `editor` at `at`.
pub(crate) fn record(
    tx: &rusqlite::Transaction,
    before: &q::IssueRow,
    body: Option<&str>,
    editor: i64,
    at: i64,
) -> rusqlite::Result<()> {
    if !q::has_body_edits(tx, before.id)? {
        q::add_body_edit(
            tx,
            before.id,
            before.author_id,
            before.created_at.unwrap_or(at),
            Some(before.body.as_deref().unwrap_or_default()),
            true,
        )?;
    }
    q::add_body_edit(
        tx,
        before.id,
        Some(editor),
        at,
        Some(body.unwrap_or_default()),
        false,
    )?;
    Ok(())
}

/// Words a reworded paragraph trades in.
const REWORDS: [&str; 5] = ["draft", "earlier", "rough", "initial", "pending"];

/// A paragraph the original body had, dropped since.
const NOTE: &str = "Opened from a note in the standup; details to follow.";

/// Whether a block is plain prose, rather than a heading, list, table, quote or code.
fn prose(block: &str) -> bool {
    let first = block.trim_start();
    !first.is_empty()
        && !first.starts_with(['#', '-', '*', '|', '>', '`', '<', '!', '['])
        && !first.starts_with(|c: char| c.is_ascii_digit())
}

/// `body`'s earlier versions, the newest first: `n` of them (1 to 3).
fn earlier(body: &str, n: usize) -> Vec<String> {
    let mut blocks: Vec<String> = body.split("\n\n").map(str::to_owned).collect();
    let mut out = Vec::new();
    // The version before the current one: a paragraph reworded.
    let at = blocks.iter().position(|b| prose(b)).unwrap_or(0);
    let reworded: Vec<String> = blocks[at]
        .split(' ')
        .enumerate()
        .map(|(i, w)| {
            if i % 4 == 2 && w.chars().all(|c| c.is_ascii_alphabetic()) {
                REWORDS[i / 4 % REWORDS.len()].to_owned()
            } else {
                w.to_owned()
            }
        })
        .collect();
    let mut reworded = reworded.join(" ");
    if reworded == blocks[at] {
        reworded.push_str(" (draft)");
    }
    blocks[at] = reworded;
    out.push(blocks.join("\n\n"));
    if n >= 2 {
        // Before that: the last paragraph not yet written.
        blocks.pop();
        out.push(blocks.join("\n\n"));
    }
    if n >= 3 {
        // The original: with a note dropped since.
        blocks.insert(1, NOTE.to_owned());
        out.push(blocks.join("\n\n"));
    }
    out
}

/// Seeds the fixture's body history (see the module's docs), in a fresh copy of the fixture.
pub(crate) fn seed(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let teammate = q::user_by_login(tx, "ilze-k")?.map(|u| u.id);
    let mut with_three = 0;
    for item in q::history_seed_items(tx)? {
        let n = 1 + (item.id % 3) as usize;
        let mut versions = earlier(&item.body, n);
        versions.reverse();
        versions.push(item.body.clone());
        // Oldest first, ending on the current body: spread from its creation to its last update.
        let (from, to) = (item.created_at, item.updated_at.max(item.created_at));
        let steps = versions.len() as i64 - 1;
        let gap = ((to - from) / steps.max(1)).max(1);
        let delete_middle = n == 3 && {
            with_three += 1;
            with_three % 3 == 1
        };
        for (k, v) in versions.iter().enumerate() {
            let k = k as i64;
            let at = if k == steps {
                to.max(from + k)
            } else {
                from + k * gap
            };
            let editor = if k % 2 == 1 { teammate } else { item.author_id };
            q::add_body_edit(tx, item.id, editor, at, Some(v), k == 0)?;
        }
        if delete_middle && let Some(seq) = q::nth_body_edit(tx, item.id, 2)? {
            let at = item.updated_at;
            q::delete_body_edit(tx, seq, item.author_id.unwrap_or_default(), at)?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct Delete {
    repo: String,
    number: i64,
    /// From the newest, 0.
    revision: i64,
    #[serde(rename = "as")]
    login: Option<String>,
}

/// `POST /history/delete` on the control port.
pub(crate) async fn delete(
    State(fake): State<Fake>,
    axum::Json(d): axum::Json<Delete>,
) -> Response {
    let now = fake.now();
    let done = fake
        .state()
        .truth
        .write(move |tx| {
            let repo = match crate::edits::find_repo(tx, &d.repo)? {
                Ok(id) => id,
                Err(why) => return Ok(Err(why)),
            };
            let Some(id) = q::issue_id(tx, repo, d.number)? else {
                return Ok(Err(format!("no issue {}#{}", d.repo, d.number)));
            };
            let by = match d.login.as_deref() {
                Some(login) => q::account_by_login(tx, login)?.map(|a| a.id),
                None => q::accounts(tx)?.first().map(|a| a.id),
            };
            let Some(by) = by else {
                return Ok(Err("no such fixture account".into()));
            };
            let Some(seq) = q::nth_body_edit(tx, id, d.revision)? else {
                return Ok(Err(format!(
                    "{}#{} has {} revisions",
                    d.repo,
                    d.number,
                    q::body_edit_count(tx, id)?
                )));
            };
            q::delete_body_edit(tx, seq, by, now)?;
            Ok(Ok(()))
        })
        .await;
    match done {
        Ok(Ok(())) => axum::Json(json!({ "ok": true })).into_response(),
        Ok(Err(why)) => bad_request(why),
        Err(e) => api::internal(e),
    }
}
