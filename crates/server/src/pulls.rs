//! The PR read-back: a PR's own fields and the issues it closes (its linked PRs, from
//! `closingIssuesReferences`), read from GitHub and written to every account syncing its repo.
//!
//! GitHub sends `pull_request` for a PR's own changes (never `issues`), `pull_request_review` for
//! a review (whose decision no payload carries), and nothing at all for a link made in the
//! Development sidebar, which only the repo's issue events feed shows (`feed.rs`: `connected` and
//! `disconnected`). Each of them reads the PR back at once, through the relationship read-backs'
//! scheduler (`edges.rs`: one at a time per PR, retried as they are, given up by marking the
//! accounts syncing the repo for resync). A PR is named by its repo and number, which every one
//! of those signals carries: a `pull_request` delivery has the PR's own id, not the issue-side
//! id the mirror keys items on, so the read starts from REST's issue (which has it), then
//! GraphQL's PR (`PullReadBack`, its closing references paged 50 at a time).
//!
//! What it read replaces what the mirror holds: the PR's row under the webhooks' `updated_at`
//! guard (newer or equal wins), and its `closes` edges as a set, under the relationship
//! read-backs' rules (an issue in a repo the account doesn't sync is kept only if the account
//! may see it, as a stub). It reads with the installation's token, narrowed to what the import
//! reads (PRs need Pull requests: read).

use crate::edges::{self, Failure, Inner, Kind, Nodes, PageInfo, Subject};
use crate::github::CallError;
use crate::import::shapes::RestIssue;
use crate::import::writes::{ItemData, PrData, write_item};
use crate::installations::Scope;
use crate::live::Push;
use crate::webhook::{self, parse_time};
use mirror_db::{Caller, q};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

/// Past this many ids, a push is a `reset` (as for webhooks).
const MAX_IDS: usize = 256;

/// The most pages of closing references one read-back follows: 5,000 issues.
const MAX_PAGES: usize = 100;

/// The PR a read-back reads: its repo (`owner/name`), its number, and the installation whose
/// token reads it.
#[derive(Clone, Debug)]
pub struct Pull {
    pub repo: i64,
    pub owner: String,
    pub name: String,
    pub number: i64,
    pub installation: i64,
}

/// `PullReadBack`: the PR's own fields and a page of the issues it closes.
const QUERY: &str = concat!(
    "query PullReadBack($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      id databaseId isDraft mergedAt headRefName baseRefName reviewDecision
      closingIssuesReferences(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...End }
      }
    }
  }
}",
    edges::end_fragment!()
);

#[derive(Deserialize)]
struct Data {
    node: Option<Node>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    database_id: Option<i64>,
    #[serde(default)]
    is_draft: bool,
    merged_at: Option<String>,
    head_ref_name: Option<String>,
    base_ref_name: Option<String>,
    review_decision: Option<String>,
    closing_issues_references: Option<Nodes>,
}

/// What a read-back read: the PR, and the issues it closes as `(pr, issue, issue)` edges
/// (`None` when GitHub left `closingIssuesReferences` null: unknown, so the links stay).
struct Read {
    item: ItemData,
    closes: Option<edges::Fetched>,
}

/// Reads PR `p` back and writes it to every account syncing its repo.
pub(crate) async fn refetch(inner: &Inner, p: &Pull) -> Result<(), Failure> {
    let Some(read) = read(inner, p).await? else {
        return Ok(());
    };
    let repo = p.repo;
    let targets = inner
        .control
        .read(move |c| control_db::q::fan_out_targets(c, repo))
        .await
        .map_err(|e| Failure::Retry(format!("reading who syncs repo {repo} failed: {e}")))?;
    let read = Arc::new(read);
    for account in targets {
        let synced: HashSet<i64> = match inner
            .control
            .read(move |c| control_db::q::synced_repo_ids(c, account))
            .await
        {
            Ok(ids) => ids.into_iter().collect(),
            Err(e) => {
                eprintln!("pulls: reading account {account}'s repos failed: {e}");
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
                continue;
            }
        };
        let (installation, r) = (p.installation, read.clone());
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                if !crate::import::synced(tx, repo)? {
                    return Ok(Vec::new());
                }
                let id = r.item.id;
                let mut ids = BTreeSet::new();
                if write_item(tx, seq, repo, &r.item)? {
                    ids.extend(edges::with_neighbours(tx, BTreeSet::from([id]))?);
                }
                let Some(closes) = &r.closes else {
                    return Ok(ids.into_iter().collect::<Vec<i64>>());
                };
                let replaced =
                    edges::replace(tx, seq, Kind::Closes, installation, id, closes, &synced)?;
                // Newer than what a sweep under way read of the PR and of every issue whose
                // linked PRs this changed.
                q::touch_edges(tx, id, seq)?;
                for &end in &replaced.touched {
                    q::touch_edges(tx, end, seq)?;
                }
                ids.extend(replaced.ids);
                Ok(ids.into_iter().collect::<Vec<i64>>())
            })
            .await;
        match written {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) if ids.len() > MAX_IDS => inner.hub.publish(account, Push::Reset),
            Ok(ids) => inner.hub.publish(account, Push::Ids(ids.into())),
            Err(e) => {
                eprintln!(
                    "pulls: writing PR {}/{}#{} failed for account {account}: {e}",
                    p.owner, p.name, p.number
                );
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
            }
        }
    }
    Ok(())
}

/// Reads PR `p` with the installation's token: `None` when GitHub shows the token no such PR
/// (a number that's an issue, or a repo out of its sight).
async fn read(inner: &Inner, p: &Pull) -> Result<Option<Read>, Failure> {
    let _turn = inner.installations.read_turn(p.installation).await;
    let token = match inner
        .installations
        .token(p.installation, Scope::Import)
        .await
    {
        Ok(t) => t,
        // The installation is gone (GitHub answers 404 for its token): no try will do better.
        Err(crate::github::Error::Status(404)) => {
            return Err(Failure::GiveUp(format!(
                "installation {} is gone",
                p.installation
            )));
        }
        Err(e) => return Err(edges::failure(e.into())),
    };
    let gh = inner.installations.github();
    let failed = |e: CallError| refused(inner, p.installation, Scope::Import, &token, e);
    let path = format!("/repos/{}/{}/issues/{}", p.owner, p.name, p.number);
    let issue: RestIssue = match gh.rest(&token, &path).await {
        Ok(v) => serde_json::from_value(v).map_err(|e| Failure::Retry(format!("{path}: {e}")))?,
        Err(CallError::NotFound) => return Ok(None),
        Err(e) => return Err(failed(e)),
    };
    if issue.pull_request.is_none() {
        return Ok(None);
    }
    let mut item = ItemData::from_rest(&issue);
    let me = item.id;
    let mut after: Option<String> = None;
    let mut edges = Vec::new();
    for page in 0.. {
        let vars = json!({ "id": issue.node_id, "after": after });
        let data: Data = gh
            .graphql(&token, "PullReadBack", QUERY, vars)
            .await
            .map_err(|e| failed(e.into()))?;
        let Some(node) = data.node else {
            return Ok(None);
        };
        if page == 0 {
            let Some(pr_id) = node.database_id else {
                return Ok(None);
            };
            item.pr = Some(PrData {
                pr_id,
                draft: node.is_draft,
                merged_at: node.merged_at.as_deref().and_then(parse_time),
                head_ref: node.head_ref_name.clone(),
                base_ref: node.base_ref_name.clone(),
                review_decision: node.review_decision.as_deref().map(str::to_lowercase),
            });
        }
        let Some(refs) = node.closing_issues_references else {
            return Ok(Some(Read { item, closes: None }));
        };
        edges.extend(
            refs.nodes
                .into_iter()
                .flatten()
                .map(|e| (me, e.database_id, e)),
        );
        match refs.page_info {
            Some(PageInfo {
                has_next_page: true,
                end_cursor: Some(next),
            }) if page + 1 < MAX_PAGES => after = Some(next),
            Some(PageInfo {
                has_next_page: true,
                ..
            }) => {
                return Err(Failure::GiveUp(format!(
                    "PR {}/{}#{} closes more issues than a read-back follows",
                    p.owner, p.name, p.number
                )));
            }
            _ => break,
        }
    }
    Ok(Some(Read {
        item,
        closes: Some(edges::Fetched { edges }),
    }))
}

/// A call GitHub failed, as a read-back's failure (see [`edges::failure`]): a token GitHub
/// refused is dropped first, so the next try mints another.
fn refused(inner: &Inner, installation: i64, scope: Scope, token: &str, e: CallError) -> Failure {
    if matches!(e, CallError::Unauthorized) {
        inner.installations.drop_token(installation, scope, token);
    }
    edges::failure(e)
}

/// `IssueLinkedPulls`: a page of the PRs that close an issue, wherever they live, open or not.
/// A PR's GraphQL id isn't the issue-side id the mirror keys items on, so each is named by its
/// repository and number.
const LINKED_QUERY: &str = "query IssueLinkedPulls($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue {
      closedByPullRequestsReferences(first: 50, after: $after, includeClosedPrs: true) {
        pageInfo { hasNextPage endCursor }
        nodes { number repository { databaseId id name owner { login } isPrivate } }
      }
    }
  }
}";

#[derive(Deserialize)]
struct LinkedData {
    node: Option<LinkedNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedNode {
    closed_by_pull_requests_references: Option<LinkedPage>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LinkedPage {
    #[serde(default)]
    nodes: Vec<Option<LinkedPull>>,
    page_info: Option<PageInfo>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LinkedPull {
    number: i64,
    repository: LinkedRepo,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LinkedRepo {
    database_id: i64,
    id: String,
    name: String,
    owner: edges::Owner,
    is_private: bool,
}

/// A linked PR outside the synced repos, as a stub holds it.
struct Outside {
    repo: LinkedRepo,
    issue: RestIssue,
}

/// Reads issue `s`'s linked PRs from GitHub's side of the issue (`IssueLinkedPulls`) and, for
/// every account syncing its repo, replaces the ones in repos that account doesn't sync (stubs,
/// under the isolation rule) with them. A sidebar link to a PR in such a repo sends no webhook,
/// and the PR's own feed isn't polled: the issue's feed event (`feed.rs`) is all that shows it.
/// A PR in a repo the account syncs is the PR read-back's, from its own repo's feed, and left as
/// it is. Each stub PR's issue-side id comes from REST (`GET …/issues/{n}`), which also tells
/// whether the token still sees it.
pub(crate) async fn refetch_linked(inner: &Inner, s: &Subject) -> Result<(), Failure> {
    let repo = s.repo;
    let targets = inner
        .control
        .read(move |c| control_db::q::fan_out_targets(c, repo))
        .await
        .map_err(|e| Failure::Retry(format!("reading who syncs repo {repo} failed: {e}")))?;
    let mut synced_by_all: Option<HashSet<i64>> = None;
    for &account in &targets {
        let ids: HashSet<i64> = inner
            .control
            .read(move |c| control_db::q::synced_repo_ids(c, account))
            .await
            .map_err(|e| Failure::Retry(format!("reading account {account}'s repos: {e}")))?
            .into_iter()
            .collect();
        synced_by_all = Some(match synced_by_all {
            None => ids,
            Some(all) => all.intersection(&ids).copied().collect(),
        });
    }
    let Some(synced_by_all) = synced_by_all else {
        return Ok(());
    };
    let outside = {
        let _turn = inner.installations.read_turn(s.installation).await;
        let token = edges::token(inner, s).await?;
        let gh = inner.installations.github();
        let failed = |e: CallError| refused(inner, s.installation, Scope::ReadBack, &token, e);
        let mut pulls = Vec::new();
        let mut after: Option<String> = None;
        for page in 0.. {
            let vars = json!({ "id": s.node_id, "after": after });
            let data: LinkedData = gh
                .graphql(&token, "IssueLinkedPulls", LINKED_QUERY, vars)
                .await
                .map_err(|e| failed(e.into()))?;
            // Gone or out of sight: the issue's own read-backs settle that.
            let Some(node) = data.node else { return Ok(()) };
            let refs = node.closed_by_pull_requests_references.unwrap_or_default();
            pulls.extend(refs.nodes.into_iter().flatten());
            match refs.page_info {
                Some(PageInfo {
                    has_next_page: true,
                    end_cursor: Some(next),
                }) if page + 1 < MAX_PAGES => after = Some(next),
                Some(PageInfo {
                    has_next_page: true,
                    ..
                }) => {
                    return Err(Failure::GiveUp(format!(
                        "issue {} has more linked PRs than a read-back follows",
                        s.id
                    )));
                }
                _ => break,
            }
        }
        let mut outside = Vec::new();
        for p in pulls {
            if synced_by_all.contains(&p.repository.database_id) {
                continue;
            }
            let path = format!(
                "/repos/{}/{}/issues/{}",
                p.repository.owner.login, p.repository.name, p.number
            );
            match gh.rest(&token, &path).await {
                Ok(v) => {
                    let issue: RestIssue = serde_json::from_value(v)
                        .map_err(|e| Failure::Retry(format!("{path}: {e}")))?;
                    if issue.pull_request.is_some() {
                        outside.push(Outside {
                            repo: p.repository,
                            issue,
                        });
                    }
                }
                Err(CallError::NotFound) => {}
                Err(e) => return Err(failed(e)),
            }
        }
        Arc::new(outside)
    };
    for account in targets {
        let (id, installation, outside) = (s.id, s.installation, outside.clone());
        let written = inner
            .mirrors
            .write(account, Caller::Webhook, move |tx, seq| {
                if !crate::import::synced(tx, repo)? {
                    return Ok(Vec::new());
                }
                replace_outside(tx, seq, id, installation, &outside)
            })
            .await;
        match written {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) if ids.len() > MAX_IDS => inner.hub.publish(account, Push::Reset),
            Ok(ids) => inner.hub.publish(account, Push::Ids(ids.into())),
            Err(e) => {
                eprintln!(
                    "pulls: writing issue {}'s linked PRs failed for account {account}: {e}",
                    s.id
                );
                webhook::mark_for_resync(&inner.control, &inner.hub, account).await;
            }
        }
    }
    Ok(())
}

/// Replaces issue `id`'s linked PRs from repos this account doesn't sync with `outside` (read
/// with `installation`'s token), each kept only if the account may see its repo, as a stub. One
/// held from a private repo of another installation, which that token can't see, stays. The
/// items whose rows or detail changed.
fn replace_outside(
    tx: &rusqlite::Transaction,
    seq: i64,
    id: i64,
    installation: i64,
    outside: &[Outside],
) -> rusqlite::Result<Vec<i64>> {
    let held: Vec<i64> = q::edges_of(tx, "closes", id)?
        .into_iter()
        .filter(|e| e.dst_id == id)
        .map(|e| e.src_id)
        .collect();
    let held: HashMap<i64, q::ItemReposRow> = q::item_repos(tx, &held)?
        .into_iter()
        .filter(|r| !r.synced)
        .map(|r| (r.id, r))
        .collect();
    let mut keep = HashSet::new();
    let mut changed = BTreeSet::new();
    for o in outside {
        let (r, i) = (&o.repo, &o.issue);
        let state = q::repo_state(tx, r.database_id)?;
        if state.as_ref().is_some_and(|st| st.synced) {
            continue;
        }
        let visible = state.is_some_and(|st| st.installation_id.is_some());
        if r.is_private && !visible {
            continue;
        }
        keep.insert(i.id);
        q::upsert_stub_repo(
            tx,
            r.database_id,
            &r.id,
            &r.owner.login,
            &r.name,
            r.is_private,
        )?;
        let open = if i.state.eq_ignore_ascii_case("open") {
            "open"
        } else {
            "closed"
        };
        let mut wrote = q::upsert_stub(
            tx,
            i.id,
            &i.node_id,
            r.database_id,
            i.number,
            "pr",
            &i.title,
            open,
            seq,
        )? > 0;
        wrote |= q::set_stub_place(tx, i.id, r.database_id, i.number, seq)? > 0;
        wrote |= q::add_edge(tx, "closes", i.id, id, seq)? > 0;
        if wrote {
            changed.insert(i.id);
        }
    }
    for (pr, r) in &held {
        let unseen = r.private && r.installation_id.is_some_and(|i| i != installation);
        if keep.contains(pr) || unseen {
            continue;
        }
        if q::remove_edge(tx, "closes", *pr, id)? > 0 {
            changed.insert(*pr);
        }
    }
    let ends: Vec<i64> = held.keys().copied().chain(keep.iter().copied()).collect();
    q::prune_stubs(tx, &ends)?;
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    q::touch_edges(tx, id, seq)?;
    for &pr in &changed {
        q::touch_edges(tx, pr, seq)?;
    }
    changed.insert(id);
    edges::with_neighbours(tx, changed)
}
