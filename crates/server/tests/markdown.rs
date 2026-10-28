//! Bodies and comments on the wire: the detail and its comment pages carry each post as the
//! compact Markdown AST, and a `refs` map of the referenced items the viewer's mirror holds. Each
//! case is written on Fake GitHub (a body edit, or a comment) and read back over HTTP: the AST's
//! shape, the sanitiser, GitHub's markup, the reference and footnote passes, and the bounds on
//! what renders, deep nesting on the server's 2 MiB stacks included. Only what no HTTP answer can
//! show is tested in md-ast: the GFM spec run (comrak's HTML) and the work counts that show it
//! scales.

mod common;

use common::{Browser, Stack, linked_stub, start};
use serde_json::{Value, json};
use sha2::Digest as _;
use std::time::{Duration, Instant};

/// Writes each of `mds` as a comment on `t` and returns the comments as the thread sends them,
/// in the same order, and their page's `refs`. A comment is found by its Markdown's digest.
async fn comment_all(s: &Stack, b: &mut Browser, t: &Value, mds: &[String]) -> (Vec<Value>, Value) {
    assert!(mds.len() <= 15, "one page of comments");
    for md in mds {
        s.edit(json!({ "repo": t["repo"], "number": t["number"], "comment": md }))
            .await;
    }
    let digests: Vec<String> = mds
        .iter()
        .map(|md| {
            sha2::Sha256::digest(md.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
        .collect();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let path = format!("/api/issues/{}/comments?order=newest", t["id"]);
        let (status, page) = s.api(b, &path).await;
        let found: Vec<Option<Value>> = digests
            .iter()
            .map(|d| {
                page["comments"]
                    .as_array()
                    .and_then(|cs| cs.iter().find(|c| c["digest"] == *d))
                    .cloned()
            })
            .collect();
        if status == 200 && found.iter().all(Option::is_some) {
            return (
                found.into_iter().map(Option::unwrap).collect(),
                page["refs"].clone(),
            );
        }
        assert!(
            Instant::now() < deadline,
            "the comments didn't arrive: {page}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Every element in a post, depth first: `(tag, attrs)`.
fn elements(post: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    fn walk(v: &Value, out: &mut Vec<(String, Value)>) {
        let Some(a) = v.as_array() else { return };
        if let Some(tag) = a.first().and_then(Value::as_str) {
            out.push((tag.to_owned(), a[1].clone()));
            a[2..].iter().for_each(|k| walk(k, out));
        }
    }
    post.as_array()
        .unwrap()
        .iter()
        .for_each(|n| walk(n, &mut out));
    out
}

/// All the text in a post.
fn text(post: &Value) -> String {
    fn node(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(a) => a[2..].iter().map(node).collect(),
            _ => String::new(),
        }
    }
    post.as_array().unwrap().iter().map(node).collect()
}

/// Polls `id`'s detail until `f` holds, or panics after a few seconds (webhooks follow an
/// outside edit about a second later).
async fn until_detail(s: &Stack, b: &mut Browser, id: i64, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let (status, d) = s.api(b, &format!("/api/issues/{id}")).await;
        if status == 200 && f(&d) {
            return d;
        }
        assert!(Instant::now() < deadline, "the detail didn't change: {d}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Two open issues from the top of the list, in the same repo: one to write in, one to refer to.
async fn two_in_one_repo(s: &Stack, b: &mut Browser) -> (Value, Value) {
    let (_, page) = s.api(b, "/api/issues").await;
    let rows = page["rows"].as_array().unwrap();
    let t = rows[0].clone();
    let x = rows[1..]
        .iter()
        .find(|r| r["owner"] == t["owner"] && r["repo"] == t["repo"] && r["state"] == "open")
        .expect("another issue in the top row's repo")
        .clone();
    (t, x)
}

/// Every `ref` node's attributes in a post's AST, depth first.
fn refs_in(ast: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    fn walk(v: &Value, out: &mut Vec<Value>) {
        let Some(a) = v.as_array() else { return };
        if a.first() == Some(&json!("ref")) {
            out.push(a[1].clone());
        }
        a.iter().for_each(|k| walk(k, out));
    }
    walk(ast, &mut out);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn references_resolve_against_the_posts_repo_and_refs_holds_only_what_the_mirror_has() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let (tid, xid) = (t["id"].as_i64().unwrap(), x["id"].as_i64().unwrap());
    // A stub: an issue in a repo the account doesn't sync, which the mirror knows the name of.
    let stub = linked_stub();
    let (status, gone) = s.api(&mut b, &format!("/api/issues/{stub}")).await;
    assert_eq!(status, 403);
    let st = &gone["issue"];
    let (so, sr, sn) = (
        st["owner"].as_str().unwrap(),
        st["repo"].as_str().unwrap(),
        st["number"].as_i64().unwrap(),
    );

    let md = format!(
        "See #{}, #999999 and {so}/{sr}#{sn}; thanks @ilze-k and @acme/core.",
        x["number"]
    );
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": md, "comment": md }))
        .await;
    // The body's and the comment's deliveries land apart: both, before either is looked at.
    let d = until_detail(&s, &mut b, tid, |d| {
        !refs_in(&d["body"]).is_empty()
            && d["comments"]["comments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| !refs_in(&c["body"]).is_empty())
    })
    .await;

    let (o, r) = (t["owner"].as_str().unwrap(), t["repo"].as_str().unwrap());
    let want = vec![
        json!({ "o": o, "r": r, "n": x["number"] }),
        json!({ "o": o, "r": r, "n": 999999 }),
        json!({ "o": so, "r": sr, "n": sn }),
        json!({ "u": "ilze-k" }),
        json!({ "t": "acme/core" }),
    ];
    assert_eq!(
        refs_in(&d["body"]),
        want,
        "a bare #n is the post's own repo"
    );
    let key = format!("{o}/{r}#{}", x["number"]).to_lowercase();
    // Only the synced item is in the map: not the missing number, not the stub.
    assert_eq!(
        d["refs"],
        json!({ key.clone(): {
            "id": xid, "kind": "issue", "title": x["title"], "state": "open", "state_reason": null
        }})
    );

    // The comment says the same, with its page's own map.
    let page = &d["comments"];
    let c = page["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| refs_in(&c["body"]) == want)
        .expect("the comment, rendered");
    assert_eq!(page["refs"][&key]["id"], xid);
    let (_, more) = s
        .api(&mut b, &format!("/api/issues/{tid}/comments?order=newest"))
        .await;
    assert_eq!(
        more["refs"][&key]["id"], xid,
        "a comment page carries its refs"
    );
    assert_eq!(more["comments"][0]["id"], c["id"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_markdown_renders_the_same_ast_whatever_the_mirror_holds() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let tid = t["id"].as_i64().unwrap();
    let key = format!(
        "{}/{}#{}",
        x["owner"].as_str().unwrap(),
        x["repo"].as_str().unwrap(),
        x["number"]
    )
    .to_lowercase();
    let md = format!("Blocked on #{}.", x["number"]);
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": md }))
        .await;
    let before = until_detail(&s, &mut b, tid, |d| d["refs"][&key]["state"] == "open").await;

    // The referenced issue closes: the map follows the mirror, the AST doesn't move.
    s.edit(json!({ "repo": x["repo"], "number": x["number"], "state": "closed", "state_reason": "not_planned" }))
        .await;
    let after = until_detail(&s, &mut b, tid, |d| d["refs"][&key]["state"] == "closed").await;
    assert_eq!(after["refs"][&key]["state_reason"], "not_planned");
    assert_eq!(after["body"], before["body"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn unsafe_html_in_a_body_never_reaches_the_wire() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    let tid = t["id"].as_i64().unwrap();
    // (`<script>`, `<style>` and the like make a post plain text, the next test shows.)
    let md = "<img src=x onerror=alert(2)> [a](javascript:alert(3)) <b style=\"x\" onclick=\"alert(4)\">ok</b>";
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": md }))
        .await;
    let d = until_detail(&s, &mut b, tid, |d| {
        d["body"].to_string().contains("[\"b\",0,\"ok\"]")
    })
    .await;
    let wire = d["body"].to_string();
    for bad in ["alert", "onerror", "onclick", "javascript", "style"] {
        assert!(!wire.contains(bad), "{bad} in {wire}");
    }
}

/// The comments a detail shows, newest first.
fn comment_bodies(d: &Value) -> Vec<Value> {
    d["comments"]["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["body"].clone())
        .collect()
}

/// Whether a post went out as its plain text, under a note: `[p, pre]`, the `pre` holding `md`
/// with its references still `ref` nodes. (Only a bare `#n` is written in these posts, so an
/// issue's `ref` reads back as one.)
fn shown_plain(post: &Value, md: &str) -> bool {
    fn as_written(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(a) if a[0] == "ref" => match &a[1] {
                r if r["u"].is_string() => format!("@{}", r["u"].as_str().unwrap()),
                r if r["t"].is_string() => format!("@{}", r["t"].as_str().unwrap()),
                r => format!("#{}", r["n"]),
            },
            _ => "\u{fffd}".to_owned(),
        }
    }
    post.as_array().is_some_and(|a| {
        a.len() == 2
            && a[0][0] == "p"
            && a[1][0] == "pre"
            && a[1][1] == 0
            && a[1].as_array().unwrap()[2..]
                .iter()
                .map(as_written)
                .collect::<String>()
                == md
    })
}

/// How deep a post's nodes go: an element counts one level.
fn depth(post: &Value) -> usize {
    // Iterative: the test mustn't overflow where the code under test doesn't.
    let mut deepest = 0;
    let mut todo: Vec<(&Value, usize)> = post.as_array().unwrap().iter().map(|n| (n, 0)).collect();
    while let Some((v, d)) = todo.pop() {
        if let Some(a) = v.as_array() {
            deepest = deepest.max(d + 1);
            todo.extend(a.iter().skip(2).map(|k| (k, d + 1)));
        }
    }
    deepest
}

#[tokio::test(flavor = "multi_thread")]
async fn deeply_nested_comments_render_and_the_server_stays_up() {
    // The server renders on tokio's blocking pool, whose threads have 2 MiB stacks, as here: a
    // stack overflow would abort the whole test process.
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    let tid = t["id"].as_i64().unwrap();
    let cap = md_ast::MAX_DEPTH;
    let deep = [
        "<div>".repeat(10_000),
        ">".repeat(60_000),
        "<b>".repeat(10_000),
        "<details><summary>s</summary>".repeat(2_000),
        // Each level indented two more spaces than its parent's marker: a list in a list.
        (0..250)
            .map(|i| format!("{}- x\n", "  ".repeat(i)))
            .collect(),
        format!("{}x", "- ".repeat(20_000)),
        format!("{}x{}", "*a ".repeat(10_000), " b*".repeat(10_000)),
        format!("{}x{}", "[".repeat(10_000), "](u)".repeat(10_000)),
        // Each `<b>` stays active after its `</div>`, so every later `<b>` reopens all the
        // earlier ones first: few tags, yet deep nesting and (quadratically) many elements.
        (0..1_000)
            .map(|i| format!("<div><b title={i}></div>"))
            .collect::<String>()
            + "x",
        // `</b>` with a `<div>` open in it: the parser keeps the `div` open, one deeper each time.
        "<b><div></b>".repeat(5_000),
        format!("{}x{}", "<div>".repeat(cap), "</div>".repeat(cap)),
    ];
    let (cs, _) = comment_all(&s, &mut b, &t, &deep).await;
    for (md, c) in deep.iter().zip(&cs) {
        let d = depth(&c["body"]);
        assert!(d <= cap + 1, "depth {d} for {:.40}", md);
    }
    assert_eq!(
        depth(&cs[10]["body"]),
        cap,
        "nesting up to the cap is kept whole"
    );
    for md in &deep[..3] {
        assert!(cs.iter().any(|c| shown_plain(&c["body"], md)), "{md:.40}");
    }
    // Opened again, and the server still answers.
    let (status, _) = s.api(&mut b, &format!("/api/issues/{tid}")).await;
    assert_eq!(status, 200);
    let health = s
        .http
        .get(format!("{}/healthz", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_post_too_large_to_render_shows_as_plain_text_with_its_references() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let tid = t["id"].as_i64().unwrap();
    // 20 columns and 2,600 rows: comrak would fill in 52,000 cells, past what a post may have.
    let table = format!(
        "See #{} and @ilze-k.\n\n|{}\n|{}\n{}",
        x["number"],
        "a|".repeat(20),
        "-|".repeat(20),
        "|1\n".repeat(2_600)
    );
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": table, "comment": table }))
        .await;
    let d = until_detail(&s, &mut b, tid, |d| {
        shown_plain(&d["body"], &table) && comment_bodies(d).iter().any(|c| shown_plain(c, &table))
    })
    .await;
    // Its references still link, and the mirror's items among them still open in-app.
    let (o, r) = (t["owner"].as_str().unwrap(), t["repo"].as_str().unwrap());
    assert_eq!(
        refs_in(&d["body"]),
        vec![
            json!({ "o": o, "r": r, "n": x["number"] }),
            json!({ "u": "ilze-k" })
        ]
    );
    let key = format!("{o}/{r}#{}", x["number"]).to_lowercase();
    assert_eq!(d["refs"][&key]["id"], x["id"]);

    // A 4-column table of 3,000 rows, 12,000 cells, renders as a table.
    let big = format!(
        "| a | b | c | d |\n|---|---|---|---|\n{}",
        "| 1 | 2 | 3 | 4 |\n".repeat(3_000)
    );
    s.edit(json!({ "repo": t["repo"], "number": t["number"], "body": big }))
        .await;
    until_detail(&s, &mut b, tid, |d| d["body"][0][0] == "table").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_post_whose_rendering_would_pass_a_mebibyte_shows_as_plain_text() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    // Each 4-byte footnote reference renders as a link with an id and a back-link: about 250
    // bytes of AST each, 2.5 MB in all, from 40 KB of Markdown.
    let md = format!("{}\n\n[^a]: x\n", "[^a]".repeat(10_000));
    let (cs, _) = comment_all(&s, &mut b, &t, std::slice::from_ref(&md)).await;
    assert!(shown_plain(&cs[0]["body"], &md), "{:.300}", cs[0]["body"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn markup_renders_to_the_compact_ast_and_githubs_markup_survives() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    let (o, r, n) = (
        t["owner"].as_str().unwrap(),
        t["repo"].as_str().unwrap(),
        &t["number"],
    );
    let githubs = "\
- [x] done
- [ ] todo

> [!WARNING]
> Careful

Text[^n]

```rust
fn main() {}
```

<details open><summary>More</summary>

Inside

</details>

<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup>

<picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://x.test/d.png\"><img src=\"https://x.test/l.png\" alt=\"logo\" width=\"40\" height=\"20\" align=\"right\"></picture>

[^n]: The note.
";
    let mds = [
        "Hello *world*\n\n- a\n- b\n",
        "```mermaid\ngraph TD; A-->B\n```\n\n```math\nx^2\n```\n\n$y_1$\n",
        githubs,
        "A[^1] and <a id=\"top\" href=\"#top\">up</a>\n\n[^1]: Note.\n",
        "[a](other) [b](/x/y) [c](#frag) ![i](pic.png)",
        // A thematic break of many markers opens no lists, however many there are.
        &"- ".repeat(150),
    ]
    .map(str::to_owned);
    let (cs, _) = comment_all(&s, &mut b, &t, &mds).await;

    // An element is `[tag, attrs | 0, ...children]`, text a plain string.
    assert_eq!(
        cs[0]["body"],
        json!([
            ["p", 0, "Hello ", ["em", 0, "world"]],
            ["ul", 0, ["li", 0, "a"], ["li", 0, "b"]]
        ])
    );
    assert_eq!(cs[5]["body"], json!([["hr", 0]]));
    // Mermaid and math stay code and text.
    assert_eq!(
        cs[1]["body"],
        json!([
            ["pre", 0, ["code", {"class": "language-mermaid"}, "graph TD; A-->B\n"]],
            ["pre", 0, ["code", {"class": "language-math"}, "x^2\n"]],
            ["p", 0, "$y_1$"]
        ])
    );

    // Task lists, alerts, footnotes, code languages, details, kbd, sub/sup and picture.
    let els = elements(&cs[2]["body"]);
    let has = |tag: &str, attrs: Value| {
        els.iter().any(|(t, at)| {
            t == tag
                && attrs
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(k, v)| at.get(k) == Some(v))
        })
    };
    let a = &cs[2]["body"];
    for (tag, attrs) in [
        (
            "input",
            json!({"type": "checkbox", "checked": "", "disabled": ""}),
        ),
        ("input", json!({"type": "checkbox", "disabled": ""})),
        ("code", json!({"class": "language-rust"})),
        (
            "div",
            json!({"class": "markdown-alert markdown-alert-warning"}),
        ),
        ("p", json!({"class": "markdown-alert-title"})),
        (
            "section",
            json!({"class": "footnotes", "data-footnotes": ""}),
        ),
        ("sup", json!({"class": "footnote-ref"})),
        ("details", json!({"open": ""})),
        ("summary", json!({})),
        ("kbd", json!({})),
        ("sub", json!({})),
        ("sup", json!({})),
        ("picture", json!({})),
        (
            "source",
            json!({"media": "(prefers-color-scheme: dark)", "srcset": "https://x.test/d.png"}),
        ),
        (
            "img",
            json!({"src": "https://x.test/l.png", "alt": "logo", "width": "40", "height": "20", "align": "right"}),
        ),
    ] {
        assert!(has(tag, attrs.clone()), "{tag} {attrs}: {a}");
    }

    // Footnote and raw ids, and the links to them, carry the comment's prefix.
    let prefix = format!("md-c{}-", cs[3]["id"]);
    let els = elements(&cs[3]["body"]);
    let attr = |tag: &str, k: &str| -> Vec<String> {
        els.iter()
            .filter(|(t, _)| t == tag)
            .filter_map(|(_, at)| at.get(k).and_then(Value::as_str).map(str::to_owned))
            .collect()
    };
    let ids: Vec<String> = attr("a", "id")
        .into_iter()
        .chain(attr("li", "id"))
        .collect();
    let hrefs = attr("a", "href");
    assert!(
        !ids.is_empty() && ids.iter().all(|i| i.starts_with(&prefix)),
        "{ids:?}"
    );
    assert!(
        hrefs.iter().all(|h| h.starts_with(&format!("#{prefix}"))),
        "{hrefs:?}"
    );
    for h in &hrefs {
        assert!(
            ids.contains(&h[1..].to_owned()),
            "{h} lands on an id in {ids:?}"
        );
    }

    // Relative URLs resolve against the issue's page on GitHub.
    let urls: Vec<String> = elements(&cs[4]["body"])
        .iter()
        .filter_map(|(_, at)| at.get("href").or(at.get("src")).and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    assert_eq!(
        urls,
        [
            format!("https://github.com/{o}/{r}/issues/other"),
            "https://github.com/x/y".to_owned(),
            format!("#md-c{}-frag", cs[4]["id"]),
            format!("https://github.com/{o}/{r}/issues/pic.png"),
        ],
        "issue #{n}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unsafe_html_in_a_comment_is_stripped_and_its_text_kept() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    // An element whose content an HTML parser reads as text makes the post plain text, never
    // HTML: the next test shows why.
    let raw = [
        "<script>alert(1)</script>after",
        "<style>p{}</style>after",
        "<iframe src=\"https://x.test\"></iframe>after",
    ];
    let mds = [("<object data=x></object>after", "object")];
    let attrs = "<b onclick=\"x()\" style=\"color:red\" class=\"evil\">b</b> \
         <img src=\"https://x.test/a.png\" onerror=\"x()\"> \
         [link](javascript:alert(1)) <a href=\"JaVaScRiPt:alert(1)\">raw</a> \
         <a href=\"data:text/html,x\">data</a> <a href=\"vbscript:x\">vb</a>";
    let all: Vec<String> = mds
        .iter()
        .map(|(md, _)| (*md).to_owned())
        .chain([attrs.to_owned()])
        .chain(raw.map(str::to_owned))
        .collect();
    let (cs, _) = comment_all(&s, &mut b, &t, &all).await;
    for (md, c) in raw.iter().zip(&cs[2..]) {
        assert!(shown_plain(&c["body"], md), "{md}: {}", c["body"]);
    }
    for ((md, tag), c) in mds.iter().zip(&cs) {
        let a = &c["body"];
        assert!(elements(a).iter().all(|(t, _)| t != tag), "{md}: {a}");
        assert!(!text(a).contains("alert"), "{md}: its contents go too: {a}");
        assert!(text(a).contains("after"), "{md}: {a}");
    }
    let a = &cs[1]["body"];
    for (tag, attrs) in elements(a) {
        let attrs = attrs.as_object().cloned().unwrap_or_default();
        for k in attrs.keys() {
            assert!(
                !k.starts_with("on") && k != "style" && k != "class",
                "{tag} {k}: {a}"
            );
        }
        if tag == "a" {
            assert_eq!(attrs.get("href"), None, "only an unsafe href is left: {a}");
        }
    }
    assert!(text(a).contains("link") && text(a).contains("raw"), "{a}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_to_an_issue_with_its_own_text_stays_a_link_and_its_issue_is_in_refs() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let (o, r) = (t["owner"].as_str().unwrap(), t["repo"].as_str().unwrap());
    let url = format!("https://github.com/{o}/{r}/issues/{}", x["number"]);
    let bare = format!(
        "https://github.com/{}/{}/pull/{}",
        o.to_uppercase(),
        r,
        x["number"]
    );
    let mds = [format!("[the bug]({url})"), bare.clone()];
    let (cs, refs) = comment_all(&s, &mut b, &t, &mds).await;
    assert_eq!(
        cs[0]["body"],
        json!([["p", 0, ["a", {"href": url}, "the bug"]]])
    );
    let key = format!("{o}/{r}#{}", x["number"]).to_lowercase();
    assert_eq!(refs[&key]["id"], x["id"]);
    // A bare link (its text is its URL) is a reference, as written.
    assert_eq!(
        refs_in(&cs[1]["body"]),
        vec![json!({ "o": o.to_uppercase(), "r": r, "n": x["number"] })]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn references_follow_githubs_rules_for_what_links() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let (o, r) = (t["owner"].as_str().unwrap(), t["repo"].as_str().unwrap());
    let mds = [
        // No login starts with a hyphen; no number past what a browser holds exactly is one.
        "-x/y#15, #9007199254740992 and #9007199254740991".to_owned(),
        // `@org/team` is a team, and its `@org` never a user (GitHub's MentionFilter). An EMU
        // login is a handle, an underscore and its enterprise's 3 to 8 character shortcode:
        // nothing else with an underscore is a login.
        "@acme/core and @octo_acme, not @acme/ @octo_ac @octo_acme_x @_octo".to_owned(),
        // A login never ends with a hyphen, and a login followed by dots then a word is none:
        // `@ilze-` isn't `@ilze`, nor `@acme-/core` a team or `@acme`, nor `@ilze.k` `@ilze`.
        "@ilze- @acme-/core @ilze.k, @ilze.".to_owned(),
        // A link to a comment names it.
        format!(
            "https://github.com/{o}/{r}/issues/{}#issuecomment-12",
            x["number"]
        ),
    ];
    let (cs, _) = comment_all(&s, &mut b, &t, &mds).await;
    assert_eq!(
        refs_in(&cs[0]["body"]),
        vec![json!({ "o": o, "r": r, "n": 9007199254740991_i64 })]
    );
    assert!(text(&cs[0]["body"]).starts_with("-x/y#15, #9007199254740992 and "));
    assert_eq!(
        refs_in(&cs[1]["body"]),
        vec![json!({ "t": "acme/core" }), json!({ "u": "octo_acme" })]
    );
    assert_eq!(
        text(&cs[1]["body"]),
        " and , not @acme/ @octo_ac @octo_acme_x @_octo"
    );
    assert_eq!(refs_in(&cs[2]["body"]), vec![json!({ "u": "ilze" })]);
    assert_eq!(text(&cs[2]["body"]), "@ilze- @acme-/core @ilze.k, .");
    assert_eq!(
        refs_in(&cs[3]["body"]),
        vec![json!({ "o": o, "r": r, "n": x["number"], "c": 12 })]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn raw_html_that_would_hide_tags_from_the_checks_shows_as_plain_text() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    let attrs: String = (0..100).map(|i| format!(" a{i}")).collect();
    let mds = [
        // An end tag's attributes cost an HTML parser what a start tag's do.
        format!("<div>\n</p{attrs}>"),
        // Inside a comment, `<b a='` opens no quote: the `<p` after the comment is a tag.
        format!("<div>\n<!-- <b a=' --><p x='>'{attrs}>"),
        // Inside `<script>` and `<textarea>`, nothing is a tag until their end tag.
        format!("<script><b a='</script><p x='>'{attrs}>"),
        format!("<div>\n<textarea>{}</textarea>", "<div>".repeat(200)),
        // Even alone: the sanitiser drops them all, and they'd show as nothing.
        "<style>p { color: red }</style>".to_owned(),
    ];
    let (cs, _) = comment_all(&s, &mut b, &t, &mds).await;
    for (md, c) in mds.iter().zip(&cs) {
        assert!(shown_plain(&c["body"], md), "{md:.60}: {:.200}", c["body"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_post_shown_as_plain_text_links_what_a_rendering_would() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let (o, r) = (t["owner"].as_str().unwrap(), t["repo"].as_str().unwrap());
    let n = &x["number"];
    // Past the bounds (the table would fill in 52,000 cells), so plain text: a bare link to an
    // issue is still a reference, and `#n` in code still isn't.
    let md = format!(
        "See #{n}, https://github.com/{o}/{r}/issues/{n}#issuecomment-7 and https://x.io/a?b=@c.\n\
         `#{n}` and ``a ` #{n}``\n\n```\n#{n} @ilze-k\n```\n\n|{}\n|{}\n{}",
        "a|".repeat(20),
        "-|".repeat(20),
        "|1\n".repeat(2_600)
    );
    let (cs, refs) = comment_all(&s, &mut b, &t, std::slice::from_ref(&md)).await;
    let body = &cs[0]["body"];
    assert_eq!(body[1][0], "pre", "{:.300}", body);
    assert_eq!(
        refs_in(body),
        vec![
            json!({ "o": o, "r": r, "n": n }),
            json!({ "o": o, "r": r, "n": n, "c": 7 }),
        ]
    );
    let key = format!("{o}/{r}#{n}").to_lowercase();
    assert_eq!(refs[&key]["id"], x["id"]);
    // Nothing of the text is lost: the URL's text is where its reference is.
    let url = format!("https://github.com/{o}/{r}/issues/{n}#issuecomment-7");
    assert_eq!(
        text(&json!([body[1]])),
        md.replacen(&format!("#{n},"), ",", 1).replacen(&url, "", 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_post_with_more_references_than_a_rendering_may_have_keeps_the_first_linked() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let t = page["rows"][0].clone();
    // 60,000 references: more than a post may have, rendered or as plain text.
    let md = "#1 ".repeat(60_000);
    let (cs, _) = comment_all(&s, &mut b, &t, std::slice::from_ref(&md)).await;
    let body = &cs[0]["body"];
    let pre = body[1].as_array().unwrap();
    assert_eq!(pre[0], "pre");
    let linked = refs_in(body).len();
    assert!(
        (10_000..md_ast::MAX_NODES).contains(&linked),
        "{linked} linked"
    );
    // The first are links, and the rest is their text.
    assert_eq!(
        pre[2],
        json!(["ref", { "o": t["owner"], "r": t["repo"], "n": 1 }])
    );
    assert_eq!(
        text(&json!([body[1]])).len() + 2 * linked,
        md.len(),
        "{:.200}",
        pre.last().unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_item_outside_the_synced_repos_is_never_an_in_app_ref() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (t, x) = two_in_one_repo(&s, &mut b).await;
    let key = |o: &Value, r: &Value, n: &Value| {
        format!("{}/{}#{n}", o.as_str().unwrap(), r.as_str().unwrap()).to_lowercase()
    };
    // A stub a relationship reaches: the mirror holds it, in a repo it doesn't sync.
    let (status, stub) = s
        .api(&mut b, &format!("/api/issues/{}", linked_stub()))
        .await;
    assert_eq!(status, 403, "{stub}");
    let stub = &stub["issue"];
    // And an issue in docs, which is then unsynced.
    let (_, other) = s.api(&mut b, "/api/issues?q=repo%3Adocs").await;
    let other = other["rows"][0].clone();
    assert_eq!(other["repo"], "docs", "{other}");
    assert_ne!(t["repo"], "docs");
    let md = format!(
        "#{} {}/{}#{} {}/{}#{}",
        x["number"],
        stub["owner"].as_str().unwrap(),
        stub["repo"].as_str().unwrap(),
        stub["number"],
        other["owner"].as_str().unwrap(),
        other["repo"].as_str().unwrap(),
        other["number"]
    );
    let (_, refs) = comment_all(&s, &mut b, &t, std::slice::from_ref(&md)).await;
    let (mine, stubs, theirs) = (
        key(&t["owner"], &t["repo"], &x["number"]),
        key(&stub["owner"], &stub["repo"], &stub["number"]),
        key(&other["owner"], &other["repo"], &other["number"]),
    );
    assert_eq!(refs[&mine]["id"], x["id"]);
    assert_eq!(refs[&theirs]["id"], other["id"]);
    assert!(refs.get(&stubs).is_none(), "{refs}");

    // Unsynced, and the unsync stopped before any of its rows went (as in crates/server/tests/
    // import.rs): another writer holds the mirror, and the process restarts while it waits.
    // docs's rows are still in the mirror, in a repo no longer synced.
    let (_, picker) = s.api(&mut b, "/api/repos").await;
    let keep: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["synced"] == true && r["name"] != "docs")
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let mirror = s.data.join("mirrors").join("1000.db");
    let mut writer = rusqlite::Connection::open(&mirror).unwrap();
    let lock = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let pick = tokio::spawn(
        s.api_write(&b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": keep }))
            .send(),
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.restart_with(|_| {}).await;
    drop(lock);
    let _ = pick.await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.api(&mut b, "/api/facets").await.1["repos"]
        .as_array()
        .unwrap()
        .contains(&json!("docs"))
    {
        assert!(Instant::now() < deadline, "docs stayed synced");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let path = format!("/api/issues/{}/comments?order=newest", t["id"]);
    let (_, page) = s.api(&mut b, &path).await;
    assert_eq!(page["refs"][&mine]["id"], x["id"], "{}", page["refs"]);
    assert!(page["refs"].get(&theirs).is_none(), "{}", page["refs"]);
    assert!(page["refs"].get(&stubs).is_none(), "{}", page["refs"]);
}
