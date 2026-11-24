# PR analysis instructions

You are analysing one pull request for beghu's PR view, so that an engineer can understand it
through a graph: which services and modules it touches, where data flows, where it reaches
outside, in which order things happen, and what the PR sets out to do. They drill from the graph
into short answers, then into the exact code lines. Your output is one JSON file in the shape of
`schema.ts`. Read `schema.ts` first: every field's comment is part of these instructions.

The run header above these instructions names the PR, its pinned SHAs and how to fetch the run's
files: `pr.json`, `schema.ts`, `previous-ids.json`, `vocabulary.json`, and the two tools,
`validate.mjs` and `merge.mjs`.

**Who this is for.** Any coding agent with a shell and git. Two capabilities are optional, and
the steps below say what to do with or without each:

- **Node** (any current version, nothing to install), to run `validate.mjs` and `merge.mjs`.
- **Orchestration**: native subagent orchestration (starting subagents and waiting for them) or
  native workflow orchestration (running a scripted set of agents).

These instructions are tested on current top models. A smaller model is not promised to produce
an analysis that passes.

**Cost.** One shape and one depth, no coarse mode. A large PR is split across several agents and
can take an hour.

## Limits

- A PR with more than 3,000 changed files is refused when the run starts.
- The upload is at most 8 MB on the wire and 32 MB once inflated. It may be gzipped
  (`Content-Encoding: gzip`).
- A code evidence quotes at most 25 lines.
- Purposes go two levels deep at most (purpose › sub-purpose).
- A conflict lists at most 20 break sites, then counts the rest.
- A chapter over 6 steps is warned about.
- An answer is at most two sentences; a walk is 2–3 sentences; a role is one line.

## The rules that matter most

1. **Every statement is a claim with evidence.** Every answer, responsibility, facet value, line,
   step, walk and role lists claim IDs. A code claim cites exact line ranges at base or head, with
   the exact snippet. If you can't find the lines, the claim is `undetermined`, with `lookedAt`
   saying where you looked: never guess, never write a confident sentence with no lines behind
   it.
2. **Code is the only source for the code view.** Nodes, lines, facets, responsibilities, answers,
   scenarios, `built`, `carried`, causes and break sites come from code: source, config, schemas,
   manifests, infra code, migrations. Never from docs, READMEs, comments, commit messages or the
   PR description. A comment may point you at code; the claim rests on the code. **The purpose
   view** (purposes, roles, walks and conflict sides) may also rest on the PR's description and
   the issues the run served, quoted word for word. The validator enforces the split
   (`claim.stated-only`).
3. **Observe and report.** State what each thing is and does. Never relate two things by
   likeness ("similar to", "overlaps", "duplicates", "same as"), never recommend ("should",
   "could instead", "better", "consider"), never grade ("risky", "clean", "concern", "smell",
   "well-designed"). If two email modules exist, describe each one's capabilities fully and let
   the reader see it. Security answers state facts: what input arrives from where, what checks it
   (with lines), or that no check was found on the path you followed (with where you looked).
   Placement follows the code's structure, never likeness.
4. **Short.** Summaries and roles are one line. Answers are at most two sentences. A walk is one
   paragraph of 2–3 sentences. Depth comes from the drill-down, not from length.

## The checkout

You need the repo at two commits: the PR's head (the SHA the run pinned) and the merge base of
the PR's base branch and that head. beghu's tools never check out code; you do.

Use your harness's own worktree handling if it has one. Otherwise, plain git:

```sh
git clone --filter=blob:none https://github.com/<owner>/<repo>.git repo   # or reuse a clone
git -C repo fetch origin <head SHA> <base tip SHA>
base=$(git -C repo merge-base <base tip SHA> <head SHA>)
git -C repo worktree add --detach ../head <head SHA>
git -C repo worktree add --detach ../base "$base"
```

Compute the merge base yourself, as above, and write it to `pr.baseSha`. `git -C head diff
<base> <head SHA> -- <path>` gives a file's diff. Copy the other `pr` fields from `pr.json`,
`description` word for word.

## The procedure

Work in this order. With orchestration, the areas and the rule checks run in parallel; without,
run them in sequence, each in a fresh context where you can, with every fragment written to disk.
Write files as you go so no work is lost.

### 0. Read what the last analysis left

Read `previous-ids.json` (the previous analysis's node and line IDs) and `vocabulary.json` (its
facets with their values, and its purposes) before anything else. Either may be missing (a `404`
from the run): then there was no previous analysis and `carried` stays empty. The run never
serves the previous analysis itself: re-check everything against the code.

Reuse every previous ID wherever the code is still the same thing. Record each one you don't
reuse in `carried` as you go (see "Carrying over").

### 1. The skeleton (one agent)

Map the whole system coarsely and settle what every later step shares:

- the `pr` fields;
- the facets and their values (reuse `vocabulary.json`'s; see "Facets");
- the boundaries;
- every top-level part, store, external system and person, with a one-line summary and its main
  responsibilities;
- the PR's purposes, in reading order, each with a **flow sketch**: its entry points and the
  rough path through top-level parts (see "Purposes");
- the rules the purposes set;
- the **candidates**: pairs of top-level parts where one might use the other, from imports,
  manifest dependencies, client construction and URLs in config. Imports are a search aid here,
  never lines.

Then decide `single` or `split`. Split when the change and the parts it reaches are more than one
agent can read and describe in one context. Fixtures, lockfiles and generated files count as
cheap: they're listed, not read line by line. Draw the **areas** from the repo's own structure
(workspaces, services, packages), not from the diff alone:

- every changed file is owned by exactly one area;
- every top-level part lies whole in exactly one area;
- areas don't overlap, and each is named after one of its path prefixes;
- unchanged parts that no changed area covers go in one or more **system areas**, which draw
  lines and responsibilities only and own no changed file;
- each candidate belongs to its caller's area, because the evidence is on the caller's side.

In `split` mode, write the skeleton as a fragment (a partial analysis that carries `version`:
see `Fragment` in `schema.ts`) and the plan as `split.json` (`Split`). Each area's prefixes are
folders of the repo, never its root. In `single` mode there is no `split.json` and no split
check: go on to the checkpoint (see "Single mode").

### 2. Check the split (split mode only)

```sh
node validate.mjs skeleton.json base head --split split.json --pr pr.json
```

(or `beghu analyse check-split`). Fix every error before going on.

### 3. The checkpoint

An interactive harness shows the engineer the plan (single mode, or the areas and their
estimates) and asks before going on. A non-interactive one goes on.

### 4. The areas (one agent each)

Give each area agent these instructions, `schema.ts`, the skeleton, `split.json`, its own area,
and its slice of `previous-ids.json` (the IDs under its prefixes). Each writes a **fragment**: a
partial analysis of its area with `version` set (the merge leaves out a fragment without one),
with its own claims (`c1`, `c2`, …, local to the fragment and each ID used once), plus **hints**
for what it can't settle alone:

- its parts, down to where the files are, with their lines, responsibilities, facets, files,
  answers, walks and `built`;
- every candidate it owns, resolved in a `candidate` hint: `drawn` (the line IDs) or `rejected`
  with a claim ("imports only shared types");
- a `seam` hint for each line it expects to cross into another area's module, when it knows the
  callee only as a top-level part. Give it `uses` (the callee's responsibility) when you know
  which one the call needs: then only a line with that `uses` answers it;
- for the purposes: `serves` for its own parts, `carries` for lines inside the area, and
  stated-vs-code conflicts in its own files. **An area can't create a purpose or a rule**: it
  writes a `purpose` or `rule` hint, or puts the part in `unclaimed` with a reason. A purpose or
  rule an area writes that the skeleton and `split.json` don't have becomes a hint in the merge.

A node ID derived from paths lets an area name another area's module without asking.

### 5. Merge

```sh
node merge.mjs --split split.json skeleton.json area-1.json area-2.json ... > merged.json
```

(or `beghu analyse merge`). The skeleton comes first. The merge joins the fragments, renumbers
claims `c1…` across them, drops the skeleton's coarse lines an area drew deeper, and lists the
seam pass's work as `hints`: every unmatched seam hint, every line from one area that ends at a
part with children in another (`deepen`), every unresolved candidate (with `--split`, also each
`split.json` candidate no area drew or rejected), every purpose and rule hint, and every purpose
or rule an area wrote that the skeleton and `split.json` don't have. Never merge by hand.

### 6. The rule checks (one per rule)

Check each rule against all of head, not just the diff (see "Rules"). With orchestration, run
them in parallel.

### 7. The seam pass, then scenarios (one agent)

Trace each purpose's flow across the merged graph, from its flow sketch:

- Resolve every hint by setting its `resolution`: draw the missing line (`drawn`), deepen a line
  that ends at a parent (`deepened`), add a purpose, sub-purpose or rule (`added`), fold the work
  into an existing one (`folded`), or reject it with a claim saying where you looked
  (`rejected`).
- Write `carries` across areas, then each purpose's `stops` and walk, the PR's walk,
  purpose-vs-purpose conflicts, the purpose-vs-outside conflicts the rule checks found, causes,
  and the final `unclaimed`.
- Then write the scenarios, from the flows you just traced.

Then strip the resolved hints:

```sh
node merge.mjs --finish merged.json > analysis.json
```

It keeps, and reports, any hint still unresolved.

### 8. Validate

```sh
node validate.mjs analysis.json base head --pr pr.json --previous <folder with previous-ids.json and vocabulary.json>
```

It checks the shape, every reference, every rule below, and every
snippet against the checkouts. Fix every error and run it again until it reports none. Fix the
warnings too; a warning on a quoted identifier can stay.

### 9. Upload

Upload `analysis.json` as the run header says. The server runs every check it can without the
code. An upload carrying `hints` is refused.

### Without Node

You can't run `validate.mjs` or `merge.mjs`: work in `single` mode (one agent, every step above
in order, no merge), check your own work against "The validator's rules", and upload. The server
still runs its checks, and the reader sees the evidence labelled "not checked".

### Single mode

One agent does every step in the same order: the skeleton, the areas' work for the whole repo,
the rule checks, the seam pass's work and the scenarios. There is no `split.json` and no split
check (skip step 2), and there are no fragments, hints or merge: write `analysis.json` directly.

## What to draw

### The graph, at two altitudes

- **The whole system, coarse.** Every top-level deployable or package (apps, services, shared
  libraries, infra, CI, docs), whether the PR touches it or not, with a one-line summary and its
  responsibilities. Find them from the repo's own structure (workspace manifests, `go.mod`,
  `package.json` workspaces, Dockerfiles, infra definitions).
- **Fine, near the change.** Inside every changed part: its modules (packages, folders with a
  role), down to where the files are. Changed parts are drawn complete. Each changed file goes in
  `files` of the deepest node that holds it. Aim for 3–12 children per node, as a hint for how
  deep to go, not a limit.
- **Outside the repo.** External systems the code talks to (third-party APIs, model providers,
  auth services) as `external` nodes, databases, queues, caches and buckets as `store` nodes, and
  the people or callers that start things as `actor` nodes. Find them from client construction,
  connection strings, env and config keys, and infra definitions.

Files that sit directly in the repo's top folder (`go.mod`, `package.json`, lockfiles,
`.gitignore`, env examples) go in one node named `top-level files`, never `root` or `repo root`.
CI workflows and docs get a node each, named after the folder.

**IDs and names.** Node IDs derive from paths (`services/advagent-v3/contract` →
`svc-advagent-v3.contract`) so a later run on the same code lands on the same IDs. Names come from
the code (the package or folder name), never invented labels.

**No grouping nodes.** Every node is code that exists: a real folder, or files, at base or head.
Every top-level part (deployable, library, infra folder, CI, docs, `top-level files`) and every
store, external system and person hangs directly off the system node. Never add a node that
groups folders, such as `apps`, `services` or `libs`, and never add a sub-group inside a folder to
keep a node's children within 3–12: that range is a hint for how deep to go, not a limit. A chain
of folders with no code of their own and one child each is one node, named by the joined path
(`cmd/server`). A node with children still has its own responsibilities, with claims.

**What part of the product each part is for.** Discover one grouping facet for the system's own
top-level parts, id `inside-*`, answering "What part of the product is it for?", in this repo's
terms (for example "ESG reporting", "agent runtime", "energy data ingestion", "platform and
deploy"). Assign it to every top-level own part. A part that serves several gets every value it
serves, each with the claims that show it (who imports it, which entrypoint uses it). Don't rank
the values or call one the main one.

**What the system uses, grouped.** External systems and stores are never grouped under a node of
their own. Discover 2 or 3 facets for them, ids `outside-*`, from the code:

- **What it does for this system** (required, the first): sign-in, authorization, AI models,
  sandboxing, observability, email, relational data, cache, object storage, CI and deploys, and so
  on, whatever the code shows. 5–9 values, one per system.
- **Who runs it, as the code shows it**: deployed by this repo's infra code, a hosted service
  reached by URL and key, a cluster service at an in-cluster hostname, and so on. Not every repo
  has infra code: say what the code does show.
- Optionally **who reaches it**: production code only, dev tooling and CI only, or both. Only if
  it groups them differently from the first two.

Every external system and store gets a value for each, with claims; `unknown` with an
undetermined claim where the code doesn't show it.

**"Changed" means the part's own code changed.** `added` if it exists only at head, `removed` if
only at base, `modified` if a file the PR changed lies under its paths or a child's, else
`unchanged`. People, external systems and stores the PR merely starts using stay `unchanged`:
their new or changed lines carry the change.

### Unchanged parts: coarse, opened only along a path

An unchanged part gets its summary, responsibilities and lines, and nothing inside it, unless a
line, a scenario step, a purpose or a conflict needs to end at a module in it. Then add only those
modules and their parents, not their siblings, and set `drawn: { partial: true, folders: N }`,
where `N` counts every folder under the part's paths, at any depth, that holds at least one file
git tracks at head (`git ls-files`), directly or in a subfolder. Untracked and ignored folders
(`node_modules`, build output) don't count. Say so in `coverage.notes` ("sandbox: 3 of 9
folders drawn, the ones this PR's flows reach").

### Lines

- **Every direct connection at head between two top-level parts, changed or not**, unchanged ↔
  unchanged included. A transitive connection (A → B → C) is not also A → C. Two parts that share
  a store connect through the store's node, not to each other.
- **Using something is a line; importing it is not.** A part importing a library draws nothing by
  itself; calling the library's `db.Open` draws a `call` line.
- **One `call` line per (caller, callee responsibility),** with `uses` naming the callee's
  responsibility ("advagent-v3 → golib: opens MySQL connections"). If the caller uses something no
  responsibility covers, the callee's list is incomplete: add a responsibility. Runtime
  interactions stay one line per interaction: a new interaction is its own `added` line even
  where two nodes already had others. A line is `modified` when the PR changes how a caller uses a
  responsibility (with base-side evidence of how it worked before).
- **`when`** on every line: `runtime` (production code at run time), `build` (Dockerfiles, infra
  that deploys a part, CI, code generation from another part's schema), or `test` (tests or dev
  tooling reaching *another* part or an external system; a test that calls the code it tests is
  not a line).
- **`data`** says what domain data crosses (records, messages, files, prompts, model output,
  credentials) and which way. Required on `data` and `event` lines; on a `call` only when domain
  data crosses ("sends chat prompts, gets completions"), not for plumbing. Logs are plumbing
  unless the system reads them back. Never just "data" or "request".
- **A call-site claim on every line**: code evidence on the `from` node's paths (the lines that
  call, write or publish). On a line from an external system or a person, the receiving entry
  point (the handler or the consumer) on the `to` node's paths. One snippet is enough on an
  unchanged line.
- **A connection you suspect but can't confirm** (a URL built from config) is drawn with an
  `undetermined` claim and `lookedAt`.
- Draw each line at the deepest level you can show; the view rolls lines up. Each line says
  whether it's sync or async, which boundaries it crosses, and how the PR changed it.

### Boundaries

Where trust, process, network or tenant changes: browser ↔ server, service ↔ service, service ↔
third party, user input ↔ trusted code, sandbox ↔ host, tenant data separation. Put nodes in a
`zone` where that is clear, and list on each line the boundaries it crosses. New lines and lines
that newly cross a boundary matter most: find all of them.

### Responsibilities

Per node, a few short items of what it does, each with claims and its `change`. A PR that gives an
existing node a new responsibility, especially of a new kind (an HTTP handler that now also
queries the database and builds HTML), is one of the most important things to show.

### Facets: discover them

Facets let the reader see, by colour and words, how differently parts are built. Discover them
from this repo; don't use a fixed list. Look for the dimensions along which this repo's code
differs, for example:

- the responsibility kinds a node mixes (domain logic, data access, presentation, I/O and infra,
  orchestration, configuration): always include this one, `multi: true`;
- language and runtime; the effect or async style; paradigm; how dependencies are wired; how
  state is held; how errors travel; how data access is done; how it's tested;
- for lines: transport (HTTP, gRPC, queue, DB row, file), and who initiates (push or pull).

Keep a facet only if it separates nodes in this repo (two or more values in use). Aim for 4–7 node
facets and 1–3 line facets, each with 2–8 values and an `unknown` value. Prefixes are 1–4
characters (`FX`, `TS`, `Go`, `DI`). Assign every facet to every node it applies to, every value
with its own claims. When the PR changed a node's value, fill `was`. Reuse `vocabulary.json`'s
facet and value IDs: a kept value may change its label, prefix and description freely, and kept
IDs keep their colours.

### Scenarios: the order of actions

The flows the PR adds or changes, each from a trigger (a person acts, a schedule, a message, a
deploy) through the nodes to its end. Steps name nodes and, where one exists, the line. Include
unchanged steps where the flow passes through existing code.

- **Write every hop, and don't shorten a flow by dropping steps.** There is no step limit. Each
  step names the deepest node it happens in (a module, not its service).
- **Cut each flow into chapters,** one per moment. A chapter ends where the flow hands over: a
  person acts, a part writes something another part picks up later (a queued row, a message), a
  deploy stage ends. A synchronous request is one chapter even when it crosses services. Most
  chapters are 2–6 steps; a longer one usually holds two moments. A flow with one moment has one
  chapter.
- **A chapter's title says what happens in it,** as a short sentence of fact ("advagent-v3 takes
  the message and replies"), never a verdict.

### Files

Every changed file in `pr.json` appears in exactly one node's `files`. Mark generated, vendored
and lock files `generated: true`, don't read them line by line, and list them in
`coverage.skipped` by group. Give every other file a one-line `summary`.

## Purposes

A purpose is something the PR sets out to do. Name and order them from the description, the
issues the run served (`pr.json`'s `issues`) and the code. Array order is reading order: the
top-level purposes first, then each one's sub-purposes. IDs are path-like slugs
(`purpose:tenant-isolation`, `purpose:tenant-isolation/role-check`); reuse `vocabulary.json`'s.
`kind` is one of `feature`, `process`, `security`, `fix`, `groundwork`, `chore`.

- **Sources.** Quote the description and the served issues word for word. A reference the run
  didn't serve (`pr.json`'s `unreached`) may be read with your own tools (`gh`, an MCP server for
  an issue tracker), and what you learn may shape how you name and order purposes, but it is never
  evidence: list it in `coverage.references` as `own-tools`, or `unreached` if you couldn't read
  it. Never quote an issue the run didn't serve.
- **Members.** `serves` lists the deepest parts that serve the purpose, each with its role in one
  line; never an ancestor of a part already listed. The part may be unchanged: that's how a
  purpose reaches outside the diff, and it opens that part along a path. `carries` lists only the
  lines the purpose's flow passes along, not every line between two members.
- **Stops** are the journey, in order: sub-purposes, parts at any level and lines, each with one
  line. A part or line stop is a member or contains one. Every stop that is a part or a line gets
  its own walk.
- **Walks** (`intro`, `journey`, `destination`): one paragraph of 2–3 sentences with at least one
  claim. Required on the PR, every purpose and sub-purpose, every stop, and every changed
  top-level part; optional elsewhere. A line with a walk also says what needs it (`neededBy`).
- **A stated promise no code serves isn't a purpose.** It's a stated-vs-code conflict whose code
  side is `undetermined` with `lookedAt`: "Does the PR remove retries? Description: yes. The
  code: no change found."
- **Partial coverage is normal.** Every changed leaf part serves at least one purpose (directly
  or through a sub-purpose) or goes in `unclaimed` with a reason.
- **The fallback.** When no purpose can be backed: `purposes: []`, `unbacked` (one or two
  sentences on why), and every changed leaf part in `unclaimed`. The PR's walk is still required:
  it can always say what changed, from the code.

### Rules

A rule is a universal statement a purpose says must hold, stated in the description or a served
issue, or established by the PR's own code ("every handler checks the caller's role"). Its
`scope` says in plain words where it applies.

- Check it against **all of head**, not just the diff. Enumerate the scope with search (grep, the
  language's tooling, route tables), and record how in `checked.searched`, with the counts.
- **How far: the scope as written, followed one hop.** For each site, look at the site and what it
  directly calls (a handler and its middleware chain), and no deeper. A site you can't decide is
  undetermined, never a break.
- A rule that holds is recorded too: "checked 48 handlers: all hold".
- **One conflict per broken rule**, never one per site: a `purpose-outside` conflict naming the
  rule, whose outside side lists the first 20 breaks with evidence in `sites` and counts the rest
  in `more`. A break inside the diff is a stated-vs-code or purpose-vs-purpose conflict instead.

### Conflicts and causes

A conflict puts two facts side by side, each with its source, and no verdict. Exactly two sides:
a three-way disagreement is two conflicts. Its `question` is what both sides answer ("Are failed
refunds retried?"), with no verdict, and each side's `says` is the answer in a few words.

- **Stated vs code**: the description or an issue on one side, the code on the other.
- **Purpose vs purpose**: for every part that serves two or more purposes, compare what each
  purpose's role needs from it. Check every rule against the other purposes' new code too.
- **Purpose vs outside**: a rule against code outside the diff, as above.

`touches.nodes` lists every node the sides' code evidence lands in, unchanged ones included.

A **cause** is shared by several conflicts ("Migrations were renumbered after the description was
written"). Write one only when code evidence shows it.

## Writing

- **Answers** are at most two short sentences of fact, each with claims, against these fixed
  questions, skipping any that don't apply:
  - **Service, app, module, library:** What changed? — What does it do now that it didn't
    before, and what did it stop doing? — What does it depend on, and what depends on it? — What
    input does it take, from where, and what checks it? — What does it read and write? — What
    happens when it fails? — How is the code organised: layers, entry points, where logic and I/O
    live?
  - **External system, store:** What is sent to it and what comes back? — How does the code
    authenticate to it, and where do credentials come from? — What happens when it is slow or
    down?
  - **Line:** What data flows, in what shape? — Who starts it, sync or async, and how often? —
    What guards the boundary it crosses: auth, validation, limits? — What happens on failure,
    timeout or retry? — What changed about it?
- A walk is 2–3 sentences, intro → journey → destination, one paragraph. A role is one line.
- A conflict's question has no verdict; `says` is a few words.
- Quote the description and the served issues verbatim.
- Observe and report only: no recommendations, anywhere.

## Claims and evidence

- `side: "head"` for code as it is after the PR, `"base"` for code as it was (at the merge base).
  Paths are repo-relative. `start` and `end` are 1-based and inclusive.
- `snippet` is the exact text of those lines, copied from the file. Keep ranges to 25 lines or
  fewer; cite the lines that show the point, not the whole function.
- A description or issue evidence quotes the text word for word, as `pr.json` serves it.
- Reuse claims: one claim can back several statements. Claim IDs: `c1`, `c2`, …
- A good claim is specific: "`Run` releases the lease and requeues the row after `d`" with the
  lines, not "handles waiting".
- The view works out "backed", "stated, not found in code" and "code" from the evidence kinds; you
  never write them.

## Carrying over

The code is the truth: you may redraw anything. Every ID in `previous-ids.json` and
`vocabulary.json` (nodes, lines, facets, facet values as `<facet id>/<value id>`, purposes and
sub-purposes) that isn't in your analysis is declared in `carried`:

- `kind`: `renamed` or `merged` (one ID in `now`), `split` (two or more), `dropped` (none);
- `cause`: `code` (the code moved, renamed or removed it), `correction` (the previous analysis was
  wrong), or `scope` (this run no longer needs to draw it);
- `reason` in one line, and at least one claim with code evidence: the lines that show the new
  reading. "The previous run was weaker" isn't evidence.

Conflicts, causes, scenarios and chapters don't carry. With no previous analysis, `carried` is
empty.

## The validator's rules

The validator (`validate.mjs`, the CLI and the server) reports each finding with one of these
rule IDs. Errors refuse the upload; warnings (marked) don't.

- `version.unknown`: `version` is missing or newer than the validator's. `schema.migrated`
  (warning): the file was migrated from an older version; refetch the run's files.
  `migration.failed`: a migration step failed.
- `shape.json`, `shape.missing-field`, `shape.unknown-field`, `shape.enum`, `shape.type`: the file
  doesn't fit `schema.ts`; the path points at the field itself. `shape.hints`: the file has a
  `hints` key, even an empty one (`merge.mjs --finish` strips the resolved hints and the key).
  `hint.unresolved`: a hint the seam pass hasn't resolved.
- `id.duplicate`: an ID is used twice (IDs share one namespace). `ref.unknown`: a reference names
  nothing. `claim.id`: a claim ID isn't `c1`, `c2`, …. `purpose.id`: a purpose ID isn't a
  path-like slug under its parent's.
- `system.root`: not exactly one `system` node, or a node with no parent. `node.parent-cycle`.
  `node.paths`: a node that is code has no paths. `node.change-summary`: a changed node has no
  `changeSummary`. `change.own-code`: a node marked changed whose own code didn't change.
- `file.duplicate`: a file on two nodes. `file.unplaced`: a changed file on no node.
  `file.summary`: a file that isn't generated has no summary. `responsibility.duplicate`.
- `group.responsibility`: a node with children has no responsibility of its own.
  `group.top-level-kinds`: a service, app, library, store, external system or person inside a
  top-level part. `group.inside`: the `inside-*` facet is missing, or a top-level part has no
  value for it. `group.outside`: not 2–3 `outside-*` facets, or a store or external system without
  a value for each.
- `drawn.changed`: `drawn` on a changed part. `built.changed`: `built` on an unchanged part.
- `facet.values`: fewer than two values. `facet.unknown-value`: no `unknown` value.
  `facet.prefix`: a prefix outside 1–4 characters. `facet.applies-to`: a node facet on a line or
  the reverse. `facet.single`: several values for a facet that isn't `multi`.
  `facet.value-claims`: a value without its own claims.
- `line.uses`: a `call` with no `uses`, or one naming no responsibility of `to` or a node inside
  it. `line.data`: a `data` or `event` line with no `data`. `line.data-generic` (warning): `data`
  names no domain data. `line.call-site`: no claim with code evidence at the call site.
  `line.per-interaction`: two lines for one interaction. `line.needed-by`: a line with a walk has
  no `neededBy`.
- `chapter.missing`, `chapter.first` (the first chapter isn't at step 0), `chapter.order`
  (chapters out of order or past the last step), `chapter.long` (warning: over 6 steps).
- `claims.missing`: an element that needs claims has none. `claim.unused` (warning): nothing
  refers to a claim. `claim.no-evidence`: supported with no evidence. `claim.looked-at`:
  undetermined with no `lookedAt`. `claim.stated-only`: the code view resting on the description
  or an issue alone. `evidence.lines`: a range that isn't one, or over 25 lines.
- `words.judging` (warning): a judging or comparing word; describe instead.
- `purpose.depth`: deeper than purpose › sub-purpose. `purpose.redundant-member`: a part and its
  ancestor both serve a purpose. `purpose.no-members`: no part serves it.
  `purpose.stop-not-member`: a stop that isn't a member, a part holding one, or a sub-purpose.
  `walk.required`: a stop or a changed top-level part without a walk. `walk.claims`: a walk with
  no claim.
- `conflict.kind-sides`: the sides don't fit the conflict's kind. `conflict.touches`:
  `touches` misses a node the evidence lands in, or a side's purpose. `conflict.sites`: over 20
  sites listed. `cause.evidence`: a cause without supported code evidence.
- `unclaimed.missing`: a changed leaf part that serves no purpose and isn't in `unclaimed`.
  `unbacked.exact`: `unbacked` present with purposes, or missing or blank without them.
- `carry.unaccounted`: a previous ID that is gone with no `carried` entry. `carry.unknown`: an
  entry for an ID the previous analysis didn't have (or there was none). `carry.present`: an
  entry for an ID still in the analysis. `carry.now`: `now` doesn't fit `kind`.
  `carry.evidence`: no supported claim with evidence.
- With the checkouts: `evidence.file` (no such file on that side), `evidence.range` (past the
  file's end), `evidence.snippet` (the snippet isn't the file's lines), `path.missing` (a path at
  neither base nor head), `drawn.folders` (the count of folders holding git-tracked files is
  wrong, or head isn't a git checkout).
- The split check: `split.file-area` (a changed file in no area, in two, or outside its area's
  prefixes), `split.part-area` (a top-level part in no area or split across two),
  `split.overlap`, `split.id` (an area not named after one of its prefixes),
  `split.system-area` (a system area owning changed files), `split.prefix` (a prefix that is the
  repo root or isn't a repo-relative folder). The merge: `merge.duplicate` (warning: two areas
  wrote the same element), `merge.duplicate-claim` (a fragment holds a claim ID twice; the first
  is kept).

## When you're done

Report the analysis's path, its counts (nodes, lines, claims, purposes, conflicts, scenarios),
the facets you found, what you couldn't cover, and whether the upload was accepted.
