// The panel's walkthrough (#183, layout A "Reader" of #159): at the whole PR (nothing selected), a
// purpose or sub-purpose, a part, a line and the unclaimed parts, the panel reads as a walk
// through the PR's purposes. A step, a boundary and a group keep their reference panels.
//
// - Top, everywhere: a trail back up (the PR › purpose › sub-purpose, or the part's parents), a
//   kind line ("The whole PR · 4 purposes", "Purpose · feature", "Sub-purpose · process",
//   "Part · 2 purposes" counting top-level purposes, "Connection") and the title, a purpose's
//   with its dot.
// - The walk: intro, journey and destination as one paragraph, its source chips at the end, one
//   per kind (`PR`, `#N`, `code ×n`, counted from the graph's stubs before the claims arrive),
//   then "Stated, not found in code" when a claim behind it rests only on what the description
//   or an issue says (hovering or focusing it says so). A chip opens its sources under the
//   paragraph. A part or line with no written walk gets one built from the code view's
//   one-liners, and says so.
// - Then, by place: a purpose's "Rules it sets"; a part's or line's "In this PR's purposes",
//   grouped by top-level purpose; a line's What flows, When and Needed by; a part's "How it's
//   built" and "What it now does"; the next level, numbered ("Its purposes, in order", "The
//   journey", "Inside it", "The connections"), each row lighting what it names on the canvas
//   while hovered and standing on it when clicked; at the PR, "N changed parts serve no purpose
//   ›"; Conflicts (n); and the reference folded at the end ("All changes, by kind" at the PR,
//   "Questions, facets, files and evidence" elsewhere).
// - The fallback: with `unbacked`, its sentence leads the PR's panel, "All changes, by kind"
//   unfolded under it.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, type Element } from "solid-js";
import type { BuiltKind, Edge, Node, Purpose, Rule, Walk } from "../bindings/analysis";
import { colors } from "../tokens.stylex";
import { useCanvas } from "./canvas/store";
import { ClaimList, SourceBox } from "./claims";
import { Conflicts } from "./Conflicts";
import type { Model } from "./model";
import { line, part, useNav } from "./nav";
import { issueLabel, lineWalk, partWalk, purposesOf, sourcesOf, type Purposes, type Role, type Walked } from "./purposes";
import { PurposeDot } from "./PurposeDot";
import type { Sel } from "./state";
import { Fold, Mark, ui } from "./ui";

/** A crumb of the trail: what it names and where it goes (none: here). */
interface Crumb {
  label: string;
  to?: Sel | "pr";
  purpose?: string;
}

/** The top of every place: the trail, the kind line and the title. */
function Top(props: { trail: Crumb[]; kind: string; title: Element; purpose?: string }) {
  const nav = useNav();
  return (
    <header {...stylex.attrs(s.top)} data-perf="walk-top">
      <nav {...stylex.attrs(s.trail)} aria-label="Where you are" data-perf="walk-trail">
        <For each={props.trail}>
          {(t, i) => (
            <>
              <Show when={i() > 0}>
                <span {...stylex.attrs(ui.muted)} aria-hidden="true">
                  {" › "}
                </span>
              </Show>
              <Show
                when={t.to}
                fallback={
                  <span {...stylex.attrs(s.here)} aria-current="location">
                    <Show when={t.purpose}>{(id) => <PurposeDot id={id()} />}</Show>
                    {t.label}
                  </span>
                }
              >
                {(to) => (
                  <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} data-perf="crumb" onClick={() => nav.select(to() === "pr" ? undefined : (to() as Sel))}>
                    <Show when={t.purpose}>{(id) => <PurposeDot id={id()} />}</Show>
                    {t.label}
                  </button>
                )}
              </Show>
            </>
          )}
        </For>
      </nav>
      <p {...stylex.attrs(ui.p, ui.muted, ui.small)} data-perf="walk-kind">
        {props.kind}
      </p>
      <h2 {...stylex.attrs(ui.h2)} data-perf="walk-title">
        <Show when={props.purpose}>{(id) => <PurposeDot id={id()} big />}</Show>
        {props.title}
      </h2>
    </header>
  );
}

/** The PR's own crumb, first in every trail. */
const prCrumb = (m: Model, here: boolean): Crumb => ({ label: `#${m.a.pr.number}`, to: here ? undefined : "pr" });

/** A walk's paragraph, its chips, "Stated, not found in code", and the chip opened under it. */
export function WalkText(props: { walked: Walked }) {
  const nav = useNav();
  const m = () => nav.model();
  const w = (): Walk => props.walked.walk;
  const src = () => sourcesOf(m(), w().claims);
  const [open, setOpen] = createSignal<string>();
  const [why, setWhy] = createSignal(false);
  const toggle = (k: string) => setOpen(open() === k ? undefined : k);
  const chip = (k: string, label: string) => (
    <button type="button" {...stylex.attrs(s.chip, open() === k && s.chipOn)} aria-expanded={open() === k ? "true" : "false"} data-perf="source-chip" data-chip={k} onClick={() => toggle(k)}>
      {label}
    </button>
  );
  return (
    <div {...stylex.attrs(s.walk)} data-perf="walk">
      <p {...stylex.attrs(s.para)} data-perf="walk-text">
        {w().intro} {w().journey} {w().destination}{" "}
        <Show when={src().description > 0}>{chip("description", "PR")} </Show>
        <For each={src().issues}>{(x) => <>{chip(`issue:${x.ref}`, issueLabel(m(), x.ref))} </>}</For>
        <Show when={src().unnamedIssues > 0}>{chip("issue", src().unnamedIssues === 1 ? "issue" : `issue ×${src().unnamedIssues}`)} </Show>
        <Show when={src().code > 0}>{chip("code", src().code === 1 ? "code" : `code ×${src().code}`)}</Show>
        <Show when={src().stated}>
          {" "}
          <span
            {...stylex.attrs(s.stated)}
            tabindex="0"
            aria-describedby="walk-stated-why"
            data-perf="stated"
            onPointerEnter={() => setWhy(true)}
            onPointerLeave={() => setWhy(false)}
            onFocus={() => setWhy(true)}
            onBlur={() => setWhy(false)}
          >
            Stated, not found in code
          </span>
        </Show>
      </p>
      <Show when={src().stated}>
        <p id="walk-stated-why" {...stylex.attrs(ui.p, ui.small, ui.muted, !why() && s.hidden)} data-perf="stated-why" role="note">
          The description or an issue says so; the analysis found no code that shows it.
        </p>
      </Show>
      <Show when={props.walked.built}>
        <p {...stylex.attrs(ui.p, ui.small, ui.muted)} data-perf="walk-built">
          No walkthrough was written for this; it's built from the code view's one-liners.
        </p>
      </Show>
      <Show when={open()} keyed>
        {(k) => (
          <SourceBox
            m={m()}
            ids={w().claims}
            kind={k === "description" ? "description" : k === "code" ? "code" : "issue"}
            issue={k.startsWith("issue:") ? k.slice("issue:".length) : undefined}
          />
        )}
      </Show>
    </div>
  );
}

/** A heading of the walkthrough. */
function H3(props: { children: Element }) {
  return <h3 {...stylex.attrs(ui.h3)}>{props.children}</h3>;
}

/** One row of the next level: a number, a name and one line; hovering lights it, a click stands on it. */
export interface Next {
  to: Sel;
  name: Element;
  line: string;
  light: { nodes: string[]; edges: string[] };
  purpose?: string;
}

function NextList(props: { title: string; rows: Next[]; note?: string }) {
  const nav = useNav();
  const c = useCanvas();
  return (
    <Show when={props.rows.length > 0}>
      <section data-perf="walk-next">
        <H3>{props.title}</H3>
        <Show when={props.note}>{(n) => <p {...stylex.attrs(ui.p, ui.small, ui.muted, s.note)}>{n()}</p>}</Show>
        <ol {...stylex.attrs(s.next)}>
          <For each={props.rows}>
            {(r, i) => (
              <li>
                <button
                  type="button"
                  {...stylex.attrs(s.stop)}
                  data-perf="next-row"
                  onClick={() => {
                    c.light(undefined);
                    nav.select(r.to);
                  }}
                  onPointerEnter={() => c.light(r.light)}
                  onPointerLeave={() => c.light(undefined)}
                  onFocus={() => c.light(r.light)}
                  onBlur={() => c.light(undefined)}
                >
                  <span {...stylex.attrs(s.num)}>{i() + 1}</span>
                  <span {...stylex.attrs(s.stopBody)}>
                    <span {...stylex.attrs(s.stopName)}>
                      <Show when={r.purpose}>{(id) => <PurposeDot id={id()} />}</Show>
                      {r.name}
                    </span>
                    <span {...stylex.attrs(ui.muted, ui.small)}>{r.line}</span>
                  </span>
                  <span {...stylex.attrs(ui.muted)} aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}

/** What a purpose lights on the canvas: its parts and its lines (its sub-purposes' too). */
const purposeLight = (p: Purposes, id: string) => ({ nodes: [...p.members({ kind: "purpose", id })], edges: [...p.carries({ kind: "purpose", id })] });

/** A purpose as a row of the next level. */
const purposeRow = (p: Purposes, q: Purpose): Next => ({ to: { kind: "purpose", ids: [q.id] }, name: q.name, line: q.walk.intro, light: purposeLight(p, q.id), purpose: q.id });

/** A part as a row. */
const partRow = (m: Model, id: string, text: string): Next => ({ to: part(id), name: m.name(id), line: text, light: { nodes: [id], edges: [] } });

/** A line as a row. */
const lineRow = (m: Model, e: Edge, text: string): Next => ({ to: line(e.id), name: `${m.name(e.from)} → ${m.name(e.to)}`, line: text, light: { nodes: [e.from, e.to], edges: [e.id] } });

/** The folded reference at the end of a place. */
function Reference(props: { title: string; children: Element; open?: boolean }) {
  return (
    <section {...stylex.attrs(s.reference)} data-perf="walk-reference">
      <Fold summary={<span {...stylex.attrs(s.referenceTitle)}>{props.title}</span>} open={props.open} perf="reference">
        {props.children}
      </Fold>
    </section>
  );
}

// ---- The PR ------------------------------------------------------------------------------------

export function PrWalk(props: { reference: Element }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const n = () => p().tops.length;
  const unclaimed = () => m().a.unclaimed.length;
  return (
    <div data-perf="walk-pr">
      <Top trail={[prCrumb(m(), true)]} kind={n() ? `The whole PR · ${n()} ${n() === 1 ? "purpose" : "purposes"}` : "The whole PR · no purposes"} title={m().a.pr.title} />
      <Show
        when={m().a.unbacked}
        fallback={
          <>
            <WalkText walked={{ walk: m().a.walk, built: false }} />
            <NextList title="Its purposes, in order" rows={p().tops.map((q) => purposeRow(p(), q))} />
            <Show when={unclaimed() > 0}>
              <p {...stylex.attrs(ui.p, s.gap)}>
                <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} data-perf="to-unclaimed" onClick={() => nav.select({ kind: "unclaimed" })}>
                  {unclaimed()} changed {unclaimed() === 1 ? "part serves" : "parts serve"} no purpose ›
                </button>
              </p>
            </Show>
            <Conflicts list={p().conflictsAt({ kind: "pr" })} />
            <Reference title="All changes, by kind">{props.reference}</Reference>
          </>
        }
      >
        {(why) => (
          <>
            <p {...stylex.attrs(ui.note, s.gap)} data-perf="unbacked">
              {why()}
            </p>
            <Reference title="All changes, by kind" open>
              {props.reference}
            </Reference>
            <Conflicts list={p().conflictsAt({ kind: "pr" })} />
          </>
        )}
      </Show>
    </div>
  );
}

// ---- A purpose ---------------------------------------------------------------------------------

export function PurposeWalk(props: { id: string; reference: Element }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const q = () => p().byId.get(props.id)!;
  const sub = () => q().parent != null && p().byId.has(q().parent!);
  const trail = (): Crumb[] => [
    prCrumb(m(), false),
    ...p().ancestors(props.id).map((a) => ({ label: p().byId.get(a)!.name, to: { kind: "purpose", ids: [a] } as Sel, purpose: a })),
    { label: q().name, purpose: props.id },
  ];
  // The journey: its stops; without any written, its sub-purposes, then the parts that serve it.
  const stops = (): Next[] =>
    q().stops.flatMap((st): Next[] => {
      const sp = p().byId.get(st.ref);
      if (sp) return [{ ...purposeRow(p(), sp), line: st.line }];
      if (m().nodes.has(st.ref)) return [partRow(m(), st.ref, st.line)];
      const e = m().edges.get(st.ref);
      return e ? [lineRow(m(), e, st.line)] : [];
    });
  const fallback = (): Next[] => [...p().subs(props.id).map((sp) => purposeRow(p(), sp)), ...q().serves.filter((x) => m().nodes.has(x.node)).map((x) => partRow(m(), x.node, x.role))];
  return (
    <div data-perf="walk-purpose" data-id={props.id}>
      <Top trail={trail()} kind={`${sub() ? "Sub-purpose" : "Purpose"} · ${q().kind}`} title={q().name} purpose={props.id} />
      <WalkText walked={{ walk: q().walk, built: false }} />
      <Show when={(q().rules ?? []).length > 0}>
        <section data-perf="rules">
          <H3>Rules it sets</H3>
          <ul {...stylex.attrs(ui.list, s.rules)}>
            <For each={q().rules ?? []}>{(r) => <RuleRow r={r} />}</For>
          </ul>
        </section>
      </Show>
      <Show
        when={stops().length > 0}
        fallback={<NextList title="The journey" rows={fallback()} note="No journey was written for it: these are its sub-purposes, then the parts that serve it, each with its role." />}
      >
        <NextList title="The journey" rows={stops()} />
      </Show>
      <Conflicts list={p().conflictsAt({ kind: "purpose", id: props.id })} />
      <Reference title="Questions, facets, files and evidence">{props.reference}</Reference>
    </div>
  );
}

/** One rule: its text, its scope muted, and the result of its check; how it was checked folded under it. */
function RuleRow(props: { r: Rule }) {
  const nav = useNav();
  const m = () => nav.model();
  const ck = () => props.r.checked;
  const conflict = () => m().a.conflicts.find((c) => c.rule === props.r.id);
  return (
    <li {...stylex.attrs(s.rule)} data-perf="rule" data-id={props.r.id}>
      <p {...stylex.attrs(ui.p)}>
        {props.r.text} <span {...stylex.attrs(ui.muted, ui.small)}>· {props.r.scope}</span>
      </p>
      <p {...stylex.attrs(ui.p, ui.small)} data-perf="rule-result">
        <Show
          when={ck().breaks > 0}
          fallback={
            <span {...stylex.attrs(s.holds)}>
              Checked {ck().found} {ck().found === 1 ? "site" : "sites"}: {ck().holds === ck().found ? (ck().found === 1 ? "it holds" : "all hold") : `${ck().holds} hold`}
            </span>
          }
        >
          <span>
            Checked {ck().found} {ck().found === 1 ? "site" : "sites"}: {ck().holds} hold,{" "}
            <Show when={conflict()} fallback={<span {...stylex.attrs(s.breaks)}>{ck().breaks} break</span>}>
              {(c) => (
                <button type="button" {...stylex.attrs(ui.pick, s.breaks)} data-perf="rule-breaks" onClick={() => nav.select({ kind: "conflict", id: c().id })}>
                  {ck().breaks} break ›
                </button>
              )}
            </Show>
          </span>
        </Show>
        <Show when={ck().undetermined > 0}>
          <span {...stylex.attrs(ui.muted)}> · {ck().undetermined} not determined</span>
        </Show>
      </p>
      <Fold nested summary={<span {...stylex.attrs(ui.muted, ui.small)}>How it was checked</span>} perf="rule-how">
        <p {...stylex.attrs(ui.p, ui.small)} data-perf="rule-searched">
          {ck().searched}
        </p>
        <ClaimList m={m()} ids={props.r.sources} />
      </Fold>
    </li>
  );
}

// ---- A part and a line: "In this PR's purposes" ------------------------------------------------

/** Roles grouped by top-level purpose: one dot and its name, its own role, its sub-purposes' under it. */
function InPurposes(props: { roles: Role[] }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const groups = () => {
    const out: { top: string; roles: Role[] }[] = [];
    for (const r of props.roles) {
      const t = p().top(r.purpose);
      const g = out.find((x) => x.top === t);
      if (g) g.roles.push(r);
      else out.push({ top: t, roles: [r] });
    }
    return out;
  };
  const via = (r: Role) => (r.via ? <span {...stylex.attrs(ui.muted, ui.small)}> (through {m().nodes.get(r.via)?.name ?? r.via})</span> : null);
  return (
    <section data-perf="in-purposes">
      <H3>In this PR's purposes</H3>
      <Show when={props.roles.length > 0} fallback={<p {...stylex.attrs(ui.p, ui.muted)} data-perf="in-none">None: the PR's purposes don't pass through it.</p>}>
        <ul {...stylex.attrs(ui.list, s.roles)}>
          <For each={groups()}>
            {(g) => (
              <li
                {...stylex.attrs(s.role)}
                data-perf="in-purpose"
                data-id={g.top}
                onPointerEnter={() => c.light(purposeLight(p(), g.top))}
                onPointerLeave={() => c.light(undefined)}
              >
                <div>
                  <PurposeDot id={g.top} />
                  <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent, s.strong)} onClick={() => nav.select({ kind: "purpose", ids: [g.top] })}>
                    {p().byId.get(g.top)?.name ?? g.top}
                  </button>
                </div>
                <For each={g.roles.filter((r) => r.purpose === g.top)}>
                  {(r) => (
                    <p {...stylex.attrs(ui.p, s.roleLine)} data-perf="role">
                      {r.role}
                      {via(r)}
                    </p>
                  )}
                </For>
                <Show when={g.roles.some((r) => r.purpose !== g.top)}>
                  <ul {...stylex.attrs(ui.list, s.subRoles)}>
                    <For each={g.roles.filter((r) => r.purpose !== g.top)}>
                      {(r) => (
                        <li data-perf="sub-role" data-id={r.purpose}>
                          <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => nav.select({ kind: "purpose", ids: [r.purpose] })}>
                            {p().byId.get(r.purpose)?.name ?? r.purpose}
                          </button>
                          <p {...stylex.attrs(ui.p, s.roleLine)} data-perf="role">
                            {r.role}
                            {via(r)}
                          </p>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- A part ------------------------------------------------------------------------------------

const BUILT: Record<BuiltKind, string> = { decision: "Decision", constraint: "Constraint", assumption: "Assumption" };

export function PartWalk(props: { n: Node; reference: Element }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const n = props.n;
  const sys = () => m().system?.id;
  const trail = (): Crumb[] => [prCrumb(m(), false), ...[...m().ancestors(n.id)].reverse().filter((x) => x !== sys()).map((x) => ({ label: m().nodes.get(x)?.name ?? x, to: part(x) })), { label: n.name }];
  const tops = () => p().servedBy(n.id).length;
  const kids = () => m().children.get(n.id) ?? [];
  return (
    <div data-perf="walk-part" data-id={n.id}>
      <Top trail={trail()} kind={`Part · ${tops()} ${tops() === 1 ? "purpose" : "purposes"}`} title={n.name} />
      <WalkText walked={partWalk(p(), n)} />
      <InPurposes roles={p().roles(n.id)} />
      <Show when={(n.built ?? []).length > 0}>
        <section data-perf="built">
          <H3>How it's built</H3>
          <ul {...stylex.attrs(ui.list)}>
            <For each={n.built ?? []}>
              {(b) => (
                <li {...stylex.attrs(s.fact)} data-perf="built-row" data-kind={b.kind}>
                  <span {...stylex.attrs(s.factKey)}>{BUILT[b.kind]}</span>
                  <span>{b.text}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={n.changeSummary}>
        {(t) => (
          <section data-perf="now-does">
            <H3>What it now does</H3>
            <p {...stylex.attrs(ui.p)}>{t()}</p>
          </section>
        )}
      </Show>
      <NextList
        title="Inside it"
        rows={kids().map((k) => ({
          ...partRow(m(), k.id, k.changeSummary ?? k.summary),
          name: (
            <>
              <Mark change={k.change} /> {k.name}
            </>
          ),
        }))}
      />
      <Conflicts list={p().conflictsAt(part(n.id))} />
      <Reference title="Questions, facets, files and evidence">{props.reference}</Reference>
    </div>
  );
}

// ---- A line ------------------------------------------------------------------------------------

const WHEN = { runtime: "At run time", build: "At build time", test: "In tests" } as const;
const DIRECTION = { forward: "from the caller to the callee", back: "back to the caller", both: "both ways" } as const;

export function LineWalk(props: { edges: Edge[]; reference: Element }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const e = () => props.edges[0]!;
  const many = () => props.edges.length > 1;
  const title = () => (many() ? `${props.edges.length} connections` : `${m().name(e().from)} → ${m().name(e().to)}`);
  const ids = () => props.edges.map((x) => x.id);
  const sel = (): Sel => ({ kind: "line", ids: ids() });
  return (
    <div data-perf="walk-line">
      <Top trail={[prCrumb(m(), false), { label: many() ? title() : e().label }]} kind={many() ? `Connection · ${props.edges.length} lines` : "Connection"} title={title()} />
      <WalkText walked={lineWalk(m(), props.edges)} />
      <InPurposes roles={p().lineRoles(ids())} />
      <Show when={!many()}>
        <dl {...stylex.attrs(s.facts)} data-perf="line-facts">
          <dt {...stylex.attrs(s.factKey)}>What flows</dt>
          <dd {...stylex.attrs(s.factValue)} data-perf="line-flows">
            {e().data ? `${e().data!.what}, ${DIRECTION[e().data!.direction]}` : `Nothing crosses it as data: ${e().label}`}
          </dd>
          <dt {...stylex.attrs(s.factKey)}>When</dt>
          <dd {...stylex.attrs(s.factValue)} data-perf="line-when">
            {WHEN[e().when]}
            {e().occurs ? `: ${e().occurs}` : ""}
          </dd>
          <Show when={(e().neededBy ?? []).length > 0}>
            <dt {...stylex.attrs(s.factKey)}>Needed by</dt>
            <dd {...stylex.attrs(s.factValue)} data-perf="line-needed">
              <For each={e().neededBy ?? []}>
                {(d, i) => (
                  <>
                    {i() > 0 ? "; " : ""}
                    <Show
                      when={d.purpose != null && p().byId.has(d.purpose) ? d.purpose : undefined}
                      fallback={
                        <Show when={d.node != null && m().nodes.has(d.node) ? d.node : undefined} fallback={d.text}>
                          {(id) => (
                            <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => nav.select(part(id()))}>
                              {d.text}
                            </button>
                          )}
                        </Show>
                      }
                    >
                      {(id) => (
                        <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => nav.select({ kind: "purpose", ids: [id()] })}>
                          <PurposeDot id={id()} />
                          {d.text}
                        </button>
                      )}
                    </Show>
                  </>
                )}
              </For>
            </dd>
          </Show>
        </dl>
      </Show>
      <NextList title="The connections" rows={many() ? props.edges.map((x) => lineRow(m(), x, x.label)) : []} />
      <Conflicts list={p().conflictsAt(sel())} />
      <Reference title="Questions, facets, files and evidence">{props.reference}</Reference>
    </div>
  );
}

// ---- The unclaimed parts -----------------------------------------------------------------------

export function UnclaimedWalk() {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const n = () => m().a.unclaimed.length;
  const title = () => `${n()} changed ${n() === 1 ? "part serves" : "parts serve"} no purpose`;
  return (
    <div data-perf="unclaimed-panel">
      <Top trail={[prCrumb(m(), false), { label: "Unclaimed" }]} kind="Changed parts no purpose names" title={title()} />
      <p {...stylex.attrs(ui.p, s.gap)}>Each changed part no purpose passes through, with why.</p>
      <ol {...stylex.attrs(s.next, s.gap)}>
        <For each={m().a.unclaimed.filter((u) => m().nodes.has(u.node))}>
          {(u, i) => (
            <li>
              <button
                type="button"
                {...stylex.attrs(s.stop)}
                data-perf="unclaimed-row"
                data-id={u.node}
                onClick={() => nav.select(part(u.node))}
                onPointerEnter={() => c.light({ nodes: [u.node], edges: [] })}
                onPointerLeave={() => c.light(undefined)}
              >
                <span {...stylex.attrs(s.num)}>{i() + 1}</span>
                <span {...stylex.attrs(s.stopBody)}>
                  <span {...stylex.attrs(s.stopName)}>
                    <Mark change={m().nodes.get(u.node)!.change} /> {m().name(u.node)}
                  </span>
                  <span {...stylex.attrs(ui.muted, ui.small)} data-perf="unclaimed-reason">
                    {u.reason}
                  </span>
                </span>
                <span {...stylex.attrs(ui.muted)} aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          )}
        </For>
      </ol>
      <Conflicts list={p().conflictsAt({ kind: "unclaimed" })} />
    </div>
  );
}

// ---- A conflict (`sel=conflict:…`): its card, with the trail back -----------------------------

export function ConflictWalk(props: { id: string }) {
  const nav = useNav();
  const m = () => nav.model();
  const p = () => purposesOf(m());
  const k = () => m().conflicts.get(props.id);
  return (
    <div data-perf="conflict-panel">
      <Show when={k()} fallback={<p {...stylex.attrs(ui.p, ui.muted)}>This conflict isn't in this analysis.</p>}>
        {(x) => (
          <>
            <Top trail={[prCrumb(m(), false), { label: "Conflict" }]} kind={`Conflict · ${x().touches.purposes.length} ${x().touches.purposes.length === 1 ? "purpose" : "purposes"}`} title={x().question} />
            <Conflicts list={[x()]} />
            <NextList title="The purposes it touches" rows={x().touches.purposes.filter((id) => p().byId.has(id)).map((id) => purposeRow(p(), p().byId.get(id)!))} />
          </>
        )}
      </Show>
    </div>
  );
}

const s = stylex.create({
  top: { gap: 4, display: "flex", flexDirection: "column" },
  trail: { alignItems: "baseline", columnGap: 2, display: "flex", flexWrap: "wrap", fontSize: 12, },
  here: { color: colors.muted },
  walk: { marginTop: 10 },
  para: { margin: 0, fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" },
  chip: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 0,
    paddingInline: 7,
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    color: colors.muted,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.6,
    marginInlineEnd: 2,
    verticalAlign: "1px",
    whiteSpace: "nowrap",
  },
  chipOn: { borderColor: colors.accent, backgroundColor: { default: colors.selected, ":hover": colors.selected }, color: colors.accent },
  stated: { color: colors.warn, cursor: "help", fontSize: 12.5, fontStyle: "italic", whiteSpace: "nowrap" },
  hidden: { visibility: "hidden" },
  gap: { marginTop: 10 },
  note: { marginBottom: 6 },
  next: { margin: 0, padding: 0, gap: 2, listStyle: "none", display: "flex", flexDirection: "column" },
  stop: {
    font: "inherit",
    borderRadius: 6,
    borderWidth: 0,
    gap: 10,
    paddingBlock: 6,
    paddingInline: 6,
    alignItems: "baseline",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    display: "flex",
    textAlign: "start",
    width: "100%",
  },
  num: { color: colors.muted, flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "end", width: 16 },
  stopBody: { gap: 1, display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  stopName: { alignItems: "baseline", display: "flex", fontWeight: 600, overflowWrap: "anywhere" },
  rules: { gap: 10 },
  rule: { gap: 3, display: "flex", flexDirection: "column" },
  holds: { color: colors.open },
  breaks: { color: colors.danger, fontWeight: 600 },
  roles: { gap: 10 },
  role: { lineHeight: 1.45 },
  roleLine: { marginInlineStart: 14 },
  strong: { fontWeight: 650 },
  subRoles: { gap: 6, paddingInlineStart: 14, marginTop: 4, },
  fact: { gap: 8, alignItems: "baseline", display: "flex", lineHeight: 1.45 },
  facts: { margin: 0, gap: "4px 12px", display: "grid", gridTemplateColumns: "max-content 1fr", marginTop: 12 },
  factKey: { color: colors.muted, flexShrink: 0, fontSize: 12, fontWeight: 650, minWidth: 82 },
  factValue: { margin: 0, overflowWrap: "anywhere" },
  reference: { marginTop: 22 },
  referenceTitle: { fontWeight: 650 },
});
