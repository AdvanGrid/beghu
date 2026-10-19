//! The mirror: SQL from the axum + Solid candidate, unchanged, as plain functions.
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension};
use serde::Deserialize;

pub type Pool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
pub type Conn = rusqlite::Connection;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize)]
pub struct Label {
    pub name: String,
    pub color: String,
}

pub struct IssueRow {
    pub id: i64,
    pub number: i64,
    pub repo: String,
    pub title: String,
    pub state: String,
    pub updated_at: String,
    pub comments_count: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
}

pub struct Comment {
    pub id: i64,
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
}

pub struct IssueDetail {
    pub row: IssueRow,
    pub body: String,
    pub repo_labels: Vec<Label>,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Default, Deserialize)]
pub struct ListQuery {
    pub state: Option<String>,
    #[serde(default)]
    pub label: Vec<String>,
    #[serde(default)]
    pub assignee: Vec<String>,
    pub q: Option<String>,
    pub offset: Option<i64>,
}

pub struct Facets {
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

const ROW: &str = "SELECT i.id, i.number, r.name, i.title, i.state, i.updated_at, i.comments_count,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id),
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id)
  FROM items i JOIN repos r ON r.id = i.repo_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<IssueRow> {
    let labels: String = r.get(7)?;
    let assignees: String = r.get(8)?;
    Ok(IssueRow {
        id: r.get(0)?,
        number: r.get(1)?,
        repo: r.get(2)?,
        title: r.get(3)?,
        state: r.get(4)?,
        updated_at: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        comments_count: r.get(6)?,
        labels: serde_json::from_str(&labels).unwrap_or_default(),
        assignees: serde_json::from_str(&assignees).unwrap_or_default(),
    })
}

pub fn facets(c: &Conn) -> Result<Facets> {
    let labels = c
        .prepare_cached("SELECT DISTINCT name FROM labels ORDER BY name").map_err(e)?
        .query_map([], |r| r.get(0)).map_err(e)?
        .collect::<std::result::Result<_, _>>().map_err(e)?;
    let assignees = c
        .prepare_cached("SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id").map_err(e)?
        .query_map([], |r| r.get(0)).map_err(e)?
        .collect::<std::result::Result<_, _>>().map_err(e)?;
    Ok(Facets { labels, assignees })
}

pub fn list(c: &Conn, q: &ListQuery, limit: i64) -> Result<Vec<IssueRow>> {
    let mut sql = format!("{ROW} WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = ?");
    let mut args: Vec<SqlValue> = vec![if q.state.as_deref() == Some("closed") { "closed" } else { "open" }.to_string().into()];
    for name in &q.label {
        sql += " AND i.id IN (SELECT item_id FROM item_labels WHERE label_id IN (SELECT id FROM labels WHERE name = ?))";
        args.push(name.clone().into());
    }
    for login in &q.assignee {
        sql += " AND i.id IN (SELECT item_id FROM item_assignees WHERE user_id IN (SELECT id FROM users WHERE login = ?))";
        args.push(login.clone().into());
    }
    if let Some(text) = q.q.as_ref().filter(|t| !t.is_empty()) {
        sql += " AND instr(lower(i.title), lower(?)) > 0";
        args.push(text.clone().into());
    }
    sql += " ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?";
    args.push(limit.into());
    args.push(q.offset.unwrap_or(0).max(0).into());
    let rows = c.prepare_cached(&sql).map_err(e)?.query_map(params_from_iter(args), row).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?;
    Ok(rows)
}

pub fn detail(c: &Conn, id: i64) -> Result<Option<IssueDetail>> {
    let Some(row) = c.prepare_cached(&format!("{ROW} WHERE i.id = ?")).map_err(e)?.query_row([id], row).optional().map_err(e)? else {
        return Ok(None);
    };
    let (body, repo_id): (Option<String>, i64) =
        c.prepare_cached("SELECT body, repo_id FROM items WHERE id = ?").map_err(e)?.query_row([id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
    let repo_labels = c
        .prepare_cached("SELECT name, color FROM labels WHERE repo_id = ? ORDER BY name").map_err(e)?
        .query_map([repo_id], |r| Ok(Label { name: r.get(0)?, color: r.get(1)? })).map_err(e)?
        .collect::<std::result::Result<_, _>>().map_err(e)?;
    let comments = c
        .prepare_cached(
            "SELECT c.id, u.login, c.body, c.created_at FROM comments c LEFT JOIN users u ON u.id = c.author_id
             WHERE c.item_id = ? ORDER BY c.created_at, c.id",
        ).map_err(e)?
        .query_map([id], |r| Ok(Comment { id: r.get(0)?, author: r.get(1)?, body: r.get(2)?, created_at: r.get(3)? })).map_err(e)?
        .collect::<std::result::Result<_, _>>().map_err(e)?;
    Ok(Some(IssueDetail { row, body: body.unwrap_or_default(), repo_labels, comments }))
}

/// Adds a label by name; `Ok(false)` when the issue's repo has no such label.
pub fn add_label(c: &mut Conn, id: i64, name: &str) -> Result<bool> {
    let label: Option<i64> = c
        .prepare_cached("SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?").map_err(e)?
        .query_row(params![id, name], |r| r.get(0))
        .optional().map_err(e)?;
    let Some(label) = label else { return Ok(false) };
    let tx = c.transaction().map_err(e)?;
    tx.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", params![id, label]).map_err(e)?;
    tx.execute("UPDATE items SET updated_at = ? WHERE id = ?", params![now(), id]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(true)
}

pub fn now() -> String {
    // RFC 3339 in UTC at second precision, without pulling in a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem / 60 % 60, rem % 60)
}

// --- webhooks -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct GhUser {
    id: i64,
    login: String,
    #[serde(default)]
    avatar_url: String,
}

#[derive(Deserialize)]
struct GhLabel {
    id: i64,
    name: String,
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct GhIssue {
    id: i64,
    node_id: String,
    number: i64,
    title: String,
    body: Option<String>,
    state: String,
    state_reason: Option<String>,
    user: Option<GhUser>,
    comments: i64,
    created_at: Option<String>,
    updated_at: String,
    closed_at: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct GhRepo {
    id: i64,
}

#[derive(Deserialize)]
struct GhComment {
    id: i64,
    node_id: String,
    user: Option<GhUser>,
    body: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
pub struct Payload {
    action: Option<String>,
    issue: Option<GhIssue>,
    comment: Option<GhComment>,
    repository: Option<GhRepo>,
    parent_issue_id: Option<i64>,
    sub_issue_id: Option<i64>,
}

fn upsert_user(c: &rusqlite::Connection, u: &GhUser) -> rusqlite::Result<()> {
    c.prepare_cached("INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login")?
        .execute(params![u.id, u.login, u.avatar_url])?;
    Ok(())
}

/// Applies an issue object from a webhook, guarded by updated_at (newer or equal wins).
fn apply_issue(c: &rusqlite::Connection, issue: &GhIssue, repo_id: i64) -> rusqlite::Result<bool> {
    let cur: Option<Option<String>> =
        c.prepare_cached("SELECT updated_at FROM items WHERE id = ?")?.query_row([issue.id], |r| r.get(0)).optional()?;
    if let Some(Some(cur)) = cur {
        if cur.as_str() > issue.updated_at.as_str() {
            return Ok(false);
        }
    }
    if let Some(u) = &issue.user {
        upsert_user(c, u)?;
    }
    c.prepare_cached(
        "INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
           comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0",
    )?
    .execute(params![
        issue.id,
        issue.node_id,
        repo_id,
        issue.number,
        if issue.pull_request.is_some() { "pr" } else { "issue" },
        issue.title,
        issue.body,
        issue.state,
        issue.state_reason,
        issue.user.as_ref().map(|u| u.id),
        issue.comments,
        issue.created_at,
        issue.updated_at,
        issue.closed_at,
    ])?;
    c.prepare_cached("DELETE FROM item_labels WHERE item_id = ?")?.execute([issue.id])?;
    for l in &issue.labels {
        c.prepare_cached("INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)")?
            .execute(params![l.id, repo_id, l.name, l.color, l.description])?;
        c.prepare_cached("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)")?.execute([issue.id, l.id])?;
    }
    c.prepare_cached("DELETE FROM item_assignees WHERE item_id = ?")?.execute([issue.id])?;
    for a in &issue.assignees {
        upsert_user(c, a)?;
        c.prepare_cached("INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)")?.execute([issue.id, a.id])?;
    }
    Ok(true)
}

/// Applies one delivery; returns the ids it changed.
pub fn apply_webhook(c: &mut Conn, event: &str, p: Payload) -> rusqlite::Result<Vec<i64>> {
    let tx = c.transaction()?;
        let mut ids = vec![];
        let repo_id = p.repository.as_ref().map(|r| r.id).unwrap_or_default();
        match event {
            "issues" => {
                if let Some(issue) = &p.issue {
                    if apply_issue(&tx, issue, repo_id)? {
                        ids.push(issue.id);
                    }
                }
            }
            "issue_comment" => {
                if let (Some(comment), Some(issue)) = (&p.comment, &p.issue) {
                    if let Some(u) = &comment.user {
                        upsert_user(&tx, u)?;
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                        params![comment.id, comment.node_id, issue.id, comment.user.as_ref().map(|u| u.id), comment.body, comment.created_at, comment.updated_at],
                    )?;
                    apply_issue(&tx, issue, repo_id)?;
                    ids.push(issue.id);
                }
            }
            "sub_issues" if p.action.as_deref() == Some("sub_issue_added") => {
                if let (Some(parent), Some(child)) = (p.parent_issue_id, p.sub_issue_id) {
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
