//! The list's view as SQL: the filter bar's tokens, parsed by the server into a `View`, become
//! checked fragments (`frag`) composed with AND/OR/NOT, and the id query for the view's sort.

use crate::{frag, q};
use dbrt::filter::Filter;
use rusqlite::Connection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Updated,
    Created,
    /// When it was closed; never-closed items last in both directions.
    Closed,
    /// When the last comment came; uncommented items last in both directions.
    Commented,
    /// How many comments.
    Comments,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sort {
    pub key: SortKey,
    /// Descending (newest, most) unless `-asc`.
    pub asc: bool,
}

impl Default for Sort {
    fn default() -> Self {
        Sort {
            key: SortKey::Updated,
            asc: false,
        }
    }
}

/// An `assignee:` or `author:` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Who {
    /// The active account.
    Me,
    Login(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub text: String,
    /// Quoted: matches as written, not as word prefixes.
    pub phrase: bool,
    /// `-word`: rows matching it are left out.
    pub exclude: bool,
}

/// What the list shows: a filter-bar query, parsed (the server's `query.rs` owns the syntax).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct View {
    pub open: bool,
    pub closed: bool,
    pub issues: bool,
    pub prs: bool,
    /// `is:any`: issues and PRs.
    pub any_kind: bool,
    pub labels: Vec<String>,
    pub assignees: Vec<Who>,
    pub authors: Vec<Who>,
    /// `(owner, name)`; the owner only when given.
    pub repos: Vec<(Option<String>, String)>,
    pub milestones: Vec<String>,
    /// Issue type names (`type:`).
    pub types: Vec<String>,
    pub no_label: bool,
    pub no_assignee: bool,
    pub no_milestone: bool,
    pub sort: Sort,
    pub words: Vec<Word>,
}

/// The view's filter. `me` is the active account's GitHub user id, for `assignee:me` and
/// `author:me`.
pub fn filter(view: &View, me: i64) -> Filter {
    let mut all = Vec::new();
    let kind = match (view.any_kind, view.issues, view.prs) {
        (true, _, _) | (false, true, true) => None,
        (false, false, true) => Some("pr"),
        // Issues only unless PRs are asked for.
        _ => Some("issue"),
    };
    let state = match (view.open, view.closed) {
        (true, false) => Some("open"),
        (false, true) => Some("closed"),
        // Neither, or both: every state.
        _ => None,
    };
    match (state, kind) {
        (Some(s), Some(_)) => all.push(frag::state(s)),
        (Some(s), None) => all.push(frag::state_any_kind(s)),
        (None, _) => {}
    }
    if let Some(k) = kind {
        all.push(frag::kind(k));
    }
    for l in &view.labels {
        all.push(frag::label(l));
    }
    for a in &view.assignees {
        all.push(match a {
            Who::Me => frag::assignee_id(me),
            Who::Login(l) => frag::assignee(l),
        });
    }
    any_of(
        &mut all,
        view.authors.iter().map(|a| match a {
            Who::Me => frag::author_id(me),
            Who::Login(l) => frag::author(l),
        }),
    );
    any_of(
        &mut all,
        view.repos.iter().map(|(owner, name)| match owner {
            Some(o) => frag::repo_full(o, name),
            None => frag::repo(name),
        }),
    );
    any_of(&mut all, view.milestones.iter().map(|m| frag::milestone(m)));
    any_of(&mut all, view.types.iter().map(|t| frag::issue_type(t)));
    if view.no_label {
        all.push(Filter::Not(Box::new(frag::has_label())));
    }
    if view.no_assignee {
        all.push(Filter::Not(Box::new(frag::has_assignee())));
    }
    if view.no_milestone {
        all.push(frag::no_milestone());
    }
    let (out, words): (Vec<_>, Vec<_>) = view.words.iter().partition(|w| w.exclude);
    if !words.is_empty() {
        let q: Vec<String> = words.iter().map(|w| fts(w)).collect();
        all.push(frag::text(&q.join(" ")));
    }
    for w in out {
        all.push(Filter::Not(Box::new(frag::text(&fts(w)))));
    }
    Filter::And(all)
}

/// One fragment for a single value, OR for several, nothing for none.
fn any_of(all: &mut Vec<Filter>, fs: impl Iterator<Item = Filter>) {
    let mut fs: Vec<Filter> = fs.collect();
    match fs.len() {
        0 => {}
        1 => all.push(fs.pop().unwrap()),
        _ => all.push(Filter::Or(fs)),
    }
}

/// A row's place in its sort: its sort key (the expression the id query orders by) and its id,
/// the tie-break. The last shown row's is the cursor the next page starts after; on the wire
/// it's `<key>.<id>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub key: i64,
    pub id: i64,
}

impl std::fmt::Display for Cursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.key, self.id)
    }
}

impl std::str::FromStr for Cursor {
    type Err = ();

    fn from_str(s: &str) -> Result<Cursor, ()> {
        let (key, id) = s.split_once('.').ok_or(())?;
        Ok(Cursor {
            key: key.parse().map_err(drop)?,
            id: id.parse().map_err(drop)?,
        })
    }
}

/// Which rows of the sort a read takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Span {
    /// From the top: the first page.
    Top,
    /// The rows after the cursor: the next page.
    After(Cursor),
    /// From the top through the cursor, inclusive: a live refetch of the rows a tab has loaded.
    Through(Cursor),
}

/// Up to `limit` rows of `span` in the sort's order, each as its `Cursor`.
pub fn ids(
    c: &Connection,
    sort: Sort,
    filter: Filter,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    macro_rules! page {
        ($ids:ident, $after:ident, $through:ident) => {{
            let f = match span {
                Span::Top => filter,
                Span::After(Cursor { key, id }) => Filter::And(vec![filter, frag::$after(key, id)]),
                Span::Through(Cursor { key, id }) => {
                    Filter::And(vec![filter, frag::$through(key, id)])
                }
            };
            q::$ids(c, &f, limit)?
                .into_iter()
                .map(|r| Cursor {
                    key: r.key,
                    id: r.id,
                })
                .collect()
        }};
    }
    use SortKey::*;
    Ok(match (sort.key, sort.asc) {
        (Updated, false) => page!(ids_updated, after_updated, through_updated),
        (Updated, true) => page!(ids_updated_asc, after_updated_asc, through_updated_asc),
        (Created, false) => page!(ids_created, after_created, through_created),
        (Created, true) => page!(ids_created_asc, after_created_asc, through_created_asc),
        (Closed, false) => page!(ids_closed, after_closed, through_closed),
        (Closed, true) => page!(ids_closed_asc, after_closed_asc, through_closed_asc),
        (Commented, false) => page!(ids_commented, after_commented, through_commented),
        (Commented, true) => {
            page!(
                ids_commented_asc,
                after_commented_asc,
                through_commented_asc
            )
        }
        (Comments, false) => page!(ids_comments, after_comments, through_comments),
        (Comments, true) => page!(ids_comments_asc, after_comments_asc, through_comments_asc),
    })
}

/// The FTS5 query for one word: a quoted string, so nothing in it is FTS syntax, with a prefix
/// star unless it's a phrase.
pub fn fts(w: &Word) -> String {
    let text = w.text.replace('"', "");
    if w.phrase {
        format!("\"{text}\"")
    } else {
        format!("\"{text}\"*")
    }
}
