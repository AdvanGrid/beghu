//! PROTOTYPE — how long the slow in-place migration (0002, FTS over every item) holds waiters
//! at 20k and 50k items, and what a fresh create plus `PRAGMA user_version` cost.
//!
//!     cargo run --release -p proto --bin timing
use std::time::Instant;

fn main() {
    let dir = std::path::Path::new("PROTOTYPE-wipe-me");
    std::fs::create_dir_all(dir).unwrap();
    for n in [20_000, 50_000] {
        let p = dir.join(format!("timing-{n}.sqlite"));
        let t = Instant::now();
        dbrt::migrations::create_fresh(&p, mirror_db::MIGRATIONS, 1).unwrap();
        let fresh = t.elapsed();
        let mut c = rusqlite::Connection::open(&p).unwrap();
        c.execute_batch("INSERT INTO repos VALUES (1, 'acme', 'web')").unwrap();
        let tx = c.transaction().unwrap();
        {
            let mut st = tx.prepare("INSERT INTO items (id, repo_id, number, kind, state, title, body, updated_at) VALUES (?1, 1, ?1, 'issue', 'open', ?2, ?3, '2026-10-20')").unwrap();
            for i in 1..=n {
                let body = format!("Body of issue {i}. ").repeat(30); // ~600 bytes
                st.execute(rusqlite::params![i, format!("Issue number {i} about login and sweeps"), body]).unwrap();
            }
        }
        tx.commit().unwrap();
        let t = Instant::now();
        let v = dbrt::migrations::file_version(&p).unwrap();
        let open = t.elapsed();
        let t = Instant::now();
        dbrt::migrations::migrate_in_place(&mut c, mirror_db::MIGRATIONS, 1, 3, None).unwrap();
        let mig = t.elapsed();
        println!("{n:>6} items: fresh create {fresh:.1?}, read user_version {open:.1?} ({v:?}), in-place v1→v3 (FTS + unique index) {mig:.1?}");
        drop(c);
        let _ = std::fs::remove_file(&p);
    }
}
