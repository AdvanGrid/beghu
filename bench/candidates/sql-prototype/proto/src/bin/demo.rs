//! PROTOTYPE — part 1: what the build-time checker generates, the generated functions running
//! on a real mirror file, and what the checker says about broken SQL.
//!
//!     cargo run -p proto --bin demo
use dbrt::filter::Filter;
use mirror_db::{frag, q};
use std::path::Path;

const B: &str = "\x1b[1m";
const D: &str = "\x1b[2m";
const R: &str = "\x1b[0m";

fn main() {
    println!("{B}== What build.rs derived for each query (column, Rust type, why) =={R}\n");
    println!("{B}mirror schema v{}{R}\n{D}{}{R}\n", mirror_db::SCHEMA_VERSION, mirror_db::QUERY_REPORT);
    println!("{B}control schema v{}{R}\n{D}{}{R}\n", control_db::SCHEMA_VERSION, control_db::QUERY_REPORT);

    println!("{B}== The generated functions on a real file =={R}\n");
    let dir = Path::new("PROTOTYPE-wipe-me");
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("demo-mirror.sqlite");
    dbrt::migrations::create_fresh(&path, mirror_db::MIGRATIONS, mirror_db::SCHEMA_VERSION).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO repos VALUES (1, 'acme', 'web'), (2, 'acme', 'api');
         INSERT INTO milestones VALUES (1, 1, 'v1');
         INSERT INTO labels VALUES (1, 1, 'bug', 'd73a4a'), (2, 1, 'ui', '0e8a16'), (3, 2, 'bug', 'd73a4a');
         INSERT INTO users VALUES (1, 'toms', NULL);",
    ).unwrap();
    let rows = [
        (1, 1, 1, "Login button misaligned", Some("The button sits 2px low on Safari."), "open", "2026-10-20"),
        (2, 1, 2, "Dark mode flicker", None, "open", "2026-10-22"),
        (3, 2, 1, "Rate limit on sweeps", Some("Sweeps hit the secondary rate limit."), "open", "2026-10-21"),
        (4, 1, 3, "Login redirect loops", Some("After sign-out the login page loops."), "closed", "2026-10-19"),
        (5, 1, 4, "Child of the misaligned button", None, "open", "2026-10-23"),
    ];
    for (id, repo, n, title, body, state, at) in rows {
        let r = q::upsert_item(&conn, id, repo, n, title, body, state, at).unwrap();
        assert_eq!(r.id, id); // `RETURNING id` is i64, not Option<i64>
    }
    conn.execute_batch(
        "UPDATE items SET milestone_id = 1 WHERE id IN (1, 4);
         UPDATE items SET parent_id = 1 WHERE id = 5;
         INSERT INTO item_labels VALUES (1, 1), (1, 2), (3, 3), (4, 1);
         INSERT INTO item_assignees VALUES (1, 1), (3, 1);
         INSERT INTO items_fts(items_fts) VALUES ('rebuild');",
    ).unwrap();

    show("q::list_page(&conn, \"open\", 3)", q::list_page(&conn, "open", 3));
    show("q::detail(&conn, 2)  -- no milestone, no parent", q::detail(&conn, 2));
    show("q::detail(&conn, 99) -- :opt", q::detail(&conn, 99));
    show("q::search(&conn, \"login\", 5)", q::search(&conn, "login", 5));
    show("q::subtree(&conn, 1)", q::subtree(&conn, 1));
    show("q::items_with_labels(&conn, 1) -- item 2 has no labels", q::items_with_labels(&conn, 1));
    show("q::labelled_titles(&conn)", q::labelled_titles(&conn));

    // The filter bar: `label:bug repo:web,api -no:milestone is:open`, built from checked
    // fragments, then a checked hydrate in the id order.
    let filter = Filter::And(vec![
        frag::label("bug"),
        Filter::Or(vec![frag::repo("web"), frag::repo("api")]),
        Filter::Not(Box::new(frag::no_milestone())),
        frag::state("open"),
    ]);
    println!("{B}filter.render(){R}\n  {D}{:?}{R}\n", filter.render());
    let ids = q::issue_ids(&conn, &filter, 50).unwrap();
    show("q::issue_ids(&conn, &filter, 50)", Ok::<_, rusqlite::Error>(ids.clone()));
    show("q::hydrate(&conn, &ids)", q::hydrate(&conn, &ids));
    let ft = Filter::And(vec![frag::text("login*"), frag::assignee("toms")]);
    show("q::issue_ids(&conn, text:login* AND assignee:toms)", q::issue_ids(&conn, &ft, 50));

    println!("{B}== What the checker says about broken SQL =={R}\n");
    broken();
}

fn show<T: std::fmt::Debug>(label: &str, r: rusqlite::Result<T>) {
    println!("{B}{label}{R}\n  {D}{:#?}{R}\n", r.unwrap());
}

/// Each case copies mirror-db's migrations and queries to a scratch dir, breaks one thing, and
/// runs the same check build.rs runs.
fn broken() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mirror-db");
    let cases: &[(&str, &str, &str, &str)] = &[
        ("a typo in a column", "queries/items.sql", "SELECT i.id, i.number, i.title, i.state, i.updated_at, i.comments_count,", "SELECT i.id, i.number, i.titel, i.state, i.updated_at, i.comments_count,"),
        ("a parameter with no `-- param:` line", "queries/items.sql", "WHERE i.id = :id;", "WHERE i.id = :item;"),
        ("an expression with no type", "queries/items.sql", "AS \"label_count!: i64\"", "AS label_count"),
        ("SELECT *", "queries/items.sql", "SELECT l.name, l.color\n", "SELECT *\n"),
        ("a fragment naming a missing table", "queries/filters.sql", "FROM item_assignees ia", "FROM assignees ia"),
        ("a new migration drops a column a query reads", "migrations/0005_drop.sql", "", "ALTER TABLE milestones DROP COLUMN title;"),
        ("a migration that fails on an empty database", "migrations/0005_bad.sql", "", "CREATE INDEX x ON items(no_such_column);"),
    ];
    for (what, file, from, to) in cases {
        let tmp = std::env::temp_dir().join(format!("sqlcheck-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for sub in ["migrations", "queries"] {
            std::fs::create_dir_all(tmp.join(sub)).unwrap();
            for e in std::fs::read_dir(src.join(sub)).unwrap() {
                let e = e.unwrap();
                std::fs::copy(e.path(), tmp.join(sub).join(e.file_name())).unwrap();
            }
        }
        let f = tmp.join(file);
        if from.is_empty() {
            std::fs::write(&f, to).unwrap();
        } else {
            let s = std::fs::read_to_string(&f).unwrap();
            assert!(s.contains(from), "{what}: pattern not found");
            std::fs::write(&f, s.replacen(from, to, 1)).unwrap();
        }
        let mut errs = Vec::new();
        sqlcheck::check(&tmp, &sqlcheck::Options { allow_rebuild: true }, &mut errs);
        println!("{B}{what}{R}");
        for e in errs {
            println!("  error: {}", e.replace(&format!("{}/", tmp.display()), ""));
        }
        println!();
        let _ = std::fs::remove_dir_all(&tmp);
    }
    let mut errs = Vec::new();
    let tmp = std::env::temp_dir().join(format!("sqlcheck-ctl-{}", std::process::id()));
    let ctl = Path::new(env!("CARGO_MANIFEST_DIR")).join("../control-db");
    for sub in ["migrations", "queries"] {
        std::fs::create_dir_all(tmp.join(sub)).unwrap();
        for e in std::fs::read_dir(ctl.join(sub)).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), tmp.join(sub).join(e.file_name())).unwrap();
        }
    }
    std::fs::write(tmp.join("migrations/0004_x.rebuild.sql"), "SELECT 1;").unwrap();
    std::fs::write(tmp.join("queries/oops.sql"), "-- name: oops :many\nSELECT id, title FROM items;\n").unwrap();
    sqlcheck::check(&tmp, &sqlcheck::Options { allow_rebuild: false }, &mut errs);
    println!("{B}control: a rebuild migration, and a query naming a mirror table{R}");
    for e in errs {
        println!("  error: {}", e.replace(&format!("{}/", tmp.display()), ""));
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
