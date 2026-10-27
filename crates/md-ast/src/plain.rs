//! What links in a post shown as plain text, read from its Markdown alone, in one pass: what a
//! rendering would link, about. References in running text (`refs.rs`) and bare links to an
//! issue or PR link; nothing in code does, nor anything inside another link.
//!
//! Code is backtick spans and fenced blocks, found as CommonMark finds them but for what only a
//! full parse knows: a fence inside a block quote or list item, an indented code block, and a
//! backslash before a backtick. A link is an `http(s)://` URL as GitHub's autolinking ends one.

use crate::ast::github_item;
use crate::refs::{self, Found};
use crate::work::tally;
use std::collections::HashMap;

/// A link in a post shown as plain text.
pub(crate) enum Link<'t> {
    /// A reference in running text.
    Found(Found<'t>),
    /// A bare link to an issue or PR (`owner`, `repo`, `number`), or to one of its comments.
    Item(String, String, i64, Option<i64>),
}

/// Every link in `md`, with its byte span, in order.
pub(crate) fn links(md: &str) -> Vec<(usize, usize, Link<'_>)> {
    let mut out = Vec::new();
    let mut at = 0;
    for (start, end) in code(md) {
        prose(md, at, start, &mut out);
        at = end;
    }
    prose(md, at, md.len(), &mut out);
    out
}

/// The links in `md[from..to]`, which holds no code.
fn prose<'t>(md: &'t str, from: usize, to: usize, out: &mut Vec<(usize, usize, Link<'t>)>) {
    let mut at = from;
    let mut search = from;
    while let Some(off) = md[search..to].find("http") {
        let start = search + off;
        search = start + 4;
        let rest = &md[start..to];
        if !(rest.starts_with("https://") || rest.starts_with("http://"))
            || md[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
        {
            continue;
        }
        let end = start + url_len(rest);
        for (s, e, found) in refs::scan(&md[at..start]) {
            out.push((at + s, at + e, Link::Found(found)));
        }
        if let Some((o, r, n, c)) = github_item(&md[start..end]) {
            out.push((start, end, Link::Item(o, r, n, c)));
        }
        // Any other URL is a link of its own: nothing in it is a reference.
        at = end;
        search = end;
    }
    for (s, e, found) in refs::scan(&md[at..to]) {
        out.push((at + s, at + e, Link::Found(found)));
    }
}

/// How long the URL at the start of `s` is, as GitHub's autolinking ends it: at a space or `<`,
/// less trailing punctuation and any `)` it doesn't open.
fn url_len(s: &str) -> usize {
    let url = &s[..s
        .find(|c: char| c.is_whitespace() || c == '<')
        .unwrap_or(s.len())];
    let mut end = url.len();
    tally(3 * url.len());
    let opened = url.bytes().filter(|c| *c == b'(').count();
    let mut closed = url.bytes().filter(|c| *c == b')').count();
    loop {
        match url.as_bytes()[..end].last() {
            Some(b'?' | b'!' | b'.' | b',' | b':' | b'*' | b'_' | b'~' | b'\'' | b'"') => end -= 1,
            Some(b')') if closed > opened => {
                end -= 1;
                closed -= 1;
            }
            _ => return end,
        }
    }
}

/// The byte spans of `md`'s code, in order: fenced blocks, fences included, and backtick spans,
/// backticks included.
fn code(md: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    // The open fence's character and length, and where the block began.
    let mut fence: Option<(u8, usize, usize)> = None;
    // Where the paragraph (lines between blank lines and blocks) being read began.
    let mut para = 0;
    let mut at = 0;
    for line in md.split_inclusive('\n') {
        let (start, end) = (at, at + line.len());
        tally(line.len());
        at = end;
        let indent = line.bytes().take_while(|c| *c == b' ').count();
        let rest = line[indent.min(line.len())..].trim_end();
        let run = |c: u8| rest.bytes().take_while(|b| *b == c).count();
        if let Some((c, len, from)) = fence {
            // A closing fence: as long as the opening one or longer, and nothing after it.
            if indent < 4 && run(c) >= len && run(c) == rest.len() {
                out.push((from, end));
                fence = None;
                para = end;
            }
            continue;
        }
        let opens = b"`~".iter().copied().find(|c| {
            indent < 4
                && run(*c) >= 3
                // A backtick fence's info string has no backtick.
                && (*c == b'~' || !rest[run(*c)..].contains('`'))
        });
        if let Some(c) = opens {
            spans(md, para, start, &mut out);
            fence = Some((c, run(c), start));
        } else if rest.is_empty() {
            spans(md, para, start, &mut out);
            para = end;
        }
    }
    match fence {
        // An unclosed fence runs to the end.
        Some((_, _, from)) => out.push((from, md.len())),
        None => spans(md, para, md.len(), &mut out),
    }
    out
}

/// The backtick spans in `md[from..to]`, one paragraph: a run of backticks opens one, which the
/// next run of as many closes. Each run is looked at once, so this is linear.
fn spans(md: &str, from: usize, to: usize, out: &mut Vec<(usize, usize)>) {
    let b = &md.as_bytes()[from..to];
    tally(2 * b.len());
    let mut runs = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let len = b[i..].iter().take_while(|c| **c == b'`').count();
        if len > 0 {
            runs.push((from + i, len));
        }
        i += len.max(1);
    }
    // Each run's closer: the next run as long as it.
    let mut next = vec![None; runs.len()];
    let mut seen = HashMap::new();
    for (k, (_, len)) in runs.iter().enumerate().rev() {
        next[k] = seen.insert(*len, k);
    }
    let mut k = 0;
    while k < runs.len() {
        match next[k] {
            Some(close) => {
                let (open, (end, len)) = (runs[k].0, runs[close]);
                out.push((open, end + len));
                k = close + 1;
            }
            None => k += 1,
        }
    }
}
