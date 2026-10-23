# PROTOTYPE: issue detail (on top of the issue list)

Throwaway, for [Prototype the issue detail](https://github.com/tomsjansons/beghu/issues/54). The
list is variant C from the list prototype below, now fixed; `?variant=A|B|C`, the floating bar or
← / → switch the **detail's** layout instead.

- **A: side panel.** List on the left, one column on the right: properties as chips under the
  title, blockers above the body, sub-issues under it, a sticky comment box at the bottom. The
  new-issue form opens in the panel.
- **B: full page.** The detail covers the list (which keeps its scroll underneath). GitHub's
  shape: a column of cards (body, sub-issues, comments, comment box) and a sidebar (assignees,
  labels, milestone, blocked by, blocking, relates to, close). The new-issue form is a page too.
- **C: drawer.** The list stays full width and the detail slides over its right side; ⤢ widens
  it to the page (`&full=1`). Linear's shape: main column plus a properties rail. The new-issue
  form is a modal with "Create more".

Shared by all three: one `/api/issues/:id` response carries the comments (preloaded on row hover),
so they show with no placeholder. Threads over the byte budget keep the first comment and the
newest, with "N more comments" in between (the footer shows the response size). Title (click),
body (Edit), comments, labels, assignees, milestone, close/reopen and every relationship kind are
**pending writes**: shown at once with a blinking dot, kept until a refetch that started after
GitHub confirmed them. Use the bar's `writes` knob to have GitHub refuse: a refused change reverts
with a toast and Retry, a refused comment stays as "not sent" with Retry/Discard, and `body 409`
keeps your text next to theirs. Stubs (repo `partner-sdk`) show as "not synced" and link out to
GitHub. `c` starts a new issue; `+ Create a new sub-issue` starts one under the open issue; a
create shows "Creating…" and then navigates to the real id. `j`/`k` step through the list in B
and C; Esc closes them.

Try `/issues/3000040375` (parent, 8 sub-issues, a blocker), `/issues/3000041809` (69 comments,
folded) and `/issues/3000029000` (blocked by a stub).

    ./bench/serve list-prototype --scale 50k            # http://127.0.0.1:8080

---

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
