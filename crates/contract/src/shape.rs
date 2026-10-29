//! Shapes: the fields and types of a JSON answer, never its values. A recorded template holds
//! one, and every answer is checked against it.
//!
//! In a template file a shape is written as JSON:
//!
//! - a type name: `"string"`, `"number"`, `"boolean"`, `"null"`, `"any"` (not checked, set by
//!   hand: recording keeps it), or `"never"` (no value seen yet: the items of an array only ever
//!   seen empty, a field only ever seen null; not checked, and the next recording that sees a
//!   value fills it in);
//! - an object, by its fields: `{"title": "string", "milestone?": …}`. A `?` marks a field that
//!   may be left out;
//! - an array, by its items: `{"[]": …}`;
//! - a choice of kinds, as a list: `["null", {"number": "number"}]`, at most one of each kind.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Any,
    Never,
    Null,
    Boolean,
    Number,
    String,
    Array(Box<Shape>),
    Object(BTreeMap<String, Field>),
    /// Two or more of the above, each of its own kind.
    OneOf(Vec<Shape>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub shape: Shape,
    /// The field may be left out.
    pub optional: bool,
}

/// What a value is, as a shape names it.
pub fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// How an answer differs from its shape, at a path such as `$.labels[].name`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Difference {
    /// The shape has the field and the answer doesn't.
    Missing { path: String },
    /// The answer has the field with another kind.
    Retyped {
        path: String,
        expected: String,
        got: String,
    },
    /// The answer has a field the shape doesn't.
    Extra { path: String, got: String },
}

impl Difference {
    pub fn path(&self) -> &str {
        match self {
            Difference::Missing { path }
            | Difference::Retyped { path, .. }
            | Difference::Extra { path, .. } => path,
        }
    }
}

impl std::fmt::Display for Difference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Difference::Missing { path } => write!(f, "`{path}` is missing"),
            Difference::Retyped {
                path,
                expected,
                got,
            } => write!(f, "`{path}` is {got}, recorded as {expected}"),
            Difference::Extra { path, got } => {
                write!(f, "`{path}` ({got}) isn't in the template")
            }
        }
    }
}

impl Shape {
    /// The kind this shape takes, for choosing among a [`Shape::OneOf`]'s.
    fn kind(&self) -> &'static str {
        match self {
            Shape::Any => "any",
            Shape::Never => "never",
            Shape::Null => "null",
            Shape::Boolean => "boolean",
            Shape::Number => "number",
            Shape::String => "string",
            Shape::Array(_) => "array",
            Shape::Object(_) => "object",
            Shape::OneOf(_) => "one of",
        }
    }

    /// The kinds it allows, as a reader would say them: `string or null`.
    pub fn describe(&self) -> String {
        match self {
            Shape::OneOf(alts) => alts
                .iter()
                .map(Shape::kind)
                .collect::<Vec<_>>()
                .join(" or "),
            s => s.kind().into(),
        }
    }

    /// The ways `v` differs from this shape, each path once, in order.
    pub fn check(&self, v: &Value) -> Vec<Difference> {
        let mut out = Vec::new();
        self.check_at("$", v, &mut out);
        out.sort();
        out.dedup();
        out
    }

    fn check_at(&self, path: &str, v: &Value, out: &mut Vec<Difference>) {
        let retyped = |out: &mut Vec<Difference>| {
            out.push(Difference::Retyped {
                path: path.to_owned(),
                expected: self.describe(),
                got: kind(v).into(),
            })
        };
        match (self, v) {
            (Shape::Any | Shape::Never, _) => {}
            (Shape::Null, Value::Null)
            | (Shape::Boolean, Value::Bool(_))
            | (Shape::Number, Value::Number(_))
            | (Shape::String, Value::String(_)) => {}
            (Shape::Array(item), Value::Array(items)) => {
                let at = format!("{path}[]");
                for i in items {
                    item.check_at(&at, i, out);
                }
            }
            (Shape::Object(fields), Value::Object(map)) => {
                for (name, f) in fields {
                    let at = format!("{path}.{name}");
                    match map.get(name) {
                        Some(x) => f.shape.check_at(&at, x, out),
                        None if f.optional => {}
                        None => out.push(Difference::Missing { path: at }),
                    }
                }
                for (name, x) in map {
                    if !fields.contains_key(name) {
                        out.push(Difference::Extra {
                            path: format!("{path}.{name}"),
                            got: kind(x).into(),
                        });
                    }
                }
            }
            (Shape::OneOf(alts), _) => {
                match alts
                    .iter()
                    .find(|a| matches!(a, Shape::Any) || a.kind() == kind(v))
                {
                    Some(a) => a.check_at(path, v, out),
                    None => retyped(out),
                }
            }
            _ => retyped(out),
        }
    }

    /// The shape of one value.
    pub fn of(v: &Value) -> Shape {
        match v {
            Value::Null => Shape::Null,
            Value::Bool(_) => Shape::Boolean,
            Value::Number(_) => Shape::Number,
            Value::String(_) => Shape::String,
            Value::Array(items) => Shape::Array(Box::new(
                items
                    .iter()
                    .map(Shape::of)
                    .reduce(Shape::merge)
                    .unwrap_or(Shape::Never),
            )),
            Value::Object(map) => Shape::Object(
                map.iter()
                    .map(|(k, x)| {
                        (
                            k.clone(),
                            Field {
                                shape: Shape::of(x),
                                optional: false,
                            },
                        )
                    })
                    .collect(),
            ),
        }
    }

    /// The shape both `self` and `other` fit: a field only one has may be left out, and two kinds
    /// at one path become a choice.
    pub fn merge(self, other: Shape) -> Shape {
        match (self, other) {
            (Shape::Any, _) | (_, Shape::Any) => Shape::Any,
            (Shape::Never, s) | (s, Shape::Never) => s,
            (Shape::Array(a), Shape::Array(b)) => Shape::Array(Box::new(a.merge(*b))),
            (Shape::Object(mut a), Shape::Object(b)) => {
                let mut out = BTreeMap::new();
                for (k, fb) in b {
                    let field = match a.remove(&k) {
                        Some(fa) => Field {
                            shape: fa.shape.merge(fb.shape),
                            optional: fa.optional || fb.optional,
                        },
                        None => Field {
                            shape: fb.shape,
                            optional: true,
                        },
                    };
                    out.insert(k, field);
                }
                for (k, fa) in a {
                    out.insert(
                        k,
                        Field {
                            shape: fa.shape,
                            optional: true,
                        },
                    );
                }
                Shape::Object(out)
            }
            (a, b) if !matches!(a, Shape::OneOf(_)) && a.kind() == b.kind() => a,
            (a, b) => {
                let mut alts = Vec::new();
                push_alt(&mut alts, a);
                push_alt(&mut alts, b);
                if alts.contains(&Shape::Any) {
                    return Shape::Any;
                }
                alts.sort_by_key(|s| order(s.kind()));
                match alts.len() {
                    0 => Shape::Never,
                    1 => alts.remove(0),
                    _ => Shape::OneOf(alts),
                }
            }
        }
    }

    /// Lets `null` wherever `old` let it and this shape doesn't: a template recorded again
    /// keeps the nulls GitHub documents, which one run's answers may not happen to show.
    pub fn keeping_nulls_of(self, old: &Shape) -> Shape {
        // Set to `any` by hand: kept so. And a field this recording saw no value of keeps
        // what an earlier one learned.
        if matches!(old, Shape::Any) || matches!(self, Shape::Never) {
            return old.clone();
        }
        let allows_null = |s: &Shape| {
            matches!(s, Shape::Null) || matches!(s, Shape::OneOf(a) if a.contains(&Shape::Null))
        };
        let mut new = match (self, old) {
            (Shape::Array(a), Shape::Array(o)) => Shape::Array(Box::new(a.keeping_nulls_of(o))),
            (Shape::Array(a), Shape::OneOf(alts)) => {
                let inner = alts.iter().find_map(|s| match s {
                    Shape::Array(o) => Some(o.as_ref()),
                    _ => None,
                });
                match inner {
                    Some(o) => Shape::Array(Box::new(a.keeping_nulls_of(o))),
                    None => Shape::Array(a),
                }
            }
            (Shape::Object(mut f), old) => {
                let old_fields = match old {
                    Shape::Object(o) => Some(o),
                    Shape::OneOf(alts) => alts.iter().find_map(|s| match s {
                        Shape::Object(o) => Some(o),
                        _ => None,
                    }),
                    _ => None,
                };
                if let Some(o) = old_fields {
                    for (k, field) in f.iter_mut() {
                        if let Some(of) = o.get(k) {
                            field.shape = std::mem::replace(&mut field.shape, Shape::Any)
                                .keeping_nulls_of(&of.shape);
                        }
                    }
                }
                Shape::Object(f)
            }
            (Shape::OneOf(alts), old) => alts
                .into_iter()
                .map(|a| match a {
                    Shape::Null => Shape::Null,
                    a => a.keeping_nulls_of(old),
                })
                .reduce(Shape::merge)
                .unwrap_or(Shape::Never),
            (s, _) => s,
        };
        if allows_null(old) && !allows_null(&new) && !matches!(new, Shape::Any | Shape::Never) {
            new = new.merge(Shape::Null);
        }
        new
    }

    /// The shape with `null` allowed at every field named in `names`, wherever it is.
    pub fn nullable(self, names: &[&str]) -> Shape {
        match self {
            Shape::Array(item) => Shape::Array(Box::new(item.nullable(names))),
            Shape::Object(fields) => Shape::Object(
                fields
                    .into_iter()
                    .map(|(k, f)| {
                        let mut shape = f.shape.nullable(names);
                        if names.contains(&k.as_str())
                            && !matches!(shape, Shape::Never | Shape::Any)
                        {
                            shape = shape.merge(Shape::Null);
                        }
                        (k, Field { shape, ..f })
                    })
                    .collect(),
            ),
            Shape::OneOf(alts) => alts
                .into_iter()
                .map(|a| a.nullable(names))
                .reduce(Shape::merge)
                .unwrap_or(Shape::Never),
            s => s,
        }
    }

    /// The shape with each field only ever seen as `null` taken as `never`: what kind its values
    /// are isn't known until a recording sees one, so only its presence is checked.
    pub fn null_fields_unknown(self) -> Shape {
        match self {
            Shape::Array(item) => Shape::Array(Box::new(item.null_fields_unknown())),
            Shape::Object(fields) => Shape::Object(
                fields
                    .into_iter()
                    .map(|(k, f)| {
                        let shape = match f.shape {
                            Shape::Null => Shape::Never,
                            s => s.null_fields_unknown(),
                        };
                        (k, Field { shape, ..f })
                    })
                    .collect(),
            ),
            Shape::OneOf(alts) => alts
                .into_iter()
                .map(Shape::null_fields_unknown)
                .reduce(Shape::merge)
                .unwrap_or(Shape::Never),
            s => s,
        }
    }

    /// The shape as a template file writes it.
    pub fn to_json(&self) -> Value {
        match self {
            Shape::OneOf(alts) => Value::Array(alts.iter().map(Shape::to_json).collect()),
            Shape::Array(item) => {
                let mut m = Map::new();
                m.insert("[]".into(), item.to_json());
                Value::Object(m)
            }
            Shape::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(k, f)| {
                        let key = if f.optional {
                            format!("{k}?")
                        } else {
                            k.clone()
                        };
                        (key, f.shape.to_json())
                    })
                    .collect(),
            ),
            s => Value::String(s.kind().into()),
        }
    }

    /// A shape as a template file writes it; why not, if it isn't one.
    pub fn from_json(v: &Value) -> Result<Shape, String> {
        Ok(match v {
            Value::String(t) => match t.as_str() {
                "any" => Shape::Any,
                "never" => Shape::Never,
                "null" => Shape::Null,
                "boolean" => Shape::Boolean,
                "number" => Shape::Number,
                "string" => Shape::String,
                other => return Err(format!("unknown type {other:?}")),
            },
            Value::Array(alts) => {
                let alts = alts
                    .iter()
                    .map(Shape::from_json)
                    .collect::<Result<Vec<_>, _>>()?;
                let mut kinds: Vec<_> = alts.iter().map(Shape::kind).collect();
                kinds.sort();
                kinds.dedup();
                if alts.len() < 2 || kinds.len() != alts.len() || kinds.contains(&"one of") {
                    return Err(
                        "a choice needs two or more kinds, each once, none itself a choice".into(),
                    );
                }
                Shape::OneOf(alts)
            }
            Value::Object(m) if m.len() == 1 && m.contains_key("[]") => {
                Shape::Array(Box::new(Shape::from_json(&m["[]"])?))
            }
            Value::Object(m) => Shape::Object(
                m.iter()
                    .map(|(k, x)| {
                        let (name, optional) = match k.strip_suffix('?') {
                            Some(n) => (n.to_owned(), true),
                            None => (k.clone(), false),
                        };
                        Ok((
                            name,
                            Field {
                                shape: Shape::from_json(x)?,
                                optional,
                            },
                        ))
                    })
                    .collect::<Result<_, String>>()?,
            ),
            other => return Err(format!("{other} isn't a shape")),
        })
    }
}

/// Adds `s` to a choice's kinds: merged into the one of its kind, if there is one.
fn push_alt(alts: &mut Vec<Shape>, s: Shape) {
    match s {
        Shape::OneOf(xs) => {
            for x in xs {
                push_alt(alts, x);
            }
        }
        Shape::Never => {}
        s => match alts.iter().position(|a| a.kind() == s.kind()) {
            Some(i) => {
                let a = alts.remove(i);
                alts.push(a.merge(s));
            }
            None => alts.push(s),
        },
    }
}

/// The order a choice lists its kinds in.
fn order(kind: &str) -> u8 {
    match kind {
        "object" => 0,
        "array" => 1,
        "string" => 2,
        "number" => 3,
        "boolean" => 4,
        _ => 5,
    }
}
