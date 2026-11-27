//! Pull requests: what GitHub does for a PR that it doesn't for an issue.
//!
//! - A PR's own changes (its title, body, state and labels) send `pull_request` deliveries
//!   (`edited`, `closed`, `reopened`, `labeled`, `unlabeled`) carrying the PR as the pulls API
//!   serialises it ([`pr_json`]), never `issues` ones. Comments on it still send `issue_comment`.
//! - Its closing references (`closingIssuesReferences`, the mirror schema's `closes` edges) come
//!   from closing keywords in its body (`closes #12`, `fixes acme/web#3`, a link to the issue)
//!   and from links made in the Development sidebar. A body edit replaces the links its old body's
//!   keywords made with those of the new one; sidebar links stay ([`relink`]).
//! - A sidebar link or unlink (`add_linked_issue`/`remove_linked_issue` on an outside edit of
//!   the PR) sends no webhook: it records `connected` or `disconnected` in the feeds of both
//!   the PR and the issue (`events.rs`).
//! - A review (`review` on an outside edit: `approve`, `request_changes`, `comment`, or
//!   `dismiss` for the latest approval or request for changes) bumps its `updated_at`, sets its
//!   review decision as GitHub would ([`review`]: a null one stays null) and sends
//!   `pull_request_review` (`submitted`, or `dismissed`) for the review, on the PR's head commit.
//! - Its head, commits and changed files, which the PR view's analysis runs read through
//!   `GET /repos/{owner}/{repo}/pulls/{number}`, `…/files` and `…/commits` ([`router`]): a
//!   fixture PR derives them from its id (1 to 4 commits, 1 to 9 files), its head being the
//!   fixture's head SHA for it (`headRefOid` in GraphQL); a push on the control port (`POST
//!   /push`, [`push`]) adds a commit on top, moving the head and sending `pull_request`
//!   `synchronize`, and may say which files the PR changes from then on, and where its base
//!   branch's tip is (`base_sha`: `base.sha` only, as on GitHub, where main moving doesn't move
//!   the commit the PR's first one sits on). The PR view's recorded PR (`fixture::recorded`)
//!   starts at its v1 head, with v1's files and base, its first commit on that base
//!   ([`seed_recorded`]). A force push replaces the PR's history, so its old commits leave its
//!   commit list, and its new first commit sits on the base's tip, as after a rebase. The pulls API pages as GitHub's does (`per_page` up to 100,
//!   default 30, with `Link` headers), and stops at GitHub's caps: 3,000 files and 250 commits.
//!   A number that isn't a PR, or a repo the token can't see, is a 404.

use crate::Fake;
use crate::api::{self, AnyToken, rfc3339};
use crate::events;
use crate::repos::{Params, paged, visible_repo};
use crate::webhooks::{Delivery, envelope, issue_json};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fake_db::q;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Digest as _;
use std::collections::BTreeSet;

/// The most files GitHub lists for a PR (`GET …/pulls/{number}/files`: "Responses include a
/// maximum of 3000 files").
pub(crate) const MAX_FILES: i64 = 3_000;

/// The most commits GitHub lists for a PR (`GET …/pulls/{number}/commits`: "Lists a maximum of
/// 250 commits for a pull request").
pub(crate) const MAX_COMMITS: i64 = 250;

/// GitHub's closing keywords (`/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue`).
const KEYWORDS: [&str; 9] = [
    "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/// The PR as the pulls API and `pull_request` deliveries serialise it.
pub(crate) fn pr_json(c: &Connection, id: i64) -> rusqlite::Result<Value> {
    let issue = issue_json(c, id)?;
    let i = q::issue(c, id)?;
    let p = q::pr_details(c, id)?;
    let r = q::repo(c, i.repo_id)?;
    let full = format!("{}/{}", r.owner, r.name);
    let head = head(c, id)?;
    let totals = file_totals(c, id)?;
    let branch = |name: Option<&str>, sha: String| {
        let name = name.unwrap_or("main");
        json!({
            "label": format!("{}:{name}", r.owner),
            "ref": name,
            "sha": sha,
            "repo": crate::webhooks::repo_json(&r),
        })
    };
    let base_ref = p.base_ref.as_deref().unwrap_or("main");
    Ok(json!({
        "url": format!("https://api.github.com/repos/{full}/pulls/{}", i.number),
        "id": p.pr_id,
        "node_id": i.node_id,
        "html_url": format!("https://github.com/{full}/pull/{}", i.number),
        "diff_url": format!("https://github.com/{full}/pull/{}.diff", i.number),
        "patch_url": format!("https://github.com/{full}/pull/{}.patch", i.number),
        "issue_url": format!("https://api.github.com/repos/{full}/issues/{}", i.number),
        "number": i.number,
        "state": i.state,
        "locked": i.locked,
        "title": i.title,
        "user": issue["user"],
        "body": i.body,
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "closed_at": issue["closed_at"],
        "merged_at": p.merged_at.map(rfc3339),
        "merge_commit_sha": null,
        "assignee": issue["assignee"],
        "assignees": issue["assignees"],
        "requested_reviewers": [],
        "requested_teams": [],
        "labels": issue["labels"],
        "milestone": issue["milestone"],
        "draft": p.draft.unwrap_or(false),
        "head": branch(p.head_ref.as_deref(), head.sha.clone()),
        "base": branch(
            p.base_ref.as_deref(),
            head.base.clone().unwrap_or_else(|| base_sha(r.id, base_ref)),
        ),
        "author_association": issue["author_association"],
        "auto_merge": null,
        "active_lock_reason": null,
        "merged": p.merged_at.is_some(),
        "mergeable": null,
        "comments": i.comments_count,
        "review_comments": 0,
        "maintainer_can_modify": false,
        "commits": head.commits,
        "additions": totals.additions,
        "deletions": totals.deletions,
        "changed_files": totals.files,
    }))
}

/// 40 hex digits derived from `what`: a commit or blob SHA the fixture doesn't hold.
fn derived_sha(what: &str) -> String {
    let digest = sha2::Sha256::digest(what.as_bytes());
    digest.iter().take(20).map(|b| format!("{b:02x}")).collect()
}

/// The tip of branch `name` of repo `repo`: the same for every PR on that base.
fn base_sha(repo: i64, name: &str) -> String {
    derived_sha(&format!("branch {repo} {name}"))
}

/// The `k`th commit (1-based) of PR `id` when no push named its SHA, after `rewrites` force
/// pushes.
fn commit_sha(id: i64, rewrites: i64, k: i64) -> String {
    match rewrites {
        0 => derived_sha(&format!("commit {id} {k}")),
        r => derived_sha(&format!("commit {id} {k} r{r}")),
    }
}

/// How many commits fixture PR `id` has before any push: 1 to 4.
fn derived_commits(id: i64) -> i64 {
    1 + id.rem_euclid(4)
}

/// How many files fixture PR `id` changes before a push names its own: 1 to 9.
fn derived_files(id: i64) -> i64 {
    1 + id.rem_euclid(9)
}

/// A PR's head: its SHA, how many commits it has, whether its files are stored (a push named
/// them) or derive from its id, and how many force pushes rewrote its history.
pub(crate) struct Head {
    pub sha: String,
    pub commits: i64,
    files_set: bool,
    rewrites: i64,
    /// The base's tip, when the seed or a push named it rather than deriving it.
    base: Option<String>,
    /// The first commit's parent, when the seed or a force push put it on a base it named.
    first_parent: Option<String>,
}

/// PR `id`'s head. Before any push it's the fixture's head SHA for the PR (what the import reads
/// as `headRefOid`), or one derived from its id for a PR the fixture names none for.
pub(crate) fn head(c: &Connection, id: i64) -> rusqlite::Result<Head> {
    let base = derived_commits(id);
    Ok(match q::pull_head(c, id)? {
        Some(h) => Head {
            sha: h.head_sha,
            commits: base + h.pushes,
            files_set: h.files_set,
            rewrites: h.rewrites,
            base: h.base_sha,
            first_parent: h.first_parent,
        },
        None => Head {
            sha: match q::pr_details(c, id)?.head_sha {
                Some(sha) => sha,
                None => commit_sha(id, 0, base),
            },
            commits: base,
            files_set: false,
            rewrites: 0,
            base: None,
            first_parent: None,
        },
    })
}

/// The SHA of PR `id`'s `k`th commit (1-based) with `head` as its head: the head itself, a pushed
/// commit, the fixture's head while no force push replaced it, or one derived from the PR's id.
fn commit_at(c: &Connection, id: i64, head: &Head, k: i64) -> rusqlite::Result<String> {
    if k == head.commits {
        return Ok(head.sha.clone());
    }
    if let Some(sha) = q::pull_commit(c, id, k)? {
        return Ok(sha);
    }
    if head.rewrites == 0
        && k == derived_commits(id)
        && let Some(sha) = q::pr_details(c, id)?.head_sha
    {
        return Ok(sha);
    }
    Ok(commit_sha(id, head.rewrites, k))
}

/// One changed file, as the pulls API lists it.
pub(crate) struct File {
    pub filename: String,
    pub previous_filename: Option<String>,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
}

/// The `k`th (0-based) of a fixture PR's derived files: the first added, the rest modified.
fn derived_file(id: i64, k: i64) -> File {
    File {
        filename: format!("src/pr{id}/file{k}.rs"),
        previous_filename: None,
        status: if k == 0 { "added" } else { "modified" }.into(),
        additions: 3 + k * 2 + id.rem_euclid(5),
        deletions: if k == 0 { 0 } else { k.rem_euclid(3) },
    }
}

/// How many files the PR changes, and its lines added and removed, all told.
pub(crate) struct Totals {
    pub files: i64,
    pub additions: i64,
    pub deletions: i64,
}

fn file_totals(c: &Connection, id: i64) -> rusqlite::Result<Totals> {
    if head(c, id)?.files_set {
        let t = q::pull_file_totals(c, id)?;
        return Ok(Totals {
            files: t.files,
            additions: t.additions,
            deletions: t.deletions,
        });
    }
    let all: Vec<File> = (0..derived_files(id))
        .map(|k| derived_file(id, k))
        .collect();
    Ok(Totals {
        files: all.len() as i64,
        additions: all.iter().map(|f| f.additions).sum(),
        deletions: all.iter().map(|f| f.deletions).sum(),
    })
}

/// A page of the PR's files: `limit` from `offset`.
fn files_page(c: &Connection, id: i64, limit: i64, offset: i64) -> rusqlite::Result<Vec<File>> {
    if head(c, id)?.files_set {
        return Ok(q::pull_files(c, id, limit, offset)?
            .into_iter()
            .map(|f| File {
                filename: f.filename,
                previous_filename: f.previous_filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect());
    }
    let end = derived_files(id).min(offset + limit);
    Ok((offset..end).map(|k| derived_file(id, k)).collect())
}

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/repos/{owner}/{repo}/pulls/{number}", get(pull))
        .route("/repos/{owner}/{repo}/pulls/{number}/files", get(files))
        .route("/repos/{owner}/{repo}/pulls/{number}/commits", get(commits))
}

/// PR `number` of the visible repo `owner/name`: its item id, or GitHub's 404 (no such repo for
/// the token, or the number names an issue or nothing).
async fn find_pull(
    fake: &Fake,
    token: AnyToken,
    owner: String,
    name: String,
    number: i64,
) -> Result<i64, Response> {
    let repo = visible_repo(fake, token, owner, name).await?;
    let found = fake
        .state()
        .truth
        .read(move |c| {
            Ok(match q::any_item_id(c, repo, number)? {
                Some(id) if q::issue(c, id)?.kind == "pr" => Some(id),
                _ => None,
            })
        })
        .await
        .map_err(api::internal)?;
    match found {
        Some(id) => Ok(id),
        None => Err(api::not_found().await),
    }
}

/// `GET /repos/{owner}/{repo}/pulls/{number}`.
async fn pull(
    State(fake): State<Fake>,
    token: AnyToken,
    Path((owner, name, number)): Path<(String, String, i64)>,
) -> Response {
    let id = match find_pull(&fake, token, owner, name, number).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    match fake.state().truth.read(move |c| pr_json(c, id)).await {
        Ok(p) => axum::Json(p).into_response(),
        Err(e) => api::internal(e),
    }
}

/// `GET /repos/{owner}/{repo}/pulls/{number}/files`: at most [`MAX_FILES`], however many the PR
/// changes.
async fn files(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name, number)): Path<(String, String, i64)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/pulls/{number}/files");
    let id = match find_pull(&fake, token, owner.clone(), name.clone(), number).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let (offset, limit) = (p.offset(), p.per_page());
    let limit = limit.min(MAX_FILES - offset).max(0);
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let r = q::repo(c, q::issue(c, id)?.repo_id)?;
            let head = head(c, id)?.sha;
            Ok(files_page(c, id, limit, offset)?
                .into_iter()
                .map(|f| file_json(&r, &head, &f))
                .collect::<Vec<_>>())
        })
        .await;
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &[]),
        Err(e) => api::internal(e),
    }
}

/// A changed file as the pulls API lists it. `patch` is left out, as GitHub leaves it out of a
/// file too large or binary to diff.
fn file_json(r: &q::RepoRow, head: &str, f: &File) -> Value {
    let full = format!("{}/{}", r.owner, r.name);
    let mut v = json!({
        "sha": derived_sha(&format!("blob {head} {}", f.filename)),
        "filename": f.filename,
        "status": f.status,
        "additions": f.additions,
        "deletions": f.deletions,
        "changes": f.additions + f.deletions,
        "blob_url": format!("https://github.com/{full}/blob/{head}/{}", f.filename),
        "raw_url": format!("https://github.com/{full}/raw/{head}/{}", f.filename),
        "contents_url": format!("https://api.github.com/repos/{full}/contents/{}?ref={head}", f.filename),
    });
    if let Some(prev) = &f.previous_filename {
        v["previous_filename"] = json!(prev);
    }
    v
}

/// `GET /repos/{owner}/{repo}/pulls/{number}/commits`: oldest first, at most [`MAX_COMMITS`],
/// the last one the PR's head.
async fn commits(
    State(fake): State<Fake>,
    token: AnyToken,
    headers: HeaderMap,
    Path((owner, name, number)): Path<(String, String, i64)>,
    Query(p): Query<Params>,
) -> Response {
    let path = format!("/repos/{owner}/{name}/pulls/{number}/commits");
    let id = match find_pull(&fake, token, owner, name, number).await {
        Ok(id) => id,
        Err(r) => return r,
    };
    let (offset, per_page) = (p.offset(), p.per_page());
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let i = q::issue(c, id)?;
            let r = q::repo(c, i.repo_id)?;
            let head = head(c, id)?;
            let author = i
                .author_id
                .map(|a| q::user_row(c, a))
                .transpose()?
                .flatten();
            let base = q::pr_details(c, id)?
                .base_ref
                .unwrap_or_else(|| "main".into());
            let end = head.commits.min(MAX_COMMITS).min(offset + per_page);
            let mut out = Vec::new();
            for k in offset + 1..=end {
                let parent = if k == 1 {
                    head.first_parent
                        .clone()
                        .unwrap_or_else(|| base_sha(r.id, &base))
                } else {
                    commit_at(c, id, &head, k - 1)?
                };
                out.push(commit_json(
                    &r,
                    &commit_at(c, id, &head, k)?,
                    &parent,
                    author.as_ref(),
                    i.created_at.unwrap_or(0) + k * 60,
                    k,
                ));
            }
            Ok(out)
        })
        .await;
    match read {
        Ok(items) => paged(&headers, &path, &p, items, &[]),
        Err(e) => api::internal(e),
    }
}

/// A commit as the pulls API lists it: made by the PR's author, unsigned.
fn commit_json(
    r: &q::RepoRow,
    sha: &str,
    parent: &str,
    author: Option<&q::UserRowRow>,
    at: i64,
    k: i64,
) -> Value {
    let full = format!("{}/{}", r.owner, r.name);
    let api = format!("https://api.github.com/repos/{full}");
    let (name, user) = match author {
        Some(u) => (
            u.login.clone(),
            crate::webhooks::user_json(u.id, &u.login, u.avatar_url.as_deref()),
        ),
        None => ("ghost".to_owned(), Value::Null),
    };
    let person = json!({
        "name": name,
        "email": format!("{name}@users.noreply.github.com"),
        "date": rfc3339(at),
    });
    let tree = derived_sha(&format!("tree {sha}"));
    json!({
        "sha": sha,
        "node_id": format!("C_{sha}"),
        "commit": {
            "author": person,
            "committer": person,
            "message": format!("Commit {k}"),
            "tree": { "sha": tree, "url": format!("{api}/git/trees/{tree}") },
            "url": format!("{api}/git/commits/{sha}"),
            "comment_count": 0,
            "verification": {
                "verified": false,
                "reason": "unsigned",
                "signature": null,
                "payload": null,
                "verified_at": null,
            },
        },
        "url": format!("{api}/commits/{sha}"),
        "html_url": format!("https://github.com/{full}/commit/{sha}"),
        "comments_url": format!("{api}/commits/{sha}/comments"),
        "author": user,
        "committer": user,
        "parents": [{
            "sha": parent,
            "url": format!("{api}/commits/{parent}"),
            "html_url": format!("https://github.com/{full}/commit/{parent}"),
        }],
    })
}

/// The recorded PR at its v1 head, as its run pinned it: its head, its changed files and its
/// base's tip (its real merge base), so a run against it pins what the recording's run did.
pub(crate) fn seed_recorded(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    use fixture::recorded;
    let Ok(repo) = crate::edits::find_repo(tx, recorded::REPO)? else {
        // A fixture from before the recorded PR: nothing to seed.
        return Ok(());
    };
    for v in recorded::versions().iter().filter(|v| v.version == 1) {
        let Some(id) = q::any_item_id(tx, repo, i64::from(v.number))? else {
            continue;
        };
        q::set_pull_head(tx, id, v.head_sha(), 0, true, 0)?;
        q::set_pull_base(tx, id, Some(v.base_sha()))?;
        q::set_pull_first_parent(tx, id, Some(v.base_sha()))?;
        q::clear_pull_files(tx, id)?;
        for (k, (path, previous, status, additions, deletions)) in v.files().iter().enumerate() {
            q::add_pull_file(
                tx,
                id,
                k as i64,
                path,
                previous.as_deref(),
                status,
                *additions,
                *deletions,
            )?;
        }
    }
    Ok(())
}

/// `POST /push` on the control port: a push to a PR's head branch.
#[derive(Deserialize)]
pub(crate) struct Push {
    /// `owner/name`, or a name that is unique.
    repo: String,
    number: i64,
    /// The new head's SHA; derived when left out.
    sha: Option<String>,
    /// The base branch's tip from now on, as main moved meanwhile; left out, it stays. It moves
    /// `base.sha` only: the PR's first commit stays on what it was on, unless the push is a force
    /// push.
    base_sha: Option<String>,
    /// A force push: the PR's history is replaced by new commits (derived anew) under the new
    /// head, so none of its old commits is in its list any more, the first of them on the base's
    /// tip (after `base_sha`), as a rebase onto it puts it.
    #[serde(default)]
    force: bool,
    /// The files the PR changes from now on, in order; left out, they stay as they were.
    files: Option<Vec<PushedFile>>,
    /// Or this many generated files (`src/pushed/file{k}.rs`, one line added each), for a PR
    /// past GitHub's 3,000-file cap.
    file_count: Option<i64>,
    /// How many commits the push brings (one by default), the last being the new head: one
    /// `synchronize` for them all, as for a push of several. For a PR past GitHub's 250-commit
    /// list.
    commits: Option<i64>,
    /// Who pushed: a fixture account's login. Left out, the PR's author, or the fixture's first
    /// account for a PR whose author is gone.
    login: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PushedFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
    additions: i64,
    deletions: i64,
}

/// Adds a commit on top of the PR, as a push to its head branch does: its head moves to the new
/// commit, its `updated_at` to now, and its files are those the push names. A force push
/// replaces its history first. GitHub sends `pull_request` `synchronize`, with the head before
/// and after (`/webhooks/webhook-events-and-payloads#pull_request`), from the pusher: `login`,
/// else the PR's author, else the fixture's first account.
/// Answers the PR's new head and counts, and the delivery.
pub(crate) fn push(
    tx: &rusqlite::Transaction,
    p: &Push,
    at: i64,
) -> rusqlite::Result<Result<(Value, Delivery), String>> {
    let repo = match crate::edits::find_repo(tx, &p.repo)? {
        Ok(r) => r,
        Err(why) => return Ok(Err(why)),
    };
    let id = match q::any_item_id(tx, repo, p.number)? {
        Some(id) if q::issue(tx, id)?.kind == "pr" => id,
        _ => return Ok(Err(format!("{}#{} isn't a PR", p.repo, p.number))),
    };
    let brought = p.commits.unwrap_or(1);
    if brought < 1 {
        return Ok(Err("commits must be at least 1".into()));
    }
    let before = head(tx, id)?;
    let (rewrites, pushes) = match p.force {
        true => (before.rewrites + 1, brought),
        false => (
            before.rewrites,
            before.commits - derived_commits(id) + brought,
        ),
    };
    let k = derived_commits(id) + pushes;
    let sha = p.sha.clone().unwrap_or_else(|| commit_sha(id, rewrites, k));
    let hex = |s: &str| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex(&sha) {
        return Ok(Err("sha must be 40 hex digits".into()));
    }
    if p.base_sha.as_deref().is_some_and(|b| !hex(b)) {
        return Ok(Err("base_sha must be 40 hex digits".into()));
    }
    let files: Option<Vec<File>> = match (&p.files, p.file_count) {
        (Some(_), Some(_)) => return Ok(Err("give files or file_count, not both".into())),
        (Some(list), None) => Some(
            list.iter()
                .map(|f| File {
                    filename: f.filename.clone(),
                    previous_filename: f.previous_filename.clone(),
                    status: f.status.clone(),
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
        ),
        (None, Some(n)) => Some(
            (0..n.max(0))
                .map(|k| File {
                    filename: format!("src/pushed/file{k}.rs"),
                    previous_filename: None,
                    status: "modified".into(),
                    additions: 1,
                    deletions: 0,
                })
                .collect(),
        ),
        (None, None) => None,
    };
    let files_set = before.files_set || files.is_some();
    if let Some(files) = files {
        // A PR whose files derived from its id keeps none of them: the push names them all.
        q::clear_pull_files(tx, id)?;
        for (k, f) in files.iter().enumerate() {
            q::add_pull_file(
                tx,
                id,
                k as i64,
                &f.filename,
                f.previous_filename.as_deref(),
                &f.status,
                f.additions,
                f.deletions,
            )?;
        }
    }
    if p.force {
        q::clear_pull_commits(tx, id)?;
    }
    q::add_pull_commit(tx, id, k, &sha)?;
    q::set_pull_head(tx, id, &sha, pushes, files_set, rewrites)?;
    if let Some(b) = p.base_sha.as_deref() {
        q::set_pull_base(tx, id, Some(b))?;
    }
    if p.force {
        // The new history sits on the base's tip (NULL: the derived one).
        let tip = p.base_sha.as_deref().or(before.base.as_deref());
        q::set_pull_first_parent(tx, id, tip)?;
    }
    q::touch_pull(tx, id, at)?;
    let after = head(tx, id)?;
    let totals = file_totals(tx, id)?;
    let i = q::issue(tx, id)?;
    let r = q::repo(tx, i.repo_id)?;
    // GitHub always names who pushed.
    let pusher = match p.login.as_deref() {
        Some(login) => match q::account_by_login(tx, login)? {
            Some(a) => q::user_row(tx, a.id)?,
            None => return Ok(Err(format!("{login} isn't a fixture account"))),
        },
        None => match i
            .author_id
            .map(|a| q::user_row(tx, a))
            .transpose()?
            .flatten()
        {
            Some(u) => Some(u),
            None => match q::accounts(tx)?.first() {
                Some(a) => q::user_row(tx, a.id)?,
                None => None,
            },
        },
    };
    let Some(u) = pusher else {
        return Ok(Err("no fixture user to push as".into()));
    };
    let sender = crate::webhooks::user_json(u.id, &u.login, u.avatar_url.as_deref());
    let mut d = envelope(&r, &sender);
    d["action"] = json!("synchronize");
    d["number"] = json!(i.number);
    d["before"] = json!(before.sha);
    d["after"] = json!(after.sha);
    d["pull_request"] = pr_json(tx, id)?;
    Ok(Ok((
        json!({
            "head": after.sha,
            "commits": after.commits,
            "changed_files": totals.files,
            "additions": totals.additions,
            "deletions": totals.deletions,
        }),
        Delivery::new("pull_request", d),
    )))
}

/// The issues `body`'s closing keywords name, in the PR's repo `repo` or another: `#12`,
/// `owner/repo#12`, or a link to the issue on GitHub. A reference to nothing GitHub has (or to a
/// PR) closes nothing.
pub(crate) fn keyword_targets(
    c: &Connection,
    repo: i64,
    body: Option<&str>,
) -> rusqlite::Result<BTreeSet<i64>> {
    let mut out = BTreeSet::new();
    let Some(body) = body else { return Ok(out) };
    let words: Vec<&str> = body.split_whitespace().collect();
    for pair in words.windows(2) {
        let keyword = pair[0].trim_end_matches(':').to_lowercase();
        if !KEYWORDS.contains(&keyword.as_str()) {
            continue;
        }
        let target = pair[1].trim_end_matches(['.', ',', ';', ')', ':']);
        let Some((owner_repo, number)) = reference(target) else {
            continue;
        };
        let repo = match owner_repo {
            None => Some(repo),
            Some((owner, name)) => q::any_repo_by_full_name(c, owner, name)?,
        };
        if let Some(repo) = repo
            && let Some(id) = q::any_issue_id(c, repo, number)?
        {
            out.insert(id);
        }
    }
    Ok(out)
}

/// `#12`, `owner/repo#12` or `https://github.com/owner/repo/issues/12`: the repo, if named, and
/// the number.
fn reference(s: &str) -> Option<(Option<(&str, &str)>, i64)> {
    if let Some(rest) = s.strip_prefix("https://github.com/") {
        let mut parts = rest.split('/');
        let (owner, name, kind, n) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        if kind != "issues" {
            return None;
        }
        return Some((Some((owner, name)), n.parse().ok()?));
    }
    let (repo, n) = s.split_once('#')?;
    let n = n.parse().ok()?;
    if repo.is_empty() {
        return Some((None, n));
    }
    let (owner, name) = repo.split_once('/')?;
    Some((Some((owner, name)), n))
}

/// After PR `id`'s body changed from `before` to `after`: the links `before`'s keywords made go,
/// and `after`'s come. A link the sidebar made (or one both bodies name) stays.
pub(crate) fn relink(
    c: &Connection,
    id: i64,
    repo: i64,
    before: Option<&str>,
    after: Option<&str>,
) -> rusqlite::Result<()> {
    let (old, new) = (
        keyword_targets(c, repo, before)?,
        keyword_targets(c, repo, after)?,
    );
    for gone in old.difference(&new) {
        q::remove_closes(c, id, *gone)?;
    }
    for issue in new {
        q::add_closes(c, id, issue)?;
    }
    Ok(())
}

/// A Development-sidebar link between PR `pr` and issue `issue` (`add`), or its removal: no
/// webhook, a `connected` (or `disconnected`) event on each. Nothing happens, and nothing is
/// recorded, for a link that's already there (or a removal of one that isn't).
pub(crate) fn sidebar(
    c: &Connection,
    pr: i64,
    issue: i64,
    add: bool,
    actor: i64,
    at: i64,
) -> rusqlite::Result<()> {
    let held = q::closes(c, pr)?.contains(&issue);
    if held == add {
        return Ok(());
    }
    let event = if add {
        q::add_closes(c, pr, issue)?;
        "connected"
    } else {
        q::remove_closes(c, pr, issue)?;
        "disconnected"
    };
    events::record(c, pr, event, Some(actor), None, at)?;
    events::record(c, issue, event, Some(actor), None, at)
}

/// A review of PR `id` by `sender` (`approve`, `request_changes`, `comment` or `dismiss`): its
/// review decision afterwards, and the `pull_request_review` delivery. `None` for another kind,
/// or a dismissal with no approval or request for changes to dismiss.
///
/// GitHub's `reviewDecision` is null on a PR whose base branch requires no reviews, and stays so
/// whatever reviews come; where reviews are required it's what the reviewers' latest standing
/// reviews say (changes requested over approved), or `REVIEW_REQUIRED` with none. The fake reads
/// a fixture PR's null decision as the first kind, and recomputes the second from the reviews it
/// recorded (`fake_reviews`). A dismissal dismisses the PR's latest approval or request for
/// changes, by anyone, and its delivery carries that review.
pub(crate) fn review(
    c: &Connection,
    repo: &q::RepoRow,
    id: i64,
    kind: &str,
    sender: i64,
    at: i64,
) -> rusqlite::Result<Option<Delivery>> {
    let before = q::issue(c, id)?;
    let held = q::pr_details(c, id)?.review_decision;
    // GitHub's clock only moves forward.
    let at = at.max(before.updated_at.unwrap_or(0));
    let pull = pr_json(c, id)?;
    let head = pull["head"]["sha"].as_str().unwrap_or_default().to_owned();
    let (review_id, author, state, commit, submitted) = match kind {
        "approve" | "request_changes" | "comment" => {
            let state = match kind {
                "approve" => "approved",
                "request_changes" => "changes_requested",
                _ => "commented",
            };
            let review = q::add_review(c, id, sender, state, &head, at)?;
            (review, sender, state, head, at)
        }
        "dismiss" => {
            let Some(r) = q::last_dismissable_review(c, id)? else {
                return Ok(None);
            };
            q::dismiss_review(c, r.id)?;
            // The dismissed review still names the commit it was made on.
            (r.id, r.user_id, "dismissed", r.commit_id, r.submitted_at)
        }
        _ => return Ok(None),
    };
    let decision = match held {
        None => None,
        Some(_) if state == "commented" => held.clone(),
        Some(_) => {
            let standing = q::standing_reviews(c, id)?;
            Some(if standing.iter().any(|s| s == "changes_requested") {
                "changes_requested".to_owned()
            } else if standing.iter().any(|s| s == "approved") {
                "approved".to_owned()
            } else {
                "review_required".to_owned()
            })
        }
    };
    q::set_review_decision(c, id, decision.as_deref(), at)?;
    let review_id = 80_000_000 + review_id;
    let full = format!("{}/{}", repo.owner, repo.name);
    let user = |uid: i64| -> rusqlite::Result<Value> {
        Ok(match q::user_row(c, uid)? {
            Some(u) => crate::webhooks::user_json(u.id, &u.login, u.avatar_url.as_deref()),
            None => Value::Null,
        })
    };
    let mut p = envelope(repo, &user(sender)?);
    p["action"] = json!(if kind == "dismiss" {
        "dismissed"
    } else {
        "submitted"
    });
    p["review"] = json!({
        "id": review_id,
        "node_id": format!("PRR_kw{review_id}"),
        "user": user(author)?,
        "body": null,
        "commit_id": commit,
        "submitted_at": rfc3339(submitted),
        "state": state,
        "html_url": format!("https://github.com/{full}/pull/{}#pullrequestreview-{review_id}", before.number),
        "pull_request_url": format!("https://api.github.com/repos/{full}/pulls/{}", before.number),
        "author_association": crate::webhooks::author_association(c, repo, Some(author))?,
    });
    p["pull_request"] = pull;
    Ok(Some(Delivery::new("pull_request_review", p)))
}
