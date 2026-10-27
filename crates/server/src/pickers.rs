//! What the detail's pickers offer for a synced repo:
//!
//! - `GET /api/repos/:id/labels`: its labels, by name, from the mirror (imported whole, kept
//!   current by `label` deliveries, which push so an open picker reads them again).
//! - `GET /api/repos/:id/milestones`: its milestones from the mirror, open ones first, each by
//!   due date.
//! - `GET /api/repos/:id/assignees`: who can be assigned, by login, read from GitHub with the
//!   user's token. The mirror knows only who is assigned somewhere, and GitHub tells no one when
//!   the set changes. The pages GitHub last answered are kept per repo with their `ETag`s (and
//!   forgotten when an account unsyncs the repo). An open answers from them at once; one past
//!   `assignees_recheck_after` (a minute) since they were last checked also asks GitHub for each
//!   again in the background, as a conditional request: an unchanged page is a 304, which GitHub
//!   doesn't count against the rate limit. So a picker never waits on the pages (up to 13 round
//!   trips), and a repo is asked at most once a minute. Only the first open of a repo waits for
//!   GitHub. Every page is read, however many (GraphQL's `assignableUsers(query:)` would search
//!   instead, at a point per keystroke, with no free revalidation; see
//!   docs/research/mirror-import-and-reconciliation.md on 304s).
//!
//! A repo the account doesn't sync is Gone. The picks themselves are ops (`ops.rs`).

use crate::App;
use crate::api::User;
use crate::auth::Session;
use crate::error::ApiError;
use crate::github::{ASSIGNABLE_PAGE, GitHub, Revalidated};
use crate::{github, tokens};
use axum::Json;
use axum::extract::{Extension, Path, State};
use mirror_db::{Caller, q};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use ts_rs::TS;

/// How many known pages of who can be assigned are asked for again at once.
const AT_ONCE: usize = 4;

/// Who can be assigned, per repo id: the pages GitHub last answered.
#[derive(Default)]
pub struct Assignable(Mutex<HashMap<i64, Known>>);

/// A repo's pages, when they were last checked with GitHub, and whether a check is under way.
struct Known {
    pages: Arc<Vec<Page>>,
    checked: Instant,
    checking: bool,
}

/// One page of who can be assigned, as GitHub answered it.
#[derive(Clone)]
pub struct Page {
    etag: Option<String>,
    logins: Vec<String>,
}

impl Assignable {
    fn all(&self) -> std::sync::MutexGuard<'_, HashMap<i64, Known>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The pages known for `repo`, if any, and whether the caller is to check them with GitHub:
    /// they were last checked over `recheck_after` ago and no check is under way (the caller's
    /// now is).
    fn get(&self, repo: i64, recheck_after: Duration) -> Option<(Arc<Vec<Page>>, bool)> {
        let mut all = self.all();
        let k = all.get_mut(&repo)?;
        let check = !k.checking && k.checked.elapsed() >= recheck_after;
        k.checking |= check;
        Some((k.pages.clone(), check))
    }

    /// `pages`, as GitHub answered them just now.
    fn put(&self, repo: i64, pages: Vec<Page>) {
        self.all().insert(
            repo,
            Known {
                pages: Arc::new(pages),
                checked: Instant::now(),
                checking: false,
            },
        );
    }

    /// A check [`get`](Self::get) asked for is over: with the pages GitHub answered, or none if
    /// it failed (the next open past the recheck tries again). Nothing if the repo was forgotten
    /// meanwhile.
    fn checked(&self, repo: i64, pages: Option<Vec<Page>>) {
        let mut all = self.all();
        let Some(k) = all.get_mut(&repo) else { return };
        k.checking = false;
        if let Some(pages) = pages {
            k.pages = Arc::new(pages);
            k.checked = Instant::now();
        }
    }

    /// Drops what's known of `repo`: an account stopped syncing it.
    pub fn forget(&self, repo: i64) {
        self.all().remove(&repo);
    }
}

/// A check [`Assignable::get`] asked for, under way: dropped, it ends with the pages it found,
/// or none (failed, panicked or stopped by the drain), so a later open can check again.
struct Checking<'a> {
    cache: &'a Assignable,
    repo: i64,
    pages: Option<Vec<Page>>,
}

impl<'a> Checking<'a> {
    fn new(cache: &'a Assignable, repo: i64) -> Self {
        Self {
            cache,
            repo,
            pages: None,
        }
    }
}

impl Drop for Checking<'_> {
    fn drop(&mut self) {
        self.cache.checked(self.repo, self.pages.take());
    }
}

/// Every page of who can be assigned to `owner/name`: the `known` ones asked for again with their
/// `ETag`s ([`AT_ONCE`] at a time), then any after them one by one, until a page comes back
/// short.
async fn assignable_pages(
    gh: &GitHub,
    token: &str,
    owner: &str,
    name: &str,
    known: &[Page],
) -> Result<Vec<Page>, github::Error> {
    let page = |n: usize, etag: Option<String>, held: Option<Page>| {
        let (gh, token, owner, name) = (
            gh.clone(),
            token.to_owned(),
            owner.to_owned(),
            name.to_owned(),
        );
        async move {
            match gh
                .assignable_page(&token, &owner, &name, n, etag.as_deref())
                .await?
            {
                Revalidated::Fresh { etag, page } => Ok(Page { etag, logins: page }),
                Revalidated::NotModified => held.ok_or_else(|| {
                    github::Error::Malformed("304 to a request without an ETag".into())
                }),
            }
        }
    };
    let mut pages = Vec::new();
    for (i, chunk) in known.chunks(AT_ONCE).enumerate() {
        let mut asked = tokio::task::JoinSet::new();
        for (j, p) in chunk.iter().enumerate() {
            let n = i * AT_ONCE + j + 1;
            let ask = page(n, p.etag.clone(), Some(p.clone()));
            asked.spawn(async move { (n, ask.await) });
        }
        let mut got = asked.join_all().await;
        got.sort_by_key(|(n, _)| *n);
        for (_, p) in got {
            let p = p?;
            let last = p.logins.len() < ASSIGNABLE_PAGE;
            pages.push(p);
            if last {
                return Ok(pages);
            }
        }
    }
    loop {
        let p = page(pages.len() + 1, None, None).await?;
        let last = p.logins.len() < ASSIGNABLE_PAGE;
        pages.push(p);
        if last {
            return Ok(pages);
        }
    }
}

/// A label the repo has.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct RepoLabel {
    pub name: String,
    /// GitHub's hex colour, without `#`.
    pub color: String,
    pub description: Option<String>,
}

/// A milestone the repo has.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct RepoMilestone {
    /// Its number in the repo: what `milestone_set` names.
    pub number: i64,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    /// Unix seconds.
    pub due_on: Option<i64>,
}

/// A repo id in the path that isn't a number names no repo.
fn repo_id(raw: &str) -> Result<i64, ApiError> {
    raw.parse().map_err(|_| ApiError::Gone)
}

/// What `read` finds for repo `raw` in the account's mirror, if the account syncs it; Gone if
/// not.
async fn from_synced<T: Send + 'static>(
    app: &App,
    account: i64,
    raw: &str,
    read: fn(&rusqlite::Connection, i64) -> rusqlite::Result<T>,
) -> Result<T, ApiError> {
    let id = repo_id(raw)?;
    app.mirrors()
        .read(account, Caller::Request, move |c| {
            Ok(match q::synced_repo(c, id)? {
                Some(_) => Some(read(c, id)?),
                None => None,
            })
        })
        .await?
        .ok_or(ApiError::Gone)
}

pub async fn labels(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
) -> Result<Json<Vec<RepoLabel>>, ApiError> {
    let rows = from_synced(&app, s.account, &raw, q::picker_labels).await?;
    Ok(Json(
        rows.into_iter()
            .map(|l| RepoLabel {
                name: l.name,
                color: l.color,
                description: l.description,
            })
            .collect(),
    ))
}

pub async fn milestones(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
) -> Result<Json<Vec<RepoMilestone>>, ApiError> {
    let rows = from_synced(&app, s.account, &raw, q::picker_milestones).await?;
    Ok(Json(
        rows.into_iter()
            .map(|m| RepoMilestone {
                number: m.number,
                title: m.title,
                state: m.state,
                due_on: m.due_on,
            })
            .collect(),
    ))
}

pub async fn assignees(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
) -> Result<Json<Vec<User>>, ApiError> {
    let id = repo_id(&raw)?;
    let repo = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| q::synced_repo(c, id))
        .await?
        .ok_or(ApiError::Gone)?;
    let users = |pages: &[Page]| -> Vec<User> {
        pages
            .iter()
            .flat_map(|p| &p.logins)
            .map(|login| User {
                login: login.clone(),
            })
            .collect()
    };
    if let Some((pages, check)) = app.assignable().get(id, app.cfg().assignees_recheck_after) {
        if check {
            // A job, so the drain stops it (see `jobs.rs`).
            let account = s.account;
            let known = pages.clone();
            app.spawn(move |app| async move {
                let mut check = Checking::new(app.assignable(), id);
                if app.github().is_down() {
                    return;
                }
                match read_pages(&app, account, &repo, &known).await {
                    Ok(pages) => check.pages = Some(pages),
                    Err(e) => eprintln!(
                        "pickers: account {account}: checking who can be assigned on repo {id}: {e}"
                    ),
                }
            });
        }
        return Ok(Json(users(&pages)));
    }
    if app.github().is_down() {
        return Err(ApiError::GitHubDown(
            "GitHub is unreachable; try again once it's back".into(),
        ));
    }
    let pages = read_pages(&app, s.account, &repo, &[])
        .await
        .map_err(|e| read_failure(e, &repo.name))?;
    let listed = users(&pages);
    app.assignable().put(id, pages);
    Ok(Json(listed))
}

/// Every page of who can be assigned to `repo`, with the account's token (`known` asked for
/// again with their `ETag`s).
async fn read_pages(
    app: &App,
    account: i64,
    repo: &q::SyncedRepoRow,
    known: &[Page],
) -> Result<Vec<Page>, tokens::Error> {
    let gh = app.github().clone();
    app.tokens()
        .with_token(account, |token| {
            let gh = gh.clone();
            async move { assignable_pages(&gh, &token, &repo.owner, &repo.name, known).await }
        })
        .await
}

/// How a read from GitHub failed, for the picker to say.
fn read_failure(e: tokens::Error, repo: &str) -> ApiError {
    match e {
        tokens::Error::SignInAgain | tokens::Error::GitHub(github::Error::Unauthorized) => {
            ApiError::SignedOut
        }
        tokens::Error::GitHub(github::Error::RateLimited(retry_after)) => {
            ApiError::RateLimited { retry_after }
        }
        tokens::Error::GitHub(github::Error::Status(404 | 410)) => ApiError::Gone,
        tokens::Error::GitHub(github::Error::Status(403)) => {
            ApiError::Refused(format!("GitHub didn't list who can be assigned on {repo}"))
        }
        tokens::Error::GitHub(
            github::Error::Network(_) | github::Error::Unsent(_) | github::Error::Status(500..=599),
        ) => ApiError::GitHubDown("GitHub didn't answer; try again".into()),
        // Signed out, restarting (the drain stopped the token's refresh), a sealed database.
        e => e.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{Assignable, Checking};
    use std::time::Duration;

    /// A background check that panics still ends: the next open past the recheck checks again,
    /// rather than the repo staying marked as checking for good.
    #[test]
    fn a_check_that_panics_still_ends() {
        let cache = Assignable::default();
        cache.put(7, Vec::new());
        let (_, check) = cache.get(7, Duration::ZERO).unwrap();
        assert!(check);
        let panicked = std::panic::catch_unwind(|| {
            let _check = Checking::new(&cache, 7);
            panic!("GitHub's answer broke the check");
        });
        assert!(panicked.is_err());
        assert!(cache.get(7, Duration::ZERO).unwrap().1);
    }
}
