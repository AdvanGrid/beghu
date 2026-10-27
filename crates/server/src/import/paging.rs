//! One round of the import: the four phases over its repos, reading GitHub page by page with
//! the repos' installation tokens, retrying what may pass, and writing each page as it lands.

use super::shapes::*;
use super::writes::*;
use super::{
    AUTH_TRIES, Failed, ImportPhase, MAX_BACKOFF, Outcome, PAGE, Round, STREAMS, retry_after,
};
use crate::App;
use crate::edges::Kind;
use crate::github::CallError;
use crate::installations::Scope;
use crate::webhook::{parse_time, time};
use mirror_db::{Caller, q};
use rusqlite::Transaction;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a secondary rate limit that names no wait is waited out at first (GitHub: "at least
/// one minute"), doubling while it lasts, up to [`MAX_SECONDARY_WAIT`].
const SECONDARY_WAIT: Duration = Duration::from_secs(60);
const MAX_SECONDARY_WAIT: Duration = Duration::from_secs(30 * 60);
/// A call that GitHub answers with a 5xx (or doesn't answer) this many times fails, as does one
/// still failing after `import_give_up_after`: its repo fails for the round and is tried again
/// later, rather than holding the round up for good.
const TRANSIENT_TRIES: u32 = 10;

/// REST's `since` for a walk that has read through `last` (an `updated_at`): a second earlier,
/// since GitHub lists only what was updated after it. What comes twice is written once.
fn since_param(last: &str) -> String {
    match parse_time(last) {
        Some(t) => crate::webhook::rfc3339(t - 1),
        None => last.to_owned(),
    }
}

/// The status slot's words for a rate limit's wait.
fn rate_limit_note(wait: Duration) -> String {
    format!(
        "GitHub's rate limit · resuming in {} s",
        wait.as_secs().max(1)
    )
}

/// Which of its two states a pass reads issues and PRs in.
#[derive(Clone, Copy, Debug)]
pub(super) enum State {
    Open,
    Closed,
}

impl State {
    /// As REST's `state=` and the mirror name it.
    fn as_str(self) -> &'static str {
        match self {
            State::Open => "open",
            State::Closed => "closed",
        }
    }

    /// As GraphQL's `IssueState` names it.
    fn graphql(self) -> &'static str {
        match self {
            State::Open => "OPEN",
            State::Closed => "CLOSED",
        }
    }
}

/// A repo being imported, as the mirror knows it.
#[derive(Clone, Debug)]
pub(super) struct Repo {
    pub(super) id: i64,
    pub(super) owner: String,
    pub(super) name: String,
    pub(super) private: bool,
    pub(super) installation: i64,
    /// The `seq` that started this import of the repo: the round finishes only that one.
    pub(super) started: i64,
}

impl Repo {
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// One round of the import over `ids`: the repos the mirror has synced and still importing
/// (with an installation), except those waiting out a failure, which the outcome hands back
/// with their time. Finishes the repos that got through every phase.
pub(super) async fn round(app: App, account: i64, ids: Vec<i64>) -> Result<Outcome, String> {
    let rows = app
        .mirrors()
        .read(account, Caller::Sweep, move |c| {
            ids.iter()
                .map(|id| q::repo_state(c, *id))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await
        .map_err(|e| format!("reading the repos to import: {e}"))?;
    let now = crate::now();
    let mut out = Outcome::default();
    let mut repos = Vec::new();
    for r in rows
        .into_iter()
        .flatten()
        .filter(|r| r.synced && r.importing)
    {
        let Some(installation) = r.installation_id else {
            continue;
        };
        let repo = Repo {
            id: r.id,
            owner: r.owner,
            name: r.name,
            private: r.private,
            installation,
            started: r.import_started,
        };
        match r.import_retry_at {
            // A restart doesn't cut a failed repo's wait short.
            Some(retry) if retry > now => {
                out.failed.insert(
                    repo.id,
                    Failed {
                        name: repo.full_name(),
                        retry_at: retry,
                    },
                );
            }
            _ => repos.push(repo),
        }
    }
    if repos.is_empty() {
        return Ok(out);
    }
    let run = Arc::new(Run {
        app,
        account,
        repos,
        parents: Mutex::default(),
        failed: Mutex::default(),
    });
    run.clone().go().await?;
    out.failed.extend(run.settle().await);
    Ok(out)
}

/// One round of the import over a set of repos.
pub(super) struct Run {
    pub(super) app: App,
    pub(super) account: i64,
    pub(super) repos: Vec<Repo>,
    /// Parents whose sub-issue lists were read this round.
    pub(super) parents: Mutex<HashSet<String>>,
    /// Repos whose part of the round failed for good, and how; later phases skip them.
    pub(super) failed: Mutex<HashMap<i64, String>>,
}

impl Run {
    fn failed(&self) -> std::sync::MutexGuard<'_, HashMap<i64, String>> {
        self.failed.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The four phases, each over every repo still going before the next starts.
    async fn go(self: Arc<Self>) -> Result<(), String> {
        let started = std::time::Instant::now();
        eprintln!(
            "import: account {}: importing {} repo(s)",
            self.account,
            self.repos.len()
        );
        for phase in ImportPhase::ALL {
            self.progress(phase, 0);
            let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let gate = Arc::new(tokio::sync::Semaphore::new(STREAMS));
            // Jobs, so the drain stops (and waits for) each repo's task, not just the round.
            let mut tasks = self.app.jobs().set();
            for repo in self.repos.clone() {
                if self.failed().contains_key(&repo.id) {
                    continue;
                }
                let (run, done, gate) = (self.clone(), done.clone(), gate.clone());
                tasks.spawn(async move {
                    let _permit = gate.acquire_owned().await;
                    let result = run.phase(phase, &repo).await;
                    run.wait_note(&repo, None);
                    match result {
                        Ok(()) => {
                            let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                            run.progress(phase, n);
                        }
                        Err(e) => {
                            eprintln!(
                                "import: account {}: {} {phase:?}: {e}",
                                run.account,
                                repo.full_name()
                            );
                            run.failed().insert(repo.id, e.to_string());
                        }
                    }
                });
            }
            while let Some(r) = tasks.join_next().await {
                if let Err(e) = r {
                    eprintln!(
                        "import: account {}: a repo's {phase:?} panicked: {e}",
                        self.account
                    );
                }
            }
        }
        eprintln!(
            "import: account {}: {} of {} repo(s) imported in {} ms",
            self.account,
            self.repos.len() - self.failed().len(),
            self.repos.len(),
            started.elapsed().as_millis()
        );
        Ok(())
    }

    /// Finishes the repos that got through every phase and records a failure for the rest, each
    /// only if the import this round began is still the repo's. The failed ones, with when each
    /// is tried again. If the mirror can't record it, the failed ones are still tried again (after
    /// the first wait), and the finished ones stay `importing` there until the next reconcile
    /// resumes them.
    async fn settle(&self) -> HashMap<i64, Failed> {
        let failed = self.failed().clone();
        let repos = self.repos.clone();
        let (first, now) = (self.app.cfg().import_retry_after, crate::now());
        let at = move |wait: Duration| now + wait.as_secs().max(1) as i64;
        let written = self
            .app
            .mirrors()
            .write(self.account, Caller::Sweep, {
                let repos = repos.clone();
                let failed = failed.clone();
                move |tx, _| {
                    let mut out = HashMap::new();
                    for r in &repos {
                        if !failed.contains_key(&r.id) {
                            q::finish_repo_import(tx, r.id, r.started)?;
                            continue;
                        }
                        let failures = q::repo_state(tx, r.id)?.map_or(0, |s| s.import_failures);
                        let retry_at = at(retry_after(first, failures));
                        if q::fail_repo_import(tx, r.id, r.started, retry_at)? > 0 {
                            let name = r.full_name();
                            out.insert(r.id, Failed { name, retry_at });
                        }
                    }
                    Ok(out)
                }
            })
            .await;
        written.unwrap_or_else(|e| {
            eprintln!("import: account {}: finishing: {e}", self.account);
            repos
                .iter()
                .filter(|r| failed.contains_key(&r.id))
                .map(|r| {
                    let (name, retry_at) = (r.full_name(), at(first));
                    (r.id, Failed { name, retry_at })
                })
                .collect()
        })
    }

    async fn phase(&self, phase: ImportPhase, repo: &Repo) -> Result<(), CallError> {
        match phase {
            ImportPhase::OpenIssues => {
                self.labels_and_milestones(repo).await?;
                self.issues(repo, State::Open).await
            }
            ImportPhase::OpenPrs => self.pulls(repo, State::Open).await,
            ImportPhase::OpenComments => self.comments_of(repo, State::Open).await,
            ImportPhase::Closed => {
                self.issues(repo, State::Closed).await?;
                self.pulls(repo, State::Closed).await?;
                self.repo_comments(repo).await
            }
        }
    }

    /// The round's progress: `done` repos through `phase`.
    fn progress(&self, phase: ImportPhase, done: usize) {
        let of = self.repos.len();
        self.app.imports().update(&self.app, self.account, |a| {
            a.round = Some(Round { phase, done, of });
        });
    }

    /// Says (or, with `None`, stops saying) what GitHub holds `repo`'s stream up with.
    fn wait_note(&self, repo: &Repo, why: Option<String>) {
        self.app
            .imports()
            .update(&self.app, self.account, |a| match why {
                Some(w) => {
                    a.waits.insert(repo.id, w);
                }
                None => {
                    a.waits.remove(&repo.id);
                }
            });
    }

    /// Runs `call` with the installation's token until it passes or fails for good: a rate
    /// limit waits as asked, however long; a 5xx or an unanswered call backs off, up to
    /// [`TRANSIENT_TRIES`] tries or the config's `import_give_up_after`, then fails; and a 401
    /// mints a new token.
    async fn call<T, F, Fut>(&self, repo: &Repo, call: F) -> Result<T, CallError>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<T, CallError>>,
    {
        let mut backoff = Duration::from_secs(1);
        let mut secondary = SECONDARY_WAIT;
        let mut auth_tries = 0;
        // 5xx and network failures so far, and when the first came.
        let (mut transient, mut failing_since) = (0, None::<Instant>);
        loop {
            let installations = self.app.installations();
            let token = installations.token(repo.installation, Scope::Import).await;
            let out = match token {
                Ok(t) => match call(t.clone()).await {
                    Err(CallError::Unauthorized) => {
                        installations.drop_token(repo.installation, Scope::Import, &t);
                        Err(CallError::Unauthorized)
                    }
                    other => other,
                },
                Err(e) => Err(e.into()),
            };
            let wait = match out {
                Ok(v) => {
                    self.wait_note(repo, None);
                    return Ok(v);
                }
                Err(CallError::Unauthorized) if auth_tries + 1 < AUTH_TRIES => {
                    auth_tries += 1;
                    continue;
                }
                Err(CallError::RateLimited(wait)) => {
                    self.wait_note(repo, Some(rate_limit_note(wait)));
                    wait
                }
                Err(CallError::SecondaryLimit) => {
                    let wait = secondary;
                    secondary = (secondary * 2).min(MAX_SECONDARY_WAIT);
                    self.wait_note(repo, Some(rate_limit_note(wait)));
                    wait
                }
                Err(e) if e.is_transient() => {
                    transient += 1;
                    let since = *failing_since.get_or_insert_with(Instant::now);
                    if transient >= TRANSIENT_TRIES
                        || since.elapsed() >= self.app.cfg().import_give_up_after
                    {
                        self.wait_note(repo, None);
                        return Err(e);
                    }
                    self.wait_note(repo, Some("GitHub isn't answering · retrying".into()));
                    let w = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    w
                }
                Err(e) => {
                    self.wait_note(repo, None);
                    return Err(e);
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    pub(super) async fn graphql(
        &self,
        repo: &Repo,
        op: &'static str,
        query: &'static str,
        vars: Value,
    ) -> Result<Value, CallError> {
        let gh = self.app.github();
        self.call(repo, |token| {
            let vars = vars.clone();
            async move { gh.graphql_data(&token, op, query, vars).await }
        })
        .await
    }

    pub(super) async fn rest(&self, repo: &Repo, path: &str) -> Result<Value, CallError> {
        let gh = self.app.github();
        self.call(repo, |token| async move { gh.rest(&token, path).await })
            .await
    }

    /// One mirror transaction of `repo`'s rows, skipped if the repo is no longer synced
    /// (unsynced mid-import); its changed ids go to the account's tabs. A write that failed is
    /// logged as `what`; the page is lost to this round, and a later sweep or the next import
    /// finds it.
    pub(super) async fn write_page<F>(&self, repo: &Repo, what: &str, f: F)
    where
        F: FnOnce(&Transaction, i64) -> rusqlite::Result<Vec<i64>> + Send + 'static,
    {
        match write_synced(&self.app, self.account, Caller::Sweep, repo.id, f).await {
            Ok(ids) => publish(&self.app, self.account, ids),
            Err(e) => eprintln!("import: account {}: writing {what}: {e}", self.account),
        }
    }

    pub(super) async fn labels_and_milestones(&self, repo: &Repo) -> Result<(), CallError> {
        let base = format!("/repos/{}/{}", repo.owner, repo.name);
        let labels = self
            .all_pages(repo, &format!("{base}/labels?per_page=100"))
            .await?;
        let milestones = self
            .all_pages(repo, &format!("{base}/milestones?state=all&per_page=100"))
            .await?;
        let id = repo.id;
        self.write_page(repo, "labels and milestones", move |tx, _| {
            for l in &labels {
                let (Some(lid), Some(name)) = (l["id"].as_i64(), l["name"].as_str()) else {
                    continue;
                };
                q::upsert_label(
                    tx,
                    lid,
                    id,
                    name,
                    l["color"].as_str().unwrap_or(""),
                    l["description"].as_str(),
                )?;
            }
            for m in &milestones {
                let (Some(mid), Some(number), Some(title)) =
                    (m["id"].as_i64(), m["number"].as_i64(), m["title"].as_str())
                else {
                    continue;
                };
                q::upsert_milestone(
                    tx,
                    mid,
                    id,
                    number,
                    title,
                    m["state"].as_str().unwrap_or("open"),
                    m["due_on"].as_str().map(time),
                    m["updated_at"].as_str().map(time),
                )?;
            }
            Ok(Vec::new())
        })
        .await;
        Ok(())
    }

    /// Every page of a REST list that pages by `page` (`path` has its query string).
    pub(super) async fn all_pages(&self, repo: &Repo, path: &str) -> Result<Vec<Value>, CallError> {
        let mut out = Vec::new();
        for page in 1.. {
            let got = self.rest(repo, &format!("{path}&page={page}")).await?;
            let items = got.as_array().cloned().unwrap_or_default();
            let n = items.len();
            out.extend(items);
            if n < PAGE {
                break;
            }
        }
        Ok(out)
    }

    /// Phases 1 and 4: the repo's issues in `state`.
    pub(super) async fn issues(&self, repo: &Repo, state: State) -> Result<(), CallError> {
        let mut after: Option<String> = None;
        loop {
            let data = self
                .graphql(
                    repo,
                    "ImportIssues",
                    IMPORT_ISSUES,
                    json!({ "owner": repo.owner, "name": repo.name, "states": [state.graphql()], "after": after }),
                )
                .await?;
            let conn = &data["repository"]["issues"];
            if conn.is_null() {
                return Err(CallError::NotFound);
            }
            let page: Conn<GqlIssue> = serde_json::from_value(conn.clone())
                .map_err(|e| CallError::Malformed(e.to_string()))?;
            let issues: Vec<GqlIssue> = page.nodes.into_iter().flatten().collect();
            self.issue_page(repo, issues).await?;
            match page.page_info {
                Some(p) if p.has_next_page && p.end_cursor.is_some() => after = p.end_cursor,
                _ => return Ok(()),
            }
        }
    }

    /// Writes a page of issues, then their relationships.
    pub(super) async fn issue_page(
        &self,
        repo: &Repo,
        issues: Vec<GqlIssue>,
    ) -> Result<(), CallError> {
        // Whose sub-issue and dependency lists to read: issues with any, and each parent.
        let mut ends: HashMap<String, Target> = HashMap::new();
        let mut lists = Vec::new();
        let mut more_relates = Vec::new();
        {
            let mut seen = self.parents.lock().unwrap_or_else(|e| e.into_inner());
            for i in &issues {
                let me = i.target(repo);
                let deps = i.issue_dependencies_summary.as_ref();
                let has = i.sub_issues_summary.as_ref().is_some_and(|s| s.total > 0)
                    || deps.is_some_and(|d| d.total_blocked_by > 0 || d.total_blocking > 0);
                if has && seen.insert(i.id.clone()) {
                    lists.push(i.id.clone());
                }
                if let Some(p) = &i.parent
                    && seen.insert(p.id.clone())
                {
                    lists.push(p.id.clone());
                    ends.insert(p.id.clone(), p.clone());
                }
                ends.insert(i.id.clone(), me);
                if let Some(info) = i.relates_to.as_ref().and_then(|r| r.page_info.clone())
                    && info.has_next_page
                {
                    more_relates.push((i.target(repo), info));
                }
            }
        }
        let mut items: Vec<ItemData> = issues.iter().map(ItemData::from_graphql).collect();
        // Labels past the first 100, before the issue is written with its whole set.
        for (i, it) in issues.iter().zip(items.iter_mut()) {
            if let Some(info) = i.labels.page_info.clone() {
                let more: Vec<Named> = self
                    .remaining_pages(repo, ("ImportLabels", IMPORT_LABELS), &i.id, "labels", info)
                    .await?;
                it.labels.extend(more.into_iter().map(|n| n.name));
            }
        }
        let relates: Vec<(Target, Vec<Target>)> = issues
            .iter()
            .map(|i| {
                let to = i
                    .relates_to
                    .as_ref()
                    .map(|r| r.nodes.iter().flatten().cloned().collect())
                    .unwrap_or_default();
                (i.target(repo), to)
            })
            .collect();
        let id = repo.id;
        self.write_page(repo, "issues", move |tx, seq| {
            let mut changed = Vec::new();
            for it in &items {
                if write_item(tx, seq, id, it)? {
                    changed.push(it.id);
                }
            }
            for (me, others) in &relates {
                for o in others {
                    changed.extend(write_relationship(tx, seq, Kind::Relates, me, o, None)?);
                }
            }
            Ok(changed)
        })
        .await;
        for chunk in lists.chunks(PAGE) {
            self.relationships(repo, chunk, &ends).await?;
        }
        // Relates-to past the first 50.
        for (me, info) in more_relates {
            let others: Vec<Target> = self
                .remaining_pages(
                    repo,
                    ("ImportRelatesTo", IMPORT_RELATES_TO),
                    &me.id,
                    "relatesTo",
                    info,
                )
                .await?;
            self.write_page(repo, "relates-to", move |tx, seq| {
                let mut changed = Vec::new();
                for o in &others {
                    changed.extend(write_relationship(tx, seq, Kind::Relates, &me, o, None)?);
                }
                Ok(changed)
            })
            .await;
        }
        Ok(())
    }

    /// The sub-issue and dependency lists of the issues `ids` names.
    pub(super) async fn relationships(
        &self,
        repo: &Repo,
        ids: &[String],
        ends: &HashMap<String, Target>,
    ) -> Result<(), CallError> {
        let data = self
            .graphql(
                repo,
                "ImportRelationships",
                IMPORT_RELATIONSHIPS,
                json!({ "ids": ids }),
            )
            .await?;
        let nodes: Vec<Option<RelationshipLists>> =
            serde_json::from_value(data["nodes"].clone())
                .map_err(|e| CallError::Malformed(e.to_string()))?;
        let mut writes = Vec::new();
        for n in nodes.into_iter().flatten() {
            let Some(me) = ends.get(&n.id).cloned() else {
                continue;
            };
            writes.push((me, n));
        }
        self.write_page(repo, "relationships", move |tx, seq| {
            let mut changed = Vec::new();
            for (me, n) in &writes {
                let subs = n
                    .sub_issues
                    .as_ref()
                    .map(|c| c.nodes.iter().flatten().collect::<Vec<_>>());
                for (i, child) in subs.unwrap_or_default().into_iter().enumerate() {
                    changed.extend(write_relationship(
                        tx,
                        seq,
                        Kind::Sub,
                        me,
                        child,
                        Some(i as f64 + 1.0),
                    )?);
                }
                for b in n.blocked_by.iter().flat_map(|c| c.nodes.iter().flatten()) {
                    changed.extend(write_relationship(tx, seq, Kind::Blocks, b, me, None)?);
                }
                for b in n.blocking.iter().flat_map(|c| c.nodes.iter().flatten()) {
                    changed.extend(write_relationship(tx, seq, Kind::Blocks, me, b, None)?);
                }
            }
            Ok(changed)
        })
        .await;
        Ok(())
    }

    /// The rest of a node's connection `field` past its first page (`info`), a page at a time
    /// through `op` (its name and document), which asks `node(id:)` for `field` after a cursor.
    async fn remaining_pages<T: serde::de::DeserializeOwned>(
        &self,
        repo: &Repo,
        op: (&'static str, &'static str),
        id: &str,
        field: &str,
        mut info: PageInfo,
    ) -> Result<Vec<T>, CallError> {
        let mut out = Vec::new();
        while let PageInfo {
            has_next_page: true,
            end_cursor: Some(after),
        } = info
        {
            let data = self
                .graphql(repo, op.0, op.1, json!({ "id": id, "after": after }))
                .await?;
            let conn: Conn<T> = serde_json::from_value(data["node"][field].clone())
                .map_err(|e| CallError::Malformed(e.to_string()))?;
            out.extend(conn.nodes.into_iter().flatten());
            match conn.page_info {
                Some(next) => info = next,
                None => break,
            }
        }
        Ok(out)
    }

    /// Phases 2 and 4: the repo's PRs in `state`, from REST's issue list (which has the
    /// issue-side ids) and their details from GraphQL.
    pub(super) async fn pulls(&self, repo: &Repo, state: State) -> Result<(), CallError> {
        let base = format!(
            "/repos/{}/{}/issues?state={}&sort=updated&direction=asc&per_page=100",
            repo.owner,
            repo.name,
            state.as_str()
        );
        // Paged on `since`, so an item updated meanwhile moves later instead of shifting the
        // pages under the walk; `page` only steps through a page-full of one time. REST's `since`
        // is exclusive: it's asked a second early (`since_param`), so the rest of that second
        // comes again rather than not at all.
        let mut since: Option<String> = None;
        let mut page = 1;
        loop {
            let path = match &since {
                Some(s) => format!("{base}&since={}&page={page}", since_param(s)),
                None => format!("{base}&page={page}"),
            };
            let got = self.rest(repo, &path).await?;
            let items: Vec<RestIssue> =
                serde_json::from_value(got).map_err(|e| CallError::Malformed(e.to_string()))?;
            let n = items.len();
            let last = items.last().map(|i| i.updated_at.clone());
            let prs: Vec<RestIssue> = items
                .into_iter()
                .filter(|i| i.pull_request.is_some())
                .collect();
            if !prs.is_empty() {
                self.pull_page(repo, prs).await?;
            }
            if n < PAGE {
                return Ok(());
            }
            if last == since {
                page += 1;
            } else {
                since = last;
                page = 1;
            }
        }
    }

    pub(super) async fn pull_page(
        &self,
        repo: &Repo,
        prs: Vec<RestIssue>,
    ) -> Result<(), CallError> {
        let ids: Vec<&str> = prs.iter().map(|p| p.node_id.as_str()).collect();
        let data = self
            .graphql(
                repo,
                "ImportPullDetails",
                IMPORT_PULL_DETAILS,
                json!({ "ids": ids }),
            )
            .await?;
        let details: Vec<Option<PullDetails>> = serde_json::from_value(data["nodes"].clone())
            .map_err(|e| CallError::Malformed(e.to_string()))?;
        let by_node: HashMap<String, PullDetails> = details
            .into_iter()
            .flatten()
            .map(|d| (d.id.clone(), d))
            .collect();
        let mut items = Vec::new();
        let mut closes = Vec::new();
        for p in &prs {
            // Without its details the PR has no id of its own to store: skipped, for a sweep.
            let Some((d, pr_id)) = by_node
                .get(&p.node_id)
                .and_then(|d| Some((d, d.database_id?)))
            else {
                eprintln!(
                    "import: account {}: {} #{}: no PR details; skipped",
                    self.account,
                    repo.full_name(),
                    p.number
                );
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
            let me = it.target(repo);
            let refs = d.closing_issues_references.as_ref();
            let mut targets: Vec<Target> = refs
                .map(|c| c.nodes.iter().flatten().cloned().collect())
                .unwrap_or_default();
            if let Some(info) = refs.and_then(|c| c.page_info.clone()) {
                targets.extend(
                    self.remaining_pages::<Target>(
                        repo,
                        ("ImportClosingRefs", IMPORT_CLOSING_REFS),
                        &d.id,
                        "closingIssuesReferences",
                        info,
                    )
                    .await?,
                );
            }
            closes.extend(targets.into_iter().map(|t| (me.clone(), t)));
            items.push(it);
        }
        let id = repo.id;
        self.write_page(repo, "PRs", move |tx, seq| {
            let mut changed = Vec::new();
            for it in &items {
                if write_item(tx, seq, id, it)? {
                    changed.push(it.id);
                }
            }
            for (pr, issue) in &closes {
                changed.extend(write_linked_pr(tx, seq, pr, issue)?);
            }
            Ok(changed)
        })
        .await;
        Ok(())
    }

    /// Phase 3: comments on the repo's items in `state` that the mirror lacks.
    pub(super) async fn comments_of(&self, repo: &Repo, state: State) -> Result<(), CallError> {
        let id = repo.id;
        let todo = self
            .app
            .mirrors()
            .read(self.account, Caller::Sweep, move |c| {
                q::items_missing_comments(c, &[id], state.as_str())
            })
            .await
            .map_err(|e| CallError::Malformed(e.to_string()))?;
        for chunk in todo.chunks(PAGE) {
            let ids: Vec<&str> = chunk.iter().map(|r| r.node_id.as_str()).collect();
            let item_of: HashMap<String, i64> =
                chunk.iter().map(|r| (r.node_id.clone(), r.id)).collect();
            let data = self
                .graphql(
                    repo,
                    "ImportComments",
                    IMPORT_COMMENTS,
                    json!({ "ids": ids }),
                )
                .await?;
            let nodes: Vec<Option<WithComments>> = serde_json::from_value(data["nodes"].clone())
                .map_err(|e| CallError::Malformed(e.to_string()))?;
            let mut writes = Vec::new();
            let mut more = Vec::new();
            for n in nodes.into_iter().flatten() {
                let Some(&item) = item_of.get(&n.id) else {
                    continue;
                };
                if let Some(p) = &n.comments.page_info
                    && p.has_next_page
                {
                    more.push((n.id.clone(), item, p.end_cursor.clone()));
                }
                writes.extend(n.comments.nodes.into_iter().flatten().map(|c| (item, c)));
            }
            self.write_comments(repo, writes).await;
            for (node, item, mut after) in more {
                while let Some(a) = after {
                    let data = self
                        .graphql(
                            repo,
                            "ImportMoreComments",
                            IMPORT_MORE_COMMENTS,
                            json!({ "id": node, "after": a }),
                        )
                        .await?;
                    let conn: Conn<GqlComment> =
                        serde_json::from_value(data["node"]["comments"].clone())
                            .map_err(|e| CallError::Malformed(e.to_string()))?;
                    after = conn
                        .page_info
                        .filter(|p| p.has_next_page)
                        .and_then(|p| p.end_cursor);
                    let writes = conn
                        .nodes
                        .into_iter()
                        .flatten()
                        .map(|c| (item, c))
                        .collect();
                    self.write_comments(repo, writes).await;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn write_comments(&self, repo: &Repo, writes: Vec<(i64, GqlComment)>) {
        let comments: Vec<CommentData> = writes
            .into_iter()
            .map(|(item, c)| CommentData::from_graphql(item, c))
            .collect();
        self.write_page(repo, "comments", move |tx, seq| {
            write_comments(tx, seq, &comments)
        })
        .await;
    }

    /// Phase 4's last step: every comment in the repo, through the REST pass, for the closed
    /// items' threads (the open ones' are there already, and come back unchanged).
    pub(super) async fn repo_comments(&self, repo: &Repo) -> Result<(), CallError> {
        // The pass lists every comment in the repo (GitHub filters it by nothing but time), so
        // only the threads still short are written: the closed items' (phase 3 read the open
        // ones'), less any a webhook or an opened issue completed. None short, no pass.
        let id = repo.id;
        let todo: HashSet<i64> = self
            .app
            .mirrors()
            .read(self.account, Caller::Sweep, move |c| {
                q::items_missing_comments(c, &[id], State::Closed.as_str())
            })
            .await
            .map_err(|e| CallError::Malformed(e.to_string()))?
            .into_iter()
            .map(|r| r.id)
            .collect();
        if todo.is_empty() {
            return Ok(());
        }
        let todo = Arc::new(todo);
        let base = format!(
            "/repos/{}/{}/issues/comments?sort=updated&direction=asc&per_page=100",
            repo.owner, repo.name
        );
        let mut since: Option<String> = None;
        let mut page = 1;
        loop {
            let path = match &since {
                Some(s) => format!("{base}&since={}&page={page}", since_param(s)),
                None => format!("{base}&page={page}"),
            };
            let got = self.rest(repo, &path).await?;
            let items: Vec<RestComment> =
                serde_json::from_value(got).map_err(|e| CallError::Malformed(e.to_string()))?;
            let n = items.len();
            let last = items.last().map(|c| c.updated_at.clone());
            let todo = todo.clone();
            self.write_page(repo, "comments", move |tx, seq| {
                let mut comments = Vec::new();
                for c in items {
                    let Some(number) = c.number() else { continue };
                    match q::item_by_number(tx, id, number)? {
                        Some(i) if !i.is_stub && todo.contains(&i.id) => {
                            comments.push(CommentData::from_rest(i.id, c))
                        }
                        _ => {}
                    }
                }
                write_comments(tx, seq, &comments)
            })
            .await;
            if n < PAGE {
                return Ok(());
            }
            if last == since {
                page += 1;
            } else {
                since = last;
                page = 1;
            }
        }
    }
}
