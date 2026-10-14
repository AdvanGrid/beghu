// Server side: the SQLite mirror, webhook application and the live-change broadcast.

use crate::api::{Comment, Detail, Facets, Filter, Label, Row};
use leptos::prelude::ServerFnError;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde_json::Value as Json;
use std::sync::OnceLock;
use tokio::sync::broadcast;

pub type Pool = r2d2::Pool<SqliteConnectionManager>;

static POOL: OnceLock<Pool> = OnceLock::new();
static LIVE: OnceLock<broadcast::Sender<Vec<i64>>> = OnceLock::new();

pub fn init(path: &str) {
    let manager = SqliteConnectionManager::file(path)
        .with_init(|c| c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;"));
    let pool = r2d2::Pool::builder().max_size(4).build(manager).expect("open mirror");
    POOL.set(pool).ok();
    LIVE.set(broadcast::channel(256).0).ok();
}

pub fn subscribe() -> broadcast::Receiver<Vec<i64>> {
    LIVE.get().expect("db::init").subscribe()
}

pub fn broadcast(ids: Vec<i64>) {
    let _ = LIVE.get().expect("db::init").send(ids);
}

// Runs a query off the async runtime.
pub async fn run<T: Send + 'static>(
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, ServerFnError> {
    let pool = POOL.get().expect("db::init").clone();
    tokio::task::spawn_blocking(move || {
        let mut c = pool.get().map_err(ServerFnError::new)?;
        f(&mut c).map_err(ServerFnError::new)
    })
    .await
    .map_err(ServerFnError::new)?
}

const ROW: &str = "SELECT i.id, i.number, i.title, i.updated_at, i.comments_count, r.name,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id),
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id)
  FROM items i JOIN repos r ON r.id = i.repo_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let labels: String = r.get(6)?;
    let assignees: String = r.get(7)?;
    Ok(Row {
        id: r.get(0)?,
        number: r.get(1)?,
        title: r.get(2)?,
        updated_at: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        comments_count: r.get(4)?,
        repo: r.get(5)?,
        labels: serde_json::from_str(&labels).unwrap_or_default(),
        assignees: serde_json::from_str(&assignees).unwrap_or_default(),
    })
}

pub fn list(c: &mut Connection, f: &Filter, limit: u32) -> rusqlite::Result<Vec<Row>> {
    let mut sql = format!("{ROW} WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = ?");
    let mut args: Vec<Value> = vec![(if f.closed { "closed" } else { "open" }).to_string().into()];
    for name in &f.labels {
        sql += " AND EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)";
        args.push(name.clone().into());
    }
    for login in &f.assignees {
        sql += " AND EXISTS (SELECT 1 FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id AND u.login = ?)";
        args.push(login.clone().into());
    }
    if !f.q.is_empty() {
        sql += " AND instr(lower(i.title), lower(?)) > 0";
        args.push(f.q.clone().into());
    }
    sql += " ORDER BY i.updated_at DESC, i.id DESC LIMIT ?";
    args.push(i64::from(limit).into());
    let mut st = c.prepare_cached(&sql)?;
    st.query_map(params_from_iter(args), row)?.collect()
}

pub fn facets(c: &mut Connection) -> rusqlite::Result<Facets> {
    let col = |c: &Connection, sql: &str| -> rusqlite::Result<Vec<String>> { c.prepare(sql)?.query_map([], |r| r.get(0))?.collect() };
    Ok(Facets {
        labels: col(c, "SELECT DISTINCT name FROM labels ORDER BY name")?,
        assignees: col(c, "SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id")?,
    })
}

pub fn detail(c: &mut Connection, id: i64) -> rusqlite::Result<Option<Detail>> {
    let Some(head) = c.prepare_cached(&format!("{ROW} WHERE i.id = ?"))?.query_row([id], row).optional()? else {
        return Ok(None);
    };
    let (body, repo_id): (Option<String>, i64) = c.query_row("SELECT body, repo_id FROM items WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let repo_labels = c
        .prepare_cached("SELECT name, color FROM labels WHERE repo_id = ? ORDER BY name")?
        .query_map([repo_id], |r| Ok(Label { name: r.get(0)?, color: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let comments = c
        .prepare_cached(
            "SELECT c.id, u.login, c.body, c.created_at FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.item_id = ? ORDER BY c.created_at, c.id",
        )?
        .query_map([id], |r| Ok(Comment { id: r.get(0)?, author: r.get(1)?, body: r.get(2)?, created_at: r.get(3)? }))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(Detail { row: head, body: body.unwrap_or_default(), repo_labels, comments }))
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn add_label(c: &mut Connection, id: i64, name: &str) -> rusqlite::Result<bool> {
    let label: Option<i64> = c
        .query_row("SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?", params![id, name], |r| r.get(0))
        .optional()?;
    let Some(label) = label else { return Ok(false) };
    let tx = c.transaction()?;
    tx.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", params![id, label])?;
    tx.execute("UPDATE items SET updated_at = ? WHERE id = ?", params![now(), id])?;
    tx.commit()?;
    Ok(true)
}

fn upsert_user(c: &Connection, u: &Json) -> rusqlite::Result<()> {
    if u.is_null() {
        return Ok(());
    }
    c.execute(
        "INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login",
        params![u["id"].as_i64(), u["login"].as_str(), u["avatar_url"].as_str().unwrap_or("")],
    )?;
    Ok(())
}

// Applies an issue object from a webhook, guarded by updated_at (newer or equal wins).
fn apply_issue(c: &Connection, issue: &Json, repo_id: i64) -> rusqlite::Result<bool> {
    let id = issue["id"].as_i64().unwrap_or_default();
    let updated_at = issue["updated_at"].as_str();
    let cur: Option<Option<String>> = c.query_row("SELECT updated_at FROM items WHERE id = ?", [id], |r| r.get(0)).optional()?;
    if let Some(Some(cur)) = cur
        && updated_at.is_some_and(|u| cur.as_str() > u)
    {
        return Ok(false);
    }
    upsert_user(c, &issue["user"])?;
    c.execute(
        "INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
           comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0",
        params![
            id,
            issue["node_id"].as_str(),
            repo_id,
            issue["number"].as_i64(),
            if issue["pull_request"].is_null() { "issue" } else { "pr" },
            issue["title"].as_str(),
            issue["body"].as_str(),
            issue["state"].as_str(),
            issue["state_reason"].as_str(),
            issue["user"]["id"].as_i64(),
            issue["comments"].as_i64().unwrap_or(0),
            issue["created_at"].as_str(),
            updated_at,
            issue["closed_at"].as_str(),
        ],
    )?;
    c.execute("DELETE FROM item_labels WHERE item_id = ?", [id])?;
    for l in issue["labels"].as_array().into_iter().flatten() {
        c.execute(
            "INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)",
            params![l["id"].as_i64(), repo_id, l["name"].as_str(), l["color"].as_str(), l["description"].as_str()],
        )?;
        c.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", params![id, l["id"].as_i64()])?;
    }
    c.execute("DELETE FROM item_assignees WHERE item_id = ?", [id])?;
    for a in issue["assignees"].as_array().into_iter().flatten() {
        upsert_user(c, a)?;
        c.execute("INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)", params![id, a["id"].as_i64()])?;
    }
    Ok(true)
}

pub fn webhook(c: &mut Connection, event: &str, p: &Json) -> rusqlite::Result<Vec<i64>> {
    let mut ids = vec![];
    let repo_id = p["repository"]["id"].as_i64().unwrap_or_default();
    let tx = c.transaction()?;
    match event {
        "issues" if p["issue"].is_object() => {
            if apply_issue(&tx, &p["issue"], repo_id)? {
                ids.extend(p["issue"]["id"].as_i64());
            }
        }
        "issue_comment" if p["comment"].is_object() => {
            let cm = &p["comment"];
            upsert_user(&tx, &cm["user"])?;
            tx.execute(
                "INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                params![cm["id"].as_i64(), cm["node_id"].as_str(), p["issue"]["id"].as_i64(), cm["user"]["id"].as_i64(), cm["body"].as_str(), cm["created_at"].as_str(), cm["updated_at"].as_str()],
            )?;
            apply_issue(&tx, &p["issue"], repo_id)?;
            ids.extend(p["issue"]["id"].as_i64());
        }
        "sub_issues" if p["action"] == "sub_issue_added" => {
            if let (Some(parent), Some(child)) = (p["parent_issue_id"].as_i64(), p["sub_issue_id"].as_i64()) {
                tx.execute(
                    "INSERT OR IGNORE INTO relationships VALUES ('sub', ?1, ?2, (SELECT coalesce(max(position), 0) + 1 FROM relationships WHERE kind = 'sub' AND src_id = ?1), 0)",
                    params![parent, child],
                )?;
                ids.extend([parent, child]);
            }
        }
        _ => {}
    }
    tx.commit()?;
    Ok(ids)
}
