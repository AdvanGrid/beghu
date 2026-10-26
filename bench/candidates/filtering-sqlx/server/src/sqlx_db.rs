// The list and facets on sqlx 0.9, for "Benchmark: sqlx against rusqlite at filter load". The shape
// is the one docs/research/compile-time-sql.md recommends: the filter bar's WHERE is assembled at
// run time in an unchecked `QueryBuilder` that returns only ids, and a checked `query!` hydrates
// that page through `json_each(?)`. Everything else in the server stays on rusqlite.

use std::{str::FromStr, time::Duration, time::Instant};

use sqlx::{
    QueryBuilder, Sqlite, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

use crate::{AppError, Facets, IssueRow, ListQuery, Page};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Opens one account's pool (up to 4 connections, one kept open, as the rusqlite pools) and brings
/// its mirror up to date. Returns the pool with the time each step took.
pub async fn open(path: &str) -> (SqlitePool, Duration, Duration) {
    let options = SqliteConnectOptions::from_str(path)
        .expect("mirror path")
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let t0 = Instant::now();
    let pool = SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(options).await.expect("open mirror");
    let opened = t0.elapsed();
    MIGRATOR.run(&pool).await.expect("migrate mirror");
    (pool, opened, t0.elapsed() - opened)
}

pub async fn facets(pool: &SqlitePool) -> Result<Facets, AppError> {
    let mut c = pool.acquire().await?;
    let labels = sqlx::query_scalar!("SELECT DISTINCT name FROM labels ORDER BY name").fetch_all(&mut *c).await?;
    let assignees = sqlx::query_scalar!("SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id")
        .fetch_all(&mut *c)
        .await?;
    Ok(Facets { labels, assignees })
}

/// The same WHERE as the rusqlite server's `list_issues`, bound through the builder.
fn push_filter(b: &mut QueryBuilder<Sqlite>, q: &ListQuery) {
    b.push(" FROM items i WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = ");
    b.push_bind(if q.state.as_deref() == Some("closed") { "closed" } else { "open" });
    for name in &q.label {
        b.push(" AND +i.id IN (SELECT item_id FROM item_labels WHERE label_id IN (SELECT id FROM labels WHERE name = ");
        b.push_bind(name.clone());
        b.push("))");
    }
    for login in &q.assignee {
        b.push(" AND +i.id IN (SELECT item_id FROM item_assignees WHERE user_id IN (SELECT id FROM users WHERE login = ");
        b.push_bind(login.clone());
        b.push("))");
    }
    if let Some(text) = q.q.as_ref().filter(|t| !t.is_empty()) {
        b.push(" AND instr(lower(i.title), lower(");
        b.push_bind(text.clone());
        b.push(")) > 0");
    }
}

pub async fn list_issues(pool: &SqlitePool, q: ListQuery) -> Result<Page, AppError> {
    let offset = q.offset.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    // One connection for the count, the ids and the hydrate, as the rusqlite handler holds one.
    let mut c = pool.acquire().await?;
    let total = if offset == 0 {
        let mut b = QueryBuilder::new("SELECT count(*)");
        push_filter(&mut b, &q);
        b.build_query_scalar::<i64>().fetch_one(&mut *c).await?
    } else {
        -1
    };
    let mut b = QueryBuilder::new("SELECT i.id");
    push_filter(&mut b, &q);
    b.push(" ORDER BY i.updated_at DESC, i.id DESC LIMIT ").push_bind(limit).push(" OFFSET ").push_bind(offset);
    let ids: Vec<i64> = b.build_query_scalar().fetch_all(&mut *c).await?;
    let ids = serde_json::to_string(&ids)?;
    let rows = sqlx::query!(
        r#"SELECT i.id AS "id!", i.number, r.name AS repo, i.title, i.state, i.updated_at, i.comments_count,
             (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id) AS "labels: String",
             (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id) AS "assignees: String"
           FROM json_each(?) AS page JOIN items i ON i.id = page.value JOIN repos r ON r.id = i.repo_id
           ORDER BY i.updated_at DESC, i.id DESC"#,
        ids
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .map(|r| IssueRow {
        id: r.id,
        number: r.number,
        repo: r.repo,
        title: r.title,
        state: r.state,
        updated_at: r.updated_at.unwrap_or_default(),
        comments_count: r.comments_count,
        labels: r.labels.as_deref().and_then(|v| serde_json::from_str(v).ok()).unwrap_or_default(),
        assignees: r.assignees.as_deref().and_then(|v| serde_json::from_str(v).ok()).unwrap_or_default(),
    })
    .collect();
    Ok(Page { rows, total })
}
