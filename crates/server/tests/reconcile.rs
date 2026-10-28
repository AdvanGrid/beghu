//! Reconciliation through the server's HTTP surface, with Fake GitHub behind it: redelivery of
//! lost webhooks, the outage trigger, the sweeps and their rate-limit pause, "sync degraded" and
//! Resync. Each test sets the schedules it needs; the harness's default keeps sweeps quiet.

mod common;

use common::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const INSTALLATION: i64 = 41000001;

/// Sweeps on a short schedule: probes every 300 ms, counts and orders every 600 ms, and every
/// change they repair counted as missed.
fn sweeping(c: &mut beghu::Config) {
    c.reconcile.tick = Duration::from_millis(100);
    c.reconcile.probe_every = Duration::from_millis(300);
    c.reconcile.count_every = Duration::from_millis(600);
    c.reconcile.webhook_grace = Duration::ZERO;
}

/// Redelivery every half second; sweeps off.
fn redelivering(c: &mut beghu::Config) {
    c.reconcile.redeliver_every = Duration::from_millis(500);
}

/// The first fixture issues in `repo` with no relationships: `(repo, number, id)`.
fn unlinked(repo: &str) -> Vec<(String, i64, i64)> {
    summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["repo"] == repo)
        .map(|u| {
            (
                repo.to_owned(),
                u["number"].as_i64().unwrap(),
                u["id"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn reference(u: &(String, i64, i64)) -> String {
    format!("{}#{}", u.0, u.1)
}

/// An outside edit of `u` on Fake GitHub.
async fn edit(s: &Stack, u: &(String, i64, i64), fields: Value) {
    let mut e = json!({ "repo": u.0, "number": u.1 });
    for (k, v) in fields.as_object().unwrap() {
        e[k] = v.clone();
    }
    s.edit(e).await;
}

async fn title_of(s: &Stack, b: &Browser, id: i64) -> String {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d["title"].as_str().unwrap().to_owned()
}

async fn sync(s: &Stack, b: &Browser) -> Value {
    s.api(&mut b.clone(), "/api/me").await.1["sync"].clone()
}

async fn fake_state(s: &Stack) -> Value {
    s.fake("GET", "/state", json!({})).await
}

/// How many times Fake GitHub answered an operation, since its start.
async fn operation(s: &Stack, op: &str) -> u64 {
    fake_state(s).await["graphql"]["operations"][op]
        .as_u64()
        .unwrap_or(0)
}

/// The sub-issues of `id` in the detail, in order.
async fn children(s: &Stack, b: &Browser, id: i64) -> Vec<i64> {
    let (_, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    d["relationships"]["sub_issues"]
        .as_array()
        .map(|a| a.iter().map(|r| r["id"].as_i64().unwrap()).collect())
        .unwrap_or_default()
}

/// Lets the fake's webhooks fail as a server that's down makes them: nobody answers.
async fn webhooks_unanswered(s: &Stack) {
    s.fake(
        "PUT",
        "/webhooks",
        json!({ "url": "http://127.0.0.1:9/webhook" }),
    )
    .await;
}

// --- redelivery ----------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_relationship_change_whose_webhooks_were_lost_arrives_by_redelivery() {
    let s = start_with(redelivering).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (parent, child) = (&web[0], &web[1]);
    // Redelivery has looked at the installation once, so it knows where to look back to.
    tokio::time::sleep(Duration::from_millis(700)).await;
    // Both of the change's deliveries are lost, and a sweep wouldn't see it: no `updated_at`
    // moves for a relationship.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    edit(&s, parent, json!({ "add_sub_issue": reference(child) })).await;
    until(6.0, "the sub-issue, by redelivery", || async {
        (children(&s, &b, parent.2).await == [child.2]).then_some(())
    })
    .await;
    let deliveries = &fake_state(&s).await["webhooks"]["deliveries"];
    assert_eq!(deliveries["redelivered"], 2, "{deliveries}");
    assert_eq!(operation(&s, "ImportIssues").await, 0, "no full sweep");
}

/// The setup both outage tests share: a webhook has landed (the installation's checkpoint), and
/// then the server is down as far as GitHub can tell, so a title edit's webhook finds nobody
/// answering. The issue and its new title.
async fn outage(s: &Stack, b: &Browser) -> ((String, i64, i64), String) {
    let me = unlinked("api")[0].clone();
    edit(s, &me, json!({ "title": "Before the outage" })).await;
    until(4.0, "the first webhook", || async {
        (title_of(s, b, me.2).await == "Before the outage").then_some(())
    })
    .await;
    webhooks_unanswered(s).await;
    edit(s, &me, json!({ "title": "During the outage" })).await;
    until(4.0, "the failed delivery", || async {
        (fake_state(s).await["webhooks"]["deliveries"]["failed"] == 1).then_some(())
    })
    .await;
    (me, "During the outage".into())
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_short_outage_the_next_start_replays_the_missed_deliveries() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let (me, title) = outage(&s, &b).await;
    s.restart_with(redelivering).await;
    until(6.0, "the change, by redelivery", || async {
        (title_of(&s, &b, me.2).await == title).then_some(())
    })
    .await;
    assert_eq!(
        fake_state(&s).await["webhooks"]["deliveries"]["redelivered"],
        1
    );
    assert_eq!(operation(&s, "ImportIssues").await, 0, "no full sweep");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outage_longer_than_redelivery_covers_gets_a_full_sweep_instead() {
    // 2.5 days, shrunk: an outage past it is too old to replay.
    let long = |c: &mut beghu::Config| {
        redelivering(c);
        c.reconcile.outage_after = Duration::from_secs(1);
    };
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let (me, title) = outage(&s, &b).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    s.restart_with(long).await;
    until(20.0, "the change, by a full sweep", || async {
        (title_of(&s, &b, me.2).await == title).then_some(())
    })
    .await;
    assert!(operation(&s, "ImportIssues").await > 0);
    assert_eq!(
        fake_state(&s).await["webhooks"]["deliveries"]["redelivered"],
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redelivery_github_refused_is_asked_for_again_on_the_next_run() {
    // Runs 1.5 s apart, each reading the log from exactly where the last ended: a GUID left
    // behind by one run is found again only if the job remembers it.
    let s = start_with(|c| {
        c.reconcile.redeliver_every = Duration::from_millis(1500);
        c.reconcile.redeliver_overlap = Duration::ZERO;
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let me = unlinked("web")[0].clone();
    tokio::time::sleep(Duration::from_millis(1700)).await;
    // GitHub refuses the first two asks to redeliver.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /app/hook/deliveries/*/attempts", "count": 2, "status": 502 }),
    )
    .await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, &me, json!({ "title": "Redelivered at the third ask" })).await;
    until(12.0, "the change, by the third ask", || async {
        (title_of(&s, &b, me.2).await == "Redelivered at the third ask").then_some(())
    })
    .await;
    assert_eq!(
        fake_state(&s).await["webhooks"]["deliveries"]["redelivered"],
        1
    );
    assert_eq!(operation(&s, "ImportIssues").await, 0, "no full sweep");
}

/// A webhook lands (the installation's checkpoint), then three title edits' deliveries in api
/// find nobody: the issues and their titles.
async fn three_missed(s: &Stack, b: &Browser) -> Vec<((String, i64, i64), String)> {
    let api = unlinked("api");
    edit(s, &api[0], json!({ "title": "Before the outage" })).await;
    until(4.0, "the first webhook", || async {
        (title_of(s, b, api[0].2).await == "Before the outage").then_some(())
    })
    .await;
    webhooks_unanswered(s).await;
    let mut missed = Vec::new();
    for (n, u) in api[..3].iter().enumerate() {
        let title = format!("Missed {n}");
        edit(s, u, json!({ "title": title })).await;
        missed.push((u.clone(), title));
    }
    until(6.0, "the failed deliveries", || async {
        (fake_state(s).await["webhooks"]["deliveries"]["failed"] == 3).then_some(())
    })
    .await;
    missed
}

#[tokio::test(flavor = "multi_thread")]
async fn more_missed_deliveries_than_the_cap_get_a_full_sweep_instead_of_redeliveries() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let missed = three_missed(&s, &b).await;
    s.restart_with(|c| {
        redelivering(c);
        c.reconcile.redeliver_cap = 2;
    })
    .await;
    for (u, title) in &missed {
        until(30.0, "the change, by a full sweep", || async {
            (title_of(&s, &b, u.2).await == *title).then_some(())
        })
        .await;
    }
    assert!(operation(&s, "ImportIssues").await > 0);
    assert_eq!(
        fake_state(&s).await["webhooks"]["deliveries"]["redelivered"],
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_sweep_redelivery_asked_for_is_still_owed_after_a_restart() {
    // Each check reads the log from exactly where the last ended.
    let capped = |c: &mut beghu::Config| {
        redelivering(c);
        c.reconcile.redeliver_cap = 2;
        c.reconcile.redeliver_overlap = Duration::ZERO;
    };
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let missed = three_missed(&s, &b).await;
    // api's full sweep fails (GitHub answers 404 for its labels), so the installation's is still
    // owed while redelivery goes on checking.
    let labels = "GET /repos/acme/api/labels";
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": labels, "count": 1000, "status": 404 }),
    )
    .await;
    let checks = "GET /app/hook/deliveries";
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": checks, "ms": 1, "count": 1000 }),
    )
    .await;
    s.restart_with(|c| {
        capped(c);
        c.reconcile.failure_backoff = Duration::from_secs(3600);
    })
    .await;
    until(20.0, "api's full sweep to fail", || async {
        (log_reads(&s, labels).await >= 1).then_some(())
    })
    .await;
    let after = delayed(&s, checks, 1000).await;
    until(10.0, "two more checks", || async {
        (delayed(&s, checks, 1000).await >= after + 2).then_some(())
    })
    .await;
    // A restart, and GitHub answers again.
    s.fake("DELETE", "/faults", json!({})).await;
    s.restart_with(capped).await;
    for (u, title) in &missed {
        until(30.0, "the change, by the full sweep still owed", || async {
            (title_of(&s, &b, u.2).await == *title).then_some(())
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missed_delivery_gone_from_githubs_log_gets_a_full_sweep_instead() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let (me, title) = outage(&s, &b).await;
    // Listed, but gone by the time it's asked for.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /app/hook/deliveries/*/attempts", "count": 1000, "status": 404 }),
    )
    .await;
    s.restart_with(redelivering).await;
    until(20.0, "the change, by a full sweep", || async {
        (title_of(&s, &b, me.2).await == title).then_some(())
    })
    .await;
    assert!(operation(&s, "ImportIssues").await > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_still_missed_past_the_outage_age_gets_a_full_sweep_while_running() {
    // 2.5 days, shrunk: the missed delivery is redelivered into the void until it's too old.
    let s = start_with(|c| {
        redelivering(c);
        c.reconcile.outage_after = Duration::from_secs(2);
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let me = unlinked("api")[0].clone();
    tokio::time::sleep(Duration::from_millis(700)).await;
    webhooks_unanswered(&s).await;
    edit(&s, &me, json!({ "title": "Missed for too long" })).await;
    until(4.0, "the failed delivery", || async {
        (fake_state(&s).await["webhooks"]["deliveries"]["failed"] == 1).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    s.fake(
        "PUT",
        "/webhooks",
        json!({ "url": format!("{}/webhook", s.server) }),
    )
    .await;
    until(30.0, "the change, by a full sweep", || async {
        (title_of(&s, &b, me.2).await == "Missed for too long").then_some(())
    })
    .await;
    assert!(operation(&s, "ImportIssues").await > 0);
}

/// How many calls a 1000-call fail rule on `endpoint` has failed so far.
async fn log_reads(s: &Stack, endpoint: &str) -> u64 {
    1000 - fake_state(s).await["faults"]["fail"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["endpoint"] == endpoint)
        .unwrap()["remaining"]
        .as_u64()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn redelivery_waits_until_the_server_listens() {
    // #86: listen first, then resume deliveries, then redeliver: a redelivery asked for before
    // the server listens would find nobody. Redelivery is part of the startup that follows
    // listening (`Opened::start`), so a server serving with that startup held back reads no log.
    let mut s = start_with(redelivering).await;
    s.sign_in("tomsj").await;
    // Redelivery has looked at the installation once: the next start reads its log.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let endpoint = "GET /app/hook/deliveries";
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "count": 1000, "status": 500 }),
    )
    .await;
    let held = s.restart_held(redelivering).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        log_reads(&s, endpoint).await,
        0,
        "the log read before the startup after listening"
    );
    held.start().await;
    until(5.0, "the log read once it listens", || async {
        (log_reads(&s, endpoint).await > 0).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_sweep_of_a_mirror_in_step_with_github_changes_nothing() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    // No checkpoint at the next start: a full sweep of every repo.
    s.restart_with(|_| {}).await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    until(30.0, "the full sweeps", || async {
        (operation(&s, "SweepEdges").await >= 5).then_some(())
    })
    .await;
    // Give the last repo's sweep time to finish writing.
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(operation(&s, "ImportIssues").await >= 5);
    assert_eq!(
        st.events_for(Duration::from_millis(500)).await,
        Vec::<Sse>::new()
    );
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_startup_full_sweep_failed_is_swept_again_after_a_backoff() {
    let mut s = start().await;
    s.sign_in("tomsj").await;
    // web's first full sweep fails: GitHub answers 404 for its labels, once.
    let endpoint = "GET /repos/acme/web/labels";
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "count": 1, "status": 404 }),
    )
    .await;
    // No checkpoint at the next start: a full sweep of every repo.
    s.restart_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.failure_backoff = Duration::from_millis(500);
    })
    .await;
    until(30.0, "the failed sweep", || async {
        let st = fake_state(&s).await;
        let left = st["faults"]["fail"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["endpoint"] == endpoint);
        (!left).then_some(())
    })
    .await;
    // Counted from here.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": endpoint, "ms": 1, "count": 1000 }),
    )
    .await;
    // The installation's sweep isn't over while web's failed: web is swept again.
    until(30.0, "web swept again", || async {
        (delayed(&s, endpoint, 1000).await >= 1).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_milestone_github_only_touched_is_no_change_the_webhooks_missed() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    let web = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "web")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    // GitHub lists web's milestones as they are, but each updated a day later (an issue joined
    // or closed in it, say), which sends no webhook.
    let db = rusqlite::Connection::open(fixture()).unwrap();
    let milestones: Vec<Value> = fake_db::q::repo_milestones(&db, web, i64::MAX, 0)
        .unwrap()
        .into_iter()
        .map(|m| {
            let t = fake_github::rfc3339;
            json!({
                "id": m.id, "node_id": format!("MI_kw{}", m.id), "number": m.number,
                "title": m.title, "description": null, "state": m.state,
                "due_on": m.due_on.map(t),
                "created_at": m.updated_at.map(t),
                "updated_at": m.updated_at.map(|u| t(u + 24 * 3600)),
                "closed_at": null,
            })
        })
        .collect();
    assert!(!milestones.is_empty());
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({ "endpoint": "GET /repos/acme/web/milestones", "count": 1, "raw": Value::from(milestones).to_string() }),
    )
    .await;
    // No checkpoint at the next start: a full sweep of every repo, every change it finds old
    // enough to count.
    s.restart_with(|c| c.reconcile.webhook_grace = Duration::ZERO)
        .await;
    until(30.0, "the full sweeps", || async {
        (operation(&s, "SweepEdges").await >= 5).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(
        fake_state(&s).await["faults"]["rewrite"],
        json!([]),
        "web's milestones were read"
    );
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_milestone_changed_too_recently_for_its_webhook_to_have_landed_is_no_miss() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    let web = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "web")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    // GitHub lists one of web's milestones retitled just now: its webhook may be on the way.
    let db = rusqlite::Connection::open(fixture()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let milestones: Vec<Value> = fake_db::q::repo_milestones(&db, web, i64::MAX, 0)
        .unwrap()
        .into_iter()
        .enumerate()
        .map(|(n, m)| {
            let t = fake_github::rfc3339;
            let (title, updated) = match n {
                0 => ("Retitled just now".to_owned(), Some(now)),
                _ => (m.title, m.updated_at),
            };
            json!({
                "id": m.id, "node_id": format!("MI_kw{}", m.id), "number": m.number,
                "title": title, "description": null, "state": m.state,
                "due_on": m.due_on.map(t), "created_at": m.updated_at.map(t),
                "updated_at": updated.map(t), "closed_at": null,
            })
        })
        .collect();
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({ "endpoint": "GET /repos/acme/web/milestones", "count": 1, "raw": Value::from(milestones).to_string() }),
    )
    .await;
    // No checkpoint at the next start: a full sweep of every repo.
    s.restart_with(|c| c.reconcile.webhook_grace = Duration::from_secs(60))
        .await;
    until(30.0, "the retitle, by the sweep", || async {
        let (_, f) = s.api(&mut b.clone(), "/api/facets").await;
        f["milestones"]
            .as_array()
            .unwrap()
            .contains(&json!("Retitled just now"))
            .then_some(())
    })
    .await;
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_change_a_sweep_finds_before_its_webhook_lands_is_no_miss() {
    let grace = Duration::from_secs(8);
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let label = label_names(&s, &b).await[0].clone();
    // The rename's webhook takes 5 s, so it lands after the sweep at the next start (no
    // checkpoint: a full sweep of every repo) has read the rename, but within the grace.
    s.fake("POST", "/faults/webhooks", json!({ "delay_ms": 5000 }))
        .await;
    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": label, "rename": "renamed-unseen" }),
    )
    .await;
    let renamed = Instant::now();
    s.restart_with(|c| c.reconcile.webhook_grace = grace).await;
    until(4.0, "the rename, by the sweep", || async {
        label_names(&s, &b)
            .await
            .contains(&"renamed-unseen".to_owned())
            .then_some(())
    })
    .await;
    assert!(
        renamed.elapsed() < Duration::from_secs(5),
        "before the webhook"
    );
    assert_eq!(sync(&s, &b).await, Value::Null);
    // Once the grace is over, the webhook has stamped it: still no miss.
    tokio::time::sleep(Duration::from_secs(7) + grace - renamed.elapsed().min(grace)).await;
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_change_whose_webhook_never_lands_is_a_miss_once_the_grace_is_over() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    let label = label_names(&s, &b).await[0].clone();
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": label, "rename": "renamed-unseen" }),
    )
    .await;
    // No checkpoint at the next start: a full sweep of every repo, which finds the rename.
    s.restart_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.webhook_grace = Duration::from_secs(1);
    })
    .await;
    until(30.0, "the miss, once the grace is over", || async {
        (sync(&s, &b).await["degraded"] == true).then_some(())
    })
    .await;
    assert!(
        label_names(&s, &b)
            .await
            .contains(&"renamed-unseen".to_owned())
    );
}

// --- sweeps ----------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_change_whose_webhook_was_lost_arrives_by_the_next_probe_and_says_sync_degraded() {
    let s = start_with(sweeping).await;
    let b = s.sign_in("tomsj").await;
    let me = unlinked("web")[0].clone();
    assert_eq!(sync(&s, &b).await, Value::Null);
    let mut st = s.stream(&b).await;
    st.reset().await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, &me, json!({ "title": "Webhook lost" })).await;
    until(5.0, "the change, by a probe", || async {
        (title_of(&s, &b, me.2).await == "Webhook lost").then_some(())
    })
    .await;
    let status = loop {
        let ev = st
            .event_within(Duration::from_secs(3))
            .await
            .expect("sync degraded on the stream");
        let v: Value = serde_json::from_str(&ev.data).unwrap();
        if ev.event == "status" && v["sync"]["degraded"] == true {
            break v;
        }
    };
    assert_eq!(status["sync"]["resyncing"], false);
    assert_eq!(sync(&s, &b).await["degraded"], true);
}

/// Fake GitHub's 304s so far, and the installation's core quota used.
async fn conditional(s: &Stack) -> (u64, u64) {
    let st = fake_state(s).await;
    (
        st["not_modified"].as_u64().unwrap(),
        st["quota"]["used"][format!("installation:{INSTALLATION} core")]
            .as_u64()
            .unwrap_or(0),
    )
}

/// Losing access deletes the mirror, and with it whatever sync had missed in it: signing in again
/// imports afresh, and sync is healthy, not degraded from before.
#[tokio::test(flavor = "multi_thread")]
async fn an_account_that_lost_access_with_sync_degraded_signs_in_again_to_healthy_sync() {
    let s = start_with(sweeping).await;
    let mut b = s.sign_in("tomsj").await;
    let me = unlinked("web")[0].clone();
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, &me, json!({ "title": "Webhook lost" })).await;
    until(5.0, "sync degraded", || async {
        (sync(&s, &b).await["degraded"] == true).then_some(())
    })
    .await;

    // The user revokes beghu on GitHub: the account must sign in again, its mirror deleted.
    s.fake("POST", "/revoke", json!({ "login": "tomsj" })).await;
    until(5.0, "signed out", || async {
        (s.api(&mut b.clone(), "/api/me").await.0 == 401).then_some(())
    })
    .await;

    s.sign_in_on(&mut b, "tomsj").await;
    until(30.0, "the fresh import's end", || async {
        let (status, me) = s.api(&mut b.clone(), "/api/me").await;
        (status == 200 && me["import"].is_null()).then_some(())
    })
    .await;
    assert_eq!(title_of(&s, &b, me.2).await, "Webhook lost");
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unchanged_probe_is_a_304_that_costs_nothing_and_changes_nothing() {
    let s = start_with(sweeping).await;
    let b = s.sign_in("tomsj").await;
    // The first probes read what changed lately; the next are 304s.
    until(10.0, "probes answered 304", || async {
        (conditional(&s).await.0 >= 6).then_some(())
    })
    .await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let before = conditional(&s).await;
    let events = st.events_for(Duration::from_millis(1500)).await;
    let after = conditional(&s).await;
    assert!(after.0 >= before.0 + 6, "{before:?} → {after:?}");
    assert_eq!(after.1, before.1, "a 304 spends nothing");
    assert_eq!(events, Vec::<Sse>::new());
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn sweeps_pause_below_a_fifth_of_the_quota_and_webhook_read_backs_do_not() {
    let s = start_with(sweeping).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let me = &web[0];
    until(10.0, "probes answered 304", || async {
        (conditional(&s).await.0 >= 3).then_some(())
    })
    .await;
    // 18% left, as if other work had spent the rest.
    s.fake("PUT", "/quota", json!({ "remaining": 900 })).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, me, json!({ "title": "Waits for the quota" })).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_ne!(title_of(&s, &b, me.2).await, "Waits for the quota");
    // A webhook's read-back doesn't wait.
    let edges = operation(&s, "IssueEdges").await;
    edit(&s, me, json!({ "add_blocked_by": reference(&web[1]) })).await;
    until(4.0, "the read-back", || async {
        (operation(&s, "IssueEdges").await > edges).then_some(())
    })
    .await;
    // The quota comes back: so do the sweeps.
    s.fake("PUT", "/quota", json!({ "remaining": null })).await;
    until(4.0, "the change, once sweeps resume", || async {
        (title_of(&s, &b, me.2).await == "Waits for the quota").then_some(())
    })
    .await;
}

/// Every feed read so far, across the repos.
async fn all_feed_reads(s: &Stack) -> u64 {
    fake_state(s).await["feeds"].as_object().map_or(0, |f| {
        f.values().map(|r| r["reads"].as_u64().unwrap()).sum()
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limit_the_feed_poller_meets_pauses_it_and_the_sweeps_until_it_lifts() {
    let s = start_with(|c| {
        sweeping(c);
        c.reconcile.feed_every = Duration::from_millis(100);
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let _stream = s.stream(&b).await;
    until(10.0, "the poller and the probes at work", || async {
        (all_feed_reads(&s).await > 3 && conditional(&s).await.0 >= 3).then_some(())
    })
    .await;

    // GitHub's secondary limit, asking for 3 s, on one feed read.
    let endpoint = "GET /repos/acme/web/issues/events";
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "status": 403, "limit": "secondary", "retry_after": 3, "count": 1 }),
    )
    .await;
    until(10.0, "the poller to meet it", || async {
        let st = fake_state(&s).await;
        let left = st["faults"]["fail"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["endpoint"] == endpoint)
            .map_or(0, |f| f["remaining"].as_u64().unwrap());
        (left == 0).then_some(())
    })
    .await;
    let met = Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (reads, probes) = (all_feed_reads(&s).await, conditional(&s).await.0);
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert!(
        met.elapsed() < Duration::from_millis(2900),
        "too slow to tell"
    );
    assert_eq!(all_feed_reads(&s).await, reads, "the poller waits");
    assert_eq!(conditional(&s).await.0, probes, "the probes wait");
    // Past the wait, both go on.
    until(10.0, "the poller and the probes again", || async {
        (all_feed_reads(&s).await > reads && conditional(&s).await.0 > probes).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_no_account_syncs_gets_no_probes() {
    let s = start_with(sweeping).await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    // Every call to list `docs`' issues, and `web`'s, is counted: a 404 fails it without retries.
    for repo in ["docs", "web"] {
        s.fake(
            "POST",
            "/faults/fail",
            json!({ "endpoint": format!("GET /repos/acme/{repo}/issues"), "count": 1000, "status": 404 }),
        )
        .await;
    }
    // Nobody syncs docs any more.
    for b in [&mut owner, &mut member] {
        let (_, picker) = s.api(b, "/api/repos").await;
        let keep: Vec<i64> = picker["repos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["synced"] == true && r["name"] != "docs")
            .map(|r| r["id"].as_i64().unwrap())
            .collect();
        let res = s
            .api_write(b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": keep }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{}", res.status());
    }
    let calls = |repo: &'static str| {
        let s = &s;
        async move {
            let st = fake_state(s).await;
            st["faults"]["fail"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["endpoint"] == format!("GET /repos/acme/{repo}/issues"))
                .map_or(1000, |f| 1000 - f["remaining"].as_u64().unwrap())
        }
    };
    // A round already under way may finish, docs and all: web is probed once a round, so its
    // second probe from here is in a round that began after the repos changed.
    let web = calls("web").await;
    until(10.0, "the round under way to end", || async {
        (calls("web").await >= web + 2).then_some(())
    })
    .await;
    let docs = calls("docs").await;
    until(10.0, "web's probes", || async {
        (calls("web").await >= web + 5).then_some(())
    })
    .await;
    assert_eq!(calls("docs").await, docs, "docs is probed by nobody");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_only_account_must_sign_in_again_gets_no_probes() {
    let s = start_with(|c| {
        sweeping(c);
        c.repo_refresh_every = Duration::ZERO;
    })
    .await;
    s.fake("PUT", "/tokens", json!({ "access_ttl": 60 })).await;
    let mut b = s.sign_in("tomsj").await;
    let endpoint = "GET /repos/acme/web/issues";
    s.fake(
        "POST",
        "/faults/fail",
        // Counted, and failed without retries.
        json!({ "endpoint": endpoint, "count": 1000, "status": 404 }),
    )
    .await;
    let calls = || async {
        fake_state(&s).await["faults"]["fail"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["endpoint"] == endpoint)
            .map_or(1000, |f| 1000 - f["remaining"].as_u64().unwrap())
    };
    until(5.0, "web's probes", || async {
        (calls().await >= 2).then_some(())
    })
    .await;
    // The grant is gone: the account isn't active any more.
    s.fake("POST", "/revoke", json!({ "login": "tomsj" })).await;
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);
    // A probe already under way may finish; none starts after it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = calls().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(calls().await, after);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_only_account_is_dormant_gets_no_probes() {
    // The account goes dormant 3 s after signing in: the requests here count as use only hourly.
    let s = start_with(|c| {
        sweeping(c);
        c.accounts_check_every = Duration::from_millis(100);
        c.dormant_after = Duration::from_secs(3);
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let me = s.api(&mut b.clone(), "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let endpoint = "GET /repos/acme/web/issues";
    // Counted, and failed without retries.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "count": 1000, "status": 404 }),
    )
    .await;
    until(5.0, "web's probes", || async {
        (log_reads(&s, endpoint).await >= 2).then_some(())
    })
    .await;
    // Unused, it goes dormant: its mirror goes.
    let mirror = s
        .control_db()
        .with_file_name("mirrors")
        .join(format!("{me}.db"));
    until(10.0, "the account dormant", || async {
        (!mirror.exists()).then_some(())
    })
    .await;
    // A probe already under way may finish; none starts after it.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let after = log_reads(&s, endpoint).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(log_reads(&s, endpoint).await, after);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_deleted_while_its_webhook_was_lost_is_found_by_the_count_check_and_removed() {
    let s = start_with(sweeping).await;
    let b = s.sign_in("tomsj").await;
    let vanished = unlinked("web")[0].clone();
    let status = || async {
        s.api(&mut b.clone(), &format!("/api/issues/{}", vanished.2))
            .await
            .0
    };
    assert_eq!(status().await, 200);
    // A count check has looked at the repo, and found it in step.
    until(5.0, "the first count check", || async {
        (operation(&s, "SweepCounts").await >= 1).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    // Deleted on GitHub, its webhook lost: no probe sees a deletion, so only the count check
    // (one fewer on GitHub than in the mirror) can find it.
    let ids = operation(&s, "SweepIssueIds").await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, &vanished, json!({ "delete": true })).await;
    until(10.0, "the vanished issue gone, by the id sweep", || async {
        (status().await != 200).then_some(())
    })
    .await;
    assert!(operation(&s, "SweepIssueIds").await > ids);
}

/// Sweeps on [`sweeping`]'s schedule, with a change counted as missed only once its webhook has
/// had 3 s to land.
fn sweeping_with_grace(c: &mut beghu::Config) {
    sweeping(c);
    c.reconcile.webhook_grace = Duration::from_secs(3);
}

/// A parent in web with sub-issues `a` and `c`, in that order, every delivery and read-back of
/// them landed: `(parent, a, c)`.
async fn parent_of_two(s: &Stack, b: &Browser) -> [(String, i64, i64); 3] {
    let web = unlinked("web");
    let (parent, a, c) = (&web[0], &web[1], &web[2]);
    edit(s, parent, json!({ "add_sub_issue": reference(a) })).await;
    edit(s, parent, json!({ "add_sub_issue": reference(c) })).await;
    until(5.0, "both sub-issues", || async {
        (children(s, b, parent.2).await == [a.2, c.2]).then_some(())
    })
    .await;
    // The deliveries' read-backs (2 s after the last) and the one opening the parent made are
    // over.
    tokio::time::sleep(Duration::from_secs(3)).await;
    [parent.clone(), a.clone(), c.clone()]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sub_issue_reorder_alone_arrives_by_the_order_sweep_and_leaves_sync_healthy() {
    let s = start_with(sweeping_with_grace).await;
    let b = s.sign_in("tomsj").await;
    let [parent, a, c] = parent_of_two(&s, &b).await;
    let read_backs = operation(&s, "IssueEdges").await;
    // GitHub sends nothing for a reorder, and nothing else changes in the repo: only the order
    // sweep reads it.
    edit(
        &s,
        &parent,
        json!({ "prioritize_sub_issue": reference(&c) }),
    )
    .await;
    until(5.0, "the new order", || async {
        (children(&s, &b, parent.2).await == [c.2, a.2]).then_some(())
    })
    .await;
    assert_eq!(
        operation(&s, "IssueEdges").await,
        read_backs,
        "no read-back"
    );
    // No webhook was missed: there was none to send.
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sub_issue_the_order_sweep_reads_before_its_webhook_lands_leaves_sync_healthy() {
    let s = start_with(sweeping_with_grace).await;
    let b = s.sign_in("tomsj").await;
    let [parent, a, c] = parent_of_two(&s, &b).await;
    let d = unlinked("web")[3].clone();
    // The webhooks take 1.5 s, inside the grace: the order sweep finds the sub-issue first.
    s.fake("POST", "/faults/webhooks", json!({ "delay_ms": 1500 }))
        .await;
    edit(&s, &parent, json!({ "add_sub_issue": reference(&d) })).await;
    until(5.0, "the new sub-issue", || async {
        (children(&s, &b, parent.2).await == [a.2, c.2, d.2]).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(sync(&s, &b).await, Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sub_issue_whose_webhooks_were_lost_arrives_by_the_order_sweep_and_says_sync_degraded() {
    let s = start_with(sweeping_with_grace).await;
    let b = s.sign_in("tomsj").await;
    let [parent, a, c] = parent_of_two(&s, &b).await;
    let d = unlinked("web")[3].clone();
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    edit(&s, &parent, json!({ "add_sub_issue": reference(&d) })).await;
    until(5.0, "the new sub-issue", || async {
        (children(&s, &b, parent.2).await == [a.2, c.2, d.2]).then_some(())
    })
    .await;
    until(6.0, "sync degraded, once the grace is over", || async {
        (sync(&s, &b).await["degraded"] == true).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_parent_reads_its_sub_issue_order_back() {
    // Sweeps off: only opening it can bring the order.
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (parent, a, c) = (&web[0], &web[1], &web[2]);
    edit(&s, parent, json!({ "add_sub_issue": reference(a) })).await;
    edit(&s, parent, json!({ "add_sub_issue": reference(c) })).await;
    // Not opened yet: wait out the deliveries and their read-backs (2 s after the last).
    tokio::time::sleep(Duration::from_secs(5)).await;
    // GitHub sends nothing for a reorder, and no sweep runs: opening the parent brings it.
    edit(&s, parent, json!({ "prioritize_sub_issue": reference(c) })).await;
    until(4.0, "the new order, once opened", || async {
        (children(&s, &b, parent.2).await == [c.2, a.2]).then_some(())
    })
    .await;
}

// --- nightly full sweeps -------------------------------------------------------------------------

/// A "night" of 2 s: each installation's full sweep falls in it at a time of its own, counted
/// from its checkpoint (which redelivery's first check of it sets).
fn nightly(c: &mut beghu::Config) {
    c.reconcile.tick = Duration::from_millis(100);
    c.reconcile.redeliver_every = Duration::from_millis(500);
    c.reconcile.full_every = Duration::from_secs(2);
}

/// Counts from here how often GitHub is asked for `repo`'s labels, which only a full sweep reads.
async fn count_label_reads(s: &Stack, repo: &str) -> String {
    let endpoint = format!("GET /repos/acme/{repo}/labels");
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": endpoint, "ms": 1, "count": 1000 }),
    )
    .await;
    endpoint
}

#[tokio::test(flavor = "multi_thread")]
async fn every_repo_gets_a_full_sweep_each_night() {
    let s = start_with(nightly).await;
    s.sign_in("tomsj").await;
    let web = count_label_reads(&s, "web").await;
    until(30.0, "two nights' full sweeps of web", || async {
        (delayed(&s, &web, 1000).await >= 2).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_full_sweep_keeps_failing_holds_back_no_other_repos_nightly_sweep() {
    let s = start_with(|c| {
        nightly(c);
        c.reconcile.failure_backoff = Duration::from_secs(3600);
    })
    .await;
    s.sign_in("tomsj").await;
    // api's full sweeps all fail: GitHub answers 404 for its labels.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/acme/api/labels", "count": 1000, "status": 404 }),
    )
    .await;
    let web = count_label_reads(&s, "web").await;
    until(30.0, "three nights' full sweeps of web", || async {
        (delayed(&s, &web, 1000).await >= 3).then_some(())
    })
    .await;
}

// --- the full sweep under concurrent changes ------------------------------------------------------

/// Every issue and PR of `repo` the list shows, least recently updated first: `(id, kind, number)`.
async fn everything_in(s: &Stack, b: &Browser, repo: &str) -> Vec<(i64, String, i64)> {
    let q = format!("repo:{repo} is:issue is:pr is:open is:closed sort:updated-asc");
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut query = vec![("q", q.clone())];
        if let Some(a) = &after {
            query.push(("after", a.clone()));
        }
        let path = format!(
            "/api/issues?{}",
            serde_urlencoded::to_string(&query).unwrap()
        );
        let (status, page) = s.api(&mut b.clone(), &path).await;
        assert_eq!(status, 200, "{page}");
        for r in page["rows"].as_array().unwrap() {
            out.push((
                r["id"].as_i64().unwrap(),
                r["kind"].as_str().unwrap().to_owned(),
                r["number"].as_i64().unwrap(),
            ));
        }
        match page["next"].as_str() {
            Some(n) => after = Some(n.to_owned()),
            None => return out,
        }
    }
}

/// POST /api/resync as `b`: its status.
async fn ask_resync(s: &Stack, b: &Browser) -> u16 {
    s.api_write(b, reqwest::Method::POST, "/api/resync")
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// How many calls a counted latency rule on `endpoint` has delayed so far.
async fn delayed(s: &Stack, endpoint: &str, count: u64) -> u64 {
    fake_state(s).await["faults"]["latency"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["endpoint"] == endpoint)
        .map_or(count, |l| count - l["remaining"].as_u64().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_sweep_deletes_nothing_live_when_items_change_while_it_pages() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let before = everything_in(&s, &b, "web").await;
    assert!(before.len() > 200, "{}", before.len());
    // Each page of web's REST issue list takes 3 s, so the test can change GitHub between pages.
    let endpoint = "GET /repos/acme/web/issues";
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": endpoint, "ms": 3000, "count": 100 }),
    )
    .await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    until(60.0, "the sweep's first page of web's issues", || async {
        (delayed(&s, endpoint, 100).await >= 1).then_some(())
    })
    .await;
    // The first page has been read, the second not yet: the ten least recently updated items
    // (all on the first page) change, and move to the end of the list.
    tokio::time::sleep(Duration::from_millis(4500)).await;
    for (_, _, number) in &before[..10] {
        s.edit(json!({ "repo": "web", "number": number, "title": format!("Changed mid-sweep {number}") }))
            .await;
    }
    until(120.0, "the resync to end", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;
    let after: std::collections::BTreeSet<i64> = everything_in(&s, &b, "web")
        .await
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    let gone: Vec<&(i64, String, i64)> = before
        .iter()
        .filter(|(id, _, _)| !after.contains(id))
        .collect();
    assert_eq!(
        gone,
        Vec::<&(i64, String, i64)>::new(),
        "deleted by the sweep"
    );
    assert_eq!(after.len(), before.len());
    // Nothing was recorded as deleted either: the items a page boundary passed over still take
    // their webhooks.
    for (id, _, number) in before[100..110].iter().filter(|(_, k, _)| k == "pr") {
        let title = format!("Edited after the sweep {number}");
        s.edit(json!({ "repo": "web", "number": number, "title": title }))
            .await;
        until(5.0, "the edit, by webhook", || async {
            (title_of(&s, &b, *id).await == title).then_some(())
        })
        .await;
    }
}

/// The label names an issue's detail shows.
async fn labels_of(s: &Stack, b: &Browser, id: i64) -> Vec<String> {
    let (_, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    d["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap().to_owned())
        .collect()
}

/// Every label name the filter bar suggests.
async fn label_names(s: &Stack, b: &Browser) -> Vec<String> {
    let (_, f) = s.api(&mut b.clone(), "/api/facets").await;
    f["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_renamed_or_created_while_a_full_sweep_runs_keeps_what_its_webhook_said() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let mut labelled = None;
    for (id, _, _) in everything_in(&s, &b, "web").await {
        if let Some(l) = labels_of(&s, &b, id).await.first() {
            labelled = Some((id, l.clone()));
            break;
        }
    }
    let (id, label) = labelled.expect("a labelled issue in web");
    // web's milestones, read after its labels, take 3 s: the labels are read, not yet written.
    let endpoint = "GET /repos/acme/web/milestones";
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": endpoint, "ms": 3000, "count": 100 }),
    )
    .await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    until(60.0, "the sweep reading web's milestones", || async {
        (delayed(&s, endpoint, 100).await >= 1).then_some(())
    })
    .await;
    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": label, "rename": "renamed-mid-sweep" }),
    )
    .await;
    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": "created-mid-sweep" }),
    )
    .await;
    until(2.5, "both label webhooks", || async {
        let names = label_names(&s, &b).await;
        (names.iter().any(|n| n == "renamed-mid-sweep")
            && names.iter().any(|n| n == "created-mid-sweep"))
        .then_some(())
    })
    .await;
    until(120.0, "the resync to end", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;
    let names = label_names(&s, &b).await;
    assert!(names.iter().any(|n| n == "created-mid-sweep"), "{names:?}");
    assert!(
        labels_of(&s, &b, id)
            .await
            .contains(&"renamed-mid-sweep".to_owned()),
        "{:?}",
        labels_of(&s, &b, id).await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_renamed_while_a_full_sweep_pages_its_labels_is_not_deleted() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let mut labelled = None;
    for (id, _, _) in everything_in(&s, &b, "web").await {
        if let Some(l) = labels_of(&s, &b, id).await.first() {
            labelled = Some((id, l.clone()));
            break;
        }
    }
    let (id, label) = labelled.expect("a labelled issue in web");
    // A hundred labels named to sort before every fixture label: web's list takes two pages,
    // and the issue's label is on the second.
    for n in 0..100 {
        s.fake(
            "POST",
            "/label",
            json!({ "repo": "web", "name": format!("a-{n:03}") }),
        )
        .await;
    }
    until(10.0, "the new labels' webhooks", || async {
        let names = label_names(&s, &b).await;
        (names.iter().filter(|n| n.starts_with("a-")).count() == 100).then_some(())
    })
    .await;
    // Each page of the list takes 3 s, so the test can change GitHub between them.
    let endpoint = "GET /repos/acme/web/labels";
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": endpoint, "ms": 3000, "count": 2 }),
    )
    .await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    until(60.0, "the sweep asking for the second page", || async {
        (delayed(&s, endpoint, 2).await >= 2).then_some(())
    })
    .await;
    // Renamed to sort first, its webhook lost: the second page no longer has it, and the first
    // was read before it moved there. Asked for by its old name, GitHub answers 404.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": label, "rename": "0-renamed-mid-sweep" }),
    )
    .await;
    until(120.0, "the resync to end", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;
    // Not deleted: the issue keeps it, under the name the mirror knows until a sweep lists it.
    let now = labels_of(&s, &b, id).await;
    assert!(
        now.contains(&label) || now.contains(&"0-renamed-mid-sweep".to_owned()),
        "{now:?}"
    );
}

// --- Resync --------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn resync_runs_a_full_sweep_at_most_once_an_hour() {
    let s = start_with(|c| c.reconcile.webhook_grace = Duration::ZERO).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (parent, child) = (&web[0], &web[1]);
    // A relationship only GitHub knows of: its webhooks were lost.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    edit(&s, parent, json!({ "add_sub_issue": reference(child) })).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(children(&s, &b, parent.2).await, Vec::<i64>::new());

    let resync = || async {
        let res = s
            .api_write(&b, reqwest::Method::POST, "/api/resync")
            .send()
            .await
            .unwrap();
        let retry = res
            .headers()
            .get("retry-after")
            .map(|v| v.to_str().unwrap().parse::<u64>().unwrap());
        (
            res.status().as_u16(),
            retry,
            res.json::<Value>().await.unwrap(),
        )
    };
    let (status, _, body) = resync().await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["sync"]["resyncing"], true);
    until(20.0, "the resync to repair it", || async {
        (children(&s, &b, parent.2).await == [child.2]).then_some(())
    })
    .await;
    // Done, and healthy: the Resync repaired what was missed.
    until(30.0, "the resync to end", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;

    // Again within the hour: refused, saying when.
    let (status, retry, body) = resync().await;
    assert_eq!(status, 429, "{body}");
    assert_eq!(body["error"], "too_soon");
    assert!(
        retry.is_some_and(|r| (3500..=3600).contains(&r)),
        "{retry:?}"
    );
    assert_eq!(body["message"], "Resync is available again in 60 min");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resync_cannot_be_asked_for_from_another_site() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    // Everything as the web app sends it but the Origin.
    let res = s
        .http
        .post(format!("{}/api/resync", s.server))
        .header("cookie", b.header())
        .header("x-beghu-account", b.account())
        .header("origin", "https://elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}

/// A change the server knows it missed in `repo` (a relationship delivery whose read-back can't
/// be made: its installation is gone), which marks every account syncing it for a repair.
async fn miss_a_change(s: &Stack, b: &Browser, repo: &str) {
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    let r = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == repo)
        .unwrap()
        .clone();
    let u = &unlinked(repo)[0];
    let payload = json!({
        "action": "blocked_by_added",
        "repository": { "id": r["id"], "name": repo, "full_name": format!("{}/{repo}", r["owner"].as_str().unwrap()) },
        "installation": { "id": 41009999 },
        "blocked_issue_id": u.2,
        // Dated long ago, so it never changes the row.
        "blocked_issue": { "id": u.2, "node_id": "I_missed", "number": u.1, "title": "x", "state": "open", "updated_at": "2020-01-01T00:00:00Z" },
    });
    let guid = format!("missed-{}", Instant::now().elapsed().as_nanos());
    assert_eq!(s.deliver("issue_dependencies", &guid, &payload).await, 202);
    until(5.0, "the account marked for a repair", || async {
        (sync(s, b).await["degraded"] == true).then_some(())
    })
    .await;
}

/// The account's repair is under way: it shows "resyncing…".
async fn repairing(s: &Stack, b: &Browser) {
    until(10.0, "the repair under way", || async {
        (sync(s, b).await["resyncing"] == true).then_some(())
    })
    .await;
}

/// Repairs as soon as an account is marked, with every GitHub GraphQL call taking a second, so
/// a repair is still running when the test stops the server.
async fn slow_repair() -> (Stack, Browser) {
    let s = start_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.repair_after = Duration::ZERO;
    })
    .await;
    let b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 1000 }),
    )
    .await;
    miss_a_change(&s, &b, "web").await;
    repairing(&s, &b).await;
    (s, b)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repair_cut_short_by_a_crash_is_still_owed_after_the_restart() {
    let (mut s, b) = slow_repair().await;
    s.restart_with(|_| {}).await;
    assert_eq!(sync(&s, &b).await["degraded"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repair_cut_short_by_sigterm_is_still_owed_after_the_restart() {
    let (mut s, b) = slow_repair().await;
    s.sigterm().await.unwrap().unwrap();
    s.restart_with(|_| {}).await;
    assert_eq!(sync(&s, &b).await["degraded"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hourly_resync_limit_outlasts_a_restart() {
    let mut s = start().await;
    let b = s.sign_in("tomsj").await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    until(60.0, "the resync to end", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;
    s.restart_with(|_| {}).await;
    assert_eq!(ask_resync(&s, &b).await, 429);
    assert!(sync(&s, &b).await.is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_resync_while_one_runs_is_accepted_as_the_same_one() {
    // From another tab, say: the first is still running.
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 500 }),
    )
    .await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    assert_eq!(ask_resync(&s, &b).await, 202);
    assert_eq!(sync(&s, &b).await["resyncing"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resync_whose_request_was_dropped_half_way_leaves_resync_working() {
    let s = start_with(|c| c.reconcile.resync_every = Duration::ZERO).await;
    let b = s.sign_in("tomsj").await;
    // Another writer holds the control DB, so the Resync's claim waits; the browser gives up on
    // it meanwhile (a closed tab, say).
    let lock = WriteLock::take(&s.control_db());
    let asked = s
        .api_write(&b, reqwest::Method::POST, "/api/resync")
        .timeout(Duration::from_millis(500))
        .send()
        .await;
    assert!(asked.is_err_and(|e| e.is_timeout()));
    drop(lock);
    until(20.0, "a later Resync to run", || async {
        let res = s
            .api_write(&b, reqwest::Method::POST, "/api/resync")
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        let body = res.json::<Value>().await.unwrap();
        (status == 202 && body["sync"]["resyncing"] == true).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resync_asked_for_during_a_repair_leaves_sync_healthy_once_the_repair_ends() {
    let s = start_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.repair_after = Duration::ZERO;
        c.reconcile.webhook_grace = Duration::ZERO;
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (parent, child) = (&web[0], &web[1]);
    // A relationship only GitHub knows of (its webhooks were lost), which the repair's sweep
    // repairs: a miss of its own.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    edit(&s, parent, json!({ "add_sub_issue": reference(child) })).await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 300 }),
    )
    .await;
    miss_a_change(&s, &b, "web").await;
    repairing(&s, &b).await;
    assert_eq!(ask_resync(&s, &b).await, 202);
    // The Resync is the repair: once it ends, sync is healthy, as after any Resync.
    until(120.0, "the repair to end, healthy", || async {
        sync(&s, &b).await.is_null().then_some(())
    })
    .await;
    assert_eq!(children(&s, &b, parent.2).await, [child.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_repair_keeps_failing_is_tried_again_only_after_a_backoff() {
    let s = start_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.repair_after = Duration::ZERO;
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    // tomsj syncs only web, which GitHub now answers 404 for (transferred, say).
    let (_, picker) = s.api(&mut b, "/api/repos").await;
    let web: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] == "web")
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let res = s
        .api_write(&b, reqwest::Method::PUT, "/api/repos")
        .json(&json!({ "repos": web }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    let endpoint = "GET /repos/acme/web/labels";
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "count": 1000, "status": 404 }),
    )
    .await;
    miss_a_change(&s, &b, "web").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let calls = 1000
        - fake_state(&s).await["faults"]["fail"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["endpoint"] == endpoint)
            .unwrap()["remaining"]
            .as_u64()
            .unwrap();
    assert_eq!(calls, 1, "one repair, then a wait");
    // Still owed.
    assert_eq!(sync(&s, &b).await["degraded"], true);
}
