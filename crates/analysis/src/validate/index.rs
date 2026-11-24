//! Lookups over a parsed analysis that every check shares, and the one list of places that hold
//! claim IDs.

use std::collections::{HashMap, HashSet};

use crate::reader::under;
use crate::schema::{Analysis, Change, Evidence, Node, NodeKind, Walk};

pub(crate) struct Index<'a> {
    pub a: &'a Analysis,
    pub nodes: HashMap<&'a str, usize>,
    pub edges: HashMap<&'a str, usize>,
    pub claims: HashMap<&'a str, usize>,
    pub boundaries: HashSet<&'a str>,
    pub facets: HashMap<&'a str, usize>,
    pub purposes: HashMap<&'a str, usize>,
    /// Rule ID → (purpose index, rule index).
    pub rules: HashMap<&'a str, (usize, usize)>,
    pub causes: HashSet<&'a str>,
    pub children: HashMap<&'a str, Vec<usize>>,
    /// The `system` node's ID, when there is exactly one.
    pub system: Option<&'a str>,
}

impl<'a> Index<'a> {
    pub fn new(a: &'a Analysis) -> Self {
        fn ids<'a, T>(list: &'a [T], id: impl Fn(&'a T) -> &'a str) -> HashMap<&'a str, usize> {
            let mut m = HashMap::new();
            for (i, x) in list.iter().enumerate() {
                m.entry(id(x)).or_insert(i);
            }
            m
        }
        let mut rules = HashMap::new();
        for (pi, p) in a.purposes.iter().enumerate() {
            for (ri, r) in p.rules.iter().flatten().enumerate() {
                rules.entry(r.id.as_str()).or_insert((pi, ri));
            }
        }
        let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, n) in a.nodes.iter().enumerate() {
            if let Some(p) = &n.parent {
                children.entry(p.as_str()).or_default().push(i);
            }
        }
        let systems: Vec<&Node> = a
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::System)
            .collect();
        Index {
            a,
            nodes: ids(&a.nodes, |n| &n.id),
            edges: ids(&a.edges, |e| &e.id),
            claims: ids(&a.claims, |c| &c.id),
            boundaries: a.boundaries.iter().map(|b| b.id.as_str()).collect(),
            facets: ids(&a.facets, |f| &f.id),
            purposes: ids(&a.purposes, |p| &p.id),
            rules,
            causes: a.causes.iter().map(|c| c.id.as_str()).collect(),
            children,
            system: if systems.len() == 1 {
                Some(systems[0].id.as_str())
            } else {
                None
            },
        }
    }

    pub fn node(&self, id: &str) -> Option<&'a Node> {
        self.nodes.get(id).map(|&i| &self.a.nodes[i])
    }

    pub fn has_children(&self, id: &str) -> bool {
        self.children.get(id).is_some_and(|c| !c.is_empty())
    }

    /// The node's ancestors, nearest first. On a cycle it stops once it meets a node again, so a
    /// node on a cycle is among its own ancestors.
    pub fn ancestors(&self, id: &str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = self.node(id).and_then(|n| n.parent.as_deref());
        while let Some(p) = cur {
            let Some(n) = self.node(p) else { break };
            out.push(n.id.as_str());
            if p == id || !seen.insert(p) {
                break;
            }
            cur = n.parent.as_deref();
        }
        out
    }

    /// Whether `inner` is `outer` or lies inside it.
    pub fn within(&self, inner: &str, outer: &str) -> bool {
        inner == outer || self.ancestors(inner).contains(&outer)
    }

    pub fn is_top_level(&self, n: &Node) -> bool {
        self.system.is_some() && n.parent.as_deref() == self.system
    }

    /// A part: a node that is the system's own code.
    pub fn is_part(n: &Node) -> bool {
        matches!(
            n.kind,
            NodeKind::Service | NodeKind::App | NodeKind::Library | NodeKind::Module
        )
    }

    /// The deepest node whose paths hold `path`.
    pub fn landing(&self, path: &str) -> Option<&'a Node> {
        self.a
            .nodes
            .iter()
            .filter(|n| n.paths.iter().any(|p| under(path, p)))
            .max_by_key(|n| self.ancestors(&n.id).len())
    }

    /// Whether `path` lies under the node's paths.
    pub fn path_in(&self, node: &Node, path: &str) -> bool {
        node.paths.iter().any(|p| under(path, p))
    }

    pub fn changed(n: &Node) -> bool {
        n.change != Change::Unchanged
    }

    pub fn code_evidence(&self, claim: &str) -> Vec<&'a Evidence> {
        match self.claims.get(claim) {
            Some(&i) => self.a.claims[i]
                .evidence
                .iter()
                .filter(|e| matches!(e, Evidence::Code { .. }))
                .collect(),
            None => Vec::new(),
        }
    }
}

/// Whether a place may rest on the description or an issue alone (principle 2).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    /// Purposes, roles, walks and conflict sides.
    StatedAllowed,
    /// Everything in the code view.
    CodeOnly,
}

pub(crate) struct ClaimRef<'a> {
    pub path: String,
    pub id: &'a str,
    pub source: Source,
}

/// Every claim ID the analysis names, where, and whether that place may rest on stated evidence.
/// The merge's renumbering relies on the same places (every `claims` list and a rule's
/// `sources`).
pub(crate) fn claim_refs(a: &Analysis) -> Vec<ClaimRef<'_>> {
    use Source::*;
    let mut out = Vec::new();
    fn push<'a>(out: &mut Vec<ClaimRef<'a>>, path: String, ids: &'a [String], source: Source) {
        for (i, id) in ids.iter().enumerate() {
            out.push(ClaimRef {
                path: format!("{path}/{i}"),
                id,
                source,
            });
        }
    }
    fn walk<'a>(out: &mut Vec<ClaimRef<'a>>, path: String, w: &'a Walk) {
        push(
            out,
            format!("{path}/claims"),
            &w.claims,
            Source::StatedAllowed,
        );
    }
    walk(&mut out, "/walk".into(), &a.walk);
    for (ni, n) in a.nodes.iter().enumerate() {
        let np = format!("/nodes/{ni}");
        for (ri, r) in n.responsibilities.iter().enumerate() {
            push(
                &mut out,
                format!("{np}/responsibilities/{ri}/claims"),
                &r.claims,
                CodeOnly,
            );
        }
        for (fi, f) in n.facets.iter().enumerate() {
            for (vi, v) in f.values.iter().enumerate() {
                push(
                    &mut out,
                    format!("{np}/facets/{fi}/values/{vi}/claims"),
                    &v.claims,
                    CodeOnly,
                );
            }
        }
        for (qi, q) in n.questions.iter().enumerate() {
            push(
                &mut out,
                format!("{np}/questions/{qi}/claims"),
                &q.claims,
                CodeOnly,
            );
        }
        if let Some(w) = &n.walk {
            walk(&mut out, format!("{np}/walk"), w);
        }
        for (bi, b) in n.built.iter().flatten().enumerate() {
            push(
                &mut out,
                format!("{np}/built/{bi}/claims"),
                &b.claims,
                CodeOnly,
            );
        }
    }
    for (ei, e) in a.edges.iter().enumerate() {
        let ep = format!("/edges/{ei}");
        push(&mut out, format!("{ep}/claims"), &e.claims, CodeOnly);
        for (fi, f) in e.facets.iter().enumerate() {
            for (vi, v) in f.values.iter().enumerate() {
                push(
                    &mut out,
                    format!("{ep}/facets/{fi}/values/{vi}/claims"),
                    &v.claims,
                    CodeOnly,
                );
            }
        }
        for (qi, q) in e.questions.iter().enumerate() {
            push(
                &mut out,
                format!("{ep}/questions/{qi}/claims"),
                &q.claims,
                CodeOnly,
            );
        }
        if let Some(w) = &e.walk {
            walk(&mut out, format!("{ep}/walk"), w);
        }
    }
    for (bi, b) in a.boundaries.iter().enumerate() {
        push(
            &mut out,
            format!("/boundaries/{bi}/claims"),
            &b.claims,
            CodeOnly,
        );
    }
    for (si, s) in a.scenarios.iter().enumerate() {
        for (ti, t) in s.steps.iter().enumerate() {
            push(
                &mut out,
                format!("/scenarios/{si}/steps/{ti}/claims"),
                &t.claims,
                CodeOnly,
            );
        }
    }
    for (pi, p) in a.purposes.iter().enumerate() {
        let pp = format!("/purposes/{pi}");
        walk(&mut out, format!("{pp}/walk"), &p.walk);
        for (i, s) in p.serves.iter().enumerate() {
            push(
                &mut out,
                format!("{pp}/serves/{i}/claims"),
                &s.claims,
                StatedAllowed,
            );
        }
        for (i, c) in p.carries.iter().enumerate() {
            push(
                &mut out,
                format!("{pp}/carries/{i}/claims"),
                &c.claims,
                StatedAllowed,
            );
        }
        for (ri, r) in p.rules.iter().flatten().enumerate() {
            push(
                &mut out,
                format!("{pp}/rules/{ri}/sources"),
                &r.sources,
                StatedAllowed,
            );
        }
    }
    for (ci, c) in a.conflicts.iter().enumerate() {
        for (name, side) in [("a", &c.a), ("b", &c.b)] {
            let sp = format!("/conflicts/{ci}/{name}");
            push(
                &mut out,
                format!("{sp}/claims"),
                &side.claims,
                StatedAllowed,
            );
            if let Some(s) = &side.sites {
                push(&mut out, format!("{sp}/sites/claims"), &s.claims, CodeOnly);
            }
        }
    }
    for (ci, c) in a.causes.iter().enumerate() {
        push(
            &mut out,
            format!("/causes/{ci}/claims"),
            &c.claims,
            CodeOnly,
        );
    }
    for (ci, c) in a.carried.iter().enumerate() {
        push(
            &mut out,
            format!("/carried/{ci}/claims"),
            &c.claims,
            CodeOnly,
        );
    }
    out
}
