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

/// The first judging or comparing word or phrase in `text`, as written there.
pub(crate) fn judging(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
        .filter(|w| !w.is_empty())
        .collect();
    for (i, w) in words.iter().enumerate() {
        let w = w.replace('’', "'");
        if WORDS.contains(&w.as_str()) {
            return Some(w);
        }
        if let Some(next) = words.get(i + 1)
            && PHRASES.iter().any(|[a, b]| *a == w && b == next)
        {
            return Some(format!("{w} {next}"));
        }
    }
    None
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
