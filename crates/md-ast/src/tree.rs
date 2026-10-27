//! ammonia's output read back into a tree. ammonia serialises a well-formed fragment (html5ever's
//! serialiser: every element closed but the void ones, text and attributes escaped), so its
//! tokens nest as they come and a stack is all the tree building it needs.
//!
//! The tree never nests deeper than [`MAX_DEPTH`]: an element that would is left out, and what's
//! inside it goes to the deepest element kept. And before ammonia, [`within_bounds`] reads
//! comrak's HTML the same way, to keep raw HTML that nests too deep or has too many elements away
//! from html5ever's tree builder, which is quadratic in nesting.

use crate::work::{tag_work, tally};
use crate::{MAX_DEPTH, MAX_NODES};
use html5ever::TokenizerResult;
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    BufferQueue, CharacterTokens, TagKind, TagToken, Token, TokenSink, TokenSinkResult, Tokenizer,
    TokenizerOpts,
};
use std::cell::{Cell, RefCell};

pub(crate) enum Node {
    Text(String),
    El(El),
}

pub(crate) struct El {
    pub tag: String,
    /// In source order.
    pub attrs: Vec<(String, String)>,
    pub kids: Vec<Node>,
}

/// Elements with no end tag.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

struct Sink {
    /// The open elements; the bottom one stands for the fragment.
    open: RefCell<Vec<El>>,
    /// Elements opened past [`MAX_DEPTH`] and left out, not closed yet: the next end tags are
    /// theirs.
    skipped: Cell<usize>,
}

impl Sink {
    fn push(&self, node: Node) {
        let mut open = self.open.borrow_mut();
        let kids = &mut open.last_mut().expect("the fragment is always open").kids;
        match (kids.last_mut(), node) {
            (Some(Node::Text(have)), Node::Text(more)) => have.push_str(&more),
            (_, node) => kids.push(node),
        }
    }

    fn close(&self, tag: &str) {
        if self.skipped.get() > 0 {
            self.skipped.set(self.skipped.get() - 1);
            return;
        }
        let mut open = self.open.borrow_mut();
        // An end tag with no element open for it isn't in well-formed input: ignore it.
        if open.len() > 1 && open.last().is_some_and(|e| e.tag == tag) {
            let done = open.pop().expect("checked");
            drop(open);
            self.push(Node::El(done));
        }
    }
}

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        match token {
            TagToken(t) => {
                let tag = t.name.to_string();
                match t.kind {
                    TagKind::StartTag => {
                        let el = El {
                            attrs: t
                                .attrs
                                .into_iter()
                                .map(|a| (a.name.local.to_string(), a.value.to_string()))
                                .collect(),
                            tag,
                            kids: Vec::new(),
                        };
                        if VOID.contains(&el.tag.as_str()) {
                            self.push(Node::El(el));
                        } else if self.skipped.get() > 0 || self.open.borrow().len() > MAX_DEPTH {
                            // The fragment's own entry doesn't count.
                            self.skipped.set(self.skipped.get() + 1);
                        } else {
                            self.open.borrow_mut().push(el);
                        }
                    }
                    TagKind::EndTag => self.close(&tag),
                }
            }
            CharacterTokens(s) => self.push(Node::Text(s.to_string())),
            // Comments are stripped and nothing else carries content.
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

/// The nodes of a serialised fragment.
pub(crate) fn parse(html: &str) -> Vec<Node> {
    let sink = Sink {
        open: RefCell::new(vec![El {
            tag: String::new(),
            attrs: Vec::new(),
            kids: Vec::new(),
        }]),
        skipped: Cell::new(0),
    };
    let tok = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    while let TokenizerResult::Script(()) = tok.feed(&input) {}
    tok.end();
    let mut open = tok.sink.open.into_inner();
    // Close anything left open (not in well-formed input) into its parent.
    while open.len() > 1 {
        let el = open.pop().expect("checked");
        open.last_mut().expect("checked").kids.push(Node::El(el));
    }
    open.pop().map(|root| root.kids).unwrap_or_default()
}

/// The elements an HTML parser reopens when what's inside them is closed by something else
/// (`<div><b></div>x`: the `x` is bold): its "active formatting elements".
const FORMATTING: &[&str] = &[
    "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u",
];

/// Reads HTML for its shape alone, from its tags, erring on the deep and large side: how deep
/// html5ever's tree would nest and how many elements it would make. An end tag closes the
/// nearest open element of its name and everything opened after it; a formatting element closed
/// that way stays "dangling", and html5ever reopens every dangling one before each later start
/// tag and text, until an end tag of its own name comes. And a formatting element closed with a
/// block open inside it closes nothing (the adoption agency's furthest block).
struct Shape {
    open: RefCell<Vec<String>>,
    dangling: RefCell<Vec<String>>,
    elements: Cell<usize>,
    over: Cell<bool>,
}

impl Shape {
    /// A start tag or text: the dangling elements are reopened in it.
    fn reopen(&self) {
        let n = self.dangling.borrow().len();
        tally(n);
        self.elements.set(self.elements.get() + n);
    }
}

impl TokenSink for Shape {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        // The tokenizer did its work on the token whether or not it's looked at.
        match &token {
            TagToken(t) => tally(tag_work(t.attrs.len())),
            _ => tally(1),
        }
        if self.over.get() {
            return TokenSinkResult::Continue;
        }
        match token {
            TagToken(t) => match t.kind {
                TagKind::StartTag => {
                    self.reopen();
                    self.elements.set(self.elements.get() + 1);
                    if !t.self_closing && !VOID.contains(&&*t.name) {
                        self.open.borrow_mut().push(t.name.to_string());
                    }
                }
                TagKind::EndTag => {
                    let mut open = self.open.borrow_mut();
                    let mut dangling = self.dangling.borrow_mut();
                    let formatting = |o: &str| FORMATTING.contains(&o);
                    match open.iter().rposition(|o| *o == *t.name) {
                        Some(at)
                            if formatting(&t.name)
                                && open[at + 1..].iter().any(|o| !formatting(o)) =>
                        {
                            // A formatting element closed around a block (`<b><div></b>`): the
                            // parser's adoption agency keeps the block open and clones the
                            // formatting element into it. Nothing closes, then, and every
                            // element open inside it may be made again.
                            self.elements.set(self.elements.get() + open.len() - at);
                        }
                        Some(at) => {
                            // The element itself is closed; the formatting ones inside it dangle.
                            dangling.extend(open.drain(at..).skip(1).filter(|o| formatting(o)));
                        }
                        None => {
                            if let Some(at) = dangling.iter().rposition(|o| *o == *t.name) {
                                dangling.remove(at);
                            }
                        }
                    }
                }
            },
            CharacterTokens(_) => self.reopen(),
            _ => {}
        }
        tally(self.open.borrow().len());
        let depth = self.open.borrow().len() + self.dangling.borrow().len();
        if depth > MAX_DEPTH || self.elements.get() > MAX_NODES {
            self.over.set(true);
        }
        TokenSinkResult::Continue
    }
}

/// Whether `html` nests at most [`MAX_DEPTH`] deep and has at most [`MAX_NODES`] elements, as
/// its tags say.
pub(crate) fn within_bounds(html: &str) -> bool {
    let sink = Shape {
        open: RefCell::new(Vec::new()),
        dangling: RefCell::new(Vec::new()),
        elements: Cell::new(0),
        over: Cell::new(false),
    };
    let tok = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    while let TokenizerResult::Script(()) = tok.feed(&input) {}
    tok.end();
    !tok.sink.over.get()
}

/// What an HTML parser will be asked to do with `html`, in work units (`work.rs`): each tag, its
/// attributes compared with each other, and each element as deep as it nests. It reads `html` as
/// html5ever's tree builder has its tokenizer read it, switching to raw text inside `<script>`,
/// `<textarea>` and the like, and nests as the tags say. Only the scaling tests ask: it's how
/// they see work the checks let through to ammonia.
#[cfg(test)]
pub(crate) fn parser_work(html: &str) -> usize {
    use html5ever::tokenizer::states::RawKind;

    struct Parser {
        open: RefCell<Vec<String>>,
        work: Cell<usize>,
    }

    impl TokenSink for Parser {
        type Handle = ();

        fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
            let TagToken(t) = token else {
                self.work.set(self.work.get() + 1);
                return TokenSinkResult::Continue;
            };
            let mut open = self.open.borrow_mut();
            let work = tag_work(t.attrs.len()) + open.len();
            self.work.set(self.work.get() + work);
            if t.kind == TagKind::EndTag {
                if let Some(at) = open.iter().rposition(|o| *o == *t.name) {
                    open.truncate(at);
                }
                return TokenSinkResult::Continue;
            }
            if !t.self_closing && !VOID.contains(&&*t.name) {
                open.push(t.name.to_string());
            }
            match &*t.name {
                "script" => TokenSinkResult::RawData(RawKind::ScriptData),
                "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => {
                    TokenSinkResult::RawData(RawKind::Rawtext)
                }
                "textarea" | "title" => TokenSinkResult::RawData(RawKind::Rcdata),
                "plaintext" => TokenSinkResult::Plaintext,
                _ => TokenSinkResult::Continue,
            }
        }
    }

    let sink = Parser {
        open: RefCell::new(Vec::new()),
        work: Cell::new(0),
    };
    let tok = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(html));
    while let TokenizerResult::Script(()) = tok.feed(&input) {}
    tok.end();
    tok.sink.work.get()
}
