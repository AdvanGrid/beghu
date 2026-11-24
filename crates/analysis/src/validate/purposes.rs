//! The purpose view: purposes, walks, conflicts, causes, `unclaimed` and `unbacked`.

use std::collections::HashSet;

use super::graph::words;
use super::index::Index;
use crate::report::{Report, rule};
use crate::schema::{ClaimStatus, ConflictKind, Evidence, Side, Walk, Who};

/// The most break sites a conflict lists before counting the rest.
pub const MAX_SITES: usize = 20;

pub(super) fn check(ix: &Index, r: &mut Report) {
    walks(ix, r);
    purposes(ix, r);
    conflicts(ix, r);
    causes(ix, r);
    unclaimed(ix, r);
}

fn walk(r: &mut Report, p: &str, w: &Walk) {
    if w.claims.is_empty() {
        r.error(
            format!("{p}/claims"),
            rule::WALK_CLAIMS,
            "a walk needs at least one claim",
        );
    }
    for (k, t) in [
        ("intro", &w.intro),
        ("journey", &w.journey),
        ("destination", &w.destination),
    ] {
        words(r, format!("{p}/{k}"), t);
    }
}

fn walks(ix: &Index, r: &mut Report) {
    let a = ix.a;
    walk(r, "/walk", &a.walk);
    for (i, n) in a.nodes.iter().enumerate() {
        if let Some(w) = &n.walk {
            walk(r, &format!("/nodes/{i}/walk"), w);
        } else if ix.is_top_level(n) && Index::is_part(n) && Index::changed(n) {
            r.error(
                format!("/nodes/{i}/walk"),
                rule::WALK_REQUIRED,
                format!("`{}` is a changed top-level part, so it needs a walk", n.id),
            );
        }
    }
    for (i, e) in a.edges.iter().enumerate() {
        if let Some(w) = &e.walk {
            walk(r, &format!("/edges/{i}/walk"), w);
        }
    }
}

/// Whether `id` is `purpose:<slug>` or, under `parent`, `<parent>/<slug>`.
fn purpose_id_ok(id: &str, parent: Option<&str>) -> bool {
    let slug_ok = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    match parent {
        None => id.strip_prefix("purpose:").is_some_and(slug_ok),
        Some(p) => id
            .strip_prefix(p)
            .and_then(|s| s.strip_prefix('/'))
            .is_some_and(slug_ok),
    }
}

fn purposes(ix: &Index, r: &mut Report) {
    let a = ix.a;
    for (pi, p) in a.purposes.iter().enumerate() {
        let pp = format!("/purposes/{pi}");
        let parent = p
            .parent
            .as_deref()
            .and_then(|id| ix.purposes.get(id).map(|&i| &a.purposes[i]));
        match (&p.parent, parent) {
            (Some(id), None) => r.error(
                format!("{pp}/parent"),
                rule::REF_UNKNOWN,
                format!("unknown purpose `{id}`"),
            ),
            (Some(_), Some(parent)) if parent.parent.is_some() => r.error(
                format!("{pp}/parent"),
                rule::PURPOSE_DEPTH,
                format!(
                    "`{}` sits under a sub-purpose: purposes go two levels deep at most",
                    p.id
                ),
            ),
            _ => {}
        }
        if !purpose_id_ok(&p.id, p.parent.as_deref()) {
            r.error(
                format!("{pp}/id"),
                rule::PURPOSE_ID,
                match &p.parent {
                    None => format!(
                        "`{}` isn't `purpose:<slug>` (lowercase letters, digits and hyphens)",
                        p.id
                    ),
                    Some(parent) => format!("`{}` isn't `{parent}/<slug>`", p.id),
                },
            );
        }
        // Members: this purpose's and its sub-purposes'.
        let family: Vec<usize> = std::iter::once(pi)
            .chain(
                a.purposes
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.parent.as_deref() == Some(&p.id))
                    .map(|(i, _)| i),
            )
            .collect();
        let served: Vec<&str> = family
            .iter()
            .flat_map(|&i| a.purposes[i].serves.iter().map(|s| s.node.as_str()))
            .collect();
        let carried: HashSet<&str> = family
            .iter()
            .flat_map(|&i| a.purposes[i].carries.iter().map(|c| c.edge.as_str()))
            .collect();
        if served.is_empty() {
            r.error(
                format!("{pp}/serves"),
                rule::PURPOSE_NO_MEMBERS,
                format!("`{}` has no part serving it: a stated promise no code serves is a stated-vs-code conflict, not a purpose", p.id),
            );
        }
        for (si, s) in p.serves.iter().enumerate() {
            let sp = format!("{pp}/serves/{si}");
            if ix.node(&s.node).is_none() {
                r.error(
                    format!("{sp}/node"),
                    rule::REF_UNKNOWN,
                    format!("unknown node `{}`", s.node),
                );
                continue;
            }
            if s.claims.is_empty() {
                r.error(
                    format!("{sp}/claims"),
                    rule::CLAIMS_MISSING,
                    "a role needs claims",
                );
            }
            words(r, format!("{sp}/role"), &s.role);
            for other in &p.serves {
                if other.node != s.node && ix.within(&other.node, &s.node) {
                    r.error(
                        format!("{sp}/node"),
                        rule::PURPOSE_REDUNDANT_MEMBER,
                        format!(
                            "`{}` and `{}` inside it both serve `{}`: list only the deepest part",
                            s.node, other.node, p.id
                        ),
                    );
                    break;
                }
            }
        }
        for (ci, c) in p.carries.iter().enumerate() {
            let cp = format!("{pp}/carries/{ci}");
            if !ix.edges.contains_key(c.edge.as_str()) {
                r.error(
                    format!("{cp}/edge"),
                    rule::REF_UNKNOWN,
                    format!("unknown edge `{}`", c.edge),
                );
            }
            if c.claims.is_empty() {
                r.error(
                    format!("{cp}/claims"),
                    rule::CLAIMS_MISSING,
                    "a carried line needs claims",
                );
            }
            words(r, format!("{cp}/why"), &c.why);
        }
        for (si, s) in p.stops.iter().enumerate() {
            let sp = format!("{pp}/stops/{si}");
            let id = s.reference.as_str();
            words(r, format!("{sp}/line"), &s.line);
            if let Some(&sub) = ix.purposes.get(id) {
                if a.purposes[sub].parent.as_deref() != Some(&p.id) {
                    r.error(
                        format!("{sp}/ref"),
                        rule::PURPOSE_STOP_NOT_MEMBER,
                        format!("`{id}` isn't a sub-purpose of `{}`", p.id),
                    );
                }
            } else if let Some(&ni) = ix.nodes.get(id) {
                if !served.iter().any(|m| ix.within(m, id)) {
                    r.error(
                        format!("{sp}/ref"),
                        rule::PURPOSE_STOP_NOT_MEMBER,
                        format!(
                            "`{id}` neither serves `{}` nor holds a part that does",
                            p.id
                        ),
                    );
                }
                if a.nodes[ni].walk.is_none() {
                    r.error(
                        format!("{sp}/ref"),
                        rule::WALK_REQUIRED,
                        format!("`{id}` is a stop, so it needs a walk"),
                    );
                }
            } else if let Some(&ei) = ix.edges.get(id) {
                if !carried.contains(id) {
                    r.error(
                        format!("{sp}/ref"),
                        rule::PURPOSE_STOP_NOT_MEMBER,
                        format!("`{}` doesn't carry `{id}`", p.id),
                    );
                }
                if a.edges[ei].walk.is_none() {
                    r.error(
                        format!("{sp}/ref"),
                        rule::WALK_REQUIRED,
                        format!("`{id}` is a stop, so it needs a walk"),
                    );
                }
            } else {
                r.error(
                    format!("{sp}/ref"),
                    rule::REF_UNKNOWN,
                    format!("`{id}` is no sub-purpose, node or edge"),
                );
            }
        }
        for (ri, rl) in p.rules.iter().flatten().enumerate() {
            if rl.sources.is_empty() {
                r.error(
                    format!("{pp}/rules/{ri}/sources"),
                    rule::CLAIMS_MISSING,
                    "a rule needs claims for where it's stated or established",
                );
            }
        }
    }
}

/// The code evidence behind a side, sites included.
fn side_code<'a>(ix: &Index<'a>, s: &'a Side) -> Vec<&'a Evidence> {
    s.claims
        .iter()
        .chain(s.sites.iter().flat_map(|x| x.claims.iter()))
        .flat_map(|c| ix.code_evidence(c))
        .collect()
}

fn conflicts(ix: &Index, r: &mut Report) {
    let a = ix.a;
    for (ci, c) in a.conflicts.iter().enumerate() {
        let p = format!("/conflicts/{ci}");
        if let Some(cause) = &c.cause
            && !ix.causes.contains(cause.as_str())
        {
            r.error(
                format!("{p}/cause"),
                rule::REF_UNKNOWN,
                format!("unknown cause `{cause}`"),
            );
        }
        if let Some(rl) = &c.rule
            && !ix.rules.contains_key(rl.as_str())
        {
            r.error(
                format!("{p}/rule"),
                rule::REF_UNKNOWN,
                format!("unknown rule `{rl}`"),
            );
        }
        for (k, list) in [
            ("purposes", &c.touches.purposes),
            ("nodes", &c.touches.nodes),
            ("edges", &c.touches.edges),
        ] {
            for (i, id) in list.iter().enumerate() {
                let known = match k {
                    "purposes" => ix.purposes.contains_key(id.as_str()),
                    "nodes" => ix.nodes.contains_key(id.as_str()),
                    _ => ix.edges.contains_key(id.as_str()),
                };
                if !known {
                    r.error(
                        format!("{p}/touches/{k}/{i}"),
                        rule::REF_UNKNOWN,
                        format!("unknown {} `{id}`", &k[..k.len() - 1]),
                    );
                }
            }
        }
        words(r, format!("{p}/question"), &c.question);
        for (name, s) in [("a", &c.a), ("b", &c.b)] {
            let sp = format!("{p}/{name}");
            if s.claims.is_empty() {
                r.error(
                    format!("{sp}/claims"),
                    rule::CLAIMS_MISSING,
                    "a side needs claims",
                );
            }
            match (&s.purpose, s.who) {
                (None, Who::Purpose) => r.error(
                    format!("{sp}/purpose"),
                    rule::CONFLICT_KIND_SIDES,
                    "a purpose's side names the purpose",
                ),
                (Some(id), _) if !ix.purposes.contains_key(id.as_str()) => r.error(
                    format!("{sp}/purpose"),
                    rule::REF_UNKNOWN,
                    format!("unknown purpose `{id}`"),
                ),
                _ => {}
            }
            if let Some(sites) = &s.sites
                && sites.claims.len() > MAX_SITES
            {
                r.error(
                    format!("{sp}/sites/claims"),
                    rule::CONFLICT_SITES,
                    format!(
                        "{} sites listed: list the first {MAX_SITES} and count the rest in `more`",
                        sites.claims.len()
                    ),
                );
            }
            // Every node the side's code evidence lands in, and its purpose, are touched.
            for ev in side_code(ix, s) {
                if let Evidence::Code { path, .. } = ev
                    && let Some(n) = ix.landing(path)
                    && !c.touches.nodes.iter().any(|t| t == &n.id)
                {
                    r.error(
                                format!("{p}/touches/nodes"),
                                rule::CONFLICT_TOUCHES,
                                format!("side {name}'s evidence lands in `{}` (`{path}`), which `touches.nodes` doesn't list", n.id),
                            );
                }
            }
            if let Some(pid) = &s.purpose
                && !c.touches.purposes.contains(pid)
            {
                r.error(
                    format!("{p}/touches/purposes"),
                    rule::CONFLICT_TOUCHES,
                    format!("side {name}'s purpose `{pid}` isn't in `touches.purposes`"),
                );
            }
        }
        let whos = [c.a.who, c.b.who];
        let has = |w: Who| whos.contains(&w);
        let bad = match c.kind {
            ConflictKind::StatedCode => {
                let stated = whos
                    .iter()
                    .filter(|w| matches!(w, Who::Description | Who::Issue))
                    .count();
                (stated != 1 || !has(Who::Code))
                    .then(|| "a stated-code conflict has one side from the description or an issue and one from the code".to_owned())
            }
            ConflictKind::PurposePurpose => (c.a.who != Who::Purpose
                || c.b.who != Who::Purpose
                || c.a.purpose.is_none()
                || c.a.purpose == c.b.purpose)
                .then(|| {
                    "a purpose-purpose conflict has two sides from two different purposes"
                        .to_owned()
                }),
            ConflictKind::PurposeOutside => {
                if c.rule.is_none() {
                    Some("a purpose-outside conflict names the rule it breaks".to_owned())
                } else if !(has(Who::Purpose) && has(Who::Outside)) {
                    Some(
                        "a purpose-outside conflict has a purpose's side and an outside side"
                            .to_owned(),
                    )
                } else {
                    let outside = if c.a.who == Who::Outside { &c.a } else { &c.b };
                    let code = side_code(ix, outside);
                    let changed: Vec<String> = code
                        .iter()
                        .filter_map(|ev| match ev {
                            Evidence::Code { path, .. } => ix.landing(path),
                            _ => None,
                        })
                        .filter(|n| Index::changed(n))
                        .map(|n| format!("`{}`", n.id))
                        .collect();
                    if code.is_empty() {
                        Some(
                            "the outside side needs code evidence of where the rule breaks"
                                .to_owned(),
                        )
                    } else if !changed.is_empty() {
                        Some(format!(
                            "the outside side lands in changed {}: a break inside the diff is a stated-code or purpose-purpose conflict",
                            changed.join(", ")
                        ))
                    } else {
                        None
                    }
                }
            }
        };
        if let Some(msg) = bad {
            r.error(format!("{p}/kind"), rule::CONFLICT_KIND_SIDES, msg);
        }
        if c.rule.is_some() && c.kind != ConflictKind::PurposeOutside {
            r.error(
                format!("{p}/rule"),
                rule::CONFLICT_KIND_SIDES,
                "only a purpose-outside conflict names a rule",
            );
        }
    }
}

fn causes(ix: &Index, r: &mut Report) {
    let a = ix.a;
    for (i, c) in a.causes.iter().enumerate() {
        words(r, format!("/causes/{i}/text"), &c.text);
        let shown = c.claims.iter().any(|id| {
            ix.claims
                .get(id.as_str())
                .is_some_and(|&ci| a.claims[ci].status == ClaimStatus::Supported)
                && !ix.code_evidence(id).is_empty()
        });
        if !shown {
            r.error(
                format!("/causes/{i}/claims"),
                rule::CAUSE_EVIDENCE,
                format!("cause `{}` needs a supported claim with code evidence: write a cause only when the code shows it", c.id),
            );
        }
    }
}

fn unclaimed(ix: &Index, r: &mut Report) {
    let a = ix.a;
    let listed: HashSet<&str> = a.unclaimed.iter().map(|u| u.node.as_str()).collect();
    for (i, u) in a.unclaimed.iter().enumerate() {
        if ix.node(&u.node).is_none() {
            r.error(
                format!("/unclaimed/{i}/node"),
                rule::REF_UNKNOWN,
                format!("unknown node `{}`", u.node),
            );
        }
    }
    let served: Vec<&str> = a
        .purposes
        .iter()
        .flat_map(|p| p.serves.iter().map(|s| s.node.as_str()))
        .collect();
    for (i, n) in a.nodes.iter().enumerate() {
        if !Index::is_part(n) || !Index::changed(n) || ix.has_children(&n.id) {
            continue;
        }
        let serves = served.iter().any(|s| ix.within(&n.id, s));
        if !serves && !listed.contains(n.id.as_str()) {
            r.error(
                format!("/nodes/{i}"),
                rule::UNCLAIMED_MISSING,
                format!(
                    "changed part `{}` serves no purpose and isn't in `unclaimed`",
                    n.id
                ),
            );
        }
    }
    match (a.purposes.is_empty(), &a.unbacked) {
        (true, None) => r.error(
            "/unbacked",
            rule::UNBACKED_EXACT,
            "with no purposes, `unbacked` says in one or two sentences why none could be backed",
        ),
        (false, Some(_)) => r.error(
            "/unbacked",
            rule::UNBACKED_EXACT,
            "`unbacked` is only for an analysis with no purposes",
        ),
        (true, Some(text)) if text.trim().is_empty() => r.error(
            "/unbacked",
            rule::UNBACKED_EXACT,
            "`unbacked` is empty: say in one or two sentences why no purpose could be backed",
        ),
        _ => {}
    }
}
