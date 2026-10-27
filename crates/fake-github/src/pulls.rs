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

use crate::api::rfc3339;
use crate::events;
use crate::webhooks::{Delivery, envelope, issue_json};
use fake_db::q;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::BTreeSet;

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
    let branch = |name: Option<&str>| {
        let name = name.unwrap_or("main");
        json!({
            "label": format!("{}:{name}", r.owner),
            "ref": name,
            "sha": format!("{:040x}", (id as u64).wrapping_mul(0x9e37_79b9) ^ name.len() as u64),
            "repo": crate::webhooks::repo_json(&r),
        })
    };
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
        "head": branch(p.head_ref.as_deref()),
        "base": branch(p.base_ref.as_deref()),
        "author_association": issue["author_association"],
        "auto_merge": null,
        "active_lock_reason": null,
        "merged": p.merged_at.is_some(),
        "mergeable": null,
        "comments": i.comments_count,
        "review_comments": 0,
        "maintainer_can_modify": false,
        "commits": 1,
        "additions": 0,
        "deletions": 0,
        "changed_files": 0,
    }))
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
