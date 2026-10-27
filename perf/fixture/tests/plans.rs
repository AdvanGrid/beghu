//! No hot query does a full scan: the filter bar's presets, each qualifier, every sort both ways
//! under each state and none (its first page, the page after a cursor and a live refetch through
//! one), and the filter bar's
//! suggestions (`/api/facets` and the facet counts) read their rows through an index on the 1k
//! fixture. Each query is the app's own (`mirror_db::list`, `mirror_db::q`), caught with its
//! parameters from SQLite's trace hook and handed to `dbrt::plan::explain`.

use fixture::{Scale, cached};
use mirror_db::list::{self, Cursor, Sort, SortKey, Span, View, Who, Word};
use mirror_db::q;
use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

static RAN: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record(e: TraceEvent<'_>) {
    if let TraceEvent::Stmt(stmt, _) = e
        && let Some(sql) = stmt.expanded_sql()
    {
        RAN.lock().unwrap().push(sql);
    }
}

/// The trace hook collects into one global: one test at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// The 1k fixture, generated once for the file, opened with the trace hook on.
fn fixture() -> (MutexGuard<'static, ()>, Connection) {
    let guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    static PATH: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    let (_, path) = PATH.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = cached(Scale::K1, &dir.path().join("fixture")).unwrap();
        (dir, path)
    });
    let c = Connection::open(path).unwrap();
    c.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(record));
    (guard, c)
}

/// The plan of the first statement `run` makes whose SQL contains `marker`, one line per step.
fn plan_of(c: &Connection, marker: &str, run: impl FnOnce(&Connection)) -> Vec<String> {
    RAN.lock().unwrap().clear();
    run(c);
    // FTS5 runs statements of its own on its shadow tables around the app's.
    let sql = RAN
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.contains(marker))
        .cloned()
        .unwrap_or_else(|| panic!("no statement with {marker:?} ran"));
    dbrt::plan::explain(c, &sql).unwrap()
}

const ME: i64 = 1000; // tomsj, as the fixture numbers its users

/// The plan of the id query for `span` of `view`.
fn plan(c: &Connection, view: &View, span: Span) -> Vec<String> {
    plan_of(c, "FROM items i", |c| {
        list::ids(c, view.sort, list::filter(view, ME), span, 101).unwrap();
    })
}

/// The cursor after `view`'s first page.
fn page_two(c: &Connection, view: &View) -> Cursor {
    *list::ids(c, view.sort, list::filter(view, ME), Span::Top, 101)
        .unwrap()
        .last()
        .expect("the view has a first page")
}

/// A step that reads a whole table or index. Full-text search shows as a scan of its virtual
/// table, but FTS5 answers the MATCH from its own index, so that one passes. So does a walk of
/// an index in the order the query asks for (`SCAN … USING [COVERING] INDEX` with no temp
/// B-tree): it stops at the page's end.
fn full_scan(line: &str, plan: &[String]) -> bool {
    let in_order = line.contains(" USING ")
        && line.contains("INDEX ")
        && !plan.iter().any(|l| l.contains("TEMP B-TREE"));
    line.starts_with("SCAN") && !line.contains("VIRTUAL TABLE") && !in_order
}

/// Read in the sort's order and stopped at the page's end: no full scan and no sort of its own.
fn in_order(plan: &[String]) -> bool {
    !plan
        .iter()
        .any(|l| full_scan(l, plan) || l.contains("TEMP B-TREE"))
}

fn open() -> View {
    View {
        open: true,
        ..View::default()
    }
}

fn sorted(view: View, key: SortKey, asc: bool) -> View {
    View {
        sort: Sort { key, asc },
        ..view
    }
}

fn word(text: &str) -> Word {
    Word {
        text: text.into(),
        phrase: false,
        exclude: false,
    }
}

const KEYS: [SortKey; 5] = [
    SortKey::Updated,
    SortKey::Created,
    SortKey::Closed,
    SortKey::Commented,
    SortKey::Comments,
];

/// The presets, the list with no filter, `is:any` (no kind), and every sort both ways under
/// `is:open`, `is:closed` and no state at all.
fn ordered_views() -> Vec<(String, View)> {
    let mut out = vec![
        ("is:open".to_owned(), open()),
        (String::new(), View::default()),
        (
            "is:pr is:open".into(),
            View {
                prs: true,
                ..open()
            },
        ),
        (
            "is:any".into(),
            View {
                any_kind: true,
                ..View::default()
            },
        ),
        (
            "is:any is:open".into(),
            View {
                any_kind: true,
                ..open()
            },
        ),
    ];
    for key in KEYS {
        for asc in [false, true] {
            for (state, open, closed) in [
                ("is:open", true, false),
                ("is:closed", false, true),
                ("(every state)", false, false),
            ] {
                out.push((
                    format!("{state} {key:?} asc={asc}"),
                    sorted(
                        View {
                            open,
                            closed,
                            ..View::default()
                        },
                        key,
                        asc,
                    ),
                ));
            }
        }
    }
    out
}

#[test]
fn every_sort_reads_its_first_page_in_order() {
    let (_g, c) = fixture();
    let mut bad = Vec::new();
    for (what, view) in ordered_views() {
        let p = plan(&c, &view, Span::Top);
        if !in_order(&p) {
            bad.push(format!("{what}: {p:#?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// The page after a cursor starts where the cursor is: the index search has a range on the sort
/// key (`<` or `>`), rather than walking every row before it and skipping them.
#[test]
fn every_sort_seeks_to_the_page_after_a_cursor() {
    let (_g, c) = fixture();
    let mut bad = Vec::new();
    for (what, view) in ordered_views() {
        let after = page_two(&c, &view);
        let p = plan(&c, &view, Span::After(after));
        if !in_order(&p) || !ranged(&p) {
            bad.push(format!("{what}, after {after}: {p:#?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// The index search has a range on the sort key (`<` or `>`).
fn ranged(plan: &[String]) -> bool {
    plan.iter()
        .any(|l| l.starts_with("SEARCH i ") && (l.contains('<') || l.contains('>')))
}

/// A live refetch (`through=`) reads from the top in the sort's order and stops at its cursor:
/// the index search has a range on the sort key, rather than walking on past the cursor to the
/// end of the view and dropping every row it finds there.
#[test]
fn every_sort_stops_a_refetch_at_its_cursor() {
    let (_g, c) = fixture();
    let mut bad = Vec::new();
    for (what, view) in ordered_views() {
        let through = page_two(&c, &view);
        let p = plan(&c, &view, Span::Through(through));
        if !in_order(&p) || !ranged(&p) {
            bad.push(format!("{what}, through {through}: {p:#?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// Driven by an index (the sort's, or the qualifier's lookup and then a sort of what it found),
/// never by a full scan: each qualifier, the other presets among them, the `no:`s and free text.
#[test]
fn every_qualifier_reads_through_an_index() {
    let (_g, c) = fixture();
    let filtered = [
        (
            "is:open assignee:me",
            View {
                assignees: vec![Who::Me],
                ..open()
            },
        ),
        (
            "is:open author:me",
            View {
                authors: vec![Who::Me],
                ..open()
            },
        ),
        (
            "label:bug label:p1",
            View {
                labels: vec!["bug".into(), "p1".into()],
                ..open()
            },
        ),
        (
            "assignee:ilze-k",
            View {
                assignees: vec![Who::Login("ilze-k".into())],
                ..open()
            },
        ),
        (
            "author:anna-b author:roberts",
            View {
                authors: vec![Who::Login("anna-b".into()), Who::Login("roberts".into())],
                ..open()
            },
        ),
        (
            "repo:web repo:acme/api",
            View {
                repos: vec![(None, "web".into()), (Some("acme".into()), "api".into())],
                ..open()
            },
        ),
        (
            "milestone:v0.3",
            View {
                milestones: vec!["v0.3".into()],
                ..open()
            },
        ),
        (
            "type:bug type:task",
            View {
                types: vec!["bug".into(), "task".into()],
                ..open()
            },
        ),
        (
            "label:bug sort:created-asc",
            sorted(
                View {
                    labels: vec!["bug".into()],
                    ..open()
                },
                SortKey::Created,
                true,
            ),
        ),
        (
            "no:label",
            View {
                no_label: true,
                ..open()
            },
        ),
        (
            "no:assignee",
            View {
                no_assignee: true,
                ..open()
            },
        ),
        (
            "no:milestone",
            View {
                no_milestone: true,
                ..open()
            },
        ),
        (
            "crash",
            View {
                words: vec![word("crash")],
                ..open()
            },
        ),
        (
            "crash (every state)",
            View {
                words: vec![word("crash")],
                ..View::default()
            },
        ),
        (
            "dark theme -safari",
            View {
                words: vec![
                    word("dark"),
                    word("theme"),
                    Word {
                        exclude: true,
                        ..word("safari")
                    },
                ],
                ..open()
            },
        ),
    ];
    let mut bad = Vec::new();
    for (what, view) in &filtered {
        let p = plan(&c, view, Span::Top);
        if p.iter().any(|l| full_scan(l, &p)) {
            bad.push(format!("{what}: {p:#?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// A filter value that matches few rows (no fixture issue has the type Epic) is looked up
/// through its own index, not found by walking the whole state in the sort's order. The planner
/// knows only from the mirror's statistics (`PRAGMA optimize`) that it's the cheaper way.
#[test]
fn a_rare_filter_value_is_looked_up_through_its_index() {
    let (_g, c) = fixture();
    let view = View {
        types: vec!["Epic".into()],
        ..open()
    };
    let p = plan(&c, &view, Span::Top);
    assert!(
        p.iter()
            .any(|l| l.starts_with("SEARCH i USING INDEX items_issue_type")),
        "{p:#?}"
    );
}

/// Accepted cost: with no kind (`is:any`, or `is:issue is:pr`) only the updated sort has an
/// index (`items_updated_any_kind`). Any other sort reads every row of the view and sorts them
/// (about 20 ms at 50k), rather than adding 8 more indexes every item write would pay for (see
/// `list.sql`). Kept out of `every_sort_reads_its_first_page_in_order`; if one of these stops
/// needing the sort, move it there.
#[test]
fn no_kind_under_another_sort_sorts_every_row_as_accepted() {
    let (_g, c) = fixture();
    let mut bad = Vec::new();
    for key in KEYS.into_iter().filter(|&k| k != SortKey::Updated) {
        for asc in [false, true] {
            for (what, view) in [
                (
                    "is:any",
                    View {
                        any_kind: true,
                        ..View::default()
                    },
                ),
                (
                    "is:issue is:pr is:open",
                    View {
                        issues: true,
                        prs: true,
                        ..open()
                    },
                ),
            ] {
                let p = plan(&c, &sorted(view, key, asc), Span::Top);
                if !p.iter().any(|l| l.contains("TEMP B-TREE")) {
                    bad.push(format!("{what} {key:?} asc={asc}: {p:#?}"));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// `/api/facets`: each facet's values come from a small table or the facet's own index on
/// items, never from a walk of every item.
#[test]
fn facet_values_read_their_own_indexes() {
    let (_g, c) = fixture();
    type Run = fn(&Connection);
    let facets: [(&str, &str, Run, Option<&str>); 6] = [
        ("labels", "FROM labels", |c| drop(q::facet_labels(c)), None),
        (
            "assignees",
            "FROM users",
            |c| drop(q::facet_assignees(c)),
            None,
        ),
        (
            "authors",
            "FROM users",
            |c| drop(q::facet_authors(c)),
            Some("items_author"),
        ),
        ("repos", "FROM repos", |c| drop(q::synced_repos(c)), None),
        (
            "milestones",
            "FROM milestones",
            |c| drop(q::facet_milestones(c)),
            None,
        ),
        (
            "types",
            "FROM items",
            |c| drop(q::facet_types(c)),
            Some("items_issue_type"),
        ),
    ];
    let mut bad = Vec::new();
    for (what, marker, run, index) in facets {
        let p = plan_of(&c, marker, run);
        let items: Vec<&String> = p
            .iter()
            .filter(|l| l.starts_with("SCAN i ") || l.starts_with("SEARCH i "))
            .collect();
        let own = match index {
            Some(ix) => !items.is_empty() && items.iter().all(|l| l.contains(ix)),
            None => items.is_empty(),
        };
        if !own {
            bad.push(format!("{what}: {p:#?}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// The facet counts read only the view's rows, found through an index: never every item.
#[test]
fn facet_counts_read_only_the_views_rows() {
    let (_g, c) = fixture();
    type Run = fn(&Connection, &dbrt::filter::Filter);
    let counts: [(&str, Run); 6] = [
        ("labels", |c, f| drop(q::count_labels(c, f))),
        ("assignees", |c, f| drop(q::count_assignees(c, f))),
        ("authors", |c, f| drop(q::count_authors(c, f))),
        ("repos", |c, f| drop(q::count_repos(c, f))),
        ("milestones", |c, f| drop(q::count_milestones(c, f))),
        ("types", |c, f| drop(q::count_types(c, f))),
    ];
    let mut bad = Vec::new();
    for view in [
        open(),
        View {
            labels: vec!["bug".into()],
            ..open()
        },
    ] {
        let f = list::filter(&view, ME);
        for (what, run) in counts {
            let p = plan_of(&c, "FROM items i", |c| run(c, &f));
            if p.iter().any(|l| l.starts_with("SCAN i ")) {
                bad.push(format!("{what} under {view:?}: {p:#?}"));
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
