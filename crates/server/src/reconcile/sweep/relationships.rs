//! Relationships read back in bulk: the 15-minute sub-issue order sweep, and every relationship in
//! a full sweep.

use super::*;

impl Sweeper {
    /// The sub-issue order sweep: each parent's children read back in GitHub's order (a reorder
    /// sends no webhook), with the parents' own parents.
    pub async fn order(&self, t: &Target) -> Result<(), Stop> {
        let mut parents: BTreeSet<(i64, String)> = BTreeSet::new();
        for &a in &t.accounts {
            let id = t.id;
            if let Ok(rows) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| q::repo_parents(c, id))
                .await
            {
                parents.extend(rows.into_iter().map(|r| (r.id, r.node_id)));
            }
        }
        let parents: Vec<(i64, String)> = parents.into_iter().collect();
        self.edges(t, &parents, &[Kind::Sub]).await?;
        Ok(())
    }

    /// Reads back the relationships of `kinds` of `issues` (id, node id), 100 at a time, and
    /// replaces each account's with them, but for an issue where a delivery (or a read-back)
    /// since the read began changed the relationships of any end, read or held, that the
    /// replacing would touch. An issue with more relates-to than one page holds is read back on
    /// its own. The accounts with misses.
    ///
    /// Only a relationship added or removed can be a miss: GitHub sends no webhook for a reorder. Such
    /// a change carries no time of its own, so whether its webhook was missed is settled once
    /// [`ReconcileConfig::webhook_grace`](crate::config::ReconcileConfig) has passed: by then a
    /// delivery that was on its way has stamped its ends ([`Reconcile::suspect`]).
    ///
    /// TODO(#92 follow-up): an issue with over 100 relates-to is left to its own read-back, which
    /// gives up past its page limit; nothing sweeps the rest.
    pub(super) async fn edges(
        &self,
        t: &Target,
        issues: &[(i64, String)],
        kinds: &[Kind],
    ) -> Result<HashSet<i64>, Stop> {
        let mut out = HashSet::new();
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Swept {
            database_id: i64,
            number: i64,
            #[serde(flatten)]
            node: edges::Node,
        }
        let synced = self.synced(t).await;
        for chunk in issues.chunks(PAGE) {
            let ids: Vec<&str> = chunk.iter().map(|(_, n)| n.as_str()).collect();
            let starts = Arc::new(self.seqs(t).await);
            let data = self
                .graphql(
                    "SweepEdges",
                    SWEEP_EDGES,
                    json!({
                        "ids": ids,
                        "sub": kinds.contains(&Kind::Sub),
                        "blocks": kinds.contains(&Kind::Blocks),
                        "relates": kinds.contains(&Kind::Relates),
                    }),
                )
                .await?;
            let nodes: Vec<Option<Swept>> =
                serde_json::from_value(data["nodes"].clone()).map_err(malformed)?;
            let mut read = Vec::new();
            for n in nodes.into_iter().flatten() {
                if n.node.more_relates() {
                    let node_id = chunk
                        .iter()
                        .find(|(id, _)| *id == n.database_id)
                        .map(|(_, node)| node.clone())
                        .unwrap_or_default();
                    drop(self.app.edges().schedule(
                        Subject {
                            id: n.database_id,
                            node_id,
                            number: n.number,
                            repo: t.id,
                            installation: self.installation,
                        },
                        ReadBack::Edges(Kind::Relates),
                        true,
                    ));
                }
                read.push(n);
            }
            let fetched: Arc<Vec<(i64, Kind, edges::Fetched)>> = Arc::new(
                read.into_iter()
                    .flat_map(|n| {
                        let more = n.node.more_relates();
                        kinds
                            .iter()
                            .filter(|k| **k != Kind::Relates || !more)
                            .map(|k| {
                                (
                                    n.database_id,
                                    *k,
                                    edges::fetched(n.database_id, *k, n.node.clone()),
                                )
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect(),
            );
            let (synced, installation) = (synced.clone(), self.installation);
            let written = self
                .write_each(t, "relationships", move |tx, seq, account| {
                    let (Some(synced), Some(&start)) = (synced.get(&account), starts.get(&account))
                    else {
                        return Ok((Vec::new(), (seq, Vec::new())));
                    };
                    let (mut changed, mut moved) = (Vec::new(), Vec::new());
                    'issue: for (id, kind, f) in fetched.iter() {
                        // A delivery (or a read-back) since the read began changed an end
                        // replacing these relationships would touch: what was read is stale. (A
                        // write to any relationship stamps both its ends.)
                        for end in edges::ends(tx, *kind, *id, f)? {
                            if q::edges_seq(tx, end)? > start {
                                continue 'issue;
                            }
                        }
                        let r = edges::replace(tx, seq, *kind, installation, *id, f, synced)?;
                        changed.extend(r.ids);
                        moved.extend(r.moved);
                    }
                    Ok((changed, (seq, moved)))
                })
                .await?;
            for (account, _, (seq, moved)) in written {
                if !moved.is_empty()
                    && self
                        .reconcile()
                        .suspect(&self.app, account, t.id, seq, Touched::Ends(moved))
                {
                    out.insert(account);
                }
            }
        }
        Ok(out)
    }

    /// Each account's synced repos, for the isolation rule.
    pub(super) async fn synced(&self, t: &Target) -> Arc<HashMap<i64, HashSet<i64>>> {
        let mut out = HashMap::new();
        for &a in &t.accounts {
            if let Ok(ids) = self
                .app
                .control()
                .read(move |c| control_db::q::synced_repo_ids(c, a))
                .await
            {
                out.insert(a, ids.into_iter().collect());
            }
        }
        Arc::new(out)
    }
}

/// `IssueEdges` (crates/server/src/edges.rs) for up to 100 issues at once; relates-to's first
/// page of 100.
const SWEEP_EDGES: &str = "query SweepEdges($ids: [ID!]!, $sub: Boolean!, $blocks: Boolean!, $relates: Boolean!) {
  nodes(ids: $ids) {
    ... on Issue {
      id databaseId number
      parent @include(if: $sub) { ...End }
      subIssues(first: 100) @include(if: $sub) { nodes { ...End } }
      blockedBy(first: 50) @include(if: $blocks) { nodes { ...End } }
      blocking(first: 50) @include(if: $blocks) { nodes { ...End } }
      relatesTo(first: 100) @include(if: $relates) { pageInfo { hasNextPage endCursor } nodes { ...End } }
    }
  }
}
fragment End on Issue {
  id databaseId number title state
  repository { databaseId id name owner { login } isPrivate }
}";
