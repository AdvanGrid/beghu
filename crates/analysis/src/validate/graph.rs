//! The code view: IDs, nodes, grouping, facets, lines, boundaries and scenarios.

use std::collections::{HashMap, HashSet};

use super::Context;
use super::index::Index;
use crate::report::{Report, rule};
use crate::schema::{
    AppliesTo, Change, ClaimStatus, EdgeKind, Evidence, FacetAssignment, NodeKind, Question,
};
use crate::words::{generic_data, judging};

pub(super) fn check(ix: &Index, ctx: &Context, r: &mut Report) {
    ids(ix, r);
    nodes(ix, ctx, r);
    facets(ix, r);
    edges(ix, r);
    boundaries(ix, r);
    scenarios(ix, r);
}

pub(super) fn words(ix: &Index, r: &mut Report, path: String, text: &str) {
    if let Some(w) = judging(text, &ix.names) {
        r.warn(
            path,
            rule::WORDS_JUDGING,
            format!("\"{w}\" judges or compares: describe what is there instead"),
        );
    }
}

/// IDs share one namespace across nodes, lines, boundaries, scenarios, facets, purposes, rules,
/// conflicts, causes and claims, so a stop or a `carried` entry names one thing.
fn ids<'a>(ix: &Index<'a>, r: &mut Report) {
    let a = ix.a;
    let mut seen: HashMap<&'a str, String> = HashMap::new();
    let mut add = |id: &'a str, path: String, r: &mut Report| {
        if let Some(first) = seen.get(id) {
            r.error(
                path,
                rule::ID_DUPLICATE,
                format!("ID `{id}` is already used at {first}"),
            );
        } else {
            seen.insert(id, path);
        }
    };
    for (i, n) in a.nodes.iter().enumerate() {
        add(&n.id, format!("/nodes/{i}/id"), r);
    }
    for (i, e) in a.edges.iter().enumerate() {
        add(&e.id, format!("/edges/{i}/id"), r);
    }
    for (i, b) in a.boundaries.iter().enumerate() {
        add(&b.id, format!("/boundaries/{i}/id"), r);
    }
    for (i, s) in a.scenarios.iter().enumerate() {
        add(&s.id, format!("/scenarios/{i}/id"), r);
    }
    for (i, f) in a.facets.iter().enumerate() {
        add(&f.id, format!("/facets/{i}/id"), r);
    }
    for (i, p) in a.purposes.iter().enumerate() {
        add(&p.id, format!("/purposes/{i}/id"), r);
        for (j, rl) in p.rules.iter().flatten().enumerate() {
            add(&rl.id, format!("/purposes/{i}/rules/{j}/id"), r);
        }
    }
    for (i, c) in a.conflicts.iter().enumerate() {
        add(&c.id, format!("/conflicts/{i}/id"), r);
    }
    for (i, c) in a.causes.iter().enumerate() {
        add(&c.id, format!("/causes/{i}/id"), r);
    }
    for (i, c) in a.claims.iter().enumerate() {
        add(&c.id, format!("/claims/{i}/id"), r);
        let ok = c.id.strip_prefix('c').is_some_and(|n| {
            !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
        });
        if !ok {
            r.error(
                format!("/claims/{i}/id"),
                rule::CLAIM_ID,
                format!("claim ID `{}` isn't `c1`, `c2`, …", c.id),
            );
        }
    }
}

fn nodes(ix: &Index, ctx: &Context, r: &mut Report) {
    let a = ix.a;
    let systems: Vec<usize> = a
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == NodeKind::System)
        .map(|(i, _)| i)
        .collect();
    if systems.len() != 1 {
        r.error(
            "/nodes",
            rule::SYSTEM_ROOT,
            format!(
                "found {} `system` nodes; there is exactly one",
                systems.len()
            ),
        );
    }
    // Every changed file the analysis or the run knows of.
    let mut changed: Vec<&str> = a
        .nodes
        .iter()
        .flat_map(|n| n.files.iter().map(|f| f.path.as_str()))
        .collect();
    if let Some(files) = &ctx.changed_files {
        changed.extend(files.iter().map(String::as_str));
    }
    let mut placed: HashMap<&str, &str> = HashMap::new();
    for (i, n) in a.nodes.iter().enumerate() {
        let p = format!("/nodes/{i}");
        match (&n.parent, n.kind) {
            (Some(_), NodeKind::System) => {
                r.error(format!("{p}/parent"), rule::SYSTEM_ROOT, "the `system` node has no parent")
            }
            (None, k) if k != NodeKind::System => r.error(
                format!("{p}/parent"),
                rule::SYSTEM_ROOT,
                format!("`{}` has no parent: top-level parts, stores, external systems and people name the `system` node", n.id),
            ),
            (Some(parent), _) if ix.node(parent).is_none() => {
                r.error(format!("{p}/parent"), rule::REF_UNKNOWN, format!("unknown parent `{parent}`"))
            }
            _ => {}
        }
        if n.parent.is_some() && ix.ancestors(&n.id).contains(&n.id.as_str()) {
            r.error(
                format!("{p}/parent"),
                rule::NODE_PARENT_CYCLE,
                format!("`{}` is its own ancestor", n.id),
            );
        }
        if let Some(z) = &n.zone
            && !ix.boundaries.contains(z.as_str())
        {
            r.error(
                format!("{p}/zone"),
                rule::REF_UNKNOWN,
                format!("unknown boundary `{z}`"),
            );
        }
        let needs_paths = !matches!(
            n.kind,
            NodeKind::System | NodeKind::External | NodeKind::Actor
        );
        if needs_paths && n.paths.is_empty() {
            r.error(
                format!("{p}/paths"),
                rule::NODE_PATHS,
                format!("`{}` has no paths: every node but the system, external systems and people is code that exists", n.id),
            );
        }
        if n.change != Change::Unchanged
            && n.change_summary
                .as_deref()
                .is_none_or(|s| s.trim().is_empty())
        {
            r.error(
                format!("{p}/changeSummary"),
                rule::NODE_CHANGE_SUMMARY,
                format!("`{}` is {} but has no changeSummary", n.id, name(&n.change)),
            );
        }
        if n.change != Change::Unchanged
            && n.kind != NodeKind::System
            && !own_code(ix, &n.id, &changed)
        {
            r.error(
                format!("{p}/change"),
                rule::CHANGE_OWN_CODE,
                format!(
                    "`{}` is marked {}, but no file the PR changed is under its paths or its children's: only its connections changed, so it stays unchanged and its lines carry the change",
                    n.id,
                    name(&n.change)
                ),
            );
        }
        let mut resp = HashSet::new();
        for (ri, rs) in n.responsibilities.iter().enumerate() {
            if !resp.insert(rs.id.as_str()) {
                r.error(
                    format!("{p}/responsibilities/{ri}/id"),
                    rule::RESPONSIBILITY_DUPLICATE,
                    format!("responsibility `{}` appears twice on `{}`", rs.id, n.id),
                );
            }
            if rs.claims.is_empty() {
                r.error(
                    format!("{p}/responsibilities/{ri}/claims"),
                    rule::CLAIMS_MISSING,
                    "a responsibility needs claims",
                );
            }
            words(ix, r, format!("{p}/responsibilities/{ri}/text"), &rs.text);
        }
        for (fi, f) in n.files.iter().enumerate() {
            if let Some(first) = placed.insert(f.path.as_str(), n.id.as_str()) {
                r.error(
                    format!("{p}/files/{fi}"),
                    rule::FILE_DUPLICATE,
                    format!("`{}` is on both `{first}` and `{}`: list it only on the deepest node that holds it", f.path, n.id),
                );
            }
            if !f.generated && f.summary.as_deref().is_none_or(|s| s.trim().is_empty()) {
                r.error(
                    format!("{p}/files/{fi}/summary"),
                    rule::FILE_SUMMARY,
                    format!(
                        "`{}` needs a one-line summary (or `generated: true`)",
                        f.path
                    ),
                );
            }
        }
        // Grouping (no grouping nodes).
        if ix.has_children(&n.id)
            && n.kind != NodeKind::System
            && !n.responsibilities.iter().any(|rs| !rs.claims.is_empty())
        {
            r.error(
                format!("{p}/responsibilities"),
                rule::GROUP_RESPONSIBILITY,
                format!("`{}` has children but no responsibility with claims of its own: a node is code that does something, never a group", n.id),
            );
        }
        if ix.is_top_level(n) {
            for &c in ix.children.get(n.id.as_str()).into_iter().flatten() {
                let child = &a.nodes[c];
                if !matches!(child.kind, NodeKind::Module) {
                    r.error(
                        format!("/nodes/{c}/parent"),
                        rule::GROUP_TOP_LEVEL_KINDS,
                        format!(
                            "`{}` is a {} inside top-level `{}`: services, apps, libraries, stores, external systems and people hang directly off the system, never under a grouping node",
                            child.id,
                            name(&child.kind),
                            n.id
                        ),
                    );
                }
            }
        }
        if n.drawn.is_some() && n.change != Change::Unchanged {
            r.error(
                format!("{p}/drawn"),
                rule::DRAWN_CHANGED,
                format!(
                    "`{}` is changed: changed parts are drawn complete, without `drawn`",
                    n.id
                ),
            );
        }
        if n.built.as_ref().is_some_and(|b| !b.is_empty()) && n.change == Change::Unchanged {
            r.error(
                format!("{p}/built"),
                rule::BUILT_CHANGED,
                format!("`{}` is unchanged: `built` is for changed parts only", n.id),
            );
        }
        for (bi, b) in n.built.iter().flatten().enumerate() {
            if b.claims.is_empty() {
                r.error(
                    format!("{p}/built/{bi}/claims"),
                    rule::CLAIMS_MISSING,
                    "`built` needs claims with code evidence",
                );
            }
            words(ix, r, format!("{p}/built/{bi}/text"), &b.text);
        }
        questions(ix, r, &p, &n.questions);
        words(ix, r, format!("{p}/summary"), &n.summary);
        if let Some(s) = &n.change_summary {
            words(ix, r, format!("{p}/changeSummary"), s);
        }
        assignments(ix, r, &p, &n.facets, AppliesTo::Node);
    }
    if let Some(files) = &ctx.changed_files {
        for f in files {
            if !placed.contains_key(f.as_str()) {
                r.error(
                    "/nodes",
                    rule::FILE_UNPLACED,
                    format!("`{f}` changed in the PR but is in no node's files"),
                );
            }
        }
    }
    grouping_facets(ix, r);
}

/// Whether some changed file lies under the node's paths, or on it or a node inside it.
fn own_code(ix: &Index, id: &str, changed: &[&str]) -> bool {
    let mut stack = vec![id];
    let mut seen = HashSet::new();
    while let Some(cur) = stack.pop() {
        if !seen.insert(cur) {
            continue;
        }
        let Some(n) = ix.node(cur) else { continue };
        if !n.files.is_empty() || changed.iter().any(|f| ix.path_in(n, f)) {
            return true;
        }
        for &c in ix.children.get(cur).into_iter().flatten() {
            stack.push(&ix.a.nodes[c].id);
        }
    }
    false
}

/// The `inside-*` and `outside-*` facets.
fn grouping_facets(ix: &Index, r: &mut Report) {
    let a = ix.a;
    let inside: Vec<&str> = a
        .facets
        .iter()
        .filter(|f| f.id.starts_with("inside-"))
        .map(|f| f.id.as_str())
        .collect();
    let outside: Vec<&str> = a
        .facets
        .iter()
        .filter(|f| f.id.starts_with("outside-"))
        .map(|f| f.id.as_str())
        .collect();
    let own_top: Vec<usize> = (0..a.nodes.len())
        .filter(|&i| ix.is_top_level(&a.nodes[i]) && Index::is_part(&a.nodes[i]))
        .collect();
    if !own_top.is_empty() {
        if inside.len() != 1 {
            r.error(
                "/facets",
                rule::GROUP_INSIDE,
                format!("found {} `inside-*` facets; there is exactly one, \"What part of the product is it for?\"", inside.len()),
            );
        }
        for (i, f) in a.facets.iter().enumerate() {
            if f.id.starts_with("inside-") && (!f.multi || f.applies_to != AppliesTo::Node) {
                r.error(
                    format!("/facets/{i}"),
                    rule::GROUP_INSIDE,
                    format!("`{}` applies to nodes and is `multi`", f.id),
                );
            }
        }
        for i in own_top {
            let n = &a.nodes[i];
            let has = n
                .facets
                .iter()
                .any(|f| f.facet.starts_with("inside-") && !f.values.is_empty());
            if !has {
                r.error(
                    format!("/nodes/{i}/facets"),
                    rule::GROUP_INSIDE,
                    format!("top-level part `{}` has no `inside-*` value: say what part of the product it is for", n.id),
                );
            }
        }
    }
    let outer: Vec<usize> = (0..a.nodes.len())
        .filter(|&i| matches!(a.nodes[i].kind, NodeKind::Store | NodeKind::External))
        .collect();
    if !outer.is_empty() {
        if !(2..=3).contains(&outside.len()) {
            r.error(
                "/facets",
                rule::GROUP_OUTSIDE,
                format!("found {} `outside-*` facets; external systems and stores are grouped by 2 or 3", outside.len()),
            );
        }
        for i in outer {
            let n = &a.nodes[i];
            for f in &outside {
                if !n
                    .facets
                    .iter()
                    .any(|x| x.facet == *f && !x.values.is_empty())
                {
                    r.error(
                        format!("/nodes/{i}/facets"),
                        rule::GROUP_OUTSIDE,
                        format!("`{}` has no value for `{f}` (use `unknown` with an undetermined claim if the code doesn't show it)", n.id),
                    );
                }
            }
        }
    }
}

fn questions(ix: &Index, r: &mut Report, p: &str, qs: &[Question]) {
    for (qi, q) in qs.iter().enumerate() {
        if q.claims.is_empty() {
            r.error(
                format!("{p}/questions/{qi}/claims"),
                rule::CLAIMS_MISSING,
                "an answer needs claims",
            );
        }
        words(ix, r, format!("{p}/questions/{qi}/answer"), &q.answer);
    }
}

fn assignments(ix: &Index, r: &mut Report, p: &str, list: &[FacetAssignment], applies: AppliesTo) {
    for (fi, f) in list.iter().enumerate() {
        let fp = format!("{p}/facets/{fi}");
        let Some(&di) = ix.facets.get(f.facet.as_str()) else {
            r.error(
                format!("{fp}/facet"),
                rule::REF_UNKNOWN,
                format!("unknown facet `{}`", f.facet),
            );
            continue;
        };
        let def = &ix.a.facets[di];
        if def.applies_to != applies {
            r.error(
                format!("{fp}/facet"),
                rule::FACET_APPLIES_TO,
                format!("facet `{}` applies to {}s", f.facet, name(&def.applies_to)),
            );
        }
        if !def.multi && f.values.len() > 1 {
            r.error(
                format!("{fp}/values"),
                rule::FACET_SINGLE,
                format!("facet `{}` takes one value", f.facet),
            );
        }
        if f.values.is_empty() {
            r.error(
                format!("{fp}/values"),
                rule::FACET_VALUE_CLAIMS,
                "an assignment holds at least one value",
            );
        }
        for (vi, v) in f.values.iter().enumerate() {
            if !def.values.iter().any(|x| x.id == v.value) {
                r.error(
                    format!("{fp}/values/{vi}/value"),
                    rule::REF_UNKNOWN,
                    format!("facet `{}` has no value `{}`", f.facet, v.value),
                );
            }
            if v.claims.is_empty() {
                r.error(
                    format!("{fp}/values/{vi}/claims"),
                    rule::FACET_VALUE_CLAIMS,
                    format!("value `{}` needs its own claims", v.value),
                );
            }
        }
        for (wi, w) in f.was.iter().flatten().enumerate() {
            if !def.values.iter().any(|x| x.id == *w) {
                r.error(
                    format!("{fp}/was/{wi}"),
                    rule::REF_UNKNOWN,
                    format!("facet `{}` has no value `{w}`", f.facet),
                );
            }
        }
    }
}

fn facets(ix: &Index, r: &mut Report) {
    for (i, f) in ix.a.facets.iter().enumerate() {
        let p = format!("/facets/{i}");
        if f.values.len() < 2 {
            r.error(
                format!("{p}/values"),
                rule::FACET_VALUES,
                format!("facet `{}` has fewer than two values", f.id),
            );
        }
        if !f.values.iter().any(|v| v.id == "unknown") {
            r.error(
                format!("{p}/values"),
                rule::FACET_UNKNOWN_VALUE,
                format!("facet `{}` has no `unknown` value", f.id),
            );
        }
        let mut seen = HashSet::new();
        for (vi, v) in f.values.iter().enumerate() {
            if !seen.insert(v.id.as_str()) {
                r.error(
                    format!("{p}/values/{vi}/id"),
                    rule::ID_DUPLICATE,
                    format!("value `{}` appears twice in `{}`", v.id, f.id),
                );
            }
            let len = v.prefix.chars().count();
            if !(1..=4).contains(&len) {
                r.error(
                    format!("{p}/values/{vi}/prefix"),
                    rule::FACET_PREFIX,
                    format!("prefix `{}` must be 1–4 characters", v.prefix),
                );
            }
        }
    }
}

fn edges(ix: &Index, r: &mut Report) {
    let a = ix.a;
    let mut interactions: HashMap<(&str, &str, EdgeKind, String), usize> = HashMap::new();
    for (i, e) in a.edges.iter().enumerate() {
        let p = format!("/edges/{i}");
        let from = ix.node(&e.from);
        let to = ix.node(&e.to);
        if from.is_none() {
            r.error(
                format!("{p}/from"),
                rule::REF_UNKNOWN,
                format!("unknown node `{}`", e.from),
            );
        }
        if to.is_none() {
            r.error(
                format!("{p}/to"),
                rule::REF_UNKNOWN,
                format!("unknown node `{}`", e.to),
            );
        }
        for (bi, b) in e.boundaries.iter().enumerate() {
            if !ix.boundaries.contains(b.as_str()) {
                r.error(
                    format!("{p}/boundaries/{bi}"),
                    rule::REF_UNKNOWN,
                    format!("unknown boundary `{b}`"),
                );
            }
        }
        // `uses`: a responsibility of `to` or of a node inside it.
        match (&e.uses, e.kind) {
            (None, EdgeKind::Call) => r.error(
                format!("{p}/uses"),
                rule::LINE_USES,
                format!(
                    "call `{}` names no `uses`: the callee's responsibility it uses",
                    e.id
                ),
            ),
            (Some(u), _) if to.is_some() => {
                let found = a.nodes.iter().any(|n| {
                    ix.within(&n.id, &e.to) && n.responsibilities.iter().any(|rs| rs.id == *u)
                });
                if !found {
                    r.error(
                        format!("{p}/uses"),
                        rule::LINE_USES,
                        format!(
                            "`{u}` isn't a responsibility of `{}` or of a node inside it",
                            e.to
                        ),
                    );
                }
            }
            _ => {}
        }
        match (&e.data, e.kind) {
            (None, EdgeKind::Data | EdgeKind::Event) => r.error(
                format!("{p}/data"),
                rule::LINE_DATA,
                format!(
                    "{} line `{}` needs `data`: what crosses it",
                    name(&e.kind),
                    e.id
                ),
            ),
            (Some(d), _) if generic_data(&d.what) => r.warn(
                format!("{p}/data/what"),
                rule::LINE_DATA_GENERIC,
                format!(
                    "\"{}\" names no domain data: say what records, messages or files cross",
                    d.what
                ),
            ),
            _ => {}
        }
        // One line per interaction.
        let key = match e.kind {
            EdgeKind::Call => e.uses.clone().unwrap_or_default(),
            _ => e
                .data
                .as_ref()
                .map(|d| d.what.trim().to_lowercase())
                .unwrap_or_default(),
        };
        if let Some(first) = interactions.insert((&e.from, &e.to, e.kind, key), i) {
            r.error(
                p.to_string(),
                rule::LINE_PER_INTERACTION,
                format!(
                    "`{}` repeats the interaction of `{}`: one {} line per (caller, callee responsibility)",
                    e.id,
                    a.edges[first].id,
                    name(&e.kind)
                ),
            );
        }
        if e.claims.is_empty() {
            r.error(
                format!("{p}/claims"),
                rule::CLAIMS_MISSING,
                "a line needs at least a call-site claim",
            );
        } else if let (Some(from), Some(to)) = (from, to) {
            // The call site: on the caller's paths, or for a line from outside, the receiving
            // entry point on the callee's.
            let site = if matches!(from.kind, NodeKind::External | NodeKind::Actor)
                || from.paths.is_empty()
            {
                to
            } else {
                from
            };
            let suspected = e.claims.iter().any(|c| {
                ix.claims
                    .get(c.as_str())
                    .is_some_and(|&ci| a.claims[ci].status == ClaimStatus::Undetermined)
            });
            let at_site = e.claims.iter().any(|c| {
                ix.code_evidence(c)
                    .iter()
                    .any(|ev| matches!(ev, Evidence::Code { path, .. } if ix.path_in(site, path)))
            });
            if !at_site && !suspected {
                r.error(
                    format!("{p}/claims"),
                    rule::LINE_CALL_SITE,
                    format!(
                        "`{}` has no claim with code evidence under `{}`'s paths: cite the lines that call, write or publish{}",
                        e.id,
                        site.id,
                        if site.id == e.to { " (the receiving entry point, for a line from outside)" } else { "" }
                    ),
                );
            }
        }
        if e.walk.is_some() && e.needed_by.as_ref().is_none_or(Vec::is_empty) {
            r.error(
                format!("{p}/neededBy"),
                rule::LINE_NEEDED_BY,
                format!("`{}` has a walk, so it needs `neededBy`", e.id),
            );
        }
        for (ni, nb) in e.needed_by.iter().flatten().enumerate() {
            if let Some(n) = &nb.node
                && ix.node(n).is_none()
            {
                r.error(
                    format!("{p}/neededBy/{ni}/node"),
                    rule::REF_UNKNOWN,
                    format!("unknown node `{n}`"),
                );
            }
            if let Some(pp) = &nb.purpose
                && !ix.purposes.contains_key(pp.as_str())
            {
                r.error(
                    format!("{p}/neededBy/{ni}/purpose"),
                    rule::REF_UNKNOWN,
                    format!("unknown purpose `{pp}`"),
                );
            }
        }
        questions(ix, r, &p, &e.questions);
        words(ix, r, format!("{p}/label"), &e.label);
        assignments(ix, r, &p, &e.facets, AppliesTo::Edge);
    }
}

fn boundaries(ix: &Index, r: &mut Report) {
    for (i, b) in ix.a.boundaries.iter().enumerate() {
        if b.claims.is_empty() {
            r.error(
                format!("/boundaries/{i}/claims"),
                rule::CLAIMS_MISSING,
                "a boundary needs claims",
            );
        }
    }
}

fn scenarios(ix: &Index, r: &mut Report) {
    for (si, s) in ix.a.scenarios.iter().enumerate() {
        let p = format!("/scenarios/{si}");
        for (ti, t) in s.steps.iter().enumerate() {
            let tp = format!("{p}/steps/{ti}");
            if ix.node(&t.from).is_none() {
                r.error(
                    format!("{tp}/from"),
                    rule::REF_UNKNOWN,
                    format!("unknown node `{}`", t.from),
                );
            }
            if ix.node(&t.to).is_none() {
                r.error(
                    format!("{tp}/to"),
                    rule::REF_UNKNOWN,
                    format!("unknown node `{}`", t.to),
                );
            }
            if let Some(e) = &t.edge
                && !ix.edges.contains_key(e.as_str())
            {
                r.error(
                    format!("{tp}/edge"),
                    rule::REF_UNKNOWN,
                    format!("unknown edge `{e}`"),
                );
            }
            if t.claims.is_empty() {
                r.error(
                    format!("{tp}/claims"),
                    rule::CLAIMS_MISSING,
                    "a step needs claims",
                );
            }
        }
        words(ix, r, format!("{p}/title"), &s.title);
        let n = s.steps.len() as u32;
        if s.chapters.is_empty() {
            r.error(
                format!("{p}/chapters"),
                rule::CHAPTER_MISSING,
                format!("`{}` has no chapters: cut the flow into its moments", s.id),
            );
        }
        for (ci, c) in s.chapters.iter().enumerate() {
            let cp = format!("{p}/chapters/{ci}");
            if ci == 0 && c.from != 0 {
                r.error(
                    format!("{cp}/from"),
                    rule::CHAPTER_FIRST,
                    "the first chapter starts at step 0",
                );
            }
            let end = s.chapters.get(ci + 1).map_or(n, |x| x.from);
            if c.from >= n {
                r.error(
                    format!("{cp}/from"),
                    rule::CHAPTER_ORDER,
                    format!("step {} doesn't exist: the flow has {n} steps", c.from),
                );
            } else if end <= c.from {
                r.error(
                    format!("{cp}/from"),
                    rule::CHAPTER_ORDER,
                    "chapters start in order, each after the one before",
                );
            } else if end - c.from > 6 {
                r.warn(
                    cp.to_string(),
                    rule::CHAPTER_LONG,
                    format!(
                        "{} steps: a chapter over 6 steps usually holds two moments",
                        end - c.from
                    ),
                );
            }
            words(ix, r, format!("{cp}/title"), &c.title);
        }
    }
}

/// An enum value as the JSON writes it.
pub(super) fn name<T: serde::Serialize>(x: &T) -> String {
    serde_json::to_value(x)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
