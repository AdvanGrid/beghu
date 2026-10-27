//! The 5-minute probes: `since` reads of a repo's issues and PRs, and of its comments, each
//! conditional on its last ETag.

use super::*;

impl Sweeper {
    /// The `since` probes of the repo's issues and PRs, then of its comments.
    pub async fn probe(&self, t: &Target) -> Result<(), Stop> {
        let id = t.id;
        let rec = self
            .app
            .control()
            .read(move |c| control_db::q::repo_probe(c, id))
            .await?;
        let (items_since, comments_since) = match &rec {
            Some(r) if r.issues_since.is_some() && r.comments_since.is_some() => {
                (r.issues_since.unwrap_or(0), r.comments_since.unwrap_or(0))
            }
            _ => self.start_since(t).await,
        };
        let (since, etag) = self
            .probe_issues(
                t,
                items_since,
                rec.as_ref().and_then(|r| r.issues_etag.clone()),
            )
            .await?;
        let (s, e) = (since, etag.clone());
        self.app
            .control()
            .write(move |tx| control_db::q::set_issues_probe(tx, id, Some(s), e.as_deref()))
            .await?;
        let (since, etag) = self
            .probe_comments(
                t,
                comments_since,
                rec.as_ref().and_then(|r| r.comments_etag.clone()),
            )
            .await?;
        self.app
            .control()
            .write(move |tx| {
                control_db::q::set_comments_probe(tx, id, Some(since), etag.as_deref())
            })
            .await?;
        Ok(())
    }

    /// Where a repo's first probes start: the newest change the mirrors hold of it (the oldest of
    /// those, across the accounts), less the overlap; a day back when they hold none.
    pub(super) async fn start_since(&self, t: &Target) -> (i64, i64) {
        let day = crate::now() - 24 * 3600;
        let (mut items, mut comments) = (None::<i64>, None::<i64>);
        for &a in &t.accounts {
            let id = t.id;
            if let Ok(n) = self
                .app
                .mirrors()
                .read(a, Caller::Sweep, move |c| q::repo_newest(c, id))
                .await
            {
                let lower = |cur: Option<i64>, v: Option<i64>| match (cur, v) {
                    (Some(c), Some(v)) => Some(c.min(v)),
                    (c, v) => c.or(v),
                };
                items = lower(items, n.items);
                comments = lower(comments, n.comments);
            }
        }
        (
            items.map_or(day, |t| t - OVERLAP),
            comments.map_or(day, |t| t - OVERLAP),
        )
    }

    /// Where the next probe reads from, once one has read through `newest`: the overlap behind
    /// it, never back past `since`.
    pub(super) fn next_since(since: i64, newest: Option<i64>) -> i64 {
        newest.map_or(since, |n| (n - OVERLAP).max(since))
    }

    /// The issues and PRs updated after `since`, conditional on `etag`. Where the next probe
    /// reads from, and the ETag that keeps it a 304 while nothing changes.
    pub(super) async fn probe_issues(
        &self,
        t: &Target,
        since: i64,
        etag: Option<String>,
    ) -> Result<(i64, Option<String>), Stop> {
        let mut pages = Updated::new(
            format!(
                "/repos/{}/{}/issues?state=all&sort=updated&direction=asc&per_page=100",
                t.owner, t.name
            ),
            Some(since),
        );
        let mut newest = None::<i64>;
        let mut first_etag = None;
        while let Some(path) = pages.next_path() {
            let first = pages.first();
            let asked = if first { etag.as_deref() } else { None };
            let Some(got) = self.rest::<RestIssue>(&path, asked).await? else {
                return Ok((since, etag));
            };
            first_etag = if first { got.etag } else { None };
            let times: Vec<i64> = got.items.iter().map(|i| time(&i.updated_at)).collect();
            newest = times.iter().copied().chain(newest).max();
            self.write_items(t, got.items).await?;
            pages.read(&times);
        }
        let next = Self::next_since(since, newest);
        // The ETag answers the URL it came with: only while `since` stays put.
        Ok((next, first_etag.filter(|_| next == since)))
    }

    /// Writes REST's issues and PRs (a PR with its details), under the webhooks' guards. Each
    /// PR's linked issues (`closes`) are replaced as a set with what GitHub read, so a link
    /// removed on GitHub goes too, under the relationship read-backs' rules (`edges::replace`):
    /// but not where a delivery or read-back since the read began stamped the PR or an issue the
    /// replacing would touch (what was read is stale, and the newer write stands), and not for a
    /// PR whose closing references go past the page read, which is read back on its own
    /// (`pulls.rs`) instead.
    pub(super) async fn write_items(
        &self,
        t: &Target,
        items: Vec<RestIssue>,
    ) -> Result<HashSet<i64>, Stop> {
        let (prs, issues): (Vec<RestIssue>, Vec<RestIssue>) =
            items.into_iter().partition(|i| i.pull_request.is_some());
        let mut data: Vec<ItemData> = issues.iter().map(ItemData::from_rest).collect();
        let mut closes: Vec<(i64, edges::Fetched)> = Vec::new();
        // Each account's last write before the read: anything stamped later is newer than it.
        let starts = Arc::new(if prs.is_empty() {
            HashMap::new()
        } else {
            self.seqs(t).await
        });
        let synced = if prs.is_empty() {
            Arc::default()
        } else {
            self.synced(t).await
        };
        if !prs.is_empty() {
            let details = self.pull_details(&prs).await?;
            for p in &prs {
                let Some((d, pr_id)) = details
                    .get(&p.node_id)
                    .and_then(|d| Some((d, d.database_id?)))
                else {
                    continue;
                };
                let mut it = ItemData::from_rest(p);
                it.pr = Some(PrData {
                    pr_id,
                    draft: d.is_draft,
                    merged_at: d.merged_at.as_deref().and_then(parse_time),
                    head_ref: d.head_ref_name.clone(),
                    base_ref: d.base_ref_name.clone(),
                    review_decision: d.review_decision.as_deref().map(str::to_lowercase),
                });
                let refs = d.closing_issues_references.as_ref();
                if refs.is_none() {
                    // GitHub left the field null (an error beside the data): what the PR closes
                    // is unknown, not none, so its links stay as they are.
                } else if refs
                    .and_then(|r| r.page_info.as_ref())
                    .is_some_and(|p| p.has_next_page)
                {
                    // More than the page read: the PR read-back pages them all.
                    let pull = crate::pulls::Pull {
                        repo: t.id,
                        owner: t.owner.clone(),
                        name: t.name.clone(),
                        number: p.number,
                        installation: self.installation,
                    };
                    drop(self.app.edges().schedule_pull(pull, true));
                } else {
                    let me = it.id;
                    let edges = refs
                        .into_iter()
                        .flat_map(|r| r.nodes.iter().flatten())
                        .map(|e| (me, e.database_id, edges::End::from(e)))
                        .collect();
                    closes.push((me, edges::Fetched { edges }));
                }
                data.push(it);
            }
        }
        let overdue: HashSet<i64> = data
            .iter()
            .filter(|i| self.overdue(i.updated))
            .map(|i| i.id)
            .collect();
        let data = Arc::new((data, closes));
        let (repo, installation) = (t.id, self.installation);
        let missed = self
            .write(
                t,
                "issues",
                move |tx, seq, account| {
                    let mut changed = Vec::new();
                    for it in &data.0 {
                        if newer(tx, it)? && write_item(tx, seq, repo, it)? {
                            changed.push(it.id);
                        }
                    }
                    let (Some(&start), Some(synced)) = (starts.get(&account), synced.get(&account))
                    else {
                        return Ok(changed);
                    };
                    'pr: for (pr, f) in &data.1 {
                        if !q::item_updated(tx, *pr)?.is_some_and(|h| !h.is_stub) {
                            continue;
                        }
                        for end in edges::ends(tx, Kind::Closes, *pr, f)? {
                            if q::edges_seq(tx, end)? > start {
                                continue 'pr;
                            }
                        }
                        let r =
                            edges::replace(tx, seq, Kind::Closes, installation, *pr, f, synced)?;
                        changed.extend(r.ids);
                    }
                    Ok(changed)
                },
                |ids| ids.iter().any(|id| overdue.contains(id)),
            )
            .await?;
        Ok(missed)
    }

    /// The PRs' own fields and the issues each closes, by node id.
    pub(super) async fn pull_details(
        &self,
        prs: &[RestIssue],
    ) -> Result<HashMap<String, PullDetails>, Stop> {
        let mut out = HashMap::new();
        for chunk in prs.chunks(PAGE) {
            let ids: Vec<&str> = chunk.iter().map(|p| p.node_id.as_str()).collect();
            let data = self
                .graphql(
                    "ImportPullDetails",
                    IMPORT_PULL_DETAILS,
                    json!({ "ids": ids }),
                )
                .await?;
            let nodes: Vec<Option<PullDetails>> =
                serde_json::from_value(data["nodes"].clone()).map_err(malformed)?;
            out.extend(nodes.into_iter().flatten().map(|d| (d.id.clone(), d)));
        }
        Ok(out)
    }

    /// The comments updated after `since`, conditional on `etag`.
    pub(super) async fn probe_comments(
        &self,
        t: &Target,
        since: i64,
        etag: Option<String>,
    ) -> Result<(i64, Option<String>), Stop> {
        let mut pages = Updated::new(
            format!(
                "/repos/{}/{}/issues/comments?sort=updated&direction=asc&per_page=100",
                t.owner, t.name
            ),
            Some(since),
        );
        let mut newest = None::<i64>;
        let mut first_etag = None;
        while let Some(path) = pages.next_path() {
            let first = pages.first();
            let asked = if first { etag.as_deref() } else { None };
            let Some(got) = self.rest::<RestComment>(&path, asked).await? else {
                return Ok((since, etag));
            };
            first_etag = if first { got.etag } else { None };
            let times: Vec<i64> = got.items.iter().map(|c| time(&c.updated_at)).collect();
            newest = times.iter().copied().chain(newest).max();
            self.write_rest_comments(t, got.items, None).await?;
            pages.read(&times);
        }
        let next = Self::next_since(since, newest);
        Ok((next, first_etag.filter(|_| next == since)))
    }

    /// Writes REST comments to the items each names by number (one the mirror doesn't hold is
    /// left for the sweep that brings it). With `seen`, collects their ids.
    pub(super) async fn write_rest_comments(
        &self,
        t: &Target,
        comments: Vec<RestComment>,
        seen: Option<&mut HashSet<i64>>,
    ) -> Result<HashSet<i64>, Stop> {
        if let Some(seen) = seen {
            seen.extend(comments.iter().map(|c| c.id));
        }
        let overdue: HashSet<i64> = comments
            .iter()
            .filter(|c| self.overdue(time(&c.updated_at)))
            .filter_map(|c| c.number())
            .collect();
        let by_number: Arc<Vec<(i64, RestComment)>> = Arc::new(
            comments
                .into_iter()
                .filter_map(|c| Some((c.number()?, c)))
                .collect(),
        );
        let repo = t.id;
        // The items whose comments changed, as the numbers they were named by.
        let numbers = Arc::new(std::sync::Mutex::new(HashMap::<i64, i64>::new()));
        let seen_numbers = numbers.clone();
        self.write(
            t,
            "comments",
            move |tx, seq, _| {
                let mut data = Vec::new();
                for (number, c) in by_number.iter() {
                    if let Some(i) = q::item_by_number(tx, repo, *number)?
                        && !i.is_stub
                    {
                        seen_numbers
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(i.id, *number);
                        let held = q::comment_updated(tx, c.id)?;
                        if held.is_none_or(|h| h < time(&c.updated_at)) {
                            data.push(CommentData::from_rest(i.id, c.clone()));
                        }
                    }
                }
                write_comments(tx, seq, &data)
            },
            |ids| {
                let numbers = numbers.lock().unwrap_or_else(|e| e.into_inner());
                ids.iter()
                    .any(|id| numbers.get(id).is_some_and(|n| overdue.contains(n)))
            },
        )
        .await
    }
}
