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
