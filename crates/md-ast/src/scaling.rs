//! The bounds keep the work in proportion to the post, whatever its shape: a post GitHub accepts
//! never takes seconds to turn away or to render. Each case renders one shape at two lengths, 8
//! times apart, and asserts the work done (`work.rs`) grows at most 16 times: 8 for the length,
//! and room for a post that crosses a bound on the way (rendered at one length, plain text at the
//! other, which does both). Work that grows with the square of the length grows 64 times; the
//! shapes below once grew it 48 to 64 times.
//!
//! **An exception to "tests go through public seams"** (AGENTS.md): work units are counted inside
//! the crate, where the checks and the parsers behind them run, and no HTTP answer shows them. A
//! count is the same on every run, where a time on a busy machine isn't.

use crate::work::take;
use crate::{Context, render};

const CTX: Context = Context {
    owner: "acme",
    repo: "web",
    number: 5,
    id_prefix: "c9-",
};

/// The smaller length tried; the larger is 8 times it.
const LEN: usize = 16 << 10;

/// The work rendering `md` takes.
fn work(md: &str) -> usize {
    take();
    render(md, &CTX);
    take()
}

/// Asserts the work for `shape` at 8 times [`LEN`] is at most 16 times that at [`LEN`], plus a
/// little: linear, give or take a bound crossed and what every post costs.
fn linear(name: &str, shape: impl Fn(usize) -> String) {
    let (small, large) = (shape(LEN), shape(8 * LEN));
    let (ws, wl) = (work(&small), work(&large));
    assert!(
        wl <= 16 * ws + 2_000,
        "{name}: {wl} units at {} bytes against {ws} at {}",
        large.len(),
        small.len()
    );
}

/// `unit` repeated to `len` bytes, cut off there.
fn fill(unit: &str, len: usize) -> String {
    unit.repeat(len / unit.len() + 1)[..len].to_owned()
}

/// `head`, then ` a0 a1 …` to `len` bytes, then `>`: a tag with ever more attributes.
fn attrs_after(head: &str, len: usize) -> String {
    let mut s = head.to_owned();
    let mut i = 0;
    while s.len() < len {
        s += &format!(" a{i}");
        i += 1;
    }
    s + ">"
}

/// `<div>`, then each `unit` (which opens a quoted value) followed by 4,000 bytes of `<div>` and
/// `close`, to `len` bytes: real nesting an HTML parser sees and a check that misread the quote
/// wouldn't.
fn hidden_nesting(unit: &str, close: &str, len: usize) -> String {
    let mut s = "<div>\n".to_owned();
    while s.len() + 4_200 < len {
        s += unit;
        s += &"<div>".repeat(800);
        s += close;
    }
    s
}

#[test]
fn table_delimiter_lines() {
    // Every `|-` line could be a table's delimiter row, which runs to the next blank line.
    linear("delimiter lines", |len| fill("|-\n", len));
}

#[test]
fn attributes_on_a_start_tag() {
    // An HTML tokenizer compares each attribute with the tag's others.
    linear("start tag", |len| attrs_after("<div>\n<p", len));
}

#[test]
fn attributes_on_an_end_tag() {
    // An end tag's attributes are parsed, compared and thrown away.
    linear("end tag", |len| attrs_after("<div>\n</p", len));
}

#[test]
fn a_quoted_value_that_swallows_a_comments_end() {
    // To a tokenizer, ` --><p x=` is a comment's end and a tag; read as a tag from the comment's
    // `<b`, it's one quoted value, and the `<p`'s attributes are text.
    linear("comment", |len| {
        attrs_after("<div>\n<!-- <b a=' --><p x='>'", len)
    });
}

#[test]
fn a_quoted_value_that_swallows_a_scripts_end() {
    linear("script", |len| {
        attrs_after("<script><b a='</script><p x='>'", len)
    });
    linear("textarea", |len| {
        attrs_after("<div>\n<textarea><b a='</textarea><p x='>'", len)
    });
}

#[test]
fn nesting_hidden_in_raw_text() {
    // Inside `<script>` or `<textarea>`, `<b a='` is text, and the `<div>`s after the end tag
    // nest; read as tags throughout, they're one attribute's value.
    linear("script, deep", |len| {
        hidden_nesting("<script><b a='</script>", "'></b></script>", len)
    });
    linear("textarea, deep", |len| {
        hidden_nesting("<textarea><b a='</textarea>", "'></b></textarea>", len)
    });
}

#[test]
fn misnested_formatting_around_blocks() {
    // `</b>` with a `<div>` open inside the `<b>`: the parser's adoption agency keeps the `div`
    // open and clones the `b` into it, so each repeat nests deeper, though the tags never do.
    linear("misnested", |len| fill("<b><div></b>", len));
}

#[test]
fn nesting_and_many_elements() {
    linear("divs", |len| fill("<div>", len));
    linear("quotes", |len| fill(">", len));
    linear("links", |len| fill("[a](b) ", len));
    linear("references", |len| fill("#1 @a ", len));
    linear("footnotes", |len| fill("[^1] ", len) + "\n\n[^1]: x\n");
    linear("table", |len| {
        "| a | b |\n|---|---|\n".to_owned() + &fill("| x | y |\n", len)
    });
}

#[test]
fn a_post_shown_as_plain_text() {
    // A line of 101 block quotes is past the bounds: the rest shows as plain text, its links
    // found in one pass.
    let plain = |unit: &'static str| move |len: usize| ">".repeat(101) + "\n\n" + &fill(unit, len);
    linear("references", plain("#1 @a acme/web#2 "));
    linear(
        "URLs",
        plain("https://github.com/acme/web/issues/1 x.io/http://a "),
    );
    linear("backticks", plain("` `` ``` x "));
    linear("fences", plain("```\n#1\n"));
    linear("one long URL", |len| {
        ">".repeat(101) + "\n\nhttps://x.io/" + &".)".repeat(len / 2)
    });
}
