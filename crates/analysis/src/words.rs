//! Judging and comparing words (principle 3: observe and report), and generic line data.

use serde_json::Value;
use std::collections::HashSet;

/// Single words that judge, recommend or compare.
const WORDS: &[&str] = &[
    "should",
    "shouldn't",
    "consider",
    "recommend",
    "recommended",
    "better",
    "worse",
    "risky",
    "concern",
    "concerning",
    "smell",
    "clean",
    "messy",
    "poorly",
    "overlap",
    "overlaps",
    "duplicate",
    "duplicates",
    "duplicated",
    "mirrors",
    "redundant",
];

/// Word pairs that do the same.
const PHRASES: &[[&str; 2]] = &[
    ["could", "instead"],
    ["risk", "of"],
    ["well", "designed"],
    ["similar", "to"],
    ["same", "as"],
];

/// The names an analysis writes as code: every identifier inside a backtick code span (and the
/// span's whole text, `pristine-mirrors`), every segment of a `::` path in its prose
/// (`dbrt::Mirrors::new`), and every path it names (a part's `paths`, a file's, a claim's
/// evidence), whole and by segment. Snippets are code, not prose, and aren't read. A capitalised
/// word is a name only when it's one of these ([`judging`]).
#[derive(Debug, Default)]
pub(crate) struct Names(HashSet<String>);

impl Names {
    /// The names in `analysis`, as uploaded (JSON, migrated).
    pub(crate) fn of(analysis: &Value) -> Names {
        let mut n = Names::default();
        n.walk(analysis, "");
        n
    }

    fn walk(&mut self, v: &Value, key: &str) {
        match v {
            Value::String(s) => match key {
                "snippet" => {}
                "path" | "paths" | "previousPath" => self.path(s),
                _ => self.text(s),
            },
            Value::Array(list) => list.iter().for_each(|x| self.walk(x, key)),
            Value::Object(o) => o.iter().for_each(|(k, x)| self.walk(x, k)),
            _ => {}
        }
    }

    fn add(&mut self, s: &str) {
        if !s.is_empty() && !self.0.contains(s) {
            self.0.insert(s.to_owned());
        }
    }

    fn idents(&mut self, s: &str) {
        for w in s.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
            self.add(w);
        }
    }

    fn path(&mut self, s: &str) {
        let s = s.trim_matches('/');
        self.add(s);
        for seg in s.split('/') {
            self.add(seg);
            self.idents(seg);
        }
    }

    fn text(&mut self, s: &str) {
        if s.contains('`') {
            for span in spans(s) {
                self.add(span.trim());
                for w in span.split_whitespace() {
                    self.path(w.trim_matches(|c: char| !(c.is_alphanumeric() || c == '_')));
                }
            }
        }
        if s.contains("::") {
            for token in s.split_whitespace().filter(|t| t.contains("::")) {
                self.idents(token);
            }
        }
    }

    fn contains(&self, s: &str) -> bool {
        self.0.contains(s)
    }
}

/// The first judging or comparing word or phrase in `text`, as written there, in an analysis that
/// writes `names` as code. Code isn't prose: words inside a backtick code span
/// (`` `clean_path` ``) and words that are part of an identifier are skipped. An identifier is a
/// token joined by `_` or `::` (`clean_path`, `mirror_db::q`), or by `-`, `/` or `.` other than
/// between two plain words (`web/src/mirrors.ts`, `self.clean`: `better-tested`, `clean/simple`
/// and `clean.It` are prose), or written in mixed case (`CleanPath`, `isClean`), or a token the
/// analysis writes as code ([`Names`]: `pristine-mirrors`, once a path or a code span names it).
/// A capitalised word is a name only that way: `Mirrors` is the type wherever it sits in a
/// sentence once the analysis writes `dbrt::Mirrors` or `` `Mirrors` `` anywhere, and a word
/// otherwise, at a sentence's start or not ("It's Concerning."). So no sentence boundaries are
/// needed: a newline, `;`, a dash, a quote or a list marker changes nothing.
pub(crate) fn judging(text: &str, names: &Names) -> Option<String> {
    let mut words: Vec<Option<String>> = Vec::new();
    for token in prose(text).split_whitespace() {
        let core = token.trim_matches(|c: char| !(c.is_alphanumeric() || c == '_'));
        let parts: Vec<&str> = core
            .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
            .filter(|w| !w.is_empty())
            .collect();
        if identifier(core, names) {
            // An identifier breaks any phrase across it.
            words.push(None);
        } else {
            words.extend(
                parts
                    .iter()
                    .map(|w| Some(w.to_lowercase().replace('’', "'"))),
            );
        }
    }
    for (i, w) in words.iter().enumerate() {
        let Some(w) = w else { continue };
        if WORDS.contains(&w.as_str()) {
            return Some(w.clone());
        }
        if let Some(Some(next)) = words.get(i + 1)
            && phrase(w, next)
        {
            return Some(format!("{w} {next}"));
        }
    }
    None
}

fn phrase(a: &str, b: &str) -> bool {
    PHRASES.iter().any(|[x, y]| *x == a && *y == b)
}

/// The text of every closed backtick code span in `text`.
fn spans(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find('`') {
        let open = rest[at..].chars().take_while(|&c| c == '`').count();
        let after = &rest[at + open..];
        match find_run(after, open) {
            Some(close) => {
                out.push(&after[..close]);
                rest = &after[close + open..];
            }
            None => rest = after,
        }
    }
    out
}

/// `text` with every backtick code span blanked out (a span closes at the next run of as many
/// backticks as opened it, as in Markdown; an unclosed run is kept as text).
fn prose(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('`') {
        out.push_str(&rest[..at]);
        let open = rest[at..].chars().take_while(|&c| c == '`').count();
        let fence = &rest[at..at + open];
        let after = &rest[at + open..];
        match find_run(after, open) {
            Some(close) => {
                out.push(' ');
                rest = &after[close + open..];
            }
            None => {
                out.push_str(fence);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Where a run of exactly `n` backticks starts in `s`.
fn find_run(s: &str, n: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`' {
            let len = b[i..].iter().take_while(|&&c| c == b'`').count();
            if len == n {
                return Some(i);
            }
            i += len;
        } else {
            i += 1;
        }
    }
    None
}

/// Whether `token` (trimmed of surrounding punctuation) is an identifier rather than a word.
fn identifier(token: &str, names: &Names) -> bool {
    // A plain word stays a word even where a code span holds it (`` `clean` ``): only a
    // capitalised word or a joined token is a name for being written as code.
    let plain = token
        .chars()
        .all(|c| c.is_lowercase() || c == '\'' || c == '’');
    if !plain && names.contains(token) {
        return true;
    }
    let joined = token.contains('_') || token.contains("::") || code_join(token);
    let chars: Vec<char> = token.chars().collect();
    let mixed = chars
        .windows(2)
        .any(|w| w[0].is_lowercase() && w[1].is_uppercase());
    joined || mixed
}

/// Whether `-`, `/` or `.` join alphanumeric runs in `token` as code does: anything but a prose
/// pair, one separator between two plain words (`better-tested`, `clean/simple`, `clean.It`, the
/// last a missing space after a full stop; `mirrors.rs` and `self.clean` are code).
fn code_join(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    let seps: Vec<usize> = (1..chars.len().saturating_sub(1))
        .filter(|&i| {
            matches!(chars[i], '-' | '/' | '.')
                && chars[i - 1].is_alphanumeric()
                && chars[i + 1].is_alphanumeric()
        })
        .collect();
    let [at] = seps[..] else {
        return !seps.is_empty();
    };
    let (a, b): (String, String) = (
        chars[..at].iter().collect(),
        chars[at + 1..].iter().collect(),
    );
    let lower = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_alphabetic() && c.is_lowercase());
    let capitalised = |w: &str| {
        let mut c = w.chars();
        c.next().is_some_and(char::is_uppercase) && lower(c.as_str())
    };
    let prose = match chars[at] {
        '.' => lower(&a) && capitalised(&b),
        _ => lower(&a) && lower(&b),
    };
    !prose
}

/// `data.what` values that name no domain data.
const GENERIC: &[&str] = &[
    "data",
    "request",
    "requests",
    "response",
    "responses",
    "payload",
    "payloads",
    "info",
    "information",
    "message",
    "messages",
    "stuff",
    "things",
    "values",
];

pub(crate) fn generic_data(what: &str) -> bool {
    let w = what.trim().trim_end_matches('.').to_lowercase();
    w.is_empty() || GENERIC.contains(&w.as_str())
}
