//! The contract check against Fake GitHub, through the fake's HTTP and control surfaces: the
//! runs pass on the fake as its templates record it, drift in a template or in the fake's
//! answers is reported, coverage gaps get their own heading, and the write run leaves the
//! sandbox as it found it.

use contract::check::Mode;
use contract::run::Setup;
use contract::{Kind, templates};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const CLIENT_ID: &str = "Iv1.test";
const CLIENT_SECRET: &str = "test-secret";

/// The 1k fixture, generated once per test run.
fn fixture() -> PathBuf {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    fixture::cached(
        fixture::Scale::K1,
        &PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("fixture"),
    )
    .unwrap()
}

struct Fake {
    api: String,
    ctl: String,
    http: reqwest::Client,
    _dir: tempfile::TempDir,
}

/// A fresh Fake GitHub on the 1k fixture. Its webhooks go to a port nobody listens on: each is
/// logged as a failed attempt, which the App's delivery log still lists with its payload.
async fn start() -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let cfg = fake_github::Config {
        fixture: fixture(),
        db: dir.path().join("truth.db"),
        client_id: CLIENT_ID.into(),
        client_secret: CLIENT_SECRET.into(),
        access_ttl: fake_github::ACCESS_TTL,
        refresh_ttl: fake_github::REFRESH_TTL,
        webhook_url: Some("http://127.0.0.1:9/webhook".into()),
        webhook_secret: "test-webhook-secret".into(),
        setup_url: None,
    };
    let fake = tokio::task::spawn_blocking(move || fake_github::Fake::open(cfg))
        .await
        .unwrap()
        .unwrap();
    let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ctl = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (a, c) = (api.local_addr().unwrap(), ctl.local_addr().unwrap());
    tokio::spawn(fake.serve(api, ctl));
    Fake {
        api: format!("http://{a}"),
        ctl: format!("http://{c}"),
        http: reqwest::Client::new(),
        _dir: dir,
    }
}

impl Fake {
    async fn setup(&self) -> Setup {
        Setup::against_fake(&self.api, "tomsj", (CLIENT_ID, CLIENT_SECRET))
            .await
            .unwrap()
    }

    async fn control(&self, method: reqwest::Method, path: &str, body: Value) {
        let res = self
            .http
            .request(method, format!("{}{path}", self.ctl))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{path}: {}", res.status());
    }

    /// An outside edit, and its webhooks logged.
    async fn edit(&self, edit: Value) {
        self.control(reqwest::Method::POST, "/edit", edit).await;
        tokio::time::sleep(fake_github::WEBHOOK_DELAY + Duration::from_millis(600)).await;
    }

    async fn get(&self, path: &str, token: &str) -> Value {
        self.http
            .get(format!("{}{path}", self.api))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    /// The drift issue on the sandbox and its comments' bodies.
    async fn drift_issue(&self, token: &str) -> Option<(Value, Vec<String>)> {
        let http = contract::http::Http::new(&self.api, &self.api);
        let (n, _, _) = contract::report::find_issue(&http, token, "acme/web")
            .await
            .unwrap()?;
        let issue = self
            .get(&format!("/repos/acme/web/issues/{n}"), token)
            .await;
        let comments = self
            .get(&format!("/repos/acme/web/issues/{n}/comments"), token)
            .await;
        let bodies = comments
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["body"].as_str().unwrap().to_owned())
            .collect();
        Some((issue, bodies))
    }
}

/// A copy of the committed templates, to change.
fn templates_copy() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("templates");
    templates::Templates::load(&templates::default_dir())
        .unwrap()
        .save(&to)
        .unwrap();
    (dir, to)
}

fn edit_template(dir: &Path, file: &str, change: impl FnOnce(&mut Value)) {
    let path = dir.join(file);
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    change(&mut v);
    std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_read_run_passes_on_the_fake_and_lists_unseen_webhooks_under_coverage_gaps() {
    let fake = start().await;
    fake.edit(json!({ "repo": "web", "number": 1, "title": "Seen tonight" }))
        .await;
    let setup = fake.setup().await;
    let out = contract::run(Kind::Read, &setup, &templates::default_dir(), true)
        .await
        .unwrap();
    let found = &out.checker.found;
    assert!(found.drift.is_empty(), "{:#?}", found.drift);
    assert!(!out.failed);
    // The whole read set ran: REST, GraphQL, the App's calls, the user-token half.
    for t in [
        "rest.issue",
        "rest.issue_events",
        "graphql.ImportIssues",
        "graphql.SweepCounts",
        "app.hook_delivery",
        "webhook.issues.edited",
        "user.repo",
        "oauth.bad_code",
    ] {
        assert!(found.checked.contains(t), "{t} wasn't checked");
    }

    // What was seen isn't a gap; what wasn't is, under its own heading, apart from drift. The
    // events only made by hand never are.
    assert!(
        !out.gaps.contains(&"issues.edited".to_owned()),
        "{:?}",
        out.gaps
    );
    assert!(
        out.gaps.contains(&"issues.closed".to_owned()),
        "{:?}",
        out.gaps
    );
    assert!(
        !out.gaps
            .iter()
            .any(|g| g == "issues.deleted" || g.starts_with("repository."))
    );
    let (drift, gaps) = out.report.split_once("### Coverage gaps").unwrap();
    assert!(drift.contains("### Drift\n\nNone."), "{}", out.report);
    assert!(
        gaps.contains("- `issues.closed` (never seen)"),
        "{}",
        out.report
    );

    // Posted to the drift issue on the sandbox, which keeps when each was last seen.
    let token = setup.write_token.clone().unwrap();
    let (issue, comments) = fake.drift_issue(&token).await.unwrap();
    assert_eq!(issue["state"], "open");
    let state = contract::report::read_state(issue["body"].as_str().unwrap());
    assert!(state.last_seen.contains_key("issues.edited"), "{state:?}");
    assert_eq!(comments.len(), 1);
    assert!(comments[0].contains("### Coverage gaps"));

    // Opening the issue and commenting are deliveries too, which the next run sees; after that
    // the gaps stay as they are, and a run with the same gaps says nothing new.
    tokio::time::sleep(fake_github::WEBHOOK_DELAY + Duration::from_millis(600)).await;
    let second = contract::run(Kind::Read, &setup, &templates::default_dir(), true)
        .await
        .unwrap();
    assert!(!second.gaps.contains(&"issue_comment.created".to_owned()));
    let (_, comments) = fake.drift_issue(&token).await.unwrap();
    let said = comments.len();
    let third = contract::run(Kind::Read, &setup, &templates::default_dir(), true)
        .await
        .unwrap();
    assert_eq!(third.gaps, second.gaps);
    let (_, comments) = fake.drift_issue(&token).await.unwrap();
    assert_eq!(comments.len(), said);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_field_in_a_recorded_template_is_reported_as_drift() {
    let fake = start().await;
    let (_keep, dir) = templates_copy();
    // `number` recorded as a string, and `title` renamed: as if GitHub had changed both.
    edit_template(&dir, "rest.json", |v| {
        let shape = &mut v["rest.issue"]["shape"];
        shape["number"] = json!("string");
        let title = shape.as_object_mut().unwrap().remove("title").unwrap();
        shape["titel"] = title;
    });
    let setup = fake.setup().await;
    let out = contract::run(Kind::Read, &setup, &dir, true).await.unwrap();
    assert!(out.failed);
    let on_issue: Vec<&str> = out
        .checker
        .found
        .drift
        .iter()
        .filter(|d| d.template == "rest.issue")
        .map(|d| d.what.as_str())
        .collect();
    assert_eq!(
        on_issue,
        [
            "`$.number` is number, recorded as string",
            // Against the fake, a field it sends that the template lacks is the drift.
            "`$.title` (string) isn't in the template",
        ],
        "{:#?}",
        out.checker.found.drift
    );
    let (drift, _) = out.report.split_once("### Coverage gaps").unwrap();
    assert!(
        drift.contains("- `GET /repos/{owner}/{repo}/issues/{number}` (`rest.issue`): `$.number` is number, recorded as string"),
        "{}",
        out.report
    );

    // The drift issue says so.
    let token = setup.write_token.clone().unwrap();
    let (_, comments) = fake.drift_issue(&token).await.unwrap();
    assert!(comments.iter().any(|c| c.contains("recorded as string")));

    // The same drift the next nights fails again, but says nothing new. (Each run's own issue
    // edits and comments are deliveries the next run sees, so the gaps take a few runs to
    // settle; a change in them is news.)
    let mut gaps = out.gaps.clone();
    for _ in 0..4 {
        tokio::time::sleep(fake_github::WEBHOOK_DELAY + Duration::from_millis(600)).await;
        let next = contract::run(Kind::Read, &setup, &dir, true).await.unwrap();
        assert!(next.failed);
        if next.gaps == gaps {
            break;
        }
        gaps = next.gaps;
    }
    let (_, comments) = fake.drift_issue(&token).await.unwrap();
    let said = comments.len();
    let again = contract::run(Kind::Read, &setup, &dir, true).await.unwrap();
    assert!(again.failed);
    assert_eq!(again.gaps, gaps);
    let (_, comments) = fake.drift_issue(&token).await.unwrap();
    assert_eq!(comments.len(), said, "{:?}", &comments[said..]);

    // Against GitHub, a template field the answer lacks is the drift.
    let github = Setup {
        mode: Mode::GitHub,
        ..setup
    };
    let out = contract::run(Kind::Read, &github, &dir, false)
        .await
        .unwrap();
    assert!(
        out.checker
            .found
            .drift
            .iter()
            .any(|d| d.template == "rest.issue" && d.what == "`$.titel` is missing"),
        "{:#?}",
        out.checker.found.drift
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn drift_in_the_fakes_answers_is_reported() {
    let fake = start().await;
    // The next issue read answers with a number that's text and nothing else.
    fake.control(
        reqwest::Method::POST,
        "/faults/rewrite",
        json!({ "endpoint": "GET /repos/acme/web/issues/*", "raw": r#"{"number": "7"}"#, "count": 1 }),
    )
    .await;
    let setup = fake.setup().await;
    let out = contract::run(Kind::Read, &setup, &templates::default_dir(), false)
        .await
        .unwrap();
    assert!(out.failed);
    let drift: Vec<_> = out
        .checker
        .found
        .drift
        .iter()
        .map(|d| (d.template.as_str(), d.what.as_str()))
        .collect();
    assert_eq!(
        drift,
        [("rest.issue", "`$.number` is string, recorded as number")]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_write_run_leaves_the_sandbox_as_it_found_it() {
    let fake = start().await;
    let setup = fake.setup().await;
    let token = setup.write_token.clone().unwrap();
    let dir = templates::default_dir();
    // The first run opens the fixture issue it keeps.
    let first = contract::run(Kind::Write, &setup, &dir, false)
        .await
        .unwrap();
    assert!(!first.failed, "{}", first.report);
    let http = contract::http::Http::new(&fake.api, &fake.api);
    // Changed in the last hour: the issues the run opened.
    let since = contract::run::rfc3339(contract::run::now() - 3600);
    let recent = fake
        .get(
            &format!("/repos/acme/web/issues?state=all&sort=updated&direction=asc&per_page=100&since={since}"),
            &token,
        )
        .await;
    let fixture = recent
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["title"] == contract::run::FIXTURE_TITLE)
        .unwrap()["number"]
        .as_i64()
        .unwrap();

    // A run that crashed half way left the fixture edited, labelled and commented on.
    fake.edit(json!({ "repo": "web", "number": fixture, "title": format!("{} (edited)", contract::run::FIXTURE_TITLE), "add_labels": ["bug"], "state": "closed", "comment": "Left by a run that crashed. <!-- beghu contract check -->" }))
        .await;
    let out = contract::run(Kind::Write, &setup, &dir, false)
        .await
        .unwrap();
    assert!(!out.failed, "{}", out.report);
    assert!(out.checker.found.left_changed.is_empty());
    for t in [
        "write.create_issue",
        "write.create_comment",
        "write.delete_comment",
        "write.add_labels",
        "write.remove_missing_label",
        "write.add_assignees",
        "write.update_issue",
        "write.forbidden",
    ] {
        assert!(out.checker.found.checked.contains(t), "{t} wasn't checked");
    }

    // A run from a clean start leaves everything as it was: the fixture issue, its comments,
    // the repo's labels, and no issue of its own left open.
    let before = contract::run::snapshot(&http, &token, "acme/web", fixture)
        .await
        .unwrap();
    assert_eq!(before["title"], contract::run::FIXTURE_TITLE);
    assert_eq!(before["state"], "open");
    assert_eq!(before["labels"], json!([]));
    assert_eq!(before["open_created_issues"], 0);
    let open_before = fake
        .get(
            "/repos/acme/web/issues?state=open&sort=updated&direction=asc&per_page=100&page=1",
            &token,
        )
        .await;
    let out = contract::run(Kind::Write, &setup, &dir, false)
        .await
        .unwrap();
    assert!(!out.failed, "{}", out.report);
    let after = contract::run::snapshot(&http, &token, "acme/web", fixture)
        .await
        .unwrap();
    assert_eq!(before, after);
    let open_after = fake
        .get(
            "/repos/acme/web/issues?state=open&sort=updated&direction=asc&per_page=100&page=1",
            &token,
        )
        .await;
    let numbers = |v: &Value| -> Vec<i64> {
        let mut n: Vec<i64> = v
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["number"].as_i64())
            .filter(|n| *n != fixture)
            .collect();
        n.sort();
        n
    };
    assert_eq!(numbers(&open_before), numbers(&open_after));
}

#[test]
fn the_committed_templates_load_and_save_back_unchanged() {
    let dir = templates::default_dir();
    let t = templates::Templates::load(&dir).unwrap();
    let out = tempfile::tempdir().unwrap();
    t.save(out.path()).unwrap();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            std::fs::read_to_string(out.path().join(name)).unwrap(),
            "{} isn't as `contract record` writes it",
            path.display()
        );
    }
}

#[test]
fn each_graphql_template_names_only_fields_beghus_query_selects() {
    // GitHub answers only what a query selects: a field the fake adds beyond the query is one
    // it invents.
    let t = templates::Templates::load(&templates::default_dir()).unwrap();
    for (op, query) in beghu::GRAPHQL_DOCUMENTS {
        assert!(
            query.trim_start().starts_with(&format!("query {op}(")),
            "{op}'s document is another operation"
        );
        let Some(template) = t.get(&format!("graphql.{op}")) else {
            panic!("no template for {op}");
        };
        let words: std::collections::BTreeSet<&str> = query
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .collect();
        let mut fields = Vec::new();
        names(&template.shape.to_json()["data"], &mut fields);
        for f in fields {
            assert!(
                words.contains(f.as_str()),
                "{op}'s template has `{f}`, which the query doesn't select"
            );
        }
    }
}

/// Every field name in a template shape.
fn names(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if k != "[]" {
                    out.push(k.trim_end_matches('?').to_owned());
                }
                names(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| names(x, out)),
        _ => {}
    }
}

#[test]
fn the_workflow_never_runs_on_pull_requests() {
    // It holds the beghu-ci App's key: nothing from a pull request may run it.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/contract.yml");
    let text = std::fs::read_to_string(path).unwrap();
    let on = text
        .split("\non:\n")
        .nth(1)
        .unwrap()
        .split("\n\n")
        .next()
        .unwrap();
    let triggers: Vec<&str> = on
        .lines()
        .filter(|l| {
            l.starts_with("  ") && !l.starts_with("   ") && !l.trim_start().starts_with('#')
        })
        .map(|l| l.trim().trim_end_matches(':'))
        .collect();
    assert_eq!(triggers, ["schedule", "workflow_dispatch", "push"]);
    assert!(!text.contains("pull_request"));
    assert!(!text.contains("workflow_run"));
}

#[test]
fn the_workflow_skips_until_the_secrets_are_set_and_hands_them_only_to_the_runs() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/contract.yml");
    let text = std::fs::read_to_string(path).unwrap();
    let job = text
        .split("\n  check:\n")
        .nth(1)
        .unwrap()
        .split("\n  keepalive:\n")
        .next()
        .unwrap();
    let (head, steps) = job.split_once("\n    steps:\n").unwrap();
    assert!(
        !head.contains("secrets."),
        "secrets in the job's own env:\n{head}"
    );
    // Each step, by its name or action.
    let steps: Vec<&str> = steps.split("\n      - ").collect();
    let step = |name: &str| {
        *steps
            .iter()
            .find(|s| s.trim_start_matches("- ").starts_with(name))
            .unwrap_or_else(|| panic!("no step {name}"))
    };
    let ready = step("name: Secrets set?");
    assert!(ready.contains("id: ready"));
    assert!(ready.contains(
        "::notice::Contract check skipped: the contract environment's secrets aren't set (docs/deploy.md)"
    ));
    assert!(ready.contains("ready=false") && ready.contains("ready=true"));
    for name in [
        "uses: actions/checkout",
        "uses: dtolnay/rust-toolchain",
        "uses: Swatinem/rust-cache",
        "name: Build",
        "name: Read run",
        "name: Write run",
    ] {
        assert!(
            step(name).contains("steps.ready.outputs.ready == 'true'"),
            "{name} runs without the secrets"
        );
    }
    for name in [
        "uses: dtolnay/rust-toolchain@",
        "uses: Swatinem/rust-cache@",
    ] {
        let sha = step(name)
            .split('@')
            .nth(1)
            .unwrap()
            .split(' ')
            .next()
            .unwrap();
        assert!(
            sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
            "{name} isn't pinned"
        );
    }
    // The secrets reach the two runs only.
    for (i, s) in steps.iter().enumerate() {
        let runs = s.starts_with("name: Read run") || s.starts_with("name: Write run");
        let ready = s.starts_with("name: Secrets set?");
        if !runs && !ready {
            assert!(!s.contains("secrets."), "step {i} sees a secret:\n{s}");
        }
    }
}
