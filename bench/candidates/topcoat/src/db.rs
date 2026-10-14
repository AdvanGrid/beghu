//! The SQLite mirror: list and detail queries, webhook writes and the label write. One connection
//! behind a mutex; every query here is a few milliseconds, so nothing holds it across an await.

use std::{collections::HashMap, sync::Mutex};

use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};
use serde_json::Value as Json;
use tokio::sync::broadcast;

pub struct Db {
    conn: Mutex<Connection>,
    changes: broadcast::Sender<Vec<i64>>,
    /// Match counts per filter, cleared on every write. A scroll re-renders the window but
    /// keeps the filter, and a count over 50k rows costs tens of ms.
    counts: Mutex<HashMap<String, usize>>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

pub struct Filter {
    pub state: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub q: String,
}

pub struct Row {
    pub id: i64,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: i64,
}

pub struct Page {
    pub rows: Vec<Row>,
    pub total: usize,
}

pub struct Comment {
    pub author: String,
    pub created_at: String,
    pub body: String,
}

pub struct Detail {
    pub id: i64,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub state: String,
    pub body: String,
    pub labels: Vec<String>,
    pub repo_labels: Vec<String>,
    pub comments: Vec<Comment>,
}

const ROW: &str = "SELECT i.id, r.name, i.number, i.title, i.comments_count,
    (SELECT group_concat(l.name, char(31)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id),
    (SELECT group_concat(u.login, char(31)) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id)
    FROM items i JOIN repos r ON r.id = i.repo_id";

fn split(s: Option<String>) -> Vec<String> {
    s.map(|s| s.split('\u{1f}').map(str::to_owned).collect()).unwrap_or_default()
}

fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    // Days-from-civil inverse (Howard Hinnant), to print UTC without a date crate.
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

impl Db {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
             -- The fixture's items_list doesn't cover is_stub, so counts read every row. Partial and
             -- with the title, so counts and searches stay inside the index.
             CREATE INDEX IF NOT EXISTS bench_issue_list ON items(state, updated_at DESC, id DESC, title) WHERE kind = 'issue' AND is_stub = 0;
             CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id, created_at, id);
             CREATE INDEX IF NOT EXISTS item_labels_label ON item_labels(label_id);
             CREATE INDEX IF NOT EXISTS item_assignees_user ON item_assignees(user_id);",
        )?;
        let labels = conn
            .prepare("SELECT DISTINCT name FROM labels ORDER BY name")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let assignees = conn
            .prepare("SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(Self { conn: Mutex::new(conn), changes: broadcast::channel(256).0, counts: Mutex::default(), labels, assignees })
    }

    /// Issue ids touched by each committed change.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<i64>> {
        self.changes.subscribe()
    }

    pub fn list(&self, f: &Filter, offset: usize, limit: usize) -> rusqlite::Result<Page> {
        let mut wh = vec!["i.kind = 'issue'".to_owned(), "i.is_stub = 0".to_owned(), "i.state = ?".to_owned()];
        let mut args: Vec<Value> = vec![f.state.clone().into()];
        for l in &f.labels {
            wh.push("EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)".into());
            args.push(l.clone().into());
        }
        for a in &f.assignees {
            wh.push("EXISTS (SELECT 1 FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id AND u.login = ?)".into());
            args.push(a.clone().into());
        }
        if !f.q.is_empty() {
            wh.push("instr(lower(i.title), lower(?)) > 0".into());
            args.push(f.q.clone().into());
        }
        let wh = wh.join(" AND ");
        let conn = self.conn.lock().unwrap();
        let key = format!("{wh}{args:?}");
        let cached = self.counts.lock().unwrap().get(&key).copied();
        let total = match cached {
            Some(n) => n,
            None => {
                let n = conn.prepare_cached(&format!("SELECT count(*) FROM items i WHERE {wh}"))?.query_row(params_from_iter(&args), |r| r.get::<_, i64>(0))? as usize;
                self.counts.lock().unwrap().insert(key, n);
                n
            }
        };
        args.push((limit as i64).into());
        args.push((offset as i64).into());
        let rows = conn
            .prepare_cached(&format!("{ROW} WHERE {wh} ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?"))?
            .query_map(params_from_iter(&args), |r| {
                Ok(Row {
                    id: r.get(0)?,
                    repo: r.get(1)?,
                    number: r.get(2)?,
                    title: r.get(3)?,
                    comments: r.get(4)?,
                    labels: split(r.get(5)?),
                    assignees: split(r.get(6)?),
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Page { rows, total })
    }

    pub fn detail(&self, id: i64) -> rusqlite::Result<Option<Detail>> {
        let conn = self.conn.lock().unwrap();
        let Some((repo_id, repo, number, title, state, body)) = conn
            .prepare_cached("SELECT i.repo_id, r.name, i.number, i.title, i.state, coalesce(i.body, '') FROM items i JOIN repos r ON r.id = i.repo_id WHERE i.id = ?")?
            .query_row([id], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .optional()?
        else {
            return Ok(None);
        };
        let names = |sql: &str, arg: i64| -> rusqlite::Result<Vec<String>> {
            conn.prepare_cached(sql)?.query_map([arg], |r| r.get(0))?.collect()
        };
        let labels = names("SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = ? ORDER BY l.name", id)?;
        let repo_labels = names("SELECT name FROM labels WHERE repo_id = ? ORDER BY name", repo_id)?;
        let comments = conn
            .prepare_cached("SELECT coalesce(u.login, 'ghost'), c.created_at, c.body FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.item_id = ? ORDER BY c.created_at, c.id")?
            .query_map([id], |r| Ok(Comment { author: r.get(0)?, created_at: r.get(1)?, body: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        Ok(Some(Detail { id, repo, number, title, state, body, labels, repo_labels, comments }))
    }

    pub fn add_label(&self, id: i64, name: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let Some(label): Option<i64> = conn
            .query_row("SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?", (id, name), |r| r.get(0))
            .optional()?
        else {
            return Ok(false);
        };
        conn.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", (id, label))?;
        conn.execute("UPDATE items SET updated_at = ? WHERE id = ?", (now(), id))?;
        drop(conn);
        self.counts.lock().unwrap().clear();
        let _ = self.changes.send(vec![id]);
        Ok(true)
    }

    /// Applies a GitHub-shaped webhook. The payload is the truth; there is no GitHub to fetch.
    pub fn webhook(&self, event: &str, p: &Json) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut ids = Vec::new();
        let repo = p["repository"]["id"].as_i64();
        match event {
            "issues" => {
                if let Some(repo) = repo
                    && apply_issue(&tx, &p["issue"], repo)?
                {
                    ids.extend(p["issue"]["id"].as_i64());
                }
            }
            "issue_comment" => {
                let c = &p["comment"];
                if let (Some(repo), Some(cid)) = (repo, c["id"].as_i64()) {
                    upsert_user(&tx, &c["user"])?;
                    tx.execute(
                        "INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                        (cid, c["node_id"].as_str(), p["issue"]["id"].as_i64(), c["user"]["id"].as_i64(), c["body"].as_str(), c["created_at"].as_str(), c["updated_at"].as_str()),
                    )?;
                    apply_issue(&tx, &p["issue"], repo)?;
                    ids.extend(p["issue"]["id"].as_i64());
                }
            }
            "sub_issues" if p["action"] == "sub_issue_added" => {
                if let (Some(parent), Some(child)) = (p["parent_issue_id"].as_i64(), p["sub_issue_id"].as_i64()) {
                    tx.execute(
                        "INSERT OR IGNORE INTO relationships VALUES ('sub', ?1, ?2, (SELECT coalesce(max(position), 0) + 1 FROM relationships WHERE kind = 'sub' AND src_id = ?1), 0)",
                        (parent, child),
                    )?;
                    ids.extend([parent, child]);
                }
            }
            _ => {}
        }
        tx.commit()?;
        drop(conn);
        if !ids.is_empty() {
            self.counts.lock().unwrap().clear();
            let _ = self.changes.send(ids);
        }
        Ok(())
    }
}

fn upsert_user(tx: &Connection, u: &Json) -> rusqlite::Result<()> {
    if let Some(id) = u["id"].as_i64() {
        tx.execute(
            "INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login",
            (id, u["login"].as_str(), u["avatar_url"].as_str().unwrap_or("")),
        )?;
    }
    Ok(())
}

// Newer or equal updated_at wins, as in the stub.
fn apply_issue(tx: &Connection, i: &Json, repo: i64) -> rusqlite::Result<bool> {
    let Some(id) = i["id"].as_i64() else { return Ok(false) };
    let updated = i["updated_at"].as_str().unwrap_or_default();
    let cur: Option<String> = tx.query_row("SELECT updated_at FROM items WHERE id = ?", [id], |r| r.get(0)).optional()?.flatten();
    if cur.is_some_and(|c| c.as_str() > updated) {
        return Ok(false);
    }
    upsert_user(tx, &i["user"])?;
    tx.execute(
        "INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
           comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0",
        rusqlite::params![
            id,
            i["node_id"].as_str(),
            repo,
            i["number"].as_i64(),
            if i["pull_request"].is_object() { "pr" } else { "issue" },
            i["title"].as_str(),
            i["body"].as_str(),
            i["state"].as_str(),
            i["state_reason"].as_str(),
            i["user"]["id"].as_i64(),
            i["comments"].as_i64().unwrap_or(0),
            i["created_at"].as_str(),
            updated,
            i["closed_at"].as_str(),
        ],
    )?;
    tx.execute("DELETE FROM item_labels WHERE item_id = ?", [id])?;
    for l in i["labels"].as_array().into_iter().flatten() {
        tx.execute(
            "INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)",
            (l["id"].as_i64(), repo, l["name"].as_str(), l["color"].as_str(), l["description"].as_str()),
        )?;
        tx.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", (id, l["id"].as_i64()))?;
    }
    tx.execute("DELETE FROM item_assignees WHERE item_id = ?", [id])?;
    for a in i["assignees"].as_array().into_iter().flatten() {
        upsert_user(tx, a)?;
        tx.execute("INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)", (id, a["id"].as_i64()))?;
    }
    Ok(true)
}
