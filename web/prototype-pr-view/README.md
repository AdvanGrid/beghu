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
- **Order of actions (#146):** `?sq=A`–`F` or the `,` `.` keys switch the scenario views. D (time
  runs down) and F (time runs across, parts down the left) are the chosen pair, with a switch
  between them; both fold chapters and roll lifelines up to a zoom level. Chapters come from the
  analysis (`chapters` in `schema.ts`); older analyses can take hand-written ones from
  `data/chapters/<name>.json` (gitignored).
- **Panel:** with nothing selected, the overview, ordered by a stated rule (boundary crossings,
  then new and removed parts, then changed responsibilities, then edits inside parts). Select a
  node, edge or step to get its questions. Open a question for its answer and claims, and a claim
  for its lines, linked to GitHub. Escape goes back to the overview.

Typecheck: `cd web/prototype-pr-view && ../node_modules/.bin/tsc -p tsconfig.json`.
