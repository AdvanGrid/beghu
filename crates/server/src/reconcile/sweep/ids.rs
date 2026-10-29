//! The 15-minute count check, and the id sweep that follows a mismatch: what the mirrors hold
//! that GitHub's cursor-paged id lists don't is removed.

use super::*;

impl Sweeper {
    /// The count check: the repos (of `ts`) whose issue or PR count on GitHub differs from what a
    /// mirror holds, with the counts that differ.
    pub async fn counts(&self, ts: &[&Target]) -> Result<HashMap<i64, Counts>, Stop> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Counted {
            database_id: i64,
            issues: crate::import::shapes::Count,
            pull_requests: crate::import::shapes::Count,
        }
        let mut out = HashMap::new();
        for chunk in ts.chunks(PAGE) {
            let ids: Vec<&str> = chunk.iter().map(|t| t.node_id.as_str()).collect();
            let data = self
                .graphql("SweepCounts", SWEEP_COUNTS, json!({ "ids": ids }))
                .await?;
            let nodes: Vec<Option<Counted>> =
                serde_json::from_value(data["nodes"].clone()).map_err(malformed)?;
            for n in nodes.into_iter().flatten() {
                let Some(t) = chunk.iter().find(|t| t.id == n.database_id) else {
                    continue;
                };
                for &a in &t.accounts {
                    let id = t.id;
                    let held = self
                        .app
                        .mirrors()
                        .read(a, Caller::Sweep, move |c| {
                            Ok(if swept(c, id)? {
                                Some(q::item_counts(c, id)?)
                            } else {
                                None
                            })
                        })
                        .await;
                    if let Ok(Some(h)) = held
                        && (h.issues != n.issues.total_count
                            || h.prs != n.pull_requests.total_count)
                    {
                        out.insert(
                            t.id,
                            Counts {
                                issues: n.issues.total_count,
                                prs: n.pull_requests.total_count,
                                held_issues: h.issues,
                                held_prs: h.prs,
                            },
                        );
                        break;
                    }
                }
            }
        }
        Ok(out)
    }

    /// Every database id GitHub has of the repo's issues, or of its PRs (`op`).
    pub(super) async fn ids(
        &self,
        t: &Target,
        op: &'static str,
        query: &'static str,
        field: &str,
    ) -> Result<HashSet<i64>, Stop> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Id {
            database_id: Option<i64>,
        }
        let mut out = HashSet::new();
        let mut after: Option<String> = None;
        loop {
            let data = self
                .graphql(
                    op,
                    query,
                    json!({ "owner": t.owner, "name": t.name, "after": after }),
                )
                .await?;
            let conn = &data["repository"][field];
            if conn.is_null() {
                return Err(Stop::Failed(Error::NoRepo(t.full_name())));
            }
            let page: Conn<Id> = serde_json::from_value(conn.clone()).map_err(malformed)?;
            out.extend(
                page.nodes
                    .into_iter()
                    .flatten()
                    .filter_map(|n| n.database_id),
            );
            match page.page_info {
                Some(p) if p.has_next_page && p.end_cursor.is_some() => after = p.end_cursor,
                _ => return Ok(out),
            }
        }
    }

    /// The id sweep after a count mismatch: deletes what GitHub no longer has (a transfer out, a
    /// deletion, a conversion to a discussion). A mirror that lacks what GitHub has gets a full
    /// sweep of the repo.
    pub async fn id_sweep(&self, t: &Target) -> Result<(), Stop> {
        let seqs = self.seqs(t).await;
        let (_, lacking) = self.delete_absent(t, &seqs).await?;
        if lacking {
            eprintln!(
                "reconcile: {}: a mirror lacks issues GitHub has; sweeping it whole",
                t.full_name()
            );
            self.reconcile().ask_full(&[t.id], None);
        }
        Ok(())
    }

    /// Reads every database id GitHub has of the repo's issues and PRs, paged by cursor in
    /// creation order (which no update moves), and removes from each account's mirror what isn't
    /// there, unless a write since `seqs` (each account's last transaction before the sweep
    /// began) touched it. Not recorded as deleted: inferred from absence, it never keeps a later
    /// delivery out. The accounts with misses, and whether a mirror lacks something GitHub has.
    pub(super) async fn delete_absent(
        &self,
        t: &Target,
        seqs: &HashMap<i64, i64>,
    ) -> Result<(HashSet<i64>, bool), Stop> {
        let issues = self
            .ids(t, "SweepIssueIds", SWEEP_ISSUE_IDS, "issues")
            .await?;
        let prs = self
            .ids(t, "SweepPullIds", SWEEP_PULL_IDS, "pullRequests")
            .await?;
        let mut lacking = false;
        for &a in &t.accounts {
            let id = t.id;
            if let Ok(Some(rows)) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| {
                    Ok(if swept(c, id)? {
                        Some(q::repo_item_ids(c, id)?)
                    } else {
                        None
                    })
                })
                .await
            {
                let held: HashSet<i64> = rows
                    .iter()
                    .map(|r| {
                        if r.kind == "pr" {
                            r.pr_id.unwrap_or(r.id)
                        } else {
                            r.id
                        }
                    })
                    .collect();
                lacking |= issues.iter().chain(prs.iter()).any(|i| !held.contains(i));
            }
        }
        let (issues, prs, seqs) = (Arc::new(issues), Arc::new(prs), Arc::new(seqs.clone()));
        let repo = t.id;
        let missed = self
            .write(
                t,
                "deletions",
                move |tx, _, account| {
                    let Some(&start) = seqs.get(&account) else {
                        return Ok(Vec::new());
                    };
                    let mut changed = Vec::new();
                    for r in q::repo_item_ids(tx, repo)? {
                        let gone = match r.kind.as_str() {
                            "pr" => r.pr_id.is_some_and(|p| !prs.contains(&p)),
                            _ => !issues.contains(&r.id),
                        };
                        if gone && r.seq <= start {
                            changed.extend(crate::webhook::forget_item(tx, r.id)?);
                        }
                    }
                    Ok(changed)
                },
                |_| true,
            )
            .await?;
        Ok((missed, lacking))
    }
}

pub(super) const SWEEP_COUNTS: &str = "query SweepCounts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository { id databaseId issues { totalCount } pullRequests { totalCount } }
  }
}";

pub(super) const SWEEP_ISSUE_IDS: &str = "query SweepIssueIds($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId } }
  }
}";

pub(super) const SWEEP_PULL_IDS: &str = "query SweepPullIds($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId } }
  }
}";
