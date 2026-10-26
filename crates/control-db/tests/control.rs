//! The real control schema opens fresh and serves its checked queries.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use control_db::{Control, ControlOutcome, SCHEMA_VERSION, q};

#[tokio::test]
async fn a_fresh_control_db_migrates_to_the_build_and_keeps_preferences_per_account() {
    let dir = tempfile::tempdir().unwrap();
    let (control, outcome) =
        Control::open(&dir.path().join("control.db"), &dir.path().join("backups")).unwrap();
    assert_eq!(
        outcome,
        ControlOutcome::Migrated {
            from: 0,
            to: SCHEMA_VERSION,
            backup: None
        }
    );

    control
        .write(|tx| {
            q::upsert_account(tx, 1, "tomsj", 100)?;
            q::upsert_account(tx, 2, "ilze-k", 100)?;
            q::set_comment_order(tx, 1, Some("oldest"))
        })
        .await
        .unwrap();
    let (a, b) = control
        .read(|c| Ok((q::account(c, 1)?.unwrap(), q::account(c, 2)?.unwrap())))
        .await
        .unwrap();
    assert_eq!(
        (
            a.login.as_str(),
            a.status.as_str(),
            a.comment_order.as_deref()
        ),
        ("tomsj", "active", Some("oldest"))
    );
    assert_eq!(b.comment_order, None, "no row means the default");
}

#[tokio::test]
async fn deleting_an_account_deletes_its_preferences_and_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let (control, _) =
        Control::open(&dir.path().join("control.db"), &dir.path().join("backups")).unwrap();
    control
        .write(|tx| {
            q::upsert_account(tx, 1, "tomsj", 100)?;
            q::set_comment_order(tx, 1, Some("oldest"))?;
            tx.execute("INSERT INTO account_tokens (github_user_id, access_enc, access_expires_at, refresh_enc, refresh_expires_at) VALUES (1, x'00', 0, x'00', 0)", [])
        })
        .await
        .unwrap();

    control
        .write(|tx| tx.execute("DELETE FROM accounts WHERE github_user_id = 1", []))
        .await
        .unwrap();
    control
        .write(|tx| q::upsert_account(tx, 1, "tomsj", 200))
        .await
        .unwrap();

    let (account, tokens) = control
        .read(|c| {
            Ok((
                q::account(c, 1)?.unwrap(),
                c.query_row("SELECT count(*) FROM account_tokens", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(
        account.comment_order, None,
        "the old preferences went with the account"
    );
    assert_eq!(tokens, 0);
}
