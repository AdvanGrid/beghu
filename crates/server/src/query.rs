//! The filter bar's language, parsed from the `q` parameter that `/api/issues` and the facet
//! counts take (the web app sends the bar's text as it stands, less a token still being typed).
//!
//! Qualifiers: `is:open|closed` (state) and `is:issue|pr|any` (kind, `issue` when none is
//! given), `type:` (the GitHub issue type, by name), `label:`, `assignee:`, `author:` (both take
//! `me`), `repo:` (`name` or `owner/name`), `milestone:` (by title), `no:label|assignee|milestone`
//! `sort:<key>[-asc|-desc]`, `in:title|body|comments` (the fields free text searches; several,
//! by comma or by token, OR together, and none means all three) and `match:blend|best|off`
//! (Match mode, see `mirror_db::rank`). A value with spaces is quoted: `label:"good first issue"`. Labels
//! and assignees AND together; repos, milestones, authors and types OR; several states or kinds
//! OR. The last `sort:` and the last `match:` win.
//!
//! A token that can't mean anything yet is dropped rather than guessed at: a key with no value
//! (`label:`), an unknown key, or a value that isn't one of a closed set (`is:op`, `sort:upd`).
//! So typing never filters by a half-typed token.
//!
//! Everything else is free text: words AND together, each matching the start of a word in the
//! title, body or comments (`mirror_db::search`). A word's last part (split as the index splits text) needs 2 characters; until
//! it has them, the word searches on the parts before it.
//! `"a phrase"` matches as written and `-word` excludes.

use crate::api::MatchMode;
use mirror_db::list::{Sort, SortKey, View, Who, Word};

/// The view when the URL has no `q`: the Open preset.
pub const DEFAULT: &str = "is:open";

/// Parses the bar's text into the view it filters to.
pub fn parse(q: &str) -> View {
    let mut out = View::default();
    for raw in tokens(q) {
        let (exclude, t) = match raw.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest),
            _ => (false, raw),
        };
        match qualifier(t) {
            // Excluding by qualifier (`-label:bug`) isn't part of the language: dropped.
            Some(_) if exclude => {}
            Some((key, value)) => apply(&mut out, &key, value),
            None => {
                let phrase = t.starts_with('"');
                let text = unquote(t).replace('"', "");
                if let Some(text) = searchable(&text, phrase) {
                    out.words.push(Word {
                        text: text.to_owned(),
                        phrase,
                        exclude,
                    });
                }
            }
        }
    }
    out
}

fn apply(v: &mut View, key: &str, value: String) {
    if value.is_empty() {
        return;
    }
    let who = |login: String| {
        if login.eq_ignore_ascii_case("me") {
            Who::Me
        } else {
            Who::Login(login)
        }
    };
    match key {
        "is" => match value.to_ascii_lowercase().as_str() {
            "open" => v.open = true,
            "closed" => v.closed = true,
            "issue" => v.issues = true,
            "pr" => v.prs = true,
            "any" => v.any_kind = true,
            _ => {}
        },
        "label" => v.labels.push(value),
        "assignee" => v.assignees.push(who(value)),
        "author" => v.authors.push(who(value)),
        "repo" => v.repos.push(match value.split_once('/') {
            Some((owner, name)) => (Some(owner.to_owned()), name.to_owned()),
            None => (None, value),
        }),
        "milestone" => v.milestones.push(value),
        "type" => v.types.push(value),
        "no" => match value.to_ascii_lowercase().as_str() {
            "label" | "labels" => v.no_label = true,
            "assignee" | "assignees" => v.no_assignee = true,
            "milestone" => v.no_milestone = true,
            _ => {}
        },
        "in" => {
            for f in value.to_ascii_lowercase().split(',') {
                match f.trim() {
                    "title" => v.fields.title = true,
                    "body" => v.fields.body = true,
                    "comments" | "comment" => v.fields.comments = true,
                    _ => {}
                }
            }
        }
        "match" => {
            use serde::Deserialize;
            use serde::de::IntoDeserializer;
            let value = value.to_ascii_lowercase();
            // The value as the web app's Match dropdown spells it.
            let mode: Result<_, serde::de::value::Error> =
                MatchMode::deserialize(value.as_str().into_deserializer());
            if let Ok(m) = mode {
                v.matching = Some(m.into());
            }
        }
        "sort" => {
            let lower = value.to_ascii_lowercase();
            let (name, asc) = match lower.strip_suffix("-asc") {
                Some(n) => (n, true),
                None => (lower.strip_suffix("-desc").unwrap_or(&lower), false),
            };
            let Some(key) = SortKey::named(name) else {
                return;
            };
            v.sort = Sort { key, asc };
        }
        _ => {}
    }
}

/// What of a word is a search yet, if anything. The index splits text into tokens at anything
/// that isn't a letter or digit, and only a plain word's last token is a prefix: it needs 2
/// characters, since a one-letter prefix would match a huge range of tokens. While the last
/// token is shorter, the word searches on the tokens before it, as it did a keystroke earlier,
/// so the list doesn't widen between keystrokes: `web-h` searches `web`, `v1.2` searches `v1`
/// (until it's `v1.20` or quoted), and `a-b` nothing. `e-mail` and `x-ray` search whole (`e`
/// and `x` are matched whole). That also makes 2 the least a word has in all. A phrase matches
/// whole tokens, so only its total counts.
fn searchable(text: &str, phrase: bool) -> Option<&str> {
    if phrase {
        return (text.chars().filter(|c| c.is_alphanumeric()).count() >= 2).then_some(text);
    }
    let mut text = text.trim_end_matches(|c: char| !c.is_alphanumeric());
    loop {
        let start = text
            .char_indices()
            .rfind(|(_, c)| !c.is_alphanumeric())
            .map_or(0, |(i, c)| i + c.len_utf8());
        if text[start..].chars().count() >= 2 {
            return Some(text);
        }
        if start == 0 {
            return None;
        }
        text = text[..start].trim_end_matches(|c: char| !c.is_alphanumeric());
    }
}

/// `key:value` with a known-shaped key (ASCII letters), the value unquoted.
fn qualifier(t: &str) -> Option<(String, String)> {
    let (key, value) = t.split_once(':')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some((key.to_ascii_lowercase(), unquote(value).trim().to_owned()))
}

fn unquote(s: &str) -> &str {
    let s = s.strip_prefix('"').unwrap_or(s);
    s.strip_suffix('"').unwrap_or(s)
}

/// Splits on whitespace outside double quotes. An unclosed quote runs to the end.
fn tokens(q: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = None;
    let mut quoted = false;
    for (i, c) in q.char_indices() {
        if c == '"' {
            quoted = !quoted;
        }
        if c.is_whitespace() && !quoted {
            if let Some(s) = start.take() {
                out.push(&q[s..i]);
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push(&q[s..]);
    }
    out
}
