//! The full sweep with diff: everything the import reads, written under the webhooks' guards,
//! then what GitHub no longer has removed.

use super::*;

impl Sweeper {
    /// The full sweep with diff: everything the import reads, written page by page under the
    /// webhooks' guards; every relationship read back; then what GitHub no longer has removed
    /// (unless a write since the sweep began touched it). The accounts with misses.
    ///
    /// What's gone is never inferred from the pages read for content: REST lists page by offset,
    /// and GraphQL's issues come per state, so an item updated (or reopened) meanwhile can be
    /// passed over. Issues and PRs go by the cursor-paged id lists; a comment only when GitHub
    /// answers 404 for it.
    ///
    /// TODO(#92 follow-up): a PR's `closes` links the mirror holds but GitHub dropped are kept.
    pub async fn full(&self, t: &Target) -> Result<HashSet<i64>, Stop> {
        let seqs = self.seqs(t).await;
        let mut missed = HashSet::new();
        missed.extend(self.labels_and_milestones(t, &seqs).await?);
        // Issues, open and closed.
        let mut with_edges: BTreeSet<(i64, String)> = BTreeSet::new();
        for state in ["OPEN", "CLOSED"] {
            let mut after: Option<String> = None;
            loop {
                let data = self
                    .graphql(
                        "ImportIssues",
                        IMPORT_ISSUES,
                        json!({ "owner": t.owner, "name": t.name, "states": [state], "after": after }),
                    )
                    .await?;
                let conn = &data["repository"]["issues"];
                if conn.is_null() {
                    return Err(Stop::Failed(Error::NoRepo(t.full_name())));
                }
                let page: Conn<GqlIssue> =
                    serde_json::from_value(conn.clone()).map_err(malformed)?;
                let issues: Vec<GqlIssue> = page.nodes.into_iter().flatten().collect();
                let mut data = Vec::new();
                for i in &issues {
                    let deps = i.issue_dependencies_summary.as_ref();
                    let has = i.parent.is_some()
                        || i.sub_issues_summary.as_ref().is_some_and(|s| s.total > 0)
                        || deps.is_some_and(|d| d.total_blocked_by > 0 || d.total_blocking > 0)
                        || i.relates_to.as_ref().is_some_and(|r| !r.nodes.is_empty());
                    if has {
                        with_edges.insert((i.database_id, i.id.clone()));
                    }
                    let mut it = ItemData::from_graphql(i);
                    if let Some(info) = i.labels.page_info.clone()
                        && info.has_next_page
                    {
                        it.labels
                            .extend(self.more_labels(&i.id, info.end_cursor).await?);
                    }
                    data.push(it);
                }
                missed.extend(self.write_data(t, data).await?);
                match page.page_info {
                    Some(p) if p.has_next_page && p.end_cursor.is_some() => after = p.end_cursor,
                    _ => break,
                }
            }
        }
        // PRs, from REST's issue list (which has their issue-side ids), with their details.
        let mut pages = Updated::new(
            format!(
                "/repos/{}/{}/issues?state=all&sort=updated&direction=asc&per_page=100",
                t.owner, t.name
            ),
            None,
        );
        while let Some(path) = pages.next_path() {
            let Some(got) = self.rest::<RestIssue>(&path, None).await? else {
                break;
            };
            let times: Vec<i64> = got.items.iter().map(|i| time(&i.updated_at)).collect();
            let prs: Vec<RestIssue> = got
                .items
                .into_iter()
                .filter(|i| i.pull_request.is_some())
                .collect();
            missed.extend(self.write_items(t, prs).await?);
            pages.read(&times);
        }
        // Every relationship, of the issues GitHub says have any and those the mirrors link.
        for &a in &t.accounts {
            let id = t.id;
            if let Ok(rows) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| {
                    q::repo_items_with_edges(c, id, r#"["sub","blocks","relates"]"#)
                })
                .await
            {
                with_edges.extend(rows.into_iter().map(|r| (r.id, r.node_id)));
            }
        }
        let with_edges: Vec<(i64, String)> = with_edges.into_iter().collect();
        missed.extend(
            self.edges(t, &with_edges, &[Kind::Sub, Kind::Blocks, Kind::Relates])
                .await?,
        );
        // What GitHub no longer has.
        missed.extend(self.delete_absent(t, &seqs).await?.0);
        missed.extend(self.full_comments(t, &seqs).await?);
        Ok(missed)
    }

    /// Every comment in the repo, written page by page (only their ids kept), then those the
    /// mirrors hold that no page listed asked for one by one: written if GitHub has them, removed
    /// on its 404 (not recorded as deleted).
    pub(super) async fn full_comments(
        &self,
        t: &Target,
        seqs: &HashMap<i64, i64>,
    ) -> Result<HashSet<i64>, Stop> {
        let mut missed = HashSet::new();
        let mut seen: HashSet<i64> = HashSet::new();
        let mut pages = Updated::new(
            format!(
                "/repos/{}/{}/issues/comments?sort=updated&direction=asc&per_page=100",
                t.owner, t.name
            ),
            None,
        );
        while let Some(path) = pages.next_path() {
            let Some(got) = self.rest::<RestComment>(&path, None).await? else {
                break;
            };
            let times: Vec<i64> = got.items.iter().map(|c| time(&c.updated_at)).collect();
            missed.extend(
                self.write_rest_comments(t, got.items, Some(&mut seen))
                    .await?,
            );
            pages.read(&times);
        }
        let mut unlisted: BTreeSet<i64> = BTreeSet::new();
        for &a in &t.accounts {
            let (id, Some(&start)) = (t.id, seqs.get(&a)) else {
                continue;
            };
            if let Ok(rows) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| q::repo_comment_ids(c, id))
                .await
            {
                unlisted.extend(
                    rows.into_iter()
                        .filter(|c| c.seq <= start && !seen.contains(&c.id))
                        .map(|c| c.id),
                );
            }
        }
        drop(seen);
        let mut gone: HashSet<i64> = HashSet::new();
        let mut found = Vec::new();
        for id in unlisted {
            match self
                .one::<RestComment>(&format!(
                    "/repos/{}/{}/issues/comments/{id}",
                    t.owner, t.name
                ))
                .await?
            {
                Some(c) => found.push(c),
                None => {
                    gone.insert(id);
                }
            }
        }
        if !found.is_empty() {
            missed.extend(self.write_rest_comments(t, found, None).await?);
        }
        if gone.is_empty() {
            return Ok(missed);
        }
        let (gone, seqs, repo) = (Arc::new(gone), Arc::new(seqs.clone()), t.id);
        missed.extend(
            self.write(
                t,
                "comment deletions",
                move |tx, seq, account| {
                    let Some(&start) = seqs.get(&account) else {
                        return Ok(Vec::new());
                    };
                    let mut changed = Vec::new();
                    for c in q::repo_comment_ids(tx, repo)? {
                        if c.seq <= start
                            && gone.contains(&c.id)
                            && crate::webhook::forget_comment(tx, c.item_id, c.id, seq)?
                        {
                            changed.push(c.item_id);
                        }
                    }
                    Ok(changed)
                },
                |_| true,
            )
            .await?,
        );
        Ok(missed)
    }

    /// An issue's labels past its first 100.
    pub(super) async fn more_labels(
        &self,
        node: &str,
        mut after: Option<String>,
    ) -> Result<Vec<String>, Stop> {
        let mut out = Vec::new();
        while let Some(a) = after {
            let data = self
                .graphql(
                    "ImportLabels",
                    IMPORT_LABELS,
                    json!({ "id": node, "after": a }),
                )
                .await?;
            let conn: Conn<Named> =
                serde_json::from_value(data["node"]["labels"].clone()).map_err(malformed)?;
            out.extend(conn.nodes.into_iter().flatten().map(|n| n.name));
            after = conn
                .page_info
                .filter(|p| p.has_next_page)
                .and_then(|p| p.end_cursor);
        }
        Ok(out)
    }

    /// Writes GraphQL's issues under the webhooks' guards.
    pub(super) async fn write_data(
        &self,
        t: &Target,
        data: Vec<ItemData>,
    ) -> Result<HashSet<i64>, Stop> {
        let overdue: HashSet<i64> = data
            .iter()
            .filter(|i| self.overdue(i.updated))
            .map(|i| i.id)
            .collect();
        let data = Arc::new(data);
        let repo = t.id;
        self.write(
            t,
            "issues",
            move |tx, seq, _| {
                let mut changed = Vec::new();
                for it in data.iter() {
                    if newer(tx, it)? && write_item(tx, seq, repo, it)? {
                        changed.push(it.id);
                    }
                }
                Ok(changed)
            },
            |ids| ids.iter().any(|id| overdue.contains(id)),
        )
        .await
    }

    /// The repo's labels and milestones as GitHub has them now. Renames land, unless a webhook
    /// wrote the label since the sweep began (`seqs`, each account's last transaction before
    /// it). What GitHub no longer lists goes, if the mirror held it before the lists were read
    /// and (a label) nothing wrote it since; not recorded as deleted. A list longer than a page
    /// pages by offset, so a change meanwhile can pass an entry over: then each one missing is
    /// asked for by itself, and only GitHub's 404 removes it. A label is asked for by name, and
    /// a rename meanwhile makes its old name a 404 too, so one of a longer list goes only once
    /// the previous full sweep's list lacked it as well.
    ///
    /// The changes it makes count as missed by the webhooks as an issue's do: a milestone's
    /// only if GitHub changed it more than [`ReconcileConfig::webhook_grace`] ago (one deleted
    /// carries no time, and counts); a label's, which carries no time, only if no `label`
    /// delivery lands within that grace ([`Reconcile::suspect`]).
    ///
    /// [`ReconcileConfig::webhook_grace`]: crate::config::ReconcileConfig::webhook_grace
    /// [`Reconcile::suspect`]: super::super::Reconcile::suspect
    pub(super) async fn labels_and_milestones(
        &self,
        t: &Target,
        seqs: &HashMap<i64, i64>,
    ) -> Result<HashSet<i64>, Stop> {
        let base = format!("/repos/{}/{}", t.owner, t.name);
        // What each mirror held before the lists were read.
        let mut held_labels: HashMap<i64, HashSet<i64>> = HashMap::new();
        let mut held_milestones: HashMap<i64, HashSet<i64>> = HashMap::new();
        let mut labels_held: BTreeMap<i64, String> = BTreeMap::new();
        let mut milestones_held: BTreeMap<i64, i64> = BTreeMap::new();
        for &a in &t.accounts {
            let id = t.id;
            let read = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| {
                    Ok((q::repo_labels(c, id)?, q::repo_milestones(c, id)?))
                })
                .await;
            if let Ok((labels, milestones)) = read {
                held_labels.insert(a, labels.iter().map(|l| l.id).collect());
                held_milestones.insert(a, milestones.iter().map(|m| m.id).collect());
                labels_held.extend(labels.into_iter().map(|l| (l.id, l.name)));
                milestones_held.extend(milestones.into_iter().map(|m| (m.id, m.number)));
            }
        }
        let labels: Vec<Value> = self
            .all_pages(&format!("{base}/labels?per_page=100"))
            .await?;
        let milestones: Vec<Value> = self
            .all_pages(&format!("{base}/milestones?state=all&per_page=100"))
            .await?;
        let listed = |list: &[Value]| -> HashSet<i64> {
            list.iter().filter_map(|v| v["id"].as_i64()).collect()
        };
        let (listed_labels, listed_milestones) = (listed(&labels), listed(&milestones));
        // A label renamed while a list of more than a page is read can move to a page already
        // read, and GitHub answers 404 for its old name: one such list lacking it isn't enough.
        let paged = labels.len() >= PAGE;
        let before = self
            .reconcile()
            .with(|s| s.unlisted_labels.remove(&t.id))
            .unwrap_or_default();
        let mut unlisted = HashSet::new();
        let mut gone_labels = HashSet::new();
        for (id, name) in labels_held {
            if listed_labels.contains(&id) {
                continue;
            }
            if paged {
                unlisted.insert(id);
            }
            let gone = !paged
                || (before.contains(&id)
                    && self
                        .one::<Value>(&format!("{base}/labels/{}", path_segment(&name)))
                        .await?
                        .is_none_or(|l| l["id"].as_i64() != Some(id)));
            if gone {
                gone_labels.insert(id);
            }
        }
        if !unlisted.is_empty() {
            self.reconcile()
                .with(|s| s.unlisted_labels.insert(t.id, unlisted));
        }
        let mut gone_milestones = HashSet::new();
        for (id, number) in milestones_held {
            if listed_milestones.contains(&id) {
                continue;
            }
            let gone = milestones.len() < PAGE
                || self
                    .one::<Value>(&format!("{base}/milestones/{number}"))
                    .await?
                    .is_none_or(|m| m["id"].as_i64() != Some(id));
            if gone {
                gone_milestones.insert(id);
            }
        }
        // Milestones GitHub changed so lately that their webhooks may still be on the way.
        let fresh: Arc<HashSet<i64>> = Arc::new(
            milestones
                .iter()
                .filter(|m| {
                    m["updated_at"]
                        .as_str()
                        .and_then(parse_time)
                        .is_some_and(|u| !self.overdue(u))
                })
                .filter_map(|m| m["id"].as_i64())
                .collect(),
        );
        let lists = Arc::new((labels, milestones));
        let gone = Arc::new((gone_labels, gone_milestones));
        let held = Arc::new((held_labels, held_milestones));
        let seqs = Arc::new(seqs.clone());
        let repo = t.id;
        let written = self
            .write_each(t, "labels and milestones", move |tx, seq, account| {
                let Some(&start) = seqs.get(&account) else {
                    return Ok((Vec::new(), (seq, Vec::new(), false)));
                };
                let (labels, milestones) = &*lists;
                let (gone_labels, gone_milestones) = &*gone;
                let none = HashSet::new();
                let held_labels = held.0.get(&account).unwrap_or(&none);
                let held_milestones = held.1.get(&account).unwrap_or(&none);
                let mut changed = Vec::new();
                // The labels changed, and whether a milestone change counts as missed.
                let (mut labels_changed, mut milestone_missed) = (Vec::new(), false);
                for l in labels {
                    let (Some(id), Some(name)) = (l["id"].as_i64(), l["name"].as_str()) else {
                        continue;
                    };
                    let (color, description) =
                        (l["color"].as_str().unwrap_or(""), l["description"].as_str());
                    if q::sweep_label(tx, id, repo, name, color, description, seq, start)? > 0 {
                        changed.extend(q::label_items(tx, id)?);
                        labels_changed.push(id);
                    }
                }
                for l in q::repo_labels(tx, repo)? {
                    if gone_labels.contains(&l.id) && held_labels.contains(&l.id) && l.seq <= start
                    {
                        changed.extend(q::label_items(tx, l.id)?);
                        q::unlink_label(tx, l.id)?;
                        q::delete_label(tx, l.id)?;
                        labels_changed.push(l.id);
                    }
                }
                for m in milestones {
                    let (Some(id), Some(number), Some(title)) =
                        (m["id"].as_i64(), m["number"].as_i64(), m["title"].as_str())
                    else {
                        continue;
                    };
                    if q::sweep_milestone(
                        tx,
                        id,
                        repo,
                        number,
                        title,
                        m["state"].as_str().unwrap_or("open"),
                        m["due_on"].as_str().map(time),
                        m["updated_at"].as_str().map(time),
                    )? > 0
                    {
                        changed.extend(q::milestone_items(tx, id)?);
                        milestone_missed |= !fresh.contains(&id);
                    }
                }
                for m in q::repo_milestones(tx, repo)? {
                    if gone_milestones.contains(&m.id) && held_milestones.contains(&m.id) {
                        changed.extend(q::milestone_items(tx, m.id)?);
                        q::clear_milestone(tx, m.id, seq)?;
                        q::delete_milestone(tx, m.id)?;
                        milestone_missed = true;
                    }
                }
                Ok((changed, (seq, labels_changed, milestone_missed)))
            })
            .await?;
        let mut out = HashSet::new();
        let r = self.reconcile();
        for (account, _, (seq, labels, milestone_missed)) in written {
            if milestone_missed {
                r.missed(&self.app, account, t.id);
                out.insert(account);
            }
            if !labels.is_empty()
                && r.suspect(&self.app, account, t.id, seq, Touched::Labels(labels))
            {
                out.insert(account);
            }
        }
        Ok(out)
    }
}

/// `s` as one URL path segment: everything but RFC 3986's unreserved characters escaped.
fn path_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
