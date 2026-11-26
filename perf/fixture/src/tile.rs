//! The tiler: the recorded analysis (`fixtures/pr-view/beghu-<n>/analysis-v1.json`) grown to
//! perf sizes, for the server's analysis gates and the PR view's perf suites. Deterministic and
//! cached beside the fixtures, by the generator's hash (which covers the recordings, the analysis
//! crate and this file).
//!
//! - **1×, #2627's shape** (76 top-level parts, 167 lines at the top level, ~1,250 claims;
//!   #2627 itself is private): the real analysis whole, then **light copies** of its top-level
//!   parts until there are [`TOP_LEVEL_PARTS`]. A line at the top level is what the layout draws
//!   there: one per distinct (from, to) pair of top-level nodes an edge's ends sit in, its edges
//!   rolled up into it (#166, #180); an edge inside one part isn't drawn there. The real analysis
//!   has 192 edges behind 78 such lines. A light copy is a part as an unchanged one is drawn:
//!   its responsibilities and facets with their claims, none of its modules, files or questions
//!   (an unchanged part has no "What changed?"), and lines of its own: the real analysis's edges
//!   lifted to the copied parts (and the stores, actors and external systems, which the copies
//!   share), one edge per pair, each citing one claim. The light copies share the
//!   [`TOP_LEVEL_LINES`] the real analysis leaves, by their parts. Each copy is wired into the
//!   real analysis (its first line's caller to the original callee, and each part the real
//!   analysis draws no line for to its original), so no part sits alone.
//! - **3×**: the 1× three times, each later copy wired to the first.
//!
//! Every copy prefixes its IDs (`t1-api`, `purpose:x1-refunds`), renumbers its claims past the
//! ones before it, and prefixes its paths (`t1/crates/…`, also in evidence), so it's a distinct
//! part of the same repo. Prose and evidence keep their real lengths. Facets and their values,
//! and a part's responsibility IDs, are shared vocabulary and stay as they are. Each result is
//! checked by the validator as the server checks an upload (no code is read: the paths are
//! made up) and comes with the `pr.json` the run pins for its synthetic PR: the recorded one,
//! with the tiled PR's number, title, head and changed files.

use analysis::{
    Analysis, Carried, Change, Claim, Conflict, Context, Edge, Evidence, FileChange, Node,
    NodeKind, PinnedFile, PinnedPr, Previous, Purpose, Scenario, Walk,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The top-level parts the 1× holds, as #2627 has.
pub const TOP_LEVEL_PARTS: usize = 76;

/// The lines at the top level the 1× holds, as #2627 has (#162).
pub const TOP_LEVEL_LINES: usize = 167;

/// A tiled analysis and its PR.
pub struct Tiled {
    /// `tiled-1x` or `tiled-3x`.
    pub name: &'static str,
    pub number: i64,
    pub analysis: Analysis,
    pub pr: PinnedPr,
}

/// How one copy renames what it copies.
struct Tag {
    /// Prefixed to IDs: `t1-`.
    id: String,
    /// Prefixed to paths: `t1/`.
    path: String,
    /// Added to every claim's number.
    claims: u32,
}

impl Tag {
    fn id(&self, s: &str) -> String {
        format!("{}{s}", self.id)
    }

    /// A purpose's (or sub-purpose's) ID: the prefix goes after `purpose:`.
    fn purpose(&self, s: &str) -> String {
        match s.strip_prefix("purpose:") {
            Some(rest) => format!("purpose:{}{rest}", self.id),
            None => self.id(s),
        }
    }

    /// Any ID a `carried` entry or a stop may name: a purpose's, or another's.
    fn any(&self, s: &str) -> String {
        if s.starts_with("purpose:") {
            self.purpose(s)
        } else {
            self.id(s)
        }
    }

    fn claim(&self, s: &str) -> String {
        match s.strip_prefix('c').and_then(|n| n.parse::<u32>().ok()) {
            Some(n) => format!("c{}", n + self.claims),
            None => self.id(s),
        }
    }

    fn claims(&self, ids: &[String]) -> Vec<String> {
        ids.iter().map(|c| self.claim(c)).collect()
    }

    fn path(&self, s: &str) -> String {
        format!("{}{s}", self.path)
    }

    fn walk(&self, w: &Walk) -> Walk {
        Walk {
            claims: self.claims(&w.claims),
            ..w.clone()
        }
    }
}

fn ids(list: &[String], f: impl Fn(&str) -> String) -> Vec<String> {
    list.iter().map(|s| f(s)).collect()
}

fn renamed_node(n: &Node, t: &Tag, system: &str) -> Node {
    let mut n = n.clone();
    n.id = t.id(&n.id);
    n.parent = n
        .parent
        .as_deref()
        .map(|p| if p == system { p.to_owned() } else { t.id(p) });
    n.paths = ids(&n.paths, |p| t.path(p));
    for r in &mut n.responsibilities {
        r.claims = t.claims(&r.claims);
    }
    for f in &mut n.facets {
        for v in &mut f.values {
            v.claims = t.claims(&v.claims);
        }
    }
    for q in &mut n.questions {
        q.claims = t.claims(&q.claims);
    }
    for f in &mut n.files {
        f.path = t.path(&f.path);
    }
    n.walk = n.walk.as_ref().map(|w| t.walk(w));
    for b in n.built.iter_mut().flatten() {
        b.claims = t.claims(&b.claims);
    }
    n
}

fn renamed_edge(e: &Edge, t: &Tag, system: &str, keep: &HashSet<String>) -> Edge {
    let mut e = e.clone();
    let end = |x: &str| {
        if x == system || keep.contains(x) {
            x.to_owned()
        } else {
            t.id(x)
        }
    };
    e.id = t.id(&e.id);
    e.from = end(&e.from);
    e.to = end(&e.to);
    e.boundaries = ids(&e.boundaries, |b| t.id(b));
    for f in &mut e.facets {
        for v in &mut f.values {
            v.claims = t.claims(&v.claims);
        }
    }
    for q in &mut e.questions {
        q.claims = t.claims(&q.claims);
    }
    e.claims = t.claims(&e.claims);
    e.walk = e.walk.as_ref().map(|w| t.walk(w));
    for nb in e.needed_by.iter_mut().flatten() {
        nb.node = nb.node.as_deref().map(|x| t.id(x));
        nb.purpose = nb.purpose.as_deref().map(|x| t.purpose(x));
    }
    e
}

fn renamed_claim(c: &Claim, t: &Tag) -> Claim {
    let mut c = c.clone();
    c.id = t.claim(&c.id);
    for e in &mut c.evidence {
        if let Evidence::Code { path, .. } = e {
            *path = t.path(path);
        }
    }
    c
}

fn renamed_scenario(s: &Scenario, t: &Tag) -> Scenario {
    let mut s = s.clone();
    s.id = t.id(&s.id);
    for st in &mut s.steps {
        st.from = t.id(&st.from);
        st.to = t.id(&st.to);
        st.edge = st.edge.as_deref().map(|e| t.id(e));
        st.claims = t.claims(&st.claims);
    }
    s
}

fn renamed_purpose(p: &Purpose, t: &Tag) -> Purpose {
    let mut p = p.clone();
    p.id = t.purpose(&p.id);
    p.parent = p.parent.as_deref().map(|x| t.purpose(x));
    p.walk = t.walk(&p.walk);
    for s in &mut p.stops {
        s.reference = t.any(&s.reference);
    }
    for s in &mut p.serves {
        s.node = t.id(&s.node);
        s.claims = t.claims(&s.claims);
    }
    for c in &mut p.carries {
        c.edge = t.id(&c.edge);
        c.claims = t.claims(&c.claims);
    }
    for r in p.rules.iter_mut().flatten() {
        r.id = t.id(&r.id);
        r.sources = t.claims(&r.sources);
    }
    p
}

fn renamed_conflict(c: &Conflict, t: &Tag) -> Conflict {
    let mut c = c.clone();
    c.id = t.id(&c.id);
    c.cause = c.cause.as_deref().map(|x| t.id(x));
    for side in [&mut c.a, &mut c.b] {
        side.purpose = side.purpose.as_deref().map(|x| t.purpose(x));
        side.claims = t.claims(&side.claims);
        if let Some(s) = &mut side.sites {
            s.claims = t.claims(&s.claims);
        }
    }
    c.rule = c.rule.as_deref().map(|x| t.id(x));
    c.touches.purposes = ids(&c.touches.purposes, |x| t.purpose(x));
    c.touches.nodes = ids(&c.touches.nodes, |x| t.id(x));
    c.touches.edges = ids(&c.touches.edges, |x| t.id(x));
    c
}

fn system_id(a: &Analysis) -> String {
    a.nodes
        .iter()
        .find(|n| n.kind == NodeKind::System)
        .map(|n| n.id.clone())
        .expect("an analysis has a system node")
}

fn is_part(n: &Node) -> bool {
    matches!(
        n.kind,
        NodeKind::Service | NodeKind::App | NodeKind::Library | NodeKind::Module
    )
}

fn top_level_parts<'a>(a: &'a Analysis, system: &str) -> Vec<&'a Node> {
    a.nodes
        .iter()
        .filter(|n| n.parent.as_deref() == Some(system) && is_part(n))
        .collect()
}

/// The lines drawn at the top level: one per distinct (from, to) pair of top-level nodes that
/// some edge's ends sit in, as the layout rolls edges up (#166, #180). An edge inside one part
/// isn't drawn there.
fn top_level_lines(a: &Analysis, system: &str) -> usize {
    let parent = parents(a);
    a.edges
        .iter()
        .map(|e| (top(&parent, system, &e.from), top(&parent, system, &e.to)))
        .filter(|(f, t)| f != t)
        .collect::<HashSet<_>>()
        .len()
}

fn parents(a: &Analysis) -> HashMap<&str, &str> {
    a.nodes
        .iter()
        .filter_map(|n| Some((n.id.as_str(), n.parent.as_deref()?)))
        .collect()
}

/// The top-level node `x` sits in (itself, at the top level).
fn top<'a>(parent: &HashMap<&'a str, &'a str>, system: &str, mut x: &'a str) -> &'a str {
    while let Some(&p) = parent.get(x).filter(|p| **p != system) {
        x = p;
    }
    x
}

fn max_claim(a: &Analysis) -> u32 {
    a.claims
        .iter()
        .filter_map(|c| c.id.strip_prefix('c').and_then(|n| n.parse().ok()))
        .max()
        .unwrap_or(0)
}

/// Adds `tag`'s whole copy of `src` to `out`, its first line wired to the part of `out`'s first
/// copy it calls.
fn add_copy(out: &mut Analysis, src: &Analysis, t: &Tag) {
    let system = system_id(src);
    let none = HashSet::new();
    out.nodes.extend(
        src.nodes
            .iter()
            .filter(|n| n.kind != NodeKind::System)
            .map(|n| renamed_node(n, t, &system)),
    );
    out.edges
        .extend(src.edges.iter().map(|e| renamed_edge(e, t, &system, &none)));
    out.boundaries.extend(src.boundaries.iter().map(|b| {
        let mut b = b.clone();
        b.id = t.id(&b.id);
        b.claims = t.claims(&b.claims);
        b
    }));
    out.scenarios
        .extend(src.scenarios.iter().map(|s| renamed_scenario(s, t)));
    out.purposes
        .extend(src.purposes.iter().map(|p| renamed_purpose(p, t)));
    out.conflicts
        .extend(src.conflicts.iter().map(|c| renamed_conflict(c, t)));
    out.causes.extend(src.causes.iter().map(|c| {
        let mut c = c.clone();
        c.id = t.id(&c.id);
        c.claims = t.claims(&c.claims);
        c
    }));
    out.unclaimed.extend(src.unclaimed.iter().map(|u| {
        let mut u = u.clone();
        u.node = t.id(&u.node);
        u
    }));
    out.carried.extend(src.carried.iter().map(|c| Carried {
        was: t.any(&c.was),
        now: ids(&c.now, |x| t.any(x)),
        claims: t.claims(&c.claims),
        ..c.clone()
    }));
    out.claims
        .extend(src.claims.iter().map(|c| renamed_claim(c, t)));
    wire(out, src, t, &system);
}

/// One line from `tag`'s copy into the first copy: the source's first line between two
/// top-level parts, from the copy's caller to the original callee.
fn wire(out: &mut Analysis, src: &Analysis, t: &Tag, system: &str) {
    let top: HashSet<&str> = top_level_parts(src, system)
        .iter()
        .map(|n| n.id.as_str())
        .collect();
    let Some(e) = src
        .edges
        .iter()
        .find(|e| top.contains(e.from.as_str()) && top.contains(e.to.as_str()))
    else {
        return;
    };
    let keep = HashSet::from([e.to.clone()]);
    let mut w = unchanged(renamed_edge(e, t, system, &keep));
    w.id = format!("{}-wire", w.id);
    out.edges.push(w);
}

/// A copied line as an unchanged one is drawn: no change, boundaries, walk or dependants.
fn unchanged(mut e: Edge) -> Edge {
    e.change = Change::Unchanged;
    e.boundaries.clear();
    e.walk = None;
    e.needed_by = None;
    for f in &mut e.facets {
        f.was = None;
    }
    e
}

/// `src`'s edges lifted to the top-level nodes their ends sit in, the first edge of each
/// distinct (from, to) in `src`'s order, as `(edge, from, to)`: those between two of `chosen`'s
/// parts, or between one of them and a top-level node that isn't a part (a store, an actor, an
/// external system), which a light copy shares with the real analysis.
fn lifted<'a>(
    src: &'a Analysis,
    system: &str,
    chosen: &HashSet<&str>,
) -> Vec<(&'a Edge, &'a str, &'a str)> {
    let parent = parents(src);
    let shared: HashSet<&str> = src
        .nodes
        .iter()
        .filter(|n| n.parent.as_deref() == Some(system) && !is_part(n))
        .map(|n| n.id.as_str())
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for e in &src.edges {
        let (f, to) = (top(&parent, system, &e.from), top(&parent, system, &e.to));
        let ok = |x: &str| chosen.contains(x) || shared.contains(x);
        if f != to
            && (chosen.contains(f) || chosen.contains(to))
            && ok(f)
            && ok(to)
            && seen.insert((f, to))
        {
            out.push((e, f, to));
        }
    }
    out
}

/// Adds `tag`'s light copy of the first `count` of `src`'s top-level parts to `out`, with at
/// most `lines` lines at the top level (each one distinct, so each one drawn): its wire into the
/// real analysis, a wire from each copied part `src` draws no line for to its original, then
/// [`lifted`] lines, first one for each part not yet on a line, then the rest in order.
fn add_light(out: &mut Analysis, src: &Analysis, t: &Tag, count: usize, lines: usize) {
    let system = system_id(src);
    let parts: Vec<&Node> = top_level_parts(src, &system)
        .into_iter()
        .take(count)
        .collect();
    let chosen: HashSet<&str> = parts.iter().map(|n| n.id.as_str()).collect();
    let mut used: HashSet<String> = HashSet::new();
    for n in &parts {
        let mut n = renamed_node(n, t, &system);
        n.change = Change::Unchanged;
        n.change_summary = None;
        n.files = Vec::new();
        n.walk = None;
        n.built = None;
        n.drawn = None;
        for r in &mut n.responsibilities {
            r.change = Change::Unchanged;
        }
        for f in &mut n.facets {
            f.was = None;
        }
        n.questions.clear();
        let refs = n.responsibilities.iter().flat_map(|r| &r.claims).chain(
            n.facets
                .iter()
                .flat_map(|f| f.values.iter().flat_map(|v| &v.claims)),
        );
        used.extend(refs.cloned());
        out.nodes.push(n);
    }
    let before = out.edges.len();
    wire(out, src, t, &system);
    let template = out.edges[before..].first().cloned();
    let candidates = lifted(src, &system, &chosen);
    let on_line: HashSet<&str> = candidates.iter().flat_map(|&(_, f, to)| [f, to]).collect();
    // A part `src` draws no line for gets one to its original, so no copy sits alone.
    let resp = |id: &str| {
        src.nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.responsibilities.first())
            .map(|r| r.id.clone())
    };
    if let Some(w) = &template {
        for n in parts.iter().filter(|n| !on_line.contains(n.id.as_str())) {
            let mut e = w.clone();
            e.id = t.id(&format!("{}-wire", n.id));
            e.from = t.id(&n.id);
            e.to = n.id.clone();
            e.uses = resp(&n.id).or(e.uses);
            // Its call site: the claims behind the copy's own first responsibility.
            let copy = out.nodes.iter().rev().find(|c| c.id == e.from);
            if let Some(r) = copy.and_then(|c| c.responsibilities.first()) {
                e.claims = r.claims.clone();
            }
            out.edges.push(e);
        }
    }
    let room = lines.saturating_sub(out.edges.len() - before);
    let mut pick = vec![false; candidates.len()];
    let mut covered: HashSet<&str> = HashSet::new();
    let mut picked = 0;
    for (i, &(_, f, to)) in candidates.iter().enumerate() {
        if picked < room
            && [f, to]
                .iter()
                .any(|x| chosen.contains(x) && !covered.contains(x))
        {
            pick[i] = true;
            picked += 1;
            covered.extend([f, to]);
        }
    }
    for p in pick.iter_mut().filter(|p| !**p) {
        if picked < room {
            *p = true;
            picked += 1;
        }
    }
    let end = |x: &str| {
        if chosen.contains(x) {
            t.id(x)
        } else {
            x.to_owned()
        }
    };
    for (&(e, f, to), _) in candidates.iter().zip(&pick).filter(|(_, p)| **p) {
        let mut e = unchanged(renamed_edge(e, t, &system, &HashSet::new()));
        e.from = end(f);
        e.to = end(to);
        // `uses` names a responsibility of `to` or of a node inside it; the copy has only `to`.
        if let Some(u) = &e.uses {
            let own = src
                .nodes
                .iter()
                .find(|n| n.id == to)
                .is_some_and(|n| n.responsibilities.iter().any(|r| &r.id == u));
            if !own {
                e.uses = resp(to);
            }
        }
        out.edges.push(e);
    }
    // Its lines' claims, but for their questions (as its parts'), and only the first behind each
    // line: a rolled-up line stands for several of `src`'s, but cites one call site.
    for e in &mut out.edges[before..] {
        e.questions.clear();
        e.claims.truncate(1);
        used.extend(e.claims.iter().cloned());
        used.extend(
            e.facets
                .iter()
                .flat_map(|f| f.values.iter().flat_map(|v| v.claims.iter().cloned())),
        );
    }
    out.claims.extend(
        src.claims
            .iter()
            .map(|c| renamed_claim(c, t))
            .filter(|c| used.contains(&c.id)),
    );
}

/// The changed files the analysis places, as `pr.json` lists them.
fn files_of(a: &Analysis) -> Vec<PinnedFile> {
    a.nodes
        .iter()
        .flat_map(|n| &n.files)
        .map(|f: &FileChange| PinnedFile {
            path: f.path.clone(),
            previous_path: None,
            status: match f.status {
                analysis::FileStatus::Added => "added",
                analysis::FileStatus::Modified => "modified",
                analysis::FileStatus::Removed => "removed",
                analysis::FileStatus::Renamed => "renamed",
            }
            .into(),
            additions: f.added,
            deletions: f.removed,
        })
        .collect()
}

/// A tiled PR's head: 40 hex digits derived from its number (splitmix64, as the generator's).
fn head_for(number: i64) -> String {
    crate::head_sha(0x7469_6c65_0000 + number)
}

/// Points the tiled analysis and its `pr.json` at the synthetic PR `number`.
fn as_pr(mut a: Analysis, recorded: &PinnedPr, number: i64, name: &'static str) -> Tiled {
    let mut pr = recorded.clone();
    pr.number = number as u32;
    pr.title = format!("{} ({name}, for the perf gates)", recorded.title);
    pr.url = format!("https://github.com/{}/pull/{number}", recorded.repo);
    pr.head_sha = head_for(number);
    pr.files = files_of(&a);
    pr.stats.files = pr.files.len() as u32;
    pr.stats.additions = pr.files.iter().map(|f| f.additions).sum();
    pr.stats.deletions = pr.files.iter().map(|f| f.deletions).sum();
    a.pr.number = pr.number;
    a.pr.title = pr.title.clone();
    a.pr.url = pr.url.clone();
    a.pr.head_sha = pr.head_sha.clone();
    a.pr.stats.files = pr.stats.files;
    a.pr.stats.additions = pr.stats.additions;
    a.pr.stats.deletions = pr.stats.deletions;
    Tiled {
        name,
        number,
        analysis: a,
        pr,
    }
}

/// The 1× and 3× tiles of the recorded analysis `analysis` (JSON at any schema version), whose
/// run pinned `pr`.
pub fn tile(analysis: &str, pr: &PinnedPr) -> Result<[Tiled; 2], String> {
    let ctx = Context {
        changed_files: Some(pr.files.iter().map(|f| f.path.clone()).collect()),
        previous: Previous::None,
    };
    let real = analysis::validate(analysis, &ctx, None)
        .analysis
        .ok_or("the recorded analysis doesn't pass the shape check")?;
    let system = system_id(&real);

    let mut one = real.clone();
    let per_copy = top_level_parts(&real, &system).len();
    let mut have = per_copy;
    // The lines the light copies share, by their parts.
    let mut lines = TOP_LEVEL_LINES.saturating_sub(top_level_lines(&real, &system));
    let mut k = 1;
    while have < TOP_LEVEL_PARTS && per_copy > 0 {
        let count = per_copy.min(TOP_LEVEL_PARTS - have);
        let share = (lines * count).div_ceil(TOP_LEVEL_PARTS - have).min(lines);
        let t = Tag {
            id: format!("t{k}-"),
            path: format!("t{k}/"),
            claims: max_claim(&one),
        };
        let before = one.edges.len();
        add_light(&mut one, &real, &t, count, share);
        lines = lines.saturating_sub(one.edges.len() - before);
        have += count;
        k += 1;
    }

    let mut three = one.clone();
    for k in 1..3 {
        let t = Tag {
            id: format!("x{k}-"),
            path: format!("x{k}/"),
            claims: max_claim(&three),
        };
        add_copy(&mut three, &one, &t);
    }
    let [(n1, name1), (n3, name3)] = crate::recorded::TILED;
    let out = [as_pr(one, pr, n1, name1), as_pr(three, pr, n3, name3)];
    for t in &out {
        let ctx = Context {
            changed_files: Some(t.pr.files.iter().map(|f| f.path.clone()).collect()),
            previous: Previous::None,
        };
        let text = serde_json::to_string(&t.analysis).expect("the schema's types serialise");
        let r = analysis::validate(&text, &ctx, None).report;
        if !r.errors.is_empty() {
            return Err(format!(
                "{} doesn't validate: {}",
                t.name,
                serde_json::to_string_pretty(&r.errors[..r.errors.len().min(20)]).unwrap()
            ));
        }
    }
    Ok(out)
}

/// Where a tile's files go: `<dir>/tiled-<hash>/<name>/{analysis,pr}.json`.
pub fn paths(dir: &Path, name: &str) -> (PathBuf, PathBuf) {
    let d = dir
        .join(format!("tiled-{}", crate::GENERATOR_HASH))
        .join(name);
    (d.join("analysis.json"), d.join("pr.json"))
}

/// The tiles of the recorded PR's v1, written into `dir` unless this generator wrote them
/// already. Returns each one's `(name, number, analysis path, pr.json path)`.
pub fn cached(dir: &Path) -> Result<Vec<(&'static str, i64, PathBuf, PathBuf)>, String> {
    let v1 = crate::recorded::versions()
        .into_iter()
        .find(|v| v.version == 1)
        .ok_or("no recorded v1 to tile")?;
    let names = crate::recorded::TILED;
    let all: Vec<_> = names
        .iter()
        .map(|&(n, name)| {
            let (a, p) = paths(dir, name);
            (name, n, a, p)
        })
        .collect();
    if all.iter().all(|(_, _, a, p)| a.exists() && p.exists()) {
        return Ok(all);
    }
    let analysis_path =
        crate::recorded::analysis_path(v1.number, 1).ok_or("no analysis-v1.json")?;
    let text = std::fs::read_to_string(&analysis_path)
        .map_err(|e| format!("{}: {e}", analysis_path.display()))?;
    let pr: PinnedPr = serde_json::from_str(v1.text).map_err(|e| format!("pr-v1.json: {e}"))?;
    // Older generators' tiles are stale.
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("tiled-") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    for t in tile(&text, &pr)? {
        let (a, p) = paths(dir, t.name);
        let parent = a.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        let write = |path: &Path, v: String| {
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, v)
                .and_then(|()| std::fs::rename(&tmp, path))
                .map_err(|e| format!("{}: {e}", path.display()))
        };
        write(&p, serde_json::to_string(&t.pr).expect("plain data"))?;
        write(&a, serde_json::to_string(&t.analysis).expect("plain data"))?;
    }
    Ok(all)
}
