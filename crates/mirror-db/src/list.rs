//! The list's view as SQL: the filter bar's tokens, parsed by the server into a `View`, become
//! checked fragments (`frag`) composed with AND/OR/NOT, and the id query for the view's sort.

use crate::{frag, q, rank, search};
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

impl SortKey {
    pub const ALL: [SortKey; 5] = [
        SortKey::Updated,
        SortKey::Created,
        SortKey::Closed,
        SortKey::Commented,
        SortKey::Comments,
    ];

    /// The key's name, as `sort:` and a cursor spell it.
    pub fn name(self) -> &'static str {
        match self {
            SortKey::Updated => "updated",
            SortKey::Created => "created",
            SortKey::Closed => "closed",
            SortKey::Commented => "commented",
            SortKey::Comments => "comments",
        }
    }

    /// The key `name` names, if any.
    pub fn named(name: &str) -> Option<SortKey> {
        SortKey::ALL.into_iter().find(|k| k.name() == name)
    }
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

impl Sort {
    /// Every sort: each key both ways.
    fn all() -> impl Iterator<Item = Sort> {
        SortKey::ALL
            .into_iter()
            .flat_map(|key| [false, true].map(|asc| Sort { key, asc }))
    }

    /// The sort as a cursor names it: `updated`, `created-asc`.
    fn name(self) -> String {
        let dir = if self.asc { "-asc" } else { "" };
        format!("{}{dir}", self.key.name())
    }

    /// Whether Blend can rank under this sort: it needs a descending time key (`comments` is a
    /// count). Under any other sort Blend falls back to Best (`rank::mode`).
    pub fn blends(self) -> bool {
        !self.asc && self.key != SortKey::Comments
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
    /// `in:`: the fields free text searches.
    pub fields: Fields,
    /// `match:`; `None` is the default, Blend (see `rank`).
    pub matching: Option<Match>,
}

/// The fields free text searches (`in:title|body|comments`). None set means all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fields {
    pub title: bool,
    pub body: bool,
    pub comments: bool,
}

impl Fields {
    /// The fields searched: those named, or all three when none is.
    pub fn searched(self) -> Fields {
        if self == Fields::default() {
            Fields {
                title: true,
                body: true,
                comments: true,
            }
        } else {
            self
        }
    }
}

/// Match mode (`match:`): how free text orders the list. See `rank`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Match {
    /// Field weight against age on the sort key.
    Blend,
    /// Title matches, then body, then comment, each in the sort.
    Best,
    /// The text only filters.
    Off,
}

/// The view's filter. `me` is the active account's GitHub user id, for `assignee:me` and
/// `author:me`.
pub fn filter(view: &View, me: i64) -> Filter {
    filter_with(view, me, search::Plan::Free)
}

fn filter_with(view: &View, me: i64, plan: search::Plan) -> Filter {
    let mut all = qualifiers(view, me);
    all.extend(search::filters(view, plan));
    Filter::And(all)
}

/// Everything the view filters on but its free text.
pub(crate) fn qualifiers(view: &View, me: i64) -> Vec<Filter> {
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
    all
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
/// the tie-break, and under a ranked Match mode its rank first (see `rank`). The last shown
/// row's is the cursor the next page starts after. On the wire it names the order it's a place
/// in: `<sort>.<key>.<id>` (`updated.…`, `created-asc.…`), or `<mode>-<sort>.<rank>.<key>.<id>`
/// when ranked (`blend-updated.…`, `best-created-asc.…`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub sort: Sort,
    pub rank: Option<Rank>,
    pub key: i64,
    pub id: i64,
}

/// A ranked cursor's rank, and the Match mode it ranks in (Blend or Best).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rank {
    pub value: i64,
    pub mode: Match,
}

impl Cursor {
    /// The cursor's rank, or none when it's the plain sort's.
    pub fn rank_value(&self) -> Option<i64> {
        self.rank.map(|r| r.value)
    }

    /// Whether the cursor is a place in the view's order: of the view's sort, and ranked in the
    /// view's Match mode, or plain for a view that isn't ranked.
    pub fn fits(&self, view: &View) -> bool {
        let mode = self.rank.map_or(Match::Off, |r| r.mode);
        self.sort == view.sort && mode == rank::mode(view)
    }
}

/// The order a cursor is a place in, as it names it: a sort, or a ranked Match mode under one.
fn order_name(mode: Match, sort: Sort) -> String {
    match mode {
        Match::Blend => format!("blend-{}", sort.name()),
        Match::Best => format!("best-{}", sort.name()),
        Match::Off => sort.name(),
    }
}

/// Every order a cursor can be in: each sort plain, Best under every sort, Blend under the
/// sorts it ranks in (`Sort::blends`).
fn orders() -> impl Iterator<Item = (Match, Sort)> {
    Sort::all().flat_map(|sort| {
        [(Match::Off, sort), (Match::Best, sort)]
            .into_iter()
            .chain(sort.blends().then_some((Match::Blend, sort)))
    })
}

impl std::fmt::Display for Cursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.rank {
            Some(r) => write!(f, "{}.{}.", order_name(r.mode, self.sort), r.value)?,
            None => write!(f, "{}.", order_name(Match::Off, self.sort))?,
        }
        write!(f, "{}.{}", self.key, self.id)
    }
}

impl std::str::FromStr for Cursor {
    type Err = ();

    /// A cursor as `Display` writes it. A ranked one's rank must be one its order can give a
    /// row (`rank::possible`), which also keeps the arithmetic on it in range.
    fn from_str(s: &str) -> Result<Cursor, ()> {
        let (name, rest) = s.split_once('.').ok_or(())?;
        let (mode, sort) = orders()
            .find(|&(mode, sort)| order_name(mode, sort) == name)
            .ok_or(())?;
        let parts: Vec<i64> = rest
            .split('.')
            .map(|p| p.parse().map_err(drop))
            .collect::<Result<_, _>>()?;
        match (mode, &parts[..]) {
            (Match::Off, &[key, id]) => Ok(Cursor {
                sort,
                rank: None,
                key,
                id,
            }),
            (Match::Blend | Match::Best, &[value, key, id])
                if rank::possible(mode, sort, value, key) =>
            {
                Ok(Cursor {
                    sort,
                    rank: Some(Rank { value, mode }),
                    key,
                    id,
                })
            }
            _ => Err(()),
        }
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

/// Up to `limit` rows of `span` of the view, in its order (the sort's, or its Match mode's),
/// each as its `Cursor`. A cursor must be a place in the view's order (`Cursor::fits`).
pub fn page(
    c: &Connection,
    view: &View,
    me: i64,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    match rank::mode(view) {
        Match::Off => {
            let plan = search::plan(c, view)?;
            ids(c, view.sort, filter_with(view, me, plan), span, limit)
        }
        mode => rank::page(c, view, me, mode, span, limit),
    }
}

/// Up to `limit` rows of `span` in the sort's order, each as its `Cursor`.
pub fn ids(
    c: &Connection,
    sort: Sort,
    filter: Filter,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    match span {
        Span::Top => ids_between(c, sort, filter, None, None, limit),
        Span::After(cur) => ids_between(c, sort, filter, Some(cur), None, limit),
        Span::Through(cur) => ids_between(c, sort, filter, None, Some(cur), limit),
    }
}

/// `ids` for the rows after `after` (if given) and up to `through`, inclusive (if given).
pub(crate) fn ids_between(
    c: &Connection,
    sort: Sort,
    filter: Filter,
    after: Option<Cursor>,
    through: Option<Cursor>,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    macro_rules! page {
        ($ids:ident, $after:ident, $through:ident) => {{
            let mut all = vec![filter];
            if let Some(Cursor { key, id, .. }) = after {
                all.push(frag::$after(key, id));
            }
            if let Some(Cursor { key, id, .. }) = through {
                all.push(frag::$through(key, id));
            }
            let f = match all.len() {
                1 => all.pop().unwrap(),
                _ => Filter::And(all),
            };
            q::$ids(c, &f, limit)?
                .into_iter()
                .map(|r| Cursor {
                    sort,
                    rank: None,
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
