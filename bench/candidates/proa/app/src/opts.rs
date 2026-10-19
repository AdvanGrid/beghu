//! The optimisation pass's changes, cumulative and switched by `BENCH_VARIANT`, so one image
//! measures each step: none = the idiomatic pass, `o1` preloads every island's modules, `o2` adds
//! `turbo-cache-control: no-cache`, `o3` adds 25-row pages and `content-visibility` on rows. `o4`
//! is `o1` plus filter and search visits as `advance`, so Turbo swaps the body instead of morphing;
//! `o5` adds `autofocus` on the search input, since a swap moves (and blurs) the permanent box.
//! `o6` is `o1` plus a `<turbo-frame>` around the filters and the list, with the search box outside it.
use std::sync::LazyLock;

pub struct Opts {
    pub preload: bool,
    pub no_snapshot_cache: bool,
    pub page: i64,
    pub lean_rows: bool,
    /// The Turbo action for filter links and the search form.
    pub filter_action: &'static str,
    pub refocus_search: bool,
    /// Filter and search visits replace only the `view` frame.
    pub frame: bool,
    /// The search form's `data-turbo-frame`.
    pub search_target: &'static str,
}

pub static OPTS: LazyLock<Opts> = LazyLock::new(|| {
    let level = match std::env::var("BENCH_VARIANT").unwrap_or_default().as_str() {
        "o1" => 1,
        "o2" => 2,
        "o3" => 3,
        "o4" => 4,
        "o5" => 5,
        "o6" => 6,
        _ => 0,
    };
    if level == 6 {
        return Opts { preload: true, no_snapshot_cache: false, page: 50, lean_rows: false, filter_action: "advance", refocus_search: false, frame: true, search_target: "view" };
    }
    if level >= 4 {
        return Opts { preload: true, no_snapshot_cache: false, page: 50, lean_rows: false, filter_action: "advance", refocus_search: level >= 5, frame: false, search_target: "_top" };
    }
    Opts { preload: level >= 1, no_snapshot_cache: level >= 2, page: if level >= 3 { 25 } else { 50 }, lean_rows: level >= 3, filter_action: "replace", refocus_search: false, frame: false, search_target: "_top" }
});
