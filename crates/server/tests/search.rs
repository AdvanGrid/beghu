//! Full-text search and Match mode through `/api/issues`, on the 1k fixture. Words are planted
//! with Fake GitHub's outside edits (titles, bodies, comments), so each test knows exactly which
//! rows a word is in and where; the fixture's own vocabulary gives the common-word views.

mod common;

use common::{Browser, Sse, Stack, ids_of, start, summary};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

/// Every row of the view `q`, paging through its cursors.
async fn all(s: &Stack, b: &mut Browser, q: &str) -> Vec<Value> {
    let base = format!(
        "/api/issues?{}",
        serde_urlencoded::to_string([("q", q)]).unwrap()
    );
    let mut rows = Vec::new();
    let mut url = base.clone();
    loop {
        let (status, page) = s.api(b, &url).await;
        assert_eq!(status, 200, "{url}: {page}");
        rows.extend(page["rows"].as_array().unwrap().iter().cloned());
        match page["next"].as_str() {
            Some(next) => url = format!("{base}&after={next}"),
            None => break,
        }
    }
    rows
}

fn id(r: &Value) -> i64 {
    r["id"].as_i64().unwrap()
}

fn idset(rows: &[Value]) -> BTreeSet<i64> {
    rows.iter().map(id).collect()
}

fn order(rows: &[Value]) -> Vec<i64> {
    rows.iter().map(id).collect()
}

async fn ids(s: &Stack, b: &mut Browser, q: &str) -> BTreeSet<i64> {
    idset(&all(s, b, q).await)
}

/// Waits until the view `q` is exactly `want` (the webhooks of an edit land about a second
/// later), or panics.
async fn until(s: &Stack, b: &mut Browser, q: &str, want: &BTreeSet<i64>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let got = ids(s, b, q).await;
        if &got == want {
            return;
        }
        assert!(Instant::now() < deadline, "{q}: {got:?}, want {want:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The matched fields a row carries.
fn matched(r: &Value) -> Vec<&str> {
    r["matched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect()
}

async fn edit(s: &Stack, r: &Value, change: Value) {
    let mut e = json!({ "repo": r["repo"], "number": r["number"] });
    e.as_object_mut()
        .unwrap()
        .extend(change.as_object().unwrap().clone());
    s.edit(e).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn words_match_titles_bodies_and_comments_with_prefixes_phrases_exclusions_and_in() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let rows = all(&s, &mut b, "is:open").await;
    let (t, bd, c) = (&rows[3], &rows[5], &rows[7]);
    edit(
        &s,
        t,
        json!({ "title": "Zebrafish quokka lantern: Crème brûlée in Ångström units" }),
    )
    .await;
    edit(
        &s,
        bd,
        json!({ "body": "The zebrafish tank leaks. No quokka here." }),
    )
    .await;
    edit(
        &s,
        c,
        json!({ "comment": "Seen with zebrafish on a wombat." }),
    )
    .await;
    let three: BTreeSet<i64> = [id(t), id(bd), id(c)].into();
    until(&s, &mut b, "zebrafish", &three).await;

    // A word matches the start of a word: two characters are enough.
    assert_eq!(ids(&s, &mut b, "zebr").await, three);
    assert!(ids(&s, &mut b, "ze").await.is_superset(&three));
    // Case and diacritics fold both ways.
    assert_eq!(ids(&s, &mut b, "creme").await, [id(t)].into());
    assert_eq!(ids(&s, &mut b, "BRÛLÉE").await, [id(t)].into());
    assert_eq!(ids(&s, &mut b, "angstrom").await, [id(t)].into());

    // Each row carries the fields it matched in.
    for r in all(&s, &mut b, "zebrafish").await {
        let want = match id(&r) {
            x if x == id(t) => vec!["title"],
            x if x == id(bd) => vec!["body"],
            _ => vec!["comments"],
        };
        assert_eq!(matched(&r), want, "{r}");
    }
    // Several words: each field any of them is in.
    let r = all(&s, &mut b, "zebrafish quokka").await;
    assert_eq!(idset(&r), [id(t), id(bd)].into());
    // Without free text, no fields.
    let (_, page) = s.api(&mut b, "/api/issues").await;
    assert!(matched(&page["rows"][0]).is_empty());

    // `in:` narrows to the fields named, by comma or by token, OR'd.
    assert_eq!(ids(&s, &mut b, "zebrafish in:title").await, [id(t)].into());
    assert_eq!(ids(&s, &mut b, "zebrafish in:body").await, [id(bd)].into());
    assert_eq!(
        ids(&s, &mut b, "zebrafish in:comments").await,
        [id(c)].into()
    );
    assert_eq!(
        ids(&s, &mut b, "zebrafish in:title,body").await,
        [id(t), id(bd)].into()
    );
    assert_eq!(
        ids(&s, &mut b, "in:title zebrafish in:comments").await,
        [id(t), id(c)].into()
    );
    for r in all(&s, &mut b, "zebrafish in:title,comments").await {
        assert!(!matched(&r).contains(&"body"), "{r}");
    }
    // A value that isn't a field yet is dropped, so `in:tit` searches everywhere.
    assert_eq!(ids(&s, &mut b, "zebrafish in:tit").await, three);

    // Words AND together, each in any field: one word in the title and another in a comment.
    assert!(ids(&s, &mut b, "quokka wombat").await.is_empty());
    assert_eq!(ids(&s, &mut b, "zebrafish wombat").await, [id(c)].into());

    // A phrase matches as written.
    assert_eq!(ids(&s, &mut b, r#""quokka lantern""#).await, [id(t)].into());
    assert!(ids(&s, &mut b, r#""lantern quokka""#).await.is_empty());
    // `-word` leaves out a row it matches in any searched field.
    assert_eq!(ids(&s, &mut b, "zebrafish -quokka").await, [id(c)].into());
    assert_eq!(
        ids(&s, &mut b, "zebrafish -wombat").await,
        [id(t), id(bd)].into()
    );
    // … but only in the fields searched.
    assert_eq!(
        ids(&s, &mut b, "zebrafish -wombat in:title,body").await,
        [id(t), id(bd)].into()
    );
    assert_eq!(
        ids(&s, &mut b, "zebrafish -quokka in:title").await,
        BTreeSet::new()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn prs_are_searched_under_their_kind() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let issue = all(&s, &mut b, "is:open").await[2].clone();
    let pr = all(&s, &mut b, "is:pr is:open").await[2].clone();
    edit(&s, &issue, json!({ "title": "Axolotl rollout" })).await;
    edit(&s, &pr, json!({ "comment": "Axolotl review notes" })).await;
    until(&s, &mut b, "is:any axolotl", &[id(&issue), id(&pr)].into()).await;
    // Free text follows the active kind: issues unless PRs are asked for.
    assert_eq!(ids(&s, &mut b, "axolotl").await, [id(&issue)].into());
    let prs = all(&s, &mut b, "is:pr axolotl").await;
    assert_eq!(order(&prs), [id(&pr)]);
    assert_eq!(matched(&prs[0]), ["comments"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_right_after_a_change_sees_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = all(&s, &mut b, "is:open").await[4].clone();

    // The push comes once the change is committed, and the index went in the same
    // transaction: no wait, no retry. (It also names any PR that closes the issue, whose
    // "Closes" shows it.)
    let pushed = |ev: Sse| ids_of(&ev).contains(&id(&r));
    edit(&s, &r, json!({ "title": "Okapi migration" })).await;
    assert!(pushed(
        st.event_within(Duration::from_secs(5)).await.unwrap()
    ));
    assert_eq!(ids(&s, &mut b, "okapi").await, [id(&r)].into());

    // Renamed again: the old words are out of the index, the new ones in.
    edit(
        &s,
        &r,
        json!({ "title": "Tapir migration", "body": "Moved off okapi." }),
    )
    .await;
    assert!(pushed(
        st.event_within(Duration::from_secs(5)).await.unwrap()
    ));
    assert_eq!(ids(&s, &mut b, "tapir").await, [id(&r)].into());
    assert!(ids(&s, &mut b, "okapi in:title").await.is_empty());
    assert_eq!(ids(&s, &mut b, "okapi in:body").await, [id(&r)].into());

    // A new comment.
    edit(&s, &r, json!({ "comment": "Capybara says hi" })).await;
    assert!(pushed(
        st.event_within(Duration::from_secs(5)).await.unwrap()
    ));
    assert_eq!(
        ids(&s, &mut b, "capybara in:comments").await,
        [id(&r)].into()
    );
}

/// Blend's half-life, as the spec sets it.
const H: i64 = 180 * 24 * 60 * 60;

/// The row's sort key for `sort` (descending sorts), as the spec defines each.
fn key(r: &Value, sort: &str) -> i64 {
    let at = |f: &str| r[f].as_i64().unwrap_or(0);
    match sort {
        "updated" => at("updated_at"),
        "created" => at("created_at"),
        "closed" => at("closed_at"),
        "commented" => at("commented_at"),
        "comments" => at("comments"),
        _ => unreachable!(),
    }
}

/// The field a row ranks by (0 title, 1 body, 2 comments): the first field any of the search's
/// words is in, which is its first matched field.
fn field(r: &Value) -> i64 {
    match matched(r).first().copied() {
        Some("title") => 0,
        Some("body") => 1,
        _ => 2,
    }
}

/// Blend's score, as the order it gives: field weight × 0.5^(age / H) orders as
/// key + H × log2(weight), with weights 4, 2 and 1.
fn blend(r: &Value, sort: &str) -> i64 {
    key(r, sort) + H * (2 - field(r))
}

#[tokio::test(flavor = "multi_thread")]
async fn match_modes_order_a_common_word_across_pages() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // A word from the fixture's text, in titles, bodies and comments; and two, which rows hold
    // in different fields.
    for text in ["laptop", "laptop spinner"] {
        modes_order(&s, &mut b, text).await;
    }
}

async fn modes_order(s: &Stack, b: &mut Browser, text: &str) {
    let off = all(s, b, &format!("{text} match:off")).await;
    let fields: BTreeSet<i64> = off.iter().map(field).collect();
    assert_eq!(fields, [0, 1, 2].into(), "{text}: rows rank by every field");
    assert!(off.len() > 200, "{text}: several pages: {}", off.len());
    let every = idset(&off);

    for sort in ["updated", "created", "closed", "commented"] {
        let blended = all(s, b, &format!("{text} sort:{sort}")).await;
        assert_eq!(idset(&blended), every, "{text}: {sort}");
        let mut want = blended.clone();
        want.sort_by_key(|r| std::cmp::Reverse((blend(r, sort), key(r, sort), id(r))));
        assert_eq!(order(&blended), order(&want), "{text}: Blend under {sort}");
        // Blend is the default with free text.
        assert_eq!(
            order(&all(s, b, &format!("{text} sort:{sort} match:blend")).await),
            order(&blended)
        );
    }

    for sort in [
        "updated",
        "created-asc",
        "comments",
        "comments-asc",
        "closed-asc",
    ] {
        let (name, asc) = match sort.strip_suffix("-asc") {
            Some(n) => (n, true),
            None => (sort, false),
        };
        let best = all(s, b, &format!("{text} sort:{sort} match:best")).await;
        let mut want = best.clone();
        want.sort_by(|x, y| {
            let k = |r: &Value| {
                // Never closed sorts last both ways.
                if name == "closed" && r["closed_at"].is_null() {
                    return if asc { i64::MAX } else { 0 };
                }
                key(r, name)
            };
            let by = (k(x), id(x)).cmp(&(k(y), id(y)));
            field(x)
                .cmp(&field(y))
                .then(if asc { by } else { by.reverse() })
        });
        assert_eq!(order(&best), order(&want), "{text}: Best under {sort}");
        // Blend needs a descending time sort; anything else falls back to Best.
        if asc || name == "comments" {
            assert_eq!(
                order(&all(s, b, &format!("{text} sort:{sort}")).await),
                order(&best),
                "{text}: Blend falls back under {sort}"
            );
        }
        // Off is the plain sort: the same rows as the view without ranking.
        let plain = all(s, b, &format!("{text} sort:{sort} match:off")).await;
        assert_eq!(idset(&plain), every);
        let mut want = plain.clone();
        want.sort_by_key(|r| {
            let k = if name == "closed" && r["closed_at"].is_null() {
                if asc { i64::MAX } else { 0 }
            } else {
                key(r, name)
            };
            if asc { (k, id(r)) } else { (-k, -id(r)) }
        });
        assert_eq!(order(&plain), order(&want), "{text}: Off under {sort}");
    }

    // A live refetch through the last loaded row is the pages it covers, in one request.
    for m in ["", "match:best", "sort:created-asc"] {
        let q = &format!("{text} {m}");
        let enc = serde_urlencoded::to_string([("q", q)]).unwrap();
        let (_, first) = s.api(b, &format!("/api/issues?{enc}")).await;
        let next = first["next"].as_str().unwrap();
        let (_, second) = s.api(b, &format!("/api/issues?{enc}&after={next}")).await;
        let last = second["last"].as_str().unwrap();
        let (_, refetch) = s.api(b, &format!("/api/issues?{enc}&through={last}")).await;
        let mut both = first["rows"].as_array().unwrap().clone();
        both.extend(second["rows"].as_array().unwrap().iter().cloned());
        assert_eq!(
            order(refetch["rows"].as_array().unwrap()),
            order(&both),
            "{q}"
        );
        assert!(refetch["next"].is_string(), "{q}: more rows follow");
        // A cursor from another view's order is refused.
        let plain = first["rows"][0]["updated_at"].to_string();
        let (status, _) = s
            .api(b, &format!("/api/issues?{enc}&after={plain}.1"))
            .await;
        assert_eq!(status, 400, "{q}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn blend_weighs_the_field_against_age() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // Open issues, newest first by creation, which edits don't change.
    let rows = all(&s, &mut b, "is:open sort:created").await;
    let created = |r: &Value| r["created_at"].as_i64().unwrap();
    let recent = &rows[10];
    // A title match created more than a half-life before the body match, and one created
    // well within it.
    let far = rows
        .iter()
        .find(|r| created(recent) - created(r) > H + 30 * 86_400)
        .expect("an issue created over 7 months before");
    let near = rows
        .iter()
        .find(|r| {
            let d = created(recent) - created(r);
            d > 30 * 86_400 && d < H - 30 * 86_400
        })
        .expect("an issue created 1–5 months before");
    let comment = &rows[0];
    edit(&s, far, json!({ "title": "Narwhal sync (far)" })).await;
    edit(&s, near, json!({ "title": "Narwhal sync (near)" })).await;
    edit(&s, recent, json!({ "body": "Narwhal in the body." })).await;
    edit(&s, comment, json!({ "comment": "A narwhal comment." })).await;
    let four: BTreeSet<i64> = [id(far), id(near), id(recent), id(comment)].into();
    until(&s, &mut b, "narwhal", &four).await;

    let q = |m: &str| format!("narwhal sort:created {m}");
    // Blend: the near title beats the newer body (within a half-life, 4 against 2), the body
    // beats the far title (more than a half-life newer).
    let blend = order(&all(&s, &mut b, &q("")).await);
    let at = |x: &Value| blend.iter().position(|&i| i == id(x)).unwrap();
    assert!(at(near) < at(recent), "{blend:?}");
    assert!(at(recent) < at(far), "{blend:?}");
    // Best: titles first, each group newest first; then body; then comment.
    assert_eq!(
        order(&all(&s, &mut b, &q("match:best")).await),
        [id(near), id(far), id(recent), id(comment)]
    );
    // Off: by creation only.
    assert_eq!(
        order(&all(&s, &mut b, &q("match:off")).await),
        [id(comment), id(recent), id(near), id(far)]
    );
    // Ascending: Blend falls back to Best, each group oldest first.
    assert_eq!(
        order(&all(&s, &mut b, "narwhal sort:created-asc").await),
        [id(far), id(near), id(recent), id(comment)]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_row_ranks_by_the_best_field_any_word_is_in() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let rows = all(&s, &mut b, "is:open sort:created").await;
    // Newest first by creation: the comment row, then the body rows, then the title rows.
    let (comment, body, split, title) = (&rows[0], &rows[5], &rows[10], &rows[20]);
    let (half, title_comment) = (&rows[15], &rows[25]);
    // One word in the title and the other in the body: a title match.
    edit(
        &s,
        title,
        json!({ "title": "Pangolin rollout", "body": "The gecko waits." }),
    )
    .await;
    edit(&s, body, json!({ "body": "Pangolin and gecko." })).await;
    // One word in the body and the other in a comment: a body match.
    edit(&s, split, json!({ "body": "A pangolin." })).await;
    edit(&s, split, json!({ "comment": "A gecko." })).await;
    edit(&s, comment, json!({ "comment": "Pangolin, gecko." })).await;
    // One word in the title and the other only in a comment: a title match.
    edit(&s, title_comment, json!({ "title": "Gecko sighting" })).await;
    edit(&s, title_comment, json!({ "comment": "A pangolin too." })).await;
    // Only one of the words anywhere: no match at all, though its title has it.
    edit(&s, half, json!({ "title": "Pangolin only" })).await;
    let five: BTreeSet<i64> = [
        id(comment),
        id(body),
        id(split),
        id(title),
        id(title_comment),
    ]
    .into();
    until(&s, &mut b, "pangolin gecko", &five).await;

    let best = all(&s, &mut b, "pangolin gecko sort:created match:best").await;
    assert_eq!(
        order(&best),
        [
            id(title),
            id(title_comment),
            id(body),
            id(split),
            id(comment)
        ],
        "Best: titles newest first, then body, then comment"
    );
    assert_eq!(matched(&best[0]), ["title", "body"]);
    assert_eq!(matched(&best[1]), ["title", "comments"]);
    assert_eq!(matched(&best[3]), ["body", "comments"]);
    // Blend weighs each row by the same field.
    let blended = all(&s, &mut b, "pangolin gecko sort:created").await;
    let mut want = blended.clone();
    want.sort_by_key(|r| std::cmp::Reverse((blend(r, "created"), key(r, "created"), id(r))));
    assert_eq!(order(&blended), order(&want));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cursor_from_another_order_is_refused() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let next = |q: &str| {
        let enc = serde_urlencoded::to_string([("q", q)]).unwrap();
        format!("/api/issues?{enc}")
    };
    let mut cursors = Vec::new();
    for q in [
        "laptop",
        "laptop match:best",
        "laptop sort:created",
        "laptop sort:created-asc",
        "laptop match:off",
        // Plain cursors name their sort too: one from another sort is no place in this one.
        "is:open",
        "is:open sort:created",
        "is:open sort:created-asc",
        "is:open sort:comments",
    ] {
        let (status, page) = s.api(&mut b, &next(q)).await;
        assert_eq!(status, 200, "{q}");
        cursors.push((q, page["next"].as_str().unwrap().to_owned()));
    }
    // Each cursor pages its own view, and is refused by every other order. (`laptop match:off`
    // and `is:open` are both the plain `sort:updated`.)
    let order_of = |q: &str| q.replace("is:open", "laptop match:off");
    for (q, _) in &cursors {
        for (from, cur) in &cursors {
            let (status, body) = s.api(&mut b, &format!("{}&after={cur}", next(q))).await;
            let want = if order_of(q) == order_of(from) {
                200
            } else {
                400
            };
            assert_eq!(status, want, "{q} after a cursor of {from}: {body}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crafted_cursor_out_of_range_is_refused() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let next = |q: &str| {
        let enc = serde_urlencoded::to_string([("q", q)]).unwrap();
        format!("/api/issues?{enc}")
    };
    let cursor = async |b: &mut Browser, q: &str| {
        let (_, page) = s.api(b, &next(q)).await;
        page["next"].as_str().unwrap().to_owned()
    };
    let blend = cursor(&mut b, "laptop").await;
    let best = cursor(&mut b, "laptop match:best").await;
    // Cursors whose arithmetic would overflow, or whose rank no row of the view can have, are
    // refused rather than read.
    let tag = |c: &str| c.split('.').next().unwrap().to_owned();
    let bad = [
        ("laptop", "-9223372036854775808.0.1".to_owned()),
        ("laptop", "9223372036854775807.0.1".to_owned()),
        ("laptop match:best", "-9223372036854775808.0.1".to_owned()),
        (
            "laptop",
            format!("{}.-9223372036854775808.0.1", tag(&blend)),
        ),
        (
            "laptop",
            format!(
                "{}.-9223372036854775808.-9223372036854775808.1",
                tag(&blend)
            ),
        ),
        (
            "laptop",
            format!("{}.9223372036854775807.9223372036854775000.1", tag(&blend)),
        ),
        ("laptop", format!("{}.5.0.1", tag(&blend))),
        (
            "laptop match:best",
            format!("{}.-9223372036854775808.0.1", tag(&best)),
        ),
        ("laptop match:best", format!("{}.1.0.1", tag(&best))),
        ("laptop match:best", format!("{}.-3.0.1", tag(&best))),
    ];
    for (q, cur) in bad {
        for param in ["after", "through"] {
            let (status, body) = s.api(&mut b, &format!("{}&{param}={cur}", next(q))).await;
            assert_eq!(status, 400, "{q} {param}={cur}: {body}");
        }
    }
}

/// FTS5's own syntax in the search box is text, never a query: operators are words, quotes and
/// stars and column filters are punctuation, and nothing fails the request.
#[tokio::test(flavor = "multi_thread")]
async fn fts_syntax_is_searched_as_text() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let rows = all(&s, &mut b, "is:open").await;
    let (and, near, not) = (&rows[3], &rows[6], &rows[9]);
    edit(&s, and, json!({ "title": "Quetzal and forest" })).await;
    edit(&s, near, json!({ "title": "Near quetzal forest" })).await;
    edit(
        &s,
        not,
        json!({ "title": "Not a quetzal forest, it's thorny" }),
    )
    .await;
    let three: BTreeSet<i64> = [id(and), id(near), id(not)].into();
    until(&s, &mut b, "quetzal", &three).await;

    // (query, the plain search it means)
    let same = [
        // Operators are words, each a prefix like any other.
        ("quetzal AND forest", "quetzal and forest"),
        ("quetzal OR forest", "quetzal or forest"),
        ("quetzal NOT forest", "quetzal not forest"),
        ("NEAR(quetzal forest)", "near quetzal forest"),
        ("AND", "and"),
        // Stars, carets and column filters are punctuation around the words.
        ("quetz*", "quetz"),
        ("th*", "th"),
        ("^quetzal", "quetzal"),
        ("^the", "the"),
        // An unknown qualifier is dropped, not a column filter.
        ("title:nosuchword quetzal", "quetzal"),
        ("title:the", ""),
        // Quotes: unclosed, inside a word, empty, empty and excluded.
        ("\"quetzal", "\"quetzal\""),
        ("quetzal \"\"\"", "quetzal"),
        ("quetzal -\"\"", "quetzal"),
        ("\"\"\"", ""),
        ("-\"\"", ""),
        ("it's", "\"it s\""),
    ];
    for (q, plain) in same {
        assert_eq!(
            ids(&s, &mut b, q).await,
            ids(&s, &mut b, plain).await,
            "{q}"
        );
    }
    // The ones whose operator reading would differ.
    assert!(ids(&s, &mut b, "quetzal OR nosuchword").await.is_empty());
    assert_eq!(
        ids(&s, &mut b, "quetzal NOT forest").await,
        [id(not)].into()
    );
    assert_eq!(
        ids(&s, &mut b, "NEAR(quetzal forest)").await,
        [id(near)].into()
    );
    assert!(ids(&s, &mut b, "{title}:quetzal").await.is_empty());
    assert_eq!(ids(&s, &mut b, "quetzal it's").await, [id(not)].into());
}

/// A stub (an issue in a repo that isn't synced, which a relationship points at) is in the
/// index like any item, but a search never lists it, under any Match mode or field.
#[tokio::test(flavor = "multi_thread")]
async fn a_stub_never_matches() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // partner-sdk isn't synced: linking to one of its issues makes it a stub.
    let number = summary()["unlinked_stubs"][0].as_i64().unwrap();
    let me = all(&s, &mut b, "is:open").await[6].clone();
    edit(
        &s,
        &me,
        json!({ "add_relates_to": format!("partner-sdk#{number}") }),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    let (stub, title) = loop {
        let (_, d) = s.api(&mut b, &format!("/api/issues/{}", id(&me))).await;
        let rel = d["relationships"]["relates_to"].as_array().unwrap();
        if let Some(it) = rel.iter().find(|r| r["stub"] == true) {
            break (
                it["id"].as_i64().unwrap(),
                it["title"].as_str().unwrap().to_owned(),
            );
        }
        assert!(Instant::now() < deadline, "no stub");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    // A synced issue with the stub's title: the search finds that one only.
    edit(&s, &me, json!({ "title": title })).await;
    let phrase = format!("\"{title}\"");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ids(&s, &mut b, &format!("is:any {phrase}"))
        .await
        .contains(&id(&me))
    {
        assert!(
            Instant::now() < deadline,
            "{phrase} never found {}",
            id(&me)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    for m in [
        "",
        "is:open is:closed",
        "match:best",
        "match:off",
        "sort:created-asc",
        "in:title",
    ] {
        let q = format!("is:any {phrase} {m}");
        let got = ids(&s, &mut b, &q).await;
        assert!(
            got.contains(&id(&me)) && !got.contains(&stub),
            "{q}: {got:?}"
        );
    }
}

/// A repo no longer synced is never searched, though an unsync cut short leaves its rows (and
/// their text in the index) in the mirror: under every Match mode, field and sort.
#[tokio::test(flavor = "multi_thread")]
async fn a_search_lists_nothing_of_a_repo_that_is_no_longer_synced() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = all(&s, &mut b, "is:open repo:web").await[3].clone();
    let docs = all(&s, &mut b, "is:open repo:docs").await[3].clone();
    edit(&s, &web, json!({ "title": "Ocelot in web" })).await;
    edit(&s, &docs, json!({ "title": "Ocelot in docs" })).await;
    edit(&s, &docs, json!({ "comment": "An ocelot comment." })).await;
    until(&s, &mut b, "is:any ocelot", &[id(&web), id(&docs)].into()).await;

    // Every unsync stalls at its first chunk, with all its rows still in the mirror; docs
    // leaves the synced repos.
    let mirror = s.data.join("mirrors").join("1000.db");
    mirror_db::q::fault_stall_unsyncs(&rusqlite::Connection::open(&mirror).unwrap()).unwrap();
    let (status, picker) = s.api(&mut b, "/api/repos").await;
    assert_eq!(status, 200, "{picker}");
    let keep: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] != "docs")
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let res = s
        .api_write(&b, reqwest::Method::PUT, "/api/repos")
        .json(&json!({ "repos": keep }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    for m in [
        "",
        "match:best",
        "match:off",
        "sort:created-asc",
        "sort:comments",
        "in:title",
        "in:comments",
        "is:open is:closed",
    ] {
        let q = format!("is:any ocelot {m}");
        let rows = all(&s, &mut b, &q).await;
        let want: BTreeSet<i64> = if m == "in:comments" {
            BTreeSet::new()
        } else {
            [id(&web)].into()
        };
        assert_eq!(idset(&rows), want, "{q}");
    }
    let rows = all(&s, &mut b, "is:any ocelot").await;
    assert_eq!(matched(&rows[0]), ["title"]);
}
