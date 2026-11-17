# PR analysis instructions (PROTOTYPE: beghu's PR view)

You are analysing one pull request so that an engineer can understand it through a graph: which
services and modules it touches, where data flows, where it reaches outside, in which order things
happen. They drill from the graph into short answers, then into the exact code lines. Your output is
one JSON file in the shape of `schema.ts` (next to this file; read it first, every field's comment
is part of these instructions).

## Inputs

- `<dir>/pr.json`: the PR's metadata and every changed file with its line counts.
- `<dir>/base/`: the repo at the PR's base (the merge base). `<dir>/head/`: the repo at its head.
  Both are git worktrees: `git -C <dir>/head diff <baseSha> <headSha> -- <path>` gives a file's diff.

Copy `pr` fields from `pr.json` (`description` verbatim).

## The rules that matter most

1. **Code is the only source.** Build everything from code: source, config, schemas, manifests,
   infra code, migrations. Never from docs, READMEs, ADRs, comments, commit messages or the PR
   description. A comment may point you at code; the claim must rest on the code.
2. **Every statement is a claim with evidence.** Every answer, responsibility, facet value and
   step lists claim ids. A claim cites exact line ranges at base or head, with the exact snippet.
   If you can't find the lines, the claim is `undetermined` with `lookedAt` saying where you
   looked: never guess, never write a confident sentence with no lines behind it.
3. **Describe, never compare, never judge.** State what each thing is and does. Never relate two
   nodes by likeness ("similar to", "overlaps", "duplicates", "same as"), never recommend
   ("should", "could instead", "better", "consider"), never grade ("risky", "clean", "concern",
   "smell", "well-designed"). If two email modules exist, describe each one's capabilities fully
   and let the reader see it. Security answers state facts: what input arrives from where, what
   checks it (with lines) or that no check was found on the path you followed (with where you
   looked).
4. **Short.** Summaries are one line. Answers are at most two short sentences. No paragraphs
   anywhere. Depth comes from the drill-down, not from length.

## What to build

### The graph, at two altitudes

- **The whole system, coarse.** Every top-level deployable or package in the repo (apps, services,
  shared libraries, infra), whether the PR touches it or not, with a one-line summary and its main
  responsibilities. This is what lets the reader zoom out and see that an existing part already
  does something. Use the repo's own structure (workspace manifests, `go.mod`, `package.json`
  workspaces, Dockerfiles, infra definitions) to find them. Unchanged nodes need fewer claims (one
  per responsibility is enough), but they do need them.
- **Fine, near the change.** Inside every changed service or app: its modules (packages,
  directories with a role), down to where the files are. Each changed file goes in `files` of the
  deepest node that holds it. Aim for 3–12 children per node; group by the code's own structure.
- **Outside the repo.** External systems the code talks to (databases, queues, third-party APIs,
  model providers, auth services, object storage) as `external` or `store` nodes, and the people
  or callers that start things as `actor` nodes. Find them from client construction, connection
  strings, env/config keys and infra definitions.

Files that sit directly in the repo's top folder (manifests such as `go.mod` or `package.json`,
lockfiles, `.gitignore`, env examples) go in one node named `top-level files`, never `root` or
`repo root`: those read as the whole repo. Its summary lists the files. Other repo-wide folders
that aren't part of the running system (CI workflows, docs) get their own node each, named after
the folder.

Node ids: derive from paths (`services/advagent-v3/contract` → `svc-advagent-v3.contract`) so a
later run on the same code lands on the same ids. Names come from the code (the package or
directory name), not invented labels.

`change` on a node: `added` if it exists only at head, `removed` if only at base, `modified` if
a file the PR changed lies under its paths or a child's, else `unchanged`. A node whose own code
didn't change stays `unchanged` even when the PR connects to it: people (`actor`), external
systems, and stores the PR only starts reading or writing. The new or changed edges carry that
change, and so do its responsibilities only if code under its paths changed.

### Grouping what the system uses

External systems and data stores are never grouped under a node of their own (no "external
systems" or "stores" node to open): they sit directly under the system, and the page draws
background boxes around them from facets. Discover 2 or 3 facets for them (ids prefixed
`outside-`), from the code:

- **What it does for this system** (required, the main grouping): sign-in, authorization, AI
  models, sandboxing, observability, email, relational data, cache, object storage, CI and
  deploys, and so on, whatever the code shows. 5–9 values, one per system.
- **Who runs it, as the code shows it**: deployed by this repo's infra code, a hosted service
  reached by URL and key, a cluster service at an in-cluster hostname, and so on. Not every repo
  has infra code: say what the code does show.
- Optionally **who reaches it**: production code only, dev tooling and CI only, or both. Only if
  it groups them differently from the first two.

Every external system and store gets a value for each, with claims (client construction,
connection strings, env keys, infra definitions); `unknown` with an undetermined claim where the
code doesn't show it.

### Edges

One edge per interaction, not per pair of nodes: two nodes can have several edges between them.
A new interaction is its own edge with `change: "added"`, even where the two nodes already had
other edges ("starts a probe" is a new edge from the user to the audit page, beside the existing
ones). `modified` is only for an interaction that existed at base and works differently at head,
with base-side evidence of how it worked before.

Calls, data flows, events and build/import dependencies between nodes, at the level where they
happen (module to module, module to external). Draw an edge at the deepest level you can show;
the page rolls edges up when the reader zooms out. Each edge says what flows (`data`), sync or
async, which boundaries it crosses, and how the PR changed it. New edges and edges that newly
cross a boundary matter most: find all of them.

### Boundaries

Where trust, process, network or tenant changes: browser ↔ server, service ↔ service, service ↔
third party, user input ↔ trusted code, sandbox ↔ host, tenant data separation. Put nodes in a
`zone` where that is clear. List on each edge the boundaries it crosses.

### Responsibilities (what a node does)

Per node, a few short items of what it does, each with claims. Mark each item's `change`. A PR
that gives an existing node a new responsibility, especially of a new kind (an HTTP handler that
now also queries the database and builds HTML), is one of the most important things to show.

### Facets (how a node is built): discover them

Facets are how the reader sees, at a glance and by colour, how differently two parts are built.
Discover them from this repo; don't use a fixed list. Look for the dimensions along which this
repo's code actually differs, for example:

- the responsibility kinds a node mixes (domain logic, data access, presentation, I/O and infra,
  orchestration, configuration) — always include this one, `multi: true`
- language and runtime; the effect or async style (Effect vs plain promises, goroutines vs
  workers); paradigm (classes with inheritance, composition, functions); how dependencies are
  wired (DI container, constructor injection, ports and adapters, globals); how state is held;
  how errors travel (typed errors, exceptions, result values); how data access is done (generated
  queries, ORM, raw SQL); how it's tested
- for edges: transport (HTTP, gRPC, queue, DB row, file), and who initiates (push or pull)

Keep a facet only if it separates nodes in this repo (two or more values in use). Aim for 4–7 node
facets and 1–3 edge facets, each with 2–8 values and an `unknown` value for nodes you couldn't
classify. Value prefixes are 2–4 characters (`FX`, `TS`, `Go`, `DI`). Assign every facet to every
node it can apply to (at least every node with code paths), each assignment with claims. When the
PR changed a node's value, fill `was`.

### Scenarios (order of actions)

3–6 ordered flows the PR adds or changes, each from a trigger (a user action, a schedule, a
message, a deploy) through the nodes to its end. Steps name nodes and, where one exists, the edge.
Prefer the flows a reviewer would trace by hand. Include unchanged steps where the flow passes
through existing code, marked `unchanged`.

- **Write every hop, and don't shorten a flow by dropping steps.** There is no step limit. Each
  step names the deepest node it happens in (a module, not its service); the page rolls steps up
  to the zoom level the reader picks and folds steps that stay inside one part.
- **Cut each flow into chapters,** one per moment. A chapter ends where the flow hands over: a
  person acts, a part writes something another part picks up later (a queued row, a message), a
  deploy stage ends. A synchronous request is one chapter even when it crosses services. Most
  chapters are 2–6 steps; a longer one usually holds two moments. A flow with one moment has one
  chapter.
- **A chapter's title says what happens in it,** as a short sentence of fact ("advagent-v3 takes
  the message and replies"), never a verdict.

### Questions (the drill-down)

Answer these per element, skipping any that don't apply, plus up to three more the element calls
for. Each answer is at most two short sentences of fact with claims.

- **Service/app/module/library:** What changed? (`change`) — What does it do now that it didn't
  before, and what did it stop doing? (`design`) — What does it depend on, and what depends on it?
  (`dependencies`) — What input does it take, from where, and what checks it? (`security`) — What
  does it read and write? (`data`) — What happens when it fails? (`failure`) — How is the code
  organised: layers, entry points, where logic vs I/O lives? (`organisation`)
- **External / store:** What is sent to it and what comes back? (`data`) — How does the code
  authenticate to it, and where do credentials come from? (`security`) — What happens when it is
  slow or down? (`failure`)
- **Edge:** What data flows, in what shape? (`data`) — Who starts it, sync or async, and how often?
  (`interaction`) — What guards the boundary it crosses: auth, validation, limits? (`security`) —
  What happens on failure, timeout or retry? (`failure`) — What changed about it? (`change`)

### Claims and evidence

- `side: "head"` for code as it is after the PR, `"base"` for code as it was (removed or changed
  behaviour). Paths are repo-relative. `start`/`end` are 1-based and inclusive.
- `snippet` is the exact text of those lines, copied from the file. Keep ranges to 25 lines or
  fewer; cite the lines that show the point, not the whole function.
- Reuse claims: one claim can back several answers. Claim ids: `c1`, `c2`, …
- A good claim is specific: "`Run` releases the lease and requeues the row after `d`" with the
  lines, not "handles waiting".

### Files

Every changed file in `pr.json` appears in exactly one node's `files`. Mark generated, vendored
and lock files `generated: true` and don't read them line by line; list them in
`coverage.skipped` by group. Give each non-generated file a one-line `summary`.

## Working method

The repo can be large. Work in passes and write the JSON to the output path as you go, so work
isn't lost:

1. Read `pr.json`; group the changed files by top-level area. Survey the repo's top-level structure.
2. Build the coarse system graph (all top-level nodes, their responsibilities and externals).
3. For each changed area, read the diff and enough surrounding code to build its modules, edges,
   boundaries and responsibilities. Discover facets as you go; settle the facet list before you
   assign values everywhere.
4. Write scenarios by following the new flows through the code.
5. Answer the questions, writing claims with snippets copied from the files.
6. Run the validator and fix everything it reports, until it passes with no errors:
   `node <beghu>/web/prototype-pr-view/validate.ts <output.json> <dir>`
   It checks ids and references, that every snippet matches its file's lines, that every changed
   file is placed, and flags judging or comparing words.

Return a short report: the output path, the counts (nodes, edges, claims, scenarios), the facets
you found, and what you couldn't cover.
