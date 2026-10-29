//! The two runs. The read run sends the read side of Fake GitHub's request set (the App's own
//! calls, REST and GraphQL reads with a read-only installation token, the App's webhook
//! deliveries, and the user-token half) to busy repos. The write run makes each of beghu's writes
//! on the sandbox and undoes it in the same run, then checks the sandbox is as it found it.

use crate::check::{Checker, Mode};

use crate::http::{Answer, Extra, Http};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Where a run points and with what.
#[derive(Debug, Clone)]
pub struct Setup {
    pub mode: Mode,
    /// GitHub's API origin (or a Fake GitHub's).
    pub api: String,
    /// GitHub's web origin, for the OAuth error shapes.
    pub web: String,
    /// The App's id and private key (PEM): `beghu-ci` in CI, the dev App by hand, Fake
    /// GitHub's dev App against the fake.
    pub app_id: String,
    pub app_key: String,
    /// `owner/name`s the read run reads: busy repos with real traffic. The first gets every read.
    pub repos: Vec<String>,
    /// `owner/name` of the sandbox: the only repo written to, where the drift issue lives.
    pub sandbox: String,
    /// The machine user's token, for the user-token half (none: skipped).
    pub user_token: Option<String>,
    /// The App's OAuth client, for the token endpoint's error shapes (none: skipped).
    pub oauth_client: Option<(String, String)>,
    /// A user token the write run writes with instead of an installation token narrowed to the
    /// sandbox: against Fake GitHub, which doesn't model an App writing as itself.
    pub write_token: Option<String>,
    /// How far back the read run reads the App's deliveries, in seconds (GitHub keeps 3 days).
    pub deliveries_for: i64,
}

impl Setup {
    /// Against the Fake GitHub at `url` (API and web): its dev App, whose key is public; the
    /// fixture's `acme/web` and `acme/api` read, `acme/web` the sandbox; and `login` (a fixture
    /// account) signed in through the fake's OAuth with `client`, for the user-token half and
    /// the writes (the fake doesn't model an App writing as itself).
    pub async fn against_fake(
        url: &str,
        login: &str,
        client: (&str, &str),
    ) -> Result<Setup, String> {
        let url = url.trim_end_matches('/').to_owned();
        let token = Http::new(&url, &url)
            .fake_sign_in(login, client.0, client.1)
            .await
            .map_err(|e| format!("signing in to the fake as {login}: {e}"))?;
        Ok(Setup {
            mode: Mode::Fake,
            api: url.clone(),
            web: url,
            app_id: "1000001".into(),
            app_key: include_str!("../../fake-github/src/dev-app-key.pem").into(),
            repos: vec!["acme/web".into(), "acme/api".into()],
            sandbox: "acme/web".into(),
            user_token: Some(token.clone()),
            oauth_client: Some((client.0.into(), client.1.into())),
            write_token: Some(token),
            deliveries_for: 3 * 24 * 3600,
        })
    }
}

/// The fixture issue the write run edits and puts back: found by its title.
pub const FIXTURE_TITLE: &str = "[contract] fixture issue";
const FIXTURE_BODY: &str = "Kept by beghu's contract check (`crates/contract`): each write run \
edits this issue and undoes every edit in the same run. Leave it open and as it is.";
/// The fixture issues the relationship writes link the fixture issue to, and unlink.
pub const CHILD_TITLES: [&str; 2] = ["[contract] fixture child 1", "[contract] fixture child 2"];
/// The prefix of the issue each write run opens, then closes as not planned.
pub const CREATED_PREFIX: &str = "[contract] created";
/// The prefix of the label each write run asks for that the repo doesn't have.
const UNKNOWN_LABEL: &str = "contract-check-";
/// What marks the comment each write run posts, then deletes.
const COMMENT_MARK: &str = "<!-- beghu contract check -->";

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// `secs` since the Unix epoch as GitHub writes times: `2026-10-28T03:00:00Z`.
pub fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// How a report names a repo: the sandbox by its name, a repo read by its place in the list.
/// The busy repos may be private, and the report and the log are public.
pub fn shown(setup: &Setup, full: &str) -> String {
    match setup.repos.iter().position(|r| r == full) {
        _ if full == setup.sandbox => full.to_owned(),
        Some(i) => format!("repo {} of CONTRACT_REPOS", i + 1),
        None => "a repo".to_owned(),
    }
}

fn split(full: &str) -> Result<(&str, &str), String> {
    full.split_once('/')
        .filter(|(o, n)| !o.is_empty() && !n.is_empty())
        .ok_or_else(|| format!("{full:?} isn't owner/name"))
}

/// The App's side: a JWT, and installation tokens minted with it.
struct App<'a> {
    setup: &'a Setup,
    http: &'a Http,
}

impl App<'_> {
    fn jwt(&self) -> Result<String, String> {
        beghu::app_jwt(&self.setup.app_id, &self.setup.app_key)
    }

    /// The installation that covers `full`, checked as `app.repo_installation`.
    async fn installation(&self, c: &mut Checker, full: &str) -> Result<i64, String> {
        let (o, n) = split(full)?;
        let a = self
            .http
            .get(&format!("/repos/{o}/{n}/installation"), &self.jwt()?)
            .await?;
        c.answer(
            "app.repo_installation",
            "GET /repos/{owner}/{repo}/installation",
            &a,
        );
        a.body["id"].as_i64().ok_or_else(|| {
            format!(
                "the App isn't installed on {} (answered {})",
                shown(self.setup, full),
                a.status
            )
        })
    }

    /// A token for `installation`, narrowed to `repos` (names) and `permissions`, checked as
    /// `app.access_token`. GitHub enforces both narrowings, so a bug here can't write elsewhere.
    async fn token(
        &self,
        c: &mut Checker,
        installation: i64,
        repos: &[&str],
        permissions: Value,
    ) -> Result<String, String> {
        let body = json!({ "repositories": repos, "permissions": permissions });
        let a = self
            .http
            .call(
                Method::POST,
                &format!("/app/installations/{installation}/access_tokens"),
                Some(&self.jwt()?),
                Extra {
                    body: Some(&body),
                    ..Extra::default()
                },
            )
            .await?;
        c.answer(
            "app.access_token",
            "POST /app/installations/{installation_id}/access_tokens",
            &a,
        );
        a.body["token"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("minting a token answered {}: {}", a.status, a.body))
    }
}

/// The events the App manifest subscribes to (`github-app/manifest.json`).
fn manifest_events() -> Vec<String> {
    let m: Value = serde_json::from_str(include_str!("../../../github-app/manifest.json"))
        .unwrap_or(Value::Null);
    m["default_events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e.as_str().map(str::to_owned))
        .collect()
}

/// The read run. `Err` is a failure to get going at all (no App, no token).
pub async fn read(setup: &Setup, c: &mut Checker) -> Result<(), String> {
    let http = Http::new(&setup.api, &setup.web);
    let app = App { setup, http: &http };
    let first = setup
        .repos
        .first()
        .ok_or("the read run needs a repo to read")?
        .clone();

    // The App itself, and whether it has every event the manifest asks for.
    let a = http.get("/app", &app.jwt()?).await?;
    c.answer("app.get", "GET /app", &a);
    let has: Vec<&str> = a.body["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let lacking: Vec<String> = manifest_events()
        .into_iter()
        .filter(|e| !has.contains(&e.as_str()))
        .collect();
    if !lacking.is_empty() {
        c.note(format!(
            "the App isn't subscribed to {} (github-app/manifest.json asks for it): its deliveries never arrive",
            lacking.join(", ")
        ));
    }

    // A read-only token per installation, narrowed to the repos read.
    // The sandbox too: SweepCounts reads it by the node id the user half finds.
    let mut read: Vec<String> = setup.repos.clone();
    if !read.contains(&setup.sandbox) {
        read.push(setup.sandbox.clone());
    }
    let mut by_installation: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for full in &read {
        let i = app.installation(c, full).await?;
        by_installation
            .entry(i)
            .or_default()
            .push(split(full)?.1.to_owned());
    }
    let read_only = json!({ "issues": "read", "pull_requests": "read", "metadata": "read" });
    let mut tokens: BTreeMap<String, String> = BTreeMap::new();
    for (i, names) in &by_installation {
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let t = app.token(c, *i, &refs, read_only.clone()).await?;
        for full in &read {
            if names
                .iter()
                .any(|n| split(full).map(|(_, x)| x == n).unwrap_or(false))
            {
                tokens.insert(full.clone(), t.clone());
            }
        }
    }

    let token = tokens[&first].clone();
    let picked = rest_reads(&http, c, &first, &token).await?;
    for full in setup.repos.iter().skip(1) {
        let (o, n) = split(full)?;
        let t = &tokens[full];
        let a = http
            .get(
                &format!(
                    "/repos/{o}/{n}/issues?state=all&sort=updated&direction=asc&per_page=100{}",
                    recent(c.mode)
                ),
                t,
            )
            .await?;
        c.answer("rest.issues", "GET /repos/{owner}/{repo}/issues", &a);
        let a = http
            .get(&format!("/repos/{o}/{n}/issues/events?per_page=100"), t)
            .await?;
        c.answer(
            "rest.issue_events",
            "GET /repos/{owner}/{repo}/issues/events",
            &a,
        );
    }

    // Whether a token narrowed to issues alone may read a PR through the issues API
    // (docs/research/contract-check-shapes.md): beghu asks for pull_requests too, so either
    // answer works; this records which it is.
    if let Some(pr) = picked.pr {
        let (o, n) = split(&first)?;
        let i = app.installation(c, &first).await?;
        let t = app.token(c, i, &[n], json!({ "issues": "read" })).await?;
        let a = http.get(&format!("/repos/{o}/{n}/issues/{pr}"), &t).await?;
        c.note(format!(
            "a token with issues: read alone reading a PR through `GET /repos/{{owner}}/{{repo}}/issues/{{number}}` answers {}",
            a.status
        ));
    }

    let mut picked = picked;
    picked.repo_node = user_half(&http, c, setup).await?;
    graphql_reads(&http, c, &first, &token, &picked).await?;
    deliveries(&http, &app, c, setup.deliveries_for).await?;
    Ok(())
}

/// The `since` the lists are read with, as beghu reads them (oldest change first): on GitHub, the
/// last 30 days', so the reads see today's fields in use; Fake GitHub's fixture is all older.
fn recent(mode: Mode) -> String {
    match mode {
        Mode::GitHub => format!("&since={}", rfc3339(now() - 30 * 86_400)),
        Mode::Fake => String::new(),
    }
}

/// What the REST reads found to read further with.
#[derive(Default)]
struct Picked {
    repo_node: Option<String>,
    issue_nodes: Vec<String>,
    pr_nodes: Vec<String>,
    pr: Option<i64>,
}

async fn rest_reads(http: &Http, c: &mut Checker, full: &str, t: &str) -> Result<Picked, String> {
    let (o, n) = split(full)?;
    let base = format!("/repos/{o}/{n}");
    let mut picked = Picked::default();

    let list = format!(
        "{base}/issues?state=all&sort=updated&direction=asc&per_page=100{}",
        recent(c.mode)
    );
    let a = http.get(&list, t).await?;
    c.answer("rest.issues", "GET /repos/{owner}/{repo}/issues", &a);
    if let Some(etag) = &a.etag {
        let again = http
            .call(
                Method::GET,
                &list,
                Some(t),
                Extra {
                    if_none_match: Some(etag),
                    ..Extra::default()
                },
            )
            .await?;
        c.answer(
            "rest.issues_not_modified",
            "GET /repos/{owner}/{repo}/issues (If-None-Match)",
            &again,
        );
    } else {
        c.note("`GET /repos/{owner}/{repo}/issues` came without an ETag");
    }
    let items: Vec<Value> = a.body.as_array().cloned().unwrap_or_default();
    let is_pr = |i: &Value| i.get("pull_request").is_some();
    for i in &items {
        let node = i["node_id"].as_str().map(str::to_owned);
        match (is_pr(i), node) {
            (true, Some(nd)) if picked.pr_nodes.len() < 20 => picked.pr_nodes.push(nd),
            (false, Some(nd)) if picked.issue_nodes.len() < 20 => picked.issue_nodes.push(nd),
            _ => {}
        }
    }
    picked.pr = items
        .iter()
        .find(|i| is_pr(i))
        .and_then(|i| i["number"].as_i64());
    // An issue with comments, if there is one.
    let issue = items
        .iter()
        .filter(|i| !is_pr(i))
        .max_by_key(|i| i["comments"].as_i64().unwrap_or(0).min(1))
        .and_then(|i| i["number"].as_i64());

    if let Some(num) = issue {
        let a = http.get(&format!("{base}/issues/{num}"), t).await?;
        c.answer(
            "rest.issue",
            "GET /repos/{owner}/{repo}/issues/{number}",
            &a,
        );
        let a = http
            .call(
                Method::GET,
                &format!("{base}/issues/{num}"),
                Some(t),
                Extra {
                    accept: Some("application/vnd.github.html+json"),
                    ..Extra::default()
                },
            )
            .await?;
        c.answer(
            "rest.issue_html",
            "GET /repos/{owner}/{repo}/issues/{number} (html)",
            &a,
        );
        let a = http
            .get(&format!("{base}/issues/{num}/comments?per_page=100"), t)
            .await?;
        c.answer(
            "rest.issue_comments",
            "GET /repos/{owner}/{repo}/issues/{number}/comments",
            &a,
        );
    } else {
        c.note("the first repo read has no issue to read");
    }
    if let Some(pr) = picked.pr {
        let a = http.get(&format!("{base}/issues/{pr}"), t).await?;
        c.answer(
            "rest.pull_as_issue",
            "GET /repos/{owner}/{repo}/issues/{number} (a PR)",
            &a,
        );
    }
    let a = http
        .get(
            &format!(
                "{base}/issues/comments?sort=updated&direction=asc&per_page=100{}",
                recent(c.mode)
            ),
            t,
        )
        .await?;
    c.answer(
        "rest.repo_comments",
        "GET /repos/{owner}/{repo}/issues/comments",
        &a,
    );
    if let Some(id) = a.body[0]["id"].as_i64() {
        let a = http.get(&format!("{base}/issues/comments/{id}"), t).await?;
        c.answer(
            "rest.comment",
            "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
            &a,
        );
    }
    for (name, path, request) in [
        (
            "rest.labels",
            format!("{base}/labels?per_page=100"),
            "GET /repos/{owner}/{repo}/labels",
        ),
        (
            "rest.milestones",
            format!("{base}/milestones?state=all&per_page=100"),
            "GET /repos/{owner}/{repo}/milestones",
        ),
        (
            "rest.assignees",
            format!("{base}/assignees?per_page=100"),
            "GET /repos/{owner}/{repo}/assignees",
        ),
        (
            "rest.issue_events",
            format!("{base}/issues/events?per_page=100"),
            "GET /repos/{owner}/{repo}/issues/events",
        ),
        (
            "rest.rate_limit",
            "/rate_limit".to_owned(),
            "GET /rate_limit",
        ),
    ] {
        let a = http.get(&path, t).await?;
        c.answer(name, request, &a);
    }
    // The error shape for a token GitHub doesn't know.
    let a = http
        .get(
            &format!("{base}/labels"),
            "ghs_contractCheckNotAToken000000000000",
        )
        .await?;
    c.answer(
        "rest.bad_token",
        "GET /repos/{owner}/{repo}/labels (bad token)",
        &a,
    );
    Ok(picked)
}

async fn graphql_reads(
    http: &Http,
    c: &mut Checker,
    full: &str,
    t: &str,
    p: &Picked,
) -> Result<(), String> {
    let (o, n) = split(full)?;
    let docs: BTreeMap<&str, &str> = beghu::GRAPHQL_DOCUMENTS.into_iter().collect();
    let issue = p.issue_nodes.first();
    let pr = p.pr_nodes.first();
    let mut more_comments: Option<(String, String)> = None;
    for (op, query) in beghu::GRAPHQL_DOCUMENTS {
        let vars = match op {
            "ImportIssues" => json!({ "owner": o, "name": n, "states": ["OPEN"], "after": null }),
            "SweepIssueIds" | "SweepPullIds" => json!({ "owner": o, "name": n, "after": null }),
            "SweepCounts" => match &p.repo_node {
                Some(r) => json!({ "ids": [r] }),
                None => {
                    c.note("no repo node id (the user-token half didn't run): SweepCounts skipped");
                    continue;
                }
            },
            "ImportRelationships" | "ImportComments" | "MintAttachments" => {
                json!({ "ids": p.issue_nodes })
            }
            "SweepEdges" => {
                json!({ "ids": p.issue_nodes, "sub": true, "blocks": true, "relates": true })
            }
            "IssueEdges" => match issue {
                Some(i) => {
                    json!({ "id": i, "sub": true, "blocks": true, "relates": true, "relatesAfter": null })
                }
                None => continue,
            },
            "ImportRelatesTo" | "ImportLabels" | "IssueLinkedPulls" => match issue {
                Some(i) => json!({ "id": i, "after": null }),
                None => continue,
            },
            "ImportPullDetails" => {
                if p.pr_nodes.is_empty() {
                    continue;
                }
                json!({ "ids": p.pr_nodes })
            }
            "PullReadBack" | "ImportClosingRefs" => match pr {
                Some(x) => json!({ "id": x, "after": null }),
                None => continue,
            },
            // After ImportComments, from the page it handed back.
            "ImportMoreComments" => continue,
            other => {
                c.note(format!(
                    "the contract check doesn't know the variables of {other}"
                ));
                continue;
            }
        };
        let a = http.graphql(t, query, vars).await?;
        if op == "ImportComments" {
            more_comments = a.body["data"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|nd| {
                    let after = nd["comments"]["pageInfo"]["endCursor"].as_str()?;
                    Some((nd["id"].as_str()?.to_owned(), after.to_owned()))
                });
        }
        c.graphql(op, &a);
    }
    match more_comments {
        Some((id, after)) => {
            let a = http
                .graphql(
                    t,
                    docs["ImportMoreComments"],
                    json!({ "id": id, "after": after }),
                )
                .await?;
            c.graphql("ImportMoreComments", &a);
        }
        None => c.note("no comment page to read on from with ImportMoreComments"),
    }
    Ok(())
}

/// The App's webhook deliveries: the listing, and the newest delivery of each event and action
/// with its payload, checked against `webhook.<event>.<action>`.
async fn deliveries(http: &Http, app: &App<'_>, c: &mut Checker, since: i64) -> Result<(), String> {
    let oldest = rfc3339(now() - since);
    // Recording takes up to ten of each, so a template sees each one's variety (an `edited`
    // with a title change and one with a body change); checking needs only the newest.
    let per_pair = if c.recording { 10 } else { 1 };
    let mut newest: BTreeMap<String, Vec<(i64, String)>> = BTreeMap::new();
    let mut next = Some("/app/hook/deliveries?per_page=100".to_owned());
    let mut first = true;
    let mut pages = 0;
    while let Some(path) = next.take() {
        pages += 1;
        let a = http.get(&path, &app.jwt()?).await?;
        if first {
            c.answer("app.hook_deliveries", "GET /app/hook/deliveries", &a);
            first = false;
        }
        let items = a.body.as_array().cloned().unwrap_or_default();
        let mut older = false;
        for d in &items {
            let at = d["delivered_at"].as_str().unwrap_or_default().to_owned();
            if at < oldest {
                older = true;
                continue;
            }
            let pair = match (d["event"].as_str(), d["action"].as_str()) {
                (Some(e), Some(a)) => format!("{e}.{a}"),
                (Some(e), None) => e.to_owned(),
                _ => continue,
            };
            let id = d["id"].as_i64().unwrap_or_default();
            // The log lists newest first.
            let kept = newest.entry(pair).or_default();
            if kept.len() < per_pair {
                kept.push((id, at));
            }
        }
        // Thirty pages of a hundred is plenty of a night's deliveries for a few repos.
        if !older && pages < 30 {
            next = a.next;
        }
    }
    for (pair, (id, at)) in newest
        .into_iter()
        .flat_map(|(p, ds)| ds.into_iter().map(move |d| (p.clone(), d)))
    {
        let a = http
            .get(&format!("/app/hook/deliveries/{id}"), &app.jwt()?)
            .await?;
        let payload = a.body["request"]["payload"].clone();
        let mut envelope = a.body.clone();
        if let Some(r) = envelope["request"].as_object_mut() {
            // Checked on its own below, as the event's payload.
            r.remove("payload");
        }
        c.body(
            "app.hook_delivery",
            "GET /app/hook/deliveries/{delivery_id}",
            a.status,
            &envelope,
        );
        c.body(
            &format!("webhook.{pair}"),
            &format!("webhook {pair}"),
            200,
            &payload,
        );
        if c.found.seen.get(&pair).is_none_or(|seen| *seen < at) {
            c.found.seen.insert(pair, at);
        }
    }
    Ok(())
}

/// The user-token half: who the user is, the installations and repos they reach, the sandbox as
/// beghu reads a repo, and the token endpoint's errors. The sandbox's node id, when it was read.
async fn user_half(http: &Http, c: &mut Checker, setup: &Setup) -> Result<Option<String>, String> {
    let mut repo_node = None;
    if let Some(t) = &setup.user_token {
        let a = http.get("/user", t).await?;
        c.answer("user.get", "GET /user", &a);
        let a = http.get("/user/installations?per_page=100", t).await?;
        c.answer("user.installations", "GET /user/installations", &a);
        if let Some(id) = a.body["installations"][0]["id"].as_i64() {
            let a = http
                .get(
                    &format!("/user/installations/{id}/repositories?per_page=100"),
                    t,
                )
                .await?;
            c.answer(
                "user.installation_repos",
                "GET /user/installations/{installation_id}/repositories",
                &a,
            );
        }
        // As beghu reads a repo: with the user's token, for its archived flag and the role.
        let (o, n) = split(&setup.sandbox)?;
        let a = http.get(&format!("/repos/{o}/{n}"), t).await?;
        c.answer("user.repo", "GET /repos/{owner}/{repo}", &a);
        if let Some(node) = a.body["node_id"].as_str() {
            repo_node = Some(node.to_owned());
        }
        let a = http
            .get(&format!("/repos/{o}/beghu-contract-no-such-repo"), t)
            .await?;
        c.answer(
            "user.repo_not_found",
            "GET /repos/{owner}/{repo} (out of sight)",
            &a,
        );
    } else {
        c.note("no user token: the user-token half didn't run");
    }
    if let Some((id, secret)) = &setup.oauth_client {
        let a = http
            .oauth_token(&[
                ("client_id", id),
                ("client_secret", secret),
                ("code", "contract-check-not-a-code"),
            ])
            .await?;
        c.answer(
            "oauth.bad_code",
            "POST /login/oauth/access_token (bad code)",
            &a,
        );
        let a = http
            .oauth_token(&[
                ("client_id", id),
                ("client_secret", secret),
                ("grant_type", "refresh_token"),
                ("refresh_token", "ghr_contractCheckNotAToken"),
            ])
            .await?;
        c.answer(
            "oauth.bad_refresh",
            "POST /login/oauth/access_token (bad refresh token)",
            &a,
        );
    }
    Ok(repo_node)
}

// --- the write run -----------------------------------------------------------------------------

/// What the write run compares before and after: the fixture issue as beghu would see it, its
/// comments, the open issues the run made, and the repo's labels.
pub async fn snapshot(http: &Http, t: &str, full: &str, fixture: i64) -> Result<Value, String> {
    let (o, n) = split(full)?;
    let base = format!("/repos/{o}/{n}");
    let i = http.get(&format!("{base}/issues/{fixture}"), t).await?.body;
    let names = |v: &Value, k: &str| {
        let mut out: Vec<String> = v
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x[k].as_str().map(str::to_owned))
            .collect();
        out.sort();
        out
    };
    let comments = http
        .get(&format!("{base}/issues/{fixture}/comments?per_page=100"), t)
        .await?
        .body;
    let open_created = all_issues(http, t, full, "open")
        .await?
        .iter()
        .filter(|x| {
            x["title"]
                .as_str()
                .is_some_and(|s| s.starts_with(CREATED_PREFIX))
        })
        .count();
    let labels = http
        .get(&format!("{base}/labels?per_page=100"), t)
        .await?
        .body;
    // Its relationships, as beghu reads them.
    let edges_doc = beghu::GRAPHQL_DOCUMENTS
        .iter()
        .find(|(op, _)| *op == "IssueEdges")
        .map(|(_, q)| *q)
        .unwrap_or_default();
    let edges = http
        .graphql(
            t,
            edges_doc,
            json!({ "id": i["node_id"], "sub": true, "blocks": true, "relates": true, "relatesAfter": null }),
        )
        .await?
        .body;
    let ids = |v: &Value| -> Vec<i64> {
        v["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x["databaseId"].as_i64())
            .collect()
    };
    let node = &edges["data"]["node"];
    Ok(json!({
        "sub_issues": ids(&node["subIssues"]),
        "blocked_by": ids(&node["blockedBy"]),
        "blocking": ids(&node["blocking"]),
        "relates_to": ids(&node["relatesTo"]),
        "title": i["title"],
        "body": i["body"],
        "state": i["state"],
        // GitHub keeps `reopened` once an issue was ever closed and reopened: only a closed
        // issue's reason says anything.
        "state_reason": if i["state"] == "closed" { i["state_reason"].clone() } else { Value::Null },
        "locked": i["locked"],
        "labels": names(&i["labels"], "name"),
        "assignees": names(&i["assignees"], "login"),
        "milestone": i["milestone"]["number"],
        "comments": names(&comments, "body"),
        "open_created_issues": open_created,
        "repo_labels": names(&labels, "name"),
    }))
}

/// Every issue (and PR) of the repo in `state`, a hundred a page.
async fn all_issues(http: &Http, t: &str, full: &str, state: &str) -> Result<Vec<Value>, String> {
    let (o, n) = split(full)?;
    let mut out = Vec::new();
    let mut next = Some(format!(
        "/repos/{o}/{n}/issues?state={state}&sort=updated&direction=asc&per_page=100"
    ));
    let mut pages = 0;
    while let Some(path) = next.take() {
        let a = http.get(&path, t).await?;
        out.extend(a.body.as_array().cloned().unwrap_or_default());
        pages += 1;
        if pages < 50 {
            next = a.next;
        }
    }
    Ok(out)
}

/// The tokens the write run writes and reads with.
pub struct WriteTokens {
    /// Writes with it: an installation token narrowed to the sandbox and `issues: write`, or
    /// the setup's user token.
    pub write: String,
    /// Narrowed to `issues: read`: its write must be refused.
    pub read_only: String,
}

pub async fn write_tokens(setup: &Setup, c: &mut Checker) -> Result<WriteTokens, String> {
    let http = Http::new(&setup.api, &setup.web);
    let app = App { setup, http: &http };
    let name = split(&setup.sandbox)?.1;
    let i = app.installation(c, &setup.sandbox).await?;
    let write = sandbox_token(setup, c).await?;
    let read_only = app
        .token(c, i, &[name], json!({ "issues": "read" }))
        .await?;
    Ok(WriteTokens { write, read_only })
}

/// A token that writes to the sandbox's issues and nowhere else: the setup's user token, or an
/// installation token narrowed to the sandbox and `issues: write`.
pub async fn sandbox_token(setup: &Setup, c: &mut Checker) -> Result<String, String> {
    if let Some(t) = &setup.write_token {
        return Ok(t.clone());
    }
    let http = Http::new(&setup.api, &setup.web);
    let app = App { setup, http: &http };
    let name = split(&setup.sandbox)?.1;
    let i = app.installation(c, &setup.sandbox).await?;
    app.token(
        c,
        i,
        &[name],
        json!({ "issues": "write", "metadata": "read" }),
    )
    .await
}

/// The write run on the sandbox: every write beghu makes, each undone, and the sandbox compared
/// before and after.
pub async fn write(setup: &Setup, c: &mut Checker) -> Result<(), String> {
    let http = Http::new(&setup.api, &setup.web);
    let tokens = write_tokens(setup, c).await?;
    let t = tokens.write.as_str();
    let (o, n) = split(&setup.sandbox)?;
    let base = format!("/repos/{o}/{n}");

    // What there is to write with: a label, someone to assign, a milestone.
    let labels = http
        .get(&format!("{base}/labels?per_page=100"), t)
        .await?
        .body;
    let label = labels
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["name"].as_str())
        .filter(|l| !l.starts_with(UNKNOWN_LABEL))
        .min_by_key(|l| *l != "contract")
        .map(str::to_owned);
    // A label a run that crashed made by adding one the repo didn't have: gone again.
    for l in labels.as_array().into_iter().flatten() {
        if let Some(name) = l["name"].as_str().filter(|n| n.starts_with(UNKNOWN_LABEL)) {
            http.call(
                Method::DELETE,
                &format!("{base}/labels/{}", segment(name)),
                Some(t),
                Extra::default(),
            )
            .await?;
        }
    }
    // Only ever the writing user itself, never a real person: with an installation token
    // there's no one to assign, and the assignee writes are skipped.
    let me = http.get("/user", t).await?;
    let assignee = (me.status == 200)
        .then(|| me.body["login"].as_str().map(str::to_owned))
        .flatten();
    if assignee.is_none() {
        c.note("no user token to write with: the assignee writes didn't run");
    }
    let milestone = http
        .get(&format!("{base}/milestones?state=open&per_page=100"), t)
        .await?
        .body[0]["number"]
        .as_i64();

    // Every issue once: the fixture issues are found among them.
    let all = all_issues(&http, t, &setup.sandbox, "all").await?;
    let (fixture, _) = fixture_issue(&http, c, t, &setup.sandbox, &all, FIXTURE_TITLE).await?;
    // Two more, for the relationships: sub-issues, a blocker, a related issue.
    let (_, child) = fixture_issue(&http, c, t, &setup.sandbox, &all, CHILD_TITLES[0]).await?;
    let (_, other) = fixture_issue(&http, c, t, &setup.sandbox, &all, CHILD_TITLES[1]).await?;
    restore(&http, t, &setup.sandbox, fixture).await?;
    unlink(&http, t, &setup.sandbox, fixture, &[child, other]).await?;
    let before = snapshot(&http, t, &setup.sandbox, fixture).await?;

    let issue = format!("{base}/issues/{fixture}");
    let send = |method: Method, path: String, body: Value| {
        let http = &http;
        async move {
            let b = (!body.is_null()).then_some(body);
            http.call(
                method,
                &path,
                Some(t),
                Extra {
                    body: b.as_ref(),
                    ..Extra::default()
                },
            )
            .await
        }
    };

    // A new issue, closed as not planned at once.
    let mut new = json!({ "title": format!("{CREATED_PREFIX} {}", rfc3339(now())), "body": "Opened by the contract check's write run, and closed by it as not planned." });
    if let Some(l) = &label {
        new["labels"] = json!([l]);
    }
    if let Some(a) = &assignee {
        new["assignees"] = json!([a]);
    }
    let a = send(Method::POST, format!("{base}/issues"), new).await?;
    c.answer(
        "write.create_issue",
        "POST /repos/{owner}/{repo}/issues",
        &a,
    );
    if let Some(num) = a.body["number"].as_i64() {
        let a = send(
            Method::PATCH,
            format!("{base}/issues/{num}"),
            json!({ "state": "closed", "state_reason": "not_planned" }),
        )
        .await?;
        c.answer(
            "write.update_issue",
            "PATCH /repos/{owner}/{repo}/issues/{number}",
            &a,
        );
    }
    let a = send(
        Method::POST,
        format!("{base}/issues"),
        json!({ "body": "no title" }),
    )
    .await?;
    c.answer(
        "write.create_issue_invalid",
        "POST /repos/{owner}/{repo}/issues (no title)",
        &a,
    );

    // A comment, deleted.
    let a = send(
        Method::POST,
        format!("{issue}/comments"),
        json!({ "body": format!("Posted by the contract check's write run, and deleted by it. {COMMENT_MARK}") }),
    )
    .await?;
    c.answer(
        "write.create_comment",
        "POST /repos/{owner}/{repo}/issues/{number}/comments",
        &a,
    );
    if let Some(id) = a.body["id"].as_i64() {
        let a = send(
            Method::DELETE,
            format!("{base}/issues/comments/{id}"),
            Value::Null,
        )
        .await?;
        c.answer(
            "write.delete_comment",
            "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
            &a,
        );
    }

    // A label, added and removed, and removed again: GitHub's "Label does not exist".
    if let Some(l) = &label {
        let a = send(
            Method::POST,
            format!("{issue}/labels"),
            json!({ "labels": [l] }),
        )
        .await?;
        c.answer(
            "write.add_labels",
            "POST /repos/{owner}/{repo}/issues/{number}/labels",
            &a,
        );
        let path = format!("{issue}/labels/{}", segment(l));
        let a = send(Method::DELETE, path.clone(), Value::Null).await?;
        c.answer(
            "write.remove_label",
            "DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}",
            &a,
        );
        let a = send(Method::DELETE, path, Value::Null).await?;
        c.answer(
            "write.remove_missing_label",
            "DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name} (not on the issue)",
            &a,
        );
    } else {
        c.note(format!(
            "{} has no label: the label writes didn't run",
            setup.sandbox
        ));
    }

    // A label the repo doesn't have (docs/research/contract-check-shapes.md): GitHub most likely
    // creates it; beghu refuses such a pick, and Fake GitHub answers 422. Recorded, and undone.
    let unknown = format!("{UNKNOWN_LABEL}{}", now());
    let a = send(
        Method::POST,
        format!("{issue}/labels"),
        json!({ "labels": [unknown] }),
    )
    .await?;
    let created = a.status == 200
        && a.body
            .as_array()
            .is_some_and(|ls| ls.iter().any(|l| l["name"] == unknown.as_str()));
    c.note(format!(
        "adding a label the repo doesn't have answers {}{}",
        a.status,
        if created {
            ", and GitHub created the label"
        } else {
            ""
        }
    ));
    if created {
        send(
            Method::DELETE,
            format!("{issue}/labels/{}", segment(&unknown)),
            Value::Null,
        )
        .await?;
        send(
            Method::DELETE,
            format!("{base}/labels/{}", segment(&unknown)),
            Value::Null,
        )
        .await?;
    }

    // An assignee, added and removed.
    if let Some(who) = &assignee {
        let a = send(
            Method::POST,
            format!("{issue}/assignees"),
            json!({ "assignees": [who] }),
        )
        .await?;
        c.answer(
            "write.add_assignees",
            "POST /repos/{owner}/{repo}/issues/{number}/assignees",
            &a,
        );
        let a = send(
            Method::DELETE,
            format!("{issue}/assignees"),
            json!({ "assignees": [who] }),
        )
        .await?;
        c.answer(
            "write.remove_assignees",
            "DELETE /repos/{owner}/{repo}/issues/{number}/assignees",
            &a,
        );
    }

    // The title, the body, the state and the milestone, each changed and put back.
    let mut patches = vec![
        json!({ "title": format!("{FIXTURE_TITLE} (edited)") }),
        json!({ "title": FIXTURE_TITLE }),
        json!({ "body": format!("{FIXTURE_BODY}\n\n(edited)") }),
        json!({ "body": FIXTURE_BODY }),
        json!({ "state": "closed", "state_reason": "completed" }),
        json!({ "state": "open" }),
        json!({ "state": "closed", "state_reason": "not_planned" }),
        json!({ "state": "open" }),
    ];
    if let Some(m) = milestone {
        patches.push(json!({ "milestone": m }));
        patches.push(json!({ "milestone": null }));
    }
    for p in patches {
        let a = send(Method::PATCH, issue.clone(), p).await?;
        c.answer(
            "write.update_issue",
            "PATCH /repos/{owner}/{repo}/issues/{number}",
            &a,
        );
    }

    // A write with a token narrowed to reading is refused, and changes nothing.
    let a = http
        .call(
            Method::PATCH,
            &issue,
            Some(&tokens.read_only),
            Extra {
                body: Some(&json!({ "title": "never" })),
                ..Extra::default()
            },
        )
        .await?;
    c.answer(
        "write.forbidden",
        "PATCH /repos/{owner}/{repo}/issues/{number} (read-only token)",
        &a,
    );

    relationship_writes(&http, c, t, &issue, child, other).await?;

    let after = snapshot(&http, t, &setup.sandbox, fixture).await?;
    if before != after {
        for (k, was) in before.as_object().into_iter().flatten() {
            if after[k] != *was {
                c.found
                    .left_changed
                    .push(format!("{k}: was {was}, now {}", after[k]));
            }
        }
    }
    Ok(())
}

/// beghu's relationship writes on the fixture issue, each undone: sub-issues added, reordered
/// and removed; a blocker added and removed; a related issue added and removed; and GitHub's
/// answers to a duplicate, and to removing what isn't there.
async fn relationship_writes(
    http: &Http,
    c: &mut Checker,
    t: &str,
    issue: &str,
    child: i64,
    other: i64,
) -> Result<(), String> {
    let send = |method: Method, path: String, body: Value| async move {
        let b = (!body.is_null()).then_some(body);
        http.call(
            method,
            &path,
            Some(t),
            Extra {
                body: b.as_ref(),
                ..Extra::default()
            },
        )
        .await
    };
    let steps: Vec<(&str, &str, Method, String, Value)> = vec![
        (
            "write.add_sub_issue",
            "POST /repos/{owner}/{repo}/issues/{number}/sub_issues",
            Method::POST,
            format!("{issue}/sub_issues"),
            json!({ "sub_issue_id": child }),
        ),
        (
            "write.add_sub_issue",
            "POST /repos/{owner}/{repo}/issues/{number}/sub_issues",
            Method::POST,
            format!("{issue}/sub_issues"),
            json!({ "sub_issue_id": other }),
        ),
        (
            "write.add_sub_issue_again",
            "POST /repos/{owner}/{repo}/issues/{number}/sub_issues (already one)",
            Method::POST,
            format!("{issue}/sub_issues"),
            json!({ "sub_issue_id": child }),
        ),
        (
            "write.prioritize_sub_issue",
            "PATCH /repos/{owner}/{repo}/issues/{number}/sub_issues/priority",
            Method::PATCH,
            format!("{issue}/sub_issues/priority"),
            json!({ "sub_issue_id": other, "before_id": child }),
        ),
        (
            "write.remove_sub_issue",
            "DELETE /repos/{owner}/{repo}/issues/{number}/sub_issue",
            Method::DELETE,
            format!("{issue}/sub_issue"),
            json!({ "sub_issue_id": child }),
        ),
        (
            "write.remove_sub_issue",
            "DELETE /repos/{owner}/{repo}/issues/{number}/sub_issue",
            Method::DELETE,
            format!("{issue}/sub_issue"),
            json!({ "sub_issue_id": other }),
        ),
        (
            "write.remove_missing_sub_issue",
            "DELETE /repos/{owner}/{repo}/issues/{number}/sub_issue (not one)",
            Method::DELETE,
            format!("{issue}/sub_issue"),
            json!({ "sub_issue_id": child }),
        ),
        (
            "write.add_blocked_by",
            "POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by",
            Method::POST,
            format!("{issue}/dependencies/blocked_by"),
            json!({ "issue_id": child }),
        ),
        (
            "write.add_blocked_by_again",
            "POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by (already)",
            Method::POST,
            format!("{issue}/dependencies/blocked_by"),
            json!({ "issue_id": child }),
        ),
        (
            "write.remove_blocked_by",
            "DELETE /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by/{issue_id}",
            Method::DELETE,
            format!("{issue}/dependencies/blocked_by/{child}"),
            Value::Null,
        ),
        (
            "write.remove_blocked_by",
            "DELETE /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by/{issue_id}",
            Method::DELETE,
            format!("{issue}/dependencies/blocked_by/{child}"),
            Value::Null,
        ),
        (
            "write.add_relates_to",
            "POST /repos/{owner}/{repo}/issues/{number}/relates_to",
            Method::POST,
            format!("{issue}/relates_to"),
            json!({ "issue_id": other }),
        ),
        (
            "write.remove_relates_to",
            "DELETE /repos/{owner}/{repo}/issues/{number}/relates_to/{issue_id}",
            Method::DELETE,
            format!("{issue}/relates_to/{other}"),
            Value::Null,
        ),
        (
            "write.remove_relates_to",
            "DELETE /repos/{owner}/{repo}/issues/{number}/relates_to/{issue_id}",
            Method::DELETE,
            format!("{issue}/relates_to/{other}"),
            Value::Null,
        ),
    ];
    for (name, request, method, path, body) in steps {
        let a = send(method, path, body).await?;
        c.answer(name, request, &a);
    }
    Ok(())
}

/// Takes away any relationship of the fixture issue to `others` a run that crashed left.
async fn unlink(
    http: &Http,
    t: &str,
    full: &str,
    fixture: i64,
    others: &[i64],
) -> Result<(), String> {
    let (o, n) = split(full)?;
    let issue = format!("/repos/{o}/{n}/issues/{fixture}");
    for id in others {
        for (method, path, body) in [
            (
                Method::DELETE,
                format!("{issue}/sub_issue"),
                Some(json!({ "sub_issue_id": id })),
            ),
            (
                Method::DELETE,
                format!("{issue}/dependencies/blocked_by/{id}"),
                None,
            ),
            (Method::DELETE, format!("{issue}/relates_to/{id}"), None),
        ] {
            http.call(
                method,
                &path,
                Some(t),
                Extra {
                    body: body.as_ref(),
                    ..Extra::default()
                },
            )
            .await?;
        }
    }
    Ok(())
}

/// A label name as one path segment.
fn segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A fixture issue's number and database id: found by its title, or opened the first time.
async fn fixture_issue(
    http: &Http,
    c: &mut Checker,
    t: &str,
    full: &str,
    all: &[Value],
    title: &str,
) -> Result<(i64, i64), String> {
    if let Some(found) = all
        .iter()
        // By its title's start: a run that crashed may have left it edited.
        .filter(|i| {
            i["title"].as_str().is_some_and(|x| x.starts_with(title))
                && i.get("pull_request").is_none()
        })
        .filter_map(|i| Some((i["number"].as_i64()?, i["id"].as_i64()?)))
        .min()
    {
        return Ok(found);
    }
    let (o, n) = split(full)?;
    let a = http
        .call(
            Method::POST,
            &format!("/repos/{o}/{n}/issues"),
            Some(t),
            Extra {
                body: Some(&json!({ "title": title, "body": FIXTURE_BODY })),
                ..Extra::default()
            },
        )
        .await?;
    c.answer(
        "write.create_issue",
        "POST /repos/{owner}/{repo}/issues",
        &a,
    );
    a.body["number"]
        .as_i64()
        .zip(a.body["id"].as_i64())
        .ok_or_else(|| {
            format!(
                "opening the fixture issue answered {}: {}",
                a.status, a.body
            )
        })
}

/// Puts the fixture back as a run starts it, whatever a run that crashed left: open, its title
/// and body, no labels, assignees or milestone, none of the run's comments, and none of the
/// run's issues open.
async fn restore(http: &Http, t: &str, full: &str, fixture: i64) -> Result<(), String> {
    let (o, n) = split(full)?;
    let base = format!("/repos/{o}/{n}");
    let issue = format!("{base}/issues/{fixture}");
    let body = |v: Value| v;
    let patch = |path: String, v: Value| async move {
        http.call(
            Method::PATCH,
            &path,
            Some(t),
            Extra {
                body: Some(&v),
                ..Extra::default()
            },
        )
        .await
    };
    for i in all_issues(http, t, full, "open").await? {
        if i["title"]
            .as_str()
            .is_some_and(|s| s.starts_with(CREATED_PREFIX))
            && let Some(num) = i["number"].as_i64()
        {
            patch(
                format!("{base}/issues/{num}"),
                json!({ "state": "closed", "state_reason": "not_planned" }),
            )
            .await?;
        }
    }
    let now: Answer = http.get(&issue, t).await?;
    let mut fix = serde_json::Map::new();
    if now.body["title"] != FIXTURE_TITLE {
        fix.insert("title".into(), json!(FIXTURE_TITLE));
    }
    if now.body["body"] != FIXTURE_BODY {
        fix.insert("body".into(), json!(FIXTURE_BODY));
    }
    if now.body["state"] != "open" {
        fix.insert("state".into(), json!("open"));
    }
    if !now.body["milestone"].is_null() {
        fix.insert("milestone".into(), Value::Null);
    }
    if !fix.is_empty() {
        patch(issue.clone(), body(Value::Object(fix))).await?;
    }
    for l in now.body["labels"].as_array().into_iter().flatten() {
        if let Some(name) = l["name"].as_str() {
            http.call(
                Method::DELETE,
                &format!("{issue}/labels/{}", segment(name)),
                Some(t),
                Extra::default(),
            )
            .await?;
        }
    }
    let logins: Vec<&str> = now.body["assignees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["login"].as_str())
        .collect();
    if !logins.is_empty() {
        http.call(
            Method::DELETE,
            &format!("{issue}/assignees"),
            Some(t),
            Extra {
                body: Some(&json!({ "assignees": logins })),
                ..Extra::default()
            },
        )
        .await?;
    }
    let comments = http
        .get(&format!("{issue}/comments?per_page=100"), t)
        .await?
        .body;
    for cm in comments.as_array().into_iter().flatten() {
        if cm["body"]
            .as_str()
            .is_some_and(|b| b.contains(COMMENT_MARK))
            && let Some(id) = cm["id"].as_i64()
        {
            http.call(
                Method::DELETE,
                &format!("{base}/issues/comments/{id}"),
                Some(t),
                Extra::default(),
            )
            .await?;
        }
    }
    Ok(())
}
