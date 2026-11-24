//! The merge: joins the skeleton's and the areas' fragments into one analysis, with the seam
//! pass's work left on it as `hints`; and `finish`, which strips the hints the seam pass
//! resolved.
//!
//! Fragments are partial analyses, so the merge works on JSON values and only reads the fields
//! it joins by. The first fragment is the skeleton; each later one is an area. The node a fragment
//! writes belongs to its area. An area may rewrite what the skeleton drew coarsely (a top-level
//! part it owns): its version replaces the skeleton's. Two areas writing the same element is
//! `merge.duplicate`, and the later one's version stays.
//!
//! An area can't create a purpose or a rule: one it writes that neither the skeleton nor
//! `split.json` settled becomes a `purpose` or `rule` hint instead. Given `split.json`, every
//! candidate no fragment drew or rejected becomes an unresolved `candidate` hint.
//!
//! Malformed fragments never make it panic: whatever doesn't have the shape it joins by is
//! reported or passed through for the validator.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::migrate::{self, VERSION};
use crate::report::{Report, rule};
use crate::tools::{Hint, Split};
use crate::validate::hints::{Known, describe, resolution, resolution_problem};
use crate::validate::parse;

/// The merge's result: the merged analysis (with `hints` when the seam pass has work) and what
/// the merge found.
#[derive(Debug, Clone)]
pub struct Merged {
    pub analysis: Value,
    pub report: Report,
}

/// The top-level lists joined element by element, by ID.
const BY_ID: &[&str] = &[
    "nodes",
    "edges",
    "boundaries",
    "scenarios",
    "facets",
    "conflicts",
    "causes",
];
/// The top-level values the first fragment that has one settles.
const FIRST: &[&str] = &["pr", "walk", "unbacked"];

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn array<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a Value> {
    v.get(k).and_then(Value::as_array).into_iter().flatten()
}

/// Renames every claim reference in a fragment: each `claims` list of IDs anywhere, and a rule's
/// `sources`.
fn rename_refs(v: &mut Value, map: &HashMap<String, String>, missing: &mut Vec<String>, top: bool) {
    match v {
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                let is_ref_list = (k == "claims" && !top) || k == "sources";
                match x {
                    Value::Array(items) if is_ref_list && items.iter().all(Value::is_string) => {
                        for it in items.iter_mut() {
                            let old = it.as_str().unwrap_or_default().to_owned();
                            match map.get(&old) {
                                Some(new) => *it = Value::from(new.clone()),
                                None => {
                                    missing.push(old.clone());
                                    *it = Value::from(format!("unknown:{old}"));
                                }
                            }
                        }
                    }
                    _ => rename_refs(x, map, missing, false),
                }
            }
        }
        Value::Array(items) => {
            for it in items {
                rename_refs(it, map, missing, false);
            }
        }
        _ => {}
    }
}

/// The parent of every node, for ancestry.
struct Tree(HashMap<String, String>);

impl Tree {
    fn of(nodes: &[Value]) -> Self {
        Tree(
            nodes
                .iter()
                .filter_map(|n| {
                    Some((str_of(n, "id")?.to_owned(), str_of(n, "parent")?.to_owned()))
                })
                .collect(),
        )
    }

    /// Whether `inner` is `outer` or lies inside it.
    fn within(&self, inner: &str, outer: &str) -> bool {
        let mut cur = inner;
        for _ in 0..=self.0.len() {
            if cur == outer {
                return true;
            }
            match self.0.get(cur) {
                Some(p) => cur = p,
                None => return false,
            }
        }
        false
    }
}

/// What makes two lines the same interaction: kind, when, and the responsibility used (a call)
/// or the data that crosses (data and events).
fn interaction(e: &Value) -> (String, String, String) {
    let kind = str_of(e, "kind").unwrap_or_default().to_owned();
    let what = if kind == "call" {
        str_of(e, "uses").unwrap_or_default().to_owned()
    } else {
        e.get("data")
            .and_then(|d| str_of(d, "what"))
            .unwrap_or_default()
            .trim()
            .to_lowercase()
    };
    (kind, str_of(e, "when").unwrap_or_default().to_owned(), what)
}

/// Joins fragments in the order given: the skeleton first, then the areas. Given `split.json`,
/// its candidates no fragment resolved become `candidate` hints, and its purposes and rules count
/// as settled.
pub fn merge(fragments: Vec<Value>, split: Option<&Value>) -> Merged {
    let mut r = Report::default();
    let split: Option<Split> = split.and_then(|v| {
        let mut sr = Report::default();
        let s = parse::<Split>(v, "", &mut sr);
        for e in sr.errors {
            r.error(
                e.path,
                &e.rule,
                format!("split.json (the pointer is into it): {}", e.message),
            );
        }
        s
    });
    let mut out = Map::new();
    out.insert("version".into(), Value::from(VERSION));
    let mut lists: HashMap<&str, Vec<Value>> = HashMap::new();
    let mut index: HashMap<(&str, String), usize> = HashMap::new();
    // Which fragment wrote each element now in `lists`.
    let mut writer: HashMap<(&str, String), usize> = HashMap::new();
    // Node ID → the fragment that wrote it; edge ID → the fragment that wrote it.
    let mut node_area: HashMap<String, usize> = HashMap::new();
    let mut edge_area: HashMap<String, usize> = HashMap::new();
    let mut purposes: Vec<Map<String, Value>> = Vec::new();
    let mut claims: Vec<Value> = Vec::new();
    let mut unclaimed: Vec<Value> = Vec::new();
    let mut carried: Vec<Value> = Vec::new();
    let mut coverage: Option<Map<String, Value>> = None;
    // Each hint with its fragment and the pointer to what it came from in that fragment.
    let mut hints: Vec<(usize, String, Value)> = Vec::new();
    // The purposes and rules (by purpose) the skeleton and split.json settled.
    let mut settled_purposes: HashSet<String> = HashSet::new();
    let mut settled_rules: HashSet<(String, String)> = HashSet::new();
    for p in split.iter().flat_map(|s| &s.purposes) {
        settled_purposes.insert(p.id.clone());
    }
    for rl in split.iter().flat_map(|s| &s.rules) {
        settled_rules.insert((rl.purpose.clone(), rl.id.clone()));
    }

    for (fi, frag) in fragments.into_iter().enumerate() {
        let fp = format!("/{fi}");
        if !frag.is_object() {
            r.error(
                &fp,
                rule::SHAPE_TYPE,
                format!("fragment {} isn't a JSON object", fi + 1),
            );
            continue;
        }
        if frag.get("version").is_none() {
            r.error(
                format!("{fp}/version"),
                rule::SHAPE_MISSING_FIELD,
                format!(
                    "fragment {} has no `version`, so it's left out: every fragment, the skeleton included, carries the `version` its schema.ts was generated for ({VERSION})",
                    fi + 1
                ),
            );
            continue;
        }
        let mut frag = match migrate::migrate_value(frag) {
            Ok(m) => m.value,
            Err(e) => {
                let id = match e {
                    migrate::MigrateError::Step { .. } => rule::MIGRATION_FAILED,
                    _ => rule::VERSION_UNKNOWN,
                };
                r.error(
                    format!("{fp}/version"),
                    id,
                    format!("fragment {}, left out: {e}", fi + 1),
                );
                continue;
            }
        };
        // Renumber its claims after the ones already merged.
        let mut map = HashMap::new();
        let mut dup_claims = Vec::new();
        for (ci, c) in array(&frag, "claims").enumerate() {
            if let Some(id) = str_of(c, "id") {
                if map.contains_key(id) {
                    r.error(
                        format!("{fp}/claims/{ci}/id"),
                        rule::MERGE_DUPLICATE_CLAIM,
                        format!(
                            "fragment {} holds claim `{id}` twice: claim IDs are unique within a fragment, and only the first is kept",
                            fi + 1
                        ),
                    );
                    dup_claims.push(ci);
                } else {
                    map.insert(id.to_owned(), format!("c{}", claims.len() + map.len() + 1));
                }
            }
        }
        let mut missing = Vec::new();
        rename_refs(&mut frag, &map, &mut missing, true);
        missing.sort();
        missing.dedup();
        for m in missing {
            r.error(
                &fp,
                rule::REF_UNKNOWN,
                format!(
                    "fragment {} names claim `{m}`, which it doesn't hold",
                    fi + 1
                ),
            );
        }
        // Checked to be an object above.
        let Some(obj) = frag.as_object_mut() else {
            continue;
        };
        // A list that isn't one would otherwise vanish from the merge unreported.
        for key in BY_ID
            .iter()
            .chain(&["purposes", "unclaimed", "carried", "claims", "hints"])
        {
            if let Some(v) = obj.get(*key)
                && !v.is_array()
                && !v.is_null()
            {
                r.error(
                    format!("{fp}/{key}"),
                    rule::SHAPE_TYPE,
                    format!(
                        "fragment {}'s `{key}` isn't a list, so it's left out of the merge",
                        fi + 1
                    ),
                );
            }
        }
        for (ci, mut c) in obj
            .remove("claims")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            if dup_claims.contains(&ci) {
                continue;
            }
            let new = str_of(&c, "id").and_then(|id| map.get(id)).cloned();
            if let (Some(new), Some(o)) = (new, c.as_object_mut()) {
                o.insert("id".into(), Value::from(new));
            }
            claims.push(c);
        }
        for k in FIRST {
            if let Some(v) = obj.remove(*k)
                && !v.is_null()
            {
                out.entry(*k).or_insert(v);
            }
        }
        if let Some(Value::Object(c)) = obj.remove("coverage") {
            match &mut coverage {
                None => coverage = Some(c),
                Some(have) => {
                    for (k, v) in c {
                        match (have.get_mut(&k), v) {
                            (Some(Value::Array(a)), Value::Array(b)) => {
                                for x in b {
                                    if !a.contains(&x) {
                                        a.push(x);
                                    }
                                }
                            }
                            (None, v) => {
                                have.insert(k, v);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        for key in BY_ID {
            for (ii, item) in obj
                .remove(*key)
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .enumerate()
            {
                let Some(id) = str_of(&item, "id").map(str::to_owned) else {
                    lists.entry(key).or_default().push(item);
                    continue;
                };
                if *key == "nodes" {
                    node_area.insert(id.clone(), fi);
                }
                if *key == "edges" {
                    edge_area.insert(id.clone(), fi);
                }
                let list = lists.entry(key).or_default();
                match index.get(&(*key, id.clone())) {
                    Some(&at) => {
                        let before = writer.insert((*key, id.clone()), fi).unwrap_or(0);
                        if before != 0 && list[at] != item {
                            r.warn(
                                format!("{fp}/{key}/{ii}"),
                                rule::MERGE_DUPLICATE,
                                format!(
                                    "`{id}` is written by fragments {} and {}: two areas own it, and fragment {}'s version stays",
                                    before + 1,
                                    fi + 1,
                                    fi + 1
                                ),
                            );
                        }
                        list[at] = item;
                    }
                    None => {
                        writer.insert((*key, id.clone()), fi);
                        index.insert((*key, id), list.len());
                        list.push(item);
                    }
                }
            }
        }
        for (pi, p) in obj
            .remove("purposes")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let pp = format!("{fp}/purposes/{pi}");
            let Value::Object(mut p) = p else {
                r.error(
                    &pp,
                    rule::SHAPE_TYPE,
                    format!(
                        "fragment {}'s purpose isn't a JSON object, so it's left out",
                        fi + 1
                    ),
                );
                continue;
            };
            let pid = p.get("id").and_then(Value::as_str).map(str::to_owned);
            if fi == 0 {
                // The skeleton settles its purposes and their rules.
                if let Some(pid) = &pid {
                    settled_purposes.insert(pid.clone());
                    for rl in p
                        .get("rules")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let Some(rid) = str_of(rl, "id") {
                            settled_rules.insert((pid.clone(), rid.to_owned()));
                        }
                    }
                }
            } else {
                let Some(pid) = pid.filter(|id| settled_purposes.contains(id)) else {
                    hints.push((fi, pp, purpose_hint(fi, &p)));
                    continue;
                };
                if let Some(Value::Array(rules)) = p.get_mut("rules") {
                    let mut ri = 0;
                    rules.retain(|rl| {
                        let at = format!("{pp}/rules/{ri}");
                        ri += 1;
                        let known = str_of(rl, "id").is_some_and(|rid| {
                            settled_rules.contains(&(pid.clone(), rid.to_owned()))
                        });
                        if !known {
                            hints.push((fi, at, rule_hint(&pid, rl)));
                        }
                        known
                    });
                }
            }
            let id = p.get("id").cloned();
            match purposes.iter_mut().find(|x| x.get("id") == id.as_ref()) {
                None => purposes.push(p),
                Some(have) => merge_purpose(have, p),
            }
        }
        for (key, into, by) in [
            ("unclaimed", &mut unclaimed, "node"),
            ("carried", &mut carried, "was"),
        ] {
            for item in obj
                .remove(key)
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
            {
                let k = item.get(by).cloned();
                match into.iter_mut().find(|x| x.get(by) == k.as_ref()) {
                    Some(have) => *have = item,
                    None => into.push(item),
                }
            }
        }
        for (hi, h) in obj
            .remove("hints")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            hints.push((fi, format!("{fp}/hints/{hi}"), h));
        }
    }

    let nodes = lists.remove("nodes").unwrap_or_default();
    let mut edges = lists.remove("edges").unwrap_or_default();
    let tree = Tree::of(&nodes);

    // Drop the coarse lines a deeper line of the same interaction replaced, and point what named
    // them at the line that replaced them.
    let mut replaced: HashMap<String, String> = HashMap::new();
    for e in &edges {
        let (Some(id), Some(from), Some(to)) =
            (str_of(e, "id"), str_of(e, "from"), str_of(e, "to"))
        else {
            continue;
        };
        let finer = edges.iter().find(|m| {
            let (Some(mid), Some(mf), Some(mt)) =
                (str_of(m, "id"), str_of(m, "from"), str_of(m, "to"))
            else {
                return false;
            };
            mid != id
                && (mf, mt) != (from, to)
                && tree.within(mf, from)
                && tree.within(mt, to)
                && interaction(m) == interaction(e)
        });
        if let Some(m) = finer.and_then(|m| str_of(m, "id")) {
            replaced.insert(id.to_owned(), m.to_owned());
        }
    }
    let mut dropped_claims: HashSet<String> = HashSet::new();
    edges.retain(|e| {
        let gone = str_of(e, "id").is_some_and(|id| replaced.contains_key(id));
        if gone {
            dropped_claims.extend(array(e, "claims").filter_map(|c| c.as_str().map(str::to_owned)));
        }
        !gone
    });

    let mut merged = Value::Object(out);
    merged["coverage"] = coverage.map(Value::Object).unwrap_or(Value::Null);
    if merged["coverage"].is_null() {
        merged.as_object_mut().map(|o| o.remove("coverage"));
    }
    merged["nodes"] = Value::Array(nodes);
    merged["edges"] = Value::Array(edges);
    for key in BY_ID.iter().filter(|k| !matches!(**k, "nodes" | "edges")) {
        merged[*key] = Value::Array(lists.remove(key).unwrap_or_default());
    }
    merged["purposes"] = Value::Array(purposes.into_iter().map(Value::Object).collect());
    merged["unclaimed"] = Value::Array(unclaimed);
    merged["carried"] = Value::Array(carried);
    merged["claims"] = Value::Array(claims);
    retarget(&mut merged, &replaced);
    // Claims only the dropped lines held go with them.
    let still: HashSet<String> = {
        let mut s = HashSet::new();
        collect_refs(&merged, &mut s, true);
        s
    };
    if let Some(cs) = merged["claims"].as_array_mut() {
        cs.retain(|c| {
            str_of(c, "id").is_none_or(|id| !dropped_claims.contains(id) || still.contains(id))
        });
    }

    // The seam pass's work.
    let known = Known::of(&merged);
    let mut work: Vec<Value> = Vec::new();
    let edges_now: Vec<Value> = merged["edges"].as_array().cloned().unwrap_or_default();
    // The candidates a fragment's hint covers: resolved, or left for the seam pass already.
    let mut covered: HashSet<(String, String)> = HashSet::new();
    for (_, hp, raw) in hints {
        let Some(h) = parse::<Hint>(&raw, &hp, &mut r) else {
            continue;
        };
        if let Hint::Candidate { from, to, .. } = &h {
            covered.insert((from.clone(), to.clone()));
        }
        match &h {
            Hint::Seam {
                from,
                to,
                line_kind,
                uses,
                resolution: None,
                ..
            } => {
                let kind = serde_json::to_value(line_kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned));
                let matched = edges_now.iter().any(|m| {
                    str_of(m, "kind") == kind.as_deref()
                        && uses.as_deref().is_none_or(|u| str_of(m, "uses") == Some(u))
                        && str_of(m, "from").is_some_and(|f| tree.within(f, from))
                        && str_of(m, "to").is_some_and(|t| tree.within(t, to))
                });
                if !matched {
                    work.push(raw);
                }
            }
            Hint::Candidate {
                resolution: Some(res),
                ..
            } => {
                if let Some(problem) = resolution_problem(&h, res, &known) {
                    r.error(
                        &hp,
                        rule::HINT_UNRESOLVED,
                        format!("{}: {problem}", describe(&h)),
                    );
                    work.push(raw);
                }
            }
            _ => work.push(raw),
        }
    }
    // split.json's candidates no fragment drew or rejected.
    for c in split.iter().flat_map(|s| &s.candidates) {
        if !covered.contains(&(c.from.clone(), c.to.clone())) {
            work.push(json!({ "kind": "candidate", "from": c.from, "to": c.to }));
        }
    }
    // Lines from one area that end at a part with children in another.
    for e in &edges_now {
        let (Some(id), Some(to)) = (str_of(e, "id"), str_of(e, "to")) else {
            continue;
        };
        let area = edge_area.get(id).copied();
        let children: Vec<String> = merged["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| str_of(n, "parent") == Some(to))
            .filter_map(|n| str_of(n, "id"))
            .filter(|c| node_area.get(*c).copied() != area)
            .map(str::to_owned)
            .collect();
        if !children.is_empty() {
            work.push(json!({ "kind": "deepen", "line": id, "to": to, "children": children }));
        }
    }
    if !work.is_empty() {
        merged["hints"] = Value::Array(work);
    }
    Merged {
        analysis: merged,
        report: r,
    }
}

/// Joins a purpose written by several fragments: the first value of each field wins, and the
/// member lists join (`serves` by node, `carries` by edge, `stops` by ref, `rules` by ID).
fn merge_purpose(have: &mut Map<String, Value>, p: Map<String, Value>) {
    for (k, v) in p {
        let by = match k.as_str() {
            "serves" => Some("node"),
            "carries" => Some("edge"),
            "stops" => Some("ref"),
            "rules" => Some("id"),
            _ => None,
        };
        match (by, have.get_mut(&k), v) {
            (Some(by), Some(Value::Array(a)), Value::Array(b)) => {
                for x in b {
                    let key = x.get(by).cloned();
                    match a.iter_mut().find(|y| y.get(by) == key.as_ref()) {
                        Some(y) => *y = x,
                        None => a.push(x),
                    }
                }
            }
            (_, None, v) => {
                have.insert(k, v);
            }
            (_, Some(slot), v) if slot.is_null() => *slot = v,
            _ => {}
        }
    }
}

/// The elements of a list field, for editing; nothing when `v` isn't an object or the field
/// isn't a list.
fn items<'a>(v: &'a mut Value, k: &str) -> impl Iterator<Item = &'a mut Value> {
    v.get_mut(k)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

/// The `purpose` hint for a purpose an area wrote that neither the skeleton nor `split.json`
/// settled: its name, parent and serving parts, and every claim it holds.
fn purpose_hint(fi: usize, p: &Map<String, Value>) -> Value {
    let id = p.get("id").and_then(Value::as_str).unwrap_or("(no id)");
    let name = p.get("name").and_then(Value::as_str).unwrap_or(id);
    let serves: Vec<&Value> = p
        .get("serves")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let nodes: Vec<&str> = serves.iter().filter_map(|s| str_of(s, "node")).collect();
    // Every claim it holds, anywhere in it, in number order.
    let mut held = HashSet::new();
    collect_refs(&Value::Object(p.clone()), &mut held, false);
    let mut claims: Vec<String> = held.into_iter().collect();
    claims.sort_by(|a, b| (a.len(), a).cmp(&(b.len(), b)));
    let intro = p
        .get("walk")
        .and_then(|w| str_of(w, "intro"))
        .map(|t| format!(": {t}"))
        .unwrap_or_default();
    let mut h = json!({
        "kind": "purpose",
        "name": name,
        "nodes": nodes,
        "why": format!("fragment {} wrote purpose `{id}`, which the skeleton doesn't have; an area can't create a purpose{intro}", fi + 1),
        "claims": claims,
    });
    if let (Some(parent), Some(o)) = (p.get("parent").and_then(Value::as_str), h.as_object_mut()) {
        o.insert("parent".into(), Value::from(parent));
    }
    h
}

/// The `rule` hint for a rule an area wrote that neither the skeleton nor `split.json` settled.
fn rule_hint(purpose: &str, rl: &Value) -> Value {
    let id = str_of(rl, "id").unwrap_or("(no id)");
    json!({
        "kind": "rule",
        "purpose": purpose,
        "text": str_of(rl, "text").unwrap_or(id),
        "scope": str_of(rl, "scope").unwrap_or_default(),
        "claims": array(rl, "sources").filter_map(Value::as_str).collect::<Vec<_>>(),
    })
}

/// Points every reference to a replaced line at the line that replaced it.
fn retarget(v: &mut Value, replaced: &HashMap<String, String>) {
    if replaced.is_empty() {
        return;
    }
    let swap = |x: &mut Value| {
        if let Some(new) = x.as_str().and_then(|s| replaced.get(s)) {
            *x = Value::from(new.clone());
        }
    };
    for s in items(v, "scenarios") {
        for t in items(s, "steps") {
            if let Some(e) = t.get_mut("edge") {
                swap(e);
            }
        }
    }
    for p in items(v, "purposes") {
        for c in p
            .get_mut("carries")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(e) = c.get_mut("edge") {
                swap(e);
            }
        }
        for s in p
            .get_mut("stops")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(e) = s.get_mut("ref") {
                swap(e);
            }
        }
    }
    for c in items(v, "conflicts") {
        for e in c
            .pointer_mut("/touches/edges")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            swap(e);
        }
    }
}

fn collect_refs(v: &Value, out: &mut HashSet<String>, top: bool) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if top && k == "claims" {
                    continue;
                }
                if (k == "claims" || k == "sources")
                    && x.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                {
                    out.extend(
                        x.as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|s| s.as_str().map(str::to_owned)),
                    );
                } else {
                    collect_refs(x, out, false);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_refs(x, out, false)),
        _ => {}
    }
}

/// `merge --finish`: strips every hint the seam pass resolved, and keeps (and reports) the rest.
pub fn finish(mut merged: Value) -> Merged {
    let mut r = Report::default();
    let hints = merged.as_object_mut().and_then(|o| o.remove("hints"));
    let known = Known::of(&merged);
    let mut left = Vec::new();
    for (i, raw) in hints
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let p = format!("/hints/{i}");
        let Some(h) = parse::<Hint>(raw, &p, &mut r) else {
            left.push(raw.clone());
            continue;
        };
        let problem = match resolution(&h) {
            None => Some(
                "unresolved: draw it, deepen it, add or fold it, or reject it with a claim"
                    .to_owned(),
            ),
            Some(res) => resolution_problem(&h, res, &known),
        };
        if let Some(problem) = problem {
            r.error(
                &p,
                rule::HINT_UNRESOLVED,
                format!("{}: {problem}", describe(&h)),
            );
            left.push(raw.clone());
        }
    }
    if !left.is_empty() {
        merged["hints"] = Value::Array(left);
    }
    Merged {
        analysis: merged,
        report: r,
    }
}
