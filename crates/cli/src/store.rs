//! What the CLI keeps on the machine: its sign-ins (`credentials.toml`) and each analysis run's
//! folder (`.beghu/run-<id>/run.toml`), both in a small subset of TOML this module reads and
//! writes itself: tables (`[hosts."https://…"]`), basic strings, integers and booleans.
//!
//! `credentials.toml` is in `$XDG_STATE_HOME/beghu/` (`~/.local/state/beghu/`) on Linux and
//! `~/Library/Application Support/beghu/` on macOS, or wherever `BEGHU_CREDENTIALS` names. Not
//! `~/.config`, which is often kept in git, and not an OS keychain, which is missing over SSH, in
//! containers and in CI. Both files are written `0600`, through a rename, so a crash never leaves
//! half of one.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

/// A value as the subset has them.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    Int(i64),
    Bool(bool),
}

/// A file: its top-level keys, then its tables by name. A table's name is kept as its first
/// part, a dot, then the rest unquoted (`hosts.https://beghu.dev`); the rest is written quoted.
#[derive(Clone, Debug, Default)]
pub struct Doc {
    pub top: BTreeMap<String, Value>,
    pub tables: BTreeMap<String, BTreeMap<String, Value>>,
}

impl Doc {
    pub fn str(map: &BTreeMap<String, Value>, key: &str) -> Option<String> {
        match map.get(key) {
            Some(Value::Str(s)) => Some(s.clone()),
            _ => None,
        }
    }

    pub fn int(map: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
        match map.get(key) {
            Some(Value::Int(n)) => Some(*n),
            _ => None,
        }
    }

    pub fn parse(text: &str) -> Result<Doc, String> {
        let mut doc = Doc::default();
        let mut table: Option<String> = None;
        for (i, raw) in text.lines().enumerate() {
            let line = raw.trim();
            let bad = |why: &str| format!("line {}: {why}", i + 1);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[') {
                let name = name
                    .strip_suffix(']')
                    .ok_or_else(|| bad("a table without `]`"))?;
                let name = unquote_key(name.trim()).ok_or_else(|| bad("a table name"))?;
                doc.tables.entry(name.clone()).or_default();
                table = Some(name);
                continue;
            }
            let (k, v) = line.split_once('=').ok_or_else(|| bad("no `=`"))?;
            let k = k.trim();
            if k.is_empty() || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return Err(bad("a key"));
            }
            let v = value(v.trim()).ok_or_else(|| bad("a value"))?;
            let map = match &table {
                None => &mut doc.top,
                Some(t) => doc.tables.get_mut(t).expect("made above"),
            };
            map.insert(k.to_owned(), v);
        }
        Ok(doc)
    }

    pub fn render(&self, header: &str) -> String {
        let mut out = String::new();
        for l in header.lines() {
            out.push_str(&format!("# {l}\n"));
        }
        for (k, v) in &self.top {
            out.push_str(&format!("{k} = {}\n", render_value(v)));
        }
        for (name, map) in &self.tables {
            let name = match name.split_once('.') {
                Some((first, rest)) => format!("{first}.{}", quote(rest)),
                None => name.clone(),
            };
            out.push_str(&format!("\n[{name}]\n"));
            for (k, v) in map {
                out.push_str(&format!("{k} = {}\n", render_value(v)));
            }
        }
        out
    }
}

/// `hosts."https://beghu.dev"` as written: the dotted key with its quoted part unquoted.
fn unquote_key(k: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = k;
    loop {
        if let Some(r) = rest.strip_prefix('"') {
            let (s, used) = basic_string(r)?;
            out.push_str(&s);
            rest = &r[used..];
        } else {
            let end = rest.find('.').unwrap_or(rest.len());
            let part = &rest[..end];
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return None;
            }
            out.push_str(part);
            rest = &rest[end..];
        }
        match rest.strip_prefix('.') {
            Some(r) => {
                out.push('.');
                rest = r;
            }
            None if rest.is_empty() => return Some(out),
            None => return None,
        }
    }
}

/// A basic string's text, from just past its opening quote: the text and how many bytes it took,
/// the closing quote included.
fn basic_string(s: &str) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((out, i + 1)),
            '\\' => match chars.next()?.1 {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                'n' => out.push('\n'),
                't' => out.push('\t'),
                _ => return None,
            },
            c => out.push(c),
        }
    }
    None
}

fn value(v: &str) -> Option<Value> {
    if let Some(r) = v.strip_prefix('"') {
        let (s, used) = basic_string(r)?;
        let rest = r[used..].trim();
        return (rest.is_empty() || rest.starts_with('#')).then_some(Value::Str(s));
    }
    let v = v.split('#').next()?.trim();
    match v {
        "true" => Some(Value::Bool(true)),
        "false" => Some(Value::Bool(false)),
        _ => v.parse().ok().map(Value::Int),
    }
}

fn quote(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn render_value(v: &Value) -> String {
    match v {
        Value::Str(s) => quote(s),
        Value::Int(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
    }
}

/// Writes `text` to `path` as `0600`, through a temporary file beside it and a rename, making
/// its folder (`0700`) if need be.
pub fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default(),
        std::process::id()
    ));
    let failed = |e: std::io::Error| format!("can't write {}: {e}", path.display());
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(failed)?;
    f.write_all(text.as_bytes()).map_err(failed)?;
    f.sync_all().map_err(failed)?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        failed(e)
    })
}

/// Where the sign-ins are kept.
pub fn credentials_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("BEGHU_CREDENTIALS").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    let home = || {
        std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                "HOME isn't set, so beghu can't find its credentials (set BEGHU_CREDENTIALS)"
                    .to_owned()
            })
    };
    let dir = if cfg!(target_os = "macos") {
        home()?
            .join("Library")
            .join("Application Support")
            .join("beghu")
    } else {
        match std::env::var_os("XDG_STATE_HOME").filter(|p| !p.is_empty()) {
            Some(s) => PathBuf::from(s).join("beghu"),
            None => home()?.join(".local").join("state").join("beghu"),
        }
    };
    Ok(dir.join("credentials.toml"))
}

/// One host's sign-in.
#[derive(Clone, Debug)]
pub struct SignIn {
    pub token: String,
    /// The GitHub account it acts as.
    pub account: String,
    /// When it expires unless it's used (Unix seconds), as last heard.
    pub expires: i64,
}

/// Every host's sign-in, and the active host.
#[derive(Clone, Debug, Default)]
pub struct Credentials {
    pub active: Option<String>,
    pub hosts: BTreeMap<String, SignIn>,
}

const HOSTS: &str = "hosts";

impl Credentials {
    /// The file, or none yet.
    pub fn load(path: &Path) -> Result<Credentials, String> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Credentials::default());
            }
            Err(e) => return Err(format!("can't read {}: {e}", path.display())),
        };
        let doc = Doc::parse(&text).map_err(|e| format!("can't read {}: {e}", path.display()))?;
        let mut c = Credentials {
            active: Doc::str(&doc.top, "active"),
            hosts: BTreeMap::new(),
        };
        for (name, map) in &doc.tables {
            let Some(host) = name.strip_prefix(&format!("{HOSTS}.")) else {
                continue;
            };
            if let (Some(token), Some(account)) = (Doc::str(map, "token"), Doc::str(map, "account"))
            {
                c.hosts.insert(
                    host.to_owned(),
                    SignIn {
                        token,
                        account,
                        expires: Doc::int(map, "expires").unwrap_or(0),
                    },
                );
            }
        }
        Ok(c)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let mut doc = Doc::default();
        if let Some(a) = &self.active {
            doc.top.insert("active".into(), Value::Str(a.clone()));
        }
        for (host, s) in &self.hosts {
            let mut m = BTreeMap::new();
            m.insert("token".into(), Value::Str(s.token.clone()));
            m.insert("account".into(), Value::Str(s.account.clone()));
            m.insert("expires".into(), Value::Int(s.expires));
            doc.tables.insert(format!("{HOSTS}.{host}"), m);
        }
        write_private(
            path,
            &doc.render(
                "beghu CLI sign-ins, one per host, written by `beghu login`. Keep this file private:\n\
                 each token acts as its GitHub account on that beghu until it's revoked.",
            ),
        )
    }
}
