//! Markdown to beghu's compact AST, on the server (spec, "Markdown and media").
//!
//! A body or comment goes through four stages:
//!
//! 1. comrak, with GitHub's dialect: tables, strikethrough, autolinks, task lists, footnotes and
//!    alerts, `gfm_quirks`, and raw HTML passed through for the next stage.
//! 2. ammonia, with an allowlist modelled on GitHub's (`sanitise.rs`).
//! 3. The sanitised HTML read back into a tree (`tree.rs`).
//! 4. The compact AST (`ast.rs`), `[tag, attrs | 0, ...children]` with text as plain strings,
//!    built with the post-passes: `#n`, `owner/repo#n`, bare issue URLs, `@user` and
//!    `@org/team` become `ref` nodes; ids and in-page links get the post's prefix; relative URLs
//!    resolve against the issue's page on GitHub.
//!
//! The work is bounded (`bounds.rs`, [`MAX_NODES`], [`MAX_JSON`]): a post too large or too
//! deeply nested to render, or one whose rendering panics, comes out as its plain text under a
//! short note instead, what a rendering would link still links (`plain.rs`). Every check is
//! linear, and each keeps what reaches the stage after it linear too, so the bounds cap the time;
//! the scaling tests count the work to show it (`scaling.rs`). Measured in release, best of 5 on
//! a busy machine, the slowest 64 KiB posts (GitHub's limit is 65,536 characters) render in 120
//! to 250 ms: a one-column table of 11,000 rows, 8,000 task items, 9,000 links, 16,000 emphases,
//! 13,000 footnote references (which then pass [`MAX_JSON`]). Most shapes take under 50 ms, posts
//! the checks turn away take under 40 ms, and no 255 KiB post took more than about 250 ms. The
//! AST never nests deeper than [`MAX_DEPTH`], so building, serialising, dropping and walking it
//! are safe on a 2 MiB stack.
//!
//! Nothing here reads a mirror: the same Markdown in the same place renders the same AST, so it
//! can be cached on the Markdown, its place and [`VERSION`] (the server does). Which references
//! the viewer's mirror holds is the caller's question, asked with [`Rendered::items`].
//!
//! Mermaid and math stay code: the dialect has neither, so a ```` ```mermaid ```` block is a code
//! block with its language, and `$x$` is text.

mod ast;
mod bounds;
#[cfg(test)]
mod gfm_spec;
mod plain;
mod refs;
mod sanitise;
#[cfg(test)]
mod scaling;
mod tree;
mod work;

use serde_json::Value;

/// Bumped whenever the same Markdown would render to a different AST: part of a cache key.
pub const VERSION: u32 = 4;

/// How deep a post may nest, in elements, and still render: deeper, it shows as plain text. (A
/// browser's HTML parser stops nesting at 512; a GitHub post never needs a tenth of that.)
pub const MAX_DEPTH: usize = 100;

/// How many elements a post may have and still render: more, and it shows as plain text. comrak's
/// nodes (text included) count, then the HTML's elements, then the AST's: about a 4-column table
/// of 5,500 rows, or a list of 12,000 links.
pub const MAX_NODES: usize = 50_000;

/// The most JSON a post's AST may take, in bytes, about: more, and it shows as plain text.
pub const MAX_JSON: usize = 1 << 20;

/// The longest Markdown rendered, in bytes: GitHub's 65,536 characters at four bytes each.
pub const MAX_INPUT: usize = 4 * 65_536;

/// What a post's rendering depends on besides its text: its place (CONTEXT.md, and the server's
/// `markdown::Place`), as `owner`, `repo` and `number`, and the prefix for its ids.
pub struct Context<'a> {
    /// The place's repo: a bare `#n` means an issue there.
    pub owner: &'a str,
    pub repo: &'a str,
    /// The place's issue or PR: relative links resolve against its page on GitHub.
    pub number: i64,
    /// Put before every id the post defines and every in-page link to one (footnotes, raw
    /// `id`s), so many posts share one page without their ids meeting.
    pub id_prefix: &'a str,
}

/// An issue or PR the AST refers to, as written (GitHub's names are case-insensitive).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ItemRef {
    pub owner: String,
    pub repo: String,
    pub number: i64,
}

impl ItemRef {
    /// `owner/repo#n`, lowercased: the `refs` map's key, which the client builds the same way.
    pub fn key(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number).to_lowercase()
    }
}

/// A rendered body or comment.
pub struct Rendered {
    /// The top-level nodes, in order.
    pub ast: Vec<Value>,
    /// Every issue or PR it refers to, by a `ref` node or a link to its page, each once, in
    /// order of first mention.
    pub items: Vec<ItemRef>,
}

/// GitHub's dialect, as comrak spells it.
fn options() -> comrak::Options<'static> {
    let mut o = comrak::Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.alerts = true;
    // cmark-gfm's emphasis edge cases, which GitHub renders with.
    o.render.gfm_quirks = true;
    // Raw HTML goes through to ammonia, which owns the allowlist.
    o.render.r#unsafe = true;
    o
}

/// The Markdown as the browser gets it: rendered, or as plain text under a note when it's too
/// large or too deeply nested to render (or its rendering failed).
pub fn render(md: &str, ctx: &Context) -> Rendered {
    let rendered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bounded(md, ctx)));
    match rendered {
        Ok(Some(r)) => r,
        Ok(None) => plain_under(
            md,
            ctx,
            "Too large or too deeply nested to render; shown as plain text.",
        ),
        Err(_) => plain(md, ctx),
    }
}

/// The four stages, or `None` past a bound.
fn bounded(md: &str, ctx: &Context) -> Option<Rendered> {
    if !bounds::markdown_within(md) {
        return None;
    }
    let o = options();
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, md, &o);
    if !bounds::document_within(root) {
        return None;
    }
    let mut html = String::new();
    comrak::format_html(root, &o, &mut html).ok()?;
    // Raw HTML nests and multiplies in ways the Markdown's tree doesn't show.
    if !bounds::html_within(&html) || !tree::within_bounds(&html) {
        return None;
    }
    #[cfg(test)]
    work::tally(tree::parser_work(&html));
    let clean = sanitise::clean(&html);
    ast::build(tree::parse(&clean), ctx)
}

/// `md` as it shows when its rendering failed: one block of plain text under a note saying so,
/// its references still links. Linear in `md`, and never fails itself.
pub fn plain(md: &str, ctx: &Context) -> Rendered {
    plain_under(md, ctx, "Couldn't render this; shown as plain text.")
}

/// `md` as one block of plain text with its references, under `note`.
fn plain_under(md: &str, ctx: &Context, note: &str) -> Rendered {
    let (text, items) = ast::plain_text(md, ctx);
    let mut pre = vec![serde_json::json!("pre"), serde_json::json!(0)];
    pre.extend(text);
    Rendered {
        ast: vec![
            serde_json::json!(["p", 0, ["em", 0, note]]),
            Value::Array(pre),
        ],
        items,
    }
}
