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

#[tokio::test]
async fn the_walker_takes_the_active_accounts_the_most_recently_used_first() {
    let dir = tempfile::tempdir().unwrap();
    let (control, _) =
        Control::open(&dir.path().join("control.db"), &dir.path().join("backups")).unwrap();
    let order = control
        .write(|tx| {
            q::upsert_account(tx, 1, "old", 100)?;
            q::upsert_account(tx, 2, "recent", 100)?;
            q::upsert_account(tx, 3, "dormant", 100)?;
            q::upsert_account(tx, 4, "signed-out", 100)?;
            q::upsert_account(tx, 5, "tied", 100)?;
            q::touch_account(tx, 2, 300)?;
            q::touch_account(tx, 1, 200)?;
            q::go_dormant(tx, 3, 100, 400)?;
            q::set_account_status(tx, 4, "needs_sign_in")?;
            q::walk_order(tx)
        })
        .await
        .unwrap();
    // Neither a dormant account nor one that must sign in again has a mirror to walk.
    assert_eq!(order, vec![2, 1, 5]);
}

/// The control DB as a build before the keymap (migration 6) left it: an account that chose
/// oldest first.
fn before_the_keymap(path: &std::path::Path) {
    let c = rusqlite::Connection::open(path).unwrap();
    // As `dbrt::migrations::migrate_control` records them.
    c.execute_batch("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))")
        .unwrap();
    for m in &control_db::MIGRATIONS[..5] {
        c.execute_batch(m.sql).unwrap();
        c.execute(
            "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
            (m.version, m.name),
        )
        .unwrap();
    }
    c.execute_batch(
        "INSERT INTO accounts (github_user_id, login, created_at, last_active_at) VALUES (1, 'tomsj', 100, 100);
         INSERT INTO preferences (github_user_id, comment_order) VALUES (1, 'oldest');",
    )
    .unwrap();
}

#[tokio::test]
async fn a_migration_adding_key_actions_leaves_existing_accounts_on_the_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.db");
    before_the_keymap(&path);
    let (control, outcome) = Control::open(&path, &dir.path().join("backups")).unwrap();
    assert!(
        matches!(outcome, ControlOutcome::Migrated { from: 5, .. }),
        "{outcome:?}"
    );

    let (account, keys) = control
        .read(|c| Ok((q::account(c, 1)?.unwrap(), q::key_bindings(c, 1)?)))
        .await
        .unwrap();
    assert_eq!(account.comment_order.as_deref(), Some("oldest"));
    assert!(
        keys.is_empty(),
        "every new action is on its default: {:?}",
        keys.iter().map(|k| &k.action).collect::<Vec<_>>()
    );

    // Each key change sets its own action only; '' is kept as unbound, NULL goes back to the
    // default.
    control
        .write(|tx| {
            q::set_key(tx, 1, "next", Some("n"))?;
            q::set_key(tx, 1, "help", Some(""))?;
            q::set_key(tx, 1, "openIssue", Some("Enter\nShift+o"))?;
            q::set_key(tx, 1, "openIssue", None)
        })
        .await
        .unwrap();
    let keys = control.read(|c| q::key_bindings(c, 1)).await.unwrap();
    let got: Vec<_> = keys
        .iter()
        .map(|k| (k.action.as_str(), k.binding.as_str()))
        .collect();
    assert_eq!(got, [("next", "n"), ("help", "")]);
}
