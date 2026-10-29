//! Webhooks: the fake POSTs the matching delivery to the App's webhook URL about a second after
//! each change, signed with the webhook secret as GitHub signs them (`X-Hub-Signature-256`).
//!
//! Deliveries go out one at a time, in the order they're due. Faults set at runtime change what
//! happens to the next deliveries: `drop` loses them (or only those of one `event.action`, with
//! `drop_only`), `duplicate` sends each twice under one GUID
//! (as a redelivery would), `reorder` holds a batch and sends it newest first, and `delay` adds
//! to every delivery's wait. A reset clears the faults; the target stays.
//!
//! Every attempt is logged, as GitHub logs an App's deliveries (`hook_deliveries.rs` lists them
//! and redelivers them): when, how it went, and the payload, for 3 days on the fake's clock. A
//! dropped delivery is logged as a failed attempt: GitHub sent it, and no answer came back.

use crate::api::rfc3339;
use base64::Engine as _;
use fake_db::q;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// How long after a change GitHub's delivery arrives (measured: 0.5–2.0 s, median 1.3 s).
pub const DELAY: Duration = Duration::from_secs(1);
/// A reorder batch that never fills is sent anyway after this long.
const REORDER_FLUSH: Duration = Duration::from_secs(10);
/// GitHub gives a webhook receiver 10 s.
const TIMEOUT: Duration = Duration::from_secs(10);
/// A failed attempt's `status` when no answer came, and when the receiver couldn't be reached.
/// Only "OK" (a 2xx) is documented (`/webhooks/using-webhooks/automatically-redelivering-failed-
/// deliveries-for-a-github-app-webhook` checks for it); these two wordings and their
/// `status_code` 0 are unverified: check them with `--github` (#118) before relying on them.
const TIMED_OUT: &str = "timed out";
const UNREACHABLE: &str = "failed to connect to host";

/// One delivery: what GitHub sends for one event.
#[derive(Debug, Clone)]
pub(crate) struct Delivery {
    pub guid: String,
    pub event: &'static str,
    pub payload: Value,
    /// Sent again through `POST /app/hook/deliveries/{id}/attempts`.
    pub redelivery: bool,
    /// Lost on the way (the `drop` fault): logged as failed, never sent.
    pub lost: bool,
}

impl Delivery {
    pub fn new(event: &'static str, payload: Value) -> Delivery {
        Delivery {
            guid: guid(),
            event,
            payload,
            redelivery: false,
            lost: false,
        }
    }
}

/// How long GitHub keeps an App's deliveries for listing and redelivery (docs/research/
/// github-app-mechanics.md §4: the pages' body text says 3 days).
pub const RETENTION: i64 = 3 * 24 * 60 * 60;

/// One delivery attempt, as `GET /app/hook/deliveries` lists it, with its payload kept for a
/// redelivery.
#[derive(Debug, Clone)]
pub(crate) struct Attempt {
    pub id: i64,
    pub guid: String,
    /// On the fake's clock, Unix seconds.
    pub delivered_at: i64,
    pub redelivery: bool,
    pub duration: f64,
    pub status: String,
    pub status_code: u16,
    pub event: &'static str,
    pub payload: Value,
    /// Where it went (the App's webhook URL then).
    pub url: String,
    /// The headers it was sent with, as GitHub's delivery log keeps them.
    pub headers: Vec<(&'static str, String)>,
    /// What the receiver answered: its `content-type` and body. None when nothing came back.
    pub response: Option<(Option<String>, String)>,
}

/// What a delivery log keeps of a receiver's answer: at most this many bytes of it.
const RESPONSE_KEPT: usize = 2048;

/// Every attempt in the last [`RETENTION`], oldest first.
#[derive(Default)]
pub(crate) struct Log {
    next_id: i64,
    attempts: Vec<Attempt>,
}

impl Log {
    /// Records an attempt; its id, GitHub's `id`, grows with each.
    fn record(&mut self, mut a: Attempt) {
        self.next_id += 1;
        a.id = 90_000_000 + self.next_id;
        self.attempts.push(a);
    }

    /// The attempts still kept at `now`, oldest first.
    pub fn kept(&mut self, now: i64) -> &[Attempt] {
        self.attempts.retain(|a| a.delivered_at > now - RETENTION);
        &self.attempts
    }
}

/// A GUID in GitHub's `X-GitHub-Delivery` shape.
fn guid() -> String {
    let hex = |n: usize| -> String {
        use rand::Rng as _;
        let mut rng = rand::rng();
        (0..n)
            .map(|_| char::from_digit(rng.random_range(0..16), 16).unwrap_or('0'))
            .collect()
    };
    format!("{}-{}-{}-{}-{}", hex(8), hex(4), hex(4), hex(4), hex(12))
}

/// The webhook faults: each count is the number of deliveries still to be affected.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub(crate) struct Rules {
    pub drop: u32,
    /// With it, `drop` counts only deliveries of this `event.action` (`issues.transferred`); the
    /// others go out as usual.
    pub drop_only: Option<String>,
    pub duplicate: u32,
    /// The size of the next batch to send in reverse; 0 for none.
    pub reorder: u32,
    /// Added to every delivery's wait.
    pub delay_ms: u64,
}

/// Faults to add to the ones in force (`POST /faults/webhooks`).
#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct MoreRules {
    #[serde(default)]
    pub drop: u32,
    /// `event.action`: `drop` loses only deliveries of it. Replaces the one in force.
    pub drop_only: Option<String>,
    #[serde(default)]
    pub duplicate: u32,
    /// The size of a batch to send in reverse; 0 leaves any batch in force.
    #[serde(default)]
    pub reorder: u32,
    pub delay_ms: Option<u64>,
}

/// Where deliveries go, the faults, and the queue to the sender task.
pub(crate) struct Webhooks {
    target: Mutex<Option<String>>,
    secret: String,
    rules: Arc<Mutex<Rules>>,
    held: Arc<Mutex<Vec<Delivery>>>,
    queue: mpsc::UnboundedSender<(Instant, Delivery)>,
    rx: Mutex<Option<mpsc::UnboundedReceiver<(Instant, Delivery)>>>,
    log: Mutex<Log>,
}

impl Webhooks {
    pub fn new(target: Option<String>, secret: String) -> Webhooks {
        let (queue, rx) = mpsc::unbounded_channel();
        Webhooks {
            target: Mutex::new(target),
            secret,
            rules: Arc::default(),
            held: Arc::default(),
            queue,
            rx: Mutex::new(Some(rx)),
            log: Mutex::default(),
        }
    }

    /// The attempt log, as of `now` on the fake's clock.
    pub fn log<T>(&self, now: i64, f: impl FnOnce(&[Attempt]) -> T) -> T {
        let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
        f(log.kept(now))
    }

    fn record(&self, a: Attempt) {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).record(a);
    }

    /// Forgets every attempt (a reset).
    pub fn clear_log(&self) {
        *self.log.lock().unwrap_or_else(|e| e.into_inner()) = Log::default();
    }

    /// Queues `d` to go out again, through the faults, as a redelivery under its own GUID.
    pub fn redeliver(&self, mut d: Delivery) {
        d.redelivery = true;
        d.lost = false;
        self.send_one(d);
    }

    pub fn target(&self) -> Option<String> {
        self.target
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_target(&self, url: Option<String>) {
        *self.target.lock().unwrap_or_else(|e| e.into_inner()) = url;
    }

    pub fn rules(&self) -> Rules {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Adds to the rules in force: counts add up, a reorder starts a new batch, and a delay, if
    /// given, replaces the old one.
    pub fn add_rules(&self, more: MoreRules) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.drop += more.drop;
        if more.drop_only.is_some() {
            rules.drop_only = more.drop_only;
        }
        rules.duplicate += more.duplicate;
        if more.reorder > 0 {
            rules.reorder = more.reorder;
        }
        if let Some(ms) = more.delay_ms {
            rules.delay_ms = ms;
        }
    }

    /// Clears the faults and sends anything a reorder was holding.
    pub fn clear(&self) {
        *self.rules.lock().unwrap_or_else(|e| e.into_inner()) = Rules::default();
        let held = std::mem::take(&mut *self.held.lock().unwrap_or_else(|e| e.into_inner()));
        let due = Instant::now();
        for d in held {
            let _ = self.queue.send((due, d));
        }
    }

    /// Queues `deliveries` (in the order the changes happened) to go out after the usual delay,
    /// through the faults.
    pub fn send(&self, deliveries: Vec<Delivery>) {
        for d in deliveries {
            self.send_one(d);
        }
    }

    fn send_one(&self, mut d: Delivery) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        let due = Instant::now() + DELAY + Duration::from_millis(rules.delay_ms);
        let droppable = rules.drop_only.as_deref().is_none_or(|only| {
            only.split_once('.').is_some_and(|(event, action)| {
                d.event == event && d.payload["action"].as_str() == Some(action)
            })
        });
        if rules.drop > 0 && droppable {
            rules.drop -= 1;
            if rules.drop == 0 {
                rules.drop_only = None;
            }
            // GitHub tried, and got nothing back: the attempt is logged as failed.
            d.lost = true;
            let _ = self.queue.send((due, d));
            return;
        }
        let copies = if rules.duplicate > 0 {
            rules.duplicate -= 1;
            2
        } else {
            1
        };
        if rules.reorder == 0 {
            for _ in 0..copies {
                let _ = self.queue.send((due, d.clone()));
            }
            return;
        }
        let size = rules.reorder as usize;
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let first = held.is_empty();
        for _ in 0..copies {
            held.push(d.clone());
        }
        if held.len() >= size {
            flush(&mut rules, &mut held, &self.queue, due);
        } else if first {
            // A batch that never fills goes out anyway, still newest first.
            let (rules, held, queue) = (self.rules.clone(), self.held.clone(), self.queue.clone());
            let guid = d.guid.clone();
            tokio::spawn(async move {
                tokio::time::sleep(REORDER_FLUSH).await;
                // Rules before held, as `send_one` takes them.
                let mut rules = rules.lock().unwrap_or_else(|e| e.into_inner());
                let mut held = held.lock().unwrap_or_else(|e| e.into_inner());
                if held.first().is_some_and(|d| d.guid == guid) {
                    flush(&mut rules, &mut held, &queue, Instant::now());
                }
            });
        }
    }

    /// The queue [`run`] sends from; there's one, so the first caller gets it.
    pub fn take_receiver(&self) -> Option<mpsc::UnboundedReceiver<(Instant, Delivery)>> {
        self.rx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// `sha256=<hex>` of `body` under the webhook secret.
    pub fn signature(&self, body: &[u8]) -> String {
        sign(&self.secret, body)
    }
}

/// Ends the reorder batch: what it held goes out newest first, due at `due`.
fn flush(
    rules: &mut Rules,
    held: &mut Vec<Delivery>,
    queue: &mpsc::UnboundedSender<(Instant, Delivery)>,
    due: Instant,
) {
    rules.reorder = 0;
    for d in std::mem::take(held).into_iter().rev() {
        let _ = queue.send((due, d));
    }
}

/// GitHub's `X-Hub-Signature-256` for `body` under `secret`: `sha256=<hex HMAC-SHA256>`.
pub fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(body);
    let bytes = mac.finalize().into_bytes();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256={hex}")
}

/// Sends queued deliveries as they fall due, until the queue closes.
pub(crate) async fn run(fake: crate::Fake, mut rx: mpsc::UnboundedReceiver<(Instant, Delivery)>) {
    let http = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("a plain HTTP client");
    while let Some((due, d)) = rx.recv().await {
        tokio::time::sleep_until(due).await;
        let w = &fake.state().webhooks;
        let Some(url) = w.target() else {
            continue;
        };
        let started = std::time::Instant::now();
        let body = serde_json::to_vec(&d.payload).expect("JSON values serialise");
        let installation = d.payload["installation"]["id"].as_i64().unwrap_or(0);
        // GitHub's delivery log names the headers as GitHub wrote them.
        let headers: Vec<(&'static str, String)> = vec![
            ("Accept", "*/*".into()),
            ("User-Agent", "GitHub-Hookshot/fake".into()),
            ("X-GitHub-Delivery", d.guid.clone()),
            ("X-GitHub-Event", d.event.into()),
            ("X-GitHub-Hook-ID", "1000001".into()),
            ("X-GitHub-Hook-Installation-Target-ID", "1000001".into()),
            (
                "X-GitHub-Hook-Installation-Target-Type",
                "integration".into(),
            ),
            ("X-Hub-Signature-256", w.signature(&body)),
            ("content-type", "application/json".into()),
        ];
        let attempt = |status: String,
                       status_code: u16,
                       response: Option<(Option<String>, String)>| Attempt {
            id: 0,
            guid: d.guid.clone(),
            delivered_at: fake.now(),
            redelivery: d.redelivery,
            duration: started.elapsed().as_secs_f64(),
            status,
            status_code,
            event: d.event,
            payload: d.payload.clone(),
            url: url.clone(),
            headers: headers.clone(),
            response,
        };
        if d.lost {
            w.record(attempt(TIMED_OUT.into(), 0, None));
            continue;
        }
        let mut req = http.post(&url);
        for (name, value) in &headers {
            req = req.header(*name, value);
        }
        let res = req.body(body).send().await;
        match res {
            Ok(r) => {
                let code = r.status().as_u16();
                let ok = r.status().is_success();
                let content_type = r
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let text = r.text().await.unwrap_or_default();
                let kept: String = text.chars().take(RESPONSE_KEPT).collect();
                let response = Some((content_type, kept));
                if ok {
                    w.record(attempt("OK".into(), code, response));
                } else {
                    eprintln!(
                        "fake-github: webhook {} {} (installation {installation}) got {code}",
                        d.event, d.guid,
                    );
                    w.record(attempt(
                        format!("Invalid HTTP Response: {code}"),
                        code,
                        response,
                    ));
                }
            }
            Err(e) => {
                eprintln!(
                    "fake-github: webhook {} {} (installation {installation}) failed: {e}",
                    d.event, d.guid
                );
                let status = if e.is_timeout() {
                    TIMED_OUT
                } else {
                    UNREACHABLE
                };
                w.record(attempt(status.into(), 0, None));
            }
        }
    }
}

// --- payloads, in GitHub's shapes ---------------------------------------------------------------

pub(crate) fn user_json(id: i64, login: &str, avatar_url: Option<&str>) -> Value {
    json!({
        "login": login,
        "id": id,
        "node_id": format!("U_kg{id}"),
        "avatar_url": avatar_url,
        "gravatar_id": "",
        "url": format!("https://api.github.com/users/{login}"),
        "html_url": format!("https://github.com/{login}"),
        "type": "User",
        "user_view_type": "public",
        "site_admin": false,
    })
}

pub(crate) fn repo_json(r: &q::RepoRow) -> Value {
    let full = format!("{}/{}", r.owner, r.name);
    json!({
        "id": r.id,
        "node_id": r.node_id,
        "name": r.name,
        "full_name": full,
        "private": r.private,
        "visibility": if r.private { "private" } else { "public" },
        "owner": { "login": r.owner, "type": owner_type(r) },
        "html_url": format!("https://github.com/{full}"),
        "url": format!("https://api.github.com/repos/{full}"),
        "archived": r.archived,
        "disabled": false,
        "has_issues": true,
    })
}

/// `Organization` or `User`, from the App's installation on the repo. A repo the App isn't
/// installed on has nothing to say it; the fixture's repos all belong to orgs.
fn owner_type(r: &q::RepoRow) -> &str {
    r.owner_type.as_deref().unwrap_or("Organization")
}

/// GitHub's `author_association` of `user` on the repo, from what the fixture knows: the repo's
/// owner, the org's members (the fixture accounts marked so) and anyone else with access
/// (collaborators). The fixture's other users have no recorded tie to the repo, so they get
/// GitHub's `NONE`.
pub(crate) fn author_association(
    c: &rusqlite::Connection,
    r: &q::RepoRow,
    user: Option<i64>,
) -> rusqlite::Result<&'static str> {
    let Some(u) = user.map(|id| q::user_row(c, id)).transpose()?.flatten() else {
        return Ok("NONE");
    };
    let org = owner_type(r) == "Organization";
    if !org && u.login.eq_ignore_ascii_case(&r.owner) {
        return Ok("OWNER");
    }
    if org
        && crate::ACCOUNTS
            .iter()
            .any(|a| a.member && a.login == u.login)
    {
        return Ok("MEMBER");
    }
    Ok(match q::permission(c, u.id, r.id)? {
        Some(_) => "COLLABORATOR",
        None => "NONE",
    })
}

pub(crate) fn label_json(
    r: &q::RepoRow,
    id: i64,
    name: &str,
    color: &str,
    description: Option<&str>,
) -> Value {
    json!({
        "id": id,
        "node_id": format!("LA_kw{id}"),
        "url": format!("https://api.github.com/repos/{}/{}/labels/{name}", r.owner, r.name),
        "name": name,
        "color": color,
        "default": false,
        "description": description,
    })
}

/// An issue type as GitHub's REST API serialises it (`issue.type`, and an `issues` delivery's
/// `type` for `typed` and `untyped`): the fields the schema requires (`id`, `node_id`, `name`,
/// `description`) and those the fake can say. The truth keeps only the name, so the id is the
/// name's hash (stable, as an org's type's id is) and there's no description or colour.
pub(crate) fn issue_type_json(name: &str) -> Value {
    // FNV-1a over the lowercased name, kept positive.
    let id = name
        .to_lowercase()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        })
        >> 33;
    json!({
        "id": id,
        "node_id": format!("IT_kw{id}"),
        "name": name,
        "description": null,
        "color": null,
        "is_enabled": true,
    })
}

/// The issue as GitHub's REST API and webhooks serialise it.
pub(crate) fn issue_json(c: &rusqlite::Connection, id: i64) -> rusqlite::Result<Value> {
    let i = q::issue(c, id)?;
    let r = q::repo(c, i.repo_id)?;
    let full = format!("{}/{}", r.owner, r.name);
    let user = |id: Option<i64>| -> rusqlite::Result<Value> {
        Ok(match id {
            Some(id) => match q::user_row(c, id)? {
                Some(u) => user_json(u.id, &u.login, u.avatar_url.as_deref()),
                None => Value::Null,
            },
            None => Value::Null,
        })
    };
    let labels: Vec<Value> = q::issue_labels(c, id)?
        .iter()
        .map(|l| label_json(&r, l.id, &l.name, &l.color, l.description.as_deref()))
        .collect();
    let assignees: Vec<Value> = q::issue_assignees(c, id)?
        .iter()
        .map(|u| user_json(u.id, &u.login, u.avatar_url.as_deref()))
        .collect();
    let milestone = match i.milestone_id {
        Some(m) => milestone_json(c, &r, m)?,
        None => Value::Null,
    };
    let path = if i.kind == "pr" { "pull" } else { "issues" };
    let mut issue = json!({
        "id": i.id,
        "node_id": i.node_id,
        "url": format!("https://api.github.com/repos/{full}/issues/{}", i.number),
        "repository_url": format!("https://api.github.com/repos/{full}"),
        "html_url": format!("https://github.com/{full}/{path}/{}", i.number),
        "number": i.number,
        "title": i.title,
        "user": user(i.author_id)?,
        "labels": labels,
        "state": i.state,
        "state_reason": i.state_reason,
        "locked": i.locked,
        "assignee": assignees.first().cloned().unwrap_or(Value::Null),
        "assignees": assignees,
        "milestone": milestone,
        "comments": i.comments_count,
        // A fixture stub (an issue in a repo the App isn't installed on) has no times; GitHub's
        // issues always do, so the epoch stands in.
        "created_at": rfc3339(i.created_at.unwrap_or(0)),
        "updated_at": rfc3339(i.updated_at.or(i.created_at).unwrap_or(0)),
        "closed_at": i.closed_at.map(rfc3339),
        "author_association": author_association(c, &r, i.author_id)?,
        "active_lock_reason": null,
        "body": i.body,
        "type": i.issue_type.as_deref().map_or(Value::Null, issue_type_json),
    });
    if i.kind == "pr" {
        issue["draft"] = json!(i.draft.unwrap_or(false));
        issue["pull_request"] = json!({
            "url": format!("https://api.github.com/repos/{full}/pulls/{}", i.number),
            "html_url": format!("https://github.com/{full}/pull/{}", i.number),
            "diff_url": format!("https://github.com/{full}/pull/{}.diff", i.number),
            "patch_url": format!("https://github.com/{full}/pull/{}.patch", i.number),
            "merged_at": i.merged_at.map(rfc3339),
        });
    }
    Ok(issue)
}

/// A milestone of `r` as GitHub's REST API and webhooks serialise it; `null` if the truth
/// doesn't have it.
pub(crate) fn milestone_json(
    c: &rusqlite::Connection,
    r: &q::RepoRow,
    id: i64,
) -> rusqlite::Result<Value> {
    let full = format!("{}/{}", r.owner, r.name);
    Ok(match q::milestone(c, id)? {
        Some(m) => json!({
            "id": m.id,
            "node_id": format!("MI_kw{}", m.id),
            "number": m.number,
            "title": m.title,
            "state": m.state,
            "due_on": m.due_on.map(rfc3339),
            "updated_at": m.updated_at.map(rfc3339),
            "url": format!("https://api.github.com/repos/{full}/milestones/{}", m.number),
            "html_url": format!("https://github.com/{full}/milestone/{}", m.number),
        }),
        None => Value::Null,
    })
}

/// The fields every delivery carries besides its event's own.
pub(crate) fn envelope(r: &q::RepoRow, sender: &Value) -> Value {
    let mut envelope = json!({
        "repository": repo_json(r),
        "sender": sender,
    });
    // A repo the App isn't installed on has no installation to name: GitHub leaves it out.
    if let Some(id) = r.installation_id {
        envelope["installation"] = json!({
            "id": id,
            // GitHub's legacy global ID, as its installation payloads still carry it.
            "node_id": base64::engine::general_purpose::STANDARD
                .encode(format!("023:IntegrationInstallation{id}")),
        });
    }
    envelope
}
