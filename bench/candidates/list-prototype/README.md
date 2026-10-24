# PROTOTYPE: Markdown styling for bodies and comments

Throwaway, for [Prototype Markdown styling for bodies and comments](https://github.com/tomsjansons/beghu/issues/68),
on top of the issue detail below (side panel, #66's cue A fixed). `?variant=A|B|C`, the floating
bar or ← / → switch how Markdown in bodies and comments is styled:

- **A: Editor bands.** render-markdown.nvim close to literal: one text size, each heading a tinted
  full-width band with a circled level number in its colour, indented by level; alerts as a
  coloured bar with icon and title; ● ○ ◆ ◇ bullets in orange; code with a header (language dot
  and name); a leading icon on every link (globe, GitHub); tables boxed with a coloured header
  rule and alignment ticks.
- **B: Document.** GitHub's sized heading hierarchy with level colours, h1/h2 underlined; alerts as
  tinted callout boxes; plain coloured bullets; code with a header bar; no link icons, ↗ after
  off-GitHub links; tables with rules and zebra rows; mentions as pills.
- **C: Outline rails.** Each heading opens a section with a coloured rail down its length, nested,
  and an `H1`…`H6` badge in a gutter, so a long agent comment reads as an outline; alert icons sit
  in the gutter; code labels in the corner; GitHub-only link icons; rounded grid tables.

Shared: the server's compact AST (comrak → ammonia, from the markdown probe) walked straight to DOM
(`web/src/md/render.ts`); `#n`, `owner/repo#n` and bare GitHub issue URLs become references (in your
mirror: state icon, hover title, opens in-app; otherwise ↗ to GitHub); `@user` and `@org/team`
link to GitHub; read-only task checkboxes; footnotes; `<details>`; images click into a lightbox;
highlight.js colours code after first paint. Colours are `light-dark()` tokens in `md/md.css`.

The bar adds `md` (which real thread replaces the fixture's lorem: `auto` by issue id, `kitchen`
for every element, six GitHub issues, five agent threads, or `off`), `icons` (`svg` sprite or
`unicode glyphs`) and the walker time for the last frame (before layout).
`node md-corpus/build.mjs` rebuilds `web/public/md-corpus.json`.

    ./bench/serve list-prototype --scale 50k --port 8095
    (cd bench/candidates/list-prototype/web && API_URL=http://127.0.0.1:8095 npx vite --port 5180)
    # http://localhost:5180/issues/3000040375?md=kitchen&variant=A

---

# PROTOTYPE: live changes in the issue detail

Throwaway, for [Prototype live changes in the issue detail](https://github.com/tomsjansons/beghu/issues/66),
on top of the relationship prototype below. `?variant=`, the floating bar or ← / → switch the
**shift cue**. The list's columns are fixed to round 3's A.

    ./bench/serve list-prototype --scale 50k            # http://127.0.0.1:8080

Open an issue, then use the **Live changes** panel (bottom left) to have a teammate change it:
a short or an agent comment, a paragraph added, removed or rewritten, a typo, a label, an
assignee, a blocker. Each change goes into the mirror and out as an ordinary SSE push, so the
detail refetches it as it would a webhook. `after` delays the change so you can scroll or rest
first, and `auto` makes one every 8–20 s. The panel shows the mode (intent with a countdown, or
reading), the phase (idle → held → cue → anim) and what's held.

- **A: mark the spot.** A still marker at the exact place, an accent line with "added" or
  "roberts commented" where something will open and a red outline on what will go, then a quick
  open/close.
- **B: show what moves.** A tinted band from the change to the edge that will move (down to the
  viewport's bottom, or up to its top), labelled "↓ +3 lines", then the same quick animation.
  Off-screen changes (with `off-screen: hold`) show as an arrow at the edge.
- **C: ghost that grows.** The cue is the motion: an empty dashed box opens slowly to the
  incoming height over the whole cue, then the content fades in. What goes dims, dashes and
  closes over the cue.

**Round 2.** The owner picked A, with three changes:
- Long blocks open and close slower: the base time up to ~3 lines, then about +1 ms per px,
  capped at 1.2 s (an agent comment takes ~0.75 s, a one-line comment ~0.3 s).
- A label, assignee or milestone change marks only its own line, not the whole header.
- Blocks, Relates to, Sub-issues and the parent crumb are units of their own, each marked,
  animated and glowing on its own.

**Round 3.** A first blocker (or first relates-to link) used to just appear: the empty section
had no box to mark. Empty sections now keep a zero-height spot that shows the insertion line
("blocker added", "link added") during the cue, and carry their gap inside, so opening animates
the gap with the section.

Shared: what doesn't move layout (title, state, counts, your own comment) updates at once. What
does is held in intent mode and applied in reading mode, cue first, then animation, then a short
afterglow on what arrived. A change landing mid-cue joins it and restarts it; one landing
mid-animation waits for the next round. The knobs:

| knob | options | what it changes |
|---|---|---|
| rest | 5 / 3 / 2 s | stillness before reading mode (5 is decided; shorter only to test faster) |
| cue | 400 / 700 / 1200 ms | how long the cue shows (in C, how slowly the ghost opens) |
| anim | 150 / 250 / 400 ms | the open/close animation |
| on intent | cancel / finish | intent during a cue: cancel it and hold again, or finish |
| props | held / in place | whether property rows and Blocks follow the cue |
| off-screen | now / hold | a change wholly above or below the viewport applies at once, keeping the reading position, or waits like the rest |
| visible | push / nearer edge | a visible change pushes what's below, or (like the list) grows upward when it's in the viewport's top half |
| order | newest / oldest | comment order: arrivals at the thread's top, or at its loaded end |
| motion | os / reduce | force `prefers-reduced-motion`: the cue stays (as a still mark, 900 ms) and the change swaps in without animation |

Try `/issues/3000040375` (short thread, sub-issues, a blocker) and `/issues/3000041809` (long
thread: scroll into it to see off-screen arrivals keep your place).

---

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
