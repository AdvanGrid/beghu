//! Focus view: the issues reached down from one issue in focus, its root.
//!
//! A focus follows one **chain**: sub-issues (parent → child, in GitHub's order) or dependencies
//! (blocker → blocked, by id), so a blocking chain reads as the order the work goes in. Under each
//! issue come its linked PRs, by id, as leaves. A PR in focus has the issues it closes under it,
//! and those go on along the chain.
//!
//! Dependencies make a graph, not a tree: an issue two blockers block, or a loop. Each issue opens
//! where a depth-first walk first shows it; every later place it's reached shows it as a
//! **repeat**, with nothing under it, which also ends a loop.
//!
//! A view filters it as Tree mode's does (`mirror_db::tree`): an issue shows if it's one of the
//! view's matches, or a match is below it (context, dimmed and opened by default); under a match
//! every child in the view's state shows, and those with a match below them whatever their state.
//! The root always shows.

use crate::q;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

/// The relationship a focus follows down from its root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Chain {
    /// Sub-issues.
    Sub,
    /// Dependencies: what each issue blocks.
    Blocks,
}

impl Chain {
    fn edge(self) -> &'static str {
        match self {
            Chain::Sub => "sub",
            Chain::Blocks => "blocks",
        }
    }
}

/// The most issues a focus reads: past it, the ones reached last have nothing under them.
pub const REACH_MAX: usize = 10_000;

/// An issue or PR a focus reached.
#[derive(Debug, Clone)]
struct Item {
    state: String,
}

/// Everything reached down from a root, before a view filters it.
#[derive(Debug)]
pub struct Focus {
    root: i64,
    items: HashMap<i64, Item>,
    /// Each issue's children, in the chain's order (the root's too, if it's a PR).
    children: HashMap<i64, Vec<i64>>,
}

impl Focus {
    /// Walks down from `root` along `chain`. `None` when the root isn't an issue or PR the mirror
    /// shows (a stub, an unsynced repo's, or unknown).
    pub fn build(c: &Connection, root: i64, chain: Chain) -> rusqlite::Result<Option<Focus>> {
        let Some(r) = q::focus_items(c, &[root])?.into_iter().next() else {
            return Ok(None);
        };
        let mut focus = Focus {
            root,
            items: HashMap::from([(root, Item { state: r.state })]),
            children: HashMap::new(),
        };
        // A level at a time, one query each. A PR has its linked issues under it only as the
        // root: elsewhere it's a leaf.
        let mut level = vec![root];
        while !level.is_empty() && focus.items.len() < REACH_MAX {
            let mut next = Vec::new();
            for e in q::focus_children(c, &level, chain.edge())? {
                // Only issues (and a PR root) are on a level: an issue's children are issues
                // along the chain and the PRs that close it, a PR's the issues it closes.
                let pr = e.kind == "pr";
                focus.children.entry(e.parent).or_default().push(e.id);
                if let std::collections::hash_map::Entry::Vacant(v) = focus.items.entry(e.id) {
                    v.insert(Item { state: e.state });
                    if !pr {
                        next.push(e.id);
                    }
                }
            }
            level = next;
        }
        Ok(Some(focus))
    }

    pub fn root(&self) -> i64 {
        self.root
    }

    /// What a view shows of the focus: `is_match` says which issues are its matches, `state` the
    /// one state it shows (`Some("open")` under `is:open`), or `None` for every state.
    pub fn shown(&self, is_match: impl Fn(i64) -> bool, state: Option<&str>) -> Shown {
        // Which issues have a match at or below them, over every path: walked up from the
        // matches through the children's reverse.
        let mut parents: HashMap<i64, Vec<i64>> = HashMap::new();
        for (&p, ks) in &self.children {
            for &k in ks {
                parents.entry(k).or_default().push(p);
            }
        }
        let mut has: HashSet<i64> = self
            .items
            .keys()
            .copied()
            .filter(|&id| is_match(id))
            .collect();
        let mut stack: Vec<i64> = has.iter().copied().collect();
        while let Some(id) = stack.pop() {
            for &p in parents.get(&id).into_iter().flatten() {
                if has.insert(p) {
                    stack.push(p);
                }
            }
        }
        let mut shown = Shown {
            root: self.root,
            kids: HashMap::new(),
            parent: HashMap::from([(self.root, None)]),
            under: HashMap::new(),
        };
        // Depth first, children in order: an issue opens where it's first shown.
        let mut stack = vec![(self.root, is_match(self.root))];
        while let Some((id, under)) = stack.pop() {
            shown.under.insert(id, under);
            let mut kids = Vec::new();
            for &k in self.children.get(&id).into_iter().flatten() {
                let fits = state.is_none_or(|s| self.items.get(&k).is_some_and(|i| i.state == s));
                if !(has.contains(&k) || (under && fits)) {
                    continue;
                }
                let first = !shown.parent.contains_key(&k);
                if first {
                    shown.parent.insert(k, Some(id));
                }
                kids.push(Kid {
                    id: k,
                    repeat: !first,
                    under: under || is_match(k),
                });
            }
            for k in kids.iter().rev().filter(|k| !k.repeat) {
                stack.push((k.id, k.under));
            }
            shown.kids.insert(id, kids);
        }
        shown
    }
}

/// One child as a filtered focus shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kid {
    pub id: i64,
    /// Shown above already: here it has nothing under it.
    pub repeat: bool,
    /// A match is at it or above it.
    pub under: bool,
}

/// A focus as a view shows it: each issue at the one place it opens, with what it shows under it.
#[derive(Debug)]
pub struct Shown {
    root: i64,
    /// Each issue's children shown, at its first place.
    kids: HashMap<i64, Vec<Kid>>,
    /// Each issue shown, with the issue it's first shown under; `None` for the root.
    parent: HashMap<i64, Option<i64>>,
    /// Each issue shown: a match is at it or above it, at its first place.
    under: HashMap<i64, bool>,
}

impl Shown {
    pub fn root(&self) -> i64 {
        self.root
    }

    /// The children `id` shows at its first place (none for an issue not shown).
    pub fn kids(&self, id: i64) -> &[Kid] {
        self.kids.get(&id).map_or(&[], Vec::as_slice)
    }

    /// Whether a match is at `id` or above it, at its first place.
    pub fn under(&self, id: i64) -> bool {
        self.under.get(&id).copied().unwrap_or(false)
    }

    /// Whether `id` shows.
    pub fn holds(&self, id: i64) -> bool {
        self.parent.contains_key(&id)
    }

    /// The issues from the root down to `id`'s first place, the root first; empty when it doesn't
    /// show.
    pub fn path(&self, id: i64) -> Vec<i64> {
        let mut out = Vec::new();
        let mut at = Some(id);
        while let Some(x) = at {
            let Some(&p) = self.parent.get(&x) else {
                return Vec::new();
            };
            out.push(x);
            at = p;
        }
        out.reverse();
        out
    }
}
