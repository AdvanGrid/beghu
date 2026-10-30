//! Tree mode: the sub-issue tree over a view (#108).
//!
//! The view's **matches** are the rows its list would show, issues only: PRs never appear in the
//! tree. Each match shows inside its ancestors, which the tree shows too: those that aren't
//! matches are **context**, dimmed by the web app and opened by default along each path to a
//! match. The nodes the tree is built from are the matches and their ancestors (`tree_up`); its
//! roots are those with no parent among them, ordered:
//!
//! - in the view's sort, each by its own sort key, when the view isn't ranked (Match mode Off, or
//!   no free text);
//! - by the best rank in its subtree, under a ranked Match mode (`rank`): a root ranks as its best
//!   match, and ties go to the root's id.
//!
//! Children keep GitHub's order. A match's subtree stays openable: under a match every child the
//! tree can show is shown, closed ones hidden under `is:open` unless a match is under them (see
//! `Tree::children`). Progress counts every descendant whatever the filter, as the list's does.
//!
//! Building a tree reads every match, so the server caches it per view and mirror `seq`; a page of
//! roots, and the children of the nodes it opens, are then read per request.

use crate::list::{self, Cursor, Match, Sort, SortKey, Span, View};
use crate::{q, rank};
use rusqlite::Connection;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// The tree over one view, as of one mirror `seq`.
#[derive(Debug, Default)]
pub struct Tree {
    /// The view's matches.
    matches: HashSet<i64>,
    /// Every node the tree is built from (the matches and their ancestors), with its parent among
    /// them, if it has one.
    parent: HashMap<i64, Option<i64>>,
    /// Each such node's children among them, in GitHub's order.
    children: HashMap<i64, Vec<i64>>,
    /// The nodes whose parent the tree doesn't show (a stub, a PR, an unsynced repo's issue): roots
    /// that are sub-issues all the same.
    hidden_parent: HashSet<i64>,
    /// The roots in the tree's order, each as its place in it.
    roots: Vec<Cursor>,
    sort: Sort,
    /// Only `is:open` (`Some("open")`) or only `is:closed` shows; `None`, every state.
    state: Option<&'static str>,
}

/// The view as the tree reads it: issues only. A view of PRs alone has no tree.
fn issues_only(view: &View) -> Option<View> {
    let prs_only = view.prs && !view.issues && !view.any_kind;
    (!prs_only).then(|| View {
        issues: true,
        prs: false,
        any_kind: false,
        ..view.clone()
    })
}

impl Tree {
    /// Builds the tree of `view` for the account `me` (`assignee:me`, `author:me`).
    pub fn build(c: &Connection, view: &View, me: i64) -> rusqlite::Result<Tree> {
        let state = match (view.open, view.closed) {
            (true, false) => Some("open"),
            (false, true) => Some("closed"),
            _ => None,
        };
        let mut tree = Tree {
            sort: view.sort,
            state,
            ..Tree::default()
        };
        let Some(view) = issues_only(view) else {
            return Ok(tree);
        };
        // Every match, in the view's order (its sort, or its Match mode's).
        let matches = list::page(c, &view, me, Span::Top, i64::MAX)?;
        let ids: Vec<i64> = matches.iter().map(|m| m.id).collect();
        tree.matches = ids.iter().copied().collect();
        let mut edges = Vec::new();
        for r in q::tree_up(c, &ids)? {
            edges.push((r.id, r.parent, r.position.unwrap_or(0.0)));
            tree.parent.insert(r.id, None);
        }
        let mut siblings: HashMap<i64, Vec<(f64, i64)>> = HashMap::new();
        for (id, parent, position) in edges {
            match parent {
                Some(p) if tree.parent.contains_key(&p) => {
                    tree.parent.insert(id, Some(p));
                    siblings.entry(p).or_default().push((position, id));
                }
                Some(_) => {
                    tree.hidden_parent.insert(id);
                }
                None => {}
            }
        }
        for (p, mut kids) in siblings {
            kids.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            tree.children
                .insert(p, kids.into_iter().map(|(_, id)| id).collect());
        }
        tree.roots = tree.order_roots(c, &view, &matches)?;
        Ok(tree)
    }

    /// The roots, each as its place in the tree's order, in that order.
    fn order_roots(
        &self,
        c: &Connection,
        view: &View,
        matches: &[Cursor],
    ) -> rusqlite::Result<Vec<Cursor>> {
        let mut roots: Vec<Cursor> = match rank::mode(view) {
            Match::Off => {
                // Each by its own key: a match's is its cursor's; a context root's is read.
                let mut out: Vec<Cursor> = matches
                    .iter()
                    .filter(|m| self.parent.get(&m.id) == Some(&None))
                    .copied()
                    .collect();
                let context: Vec<i64> = self
                    .parent
                    .iter()
                    .filter(|(id, p)| p.is_none() && !self.matches.contains(id))
                    .map(|(&id, _)| id)
                    .collect();
                for k in q::tree_sort_keys(c, &context)? {
                    out.push(Cursor {
                        sort: self.sort,
                        rank: None,
                        key: sort_key(self.sort, &k),
                        id: k.id,
                    });
                }
                out
            }
            _ => {
                // Matches come best first: a root takes the first one under it.
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                for m in matches {
                    let root = self.root_of(m.id);
                    if seen.insert(root) {
                        out.push(Cursor { id: root, ..*m });
                    }
                }
                out
            }
        };
        roots.sort_by(|a, b| self.cmp(a, b));
        Ok(roots)
    }

    /// The root above `id` (itself for a root).
    fn root_of(&self, mut id: i64) -> i64 {
        // GitHub nests at most 8 levels; the cap only stops a loop.
        for _ in 0..64 {
            match self.parent.get(&id) {
                Some(Some(p)) => id = *p,
                _ => break,
            }
        }
        id
    }

    /// The tree's order of two roots' places: the sort's direction over rank, key and id.
    fn cmp(&self, a: &Cursor, b: &Cursor) -> Ordering {
        let at = |c: &Cursor| (c.rank_value().unwrap_or(0), c.key, c.id);
        let o = at(a).cmp(&at(b));
        if self.sort.asc { o } else { o.reverse() }
    }

    /// Up to `limit` roots of `span`, each as its place in the tree's order.
    pub fn page(&self, span: Span, limit: usize) -> Vec<Cursor> {
        let from = match span {
            Span::After(c) => self
                .roots
                .partition_point(|r| self.cmp(r, &c) != Ordering::Greater),
            _ => 0,
        };
        let rest = self.roots[from..].iter();
        match span {
            Span::Through(c) => rest
                .take_while(|r| self.cmp(r, &c) != Ordering::Greater)
                .take(limit)
                .copied()
                .collect(),
            _ => rest.take(limit).copied().collect(),
        }
    }

    /// How many roots the tree has.
    pub fn root_count(&self) -> usize {
        self.roots.len()
    }

    pub fn is_match(&self, id: i64) -> bool {
        self.matches.contains(&id)
    }

    /// Whether the tree is built from `id`: a match, or an ancestor of one.
    pub fn holds(&self, id: i64) -> bool {
        self.parent.contains_key(&id)
    }

    /// Whether `id` has a parent the tree doesn't show: it's a root, and a sub-issue on GitHub.
    pub fn has_hidden_parent(&self, id: i64) -> bool {
        self.hidden_parent.contains(&id)
    }

    /// Whether `id` is one of the tree's roots.
    pub fn is_root(&self, id: i64) -> bool {
        self.parent.get(&id) == Some(&None)
    }

    /// The children each of `nodes` shows, in GitHub's order. A node not under a match (`false`
    /// beside it: context, there for a match below) shows only the children a match is under. A
    /// match, and every node under one, shows every child the tree can show, but under `is:open`
    /// (or `is:closed`) only those in that state, or with a match under them.
    pub fn children(
        &self,
        c: &Connection,
        nodes: &[(i64, bool)],
    ) -> rusqlite::Result<HashMap<i64, Vec<i64>>> {
        let mut out = HashMap::new();
        let mut read = Vec::new();
        for &(id, under_match) in nodes {
            if under_match {
                read.push(id);
                out.insert(id, Vec::new());
            } else {
                out.insert(id, self.children.get(&id).cloned().unwrap_or_default());
            }
        }
        if read.is_empty() {
            return Ok(out);
        }
        for r in q::tree_children(c, &read)? {
            let shown = self.state.is_none_or(|s| s == r.state) || self.holds(r.id);
            if shown && let Some(kids) = out.get_mut(&r.parent) {
                kids.push(r.id);
            }
        }
        Ok(out)
    }
}

/// An item's key in `sort`, as the list's id query for that sort orders by it (`list.sql`): a
/// never-closed or uncommented item goes last both ways.
fn sort_key(sort: Sort, k: &q::TreeSortKeysRow) -> i64 {
    let last = if sort.asc { i64::MAX } else { 0 };
    match sort.key {
        SortKey::Updated => k.updated_at.unwrap_or(0),
        SortKey::Created => k.created_at.unwrap_or(0),
        SortKey::Closed => k.closed_at.unwrap_or(last),
        SortKey::Commented => k.last_commented_at.unwrap_or(last),
        SortKey::Comments => k.comments_count,
    }
}
