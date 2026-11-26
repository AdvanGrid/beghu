//! Judging and comparing words (principle 3: observe and report), and generic line data.

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

/// The first judging or comparing word or phrase in `text`, as written there. Code isn't prose:
/// words inside a backtick code span (`` `clean_path` ``) and words that are part of an
/// identifier are skipped. An identifier is a token joined by `_`, `-`, `::`, `.` or `/`
/// (`pristine-mirrors`, `clean_path`, `mirror_db::q`, `web/src/mirrors.ts`), or written in mixed
/// case (`CleanPath`, `isClean`), or capitalised inside a sentence (`the Mirrors type`). A
/// hyphenated phrase from the list (`well-designed`) still counts.
pub(crate) fn judging(text: &str) -> Option<String> {
    let mut words: Vec<Option<String>> = Vec::new();
    let mut sentence_start = true;
    for token in prose(text).split_whitespace() {
        let ends_sentence = token.ends_with(['.', '!', '?', ':']);
        let core = token.trim_matches(|c: char| !(c.is_alphanumeric() || c == '_'));
        let parts: Vec<&str> = core
            .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
            .filter(|w| !w.is_empty())
            .collect();
        if identifier(core, sentence_start) {
            // A hyphenated pair from the phrase list reads as prose.
            if let [a, b] = parts[..]
                && core.contains('-')
                && phrase(&a.to_lowercase(), &b.to_lowercase())
            {
                return Some(format!("{} {}", a.to_lowercase(), b.to_lowercase()));
            }
            // An identifier breaks any phrase across it.
            words.push(None);
        } else {
            words.extend(
                parts
                    .iter()
                    .map(|w| Some(w.to_lowercase().replace('’', "'"))),
            );
        }
        sentence_start = ends_sentence || core.is_empty() && sentence_start;
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
fn identifier(token: &str, sentence_start: bool) -> bool {
    let joined = token.contains('_')
        || token.contains("::")
        || token.contains('/')
        || inner(token, '.')
        || inner(token, '-');
    let chars: Vec<char> = token.chars().collect();
    let mixed = chars
        .windows(2)
        .any(|w| w[0].is_lowercase() && w[1].is_uppercase());
    // Capitalised inside a sentence: a type's name (`Mirrors`), not a word. An all-caps word
    // (`NOT`) is emphasis, still prose.
    let named = !sentence_start
        && chars.first().is_some_and(|c| c.is_uppercase())
        && chars.iter().skip(1).any(|c| c.is_lowercase());
    joined || mixed || named
}

/// Whether `sep` joins two alphanumeric runs inside `token`.
fn inner(token: &str, sep: char) -> bool {
    let chars: Vec<char> = token.chars().collect();
    chars
        .windows(3)
        .any(|w| w[1] == sep && w[0].is_alphanumeric() && w[2].is_alphanumeric())
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
