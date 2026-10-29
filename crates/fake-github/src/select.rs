//! GitHub answers a GraphQL query with exactly the fields it selects. The fake builds each
//! operation's answer whole, then cuts it down to the query's selection here, so it never
//! answers a field the query didn't ask for (the contract check holds it to that).

use graphql_parser::query::{Definition, OperationDefinition, Selection, SelectionSet};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// The fields a selection set asks for, by the key the answer carries (the alias, or the name),
/// each with its own selection (empty for a scalar).
#[derive(Debug, Default)]
pub(crate) struct Fields(BTreeMap<String, Fields>);

type Fragments<'a> = HashMap<&'a str, &'a SelectionSet<'a, &'a str>>;

/// The fields `query`'s operation selects, merging fragments and inline fragments whatever
/// their type condition; None when it doesn't parse.
pub(crate) fn selection(query: &str) -> Option<Fields> {
    let doc = graphql_parser::query::parse_query::<&str>(query).ok()?;
    let mut fragments: Fragments = HashMap::new();
    let mut operation = None;
    for d in &doc.definitions {
        match d {
            Definition::Fragment(f) => {
                fragments.insert(f.name, &f.selection_set);
            }
            Definition::Operation(op) if operation.is_none() => {
                operation = Some(match op {
                    OperationDefinition::Query(q) => &q.selection_set,
                    OperationDefinition::SelectionSet(s) => s,
                    OperationDefinition::Mutation(m) => &m.selection_set,
                    OperationDefinition::Subscription(s) => &s.selection_set,
                });
            }
            Definition::Operation(_) => {}
        }
    }
    let mut out = Fields::default();
    collect(operation?, &fragments, &mut out, 0);
    Some(out)
}

fn collect<'a>(
    set: &'a SelectionSet<'a, &'a str>,
    fragments: &Fragments<'a>,
    out: &mut Fields,
    depth: usize,
) {
    // A fragment that spreads itself would never end.
    if depth > 64 {
        return;
    }
    for s in &set.items {
        match s {
            Selection::Field(f) => {
                let key = f.alias.unwrap_or(f.name).to_owned();
                collect(
                    &f.selection_set,
                    fragments,
                    out.0.entry(key).or_default(),
                    depth + 1,
                );
            }
            Selection::FragmentSpread(spread) => {
                if let Some(set) = fragments.get(spread.fragment_name) {
                    collect(set, fragments, out, depth + 1);
                }
            }
            Selection::InlineFragment(i) => collect(&i.selection_set, fragments, out, depth + 1),
        }
    }
}

/// Cuts `v` down to `fields`: objects keep only the keys selected, lists each item so.
pub(crate) fn project(v: &mut Value, fields: &Fields) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| fields.0.contains_key(k));
            for (k, x) in m.iter_mut() {
                let sub = &fields.0[k];
                if !sub.0.is_empty() {
                    project(x, sub);
                }
            }
        }
        Value::Array(items) => {
            for x in items {
                project(x, fields);
            }
        }
        _ => {}
    }
}
