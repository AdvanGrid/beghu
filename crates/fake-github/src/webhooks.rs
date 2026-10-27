//! Webhooks: the fake POSTs the matching delivery to the App's webhook URL about a second after
//! each change, signed with the webhook secret as GitHub signs them (`X-Hub-Signature-256`).
//!
//! Deliveries go out one at a time, in the order they're due. Faults set at runtime change what
//! happens to the next deliveries: `drop` loses them, `duplicate` sends each twice under one GUID
//! (as a redelivery would), `reorder` holds a batch and sends it newest first, and `delay` adds
//! to every delivery's wait. A reset clears the faults; the target stays.

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

/// One delivery: what GitHub sends for one event.
#[derive(Debug, Clone)]
pub(crate) struct Delivery {
    pub guid: String,
    pub event: &'static str,
    pub payload: Value,
}

impl Delivery {
    pub fn new(event: &'static str, payload: Value) -> Delivery {
        Delivery {
            guid: guid(),
            event,
            payload,
        }
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
        }
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

    fn send_one(&self, d: Delivery) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        let due = Instant::now() + DELAY + Duration::from_millis(rules.delay_ms);
        if rules.drop > 0 {
            rules.drop -= 1;
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
        let body = serde_json::to_vec(&d.payload).expect("JSON values serialise");
        let installation = d.payload["installation"]["id"].as_i64().unwrap_or(0);
        let res = http
            .post(&url)
            .header("content-type", "application/json")
            .header("user-agent", "GitHub-Hookshot/fake")
            .header("x-github-event", d.event)
            .header("x-github-delivery", &d.guid)
            .header("x-github-hook-id", "1000001")
            .header("x-github-hook-installation-target-id", "1000001")
            .header("x-github-hook-installation-target-type", "integration")
            .header("x-hub-signature-256", w.signature(&body))
            .body(body)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => eprintln!(
                "fake-github: webhook {} {} (installation {installation}) got {}",
                d.event,
                d.guid,
                r.status()
            ),
            Err(e) => eprintln!(
                "fake-github: webhook {} {} (installation {installation}) failed: {e}",
                d.event, d.guid
            ),
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
        Some(m) => match q::milestone(c, m)? {
            Some(m) => json!({
                "id": m.id,
                "node_id": format!("MI_kw{}", m.id),
                "number": m.number,
                "title": m.title,
                "state": m.state,
                "due_on": m.due_on.map(rfc3339),
                "url": format!("https://api.github.com/repos/{full}/milestones/{}", m.number),
                "html_url": format!("https://github.com/{full}/milestone/{}", m.number),
            }),
            None => Value::Null,
        },
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
        "created_at": i.created_at.map(rfc3339),
        "updated_at": i.updated_at.map(rfc3339),
        "closed_at": i.closed_at.map(rfc3339),
        "author_association": author_association(c, &r, i.author_id)?,
        "active_lock_reason": null,
        "body": i.body,
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
