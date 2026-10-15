// Types shared by server and client, and the server functions the UI calls.

use leptos::prelude::*;
use leptos::server_fn::codec::Json;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Label {
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub id: i64,
    pub number: i64,
    pub title: String,
    pub repo: String,
    pub updated_at: String,
    pub comments_count: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    pub id: i64,
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Detail {
    pub row: Row,
    pub body: String,
    pub repo_labels: Vec<Label>,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Filter {
    pub closed: bool,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub q: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Facets {
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

#[server(input = Json)]
pub async fn list_issues(filter: Filter, offset: u32, limit: u32) -> Result<Vec<Row>, ServerFnError> {
    crate::db::run(move |c| crate::db::list(c, &filter, offset, limit.min(1000))).await
}

#[server]
pub async fn get_facets() -> Result<Facets, ServerFnError> {
    crate::db::run(crate::db::facets).await
}

#[server]
pub async fn get_detail(id: i64) -> Result<Option<Detail>, ServerFnError> {
    crate::db::run(move |c| crate::db::detail(c, id)).await
}

#[server]
pub async fn add_label(id: i64, name: String) -> Result<(), ServerFnError> {
    let latency = std::env::var("GITHUB_LATENCY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    // Stands in for the GitHub API call.
    tokio::time::sleep(std::time::Duration::from_millis(latency)).await;
    let added = crate::db::run(move |c| crate::db::add_label(c, id, &name)).await?;
    if !added {
        return Err(ServerFnError::new("no such label"));
    }
    crate::db::broadcast(vec![id]);
    Ok(())
}
