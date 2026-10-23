# PROTOTYPE: relationships (sub-issues, dependencies, relates-to)

Throwaway, for [Prototype the relationship tree](https://github.com/tomsjansons/beghu/issues/55), on
top of the list (#52, variant C) and detail (#54, side panel) prototypes. `?variant=` and the
floating bar (← / →) switch the list's **column arrangement** (round 3). The detail is always the
side panel.

    ./bench/serve list-prototype --scale 50k            # http://127.0.0.1:8080

**Round 5.** A header row over the list (A only): drag a column's left edge to resize it; the title
takes what's left. Widths are remembered per browser and double-click resets one. Untouched columns
keep their automatic width from the list's width, and labels and blockers fit as many stacked
columns as their width holds.

**Round 4.** Labels and blockers fill stacked columns of two, and the number of columns follows
the list's width (labels: 1 column under 900px, 2 from 900, 3 from 1500; blockers: 1, 2 from 1200,
3 from 1800). When there are more than the slots, the last slot says "+n" and hovering lists them
all. Rows carry up to 8 open blockers. A cross-repo chip truncates the repo, never the number.

**Round 3c.** The divider between the list and the detail drags to resize (360px minimum each side),
is remembered per browser, and resets on double-click. Hidden on narrow screens, where the detail
sits under the list.

**Round 3b.** The owner picked A. Blockers are rarely more than one but labels are often several,
so both now **stack** in two 15px lines inside the 34px row: blocker chips one above the other
(the second carries "+n"), and labels filling column by column. A single blocker or label stays one
normal-size line. That lets the blocker column shrink to one chip (112px) and labels take 220px.

**Round 3.** The owner picked chips (round 2's C) and asked for strict columns, since the blocker
chips, number, assignees and labels shifted from row to row. Every row is now one CSS grid with
fixed cells, so each sits at the same x on every row, in the list and the tree. Below 1000px of
list width (panel open) labels and blockers narrow and the gaps tighten. At most two blocker chips
show, then "+n"; the hover card lists all of them.

- **A: title first.** Title | labels | blockers | progress | number | assignees | updated.
- **B: number first.** Number | title | labels | blockers | progress | assignees | updated.
- **C: number and owner first.** Number | assignees | title | progress | blockers | labels | updated.

**Round 2.** Owner feedback on round 1 kept: drag to reorder and re-parent (sub-issues in the
panel, and the tree, both in every variant), separate **+ Blocked by / + Blocking / + Relates to**
buttons, and the "waits on" note on blocked rows. The detail now has a **Blocks** section above the
body: Blocked by on the left, Blocking mirrored on the right (icon on the outer edge, two lines per
item: title, then number and owner, plus "itself blocked by n" / "also waits on n more").
**Relates to** sits under it. The variants now try what the list's note says. Every one opens the
same hover card with each open blocker's title, owner and status, and the row's red edge stays:

- **A: what.** "waits on <first blocker's title> +n".
- **B: who and how.** "waits on (avatar) owner", or "#123, nobody on it", "…, itself blocked",
  "…, quiet 8mo" (no update for 180 days, since the fixture is old; 14 on live data).
- **C: every blocker.** A chip per open blocker: avatar and number (repo only when it differs).
  Amber dashed means nobody is on it, and red means it is itself blocked.

Round 1 (panel / outliner / dependency lens) is commit 75386b8 on this branch.

Shared by all three: every edit is a pending write (blinks until GitHub answers) and reverts with
a toast if refused (use the bar's `writes` knob). Reorders are one `sub_move` op on the parent
(GitHub's reprioritize: `after_id`, or first). A move to another parent is GitHub's add with
`replace_parent`, plus a reorder when it doesn't land last. The server refuses a loop, more than
8 levels, or a 101st child with 422. Pasting `https://github.com/acme/partner-sdk/issues/N` (or
`partner-sdk#N`) links a **stub**; the real server would read its title from GitHub once.
Cross-repo sub-issues already show in the tree (812 in the fixture). Moves that arrive by live
push would follow #53's held changes; the prototype doesn't redo them.

---

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
