// The PR view's panel: its reference content for each place the selection can be (#181). The
// walkthrough (slice 9) goes above it and folds this under "Questions, facets, files and
// evidence" ("All changes, by kind" at the PR).
//
// - The PR (nothing selected): the stated-rule list "All changes, by kind", the description
//   (verbatim, folded), coverage, the facets found, and "Since the last analysis" (folded).
// - A part: its questions, what it does (each responsibility with its change and how many parts
//   use it, from the lines' `uses`), how it's built, its connections (the ones the Lines menu
//   hides listed faded, "hidden: test"), and its files.
// - A line: each connection's questions, facets, what it carries, when, mode, boundaries crossed
//   and evidence.
// - A step: previous and next, and the whole flow.
// - A group (a column, a box, the Shared box; slice 8): its name and what groups it, "N parts · N
//   changed", its lines to other blocks grouped by neighbour with counts, its members to pick
//   from, and for a box each member's placement with its claims (for the Shared box, each
//   member's values with theirs).
// - A boundary: what it is, its claims, and every line crossing it.
//
// Every claim sits in its own boundary (claims.tsx). Answers are short; depth is a fold away.
import * as stylex from "@stylexjs/stylex";
import { createMemo, Errored, For, Loading, Show, type Element } from "solid-js";
import type { Carried, CarriedCause, Edge, FacetAssignment, Node, Question } from "../bindings/analysis";
import { claimCount, ClaimList, useEvidencePaths } from "./claims";
import type { Model } from "./model";
import { line, part, selOf, useNav } from "./nav";
import { hiddenBy, parseLines, type Sel } from "./state";
import { ChangeWord, changeText, Fold, githubBlob, githubTree, Mark, ui } from "./ui";
import { colors } from "../tokens.stylex";
import { touched } from "./canvas/look";
import { useCanvas } from "./canvas/store";

export function Panel(props: { note?: string; dismiss: () => void }) {
  const nav = useNav();
  return (
    <div {...stylex.attrs(s.panel)} data-perf="view-panel">
      <Show when={props.note}>
        {(n) => (
          <p role="status" {...stylex.attrs(ui.note, s.forward)} data-perf="forward-note">
            <span>{n()}</span>
            <button type="button" {...stylex.attrs(ui.pick, ui.muted)} aria-label="Dismiss" onClick={() => props.dismiss()}>
              ×
            </button>
          </p>
        )}
      </Show>
      {/* Keyed on the analysis as well as the selection: after Show it, a place whose ID
          survived shows the newer analysis's words, with its claims' boundaries afresh. */}
      <Show when={nav.model()} keyed>
        {(_model) => (
          <Show when={nav.sel()} keyed fallback={<PrPanel />}>
            {(sel) => <Place sel={sel} />}
          </Show>
        )}
      </Show>
    </div>
  );
}

function Place(props: { sel: Sel }) {
  const nav = useNav();
  const m = () => nav.model();
  const sel = props.sel;
  switch (sel.kind) {
    case "part": {
      const nodes = sel.ids.map((id) => m().nodes.get(id)).filter((n): n is Node => n !== undefined);
      return nodes.length === 1 ? <PartPanel n={nodes[0]!} /> : <PartsPanel nodes={nodes} />;
    }
    case "line":
      return <LinePanel edges={sel.ids.map((id) => m().edges.get(id)).filter((e): e is Edge => e !== undefined)} />;
    case "step":
      return <StepPanel scenario={sel.scenario} n={sel.n} />;
    case "purpose": {
      const ids = sel.ids.filter((id) => m().purposes.has(id));
      return ids.length === 1 ? <PurposePanel id={ids[0]!} /> : <PurposesPanel ids={ids} />;
    }
    case "conflict":
      return <ConflictPanel id={sel.id} />;
    case "unclaimed":
      return <UnclaimedPanel />;
    case "group":
      return <GroupPanel id={sel.id} />;
    case "boundary":
      return <BoundaryPanel id={sel.id} />;
  }
}

/** A pick: selects what it names. */
function Pick(props: { to: Sel; children: Element; accent?: boolean; perf?: string }) {
  const nav = useNav();
  return (
    <button type="button" {...stylex.attrs(ui.pick, props.accent && ui.pickAccent)} data-perf={props.perf} onClick={() => nav.select(props.to)}>
      {props.children}
    </button>
  );
}

function H3(props: { children: Element }) {
  return <h3 {...stylex.attrs(ui.h3)}>{props.children}</h3>;
}

// ---- The PR ------------------------------------------------------------------------------------

function PrPanel() {
  const nav = useNav();
  const m = () => nav.model();
  const a = () => m().a;
  const partlyDrawn = () => a().nodes.filter((n) => n.drawn);
  return (
    <div data-perf="pr-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>
        {a().pr.repo}#{a().pr.number} · {a().pr.stats.files} files · <span {...stylex.attrs(changeText.added)}>+{a().pr.stats.additions.toLocaleString("en")}</span>{" "}
        <span {...stylex.attrs(changeText.removed)}>−{a().pr.stats.deletions.toLocaleString("en")}</span>
      </p>
      <h2 {...stylex.attrs(ui.h2)}>All changes, by kind</h2>
      <For each={m().ranked()}>
        {(g) => (
          <section data-perf="rank-group">
            <H3>
              {g.title} ({g.items.length})
            </H3>
            <p {...stylex.attrs(ui.p, ui.muted, ui.small, s.rule)}>{g.rule}</p>
            <Show when={g.items.length > 0} fallback={<p {...stylex.attrs(ui.p, ui.muted, ui.small)}>None.</p>}>
              <ul {...stylex.attrs(ui.list)}>
                <For each={g.items}>
                  {(it) => (
                    <li {...stylex.attrs(ui.item)} data-perf="rank-item" data-kind={it.kind} data-id={it.id}>
                      <Mark change={it.change} />
                      <Pick to={it.kind === "line" ? line(it.id) : part(it.id)}>{it.text}</Pick>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>

      <H3>The PR</H3>
      <Fold summary="The PR's description" perf="description">
        <Show when={a().pr.description.trim()} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>The PR has no description.</p>}>
          <div {...stylex.attrs(s.description)}>{a().pr.description}</div>
        </Show>
      </Fold>

      <H3>Coverage</H3>
      <div {...stylex.attrs(ui.stack)} data-perf="coverage">
        <p {...stylex.attrs(ui.p)}>{a().coverage.summary}</p>
        <Show when={a().coverage.skipped.length > 0}>
          <Fold summary={`Skipped: ${a().coverage.skipped.reduce((n, k) => n + k.files, 0)} files not read line by line`}>
            <ul {...stylex.attrs(ui.list)}>
              <For each={a().coverage.skipped}>
                {(k) => (
                  <li>
                    {k.what} ({k.files} {k.files === 1 ? "file" : "files"}): <span {...stylex.attrs(ui.muted)}>{k.reason}</span>
                  </li>
                )}
              </For>
            </ul>
          </Fold>
        </Show>
        <Show when={a().coverage.notes.length > 0}>
          <Fold summary={`Notes (${a().coverage.notes.length})`}>
            <ul {...stylex.attrs(ui.list)}>
              <For each={a().coverage.notes}>{(n) => <li>{n}</li>}</For>
            </ul>
          </Fold>
        </Show>
        <Show when={a().coverage.references.length > 0}>
          <Fold summary={`References the run didn't serve (${a().coverage.references.length})`}>
            <ul {...stylex.attrs(ui.list)}>
              <For each={a().coverage.references}>
                {(r) => (
                  <li>
                    <span {...stylex.attrs(ui.mono)}>{r.ref}</span>:{" "}
                    <span {...stylex.attrs(ui.muted)}>{r.how === "own-tools" ? "read with the agent's own tools, never as evidence" : "unreached"}</span>
                  </li>
                )}
              </For>
            </ul>
          </Fold>
        </Show>
        <Show when={partlyDrawn().length > 0}>
          <Fold summary={`Partly drawn parts (${partlyDrawn().length})`}>
            <ul {...stylex.attrs(ui.list)}>
              <For each={partlyDrawn()}>
                {(n) => (
                  <li>
                    <Pick to={part(n.id)}>{n.name}</Pick>: <span {...stylex.attrs(ui.muted)}>
                      <DrawnLine n={n} />
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Fold>
        </Show>
      </div>

      <H3>Facets found</H3>
      <div {...stylex.attrs(ui.stack)} data-perf="facets-found">
        <For each={a().facets}>
          {(f) => (
            <Fold
              summary={
                <>
                  {f.name} <span {...stylex.attrs(ui.muted, ui.small)}>({f.appliesTo === "node" ? "parts" : "lines"})</span>
                </>
              }
            >
              <p {...stylex.attrs(ui.p, ui.muted)}>{f.question}</p>
              <ul {...stylex.attrs(ui.list)}>
                <For each={f.values}>
                  {(v) => (
                    <li>
                      <span {...stylex.attrs(ui.chip)}>{v.prefix}</span> {v.label}: <span {...stylex.attrs(ui.muted)}>{v.description}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Fold>
          )}
        </For>
      </div>

      {/* `previous` names the analysis this one replaced; one stored before it said so may
          still have a `carried`. */}
      <Show when={m().g.previous || a().carried.length > 0}>
        <H3>Since the last analysis</H3>
        <SinceLast />
      </Show>
    </div>
  );
}

const CAUSES: { cause: CarriedCause; title: string }[] = [
  { cause: "code", title: "Code changed" },
  { cause: "correction", title: "Corrected" },
  { cause: "scope", title: "No longer drawn" },
];

/**
 * The upload's `carried`, folded, by cause: each entry with its reason and claims. An empty one:
 * every ID of the last analysis is still here.
 */
function SinceLast() {
  const nav = useNav();
  const m = () => nav.model();
  return (
    <Show
      when={m().a.carried.length > 0}
      fallback={
        <p {...stylex.attrs(ui.p, ui.muted)} data-perf="since-last">
          Every part, line and purpose of the last analysis is still here, under the same ID.
        </p>
      }
    >
    <Fold summary={`${m().a.carried.length} IDs of the last analysis went`} perf="since-last">
      <For each={CAUSES}>
        {(c) => {
          const entries = () => m().a.carried.filter((x) => x.cause === c.cause);
          return (
            <Show when={entries().length > 0}>
              <Fold nested summary={`${c.title} (${entries().length})`} perf={`since-${c.cause}`}>
                <ul {...stylex.attrs(ui.list)}>
                  <For each={entries()}>{(x) => <CarriedItem x={x} />}</For>
                </ul>
              </Fold>
            </Show>
          );
        }}
      </For>
    </Fold>
    </Show>
  );
}

function CarriedItem(props: { x: Carried }) {
  const nav = useNav();
  const m = () => nav.model();
  return (
    <li data-perf="carried">
      <Fold
        nested
        summary={
          <>
            <span {...stylex.attrs(ui.mono)}>{props.x.was}</span> <span {...stylex.attrs(ui.muted)}>{props.x.kind}</span>
            <Show when={props.x.now.length > 0}>
              {" → "}
              <For each={props.x.now}>
                {(id, i) => (
                  <>
                    {i() > 0 ? ", " : ""}
                    <Pick to={selOf(m(), [id])} accent>
                      {m().name(id)}
                    </Pick>
                  </>
                )}
              </For>
            </Show>
          </>
        }
      >
        <p {...stylex.attrs(ui.p)}>{props.x.reason}</p>
        <ClaimList m={m()} ids={props.x.claims} />
      </Fold>
    </li>
  );
}

// ---- A part ------------------------------------------------------------------------------------

/** The paths a list of claims' code evidence shows (`useEvidencePaths`). */
type EvidencePaths = (ids: readonly string[]) => string[];

/**
 * Whether `p`, one of `d`'s paths, is a file: what the graph says (`Model.pathIs`), else `d`'s own
 * claims' code evidence, lines of `p` itself making it a file and of a path under it a folder.
 * Without `evidence` (the claims not in, or failed), or with neither, a folder, as a module
 * mostly is.
 */
function isFile(m: Model, d: Node, p: string, evidence?: EvidencePaths): boolean {
  const known = m.pathIs(p);
  if (known !== undefined) return known === "file";
  if (!evidence) return false;
  const shown = evidence([...d.responsibilities.flatMap((r) => r.claims), ...d.questions.flatMap((q) => q.claims)]);
  return shown.includes(p) && !shown.some((x) => x.startsWith(`${p}/`));
}

/**
 * The folders inside a part's paths that its drawing reaches, relative to the path they're in
 * and sorted: every folder, at any depth, on the way to a part drawn inside it (a folder part is
 * one itself; a file part's folders are), counted as `drawn.folders` counts them (the part's own
 * paths aside).
 */
export function drawnFolders(m: Model, n: Node, evidence?: EvidencePaths): string[] {
  const bases = n.paths.map((p) => p.replace(/\/+$/, ""));
  const inside = new Set<string>();
  for (const id of m.subtree(n.id)) {
    if (id === n.id) continue;
    const d = m.nodes.get(id);
    if (!d) continue;
    for (const raw of d.paths) {
      const p = raw.replace(/\/+$/, "");
      const base = bases.find((b) => b === "" || b === "." || p.startsWith(`${b}/`));
      if (base === undefined) continue;
      const rel = base === "" || base === "." ? p : p.slice(base.length + 1);
      const segs = rel.split("/");
      // A file part reaches its folders; a folder part, itself too.
      const folders = isFile(m, d, p, evidence) ? segs.length - 1 : segs.length;
      for (let i = 1; i <= folders; i++) inside.add(segs.slice(0, i).join("/"));
    }
  }
  return [...inside].sort();
}

/** "6 of 20 folders drawn (src, tests): …", for a partly drawn part. */
function drawnLine(m: Model, n: Node, evidence?: EvidencePaths): string {
  const total = n.drawn?.folders ?? 0;
  const drawn = drawnFolders(m, n, evidence);
  const rest = Math.max(0, total - drawn.length);
  const which = drawn.length ? ` (${drawn.join(", ")})` : "";
  return `${drawn.length} of ${total} folders drawn${which}: no line, step, purpose or conflict in this PR reaches the other ${rest}.`;
}

/**
 * `drawnLine`, the claims' evidence deciding the paths the graph can't: a moment's placeholder
 * while they're on their way, and the graph's word alone if they failed.
 */
function DrawnLine(props: { n: Node }) {
  const nav = useNav();
  const evidence = useEvidencePaths();
  return (
    <Errored fallback={drawnLine(nav.model(), props.n)}>
      <Loading fallback="counting the folders drawn…">{drawnLine(nav.model(), props.n, evidence)}</Loading>
    </Errored>
  );
}

const KIND: Record<string, string> = {
  system: "System",
  service: "Service",
  app: "App",
  library: "Library",
  module: "Module",
  store: "Store",
  external: "External system",
  actor: "Person or caller",
};

function PartsPanel(props: { nodes: Node[] }) {
  return (
    <div data-perf="parts-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>{props.nodes.length} parts, selected together</p>
      <ul {...stylex.attrs(ui.list, s.gap)}>
        <For each={props.nodes}>
          {(n) => (
            <li {...stylex.attrs(ui.stack)}>
              <span {...stylex.attrs(ui.row)}>
                <Mark change={n.change} />
                <Pick to={part(n.id)} accent>
                  {n.name}
                </Pick>
              </span>
              <span {...stylex.attrs(ui.p, ui.muted)}>{n.summary}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function PartPanel(props: { n: Node }) {
  const nav = useNav();
  const m = () => nav.model();
  const n = props.n;
  const parent = () => (n.parent !== undefined && m().nodes.get(n.parent)?.kind !== "system" ? n.parent : undefined);
  const conn = () => m().connections(n.id);
  const outside = n.kind === "external" || n.kind === "actor" || n.kind === "store";
  const newLines = () => [...conn().out, ...conn().into].filter((e) => e.change !== "unchanged").length;
  const sha = () => (n.change === "removed" ? m().g.mergeBase : m().g.headSha);
  const files = () => m().files(n.id);
  return (
    <div data-perf="part-panel" data-id={n.id}>
      <p {...stylex.attrs(ui.p, ui.muted)}>
        {KIND[n.kind] ?? n.kind}
        <Show when={parent()}>
          {(p) => (
            <>
              {" in "}
              <Pick to={part(p())} accent>
                {m().name(p())}
              </Pick>
            </>
          )}
        </Show>
      </p>
      <h2 {...stylex.attrs(ui.h2)}>{n.name}</h2>
      <p {...stylex.attrs(ui.p, s.gap)}>{n.summary}</p>
      <Show when={n.drawn}>
        <p {...stylex.attrs(ui.p, ui.muted, ui.small, s.gap)} data-perf="partly-drawn">
          Partly drawn: <DrawnLine n={n} />
        </p>
      </Show>
      <Show
        when={!outside && n.change !== "unchanged"}
        fallback={
          <Show when={newLines() > 0}>
            <p {...stylex.attrs(ui.p, ui.muted, s.gap)}>
              {outside ? `${newLines()} of its connections are new or changed in this PR.` : `Its own code didn't change in this PR; ${newLines()} of its connections are new or changed.`}
            </p>
          </Show>
        }
      >
        <p {...stylex.attrs(ui.p, s.gap)} data-perf="change">
          <ChangeWord change={n.change} />
          <Show when={n.changeSummary}>{(t) => <>: {t()}</>}</Show>
        </p>
      </Show>
      <Show when={n.paths.length > 0}>
        <div {...stylex.attrs(ui.row, s.gap)}>
          <For each={n.paths}>
            {(p) => (
              <a href={githubTree(m().g.repo, sha(), p)} target="_blank" rel="noreferrer external" {...stylex.attrs(ui.link, ui.mono)}>
                {p}
              </a>
            )}
          </For>
        </div>
      </Show>

      <Questions m={m()} qs={n.questions} />

      <Show when={n.responsibilities.length > 0}>
        <H3>What it does</H3>
        <ul {...stylex.attrs(ui.list)} data-perf="responsibilities">
          <For each={n.responsibilities}>
            {(r) => {
              const users = () => m().usersOf(n.id, r.id);
              return (
                <li data-perf="responsibility">
                  <Fold
                    nested
                    summary={
                      <>
                        <Mark change={r.change} /> {r.text}{" "}
                        <Show when={users().length > 0}>
                          <span {...stylex.attrs(ui.muted, ui.small)} data-perf="used-by">
                            · used by {users().length} {users().length === 1 ? "part" : "parts"}
                          </span>
                        </Show>
                      </>
                    }
                  >
                    <Show when={users().length > 0}>
                      <p {...stylex.attrs(ui.p, ui.small)}>
                        <span {...stylex.attrs(ui.muted)}>Used by </span>
                        <For each={users()}>
                          {(u, i) => (
                            <>
                              {i() > 0 ? ", " : ""}
                              <Pick to={part(u)} accent>
                                {m().name(u)}
                              </Pick>
                            </>
                          )}
                        </For>
                      </p>
                    </Show>
                    <ClaimList m={m()} ids={r.claims} />
                  </Fold>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <Show when={n.facets.length > 0 || (n.built ?? []).length > 0}>
        <H3>How it's built</H3>
        <Facets m={m()} list={n.facets} />
        <For each={n.built ?? []}>
          {(b) => (
            <Fold
              nested
              summary={
                <>
                  <span {...stylex.attrs(ui.muted)}>{b.kind}: </span>
                  {b.text}
                </>
              }
            >
              <ClaimList m={m()} ids={b.claims} />
            </Fold>
          )}
        </For>
      </Show>

      <Show when={conn().out.length + conn().into.length > 0}>
        <H3>Connections ({conn().out.length + conn().into.length})</H3>
        <Lines edges={conn().out} from={n.id} />
        <Lines edges={conn().into} from={n.id} />
      </Show>

      <Show when={files().length > 0}>
        <H3>Files ({files().length})</H3>
        {/* One grid for the whole list, so the counts line up in their own columns. */}
        <div {...stylex.attrs(s.files)} data-perf="files">
          <For each={files()}>
            {(f) => (
              <>
                <span {...stylex.attrs(s.count, f.added > 0 ? changeText.added : s.zero)}>+{f.added.toLocaleString("en")}</span>
                <span {...stylex.attrs(s.count, f.removed > 0 ? changeText.removed : s.zero)}>−{f.removed.toLocaleString("en")}</span>
                <span {...stylex.attrs(s.fileCell)} data-perf="file">
                  <a
                    href={githubBlob(m().g.repo, f.status === "removed" ? m().g.mergeBase : m().g.headSha, f.path)}
                    target="_blank"
                    rel="noreferrer external"
                    {...stylex.attrs(ui.link, ui.mono)}
                  >
                    {f.path}
                  </a>
                  <Show when={f.status !== "modified"}>
                    <span {...stylex.attrs(ui.muted)}> ({f.status === "added" ? "new" : f.status === "removed" ? "deleted" : "renamed"})</span>
                  </Show>
                  <Show when={f.generated}>
                    <span {...stylex.attrs(ui.muted)}> (generated)</span>
                  </Show>
                  <Show when={f.summary}>{(t) => <span {...stylex.attrs(s.fileSummary)}>{t()}</span>}</Show>
                </span>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A part's lines, each a pick: the other end, its label, what it crosses; hidden ones faded. */
function Lines(props: { edges: Edge[]; from: string }) {
  const nav = useNav();
  const m = () => nav.model();
  const lines = () => parseLines(nav.state().lines);
  return (
    <ul {...stylex.attrs(ui.list, s.lines)}>
      <For each={props.edges}>
        {(e) => {
          // A block body: StyleX evaluates an expression-bodied arrow read inside `attrs`.
          const hidden = () => {
            return hiddenBy(e, lines());
          };
          const out = m().within(e.from, props.from);
          return (
            <li {...stylex.attrs(ui.item, hidden() !== undefined && ui.faded)} data-perf="connection" data-hidden={hidden() ? "" : undefined}>
              <Mark change={e.change} />
              <span>
                <Pick to={line(e.id)}>
                  {out ? "→ " : "← "}
                  {m().name(out ? e.to : e.from)}: {e.label}
                </Pick>
                <Show when={e.boundaries.length > 0}>
                  <span {...stylex.attrs(ui.muted)}> ⟂ {e.boundaries.map((b) => m().boundaries.get(b)?.name ?? b).join(", ")}</span>
                </Show>
                <Show when={hidden()}>{(h) => <span {...stylex.attrs(ui.muted, ui.small)}> ({h()})</span>}</Show>
              </span>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

function Questions(props: { m: Model; qs: Question[] }) {
  return (
    <Show when={props.qs.length > 0}>
      <H3>Questions</H3>
      <ul {...stylex.attrs(ui.list)} data-perf="questions">
        <For each={props.qs}>
          {(q) => (
            <li data-perf="question">
              <Fold nested summary={q.question}>
                <p {...stylex.attrs(ui.p)} data-perf="answer">
                  {q.answer}
                </p>
                <Show when={q.claims.length > 0}>
                  <span {...stylex.attrs(ui.muted, ui.small)}>{claimCount(props.m, q.claims)}</span>
                </Show>
                <ClaimList m={props.m} ids={q.claims} />
              </Fold>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** Facet assignments in words, each value with its claims. */
function Facets(props: { m: Model; list: FacetAssignment[] }) {
  return (
    <ul {...stylex.attrs(ui.list)} data-perf="facets">
      <For each={props.list}>
        {(f) => {
          const def = props.m.facets.get(f.facet);
          const label = (v: string) => def?.values.find((x) => x.id === v)?.label ?? v;
          return (
            <li>
              <Fold
                nested
                summary={
                  <>
                    <span {...stylex.attrs(ui.muted)}>{def?.name ?? f.facet}: </span>
                    {f.values.map((v) => label(v.value)).join(", ")}
                    <Show when={f.was}>{(was) => <span {...stylex.attrs(changeText.modified)}> (was {was().map(label).join(", ")})</span>}</Show>
                  </>
                }
              >
                <For each={f.values}>
                  {(v) => (
                    <div {...stylex.attrs(ui.stack)}>
                      <span {...stylex.attrs(ui.small, ui.muted)}>{label(v.value)}</span>
                      <ClaimList m={props.m} ids={v.claims} />
                    </div>
                  )}
                </For>
              </Fold>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

// ---- A line ------------------------------------------------------------------------------------

const DIRECTION = { forward: "from the caller to the callee", back: "back to the caller", both: "both ways" } as const;
const WHEN = { runtime: "at run time", build: "at build time", test: "in tests" } as const;

function LinePanel(props: { edges: Edge[] }) {
  return (
    <div data-perf="line-panel">
      <Show when={props.edges.length > 1}>
        <p {...stylex.attrs(ui.p, ui.muted, s.gap)}>{props.edges.length} connections, selected together</p>
      </Show>
      <For each={props.edges}>{(e) => <LineDetail e={e} />}</For>
    </div>
  );
}

function LineDetail(props: { e: Edge }) {
  const nav = useNav();
  const m = () => nav.model();
  const e = props.e;
  const hidden = () => hiddenBy(e, parseLines(nav.state().lines));
  const uses = () => {
    if (e.uses === undefined) return undefined;
    const queue = [e.to];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const r = m().nodes.get(id)?.responsibilities.find((x) => x.id === e.uses);
      if (r) return { node: id, text: r.text };
      queue.push(...(m().children.get(id) ?? []).map((c) => c.id));
    }
    return undefined;
  };
  return (
    <section {...stylex.attrs(s.connection)} data-perf="line" data-id={e.id}>
      <p {...stylex.attrs(ui.p, ui.muted)}>
        {e.kind} · {WHEN[e.when]} · {e.mode}
        <Show when={hidden()}>{(h) => <> · {h()}</>}</Show>
      </p>
      <h2 {...stylex.attrs(ui.h2)}>
        <Pick to={part(e.from)} accent>
          {m().name(e.from)}
        </Pick>
        {" → "}
        <Pick to={part(e.to)} accent>
          {m().name(e.to)}
        </Pick>
      </h2>
      <p {...stylex.attrs(ui.p, s.gap)}>{e.label}</p>
      <p {...stylex.attrs(ui.p, s.gap)} data-perf="change">
        <ChangeWord change={e.change} />
      </p>
      <dl {...stylex.attrs(s.props)}>
        <Show when={e.data}>
          {(d) => (
            <>
              <dt {...stylex.attrs(s.key)}>Carries</dt>
              <dd {...stylex.attrs(s.value)} data-perf="carries">
                {d().what}, {DIRECTION[d().direction]}
              </dd>
            </>
          )}
        </Show>
        <Show when={uses()}>
          {(u) => (
            <>
              <dt {...stylex.attrs(s.key)}>Uses</dt>
              <dd {...stylex.attrs(s.value)}>
                {u().text} <span {...stylex.attrs(ui.muted)}>of {m().name(u().node)}</span>
              </dd>
            </>
          )}
        </Show>
        <dt {...stylex.attrs(s.key)}>When</dt>
        <dd {...stylex.attrs(s.value)} data-perf="when">
          {WHEN[e.when]}
          {e.occurs ? `: ${e.occurs}` : ""}
        </dd>
        <dt {...stylex.attrs(s.key)}>Mode</dt>
        <dd {...stylex.attrs(s.value)}>{e.mode === "n/a" ? "not a call" : e.mode === "sync" ? "synchronous" : "asynchronous"}</dd>
        <Show when={e.boundaries.length > 0}>
          <dt {...stylex.attrs(s.key)}>Crosses</dt>
          <dd {...stylex.attrs(s.value)} data-perf="crosses">
            <For each={e.boundaries}>
              {(b, i) => {
                const x = m().boundaries.get(b);
                return (
                  <>
                    {i() > 0 ? ", " : ""}
                    <Pick to={{ kind: "boundary", id: b }} accent perf="boundary-pick">
                      {x ? `${x.name} (${x.kind})` : b}
                    </Pick>
                  </>
                );
              }}
            </For>
          </dd>
        </Show>
      </dl>
      <Questions m={m()} qs={e.questions} />
      <Show when={e.facets.length > 0}>
        <H3>How it's built</H3>
        <Facets m={m()} list={e.facets} />
      </Show>
      <H3>Evidence</H3>
      <Show when={e.claims.length > 0} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>None.</p>}>
        <span {...stylex.attrs(ui.muted, ui.small)}>{claimCount(m(), e.claims)}</span>
        <ClaimList m={m()} ids={e.claims} />
      </Show>
    </section>
  );
}

// ---- A step ------------------------------------------------------------------------------------

function StepPanel(props: { scenario: string; n: number }) {
  const nav = useNav();
  const m = () => nav.model();
  const sc = () => m().scenarios.get(props.scenario)!;
  const st = () => sc().steps[props.n - 1]!;
  const step = (n: number): Sel => ({ kind: "step", scenario: props.scenario, n });
  const chapterAt = (i: number) => sc().chapters.find((c) => c.from === i);
  return (
    <div data-perf="step-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>
        {sc().title} · step {props.n} of {sc().steps.length}
      </p>
      <div {...stylex.attrs(ui.row, s.gap)}>
        <button type="button" {...stylex.attrs(ui.button)} disabled={props.n <= 1} onClick={() => nav.select(step(props.n - 1))}>
          ← Previous
        </button>
        <button type="button" {...stylex.attrs(ui.button)} disabled={props.n >= sc().steps.length} onClick={() => nav.select(step(props.n + 1))}>
          Next →
        </button>
      </div>
      <h2 {...stylex.attrs(ui.h2, s.gap)}>{st().action}</h2>
      <p {...stylex.attrs(ui.p, s.gap)}>
        <Pick to={part(st().from)} accent>
          {m().name(st().from)}
        </Pick>
        {" → "}
        <Pick to={part(st().to)} accent>
          {m().name(st().to)}
        </Pick>
      </p>
      <Show when={st().data}>{(d) => <p {...stylex.attrs(ui.p, s.gap)}>Carries: {d()}</p>}</Show>
      <p {...stylex.attrs(ui.p, s.gap)}>
        <ChangeWord change={st().change} />
      </p>
      <Show when={st().edge}>
        {(e) => (
          <div {...stylex.attrs(ui.row, s.gap)}>
            <button type="button" {...stylex.attrs(ui.button)} onClick={() => nav.select(line(e()))}>
              The line it travels
            </button>
          </div>
        )}
      </Show>
      <H3>Evidence</H3>
      <ClaimList m={m()} ids={st().claims} />
      <H3>The whole flow</H3>
      <p {...stylex.attrs(ui.p, ui.muted)}>Starts when {sc().trigger}.</p>
      <ol {...stylex.attrs(s.flow)} data-perf="flow">
        <For each={sc().steps}>
          {(x, i) => (
            <>
              <Show when={chapterAt(i())}>{(c) => <li {...stylex.attrs(s.chapter)}>{c().title}</li>}</Show>
              <li {...stylex.attrs(ui.item)} aria-current={i() + 1 === props.n ? "step" : undefined}>
                <span {...stylex.attrs(ui.muted, s.stepNo)}>{i() + 1}.</span>
                <Mark change={x.change} />
                <button type="button" {...stylex.attrs(ui.pick, i() + 1 === props.n && s.current)} onClick={() => nav.select(step(i() + 1))}>
                  {m().name(x.from)} → {m().name(x.to)}: {x.action}
                </button>
              </li>
            </>
          )}
        </For>
      </ol>
    </div>
  );
}

// ---- What slice 9 builds on: a purpose, a conflict, the unclaimed parts ------------------------

function PurposePanel(props: { id: string }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => m().purposes.get(props.id)!;
  return (
    <div data-perf="purpose-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>Purpose · {p().kind}</p>
      <h2 {...stylex.attrs(ui.h2)}>{p().name}</h2>
      <H3>Parts that serve it ({p().serves.length})</H3>
      <ul {...stylex.attrs(ui.list)}>
        <For each={p().serves}>
          {(x) => (
            <li>
              <Fold
                nested
                summary={
                  <>
                    <Pick to={part(x.node)} accent>
                      {m().name(x.node)}
                    </Pick>
                    : {x.role}
                  </>
                }
              >
                <ClaimList m={m()} ids={x.claims} />
              </Fold>
            </li>
          )}
        </For>
      </ul>
      <Show when={p().carries.length > 0}>
        <H3>Lines its flow passes along ({p().carries.length})</H3>
        <ul {...stylex.attrs(ui.list)}>
          <For each={p().carries}>
            {(x) => {
              const e = m().edges.get(x.edge);
              return (
                <li>
                  <Pick to={line(x.edge)} accent>
                    {e ? `${m().name(e.from)} → ${m().name(e.to)}` : x.edge}
                  </Pick>
                  : {x.why}
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** A split purpose's halves, selected together. */
function PurposesPanel(props: { ids: string[] }) {
  const nav = useNav();
  const m = () => nav.model();
  return (
    <div data-perf="purposes-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>{props.ids.length} purposes, selected together</p>
      <ul {...stylex.attrs(ui.list, s.gap)}>
        <For each={props.ids}>
          {(id) => (
            <li {...stylex.attrs(ui.stack)}>
              <Pick to={{ kind: "purpose", ids: [id] }} accent>
                {m().purposes.get(id)!.name}
              </Pick>
              <span {...stylex.attrs(ui.p, ui.muted)}>
                {m().purposes.get(id)!.kind} · serves {m().purposes.get(id)!.serves.length} parts
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function ConflictPanel(props: { id: string }) {
  const nav = useNav();
  const m = () => nav.model();
  const c = () => m().conflicts.get(props.id)!;
  return (
    <div data-perf="conflict-panel">
      <p {...stylex.attrs(ui.p, ui.muted)}>Conflict · {c().kind}</p>
      <h2 {...stylex.attrs(ui.h2)}>{c().question}</h2>
      <For each={[c().a, c().b]}>
        {(side) => (
          <section {...stylex.attrs(s.side)}>
            <p {...stylex.attrs(ui.p)}>
              <span {...stylex.attrs(ui.muted)}>{side.who === "purpose" && side.purpose ? m().purposes.get(side.purpose)?.name ?? side.purpose : side.who}: </span>
              <b>{side.says}</b>
            </p>
            <p {...stylex.attrs(ui.p, ui.small)}>{side.text}</p>
            <ClaimList m={m()} ids={side.claims} />
          </section>
        )}
      </For>
    </div>
  );
}

// ---- A group -----------------------------------------------------------------------------------

function GroupPanel(props: { id: string }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const g = () => c.scene().groups.get(props.id);
  return (
    <div data-perf="group-panel" data-id={props.id}>
      <Show
        when={g()}
        fallback={
          <>
            <p {...stylex.attrs(ui.p, ui.muted)}>Group</p>
            <p {...stylex.attrs(ui.p, s.gap)}>This group isn't drawn with the canvas's current Boxes and lens.</p>
          </>
        }
      >
        {(gr) => {
          const members = () => gr().members.map((id) => m().nodes.get(id)).filter((n): n is Node => n !== undefined);
          const changed = () => members().filter((n) => touched(m(), n.id) && n.kind !== "actor" && n.kind !== "external" && n.kind !== "store").length;
          const what = () => {
            const x = gr();
            if (x.kind === "column") return COLUMN_WHAT[x.column];
            if (x.kind === "shared") return `Parts with several values of ${x.by}, in one box rather than in each value's.`;
            if (x.facet === undefined) return `Parts whose paths share the folder ${x.value}.`;
            return `Parts whose ${x.by} is ${x.title}.`;
          };
          // Lines to other blocks, by neighbour: the drawn block holding each line's other end.
          const neighbours = createMemo(() => {
            const sc = c.scene();
            const inside = new Set<string>();
            for (const top of gr().members) for (const x of m().subtree(top)) inside.add(x);
            const by = new Map<string, { out: string[]; into: string[] }>();
            for (const e of sc.edges) {
              const a = inside.has(e.from), b = inside.has(e.to);
              if (a === b) continue;
              const other = a ? e.to : e.from;
              const h = sc.holder(other) ?? other;
              const row = by.get(h) ?? { out: [], into: [] };
              (a ? row.out : row.into).push(e.id);
              by.set(h, row);
            }
            return [...by].map(([id, r]) => ({ id, name: sc.groups.get(id)?.title ?? m().name(id), ...r })).sort((x, y) => y.out.length + y.into.length - (x.out.length + x.into.length));
          });
          return (
            <>
              <p {...stylex.attrs(ui.p, ui.muted)}>{gr().kind === "column" ? "Column" : gr().kind === "shared" ? `Shared box · ${gr().by}` : `Box · grouped by ${gr().by}`}</p>
              <h2 {...stylex.attrs(ui.h2)}>{gr().title}</h2>
              <p {...stylex.attrs(ui.p, s.gap)}>{what()}</p>
              <p {...stylex.attrs(ui.p, ui.muted, s.gap)} data-perf="group-counts">
                {members().length} {members().length === 1 ? "part" : "parts"} · {changed()} changed
              </p>
              <H3>Lines to other blocks</H3>
              <Show when={neighbours().length > 0} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>None in this lens.</p>}>
                <ul {...stylex.attrs(ui.list)} data-perf="group-neighbours">
                  <For each={neighbours()}>
                    {(r) => (
                      <li {...stylex.attrs(ui.item)} data-perf="group-neighbour">
                        <Pick to={{ kind: "line", ids: [...r.out, ...r.into] }}>{r.name}</Pick>
                        <span {...stylex.attrs(ui.muted, ui.small)}>
                          {[r.out.length ? `${r.out.length} out` : "", r.into.length ? `${r.into.length} in` : ""].filter(Boolean).join(" · ")}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <H3>{gr().kind === "column" ? "Its parts" : "Its parts, and why each is here"}</H3>
              <ul {...stylex.attrs(ui.list)} data-perf="group-members">
                <For each={members()}>
                  {(n) => (
                    <li data-perf="group-member" data-id={n.id}>
                      <div {...stylex.attrs(ui.item)}>
                        <Mark change={n.change} />
                        <Pick to={part(n.id)} accent>
                          {n.name}
                        </Pick>
                      </div>
                      <Show when={gr().kind !== "column"}>
                        <Show when={gr().facet} fallback={<p {...stylex.attrs(ui.p, ui.muted, ui.small)}>Its paths: {n.paths.join(", ")}</p>}>
                          {(f) => <Facets m={m()} list={n.facets.filter((x) => x.facet === f())} />}
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </>
          );
        }}
      </Show>
    </div>
  );
}

const COLUMN_WHAT: Record<string, string> = {
  people: "People and callers that reach the system: they never change, and their lines carry the change.",
  changed: "Parts whose own code changed in this PR, or a part inside them did.",
  unchanged: "Parts this PR leaves alone: their code and everything inside them is as it was.",
  outside: "External systems and stores the system talks to. The PR never changes them; their lines carry the change.",
};

// ---- A boundary --------------------------------------------------------------------------------

function BoundaryPanel(props: { id: string }) {
  const nav = useNav();
  const m = () => nav.model();
  const b = () => m().boundaries.get(props.id);
  const crossing = () => m().a.edges.filter((e) => e.boundaries.includes(props.id));
  return (
    <div data-perf="boundary-panel" data-id={props.id}>
      <Show when={b()} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>This boundary isn't in this analysis.</p>}>
        {(x) => (
          <>
            <p {...stylex.attrs(ui.p, ui.muted)}>Boundary · {x().kind}</p>
            <h2 {...stylex.attrs(ui.h2)}>{x().name}</h2>
            <H3>Evidence</H3>
            <Show when={x().claims.length > 0} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>None.</p>}>
              <span {...stylex.attrs(ui.muted, ui.small)}>{claimCount(m(), x().claims)}</span>
              <ClaimList m={m()} ids={x().claims} />
            </Show>
            <H3>What crosses it ({crossing().length})</H3>
            <ul {...stylex.attrs(ui.list)} data-perf="boundary-crossing">
              <For each={crossing()}>
                {(e) => (
                  <li {...stylex.attrs(ui.item)} data-perf="crossing">
                    <Mark change={e.change} />
                    <Pick to={line(e.id)}>
                      {m().name(e.from)} → {m().name(e.to)}: {e.label}
                    </Pick>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </div>
  );
}

function UnclaimedPanel() {
  const nav = useNav();
  const m = () => nav.model();
  return (
    <div data-perf="unclaimed-panel">
      <h2 {...stylex.attrs(ui.h2)}>
        {m().a.unclaimed.length} changed {m().a.unclaimed.length === 1 ? "part serves" : "parts serve"} no purpose
      </h2>
      <ul {...stylex.attrs(ui.list, s.gap)}>
        <For each={m().a.unclaimed}>
          {(u) => (
            <li>
              <Pick to={part(u.node)} accent>
                {m().name(u.node)}
              </Pick>
              : <span {...stylex.attrs(ui.muted)}>{u.reason}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

const s = stylex.create({
  panel: { padding: 16, fontSize: 13 },
  forward: { gap: 8, alignItems: "flex-start", display: "flex", justifyContent: "space-between", marginBottom: 12 },
  gap: { marginTop: 6 },
  rule: { marginBottom: 4 },
  description: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: colors.bgRaised,
    lineHeight: 1.5,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  lines: { marginBottom: 6 },
  connection: {
    borderBottomColor: colors.line,
    borderBottomStyle: { default: "solid", ":last-child": "none" },
    borderBottomWidth: 1,
    marginBottom: 16,
    paddingBottom: 16,
  },
  props: { margin: 0, gap: "4px 12px", display: "grid", gridTemplateColumns: "max-content 1fr", marginTop: 10, },
  key: { color: colors.muted },
  value: { margin: 0, overflowWrap: "anywhere" },
  files: { gap: "2px 10px", display: "grid", fontSize: 12, gridTemplateColumns: "max-content max-content 1fr", },
  count: { fontVariantNumeric: "tabular-nums", textAlign: "end" },
  zero: { color: colors.muted },
  fileCell: { overflowWrap: "anywhere", minWidth: 0, },
  fileSummary: { color: colors.muted, display: "block" },
  flow: { margin: 0, padding: 0, gap: 3, listStyle: "none", display: "flex", flexDirection: "column" },
  chapter: { color: colors.muted, fontSize: 11, fontWeight: 650, marginTop: 6 },
  stepNo: { fontVariantNumeric: "tabular-nums", textAlign: "end", minWidth: 20 },
  current: { fontWeight: 650 },
  side: {
    padding: 10,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 6,
    display: "flex",
    flexDirection: "column",
    marginTop: 10,
  },
});
