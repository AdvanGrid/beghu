//! Free text as SQL: the view's words become FTS5 queries over the two indexes (items' title and
//! body, and comment bodies), as filter fragments and as the matched-field set of a page's rows.
//!
//! A word (`crash`) matches the start of a word in a searched field, a phrase (`"crash in"`)
//! matches as written, and words AND together: each must match in some searched field (`in:`),
//! not necessarily the same one. `-word` leaves out every row it matches in a searched field.
//! The tokenizer (`unicode61 remove_diacritics 2`, 0001_init.sql) folds case and diacritics on
//! both sides, so `cafe` finds "Café".

use crate::list::{Fields, View, Word};
use crate::{frag, q};
use dbrt::filter::Filter;
use rusqlite::Connection;
use std::collections::HashMap;

/// A word with at least this many matches in items, or in comments, is common: see `Plan`.
pub const COMMON_MATCHES: i64 = 2_000;

/// How a list page reads free text. Starting from a word's matches and sorting them is the
/// fastest way to a page when the word is rare; when it's common that sorts tens of thousands
/// of rows, and walking the sort's index, checking each row, stops sooner. FTS5 can't be asked
/// per row instead (on the 1k fixture, a lookup costs 0.03–0.3 ms per item and 1–10 ms per
/// item's comments; see `matched`), so both read each word's matches as a set, once. #117 owns
/// a timed budget for a common word at 50k, and the slow `in:comments` case of a 4+-character
/// prefix, which may need a narrow comment→item map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// The planner may start from the matches (and does, with statistics, for a rare word).
    Free,
    /// Every positive word is common: walk the sort (`text_walk` and `comment_text_walk`).
    Walk,
}

/// A list page's plan: `Walk` when every positive word is common, so any of them would fill a
/// page within the first rows of the sort. Counting stops at `COMMON_MATCHES` (under 1 ms).
pub(crate) fn plan(c: &Connection, view: &View) -> rusqlite::Result<Plan> {
    let fields = view.fields.searched();
    let cols = columns(fields);
    let (pos, _) = words(view);
    for w in &pos {
        let items = !cols.is_empty()
            && q::count_item_matches(c, &items_query(&[w], &cols, Join::And), COMMON_MATCHES)?
                >= COMMON_MATCHES;
        let comments = fields.comments
            && q::count_comment_matches(c, &comments_query(&[w], Join::And), COMMON_MATCHES)?
                >= COMMON_MATCHES;
        if !items && !comments {
            return Ok(Plan::Free);
        }
    }
    Ok(if pos.is_empty() {
        Plan::Free
    } else {
        Plan::Walk
    })
}

fn item_text(q: &str, plan: Plan) -> Filter {
    match plan {
        Plan::Free => frag::text(q),
        Plan::Walk => frag::text_walk(q),
    }
}

fn comment_text(q: &str, plan: Plan) -> Filter {
    match plan {
        Plan::Free => frag::comment_text(q),
        Plan::Walk => frag::comment_text_walk(q),
    }
}

/// A field free text searches (`in:`) and matches in (a row's icons).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Field {
    Title,
    Body,
    Comments,
}

/// The FTS5 query for one word: a quoted string, so nothing in it is FTS syntax, with a prefix
/// star unless it's a phrase.
pub fn fts(w: &Word) -> String {
    let text = w.text.replace('"', "");
    if w.phrase {
        format!("\"{text}\"")
    } else {
        format!("\"{text}\"*")
    }
}

/// How an FTS5 query joins its words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Join {
    /// Every word.
    And,
    /// Any word.
    Or,
}

impl Join {
    fn sql(self) -> &'static str {
        match self {
            Join::And => " AND ",
            Join::Or => " OR ",
        }
    }
}

/// The words that must match, and those that leave a row out.
pub(crate) fn words(view: &View) -> (Vec<&Word>, Vec<&Word>) {
    view.words.iter().partition(|w| !w.exclude)
}

/// The item columns `fields` searches, as an FTS5 column filter's names.
fn columns(fields: Fields) -> Vec<&'static str> {
    let mut cols = Vec::new();
    if fields.title {
        cols.push("title");
    }
    if fields.body {
        cols.push("body");
    }
    cols
}

/// An `items_fts` query: `words` joined by `join`, in `cols` only.
pub(crate) fn items_query(words: &[&Word], cols: &[&str], join: Join) -> String {
    format!("{{{}}} : ({})", cols.join(" "), joined(words, join))
}

/// A `comments_fts` query: `words` joined by `join`.
fn comments_query(words: &[&Word], join: Join) -> String {
    joined(words, join)
}

fn joined(words: &[&Word], join: Join) -> String {
    let ws: Vec<String> = words.iter().map(|w| fts(w)).collect();
    ws.join(join.sql())
}

/// Rows where `w` matches in a field of `fields` (already `searched()`).
fn matches(w: &Word, fields: Fields, plan: Plan) -> Filter {
    let cols = columns(fields);
    let mut any = Vec::new();
    // Title and body first: a row they match never needs the comment set.
    if !cols.is_empty() {
        any.push(item_text(&items_query(&[w], &cols, Join::And), plan));
    }
    if fields.comments {
        any.push(comment_text(&comments_query(&[w], Join::And), plan));
    }
    match any.len() {
        1 => any.pop().unwrap(),
        _ => Filter::Or(any),
    }
}

/// The view's free text as filters: one that every positive word matches, and one per `-word`.
pub(crate) fn filters(view: &View, plan: Plan) -> Vec<Filter> {
    let mut all = Vec::new();
    all.extend(qualify(view, plan));
    all.extend(exclusions(view, plan));
    all
}

/// Rows with a comment `w` matches.
pub(crate) fn in_comments(w: &Word, plan: Plan) -> Filter {
    comment_text(&comments_query(&[w], Join::And), plan)
}

/// The positive words, each matching somewhere in the searched fields. Without comments, all of
/// them in one `items_fts` query.
pub(crate) fn qualify(view: &View, plan: Plan) -> Option<Filter> {
    let fields = view.fields.searched();
    let (pos, _) = words(view);
    if pos.is_empty() {
        return None;
    }
    if !fields.comments {
        return Some(item_text(
            &items_query(&pos, &columns(fields), Join::And),
            plan,
        ));
    }
    Some(Filter::And(
        pos.iter().map(|w| matches(w, fields, plan)).collect(),
    ))
}

/// One filter per `-word`: rows it matches in a searched field are left out.
pub(crate) fn exclusions(view: &View, plan: Plan) -> Vec<Filter> {
    let fields = view.fields.searched();
    let (_, neg) = words(view);
    neg.iter()
        .map(|w| Filter::Not(Box::new(matches(w, fields, plan))))
        .collect()
}

/// Rows whose `field` (title or body) holds any positive word: with the search matching, the
/// rows that may rank by it (see `rank`).
pub(crate) fn any_in(view: &View, field: Field, plan: Plan) -> Filter {
    let (pos, _) = words(view);
    let col = match field {
        Field::Title => "title",
        Field::Body => "body",
        Field::Comments => unreachable!("comments rank as the rest"),
    };
    item_text(&items_query(&pos, &[col], Join::Or), plan)
}

/// For each of `ids` the searched fields any positive word matched in, in field order; rows
/// that matched in none (or a view with no positive words) are left out.
pub fn matched(
    c: &Connection,
    view: &View,
    ids: &[i64],
) -> rusqlite::Result<HashMap<i64, Vec<Field>>> {
    let mut out: HashMap<i64, Vec<Field>> = HashMap::new();
    let (pos, _) = words(view);
    if pos.is_empty() || ids.is_empty() {
        return Ok(out);
    }
    let fields = view.fields.searched();
    // Each field's matches read as one set, never looked up row by row. Measured on the 1k
    // fixture with its indexes as the triggers leave them (10 and 18 segments), a lookup per
    // row of a 100-row page cost 3–33 ms for titles and bodies and 100–1,000 ms for comments,
    // against 0.2–1.5 ms and 0.5–7 ms for the sets, over short common words (`to`, `the`),
    // 4+-character prefixes, phrases and ORs of them; even 25 rows never came out ahead. A
    // refetch's rows (up to 10,000) only widen the gap. #117 owns the timed budget at 50k.
    let mut add = |field: Field, hits: Vec<i64>| {
        for id in hits {
            out.entry(id).or_default().push(field);
        }
    };
    if fields.title {
        let q = items_query(&pos, &["title"], Join::Or);
        add(Field::Title, q::item_hits(c, &q, ids)?);
    }
    if fields.body {
        let q = items_query(&pos, &["body"], Join::Or);
        add(Field::Body, q::item_hits(c, &q, ids)?);
    }
    if fields.comments {
        let q = comments_query(&pos, Join::Or);
        add(Field::Comments, q::comment_hits(c, &q, ids)?);
    }
    Ok(out)
}
