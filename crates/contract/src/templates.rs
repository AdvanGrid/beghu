//! Fake GitHub's recorded templates (`crates/fake-github/templates/`): one per request the fake
//! answers, holding the status and the shape GitHub's answer has, and per webhook event and
//! action, the shape of its payload. A template file is a JSON object of templates by name;
//! the name's first part names the file (`rest.issue` lives in `rest.json`).

use crate::shape::{Difference, Shape};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where the templates live in this repo.
pub fn default_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fake-github/templates")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    /// The request, with its path as a template: `GET /repos/{owner}/{repo}/issues/{number}`.
    pub request: String,
    /// The answer's status.
    pub status: u16,
    /// The answer's shape. For a list whose items differ by a field, the list's own shape is
    /// `any` and `items_by` holds the items'.
    pub shape: Shape,
    /// Values beghu relies on, by path (`$.message`): checked as values, not only as types.
    pub pins: BTreeMap<String, Value>,
    /// A list whose items differ by one field's value (the issue events feed, by `event`): that
    /// field, and each value's item shape. Items with a value not listed are left unchecked.
    pub items_by: Option<(String, BTreeMap<String, Shape>)>,
}

/// One way an answer differs from its template.
#[derive(Debug, Clone, PartialEq)]
pub enum Mismatch {
    Status {
        expected: u16,
        got: u16,
    },
    Shape(Difference),
    Pin {
        path: String,
        expected: Value,
        got: Value,
    },
}

impl std::fmt::Display for Mismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Mismatch::Status { expected, got } => {
                write!(f, "answered {got}, recorded as {expected}")
            }
            Mismatch::Shape(d) => d.fmt(f),
            Mismatch::Pin {
                path,
                expected,
                got,
            } => write!(f, "`{path}` is {got}, beghu relies on {expected}"),
        }
    }
}

impl Template {
    /// How an answer with `status` and `body` differs from this template. A status other than
    /// the recorded one says so and checks nothing more: the body is another kind of answer.
    pub fn check(&self, status: u16, body: &Value) -> Vec<Mismatch> {
        if status != self.status {
            return vec![Mismatch::Status {
                expected: self.status,
                got: status,
            }];
        }
        let mut out: Vec<Mismatch> = self
            .shape
            .check(body)
            .into_iter()
            .map(Mismatch::Shape)
            .collect();
        if let Some((field, variants)) = &self.items_by {
            for item in body.as_array().into_iter().flatten() {
                if let Some(shape) = item[field].as_str().and_then(|v| variants.get(v)) {
                    for d in shape.check(item) {
                        out.push(Mismatch::Shape(rebase(d, "$[]")));
                    }
                }
            }
            out.dedup();
        }
        for (path, expected) in &self.pins {
            let got = at(body, path);
            if &got != expected {
                out.push(Mismatch::Pin {
                    path: path.clone(),
                    expected: expected.clone(),
                    got,
                });
            }
        }
        out
    }

    fn to_json(&self) -> Value {
        let mut v = json!({
            "request": self.request,
            "status": self.status,
            "shape": self.shape.to_json(),
        });
        if !self.pins.is_empty() {
            v["pins"] = Value::Object(self.pins.clone().into_iter().collect());
        }
        if let Some((field, variants)) = &self.items_by {
            v["items_by"] = json!(field);
            v["variants"] = Value::Object(
                variants
                    .iter()
                    .map(|(k, s)| (k.clone(), s.to_json()))
                    .collect(),
            );
        }
        v
    }

    fn from_json(name: &str, v: &Value) -> Result<Template, String> {
        let bad = |why: &str| format!("template {name}: {why}");
        let request = v["request"]
            .as_str()
            .ok_or_else(|| bad("no request"))?
            .to_owned();
        let status = v["status"]
            .as_u64()
            .and_then(|s| u16::try_from(s).ok())
            .ok_or_else(|| bad("no status"))?;
        let shape = Shape::from_json(&v["shape"]).map_err(|e| bad(&e))?;
        let pins = match &v["pins"] {
            Value::Null => BTreeMap::new(),
            Value::Object(m) => m.clone().into_iter().collect(),
            _ => return Err(bad("pins must be an object")),
        };
        let items_by = match (&v["items_by"], &v["variants"]) {
            (Value::Null, _) => None,
            (Value::String(field), Value::Object(m)) => Some((
                field.clone(),
                m.iter()
                    .map(|(k, s)| Ok((k.clone(), Shape::from_json(s).map_err(|e| bad(&e))?)))
                    .collect::<Result<_, String>>()?,
            )),
            _ => return Err(bad("items_by needs variants")),
        };
        Ok(Template {
            request,
            status,
            shape,
            pins,
            items_by,
        })
    }
}

/// A difference found in a list's item, at the list's path.
fn rebase(d: Difference, prefix: &str) -> Difference {
    let re = |p: String| format!("{prefix}{}", p.strip_prefix('$').unwrap_or(&p));
    match d {
        Difference::Missing { path } => Difference::Missing { path: re(path) },
        Difference::Retyped {
            path,
            expected,
            got,
        } => Difference::Retyped {
            path: re(path),
            expected,
            got,
        },
        Difference::Extra { path, got } => Difference::Extra {
            path: re(path),
            got,
        },
    }
}

/// The value at `path` (`$.a.b`, `$.a[0]`), null when there's none.
pub fn at(v: &Value, path: &str) -> Value {
    let mut cur = v;
    for part in path
        .trim_start_matches('$')
        .split('.')
        .filter(|p| !p.is_empty())
    {
        let (name, index) = match part.split_once('[') {
            Some((n, rest)) => (n, rest.trim_end_matches(']').parse::<usize>().ok()),
            None => (part, None),
        };
        if !name.is_empty() {
            cur = &cur[name];
        }
        if let Some(i) = index {
            cur = &cur[i];
        }
    }
    cur.clone()
}

/// Every template, by name.
#[derive(Debug, Clone, Default)]
pub struct Templates {
    pub all: BTreeMap<String, Template>,
}

/// The file a template's name puts it in.
fn file_of(name: &str) -> String {
    format!("{}.json", name.split('.').next().unwrap_or(name))
}

impl Templates {
    pub fn load(dir: &Path) -> Result<Templates, String> {
        let mut all = BTreeMap::new();
        let entries =
            std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        for path in files {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("reading {}: {e}", path.display()))?;
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("{} isn't JSON: {e}", path.display()))?;
            let Value::Object(m) = v else {
                return Err(format!("{} isn't an object of templates", path.display()));
            };
            for (name, t) in m {
                let file = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
                if file_of(&name) != file {
                    return Err(format!("template {name} belongs in {}", file_of(&name)));
                }
                all.insert(name.clone(), Template::from_json(&name, &t)?);
            }
        }
        Ok(Templates { all })
    }

    pub fn get(&self, name: &str) -> Option<&Template> {
        self.all.get(name)
    }

    /// Writes every template to `dir`, a file per group, keys sorted, as `load` reads them.
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        let mut files: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        for (name, t) in &self.all {
            files
                .entry(file_of(name))
                .or_default()
                .insert(name.clone(), t.to_json());
        }
        for (file, m) in files {
            let path = dir.join(file);
            let text = serde_json::to_string_pretty(&Value::Object(m))
                .map_err(|e| format!("writing {}: {e}", path.display()))?;
            std::fs::write(&path, text + "\n")
                .map_err(|e| format!("writing {}: {e}", path.display()))?;
        }
        Ok(())
    }

    /// The webhook events and actions there are templates for: `issues.opened`, …
    pub fn webhook_pairs(&self) -> Vec<String> {
        self.all
            .keys()
            .filter_map(|k| k.strip_prefix("webhook."))
            .map(str::to_owned)
            .collect()
    }
}
