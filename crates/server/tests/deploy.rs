//! What a deploy relies on: the previous build's assets outliving it for a day, the control DB's
//! hourly backups and their rotation, a restore from one (caught up with GitHub by redelivery and
//! sweeps), and a drain that stops the jobs and leaves whole databases on the volume.

mod common;

use common::{Browser, Stack, start, start_fresh, start_with};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

/// Replaces the web build's assets with `files` (name, contents).
fn build_with(s: &Stack, files: &[(&str, &str)]) {
    let dir = s.web.join("assets");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for (name, body) in files {
        std::fs::write(dir.join(name), body).unwrap();
    }
}

async fn asset(s: &Stack, name: &str) -> (u16, String) {
    let res = s
        .get(&mut Browser::default(), &format!("/assets/{name}"))
        .await;
    let status = res.status().as_u16();
    (status, res.text().await.unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deploy_keeps_the_previous_builds_assets_until_its_day_is_up() {
    let mut s = start().await;
    build_with(
        &s,
        &[
            ("index-aaa.js", "build A"),
            ("Highlight-same.js", "unchanged"),
        ],
    );
    s.restart_with(|c| c.build_id = "A".into()).await;
    assert_eq!(asset(&s, "index-aaa.js").await, (200, "build A".into()));

    // B's image holds only its own assets; A's stay on the volume after the deploy.
    build_with(
        &s,
        &[
            ("index-bbb.js", "build B"),
            ("Highlight-same.js", "unchanged"),
        ],
    );
    s.restart_with(|c| {
        c.build_id = "B".into();
        c.assets_kept_for = Duration::from_secs(2);
    })
    .await;
    let res = s.get(&mut Browser::default(), "/assets/index-aaa.js").await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(asset(&s, "index-bbb.js").await, (200, "build B".into()));
    assert_eq!(asset(&s, "index-ccc.js").await.0, 404);

    // Once A has been superseded for its time, its own files go; what B shares with it stays.
    let t = Instant::now();
    while asset(&s, "index-aaa.js").await.0 != 404 {
        assert!(t.elapsed() < Duration::from_secs(10), "A's asset stayed");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(t.elapsed() > Duration::from_secs(1), "{:?}", t.elapsed());
    assert_eq!(asset(&s, "index-bbb.js").await.0, 200);
    assert_eq!(asset(&s, "Highlight-same.js").await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_rewrites_an_asset_the_volume_holds_only_part_of() {
    let mut s = start().await;
    build_with(&s, &[("index-aaa.js", "build A")]);
    s.restart_with(|c| c.build_id = "A".into()).await;
    // A full disk (or an older beghu's crash) left the volume's copy short.
    std::fs::write(s.data.join("assets").join("index-aaa.js"), "bui").unwrap();
    s.restart_with(|c| c.build_id = "A".into()).await;
    assert_eq!(asset(&s, "index-aaa.js").await, (200, "build A".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_build_id_deployed_again_keeps_the_files_it_had() {
    let mut s = start().await;
    build_with(&s, &[("index-aaa.js", "first")]);
    s.restart_with(|c| c.build_id = "A".into()).await;
    // Another image under the same id: a tab on the first one still loads its chunks.
    build_with(&s, &[("index-bbb.js", "second")]);
    s.restart_with(|c| c.build_id = "A".into()).await;
    assert_eq!(asset(&s, "index-aaa.js").await, (200, "first".into()));
    assert_eq!(asset(&s, "index-bbb.js").await, (200, "second".into()));
}

/// The hourly backups in `dir`, by name. Not one still being written (`<name>.tmp`), which takes
/// its name once it's whole.
fn hourly(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .filter(|n| n.starts_with("control-20") && n.ends_with("Z.db"))
                .collect()
        })
        .unwrap_or_default()
}

async fn until<T>(secs: u64, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let t = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t.elapsed() < Duration::from_secs(secs), "{what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn backups_keep_the_24_newest_and_the_newest_of_each_of_the_7_days_before_them() {
    let mut s = start().await;
    let dir = s.data.join("backups");
    // A start with no recent backup takes one at once.
    let now = until(10, "the first backup", || hourly(&dir).pop_first()).await;

    // Days 1 to 11 of January 2025 with three backups each, day 13 with twelve.
    let mut seeded = Vec::new();
    for day in 1..=11 {
        for hour in [6, 12, 18] {
            seeded.push(format!("control-202501{day:02}T{hour:02}0000Z.db"));
        }
    }
    for hour in 0..12 {
        seeded.push(format!("control-20250113T{hour:02}0000Z.db"));
    }
    for name in &seeded {
        std::fs::write(dir.join(name), "").unwrap();
    }
    // Not hourly backups: left alone.
    std::fs::write(dir.join("control-before-v2.db"), "").unwrap();
    std::fs::write(dir.join("notes.txt"), "").unwrap();
    // One a crash left half written: deleted.
    let stale = dir.join("control-20250109T060000Z.db.tmp");
    std::fs::write(&stale, "").unwrap();
    s.restart_with(|_| {}).await;

    // The 24 newest: today's, day 13's twelve, days 11, 10 and 9 whole, and day 8's two latest.
    // Then the newest of each of the 7 days before them: day 8's 06:00 and days 7 to 2's 18:00.
    // Day 1 goes: 31 in all.
    let mut want: BTreeSet<String> = [
        "control-20250102T180000Z.db",
        "control-20250103T180000Z.db",
        "control-20250104T180000Z.db",
        "control-20250105T180000Z.db",
        "control-20250106T180000Z.db",
        "control-20250107T180000Z.db",
        "control-20250108T060000Z.db",
        "control-20250108T120000Z.db",
        "control-20250108T180000Z.db",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    for day in 9..=11 {
        for hour in [6, 12, 18] {
            want.insert(format!("control-202501{day:02}T{hour:02}0000Z.db"));
        }
    }
    want.extend((0..12).map(|h| format!("control-20250113T{h:02}0000Z.db")));
    want.insert(now);
    assert_eq!(want.len(), 31);
    until(10, "the rotation", || (hourly(&dir) == want).then_some(())).await;
    assert!(dir.join("control-before-v2.db").exists());
    assert!(dir.join("notes.txt").exists());
    assert!(!stale.exists());
}

/// The first fixture issues in `repo` with no relationships: `(repo, number, id)`.
fn unlinked(repo: &str) -> Vec<(String, i64, i64)> {
    common::summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["repo"] == repo)
        .map(|u| {
            let n = |k: &str| u[k].as_i64().unwrap();
            (repo.to_owned(), n("number"), n("id"))
        })
        .collect()
}

/// An outside edit of `u` on Fake GitHub.
async fn edit(s: &Stack, u: &(String, i64, i64), mut fields: serde_json::Value) {
    fields["repo"] = json!(u.0);
    fields["number"] = json!(u.1);
    s.edit(fields).await;
}

async fn title_of(s: &Stack, b: &Browser, id: i64) -> String {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d["title"].as_str().unwrap().to_owned()
}

/// The sub-issues of `id` in the detail, in order.
async fn children(s: &Stack, b: &Browser, id: i64) -> Vec<i64> {
    let (_, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    d["relationships"]["sub_issues"]
        .as_array()
        .map(|a| a.iter().map(|r| r["id"].as_i64().unwrap()).collect())
        .unwrap_or_default()
}

/// Polls `f` every 50 ms until it holds, or panics after `secs`.
async fn until_async<F, Fut>(secs: u64, what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !f().await {
        assert!(Instant::now() < deadline, "{what}: not within {secs} s");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// How many times Fake GitHub answered a GraphQL operation, since its start.
async fn operation(s: &Stack, op: &str) -> u64 {
    s.fake("GET", "/state", json!({})).await["graphql"]["operations"][op]
        .as_u64()
        .unwrap_or(0)
}

/// Fake GitHub's count of webhook delivery attempts that are `which` ("failed", "redelivered").
async fn deliveries(s: &Stack, which: &str) -> u64 {
    s.fake("GET", "/state", json!({})).await["webhooks"]["deliveries"][which]
        .as_u64()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restored_backup_starts_with_what_it_held_and_catches_up_with_github() {
    let mut s = start().await;
    let dir = s.data.join("backups");
    let mut before = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (me, parent, a, c) = (&web[3], &web[0], &web[1], &web[2]);
    // A parent with sub-issues `a` then `c`, and a webhook landed: the installation's checkpoint,
    // which redelivery reads the log back from.
    let read_backs = operation(&s, "IssueEdges").await;
    edit(
        &s,
        parent,
        json!({ "add_sub_issue": format!("web#{}", a.1) }),
    )
    .await;
    edit(
        &s,
        parent,
        json!({ "add_sub_issue": format!("web#{}", c.1) }),
    )
    .await;
    until_async(5, "both sub-issues", || async {
        children(&s, &before, parent.2).await == [a.2, c.2]
    })
    .await;
    // The deliveries' read-back (2 s after the last) has landed.
    until_async(10, "the deliveries' read-back", || async {
        operation(&s, "IssueEdges").await > read_backs
    })
    .await;
    // A backup taken after all that.
    let landed_at = std::time::SystemTime::now();
    s.restart_with(|c| c.backup_every = Duration::from_secs(1))
        .await;
    let backup = until(10, "a backup after the webhooks landed", || {
        hourly(&dir).into_iter().rev().find(|n| {
            let m = std::fs::metadata(dir.join(n)).unwrap().modified().unwrap();
            m > landed_at
        })
    })
    .await;
    s.restart_with(|_| {}).await;
    let mut after = s.sign_in("ilze-k").await;

    // Stop. While beghu is down, GitHub changes a title (its webhook finds nobody) and the
    // sub-issues' order (GitHub sends no webhook for a reorder).
    s.sigterm().await.unwrap().unwrap();
    let (failed, redelivered) = (
        deliveries(&s, "failed").await,
        deliveries(&s, "redelivered").await,
    );
    edit(&s, me, json!({ "title": "While restoring" })).await;
    edit(
        &s,
        parent,
        json!({ "prioritize_sub_issue": format!("web#{}", c.1) }),
    )
    .await;
    until_async(5, "the failed delivery", || async {
        deliveries(&s, "failed").await > failed
    })
    .await;
    // Copy the backup over the control DB, and start.
    let order_sweeps = operation(&s, "SweepEdges").await;
    std::fs::copy(dir.join(&backup), s.control_db()).unwrap();
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", s.control_db().display()));
    }
    s.restart_with(|c| {
        // Sweeps on a short schedule (the harness keeps them quiet).
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.probe_every = Duration::from_millis(300);
        c.reconcile.count_every = Duration::from_millis(600);
    })
    .await;

    assert_eq!(s.api(&mut before, "/api/me").await.0, 200);
    assert_eq!(s.api(&mut after, "/api/me").await.0, 401);
    // The title by redelivery, at the start (a probe may land it first: either way GitHub was
    // asked to send it again); the order by the order sweep, which GitHub sees asked for before
    // anyone opens the parent (which would read its order back too).
    until_async(10, "the downtime's delivery, redelivered", || async {
        deliveries(&s, "redelivered").await > redelivered
    })
    .await;
    until_async(10, "the title changed during the downtime", || async {
        title_of(&s, &before, me.2).await == "While restoring"
    })
    .await;
    until_async(10, "the order sweep", || async {
        operation(&s, "SweepEdges").await > order_sweeps
    })
    .await;
    until_async(10, "the order changed during the downtime", || async {
        children(&s, &before, parent.2).await == [c.2, a.2]
    })
    .await;
}

/// Every file of the mirrors and the control DB, with its length and last change.
fn volume(data: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    let mut files: Vec<_> = std::fs::read_dir(data.join("mirrors"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .chain([data.join("control.db"), data.join("control.db-wal")])
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?;
            Some((p.display().to_string(), m.len(), m.modified().unwrap()))
        })
        .collect();
    files.sort();
    files
}

#[tokio::test(flavor = "multi_thread")]
async fn the_drain_stops_the_import_between_pages_and_leaves_no_wal_behind() {
    let mut s = start_fresh().await;
    // A slow GitHub keeps the import running when SIGTERM comes.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 300 }),
    )
    .await;
    let mut b = s.sign_in("tomsj").await;
    let (_, picker) = s.api(&mut b, "/api/repos").await;
    let repos: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let picked = s
        .http
        .put(format!("{}/api/repos", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&json!({ "repos": repos }))
        .send()
        .await
        .unwrap();
    assert_eq!(picked.status(), 200);
    s.until_list(&mut b, 20, |page| {
        page["rows"].as_array().is_some_and(|r| !r.is_empty())
    })
    .await;

    tokio::time::timeout(Duration::from_secs(10), s.sigterm())
        .await
        .expect("the drain doesn't wait out the import")
        .unwrap()
        .unwrap();

    // Each database is whole in its own file, and nothing writes to them after the stop.
    let stopped = volume(&s.data);
    for (path, len, _) in &stopped {
        assert!(!path.ends_with("-wal") || *len == 0, "{path}: {len} bytes");
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(volume(&s.data), stopped);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_that_writes_after_the_drain_has_sealed_the_databases_answers_503() {
    let mut s = start_with(|c| c.drain_for = Duration::from_millis(500)).await;
    // A sign-in on its way back from GitHub, whose code exchange outlasts the drain: it stores
    // the account once the control DB is sealed.
    let mut b = Browser::default();
    let to_github = s.get(&mut b, "/auth/login?login=tomsj").await;
    let back = s
        .http
        .get(common::location(&to_github))
        .send()
        .await
        .unwrap();
    let callback = common::location(&back);
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /login/oauth/access_token", "ms": 2000 }),
    )
    .await;
    let signing_in = {
        let req = s.http.get(callback).header("cookie", b.header());
        tokio::spawn(async move { req.send().await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    tokio::time::timeout(Duration::from_secs(10), s.sigterm())
        .await
        .expect("the drain stops")
        .unwrap()
        .unwrap();
    let res = signing_in.await.unwrap();
    assert_eq!(res.status(), 503);
    assert!(res.headers().contains_key("retry-after"), "{res:?}");
}

/// The WAL's length beside the database at `db`; none is as good as an empty one.
fn wal_len(db: &Path) -> u64 {
    std::fs::metadata(format!("{}-wal", db.display())).map_or(0, |m| m.len())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_database_the_checkpoint_waits_on_doesnt_keep_the_others_from_theirs() {
    let mut s = start().await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    let mirror = |b: &Browser| {
        let id = &b.cookies["beghu_acct"];
        s.data.join("mirrors").join(format!("{id}.db"))
    };
    let (mine, theirs) = (mirror(&owner), mirror(&member));
    // An outside edit, applied to both accounts' mirrors.
    let (_, page) = s.api(&mut owner, "/api/issues").await;
    let r = page["rows"][9].clone();
    s.edit(json!({
        "repo": r["repo"], "number": r["number"], "as": "ilze-k",
        "title": "Edited before the drain",
    }))
    .await;
    for b in [&mut owner, &mut member] {
        s.until_list(b, 10, |p| {
            p["rows"][0]["title"] == "Edited before the drain"
        })
        .await;
    }
    assert!(wal_len(&mine) > 0 && wal_len(&theirs) > 0);

    // Another process holds the control DB's write lock and the other account's mirror's as
    // SIGTERM comes: their checkpoints wait on it for SQLite's busy timeout (5 s), past the
    // drain's budget.
    let mut control = rusqlite::Connection::open(s.control_db()).unwrap();
    let mut other = rusqlite::Connection::open(&theirs).unwrap();
    let immediate = rusqlite::TransactionBehavior::Immediate;
    let _held = (
        control.transaction_with_behavior(immediate).unwrap(),
        other.transaction_with_behavior(immediate).unwrap(),
    );
    let t = Instant::now();
    let stopped = s.sigterm();
    // Within a second, long before those two give up: once the server has stopped and its
    // databases close, every WAL is folded whatever the drain did.
    until(1, "this account's mirror checkpointed", || {
        (wal_len(&mine) == 0).then_some(())
    })
    .await;
    assert!(!stopped.is_finished(), "{:?}", t.elapsed());
    tokio::time::timeout(Duration::from_secs(10), stopped)
        .await
        .expect("the drain stops")
        .unwrap()
        .unwrap();
}

/// An `issues` delivery retitling `r` (a list row) at `updated_at`, as GitHub would send it.
fn retitled(repo: i64, r: &serde_json::Value, title: &str, updated_at: &str) -> serde_json::Value {
    json!({
        "action": "edited",
        "issue": {
            "id": r["id"], "node_id": "I_test", "number": r["number"], "title": title,
            "body": "", "state": "open", "state_reason": null, "locked": false,
            "user": { "id": 1, "login": "someone", "avatar_url": null },
            "labels": [], "assignees": [], "milestone": null, "comments": 0,
            "created_at": "2025-01-01T00:00:00Z", "updated_at": updated_at, "closed_at": null,
        },
        "repository": {
            "id": repo, "name": r["repo"],
            "full_name": format!("acme/{}", r["repo"].as_str().unwrap()),
        },
        "installation": { "id": 41000001 },
    })
}

async fn top_title(s: &Stack, b: &mut Browser) -> serde_json::Value {
    s.api(b, "/api/issues").await.1["rows"][0]["title"].clone()
}

async fn ready(s: &Stack) -> u16 {
    s.get(&mut Browser::default(), "/readyz")
        .await
        .status()
        .as_u16()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_that_comes_in_before_the_resume_is_applied_after_the_resumed_ones() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let r = page["rows"][0].clone();
    let (_, me) = s.api(&mut b, "/api/me").await;
    let repo = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == r["repo"])
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let at = "2030-01-01T00:00:00Z";

    // Acked by a server that stops before applying it: unprocessed at the next start.
    let held = s.restart_held(|_| {}).await;
    let first = retitled(repo, &r, "resumed", at);
    assert_eq!(s.deliver("issues", "g-resumed", &first).await, 202);
    drop(held);

    // The next server serves before it resumes: a delivery then is acked, and waits.
    let held = s.restart_held(|_| {}).await;
    assert_eq!(ready(&s).await, 503);
    let second = retitled(repo, &r, "came in early", at);
    assert_eq!(s.deliver("issues", "g-early", &second).await, 202);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(top_title(&s, &mut b).await, r["title"]);
    assert!(!processed(&s, "g-early"));

    // Then the resumed one goes first. The early one, of the same second but saying otherwise,
    // can't be ordered after it: it's left unapplied (the issue is read again, and GitHub's own
    // copy is older still). Applied the other way round, the early one would be the title.
    held.start().await;
    assert_eq!(ready(&s).await, 200);
    s.until_list(&mut b, 5, |p| p["rows"][0]["title"] == "resumed")
        .await;
    // The early one is done with too: applied as far as it could be, and its read-back landed.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !processed(&s, "g-early") {
        assert!(Instant::now() < deadline, "g-early was never processed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(top_title(&s, &mut b).await, "resumed");
}

/// Whether the delivery is marked processed: applied, and its read-back landed or given up. No
/// HTTP seam shows it, so the test reads the control DB.
fn processed(s: &Stack, guid: &str) -> bool {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    control_db::q::pending_delivery(&db, guid)
        .unwrap()
        .is_none()
}
