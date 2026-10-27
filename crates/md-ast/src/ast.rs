//! The sanitised tree to the compact AST, with the post-passes.
//!
//! - An element is `[tag, attrs | 0, ...children]`, and text is a plain string. Whitespace
//!   between blocks, which only the HTML needed, is dropped.
//! - References are `["ref", {o, r, n}]` (an issue or PR), `["ref", {u}]` (a user) and
//!   `["ref", {t: "org/team"}]` (a team), with no children: the client words them.
//! - A bare link to an issue or PR on GitHub (its text is its URL) is a reference too, as on
//!   GitHub; a bare link to one of its comments (`#issuecomment-c`) is `["ref", {o, r, n, c}]`,
//!   which GitHub shows as `#n (comment)`. A link with text of its own stays a link, and its
//!   target is listed in [`Rendered::items`] so the client can open it in-app.
//! - Every `id` and `name`, and every `#fragment` link, gets the post's prefix.
//! - Relative URLs resolve against the issue's page on github.com. A URL that then isn't
//!   http(s) or mailto is dropped (ammonia already dropped such absolute ones).

use crate::refs::{self, Found, MAX_NUMBER};
use crate::tree::{El, Node};
use crate::{Context, ItemRef, MAX_JSON, MAX_NODES, Rendered};
use ammonia::url::Url;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// Elements whose neighbouring whitespace is layout in the HTML only.
const BLOCKS: &[&str] = &[
    "blockquote",
    "caption",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

/// Text inside these is never scanned for references.
const VERBATIM: &[&str] = &["a", "code", "pre"];

struct Pass<'c> {
    ctx: &'c Context<'c>,
    /// The issue's page on GitHub, for relative URLs.
    base: Option<Url>,
    items: Vec<ItemRef>,
    seen: HashSet<String>,
    /// Elements made so far, `ref` nodes included.
    made: usize,
    /// The bytes of JSON made so far, about: at most [`MAX_JSON`] go out.
    bytes: usize,
}

/// The AST, or `None` if it would have more than [`MAX_NODES`] elements or [`MAX_JSON`] bytes:
/// references, prefixed ids and resolved URLs multiply what the Markdown makes.
pub(crate) fn build(nodes: Vec<Node>, ctx: &Context) -> Option<Rendered> {
    let mut pass = Pass::new(ctx);
    let ast = pass.children(nodes, "", false);
    pass.within().then_some(Rendered {
        ast,
        items: pass.items,
    })
}

/// `md` as plain text with its references made `ref` nodes, as a rendering would make them: in
/// running text, and bare links to an issue or PR; not in code (backtick spans and fenced
/// blocks, as `plain.rs` finds them) nor inside other links. Past [`MAX_NODES`] references, or
/// [`MAX_JSON`] bytes, the rest is text: the first are still links. Unlike a rendering's, the
/// text itself always goes out, however much JSON it makes.
pub(crate) fn plain_text(md: &str, ctx: &Context) -> (Vec<Value>, Vec<ItemRef>) {
    let mut pass = Pass::new(ctx);
    let mut out = Vec::new();
    let mut at = 0;
    for (start, end, link) in crate::plain::links(md) {
        // Room for this reference, its text before it, and the `ref` it makes, about.
        if pass.made >= MAX_NODES || pass.bytes + json_len(&md[at..start]) + 64 > MAX_JSON {
            break;
        }
        if start > at {
            let v = pass.string(md[at..start].to_owned());
            out.push(v);
        }
        let v = match link {
            crate::plain::Link::Found(found) => pass.found(found),
            crate::plain::Link::Item(o, r, n, c) => pass.issue(&o, &r, n, c),
        };
        out.push(v);
        at = end;
    }
    if at < md.len() {
        let v = pass.string(md[at..].to_owned());
        out.push(v);
    }
    (out, pass.items)
}

impl<'c> Pass<'c> {
    fn new(ctx: &'c Context<'c>) -> Pass<'c> {
        Pass {
            ctx,
            base: Url::parse(&format!(
                "https://github.com/{}/{}/issues/{}",
                ctx.owner, ctx.repo, ctx.number
            ))
            .ok(),
            items: Vec::new(),
            seen: HashSet::new(),
            made: 0,
            bytes: 0,
        }
    }

    fn within(&self) -> bool {
        self.made <= MAX_NODES && self.bytes <= MAX_JSON
    }

    /// `s` as a string in the AST: counted, then made.
    fn string(&mut self, s: String) -> Value {
        self.bytes += json_len(&s) + 1;
        Value::String(s)
    }

    /// A `ref` node: counted, then made.
    fn reference(&mut self, v: Value) -> Value {
        self.made += 1;
        self.bytes += v.to_string().len() + 1;
        v
    }
}

/// How long `s` is as a JSON string, at most: quotes and escapes included.
fn json_len(s: &str) -> usize {
    let escapes: usize = s
        .bytes()
        .map(|b| match b {
            b'"' | b'\\' => 1,
            0..=0x1f => 5,
            _ => 0,
        })
        .sum();
    s.len() + 2 + escapes
}

fn is_block(n: Option<&Node>) -> bool {
    match n {
        None => true,
        Some(Node::El(e)) => BLOCKS.contains(&e.tag.as_str()),
        Some(Node::Text(_)) => false,
    }
}

/// A number as a reference may have one: past [`MAX_NUMBER`], a browser can't hold it exactly.
fn number(n: &str) -> Option<i64> {
    n.parse().ok().filter(|n| (1..=MAX_NUMBER).contains(n))
}

/// An issue or PR on GitHub: `owner/repo/(issues|pull)/n` on github.com, and nothing after it but
/// a slash; and the comment, if the fragment names one (`#issuecomment-c`).
pub(crate) fn github_item(href: &str) -> Option<(String, String, i64, Option<i64>)> {
    let url = Url::parse(href).ok()?;
    if url.scheme() != "https" && url.scheme() != "http"
        || url.host_str() != Some("github.com")
        || url.query().is_some()
    {
        return None;
    }
    let comment = match url.fragment() {
        None => None,
        Some(f) => Some(number(f.strip_prefix("issuecomment-")?)?),
    };
    let path: Vec<&str> = url
        .path()
        .trim_end_matches('/')
        .split('/')
        .skip(1)
        .collect();
    match path.as_slice() {
        [o, r, "issues" | "pull", n] => {
            Some(((*o).to_owned(), (*r).to_owned(), number(n)?, comment))
        }
        _ => None,
    }
}

impl Pass<'_> {
    fn item(&mut self, owner: &str, repo: &str, number: i64) {
        let it = ItemRef {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
        };
        if self.seen.insert(it.key()) {
            self.items.push(it);
        }
    }

    fn children(&mut self, kids: Vec<Node>, parent: &str, verbatim: bool) -> Vec<Value> {
        let keep_space = matches!(parent, "pre" | "code");
        let dropped: Vec<bool> = (0..kids.len())
            .map(|i| match &kids[i] {
                Node::Text(t) => {
                    !keep_space
                        && t.chars().all(char::is_whitespace)
                        && is_block(i.checked_sub(1).and_then(|p| kids.get(p)))
                        && is_block(kids.get(i + 1))
                }
                Node::El(_) => false,
            })
            .collect();
        let mut out = Vec::with_capacity(kids.len());
        for (n, dropped) in kids.into_iter().zip(dropped) {
            // Past a bound, what's made is thrown away: stop making it.
            if !self.within() {
                break;
            }
            match n {
                _ if dropped => {}
                Node::Text(t) if verbatim => {
                    let v = self.string(t);
                    out.push(v);
                }
                Node::Text(t) => self.text(&t, &mut out),
                Node::El(e) => out.push(self.element(e, verbatim)),
            }
        }
        out
    }

    /// Text, with its references made `ref` nodes.
    fn text(&mut self, t: &str, out: &mut Vec<Value>) {
        let mut at = 0;
        for (start, end, found) in refs::scan(t) {
            if !self.within() {
                return;
            }
            if start > at {
                let v = self.string(t[at..start].to_owned());
                out.push(v);
            }
            let v = self.found(found);
            out.push(v);
            at = end;
        }
        if at < t.len() {
            let v = self.string(t[at..].to_owned());
            out.push(v);
        }
    }

    /// A reference found in text, as a `ref` node: counted, and its item listed.
    fn found(&mut self, found: Found) -> Value {
        let node = match found {
            Found::Issue { repo, number } => {
                let (o, r) = repo.unwrap_or((self.ctx.owner, self.ctx.repo));
                self.item(o, r, number);
                json!(["ref", { "o": o, "r": r, "n": number }])
            }
            Found::User(u) => json!(["ref", { "u": u }]),
            Found::Team(t) => json!(["ref", { "t": t }]),
        };
        self.reference(node)
    }

    /// A bare link to an issue or PR, or to comment `c` on one, as a `ref` node: counted, and its
    /// item listed.
    fn issue(&mut self, o: &str, r: &str, n: i64, c: Option<i64>) -> Value {
        self.item(o, r, n);
        self.reference(match c {
            None => json!(["ref", { "o": o, "r": r, "n": n }]),
            Some(c) => json!(["ref", { "o": o, "r": r, "n": n, "c": c }]),
        })
    }

    /// A URL as the browser may follow it, or `None` to drop the attribute.
    fn url(&self, v: &str, fragments: bool) -> Option<String> {
        let v = v.trim();
        if let Some(frag) = v.strip_prefix('#') {
            return fragments.then(|| format!("#{}{frag}", self.ctx.id_prefix));
        }
        let url = match Url::parse(v) {
            Ok(u) => u,
            Err(_) => self.base.as_ref()?.join(v).ok()?,
        };
        matches!(url.scheme(), "http" | "https" | "mailto").then(|| url.to_string())
    }

    /// `srcset`, each candidate's URL as [`Pass::url`] keeps it, or `None` if any isn't kept.
    fn srcset(&self, v: &str) -> Option<String> {
        let mut out = Vec::new();
        for candidate in v.split(',') {
            let mut parts = candidate.split_whitespace();
            let url = self.url(parts.next()?, false)?;
            out.push(
                std::iter::once(url)
                    .chain(parts.map(str::to_owned))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        Some(out.join(", "))
    }

    fn element(&mut self, e: El, verbatim: bool) -> Value {
        self.made += 1;
        let El { tag, attrs, kids } = e;
        let mut map = Map::new();
        let mut written_href = None;
        for (name, value) in attrs {
            let kept = match name.as_str() {
                // TODO(#100): an image's `src` and `srcset` go out as written, so the browser
                // loads it from its host, which sees the viewer's IP, until the image proxy.
                "href" | "src" | "cite" => self.url(&value, name == "href"),
                "srcset" => self.srcset(&value),
                "id" | "name" => Some(format!("{}{value}", self.ctx.id_prefix)),
                _ => Some(value.clone()),
            };
            if name == "href" {
                written_href = Some(value);
            }
            if let Some(v) = kept {
                map.insert(name, Value::String(v));
            }
        }
        if tag == "a"
            && let Some(href) = map.get("href").and_then(Value::as_str)
            && let Some((o, r, n, comment)) = github_item(href)
        {
            // Its text is its URL (an autolink): GitHub shows it as a reference.
            if matches!(kids.as_slice(), [Node::Text(t)] if Some(t) == written_href.as_ref()) {
                // Counted as a `ref`, not the element it stands for.
                self.made -= 1;
                return self.issue(&o, &r, n, comment);
            }
            self.item(&o, &r, n);
        }
        // `["tag",0,` and `]`, or the attributes' `{"k":"v",…}`.
        self.bytes += json_len(&tag) + 4;
        self.bytes += map
            .iter()
            .map(|(k, v)| json_len(k) + v.as_str().map_or(0, json_len) + 2)
            .sum::<usize>();
        let verbatim = verbatim || VERBATIM.contains(&tag.as_str());
        let kids = self.children(kids, &tag, verbatim);
        let mut node = Vec::with_capacity(kids.len() + 2);
        node.push(Value::String(tag));
        node.push(if map.is_empty() {
            Value::from(0)
        } else {
            Value::Object(map)
        });
        node.extend(kids);
        Value::Array(node)
    }
}
