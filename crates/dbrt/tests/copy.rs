//! `copy_over` leaves `dest` and nothing else when the edit fails.
#![allow(clippy::disallowed_methods)] // tests of a database crate run raw SQL

use dbrt::copy::copy_over;

#[test]
fn a_failed_edit_leaves_no_copy_behind() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.db");
    rusqlite::Connection::open(&src)
        .unwrap()
        .pragma_update(None, "user_version", 1)
        .unwrap();
    let dest = dir.path().join("dest.db");

    let out: Result<(), dbrt::Error> = copy_over(&src, &dest, |conn| {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "user_version", 2)?;
        Err(dbrt::Error::MigrationFailed("no".into()))
    });
    assert!(out.is_err());

    let mut left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["src.db"]);
}
