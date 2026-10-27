//! What a post may be and still render: checked before each stage that would take too long on
//! more. comrak's parse is quadratic in how many block quotes one line opens, and its tables
//! fill in every row's missing cells; html5ever's tree builder, inside ammonia, is quadratic in
//! nesting, and its tokenizer in how many attributes one tag has (each is checked against the
//! tag's others). Each check is linear and cheap, and errs on the side of plain text.

use crate::work::tally;
use crate::{MAX_DEPTH, MAX_INPUT, MAX_NODES};
use comrak::arena_tree::NodeEdge;

/// The Markdown before comrak sees it: not too long, no line opening more than [`MAX_DEPTH`]
/// block quotes and list items, and no table that would fill in more than [`MAX_NODES`] cells.
pub(crate) fn markdown_within(md: &str) -> bool {
    if md.len() > MAX_INPUT {
        return false;
    }
    let lines: Vec<&str> = md.lines().collect();
    // How many non-blank lines follow each line before the next blank one: one pass from the
    // end, so a post of many delimiter-like lines costs no more than one of few.
    let mut following = vec![0usize; lines.len()];
    for i in (0..lines.len().saturating_sub(1)).rev() {
        tally(1);
        following[i] = if lines[i + 1].trim().is_empty() {
            0
        } else {
            following[i + 1] + 1
        };
    }
    for (line, rows) in lines.iter().zip(following) {
        if containers_opened(line) > MAX_DEPTH {
            return false;
        }
        // The table runs to the next blank line at most; every row gets every column.
        let columns = delimiter_row_columns(line);
        if columns > 0 && columns.saturating_mul(rows + 2) > MAX_NODES {
            return false;
        }
    }
    true
}

/// How many block quotes and list items `line` opens before its content, at most. A thematic
/// break (`- - -`, `* * *`) where a list item could start is content: it opens nothing.
fn containers_opened(line: &str) -> usize {
    let b = line.as_bytes();
    // The markers' two passes, then the one over the containers.
    tally(3 * b.len() + 1);
    let blank = |i: usize| b.get(i).is_none_or(|c| matches!(c, b' ' | b'\t'));
    // For `-` and `*`: the last byte that is neither it nor a space, and how many there are of it.
    let marker = |m: u8| {
        let last_other = b
            .iter()
            .rposition(|c| *c != m && !matches!(c, b' ' | b'\t'));
        (last_other, b.iter().filter(|c| **c == m).count())
    };
    let (dash, star) = (marker(b'-'), marker(b'*'));
    // How many `-` and `*` come before `i`, counted up to `counted`.
    let (mut counted, mut dashes, mut stars) = (0, 0, 0);
    let (mut i, mut n) = (0, 0);
    while i < b.len() {
        match b[i] {
            b' ' | b'\t' => i += 1,
            b'>' => {
                n += 1;
                i += 1;
            }
            c @ (b'-' | b'*') if blank(i + 1) => {
                for c in &b[counted..i] {
                    dashes += usize::from(*c == b'-');
                    stars += usize::from(*c == b'*');
                }
                counted = i;
                let ((last_other, total), before) = if c == b'-' {
                    (dash, dashes)
                } else {
                    (star, stars)
                };
                // The rest of the line is this marker and spaces, three or more: a break.
                if last_other.is_none_or(|l| l < i) && total - before >= 3 {
                    break;
                }
                n += 1;
                i += 1;
            }
            b'0'..=b'9' => {
                let digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
                let after = i + digits;
                if digits > 9 || !matches!(b.get(after), Some(b'.' | b')')) || !blank(after + 1) {
                    break;
                }
                n += 1;
                i = after + 1;
            }
            _ => break,
        }
    }
    n
}

/// If `line` could be a table's delimiter row (`|---|:-:|`), how many columns it has; else 0.
fn delimiter_row_columns(line: &str) -> usize {
    let t = line.trim();
    tally(t.len() + 1);
    if !t.contains('|') || !t.contains('-') || !t.bytes().all(|c| b"|:- \t".contains(&c)) {
        return 0;
    }
    t.trim_matches('|')
        .split('|')
        .filter(|cell| cell.contains('-'))
        .count()
}

/// comrak's tree, before it's written out: at most [`MAX_DEPTH`] deep and [`MAX_NODES`] nodes.
pub(crate) fn document_within<'a>(root: comrak::Node<'a>) -> bool {
    let (mut depth, mut nodes) = (0usize, 0usize);
    for edge in root.traverse() {
        match edge {
            NodeEdge::Start(_) => {
                tally(1);
                depth += 1;
                nodes += 1;
                // The document node itself doesn't count.
                if depth > MAX_DEPTH + 1 || nodes > MAX_NODES + 1 {
                    return false;
                }
            }
            NodeEdge::End(_) => depth -= 1,
        }
    }
    true
}

/// The most attributes one tag in comrak's HTML may have: past it, the post is plain text.
/// GitHub's allowlist keeps at most seven on any element.
pub(crate) const MAX_ATTRS: usize = 64;

/// The longest one tag in comrak's HTML may be, in bytes, `<` to `>`.
pub(crate) const MAX_TAG: usize = 4 << 10;

/// Elements whose content an HTML parser reads as text, not tags, until their end tag: html5ever's
/// tree builder switches its tokenizer into raw text for them. A check reading tags throughout
/// would see tags inside them that aren't, and miss ones after them that are, so a post with one
/// is plain text. The sanitiser drops them all anyway.
const RAW_TEXT: &[&str] = &[
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
];

/// comrak's HTML before any HTML parser sees it: no tag, start or end, with more than
/// [`MAX_ATTRS`] attributes or longer than [`MAX_TAG`], and no raw-text element ([`RAW_TEXT`]).
/// One pass over the bytes, reading tags as an HTML tokenizer would and erring on the side of
/// plain text:
///
/// - A `<` or `</` and a letter starts a tag here wherever it is, a comment included: a tag read
///   where a tokenizer reads none only adds to what's checked.
/// - A quoted value with a `<` and a letter, `/`, `!` or `?` in it is plain text. Read from a tag
///   that's no tag (inside a comment), the quote can run past a real tag, which then goes
///   unchecked.
/// - So every tag a tokenizer reads, this reads too, with all its attributes.
pub(crate) fn html_within(html: &str) -> bool {
    let b = html.as_bytes();
    let space = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c');
    let mut i = 0;
    while let Some(off) = b[i..].iter().position(|c| *c == b'<') {
        let start = i + off;
        i = start + 1;
        let end_tag = b.get(i) == Some(&b'/');
        if end_tag {
            i += 1;
        }
        if !b.get(i).is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        tally(1);
        // The tag's name.
        let name = i;
        while i < b.len() && !space(b[i]) && b[i] != b'/' && b[i] != b'>' {
            i += 1;
        }
        if !end_tag
            && RAW_TEXT
                .iter()
                .any(|r| r.as_bytes().eq_ignore_ascii_case(&b[name..i]))
        {
            return false;
        }
        let mut attrs = 0;
        loop {
            while i < b.len() && (space(b[i]) || b[i] == b'/') {
                i += 1;
            }
            if i >= b.len() || b[i] == b'>' {
                break;
            }
            // An attribute's name, then its value if it has one.
            attrs += 1;
            tally(1);
            i += 1;
            while i < b.len() && !space(b[i]) && !matches!(b[i], b'/' | b'>' | b'=') {
                i += 1;
            }
            while i < b.len() && space(b[i]) {
                i += 1;
            }
            if b.get(i) == Some(&b'=') {
                i += 1;
                while i < b.len() && space(b[i]) {
                    i += 1;
                }
                match b.get(i) {
                    Some(&q @ (b'"' | b'\'')) => {
                        let value = i + 1;
                        let len = b[value..].iter().position(|c| *c == q);
                        let value = &b[value..len.map_or(b.len(), |l| value + l)];
                        if value.windows(2).any(|w| {
                            w[0] == b'<' && (w[1].is_ascii_alphabetic() || b"/!?".contains(&w[1]))
                        }) {
                            return false;
                        }
                        i += value.len() + 2;
                    }
                    _ => {
                        while i < b.len() && !space(b[i]) && b[i] != b'>' {
                            i += 1;
                        }
                    }
                }
            }
            if attrs > MAX_ATTRS || i.min(b.len()) - start > MAX_TAG {
                return false;
            }
        }
        if i.min(b.len()) - start > MAX_TAG {
            return false;
        }
        i = i.min(b.len());
    }
    true
}
