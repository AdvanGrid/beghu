//! Match mode: how a search's text orders the list. Every tuning constant is here.
//!
//! A row that matches (every positive word somewhere in the searched fields) ranks by its best
//! field: the first of title, body, comments that any positive word is in, which is the first
//! of its icons (`search::matched`). So `crash login` with "crash" in the title and "login" in
//! the body is a title match.
//!
//! - **Blend** (the default): field weight × 0.5^(age on the sort key / half-life), highest
//!   first, ties on the sort key and then id. It needs a descending time sort; under any other
//!   sort it falls back to Best.
//! - **Best**: title matches, then body, then comment, each group in the view's sort.
//! - **Off**: the plain sort; the text only filters.
//!
//! Blend's order needs no clock. With `t` the sort key, a row's score is
//! `w × 2^((t − now) / H)`, which orders as `t + H × log2(w)`: the sort key, moved later by a
//! fixed offset per field. That's the rank a ranked cursor carries, so pages and live refetches
//! agree across the time between them, and within one field the order is the plain sort's.
//!
//! So each field is read as its own sorted list, through the list's sort indexes, and the lists
//! are merged: a page takes at most `limit` rows from each field (the spec's "top 50 from each
//! field"), and no row is scored or sorted that the page doesn't need. Each field's list holds
//! only the rows ranking by it (a word in the title; a word in the body and none in the title;
//! the rest), so the lists are disjoint and the merge is exact.
//!
//! Tree mode's ranking of whole subtrees is #108's.

use crate::list::{self, Cursor, Match, Rank, Sort, Span, View};
use crate::search::{self, Field};
use dbrt::filter::Filter;
use rusqlite::Connection;

/// Blend's field weights.
pub const TITLE_WEIGHT: f64 = 4.0;
pub const BODY_WEIGHT: f64 = 2.0;
pub const COMMENT_WEIGHT: f64 = 1.0;
/// Blend's half-life: a match this much older than another of the same field scores half.
pub const HALF_LIFE_SECS: i64 = 180 * 24 * 60 * 60;

/// The Match mode that applies to a view. Only free text ranks: with no positive word, the plain
/// sort (Off). Blend needs a sort it can rank in (`Sort::blends`) and otherwise falls back to
/// Best.
pub fn mode(view: &View) -> Match {
    if search::words(view).0.is_empty() {
        return Match::Off;
    }
    match view.matching.unwrap_or(Match::Blend) {
        Match::Blend if !view.sort.blends() => Match::Best,
        m => m,
    }
}

/// Whether a ranked cursor's `value` is a rank a row can have under `mode` and `sort`, with
/// sort key `key`: Best's is the field's place (0, 1, 2), negated under a descending sort;
/// Blend's is the key moved by one field's offset, and Blend's keys (descending times, never
/// closed or never commented as 0) are never negative. A cursor's parse checks it, so the
/// arithmetic `blend` and `best` do on a cursor stays in range.
pub(crate) fn possible(mode: Match, sort: Sort, value: i64, key: i64) -> bool {
    match mode {
        Match::Best => {
            let dir = if sort.asc { 1 } else { -1 };
            (0..=2).any(|place| place * dir == value)
        }
        Match::Blend => {
            key >= 0
                && [TITLE_WEIGHT, BODY_WEIGHT, COMMENT_WEIGHT]
                    .into_iter()
                    .any(|w| key.checked_add(offset(w)) == Some(value))
        }
        Match::Off => false,
    }
}

/// How far Blend moves a field's sort key: `H × log2(weight)` seconds.
fn offset(weight: f64) -> i64 {
    (HALF_LIFE_SECS as f64 * weight.log2()).round() as i64
}

/// One field's list: the rows that rank by it.
struct Tier {
    /// Best's position: 0 for title, 1 for body, 2 for the rest.
    order: i64,
    weight: f64,
    filter: Filter,
}

/// The view's fields, best first, each with the filter for the rows that rank by it. A field
/// that can hold no row of the view is left out.
fn tiers(view: &View, me: i64, plan: search::Plan) -> Vec<Tier> {
    let fields = view.fields.searched();
    let (pos, _) = search::words(view);
    let mut base = list::qualifiers(view, me);
    base.extend(search::exclusions(view, plan));
    let with = |extra: Vec<Filter>| {
        let mut all = base.clone();
        all.extend(extra);
        Filter::And(all)
    };
    let not = |f: &Filter| Filter::Not(Box::new(f.clone()));
    // With one positive word, a field that holds it matches on its own; with more, the row must
    // also match as a whole.
    let whole = |f: Filter| {
        let mut all = vec![f];
        if pos.len() > 1 {
            all.extend(search::qualify(view, plan));
        }
        all
    };
    let title = fields
        .title
        .then(|| search::any_in(view, Field::Title, plan));
    let body = fields.body.then(|| search::any_in(view, Field::Body, plan));
    let mut out = Vec::new();
    if let Some(t) = &title {
        out.push(Tier {
            order: 0,
            weight: TITLE_WEIGHT,
            filter: with(whole(t.clone())),
        });
    }
    if let Some(b) = &body {
        let mut f: Vec<Filter> = title.iter().map(not).collect();
        f.extend(whole(b.clone()));
        out.push(Tier {
            order: 1,
            weight: BODY_WEIGHT,
            filter: with(f),
        });
    }
    // The rest: no word in title or body, so every word in a comment (not necessarily the
    // same one). Without comments there's no rest.
    if fields.comments {
        let mut f: Vec<Filter> = title.iter().chain(&body).map(not).collect();
        f.extend(pos.iter().map(|w| search::in_comments(w, plan)));
        out.push(Tier {
            order: 2,
            weight: COMMENT_WEIGHT,
            filter: with(f),
        });
    }
    out
}

/// `list::page` for a ranked view.
pub(crate) fn page(
    c: &Connection,
    view: &View,
    me: i64,
    mode: Match,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    let tiers = tiers(view, me, search::plan(c, view)?);
    match mode {
        Match::Blend => blend(c, view, tiers, span, limit),
        _ => best(c, view, tiers, span, limit),
    }
}

/// Every field's list from `span` on, merged by rank.
fn blend(
    c: &Connection,
    view: &View,
    tiers: Vec<Tier>,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    let limit = limit.max(0) as usize;
    let mut out: Vec<Cursor> = Vec::new();
    // Fields come best first. Once the page is full, a later field's row makes it only by
    // ranking above the page's last row, so its list is read only that far: under a common
    // word, title and body fill the page and the rest is read hardly at all.
    let mut floor: Option<Cursor> = None;
    for t in tiers {
        let off = offset(t.weight);
        // A ranked cursor in this field's own (key, id) order: rows of the field rank below
        // (rank, key, id) when key + off < rank, or on a tie of rank, when (key, id) is lower.
        let at = |cur: Cursor| {
            // Saturating, though a parsed cursor's rank can't take it out of range (`possible`).
            let key = cur.rank_value().unwrap_or(cur.key).saturating_sub(off);
            let id = match key.cmp(&cur.key) {
                std::cmp::Ordering::Less => i64::MAX,
                std::cmp::Ordering::Greater => i64::MIN,
                std::cmp::Ordering::Equal => cur.id,
            };
            Cursor {
                rank: None,
                key,
                id,
                ..cur
            }
        };
        let (after, through) = match span {
            Span::Top => (None, None),
            Span::After(cur) => (Some(at(cur)), None),
            Span::Through(cur) => (None, Some(at(cur))),
        };
        // The page's last row ranks at or above a refetch's cursor, so it's the nearer end.
        let through = floor.map(at).or(through);
        for row in list::ids_between(c, view.sort, t.filter, after, through, limit as i64)? {
            out.push(Cursor {
                rank: Some(Rank {
                    value: row.key + off,
                    mode: Match::Blend,
                }),
                ..row
            });
        }
        out.sort_by_key(|r| std::cmp::Reverse((r.rank_value(), r.key, r.id)));
        out.truncate(limit);
        if out.len() == limit {
            floor = out.last().copied();
        }
    }
    Ok(out)
}

/// The fields' lists one after another, from `span` on. The rank is the field's place, negated
/// under a descending sort so that every part of the cursor runs the sort's way.
fn best(
    c: &Connection,
    view: &View,
    tiers: Vec<Tier>,
    span: Span,
    limit: i64,
) -> rusqlite::Result<Vec<Cursor>> {
    let dir = if view.sort.asc { 1 } else { -1 };
    let mut out = Vec::new();
    for t in tiers {
        let rank = dir * t.order;
        let field_span = match span {
            Span::Top => Span::Top,
            Span::After(cur) | Span::Through(cur) => {
                let at = cur.rank_value().unwrap_or(0).saturating_mul(dir);
                let inner = Cursor { rank: None, ..cur };
                match (t.order.cmp(&at), span) {
                    // A field wholly before the cursor: past for a next page, all of it for a
                    // refetch.
                    (std::cmp::Ordering::Less, Span::After(_)) => continue,
                    (std::cmp::Ordering::Less, _) => Span::Top,
                    (std::cmp::Ordering::Equal, Span::After(_)) => Span::After(inner),
                    (std::cmp::Ordering::Equal, _) => Span::Through(inner),
                    (std::cmp::Ordering::Greater, Span::After(_)) => Span::Top,
                    // A refetch ends at its cursor.
                    (std::cmp::Ordering::Greater, _) => break,
                }
            }
        };
        let want = limit - out.len() as i64;
        if want <= 0 {
            break;
        }
        for row in list::ids(c, view.sort, t.filter, field_span, want)? {
            out.push(Cursor {
                rank: Some(Rank {
                    value: rank,
                    mode: Match::Best,
                }),
                ..row
            });
        }
    }
    Ok(out)
}
