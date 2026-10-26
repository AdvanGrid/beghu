//! Build-time SQL checker for rusqlite.
//!
//! Called from a crate's `build.rs`. It applies `migrations/*.sql` in order to an in-memory
//! SQLite (the same bundled build the app links), prepares every named query in `queries/*.sql`
//! against it, and writes typed Rust for each one to `$OUT_DIR/db.rs`. Any failure is a
//! `cargo::error=<file>:<line>: …` line, so the build stops at the query's location.
//!
//! Query file format (sqlc-style):
//!
//! ```sql
//! -- name: list_page :many        (:one | :opt | :many | :exec | :fragment)
//! -- param: state &str            (one per named parameter, Rust type after the name)
//! -- base: items i                (fragments only: the FROM they are checked against)
//! SELECT … WHERE i.state = :state;
//! ```
//!
//! Column overrides live in the alias, as in sqlx: `AS "x!"` not null, `AS "x?"` nullable,
//! `AS "x: f64"` type, `AS "x!: f64"` both.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

pub struct Options {
    /// Mirrors may mark a migration `*.rebuild.sql`; the control DB may not.
    pub allow_rebuild: bool,
    /// Another schema crate's directory (relative to this crate's), whose migrations come first:
    /// this schema extends that one. Its own migrations are numbered from 1 in `migrations/` and
    /// take versions after the base's. The base's `.rebuild.sql` files keep their kind.
    pub base: Option<String>,
}

/// The whole check for the crate whose `build.rs` calls it. Errors become `cargo::error=` lines,
/// which fail the build; the generated code goes to `$OUT_DIR/db.rs`.
pub fn run(opts: Options) {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("db.rs");
    println!("cargo::rerun-if-changed=migrations");
    println!("cargo::rerun-if-changed=queries");
    if let Some(base) = &opts.base {
        println!("cargo::rerun-if-changed={base}/migrations");
    }
    let code = match check(&dir, &opts) {
        Ok(code) => code,
        Err(errs) => {
            for e in &errs {
                println!("cargo::error={e}");
            }
            String::new()
        }
    };
    std::fs::write(out, code).unwrap();
}

/// Everything `run` does except the cargo plumbing: the generated Rust, or every error found,
/// each as `<file>:<line>: …`.
pub fn check(dir: &Path, opts: &Options) -> Result<String, Vec<String>> {
    let mut errs = Vec::new();
    let errs = &mut errs;
    let conn = Connection::open_in_memory().unwrap();
    let mut code = String::new();
    let mut list = String::new();
    let mut migs = 0;
    if let Some(base) = &opts.base {
        let base_opts = Options {
            allow_rebuild: true,
            base: None,
        };
        let migrations = dir.join(base).join("migrations");
        migs = apply_migrations(&conn, &migrations, &base_opts, 0, errs, &mut list);
    }
    let base_migs = opts.base.as_ref().map(|_| migs);
    migs = apply_migrations(&conn, &dir.join("migrations"), opts, migs, errs, &mut list);
    let _ = writeln!(
        code,
        "pub static MIGRATIONS: &[dbrt::Migration] = &[\n{list}];"
    );
    if !errs.is_empty() {
        // Every query would fail on the half-built schema too; report only the cause.
        return Err(std::mem::take(errs));
    }
    let mut files: Vec<_> = std::fs::read_dir(dir.join("queries"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut defs = Vec::new();
    for f in files
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "sql"))
    {
        defs.extend(parse_file(f, errs));
    }
    let mut q = String::new();
    let mut fr = String::new();
    let mut seen = BTreeSet::new();
    for d in &defs {
        if !seen.insert(d.name.clone()) {
            errs.push(format!(
                "{}:{}: query `{}` is defined twice",
                d.file.display(),
                d.header_line,
                d.name
            ));
            continue;
        }
        if let Some(c) = check_query(&conn, d, errs) {
            if d.kind == Kind::Fragment {
                fr.push_str(&c.code)
            } else {
                q.push_str(&c.code)
            }
        }
    }
    if !errs.is_empty() {
        return Err(std::mem::take(errs));
    }
    let _ = writeln!(code, "pub const SCHEMA_VERSION: u32 = {migs};");
    if let Some(base) = base_migs {
        let _ = writeln!(
            code,
            "/// The version of the base schema's last migration: `MIGRATIONS[..BASE_VERSION]` are the base's.\npub const BASE_VERSION: u32 = {base};"
        );
    }
    let _ = writeln!(
        code,
        "#[allow(clippy::all, unused_imports)]\npub mod q {{\nuse rusqlite::{{OptionalExtension as _, ToSql}};\n{q}}}"
    );
    let _ = writeln!(
        code,
        "#[allow(clippy::all, unused_imports)]\npub mod frag {{\nuse dbrt::filter::{{Filter, val}};\n{fr}}}"
    );
    Ok(code)
}

/// Applies `dir`'s migrations after the first `offset` versions, appending each to `list` (the
/// body of `MIGRATIONS`). Returns the last version.
fn apply_migrations(
    conn: &Connection,
    dir: &Path,
    opts: &Options,
    offset: u32,
    errs: &mut Vec<String>,
    list: &mut String,
) -> u32 {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut v = 0;
    for f in files
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "sql"))
    {
        let file = f.file_name().unwrap().to_str().unwrap();
        let Some((num, rest)) = file.split_once('_') else {
            errs.push(format!(
                "{}:1: migration file names are NNNN_name.sql",
                f.display()
            ));
            continue;
        };
        let n: u32 = num.parse().unwrap_or(0);
        if n != v + 1 {
            errs.push(format!(
                "{}:1: expected migration {}, found {num}",
                f.display(),
                v + 1
            ));
        }
        v = n;
        let rebuild = rest.ends_with(".rebuild.sql");
        if rebuild && !opts.allow_rebuild {
            errs.push(format!(
                "{}:1: this schema isn't disposable, so no migration may be `.rebuild.sql`",
                f.display()
            ));
        }
        let sql = std::fs::read_to_string(f).unwrap();
        let name = rest.trim_end_matches(".sql").trim_end_matches(".rebuild");
        // Applied the way the runtime applies it: inside a transaction.
        const BEGIN: &str = "BEGIN;\n";
        let wrapped = format!("{BEGIN}{sql}\nCOMMIT;");
        if let Err(e) = conn.execute_batch(&wrapped) {
            let _ = conn.execute_batch("ROLLBACK");
            let (line, msg) = match &e {
                // `execute_batch` prepares one statement at a time, so `sql` is the unexecuted
                // tail of `wrapped` and `offset` counts from its start.
                rusqlite::Error::SqlInputError {
                    msg,
                    offset,
                    sql: tail,
                    ..
                } => {
                    let at = (wrapped.len() - tail.len() + (*offset).max(0) as usize)
                        .saturating_sub(BEGIN.len())
                        .min(sql.len());
                    (sql[..at].matches('\n').count() + 1, msg.clone())
                }
                e => (1, e.to_string()),
            };
            errs.push(format!(
                "{}:{line}: migration {num}_{name}: {msg}",
                f.display()
            ));
        }
        let kind = if rebuild { "Rebuild" } else { "InPlace" };
        let _ = writeln!(
            list,
            "    dbrt::Migration {{ version: {}, name: {name:?}, kind: dbrt::Kind::{kind}, sql: include_str!({:?}) }},",
            offset + n,
            f.display()
        );
    }
    offset + v
}

// ---------------------------------------------------------------------------------------------
// Query files

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    One,
    Opt,
    Many,
    Exec,
    Fragment,
}

struct Def {
    name: String,
    kind: Kind,
    params: Vec<(String, String)>,
    base: Option<String>,
    sql: String,
    file: PathBuf,
    header_line: usize,
    sql_line: usize,
}

fn parse_file(path: &Path, errs: &mut Vec<String>) -> Vec<Def> {
    let text = std::fs::read_to_string(path).unwrap();
    let mut defs: Vec<Def> = Vec::new();
    let mut in_header = false;
    for (i, line) in text.lines().enumerate() {
        let ln = i + 1;
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("-- name:") {
            let mut it = rest.split_whitespace();
            let name = it.next().unwrap_or("").to_string();
            let kind = match it.next() {
                Some(":one") => Kind::One,
                Some(":opt") => Kind::Opt,
                Some(":many") => Kind::Many,
                Some(":exec") => Kind::Exec,
                Some(":fragment") => Kind::Fragment,
                k => {
                    errs.push(format!("{}:{ln}: unknown query kind {k:?}", path.display()));
                    Kind::Many
                }
            };
            defs.push(Def {
                name,
                kind,
                params: vec![],
                base: None,
                sql: String::new(),
                file: path.into(),
                header_line: ln,
                sql_line: ln + 1,
            });
            in_header = true;
            continue;
        }
        let Some(d) = defs.last_mut() else { continue };
        if in_header {
            if let Some(p) = t.strip_prefix("-- param:") {
                let p = p.trim();
                let (n, ty) = p.split_once(' ').unwrap_or((p, ""));
                if ty.trim().is_empty() {
                    errs.push(format!(
                        "{}:{ln}: `-- param: {n}` needs a Rust type",
                        path.display()
                    ));
                }
                d.params.push((n.to_string(), ty.trim().to_string()));
                continue;
            }
            if let Some(b) = t.strip_prefix("-- base:") {
                d.base = Some(b.trim().to_string());
                continue;
            }
            in_header = false;
            d.sql_line = ln;
        }
        d.sql.push_str(line);
        d.sql.push('\n');
    }
    for d in &mut defs {
        // Doc comments for the next query sit at the end of this one's text: drop them.
        let mut lines: Vec<&str> = d.sql.lines().collect();
        while lines
            .last()
            .is_some_and(|l| l.trim().is_empty() || l.trim().starts_with("--"))
        {
            lines.pop();
        }
        d.sql = lines
            .join("\n")
            .trim_end()
            .trim_end_matches(';')
            .to_string();
        if d.kind == Kind::Fragment && d.base.is_none() {
            d.base = Some("items i".into());
        }
    }
    defs
}

// ---------------------------------------------------------------------------------------------
// Lexer

#[derive(Clone, Debug, PartialEq)]
enum T {
    Word(String),
    Quoted(String),
    Str,
    Num,
    Param(String),
    Positional,
    P(char),
    Comment(String),
}

#[derive(Clone, Debug)]
struct Tok {
    t: T,
    start: usize,
    end: usize,
}

fn lex(s: &str) -> Vec<Tok> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    while i < b.len() {
        let c = b[i];
        let st = i;
        let t = if c.is_ascii_whitespace() {
            i += 1;
            continue;
        } else if c == b'-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1
            }
            T::Comment(s[st..i].to_string())
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1
            }
            i = (i + 2).min(b.len());
            T::Comment(s[st..i].to_string())
        } else if c == b'\'' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\'' && b.get(i + 1) == Some(&b'\'') {
                    i += 2
                } else if b[i] == b'\'' {
                    break;
                } else {
                    i += 1
                }
            }
            i += 1;
            T::Str
        } else if c == b'"' || c == b'`' || c == b'[' {
            let close = if c == b'[' { b']' } else { c };
            i += 1;
            while i < b.len() && b[i] != close {
                i += 1
            }
            i += 1;
            T::Quoted(s[st + 1..i - 1].to_string())
        } else if c == b':' && b.get(i + 1).is_some_and(|&c| word(c)) {
            i += 1;
            while i < b.len() && word(b[i]) {
                i += 1
            }
            T::Param(s[st + 1..i].to_string())
        } else if c == b'?' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1
            }
            T::Positional
        } else if c.is_ascii_digit() {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1
            }
            T::Num
        } else if word(c) {
            while i < b.len() && word(b[i]) {
                i += 1
            }
            T::Word(s[st..i].to_string())
        } else {
            i += 1;
            T::P(c as char)
        };
        out.push(Tok {
            t,
            start: st,
            end: i,
        });
    }
    out
}

fn kw(t: &Tok, k: &str) -> bool {
    matches!(&t.t, T::Word(w) if w.eq_ignore_ascii_case(k))
}

fn ident(t: &Tok) -> Option<&str> {
    match &t.t {
        T::Word(w) | T::Quoted(w) => Some(w),
        _ => None,
    }
}

/// Index of the matching `)` for the `(` at `i`.
fn close(toks: &[Tok], i: usize) -> usize {
    let mut depth = 0;
    for (j, t) in toks.iter().enumerate().skip(i) {
        match t.t {
            T::P('(') => depth += 1,
            T::P(')') => {
                depth -= 1;
                if depth == 0 {
                    return j;
                }
            }
            _ => {}
        }
    }
    toks.len() - 1
}

/// Positions in `toks` at paren depth 0.
fn top(toks: &[Tok]) -> Vec<usize> {
    let mut depth = 0i32;
    let mut out = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        match t.t {
            T::P('(') => depth += 1,
            T::P(')') => depth -= 1,
            _ if depth == 0 => out.push(i),
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Shape: just enough of the statement to decide nullability per output column

#[derive(Debug, Clone)]
enum Src {
    Table(String),
    Sub { outer: bool, compound: bool },
    Func(String),
}

#[derive(Debug, Clone)]
struct Source {
    alias: String,
    src: Src,
    nullable: bool,
}

#[derive(Debug)]
enum Item {
    Col(Option<String>, String),
    Expr,
    Star,
}

#[derive(Default, Debug)]
struct Shape {
    items: Vec<Item>,
    sources: Vec<Source>,
    compound: bool,
    /// An aggregate in the select list with no GROUP BY: one row even on no input, so every
    /// column can be NULL (`SELECT max(id), title FROM items` on an empty table).
    lone_aggregate: bool,
    returning: Option<String>,
    ctes: BTreeMap<String, (bool, bool)>,
}

fn has_outer(toks: &[Tok]) -> bool {
    toks.iter()
        .any(|t| kw(t, "LEFT") || kw(t, "RIGHT") || kw(t, "FULL"))
}

fn has_compound(toks: &[Tok]) -> bool {
    top(toks)
        .into_iter()
        .any(|i| kw(&toks[i], "UNION") || kw(&toks[i], "INTERSECT") || kw(&toks[i], "EXCEPT"))
}

const CLAUSE_END: &[&str] = &[
    "WHERE",
    "GROUP",
    "HAVING",
    "ORDER",
    "LIMIT",
    "WINDOW",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "RETURNING",
    "ON",
    "USING",
];
const NOT_ALIAS: &[&str] = &[
    "ON",
    "USING",
    "JOIN",
    "LEFT",
    "RIGHT",
    "FULL",
    "INNER",
    "CROSS",
    "NATURAL",
    "OUTER",
    "WHERE",
    "GROUP",
    "HAVING",
    "ORDER",
    "LIMIT",
    "WINDOW",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "INDEXED",
    "NOT",
    "SET",
    "VALUES",
    "RETURNING",
    "DEFAULT",
    "SELECT",
];

fn shape(all: &[Tok]) -> Shape {
    let toks: Vec<Tok> = all
        .iter()
        .filter(|t| !matches!(t.t, T::Comment(_)))
        .cloned()
        .collect();
    let mut sh = Shape::default();
    let mut i = 0;
    if toks.first().is_some_and(|t| kw(t, "WITH")) {
        i = 1;
        if kw(&toks[i], "RECURSIVE") {
            i += 1
        }
        loop {
            let name = ident(&toks[i]).unwrap_or("").to_lowercase();
            i += 1;
            if matches!(toks[i].t, T::P('(')) {
                i = close(&toks, i) + 1
            }
            i += 1; // AS
            while kw(&toks[i], "NOT") || kw(&toks[i], "MATERIALIZED") {
                i += 1
            }
            let j = close(&toks, i);
            let body = &toks[i + 1..j];
            sh.ctes.insert(name, (has_outer(body), has_compound(body)));
            i = j + 1;
            if matches!(toks.get(i).map(|t| &t.t), Some(T::P(','))) {
                i += 1
            } else {
                break;
            }
        }
    }
    let rest = &toks[i..];
    let tops = top(rest);
    let find = |k: &str| tops.iter().copied().find(|&j| kw(&rest[j], k));
    if rest.first().is_some_and(|t| kw(t, "SELECT")) {
        sh.compound = has_compound(rest);
        let from = find("FROM").unwrap_or(rest.len());
        let mut s = 1;
        while s < from && (kw(&rest[s], "DISTINCT") || kw(&rest[s], "ALL")) {
            s += 1
        }
        sh.items = items(&rest[s..from]);
        let list = &rest[s..from];
        let aggregate = top(list).into_iter().any(|j| {
            [
                "count",
                "max",
                "min",
                "sum",
                "avg",
                "total",
                "group_concat",
                "string_agg",
                "json_group_array",
                "json_group_object",
            ]
            .iter()
            .any(|f| kw(&list[j], f))
                && list.get(j + 1).is_some_and(|t| t.t == T::P('('))
        });
        sh.lone_aggregate = aggregate && find("GROUP").is_none();
        if from < rest.len() {
            let end = tops
                .iter()
                .copied()
                .find(|&j| j > from && CLAUSE_END[..9].iter().any(|k| kw(&rest[j], k)))
                .unwrap_or(rest.len());
            sh.sources = sources(&rest[from + 1..end], &sh.ctes);
        }
    } else {
        // INSERT [OR x] INTO t | UPDATE [OR x] t | DELETE FROM t, with RETURNING.
        let mut j = 1;
        while j < rest.len()
            && (kw(&rest[j], "OR")
                || kw(&rest[j], "INTO")
                || kw(&rest[j], "FROM")
                || kw(&rest[j], "REPLACE")
                || kw(&rest[j], "IGNORE")
                || kw(&rest[j], "ABORT")
                || kw(&rest[j], "FAIL")
                || kw(&rest[j], "ROLLBACK"))
        {
            j += 1
        }
        let table = rest.get(j).and_then(ident).unwrap_or("").to_string();
        if let Some(r) = find("RETURNING") {
            sh.items = items(&rest[r + 1..]);
            sh.returning = Some(table.clone());
            sh.sources = vec![Source {
                alias: table.clone(),
                src: Src::Table(table),
                nullable: false,
            }];
        }
    }
    sh
}

fn items(toks: &[Tok]) -> Vec<Item> {
    let mut out = Vec::new();
    let mut cur: Vec<&Tok> = Vec::new();
    let tops: BTreeSet<usize> = top(toks).into_iter().collect();
    for (i, t) in toks.iter().enumerate() {
        if tops.contains(&i) && t.t == T::P(',') {
            out.push(item(&cur));
            cur.clear();
        } else {
            cur.push(t);
        }
    }
    if !cur.is_empty() {
        out.push(item(&cur))
    }
    out
}

fn item(toks: &[&Tok]) -> Item {
    let mut e = toks;
    if e.len() >= 3 && kw(e[e.len() - 2], "AS") {
        e = &e[..e.len() - 2]
    }
    match e {
        [a, d, c] if d.t == T::P('.') && ident(a).is_some() && ident(c).is_some() => Item::Col(
            Some(ident(a).unwrap().to_lowercase()),
            ident(c).unwrap().into(),
        ),
        [a, d, s] if d.t == T::P('.') && s.t == T::P('*') && ident(a).is_some() => Item::Star,
        [s] if s.t == T::P('*') => Item::Star,
        [c] if ident(c).is_some() && !["NULL", "TRUE", "FALSE"].iter().any(|k| kw(c, k)) => {
            Item::Col(None, ident(c).unwrap().into())
        }
        _ => Item::Expr,
    }
}

fn sources(toks: &[Tok], ctes: &BTreeMap<String, (bool, bool)>) -> Vec<Source> {
    let mut out: Vec<Source> = Vec::new();
    let mut i = 0;
    let mut join = String::new();
    while i < toks.len() {
        let (src, name) = if toks[i].t == T::P('(') {
            let j = close(toks, i);
            let body = &toks[i + 1..j];
            i = j + 1;
            (
                Src::Sub {
                    outer: has_outer(body),
                    compound: has_compound(body),
                },
                String::new(),
            )
        } else {
            let n = ident(&toks[i]).unwrap_or("").to_string();
            i += 1;
            if toks.get(i).is_some_and(|t| t.t == T::P('(')) {
                i = close(toks, i) + 1;
                (Src::Func(n.to_lowercase()), n)
            } else if let Some(&(outer, compound)) = ctes.get(&n.to_lowercase()) {
                (Src::Sub { outer, compound }, n)
            } else {
                (Src::Table(n.clone()), n)
            }
        };
        if toks.get(i).is_some_and(|t| kw(t, "AS")) {
            i += 1
        }
        let alias = match toks.get(i) {
            Some(t) if ident(t).is_some() && !NOT_ALIAS.iter().any(|k| kw(t, k)) => {
                i += 1;
                ident(t).unwrap().to_string()
            }
            _ => name,
        };
        let left = join.contains("LEFT") || join.contains("FULL");
        if join.contains("RIGHT") || join.contains("FULL") {
            out.iter_mut().for_each(|s| s.nullable = true);
        }
        out.push(Source {
            alias: alias.to_lowercase(),
            src,
            nullable: left,
        });
        // Skip ON/USING/INDEXED BY to the next join operator at this depth.
        join.clear();
        while i < toks.len() {
            let t = &toks[i];
            if t.t == T::P('(') {
                i = close(toks, i) + 1;
                continue;
            }
            if t.t == T::P(',') {
                i += 1;
                break;
            }
            if [
                "NATURAL", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "JOIN",
            ]
            .iter()
            .any(|k| kw(t, k))
            {
                while i < toks.len() && !kw(&toks[i], "JOIN") {
                    join.push_str(&ident(&toks[i]).unwrap_or("").to_uppercase());
                    join.push(' ');
                    i += 1;
                }
                i += 1;
                break;
            }
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Checking one query

struct Checked {
    code: String,
}

struct Col {
    field: String,
    ty: String,
    nullable: bool,
    why: String,
}

fn check_query(conn: &Connection, d: &Def, errs: &mut Vec<String>) -> Option<Checked> {
    let at = |off: usize| d.sql_line + d.sql[..off.min(d.sql.len())].matches('\n').count();
    let loc = |off: usize| format!("{}:{}: query `{}`", d.file.display(), at(off), d.name);
    let toks = lex(&d.sql);
    let n0 = errs.len();

    // Parameters: every `:name` declared, every declaration used, no positional `?`.
    let mut uses: Vec<(String, bool)> = Vec::new(); // (name, after the filter placeholder)
    let mut checked = d.sql.clone().into_bytes();
    let mut compact = String::new(); // what the generated code runs: `?` without the padding
    let mut last = 0;
    let mut filter_at = None;
    for t in &toks {
        match &t.t {
            T::Param(p) => {
                if !d.params.iter().any(|(n, _)| n == p) {
                    errs.push(format!(
                        "{}: `:{p}` has no `-- param: {p} <type>` line",
                        loc(t.start)
                    ));
                }
                uses.push((p.clone(), filter_at.is_some()));
                compact.push_str(&d.sql[last..t.start]);
                compact.push('?');
                last = t.end;
                checked[t.start] = b'?';
                checked[t.start + 1..t.end].fill(b' ');
            }
            T::Positional => errs.push(format!("{}: use a named `:param`, not `?`", loc(t.start))),
            T::Comment(c) if c == "/* filter */" => {
                if d.kind == Kind::Fragment {
                    errs.push(format!(
                        "{}: a fragment can't hold `/* filter */`",
                        loc(t.start)
                    ))
                }
                compact.push_str(&d.sql[last..t.start]);
                filter_at = Some(compact.len());
                compact.push_str("/* filter */");
                last = t.end;
                checked[t.start] = b'1';
                checked[t.start + 1..t.end].fill(b' ');
            }
            _ => {}
        }
    }
    for (n, _) in &d.params {
        if !uses.iter().any(|(u, _)| u == n) {
            errs.push(format!(
                "{}:{}: query `{}`: `-- param: {n}` is never used",
                d.file.display(),
                d.header_line,
                d.name
            ));
        }
    }
    compact.push_str(&d.sql[last..]);
    let checked = String::from_utf8(checked).unwrap();
    let (sql, shift) = match d.kind {
        Kind::Fragment => {
            let pre = format!("SELECT 1 FROM {} WHERE (", d.base.as_deref().unwrap());
            (format!("{pre}{checked})"), pre.len())
        }
        _ => (checked.clone(), 0),
    };
    let stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(rusqlite::Error::SqlInputError { msg, offset, .. }) => {
            errs.push(format!(
                "{}: {msg}",
                loc((offset.max(0) as usize).saturating_sub(shift))
            ));
            return None;
        }
        Err(e) => {
            errs.push(format!("{}: {e}", loc(0)));
            return None;
        }
    };
    if stmt.parameter_count() != uses.len() {
        errs.push(format!(
            "{}: SQLite counts {} parameters, the file {}",
            loc(0),
            stmt.parameter_count(),
            uses.len()
        ));
    }
    let ncol = if d.kind == Kind::Fragment {
        0
    } else {
        stmt.column_count()
    };
    match d.kind {
        Kind::Exec if ncol > 0 => errs.push(format!(
            "{}: `:exec` returns no rows; this returns {ncol} columns",
            loc(0)
        )),
        Kind::One | Kind::Opt | Kind::Many if ncol == 0 => {
            errs.push(format!("{}: returns no columns; use `:exec`", loc(0)))
        }
        _ => {}
    }

    // Columns: type and nullability, with the reason kept for the generated docs.
    let mut sh = shape(&toks);
    // SQLite traces a view's columns to its base tables but not through its joins: treat every
    // view as a source with an outer join inside.
    for src in &mut sh.sources {
        if let Src::Table(t) = &src.src
            && conn
                .query_row(
                    "SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = ?1 COLLATE NOCASE",
                    [t],
                    |_| Ok(()),
                )
                .is_ok()
        {
            src.src = Src::Sub {
                outer: true,
                compound: false,
            };
        }
    }
    if ncol > 0 && sh.items.len() != ncol && !sh.items.iter().any(|i| matches!(i, Item::Star)) {
        errs.push(format!(
            "{}: couldn't line up {ncol} result columns with the select list",
            loc(0)
        ));
    }
    let decl: Vec<Option<String>> = stmt
        .columns()
        .iter()
        .map(|c| c.decl_type().map(str::to_string))
        .collect();
    let mut cols = Vec::new();
    for (i, decl) in decl.iter().enumerate().take(ncol) {
        let raw = stmt.column_name(i).unwrap().to_string();
        let (left, ty_over) = match raw.split_once(':') {
            Some((l, t)) => (l.trim().to_string(), Some(t.trim().to_string())),
            None => (raw.clone(), None),
        };
        let (field, null_over) = match left.strip_suffix('!') {
            Some(f) => (f.to_string(), Some(false)),
            None => match left.strip_suffix('?') {
                Some(f) => (f.to_string(), Some(true)),
                None => (left.clone(), None),
            },
        };
        if !field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || field.is_empty() {
            errs.push(format!(
                "{}: column `{raw}` isn't a Rust field name; alias it",
                loc(0)
            ));
            continue;
        }
        let item = sh.items.get(i);
        if matches!(item, Some(Item::Star)) {
            errs.push(format!(
                "{}: no `*` in checked queries; list the columns",
                loc(0)
            ));
            continue;
        }
        // Origin: what SQLite traced the column to, or, for RETURNING, the target table.
        let origin: Option<(String, String)> = stmt
            .column_metadata(i)
            .ok()
            .flatten()
            .map(|m| (m.1.to_str().unwrap().into(), m.2.to_str().unwrap().into()))
            .or_else(|| match (&sh.returning, item) {
                (Some(t), Some(Item::Col(_, c))) => Some((t.clone(), c.clone())),
                _ => None,
            });
        let meta = origin.as_ref().and_then(|(t, c)| {
            conn.column_metadata(None::<&str>, t.as_str(), c.as_str())
                .ok()
                .map(|m| (m.0.map(|s| s.to_str().unwrap().to_string()), m.2, m.3))
        });
        let decl_ty = decl
            .clone()
            .or_else(|| meta.as_ref().and_then(|m| m.0.clone()));
        let ty = match ty_over.or_else(|| decl_ty.as_deref().and_then(affinity)) {
            Some(t) => t,
            None => {
                errs.push(format!("{}: column `{field}` has no declared type (an expression); give it one: AS \"{field}: i64\"", loc(0)));
                continue;
            }
        };
        let (nullable, why) = match null_over {
            Some(n) => (n, format!("override `{}`", if n { "?" } else { "!" })),
            None => nullability(
                &sh,
                item,
                origin.as_ref(),
                meta.as_ref()
                    .map(|m| (m.1, m.2, m.0.as_deref() == Some("INTEGER"))),
            ),
        };
        cols.push(Col {
            field,
            ty,
            nullable,
            why,
        });
    }
    if errs.len() > n0 {
        return None;
    }
    Some(codegen(d, &compact, filter_at, &uses, &cols))
}

fn affinity(decl: &str) -> Option<String> {
    let d = decl.to_uppercase();
    Some(
        if d.contains("BOOL") {
            "bool"
        } else if d.contains("INT") {
            "i64"
        } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
            "String"
        } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
            "f64"
        } else if d.contains("BLOB") {
            "Vec<u8>"
        } else {
            return None;
        }
        .to_string(),
    )
}

/// The rule: not null only when the column comes straight from a NOT NULL (or rowid) column of a
/// source that no outer join can null out. Everything else is `Option` unless overridden.
fn nullability(
    sh: &Shape,
    item: Option<&Item>,
    origin: Option<&(String, String)>,
    meta: Option<(bool, bool, bool)>,
) -> (bool, String) {
    if sh.compound {
        return (true, "compound select".into());
    }
    if sh.lone_aggregate {
        return (true, "aggregate without GROUP BY".into());
    }
    let Some(Item::Col(alias, _)) = item else {
        return (true, "expression".into());
    };
    let src: Vec<&Source> = match alias {
        Some(a) => sh
            .sources
            .iter()
            .filter(|s| {
                &s.alias == a || matches!(&s.src, Src::Table(t) if t.eq_ignore_ascii_case(a))
            })
            .collect(),
        None => {
            let by_origin: Vec<&Source> = sh.sources.iter().filter(|s| matches!((&s.src, origin), (Src::Table(t), Some((o, _))) if t.eq_ignore_ascii_case(o))).collect();
            if by_origin.is_empty() {
                sh.sources.iter().collect()
            } else {
                by_origin
            }
        }
    };
    if src.is_empty() {
        return (true, "source not resolved".into());
    }
    if let Some(s) = src.iter().find(|s| s.nullable) {
        return (true, format!("outer join `{}`", s.alias));
    }
    for s in &src {
        match &s.src {
            Src::Sub { outer: true, .. } => {
                return (true, format!("outer join inside `{}`", s.alias));
            }
            Src::Sub { compound: true, .. } => {
                return (true, format!("compound select inside `{}`", s.alias));
            }
            Src::Func(f) => return (true, format!("table-valued `{f}`")),
            _ => {}
        }
    }
    match (origin, meta) {
        (Some((t, c)), Some((not_null, pk, int))) if not_null || (pk && int) => (
            false,
            format!("{t}.{c} {}", if not_null { "NOT NULL" } else { "rowid" }),
        ),
        (Some((t, c)), Some(_)) => (true, format!("{t}.{c} nullable")),
        _ => (true, "no origin column".into()),
    }
}

// ---------------------------------------------------------------------------------------------
// Code generation

fn camel(s: &str) -> String {
    s.split('_')
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect()
}

fn bind(name: &str, ty: &str) -> String {
    if ty == "&[i64]" {
        format!("&dbrt::filter::json_ids({name})")
    } else {
        format!("&{name}")
    }
}

fn codegen(
    d: &Def,
    sql: &str,
    filter_at: Option<usize>,
    uses: &[(String, bool)],
    cols: &[Col],
) -> Checked {
    let mut c = String::new();
    let name = &d.name;
    let args: String = d
        .params
        .iter()
        .map(|(n, t)| format!(", {n}: {t}"))
        .collect();
    if d.kind == Kind::Fragment {
        let vals: Vec<String> = uses.iter().map(|(u, _)| format!("val({u})")).collect();
        let _ = writeln!(
            c,
            "pub fn {name}({}) -> Filter {{\n    Filter::Frag {{ sql: {sql:?}, params: vec![{}] }}\n}}",
            args.trim_start_matches(", "),
            vals.join(", ")
        );
        return Checked { code: c };
    }
    let row = camel(name) + "Row";
    let single = cols.len() == 1;
    let fty = |col: &Col| {
        if col.nullable {
            format!("Option<{}>", col.ty)
        } else {
            col.ty.clone()
        }
    };
    if !single && !cols.is_empty() {
        let fields: String = cols
            .iter()
            .map(|col| {
                format!(
                    "    /// {}\n    pub {}: {},\n",
                    col.why,
                    col.field,
                    fty(col)
                )
            })
            .collect();
        let _ = writeln!(
            c,
            "#[derive(Debug, Clone, PartialEq)]\npub struct {row} {{\n{fields}}}"
        );
    }
    let out_ty = if single { fty(&cols[0]) } else { row.clone() };
    let map = if single {
        "|r| r.get(0)".to_string()
    } else {
        let f: String = cols
            .iter()
            .enumerate()
            .map(|(i, col)| format!("{}: r.get({i})?, ", col.field))
            .collect();
        format!("|r| Ok({row} {{ {f}}})")
    };
    let ret = match d.kind {
        Kind::One => out_ty.clone(),
        Kind::Opt => format!("Option<{out_ty}>"),
        Kind::Many => format!("Vec<{out_ty}>"),
        _ => "usize".into(),
    };
    let ty_of = |u: &str| {
        d.params
            .iter()
            .find(|(n, _)| n == u)
            .map(|(_, t)| t.clone())
            .unwrap_or_default()
    };
    let filter_arg = if filter_at.is_some() {
        ", filter: &dbrt::filter::Filter"
    } else {
        ""
    };
    let _ = writeln!(
        c,
        "/// `{name}` in `{}`.",
        d.file.file_name().unwrap().to_string_lossy()
    );
    let _ = writeln!(
        c,
        "pub fn {name}(conn: &rusqlite::Connection{filter_arg}{args}) -> rusqlite::Result<{ret}> {{"
    );
    match filter_at {
        None => {
            let ps: Vec<String> = uses.iter().map(|(u, _)| bind(u, &ty_of(u))).collect();
            let _ = writeln!(
                c,
                "    let mut st = conn.prepare_cached({sql:?})?;\n    let p: &[&dyn ToSql] = &[{}];",
                ps.join(", ")
            );
        }
        Some(at) => {
            let (pre, post) = (&sql[..at], &sql[at + "/* filter */".len()..]);
            let pre_p: Vec<String> = uses
                .iter()
                .filter(|u| !u.1)
                .map(|(u, _)| bind(u, &ty_of(u)))
                .collect();
            let post_p: Vec<String> = uses
                .iter()
                .filter(|u| u.1)
                .map(|(u, _)| bind(u, &ty_of(u)))
                .collect();
            let _ = writeln!(
                c,
                "    let (fsql, fp) = filter.render();\n    let mut st = conn.prepare_cached(&format!(\"{{}}{{}}{{}}\", {pre:?}, fsql, {post:?}))?;"
            );
            let _ = writeln!(
                c,
                "    let mut p: Vec<&dyn ToSql> = vec![{}];\n    p.extend(fp.iter().map(|v| v as &dyn ToSql));\n    p.extend([{}] as [&dyn ToSql; {}]);\n    let p = &p[..];",
                pre_p.join(", "),
                post_p.join(", "),
                post_p.len()
            );
        }
    }
    let body = match d.kind {
        Kind::One => format!("st.query_row(p, {map})"),
        Kind::Opt => format!("st.query_row(p, {map}).optional()"),
        Kind::Many => format!("st.query_map(p, {map})?.collect()"),
        _ => "st.execute(p)".into(),
    };
    let _ = writeln!(c, "    {body}\n}}");
    Checked { code: c }
}
