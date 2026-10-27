//! Work units: how much the checks and the parsers behind them do for a post, counted only in
//! tests (`scaling.rs`), where a count says what a timing on a busy machine can't, every run.
//!
//! What counts, each where the work happens: the bytes the Markdown checks read, the tags and
//! attributes the HTML checks read (an attribute that html5ever's tokenizer compares with its
//! tag's others counts each comparison, as that's the tokenizer's quadratic factor), and, for
//! HTML that passes the checks, what an HTML parser will be asked to do with it
//! ([`crate::tree::parser_work`]). Outside tests, [`tally`] is nothing.

#[cfg(test)]
thread_local! {
    static DONE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Counts `n` units of work on this thread.
#[cfg(test)]
pub(crate) fn tally(n: usize) {
    DONE.with(|d| d.set(d.get().saturating_add(n)));
}

#[cfg(not(test))]
#[inline(always)]
pub(crate) fn tally(_: usize) {}

/// The work counted on this thread since the last call, and the count back to 0.
#[cfg(test)]
pub(crate) fn take() -> usize {
    DONE.with(|d| d.replace(0))
}

/// The work html5ever's tokenizer does on a tag with `attrs` distinct attributes: the tag, and
/// each attribute compared with every one before it.
pub(crate) fn tag_work(attrs: usize) -> usize {
    1 + attrs + attrs * attrs.saturating_sub(1) / 2
}
