//! The GFM spec run: every non-disabled example of cmark-gfm's `test/spec.txt` (GFM 0.29, commit
//! 27d942c; `gfm/spec.json` is its `spec_tests.py --dump-tests`, trimmed to the fields used here)
//! through the renderer's first stage, compared after cmark-gfm's own `normalize.py`, ported below.
//! It's how docs/research/markdown-rendering.md scored comrak: 665 of 670.
//!
//! **An exception to "tests go through public seams"** (AGENTS.md): 670 examples through Fake
//! GitHub edits and the server's HTTP surface would take minutes, and the spec scores comrak's
//! HTML, which no seam shows. So it runs here, in-crate, against [`to_html`], defined below for
//! it alone. Everything else about rendering is tested over HTTP (crates/server/tests/markdown.rs).
//!
//! The five known fails:
//! - 610, 616, 619 and 620 are plain "Autolinks" examples that expect the autolink extension
//!   off. GitHub, and beghu, render with it on.
//! - 652 expects the tagfilter extension, which comrak removed in 0.56. beghu's sanitiser drops
//!   those tags instead: none is in its allowlist (`sanitise.rs`).

use html5ever::TokenizerResult;
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};
use std::cell::RefCell;
use std::collections::BTreeSet;

#[derive(serde::Deserialize)]
struct Example {
    example: u32,
    markdown: String,
    html: String,
}

/// Stage 1 alone: the Markdown as comrak renders it to HTML, before sanitising.
fn to_html(md: &str) -> String {
    comrak::markdown_to_html(md, &crate::options())
}

fn examples() -> Vec<Example> {
    serde_json::from_str(include_str!("gfm/spec.json")).unwrap()
}

#[test]
fn the_gfm_spec_run_scores_665_of_670_with_the_known_fails() {
    let all = examples();
    assert_eq!(all.len(), 670);
    let fails: BTreeSet<u32> = all
        .iter()
        .filter(|e| normalize(&to_html(&e.markdown)) != normalize(&e.html))
        .map(|e| e.example)
        .collect();
    assert_eq!(fails, BTreeSet::from([610, 616, 619, 620, 652]));
}

#[test]
fn the_gfm_quirks_examples_pass_only_with_gfm_quirks_on() {
    // cmark-gfm's emphasis edge cases: the examples comrak gets wrong without `gfm_quirks`. 476
    // (`***foo***`) sits among them in the spec but isn't one: comrak renders it right either way.
    let quirks = [398, 426, 434, 435, 436, 473, 474, 475, 477];
    let mut off = crate::options();
    off.render.gfm_quirks = false;
    for e in examples().iter().filter(|e| quirks.contains(&e.example)) {
        let want = normalize(&e.html);
        assert_eq!(
            normalize(&to_html(&e.markdown)),
            want,
            "example {}: {:?}",
            e.example,
            e.markdown
        );
        assert_ne!(
            normalize(&comrak::markdown_to_html(&e.markdown, &off)),
            want,
            "example {} passes without gfm_quirks",
            e.example
        );
    }
}

// --- after cmark-gfm's normalize.py -------------------------------------------------------------
//
// Modelled on normalize.py, not a faithful port. Like it, this collapses whitespace runs to one
// space outside `pre`, drops whitespace around block tags and newlines after `<br>`, sorts
// attributes, turns character references into characters (but `<`, `>`, `&` and `"` stay
// escaped), and writes a self-closing tag as a start tag. Unlike it: html5ever's tokenizer stands
// in for Python's HTMLParser, so malformed markup, processing instructions and declarations
// tokenize html5ever's way; and `href` and `src` values aren't percent-decoded and re-encoded.

const BLOCK: &[&str] = &[
    "article",
    "header",
    "aside",
    "hgroup",
    "blockquote",
    "hr",
    "iframe",
    "body",
    "li",
    "map",
    "button",
    "object",
    "canvas",
    "ol",
    "caption",
    "output",
    "col",
    "p",
    "colgroup",
    "pre",
    "dd",
    "progress",
    "div",
    "section",
    "dl",
    "table",
    "td",
    "dt",
    "tbody",
    "embed",
    "textarea",
    "fieldset",
    "tfoot",
    "figcaption",
    "th",
    "figure",
    "thead",
    "footer",
    "tr",
    "form",
    "ul",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "video",
    "script",
    "style",
];

#[derive(PartialEq, Clone, Copy)]
enum Last {
    StartTag,
    EndTag,
    Data,
    Other,
}

struct Normalizer {
    out: String,
    last: Last,
    last_tag: String,
    in_pre: bool,
    /// Text not yet written: the tokenizer splits a run of text, HTMLParser doesn't.
    text: String,
}

fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn collapse(s: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

impl Normalizer {
    fn flush(&mut self) {
        if !self.text.is_empty() {
            let t = std::mem::take(&mut self.text);
            self.data(&t);
        }
    }

    fn data(&mut self, data: &str) {
        let after_tag = matches!(self.last, Last::StartTag | Last::EndTag);
        let after_block = after_tag && BLOCK.contains(&self.last_tag.as_str());
        let mut d = data.to_owned();
        if after_tag && self.last_tag == "br" {
            d = d.trim_start_matches('\n').to_owned();
        }
        if !self.in_pre {
            d = collapse(&d);
        }
        if after_block && !self.in_pre {
            d = match self.last {
                Last::StartTag => d.trim_start().to_owned(),
                _ => d.trim().to_owned(),
            };
        }
        self.out.push_str(&escape_text(&d));
        self.last = Last::Data;
    }

    fn start(&mut self, tag: &str, attrs: &mut [(String, String)]) {
        self.flush();
        if tag == "pre" {
            self.in_pre = true;
        }
        if BLOCK.contains(&tag) {
            self.out.truncate(self.out.trim_end().len());
        }
        self.out.push('<');
        self.out.push_str(tag);
        attrs.sort();
        for (k, v) in attrs.iter() {
            let v = escape_text(v).replace('\'', "&#x27;");
            self.out.push_str(&format!(" {k}=\"{v}\""));
        }
        self.out.push('>');
        self.last_tag = tag.to_owned();
        self.last = Last::StartTag;
    }

    fn end(&mut self, tag: &str) {
        self.flush();
        if tag == "pre" {
            self.in_pre = false;
        } else if BLOCK.contains(&tag) {
            self.out.truncate(self.out.trim_end().len());
        }
        self.out.push_str(&format!("</{tag}>"));
        self.last_tag = tag.to_owned();
        self.last = Last::EndTag;
    }
}

struct Sink(RefCell<Normalizer>);

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        let mut n = self.0.borrow_mut();
        match token {
            Token::TagToken(t) => {
                let tag = t.name.to_string();
                match t.kind {
                    html5ever::tokenizer::TagKind::StartTag => {
                        let mut attrs: Vec<(String, String)> = t
                            .attrs
                            .iter()
                            .map(|a| (a.name.local.to_string(), a.value.to_string()))
                            .collect();
                        n.start(&tag, &mut attrs);
                        if t.self_closing {
                            n.last = Last::EndTag;
                        }
                    }
                    html5ever::tokenizer::TagKind::EndTag => n.end(&tag),
                }
            }
            Token::CharacterTokens(s) => n.text.push_str(&s),
            Token::NullCharacterToken => n.text.push('\0'),
            Token::CommentToken(c) => {
                n.flush();
                n.out.push_str(&format!("<!--{c}-->"));
                n.last = Last::Other;
            }
            Token::DoctypeToken(d) => {
                n.flush();
                let name = d.name.map(|s| s.to_string()).unwrap_or_default();
                n.out.push_str(&format!("<!DOCTYPE {name}>"));
                n.last = Last::Other;
            }
            Token::EOFToken | Token::ParseError(_) => {}
        }
        TokenSinkResult::Continue
    }
}

fn normalize(html: &str) -> String {
    let sink = Sink(RefCell::new(Normalizer {
        out: String::new(),
        last: Last::StartTag,
        last_tag: String::new(),
        in_pre: false,
        text: String::new(),
    }));
    let tok = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    while let TokenizerResult::Script(()) = tok.feed(&input) {}
    tok.end();
    let mut n = tok.sink.0.into_inner();
    n.flush();
    n.out
}
