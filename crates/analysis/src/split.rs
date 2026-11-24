//! The split check (`check-split`): the skeleton's `split.json` against the skeleton analysis and
//! the run's changed files.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::migrate;
use crate::reader::under;
use crate::report::{Report, rule};
use crate::tools::Split;
use crate::validate::parse;

/// A top-level part of the skeleton: its ID and paths.
struct Part {
    id: String,
    paths: Vec<String>,
}

fn top_level_parts(skeleton: &Value) -> (Vec<Part>, HashSet<String>) {
    let nodes: Vec<&Value> = skeleton
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let str_of = |n: &Value, k: &str| n.get(k).and_then(Value::as_str).map(str::to_owned);
    let system: Option<String> = nodes
        .iter()
        .find(|n| n.get("kind").and_then(Value::as_str) == Some("system"))
        .and_then(|n| str_of(n, "id"));
    let mut parts = Vec::new();
    let mut all = HashSet::new();
    for n in nodes {
        let Some(id) = str_of(n, "id") else { continue };
        all.insert(id.clone());
        let kind = n.get("kind").and_then(Value::as_str).unwrap_or("");
        let top = system.is_some() && str_of(n, "parent") == system;
        if top && matches!(kind, "service" | "app" | "library" | "module") {
            let paths = n
                .get("paths")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect();
            parts.push(Part { id, paths });
        }
    }
    (parts, all)
}

/// Checks `split.json` against the skeleton analysis and, when given, the run's changed files.
/// Pointers in the report are into `split.json`.
pub fn check_split(skeleton: &Value, split: &Value, changed_files: Option<&[String]>) -> Report {
    let mut r = Report::default();
    let skeleton = match migrate::migrate_value(skeleton.clone()) {
        Ok(m) => m.value,
        Err(e) => {
            r.error("", rule::VERSION_UNKNOWN, format!("the skeleton: {e}"));
            return r;
        }
    };
    let Some(s) = parse::<Split>(split, "", &mut r) else {
        return r;
    };
    let (parts, all_nodes) = top_level_parts(&skeleton);
    let part_ids: HashSet<&str> = parts.iter().map(|p| p.id.as_str()).collect();

    let mut area_ids = HashSet::new();
    for (i, a) in s.areas.iter().enumerate() {
        let p = format!("/areas/{i}");
        if !area_ids.insert(a.id.as_str()) {
            r.error(
                format!("{p}/id"),
                rule::ID_DUPLICATE,
                format!("area `{}` appears twice", a.id),
            );
        }
        if !a.prefixes.iter().any(|x| x.trim_end_matches('/') == a.id) {
            r.error(
                format!("{p}/id"),
                rule::SPLIT_ID,
                format!("area `{}` isn't named after its paths: use one of its prefixes, without the trailing slash", a.id),
            );
        }
        if a.system && !a.owns.is_empty() {
            r.error(
                format!("{p}/owns"),
                rule::SPLIT_SYSTEM_AREA,
                format!("system area `{}` owns changed files: a system area covers unchanged parts only", a.id),
            );
        }
        for (fi, f) in a.owns.iter().enumerate() {
            if !a.prefixes.iter().any(|x| under(f, x)) {
                r.error(
                    format!("{p}/owns/{fi}"),
                    rule::SPLIT_FILE_AREA,
                    format!("`{f}` isn't under any of `{}`'s prefixes", a.id),
                );
            }
        }
        for (ri, id) in a.reads.iter().enumerate() {
            if !part_ids.contains(id.as_str()) {
                r.error(
                    format!("{p}/reads/{ri}"),
                    rule::REF_UNKNOWN,
                    format!("`{id}` isn't a top-level part of the skeleton"),
                );
            }
        }
        for (j, b) in s.areas.iter().enumerate().skip(i + 1) {
            for x in &a.prefixes {
                for y in &b.prefixes {
                    if under(x, y) || under(y, x) {
                        r.error(
                            format!("{p}/prefixes"),
                            rule::SPLIT_OVERLAP,
                            format!(
                                "`{}` ({x}) and `{}` ({y}) overlap (areas/{j}): areas are disjoint",
                                a.id, b.id
                            ),
                        );
                    }
                }
            }
        }
    }

    // Every changed file in exactly one area.
    let mut owner: HashMap<&str, Vec<&str>> = HashMap::new();
    for a in &s.areas {
        for f in &a.owns {
            owner.entry(f.as_str()).or_default().push(a.id.as_str());
        }
    }
    if let Some(files) = changed_files {
        let set: HashSet<&str> = files.iter().map(String::as_str).collect();
        for f in files {
            match owner.get(f.as_str()).map(Vec::len).unwrap_or(0) {
                1 => {}
                0 => r.error(
                    "/areas",
                    rule::SPLIT_FILE_AREA,
                    format!("changed file `{f}` is in no area's `owns`"),
                ),
                _ => r.error(
                    "/areas",
                    rule::SPLIT_FILE_AREA,
                    format!(
                        "changed file `{f}` is owned by {}",
                        owner[f.as_str()].join(", ")
                    ),
                ),
            }
        }
        for (i, a) in s.areas.iter().enumerate() {
            for (fi, f) in a.owns.iter().enumerate() {
                if !set.contains(f.as_str()) {
                    r.error(
                        format!("/areas/{i}/owns/{fi}"),
                        rule::SPLIT_FILE_AREA,
                        format!("`{f}` isn't a changed file of the PR"),
                    );
                }
            }
        }
    } else {
        for (f, areas) in &owner {
            if areas.len() > 1 {
                r.error(
                    "/areas",
                    rule::SPLIT_FILE_AREA,
                    format!("`{f}` is owned by {}", areas.join(", ")),
                );
            }
        }
    }

    // Every top-level part in exactly one area, by its paths.
    for part in &parts {
        let holders: Vec<&str> = s
            .areas
            .iter()
            .filter(|a| {
                part.paths
                    .iter()
                    .any(|pp| a.prefixes.iter().any(|x| under(pp, x)))
            })
            .map(|a| a.id.as_str())
            .collect();
        let whole = s.areas.iter().any(|a| {
            !part.paths.is_empty()
                && part
                    .paths
                    .iter()
                    .all(|pp| a.prefixes.iter().any(|x| under(pp, x)))
        });
        if holders.len() != 1 || !whole {
            r.error(
                "/areas",
                rule::SPLIT_PART_AREA,
                if holders.is_empty() {
                    format!("top-level part `{}` is in no area: put it in a changed area or a system area", part.id)
                } else {
                    format!("top-level part `{}` is split across {}: each part lies whole in one area", part.id, holders.join(", "))
                },
            );
        }
    }

    // References within the plan.
    for (i, c) in s.candidates.iter().enumerate() {
        for (k, id) in [("from", &c.from), ("to", &c.to)] {
            if !all_nodes.contains(id) {
                r.error(
                    format!("/candidates/{i}/{k}"),
                    rule::REF_UNKNOWN,
                    format!("`{id}` isn't a node of the skeleton"),
                );
            }
        }
    }
    let purposes: HashMap<&str, Option<&str>> = s
        .purposes
        .iter()
        .map(|p| (p.id.as_str(), p.parent.as_deref()))
        .collect();
    for (i, p) in s.purposes.iter().enumerate() {
        if let Some(parent) = &p.parent {
            match purposes.get(parent.as_str()) {
                None => r.error(
                    format!("/purposes/{i}/parent"),
                    rule::REF_UNKNOWN,
                    format!("unknown purpose `{parent}`"),
                ),
                Some(Some(_)) => r.error(
                    format!("/purposes/{i}/parent"),
                    rule::PURPOSE_DEPTH,
                    format!("`{}` sits under a sub-purpose: two levels at most", p.id),
                ),
                Some(None) => {}
            }
        }
        for (j, id) in p.flow.path.iter().enumerate() {
            if !all_nodes.contains(id) {
                r.error(
                    format!("/purposes/{i}/flow/path/{j}"),
                    rule::REF_UNKNOWN,
                    format!("`{id}` isn't a node of the skeleton"),
                );
            }
        }
    }
    for (i, rl) in s.rules.iter().enumerate() {
        if !purposes.contains_key(rl.purpose.as_str()) {
            r.error(
                format!("/rules/{i}/purpose"),
                rule::REF_UNKNOWN,
                format!("unknown purpose `{}`", rl.purpose),
            );
        }
    }
    r
}
