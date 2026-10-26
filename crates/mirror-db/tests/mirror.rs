//! What the mirror schema promises its writers and readers: one `seq` per write transaction,
//! and full-text search kept current by the schema itself.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::filter::Filter;
use mirror_db::{Caller, Config, Mirrors, frag, q};

const ACCT: i64 = 7;

fn issue(
    tx: &rusqlite::Connection,
    id: i64,
    title: &str,
    body: &str,
    seq: i64,
) -> rusqlite::Result<usize> {
    q::insert_item(
        tx, id, "I_x", 1, id, "issue", title, body, "open", None, 1, None, 0, id, None, None, None,
        None, None, None, None, seq,
    )
}

async fn ids(m: &Mirrors, filter: Filter) -> Vec<i64> {
    m.read(ACCT, Caller::Request, move |c| {
        q::item_ids(c, &filter, "issue", 50)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn every_write_transaction_bumps_seq_once_and_a_failed_one_leaves_it() {
    let dir = tempfile::tempdir().unwrap();
    let m = Mirrors::new(dir.path(), Config::default());

    let first = m
        .write(ACCT, Caller::Webhook, |tx, seq| {
            issue(tx, 1, "one", "", seq)?;
            issue(tx, 2, "two", "", seq)?;
            Ok(seq)
        })
        .await
        .unwrap();
    let failed = m.write(ACCT, Caller::Webhook, |tx, seq| {
        issue(tx, 3, "three", "", seq)?;
        issue(tx, 3, "three again", "", seq) // duplicate id: the transaction rolls back
    });
    assert!(failed.await.is_err());
    let second = m
        .write(ACCT, Caller::Webhook, |tx, seq| {
            issue(tx, 4, "four", "", seq).map(|_| seq)
        })
        .await
        .unwrap();

    assert_eq!(second, first + 1);
    let changed = m
        .read(ACCT, Caller::Request, |c| q::items_changed_since(c, 0))
        .await
        .unwrap();
    let changed: Vec<(i64, i64)> = changed.into_iter().map(|r| (r.id, r.seq)).collect();
    assert_eq!(changed, [(1, first), (2, first), (4, second)]);
}

#[tokio::test]
async fn titles_bodies_and_comments_are_searchable_as_they_change_and_stubs_are_not() {
    let dir = tempfile::tempdir().unwrap();
    let m = Mirrors::new(dir.path(), Config::default());
    m.write(ACCT, Caller::Webhook, |tx, seq| {
        q::insert_repo(
            tx,
            1,
            "R_x",
            "acme",
            "web",
            true,
            Some(1),
            true,
            Some("write"),
        )?;
        issue(
            tx,
            1,
            "Dark theme contrast",
            "Borders vanish on Safari",
            seq,
        )?;
        issue(tx, 2, "Date parsing", "Off by one", seq)?;
        q::insert_stub(tx, 3, "I_s", 2, 9, "Dark mode in the SDK", "open", seq)?;
        q::insert_comment(tx, 10, "IC_x", 2, 1, "Also broken in Firefox", 0, seq)
    })
    .await
    .unwrap();

    assert_eq!(
        ids(&m, frag::text("dark")).await,
        [1],
        "a stub is never indexed"
    );
    assert_eq!(
        ids(&m, frag::text("saf*")).await,
        [1],
        "prefix match on the body"
    );
    assert_eq!(ids(&m, frag::comment_text("firefox")).await, [2]);
    let either = Filter::Or(vec![frag::text("safari"), frag::comment_text("firefox")]);
    assert_eq!(ids(&m, either).await, [2, 1]);

    m.write(ACCT, Caller::Webhook, |tx, _| {
        tx.execute(
            "UPDATE items SET title = 'Light theme contrast' WHERE id = 1",
            [],
        )?;
        tx.execute(
            "UPDATE comments SET body = 'Fine in Chrome' WHERE id = 10",
            [],
        )?;
        // The repo becomes synced: its stub is now a real issue.
        tx.execute(
            "UPDATE items SET is_stub = 0, body = 'SDK side' WHERE id = 3",
            [],
        )
    })
    .await
    .unwrap();
    assert_eq!(ids(&m, frag::text("dark")).await, [3]);
    assert_eq!(ids(&m, frag::text("light")).await, [1]);
    assert!(ids(&m, frag::comment_text("firefox")).await.is_empty());
    assert_eq!(ids(&m, frag::comment_text("chrome")).await, [2]);

    m.write(ACCT, Caller::Webhook, |tx, _| {
        tx.execute("DELETE FROM items WHERE id = 3", [])
    })
    .await
    .unwrap();
    assert!(ids(&m, frag::text("dark")).await.is_empty());
}
