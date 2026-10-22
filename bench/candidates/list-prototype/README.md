# PROTOTYPE: issue list and filter bar

Throwaway, for [Prototype the issue list and filter bar](https://github.com/tomsjansons/beghu/issues/52).
Three variants of the list and filter bar on one route, on the 50k fixture, switched with
`?variant=A|B|C`, the floating bar, or ← / →.

- **A: query bar + menus, two-line rows.** GitHub-style. One box with typed syntax
  (`is:open label:bug assignee:me repo:web no:assignee sort:created`), Open/Closed tabs with
  counts, and a dropdown per facet with counts. Picking from a menu rewrites the box.
- **B: facet rail, table rows.** Every facet always on screen as checkboxes with counts; a plain
  title search; active filters as removable chips; dense rows in columns.
- **C: token bar + presets, one-line rows.** Filters are tokens inside one input; typing suggests
  keys and values with counts; plain words search titles; preset views under the bar.

Shared by all three: the view lives in the query string, only the rows on screen render, a
user-started list load over 200 ms pulses the list outline and keeps the old rows (try the `lag`
knob on the bar), search boxes refill on back/forward but aren't bound to the URL while typing,
and live updates refetch the loaded rows. Light/dark/system on the bar.

Server: the axum-solid2-router server with richer rows (author, milestone, parent, sub-issue
progress, open blockers) and `GET /api/facets?<view>` counts per facet for the current view.

Run it from the repo root:

    ./bench/serve list-prototype --scale 50k            # http://127.0.0.1:8080
    ./bench/serve list-prototype --scale 50k --rtt 100 --replay   # shaped link + live changes

**Tree mode** (`&tree=1`, or the List | Tree toggle in every variant): the list as a collapsible
sub-issue tree. Roots are issues with no parent, in the view's sort; children keep GitHub's
sub-issue order. Click a chevron for one level, Shift/Alt-click for the whole subtree. The
progress on a parent counts every descendant (closed / total), whatever the view. A filter shows
matches inside their ancestors (dimmed) and keeps each match's subtree openable; it arrives
opened along every path to a match. `GET /api/tree?<view>&parent=&deep_mode=path|all` serves it,
120–320 ms at 50k because the match/ancestor sets are rebuilt per request.

## Verdict

- **Filter bar and rows: C.** Token bar with typed keys, suggestions and presets; one-line 34 px
  rows.
- **Suggestion counts: keep, computed lazily** (only once a value list stays open, or from a
  cached snapshot), since they cost 80–550 ms of server time per keystroke at 50k.
- **Tree:** roots are any issue with no parent; under `is:open` closed children are hidden but
  still counted in progress; expanded nodes are remembered per saved view.
