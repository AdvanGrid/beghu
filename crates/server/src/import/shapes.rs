//! GitHub's shapes, as the import reads them, and the import's GraphQL documents.

use super::paging::Repo;
use super::writes::{ItemData, UserData};
use serde::Deserialize;
use serde_json::Value;

// --- GitHub's shapes -----------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageInfo {
    pub(crate) has_next_page: bool,
    pub(crate) end_cursor: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conn<T> {
    pub(crate) page_info: Option<PageInfo>,
    #[serde(default = "Vec::new")]
    pub(crate) nodes: Vec<Option<T>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Count {
    pub(crate) total_count: i64,
}

#[derive(Deserialize, Debug)]
pub(crate) struct Named {
    pub(crate) name: String,
}

#[derive(Deserialize, Debug)]
pub(crate) struct Nodes<T> {
    #[serde(default = "Vec::new")]
    pub(crate) nodes: Vec<Option<T>>,
}

/// A user, a bot or a deleted account (`null`); only users and bots carry a database id.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Actor {
    pub(crate) login: String,
    pub(crate) avatar_url: Option<String>,
    pub(crate) database_id: Option<i64>,
}

impl Actor {
    pub(crate) fn user(&self) -> Option<UserData> {
        Some(UserData {
            id: self.database_id?,
            login: self.login.clone(),
            avatar_url: self.avatar_url.clone(),
        })
    }
}

#[derive(Deserialize, Clone, Debug)]
pub(crate) struct Login {
    pub(crate) login: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetRepo {
    #[serde(default)]
    pub(crate) id: String,
    pub(crate) database_id: i64,
    pub(crate) name: String,
    pub(crate) owner: Login,
    pub(crate) is_private: bool,
}

/// The issue at a relationship's other end.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    #[serde(rename = "__typename")]
    pub(crate) typename: Option<String>,
    pub(crate) id: String,
    pub(crate) database_id: i64,
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) state: String,
    pub(crate) repository: TargetRepo,
}

#[derive(Deserialize, Debug)]
pub(crate) struct SubSummary {
    pub(crate) total: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
/// `totalBlockedBy` and `totalBlocking` count open and closed issues alike; GitHub's
/// `blockedBy` and `blocking` count only the open ones, and would miss one between two closed
/// issues.
pub(crate) struct DepSummary {
    pub(crate) total_blocked_by: i64,
    pub(crate) total_blocking: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MilestoneRef {
    pub(crate) number: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlIssue {
    pub(crate) id: String,
    pub(crate) database_id: i64,
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) body: Option<String>,
    pub(crate) state: String,
    pub(crate) state_reason: Option<String>,
    #[serde(default)]
    pub(crate) locked: bool,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) closed_at: Option<String>,
    pub(crate) author: Option<Actor>,
    pub(crate) milestone: Option<MilestoneRef>,
    pub(crate) issue_type: Option<Named>,
    pub(crate) comments: Count,
    pub(crate) labels: Conn<Named>,
    pub(crate) assignees: Nodes<Actor>,
    pub(crate) parent: Option<Target>,
    pub(crate) sub_issues_summary: Option<SubSummary>,
    pub(crate) issue_dependencies_summary: Option<DepSummary>,
    pub(crate) relates_to: Option<Conn<Target>>,
}

impl GqlIssue {
    pub(super) fn target(&self, repo: &Repo) -> Target {
        ItemData::from_graphql(self).target(repo)
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelationshipLists {
    pub(crate) id: String,
    pub(crate) sub_issues: Option<Conn<Target>>,
    pub(crate) blocked_by: Option<Conn<Target>>,
    pub(crate) blocking: Option<Conn<Target>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullDetails {
    pub(crate) id: String,
    /// `null` for a PR GitHub can't name by database id (the PR is skipped).
    pub(crate) database_id: Option<i64>,
    #[serde(default)]
    pub(crate) is_draft: bool,
    pub(crate) merged_at: Option<String>,
    pub(crate) head_ref_name: Option<String>,
    pub(crate) base_ref_name: Option<String>,
    pub(crate) review_decision: Option<String>,
    pub(crate) closing_issues_references: Option<Conn<Target>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlComment {
    pub(crate) id: String,
    pub(crate) database_id: i64,
    #[serde(default)]
    pub(crate) body: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) author: Option<Actor>,
}

#[derive(Deserialize, Debug)]
pub(crate) struct WithComments {
    pub(crate) id: String,
    pub(crate) comments: Conn<GqlComment>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct RestUser {
    pub(crate) id: i64,
    pub(crate) login: String,
    pub(crate) avatar_url: Option<String>,
}

impl RestUser {
    pub(crate) fn user(&self) -> UserData {
        UserData {
            id: self.id,
            login: self.login.clone(),
            avatar_url: self.avatar_url.clone(),
        }
    }
}

#[derive(Deserialize, Debug)]
pub(crate) struct RestNamed {
    pub(crate) name: String,
}

#[derive(Deserialize, Debug)]
pub(crate) struct RestMilestone {
    pub(crate) number: i64,
}

#[derive(Deserialize, Debug)]
pub(crate) struct RestIssue {
    pub(crate) id: i64,
    #[serde(default)]
    pub(crate) node_id: String,
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) body: Option<String>,
    pub(crate) state: String,
    pub(crate) state_reason: Option<String>,
    #[serde(default)]
    pub(crate) locked: bool,
    pub(crate) user: Option<RestUser>,
    #[serde(default)]
    pub(crate) labels: Vec<RestNamed>,
    #[serde(default)]
    pub(crate) assignees: Vec<RestUser>,
    pub(crate) milestone: Option<RestMilestone>,
    #[serde(default)]
    pub(crate) comments: i64,
    pub(crate) created_at: Option<String>,
    pub(crate) updated_at: String,
    pub(crate) closed_at: Option<String>,
    pub(crate) pull_request: Option<Value>,
    #[serde(rename = "type")]
    pub(crate) issue_type: Option<RestNamed>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct RestComment {
    pub(crate) id: i64,
    #[serde(default)]
    pub(crate) node_id: String,
    pub(crate) user: Option<RestUser>,
    pub(crate) body: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) issue_url: String,
}

impl RestComment {
    /// The issue's number, from `issue_url` (`…/issues/<number>`).
    pub(crate) fn number(&self) -> Option<i64> {
        self.issue_url.rsplit('/').next()?.parse().ok()
    }
}

// --- the queries -------------------------------------------------------------------------------
// GraphQL wants every fragment a document spreads in that document: each query ends with its own.

/// What a relationship names at its other end.
macro_rules! target_fragment {
    () => {
        "\nfragment Target on Issue { __typename id databaseId number title state \
         repository { id databaseId name owner { login } isPrivate } }"
    };
}

macro_rules! comment_fragment {
    () => {
        "\nfragment Comment on IssueComment { id databaseId body createdAt updatedAt \
         author { login avatarUrl ... on User { databaseId } ... on Bot { databaseId } } }"
    };
}

pub(crate) const IMPORT_ISSUES: &str = concat!(
    "query ImportIssues($owner: String!, $name: String!, $states: [IssueState!]!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id databaseId number title body state stateReason locked createdAt updatedAt closedAt
        author { login avatarUrl ... on User { databaseId } ... on Bot { databaseId } }
        milestone { number }
        issueType { name }
        comments { totalCount }
        labels(first: 100) { pageInfo { hasNextPage endCursor } nodes { name } }
        assignees(first: 100) { nodes { login avatarUrl databaseId } }
        parent { ...Target }
        subIssuesSummary { total }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
        relatesTo(first: 50) { totalCount pageInfo { hasNextPage endCursor } nodes { ...Target } }
      }
    }
  }
}",
    target_fragment!()
);

pub(crate) const IMPORT_RELATIONSHIPS: &str = concat!(
    "query ImportRelationships($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      subIssues(first: 100) { nodes { ...Target } }
      blockedBy(first: 100) { nodes { ...Target } }
      blocking(first: 100) { nodes { ...Target } }
    }
  }
}",
    target_fragment!()
);

pub(crate) const IMPORT_RELATES_TO: &str = concat!(
    "query ImportRelatesTo($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue { id relatesTo(first: 50, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ...Target } } }
  }
}",
    target_fragment!()
);

pub(crate) const IMPORT_PULL_DETAILS: &str = concat!(
    "query ImportPullDetails($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id databaseId isDraft mergedAt headRefName baseRefName reviewDecision
      closingIssuesReferences(first: 50) { pageInfo { hasNextPage endCursor } nodes { ...Target } }
    }
  }
}",
    target_fragment!()
);

pub(crate) const IMPORT_LABELS: &str = "query ImportLabels($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue { id labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name } } }
  }
}";

pub(crate) const IMPORT_CLOSING_REFS: &str = concat!(
    "query ImportClosingRefs($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest { id closingIssuesReferences(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Target } } }
  }
}",
    target_fragment!()
);

pub(crate) const IMPORT_COMMENTS: &str = concat!(
    "query ImportComments($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue { id comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
    ... on PullRequest { id comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
  }
}",
    comment_fragment!()
);

pub(crate) const IMPORT_MORE_COMMENTS: &str = concat!(
    "query ImportMoreComments($id: ID!, $after: String!) {
  node(id: $id) {
    ... on Issue { id comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
    ... on PullRequest { id comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
  }
}",
    comment_fragment!()
);
