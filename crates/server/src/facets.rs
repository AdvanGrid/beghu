//! The filter bar's suggestions. `/api/facets` lists each facet's values across the synced
//! repos; it doesn't depend on the view, so one fetch serves every keystroke. Counts cost a
//! grouped pass over the view's rows, so they come separately and only for a value list that
//! stays open: `/api/facets/:facet/counts?q=…`.

use crate::App;
use crate::auth::Session;
use crate::error::ApiError;
use crate::query;
use axum::Json;
use axum::extract::rejection::PathRejection;
use axum::extract::{Extension, Path, Query as Params, State};
use mirror_db::list;
use mirror_db::{Caller, Connection, QueryResult, q};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// Each facet's values, for suggestions.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Facets {
    pub labels: Vec<crate::api::Label>,
    pub assignees: Vec<String>,
    pub authors: Vec<String>,
    /// `name`, or `owner/name` where two synced repos share a name.
    pub repos: Vec<String>,
    /// Titles, open milestones first.
    pub milestones: Vec<String>,
    /// Issue type names.
    pub types: Vec<String>,
}

/// A facet the bar suggests values for: the key of its qualifier (`label:` and so on).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Facet {
    Label,
    Assignee,
    Author,
    Repo,
    Milestone,
    Type,
}

pub async fn facets(
    State(app): State<App>,
    Extension(s): Extension<Session>,
) -> Result<Json<Facets>, ApiError> {
    let (labels, assignees, authors, repos, milestones, types) = app
        .mirrors()
        .read(s.account, Caller::Request, |c| {
            Ok((
                q::facet_labels(c)?,
                q::facet_assignees(c)?,
                q::facet_authors(c)?,
                RepoNames::read(c)?,
                q::facet_milestones(c)?,
                q::facet_types(c)?,
            ))
        })
        .await?;
    Ok(Json(Facets {
        labels: labels
            .into_iter()
            .map(|l| crate::api::Label {
                name: l.name,
                color: l.color,
            })
            .collect(),
        assignees,
        authors,
        repos: repos.synced(),
        milestones: milestones.into_iter().map(|m| m.title).collect(),
        types,
    }))
}

/// How the bar names a synced repo: `name`, or `owner/name` where two synced repos share the
/// name (GitHub's names are case-insensitive). The facet list and the repo counts both name
/// repos this way, so the bar finds each value's count under the value it lists.
struct RepoNames {
    /// The synced repos' `(owner, name)`, by owner then name.
    synced: Vec<(String, String)>,
    /// How many synced repos have each lowercased name.
    shared: HashMap<String, usize>,
}

impl RepoNames {
    fn read(c: &Connection) -> QueryResult<RepoNames> {
        let synced: Vec<(String, String)> = q::synced_repos(c)?
            .into_iter()
            .map(|r| (r.owner, r.name))
            .collect();
        let mut shared: HashMap<String, usize> = HashMap::new();
        for (_, name) in &synced {
            *shared.entry(name.to_lowercase()).or_default() += 1;
        }
        Ok(RepoNames { synced, shared })
    }

    /// Every synced repo, named.
    fn synced(&self) -> Vec<String> {
        self.synced.iter().map(|(o, n)| self.of(o, n)).collect()
    }

    fn of(&self, owner: &str, name: &str) -> String {
        match self.shared.get(&name.to_lowercase()) {
            Some(n) if *n > 1 => format!("{owner}/{name}"),
            _ => name.to_owned(),
        }
    }
}

/// How many items in the view carry one value.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct FacetCount {
    pub value: String,
    pub count: i64,
}

#[derive(Deserialize)]
pub struct CountsQuery {
    q: Option<String>,
}

/// Counts for one facet's values in the view `q`. For the facets whose values OR together
/// (repo, milestone, author, type) the view's own values of that facet are left out first, so
/// each count says how many rows that value would bring, not only the ones already shown.
pub async fn counts(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    facet: Result<Path<Facet>, PathRejection>,
    Params(cq): Params<CountsQuery>,
) -> Result<Json<Vec<FacetCount>>, ApiError> {
    // Not a facet: there's nothing at that path.
    let Ok(Path(facet)) = facet else {
        return Err(ApiError::NotFound);
    };
    let mut view = query::parse(cq.q.as_deref().unwrap_or(query::DEFAULT));
    match facet {
        Facet::Label | Facet::Assignee => {}
        Facet::Author => view.authors.clear(),
        Facet::Repo => view.repos.clear(),
        Facet::Milestone => view.milestones.clear(),
        Facet::Type => view.types.clear(),
    }
    let filter = list::filter(&view, s.account);
    let rows = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let f = &filter;
            macro_rules! counted {
                ($query:ident) => {
                    q::$query(c, f)?
                        .into_iter()
                        .map(|r| FacetCount {
                            value: r.name,
                            count: r.count,
                        })
                        .collect()
                };
            }
            Ok(match facet {
                Facet::Label => counted!(count_labels),
                Facet::Assignee => counted!(count_assignees),
                Facet::Author => counted!(count_authors),
                Facet::Repo => {
                    let name = RepoNames::read(c)?;
                    q::count_repos(c, f)?
                        .into_iter()
                        .map(|r| FacetCount {
                            value: name.of(&r.owner, &r.name),
                            count: r.count,
                        })
                        .collect()
                }
                Facet::Milestone => counted!(count_milestones),
                Facet::Type => counted!(count_types),
            })
        })
        .await?;
    Ok(Json(rows))
}
