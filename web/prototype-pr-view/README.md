# PR view (prototype)

Throwaway prototype for the question: can an engineer get a sense of a PR from an agent-built
graph, with drill-down to claims and code lines? None of it is production code.

| File | What it is |
|---|---|
| `prepare.sh` | Checks a PR's base and head out as worktrees and writes `pr.json` |
| `ANALYSIS.md` | The analysing agent's instructions |
| `schema.ts` | The analysis JSON shape (its comments are instructions too) |
| `validate.ts` | Checks an analysis: references, snippets against the files, every changed file placed, judging words |
| `index.html`, `main.tsx`, `model.ts`, `layout.ts`, `tokens.stylex.ts` | The page |
| `data/` | Analyses, one `<owner>-<repo>-<n>.json` each. Gitignored: they quote private code |

## Analyse a PR

1. `web/prototype-pr-view/prepare.sh <local clone> <owner/repo> <n>` prints the prep directory.
2. Give an agent this brief: "Follow `web/prototype-pr-view/ANALYSIS.md` and `schema.ts`. Prep dir:
   `<dir>`. Write `web/prototype-pr-view/data/<owner>-<repo>-<n>.json` and validate it until it
   passes."
3. `node web/prototype-pr-view/validate.ts web/prototype-pr-view/data/<name>.json <dir>`

## Look at it

Run Vite: `./dev-ctl start` runs it at `DEV_APP_PORT` (5173), or `cd web && npx vite --port 5291`
runs it alone, since the page needs no server. Then open
`http://localhost:<port>/prototype-pr-view/index.html?a=<owner>-<repo>-<n>`. Without `?a=` the
page lists the analyses in `data/`.

- **Lenses** (top): modules and services, data flow, external connections and boundaries, order
  of actions (one scenario at a time).
- **Zoom:** double-click a node to go inside it; the breadcrumb or Backspace goes out. Edges roll
  up to what's visible. Dashed boxes are outside the current zoom.
- **Colour by:** how the PR changed each node, or any facet the agent found. Each node also shows
  every facet as a text prefix, with the coloured facet's in brackets.
- **Panel:** with nothing selected, the overview, ordered by a stated rule (boundary crossings,
  then new and removed parts, then changed responsibilities, then edits inside parts). Select a
  node, edge or step to get its questions. Open a question for its answer and claims, and a claim
  for its lines, linked to GitHub. Escape goes back to the overview.

Typecheck: `cd web/prototype-pr-view && ../node_modules/.bin/tsc -p tsconfig.json`.

## On a phone (#158)

`mobile.tsx` holds three phone variants of the explorers, switched with `?phone=1|2|3` and the bar
at the bottom (a window under 720 px gets 1 by default, `?phone=0` keeps the desktop page);
`?x=clusters` picks Clusters over Path. To try them on a real phone, run Vite with `--host` and open
the page at the machine's address.

## The panel's walkthrough of purposes (#159)

`walkthrough.tsx` holds three layouts of the panel, switched with `?wt=A|B|C` or ← → (the bar at the
bottom; `?wt=0` is the old stated-rule panel, `[` `]` now switch the legend). They read
`purpose.ts`-shaped data from `data/purposes/<name>.json` (gitignored: it quotes the PR and its
issues), hand-written for #2627, beside the code view's analysis.

- **A, Reader (chosen):** three sentences (intro, journey, destination), then the next level as a list.
- **B, Tour:** one step at a time; each step lights and moves the canvas, "Go in" stands on it.
- **C, Crossing:** one sentence, then tables of purposes × parts.

A purpose lights the parts and lines that serve it (the rest fades); hovering a stop, a role or a
conflict lights what it names. Conflicts marked "made up" are invented where #2627 had none of that kind.

A conflict is a question with one row per side: who says it, and what, in a few words (`says`). A
row opens to the whole fact and its source.

## A purpose on the canvas (#160)

`purpose-canvas.tsx` holds four canvases for a purpose, switched with `?pc=A|B|C|D` or ← → (the bar
at the bottom; Alt + ← → now switch the panel's layout, `?pc=0` is the code view with fading only).
They show where the walkthrough panel stands: the whole PR, or a purpose. Picking a part keeps the
canvas; "Code view at ‹part› ›" (or a double-click) goes to the code view, and "← Back to ‹purpose›"
in the bar returns.

- **A, Purpose groups:** a fourth view. Purpose cards, then sub-purpose cards, then a leaf purpose's parts and lines.
- **B, Fold the rest (chosen):** the code view's top level with everything the purpose doesn't touch folded into stubs. Blocks open in place inside frames and glide there; one click selects, a double-click goes in; Back and Start over undo opens and folds.
- **C, Journey line:** the purpose's stops left to right; other purposes cross where they share parts.
- **D, Purpose × area map:** purposes down, top-level parts across, counts in the cells.

All four roll a purpose's parts up to a budget of blocks, folding siblings by kind when there are
too many ("middleware in 21 services"). `node web/prototype-pr-view/make-synthetic.ts` writes a
made-up many-purpose PR (`?a=acme-shop-77`): 256 parts, a tenant-isolation purpose over about 110 of
them, five purposes that share parts, and a conflict reaching unchanged code outside the diff.

## Our layout for nested blocks (#166)

`nested-layout.ts` lays out open blocks with our own engine (`own-layout.ts`, street routing): each
open block's inside is laid out by the same engine, its lines leaving through stubs on the frame's
edge, and the scope above lays the frame out as one big part with those ports. Open
`nested.html?a=<name>`: click a block to open or fold it (the bar says what moved), "Open all"
for Clusters fully open, the counts either on the line (room made in each gutter) or in the trunk's
card, and "Phone" for a 390 px pane driven by taps (tap picks, its lines are rows; double tap opens).
`?x=3` lays out three copies of the analysis. `node web/prototype-pr-view/nested-bench.ts [name] [times]`
times the layout outside the browser and counts what moves when a block opens or folds.

## One canvas or three (#173)

`canvas.html?a=<name>` asks whether the drawn graph and Clusters are one canvas or two. Both
shapes use our layout (`nested-layout.ts`), one shared panel (a stand-in for the walkthrough:
the PR, a purpose, a part, a line) and Path. Switch with ← → or the bar at the bottom (`?v=one|three`).

- **one, One canvas:** Canvas | Path. The canvas is the locked top level, and every part opens in
  place (double-click). Standing on the PR or a purpose folds the rest on this same canvas, with
  Back and Start over. "Code view at ‹part› ›" leaves the fold with that part opened in place.
- **three, Three canvases:** Drawn graph | Clusters | Path. The drawn graph is the locked top
  level. A double-click zooms into a part: a scene of its inside, with the parts it connects to
  around it, and a Zoom trail. Standing on the PR or a purpose folds the rest on it.
  Clusters starts as four group blocks that open in place, and ignores purposes.

Click picks, double-click opens, and clicking an open frame's title folds it. Each canvas keeps
its own opens when you switch tabs; the selection is shared. Left out: lenses, Colour by, Boxes,
hover cards, the legend, the purpose plan's sibling folds, and the phone.
