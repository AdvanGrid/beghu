//! GitHub's shapes, as the import reads them, and the import's GraphQL documents.

use super::paging::Repo;
use super::writes::{ItemData, UserData};
use serde::Deserialize;
use serde_json::Value;

// --- GitHub's shapes -----------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct PageInfo {
    pub(super) has_next_page: bool,
    pub(super) end_cursor: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct Conn<T> {
    pub(super) page_info: Option<PageInfo>,
    #[serde(default = "Vec::new")]
    pub(super) nodes: Vec<Option<T>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct Count {
    pub(super) total_count: i64,
}

#[derive(Deserialize, Debug)]
pub(super) struct Named {
    pub(super) name: String,
}

#[derive(Deserialize, Debug)]
pub(super) struct Nodes<T> {
    #[serde(default = "Vec::new")]
    pub(super) nodes: Vec<Option<T>>,
}

/// A user, a bot or a deleted account (`null`); only users and bots carry a database id.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct Actor {
    pub(super) login: String,
    pub(super) avatar_url: Option<String>,
    pub(super) database_id: Option<i64>,
}

impl Actor {
    pub(super) fn user(&self) -> Option<UserData> {
        Some(UserData {
            id: self.database_id?,
            login: self.login.clone(),
            avatar_url: self.avatar_url.clone(),
        })
    }
}

#[derive(Deserialize, Clone, Debug)]
pub(super) struct Login {
    pub(super) login: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct TargetRepo {
    #[serde(default)]
    pub(super) id: String,
    pub(super) database_id: i64,
    pub(super) name: String,
    pub(super) owner: Login,
    pub(super) is_private: bool,
}

/// The issue at a relationship's other end.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct Target {
    #[serde(rename = "__typename")]
    pub(super) typename: Option<String>,
    pub(super) id: String,
    pub(super) database_id: i64,
    pub(super) number: i64,
    pub(super) title: String,
    pub(super) state: String,
    pub(super) repository: TargetRepo,
}

#[derive(Deserialize, Debug)]
pub(super) struct SubSummary {
    pub(super) total: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
/// `totalBlockedBy` and `totalBlocking` count open and closed issues alike; GitHub's
/// `blockedBy` and `blocking` count only the open ones, and would miss one between two closed
/// issues.
pub(super) struct DepSummary {
    pub(super) total_blocked_by: i64,
    pub(super) total_blocking: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct MilestoneRef {
    pub(super) number: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlIssue {
    pub(super) id: String,
    pub(super) database_id: i64,
    pub(super) number: i64,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) state: String,
    pub(super) state_reason: Option<String>,
    #[serde(default)]
    pub(super) locked: bool,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) closed_at: Option<String>,
    pub(super) author: Option<Actor>,
    pub(super) milestone: Option<MilestoneRef>,
    pub(super) issue_type: Option<Named>,
    pub(super) comments: Count,
    pub(super) labels: Conn<Named>,
    pub(super) assignees: Nodes<Actor>,
    pub(super) parent: Option<Target>,
    pub(super) sub_issues_summary: Option<SubSummary>,
    pub(super) issue_dependencies_summary: Option<DepSummary>,
    pub(super) relates_to: Option<Conn<Target>>,
}

impl GqlIssue {
    pub(super) fn target(&self, repo: &Repo) -> Target {
        ItemData::from_graphql(self).target(repo)
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelationshipLists {
    pub(super) id: String,
    pub(super) sub_issues: Option<Conn<Target>>,
    pub(super) blocked_by: Option<Conn<Target>>,
    pub(super) blocking: Option<Conn<Target>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct PullDetails {
    pub(super) id: String,
    /// `null` for a PR GitHub can't name by database id (the PR is skipped).
    pub(super) database_id: Option<i64>,
    #[serde(default)]
    pub(super) is_draft: bool,
    pub(super) merged_at: Option<String>,
    pub(super) head_ref_name: Option<String>,
    pub(super) base_ref_name: Option<String>,
    pub(super) review_decision: Option<String>,
    pub(super) closing_issues_references: Option<Conn<Target>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlComment {
    pub(super) id: String,
    pub(super) database_id: i64,
    #[serde(default)]
    pub(super) body: String,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) author: Option<Actor>,
}

#[derive(Deserialize, Debug)]
pub(super) struct WithComments {
    pub(super) id: String,
    pub(super) comments: Conn<GqlComment>,
}

#[derive(Deserialize, Debug)]
pub(super) struct RestUser {
    pub(super) id: i64,
    pub(super) login: String,
    pub(super) avatar_url: Option<String>,
}

impl RestUser {
    pub(super) fn user(&self) -> UserData {
        UserData {
            id: self.id,
            login: self.login.clone(),
            avatar_url: self.avatar_url.clone(),
        }
    }
}

#[derive(Deserialize, Debug)]
pub(super) struct RestNamed {
    pub(super) name: String,
}

#[derive(Deserialize, Debug)]
pub(super) struct RestMilestone {
    pub(super) number: i64,
}

#[derive(Deserialize, Debug)]
pub(super) struct RestIssue {
    pub(super) id: i64,
    #[serde(default)]
    pub(super) node_id: String,
    pub(super) number: i64,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) state: String,
    pub(super) state_reason: Option<String>,
    #[serde(default)]
    pub(super) locked: bool,
    pub(super) user: Option<RestUser>,
    #[serde(default)]
    pub(super) labels: Vec<RestNamed>,
    #[serde(default)]
    pub(super) assignees: Vec<RestUser>,
    pub(super) milestone: Option<RestMilestone>,
    #[serde(default)]
    pub(super) comments: i64,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: String,
    pub(super) closed_at: Option<String>,
    pub(super) pull_request: Option<Value>,
    #[serde(rename = "type")]
    pub(super) issue_type: Option<RestNamed>,
}

#[derive(Deserialize, Debug)]
pub(super) struct RestComment {
    pub(super) id: i64,
    #[serde(default)]
    pub(super) node_id: String,
    pub(super) user: Option<RestUser>,
    pub(super) body: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: String,
    #[serde(default)]
    pub(super) issue_url: String,
}

impl RestComment {
    /// The issue's number, from `issue_url` (`…/issues/<number>`).
    pub(super) fn number(&self) -> Option<i64> {
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

pub(super) const IMPORT_ISSUES: &str = concat!(
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

pub(super) const IMPORT_RELATIONSHIPS: &str = concat!(
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

pub(super) const IMPORT_RELATES_TO: &str = concat!(
    "query ImportRelatesTo($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue { id relatesTo(first: 50, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ...Target } } }
  }
}",
    target_fragment!()
);

pub(super) const IMPORT_PULL_DETAILS: &str = concat!(
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

pub(super) const IMPORT_LABELS: &str = "query ImportLabels($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue { id labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name } } }
  }
}";

pub(super) const IMPORT_CLOSING_REFS: &str = concat!(
    "query ImportClosingRefs($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest { id closingIssuesReferences(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Target } } }
  }
}",
    target_fragment!()
);

pub(super) const IMPORT_COMMENTS: &str = concat!(
    "query ImportComments($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue { id comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
    ... on PullRequest { id comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
  }
}",
    comment_fragment!()
);

pub(super) const IMPORT_MORE_COMMENTS: &str = concat!(
    "query ImportMoreComments($id: ID!, $after: String!) {
  node(id: $id) {
    ... on Issue { id comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
    ... on PullRequest { id comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Comment } } }
  }
}",
    comment_fragment!()
);
