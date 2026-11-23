// PROTOTYPE — throwaway, never merged (wayfinder #169, "Prototype the PR panel's side of the PR
// view"). Three variants of where the PR view and its analysis run show in the PR panel, switched
// with ?pa=A|B|C, and every state of the run and the analysis, switched with ?pas=<state>, from the
// floating bar at the bottom (← → keys cycle the variant). Nothing is real: no run is created, the
// prompt copied is the fixed one from #151 with a fake token, and the full-screen view is a mock
// of its top bar and empty state only.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { colors, fonts } from "./tokens.stylex";

// ---- State --------------------------------------------------------------------------------------

const STATES = [
  ["none", "No analysis, no run"],
  ["waiting", "Run: prompt copied, waiting for the agent"],
  ["attached", "Run: agent attached, working"],
  ["refused", "Run: last upload refused (422)"],
  ["cli", "Run: started from the beghu CLI"],
  ["expired", "Run expired, no analysis"],
  ["fresh", "Analysis at head"],
  ["fresh-attached", "Analysis at head, its run still attached"],
  ["behind", "Analysis 3 commits behind"],
  ["behind-running", "Analysis 3 behind, new run working"],
  ["view-none", "View: NoAnalysis"],
  ["view-none-waiting", "View: NoAnalysis, run waiting"],
  ["view-behind", "View: analysis 3 behind"],
  ["view-newer", "View: a newer analysis is ready"],
] as const;
type St = (typeof STATES)[number][0];
const VARIANTS = [
  ["A", "Section under the branches"],
  ["B", "Button in the status row"],
  ["C", "A property row"],
] as const;
type V = (typeof VARIANTS)[number][0];

const q = new URLSearchParams(location.search);
const [variant, setVariantSig] = createSignal<V>((VARIANTS.find((v) => v[0] === q.get("pa"))?.[0] ?? "A") as V);
const [st, setStSig] = createSignal<St>((STATES.find((s) => s[0] === q.get("pas"))?.[0] ?? "none") as St);
const [copied, setCopied] = createSignal(false);
const [popOpen, setPopOpen] = createSignal(false);

function writeUrl() {
  const u = new URL(location.href);
  u.searchParams.set("pa", variant());
  u.searchParams.set("pas", st());
  history.replaceState(history.state, "", u);
}
function setVariant(v: V) {
  setVariantSig(() => v);
  setPopOpen(false);
  writeUrl();
}
function go(s: St) {
  setStSig(() => s);
  setCopied(false);
  writeUrl();
}

type Run = { by: "button" | "cli"; phase: "waiting" | "attached"; refused?: number };
type Analysis = { behind: number };
function run(): Run | null {
  switch (st()) {
    case "waiting":
    case "view-none-waiting":
      return { by: "button", phase: "waiting" };
    case "attached":
    case "fresh-attached":
    case "behind-running":
      return { by: "button", phase: "attached" };
    case "refused":
      return { by: "button", phase: "attached", refused: 3 };
    case "cli":
      return { by: "cli", phase: "attached" };
    default:
      return null;
  }
}
function analysis(): Analysis | null {
  switch (st()) {
    case "fresh":
    case "fresh-attached":
    case "view-newer":
      return { behind: 0 };
    case "behind":
    case "behind-running":
    case "view-behind":
      return { behind: 3 };
    default:
      return null;
  }
}
const inView = () => st().startsWith("view-");

type Pr = { owner: string; repo: string; number: number; title: string };
const PIN = "a1b2c3d";
const prompt = (p: Pr) =>
  `Analyse pull request ${p.owner}/${p.repo}#${p.number} (476 files, +31,204 −16,877) for beghu by fetching your instructions from \`https://${location.host}/api/runs/k3J9xq…Zp/instructions\` and following them to the end: they say how to check out the code, build and check the analysis, and upload it. Large PRs are split across several agents and can take an hour; treat the link as a password, as it lets anyone holding it act on this PR's analysis until the run ends.`;
const cliCommand = (p: Pr) => `beghu analyse ${p.owner}/${p.repo}#${p.number}`;

function analyse(p: Pr) {
  void navigator.clipboard?.writeText(prompt(p)).catch(() => {});
  go(inView() ? "view-none-waiting" : analysis()?.behind ? "behind-running" : analysis() ? "fresh-attached" : "waiting");
  setCopied(true);
}
function endRun() {
  const a = analysis();
  go(inView() ? "view-none" : a ? (a.behind ? "behind" : "fresh") : "none");
}
function openView() {
  setPopOpen(false);
  const a = analysis();
  go(a ? (a.behind ? "view-behind" : "view-newer") : run() ? "view-none-waiting" : "view-none");
}

// ---- Shared bits --------------------------------------------------------------------------------

function runLine(r: Run) {
  if (r.refused) return `Last upload refused: ${r.refused} errors. The agent got the report and can upload again.`;
  if (r.phase === "waiting") return "Waiting for an agent to fetch the instructions. Unused, the link ends in 24 h.";
  return `${r.by === "cli" ? "The beghu CLI" : "An agent"} is working at ${PIN}, last heard 2 min ago. The run ends after 2 h idle.`;
}
function runShort(r: Run) {
  if (r.refused) return "Upload refused";
  if (r.phase === "waiting") return "Waiting for agent";
  return r.by === "cli" ? "CLI working" : "Agent working";
}

/** The run's three steps: link made, agent fetched, analysis uploaded. */
function Steps(props: { r: Run }) {
  const steps = () => [
    { label: props.r.by === "cli" ? "Started from CLI" : "Prompt copied", done: true },
    { label: "Agent fetched", done: props.r.phase === "attached" },
    { label: props.r.refused ? "Upload refused" : "Uploaded", done: false, bad: !!props.r.refused },
  ];
  return (
    <ol {...stylex.attrs(s.steps)}>
      <For each={steps()}>
        {(x) => (
          <li {...stylex.attrs(s.step)}>
            <span {...stylex.attrs(s.stepDot, x.done && s.stepDone, x.bad && s.stepBad)} />
            <span {...stylex.attrs(!x.done && !x.bad && s.muted, x.bad && s.bad)}>{x.label}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

function PromptPeek(props: { p: Pr }) {
  return (
    <details {...stylex.attrs(s.peek)}>
      <summary {...stylex.attrs(s.peekSummary)}>What was copied</summary>
      <p {...stylex.attrs(s.promptText)}>{prompt(props.p)}</p>
      <p {...stylex.attrs(s.small, s.muted)}>
        Or from a terminal: <code {...stylex.attrs(s.code)}>{cliCommand(props.p)}</code>
      </p>
    </details>
  );
}

function Stats() {
  return (
    <span {...stylex.attrs(s.muted)}>
      76 parts · 9 purposes · <span {...stylex.attrs(s.warnText)}>2 conflicts</span>
    </span>
  );
}

function Behind(props: { n: number }) {
  return (
    <Show when={props.n > 0}>
      <span {...stylex.attrs(s.behindChip)} title="The PR has moved past the analysed head">
        {props.n} commits behind
      </span>
    </Show>
  );
}

// ---- Variant A: a section of its own under the branches ------------------------------------------

function VariantA(props: { p: Pr }) {
  return (
    <section {...stylex.attrs(s.aBox)} data-proto="A">
      <div {...stylex.attrs(s.aHead)}>
        <span {...stylex.attrs(s.aTitle)}>PR view</span>
        <Show when={analysis()}>
          {(a) => (
            <>
              <span {...stylex.attrs(s.muted, s.small)}>
                at <code {...stylex.attrs(s.code)}>{PIN}</code>, 3 h ago
              </span>
              <Behind n={a().behind} />
            </>
          )}
        </Show>
        <span {...stylex.attrs(s.spacer)} />
        <Show when={analysis()}>
          <button type="button" {...stylex.attrs(s.primary)} onClick={openView}>
            Open PR view →
          </button>
        </Show>
      </div>
      <Show when={analysis()}>
        <div {...stylex.attrs(s.small)}>
          <Stats />
        </div>
      </Show>
      <Show
        when={run()}
        fallback={
          <Show
            when={analysis()}
            fallback={
              <>
                <p {...stylex.attrs(s.text)}>
                  <Show when={st() === "expired"} fallback="Your own agent maps this PR: its parts, what it's for and where it contradicts itself, down to the lines.">
                    The last run ended after 2 h idle with no upload.
                  </Show>
                </p>
                <div {...stylex.attrs(s.row)}>
                  <button type="button" {...stylex.attrs(s.primary)} onClick={() => analyse(props.p)}>
                    {st() === "expired" ? "Analyse again" : "Analyse this PR"}
                  </button>
                  <span {...stylex.attrs(s.small, s.muted)}>copies a prompt for your agent</span>
                </div>
              </>
            }
          >
            {(a) => (
              <div {...stylex.attrs(s.row)}>
                <button type="button" {...stylex.attrs(a().behind ? s.secondaryStrong : s.secondary)} onClick={() => analyse(props.p)}>
                  Analyse again{a().behind ? " at the new head" : ""}
                </button>
                <span {...stylex.attrs(s.small, s.muted)}>replaces this analysis when the upload is accepted</span>
              </div>
            )}
          </Show>
        }
      >
        {(r) => (
          <div {...stylex.attrs(s.aRun)}>
            <Steps r={r()} />
            <p {...stylex.attrs(s.text, !!r().refused && s.bad)}>{runLine(r())}</p>
            <div {...stylex.attrs(s.row)}>
              <Show when={r().by === "button"}>
                <button type="button" {...stylex.attrs(s.secondary)} onClick={() => analyse(props.p)}>
                  {copied() ? "Copied" : "Copy the prompt again"}
                </button>
              </Show>
              <button type="button" {...stylex.attrs(s.danger)} onClick={endRun}>
                End run
              </button>
              <Show when={analysis()}>
                <span {...stylex.attrs(s.small, s.muted)}>an accepted upload replaces the analysis above</span>
              </Show>
            </div>
            <Show when={r().by === "button"}>
              <PromptPeek p={props.p} />
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

// ---- Variant B: one button in the status row, details in a popover ------------------------------

export function VariantBButton(props: { p: Pr }) {
  const label = () => {
    const r = run();
    const a = analysis();
    if (a) return a.behind ? `PR view · ${a.behind} behind` : "PR view";
    if (r) return runShort(r);
    return st() === "expired" ? "Analyse again" : "Analyse";
  };
  const main = () => {
    if (analysis()) openView();
    else if (run()) setPopOpen(!popOpen());
    else analyse(props.p);
  };
  return (
    <Show when={variant() === "B" && !inView()}>
      <span {...stylex.attrs(s.bWrap)}>
        <span {...stylex.attrs(s.split)}>
          <button type="button" {...stylex.attrs(s.bMain, analysis() && s.bMainHas)} onClick={main}>
            <Show when={run()}>
              {(r) => <span {...stylex.attrs(s.pulse, !!r().refused && s.pulseBad, r().phase === "waiting" && s.pulseWait)} />}
            </Show>
            {label()}
          </button>
          <button type="button" {...stylex.attrs(s.bCaret)} aria-label="Analysis details" onClick={() => setPopOpen(!popOpen())}>
            ▾
          </button>
        </span>
        <Show when={popOpen()}>
          <div {...stylex.attrs(s.pop)}>
            <Show when={analysis()}>
              {(a) => (
                <div {...stylex.attrs(s.popSec)}>
                  <div {...stylex.attrs(s.row)}>
                    <b>Analysis</b>
                    <span {...stylex.attrs(s.muted, s.small)}>
                      at <code {...stylex.attrs(s.code)}>{PIN}</code>, 3 h ago
                    </span>
                    <Behind n={a().behind} />
                  </div>
                  <div {...stylex.attrs(s.small)}>
                    <Stats />
                  </div>
                </div>
              )}
            </Show>
            <Show
              when={run()}
              fallback={
                <div {...stylex.attrs(s.popSec)}>
                  <button type="button" {...stylex.attrs(analysis() ? s.secondary : s.primary)} onClick={() => analyse(props.p)}>
                    {analysis() ? "Analyse again" : "Analyse this PR"}
                  </button>
                  <p {...stylex.attrs(s.small, s.muted)}>
                    Copies a prompt for your agent. From a terminal: <code {...stylex.attrs(s.code)}>{cliCommand(props.p)}</code>
                  </p>
                </div>
              }
            >
              {(r) => (
                <div {...stylex.attrs(s.popSec)}>
                  <b>Run</b>
                  <Steps r={r()} />
                  <p {...stylex.attrs(s.text, !!r().refused && s.bad)}>{runLine(r())}</p>
                  <div {...stylex.attrs(s.row)}>
                    <Show when={r().by === "button"}>
                      <button type="button" {...stylex.attrs(s.secondary)} onClick={() => analyse(props.p)}>
                        {copied() ? "Copied" : "Copy again"}
                      </button>
                    </Show>
                    <button type="button" {...stylex.attrs(s.danger)} onClick={endRun}>
                      End run
                    </button>
                  </div>
                  <Show when={r().by === "button"}>
                    <PromptPeek p={props.p} />
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </span>
    </Show>
  );
}

// ---- Variant C: a property row, beside Assignees and Labels -------------------------------------

export function VariantCRow(props: { p: Pr; keyStyle: stylex.StyleXStyles; valueStyle: stylex.StyleXStyles }) {
  return (
    <Show when={variant() === "C" && !inView()}>
      <dt {...stylex.attrs(props.keyStyle)}>PR view</dt>
      <dd {...stylex.attrs(props.valueStyle)} data-proto="C">
        <div {...stylex.attrs(s.cLine)}>
          <Show
            when={analysis()}
            fallback={
              <Show when={!run()}>
                <span {...stylex.attrs(s.muted)}>{st() === "expired" ? "Last run expired" : "Not analysed"}</span>
                <button type="button" {...stylex.attrs(s.link)} onClick={() => analyse(props.p)}>
                  {st() === "expired" ? "Analyse again" : "Analyse this PR"}
                </button>
              </Show>
            }
          >
            {(a) => (
              <>
                <button type="button" {...stylex.attrs(s.link, s.linkStrong)} onClick={openView}>
                  Open
                </button>
                <span {...stylex.attrs(s.muted)}>
                  <code {...stylex.attrs(s.code)}>{PIN}</code> · 3 h ago
                </span>
                <Behind n={a().behind} />
                <Show when={!run()}>
                  <button type="button" {...stylex.attrs(s.link)} onClick={() => analyse(props.p)}>
                    Analyse again
                  </button>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Show when={run()}>
          {(r) => (
            <div {...stylex.attrs(s.cLine)}>
              <span {...stylex.attrs(s.pulse, !!r().refused && s.pulseBad, r().phase === "waiting" && s.pulseWait)} />
              <span {...stylex.attrs(r().refused ? s.bad : s.muted)} title={runLine(r())}>
                {runShort(r())}
                {r().phase === "waiting" ? " · link ends in 24 h" : ` at ${PIN} · 2 min ago`}
              </span>
              <Show when={r().by === "button"}>
                <button type="button" {...stylex.attrs(s.link)} onClick={() => analyse(props.p)}>
                  {copied() ? "Copied" : "Copy prompt"}
                </button>
              </Show>
              <button type="button" {...stylex.attrs(s.link, s.linkDanger)} onClick={endRun}>
                End run
              </button>
            </div>
          )}
        </Show>
      </dd>
    </Show>
  );
}

export function VariantASection(props: { p: Pr }) {
  return (
    <Show when={variant() === "A" && !inView()}>
      <VariantA p={props.p} />
    </Show>
  );
}

// ---- The full-screen view, mocked: its top bar and NoAnalysis ------------------------------------

function ViewMock(props: { p: Pr }) {
  const back = () => go(analysis() ? (analysis()!.behind ? "behind" : "fresh") : run() ? "waiting" : "none");
  return (
    <div {...stylex.attrs(s.view)} data-proto="view">
      <header {...stylex.attrs(s.viewBar)}>
        <button type="button" {...stylex.attrs(s.link)} onClick={back}>
          ← {props.p.repo}#{props.p.number}
        </button>
        <span {...stylex.attrs(s.viewTitle)}>{props.p.title}</span>
        <Show when={analysis()}>
          {(a) => (
            <>
              <span {...stylex.attrs(s.muted, s.small)}>
                analysed at <code {...stylex.attrs(s.code)}>{PIN}</code>, 3 h ago
              </span>
              <Behind n={a().behind} />
            </>
          )}
        </Show>
        <span {...stylex.attrs(s.spacer)} />
        <Show when={analysis()}>
          <Show
            when={run()}
            fallback={
              <button type="button" {...stylex.attrs(analysis()!.behind ? s.secondaryStrong : s.secondary)} onClick={() => analyse(props.p)}>
                Analyse again
              </button>
            }
          >
            {(r) => <span {...stylex.attrs(s.small, s.muted)}>{runShort(r())}</span>}
          </Show>
        </Show>
      </header>
      <Show when={st() === "view-newer"}>
        <div {...stylex.attrs(s.newer)}>
          A newer analysis is ready
          <button type="button" {...stylex.attrs(s.newerBtn)} onClick={() => go("view-behind")}>
            Show it
          </button>
        </div>
      </Show>
      <Show
        when={analysis()}
        fallback={
          <div {...stylex.attrs(s.empty)}>
            <h2 {...stylex.attrs(s.emptyTitle)}>No analysis of this PR yet</h2>
            <p {...stylex.attrs(s.text)}>
              beghu never reads your code. Your own agent does: it checks out the PR, maps its parts, what it's for and where it
              contradicts itself, and uploads the map here. Only you can see it.
            </p>
            <Show
              when={run()}
              fallback={
                <div {...stylex.attrs(s.emptyActions)}>
                  <button type="button" {...stylex.attrs(s.primary, s.big)} onClick={() => analyse(props.p)}>
                    Analyse this PR
                  </button>
                  <p {...stylex.attrs(s.small, s.muted)}>
                    Copies a prompt to paste into Claude Code, Codex or any agent with a shell and git. Or from a terminal:{" "}
                    <code {...stylex.attrs(s.code)}>{cliCommand(props.p)}</code>
                  </p>
                </div>
              }
            >
              {(r) => (
                <div {...stylex.attrs(s.aRun)}>
                  <Steps r={r()} />
                  <p {...stylex.attrs(s.text)}>{runLine(r())} This page fills in when the upload is accepted.</p>
                  <div {...stylex.attrs(s.row)}>
                    <button type="button" {...stylex.attrs(s.secondary)} onClick={() => analyse(props.p)}>
                      {copied() ? "Copied" : "Copy the prompt again"}
                    </button>
                    <button type="button" {...stylex.attrs(s.danger)} onClick={endRun}>
                      End run
                    </button>
                  </div>
                  <PromptPeek p={props.p} />
                </div>
              )}
            </Show>
          </div>
        }
      >
        <div {...stylex.attrs(s.canvas)}>
          <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{() => <div {...stylex.attrs(s.fakeBlock)} />}</For>
          <p {...stylex.attrs(s.muted, s.small)}>(the drawn graph goes here)</p>
        </div>
      </Show>
    </div>
  );
}

// ---- The floating bar ---------------------------------------------------------------------------

export function ProtoBar(props: { p: Pr }) {
  const cycle = (d: number) => {
    const i = VARIANTS.findIndex((v) => v[0] === variant());
    setVariant(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length][0]);
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.closest("input, textarea, select, [contenteditable]") || e.altKey || e.ctrlKey || e.metaKey)) return;
    if (e.key === "ArrowLeft") cycle(-1);
    else if (e.key === "ArrowRight") cycle(1);
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <Show when={import.meta.env.DEV}>
      <Portal>
        <Show when={inView()}>
          <ViewMock p={props.p} />
        </Show>
        <div {...stylex.attrs(s.bar)}>
          <button type="button" {...stylex.attrs(s.barBtn)} onClick={() => cycle(-1)} aria-label="Previous variant">
            ‹
          </button>
          <span {...stylex.attrs(s.barLabel)}>
            {variant()} — {VARIANTS.find((v) => v[0] === variant())?.[1]}
          </span>
          <button type="button" {...stylex.attrs(s.barBtn)} onClick={() => cycle(1)} aria-label="Next variant">
            ›
          </button>
          <select {...stylex.attrs(s.barSelect)} value={st()} onChange={(e) => go(e.currentTarget.value as St)}>
            <For each={[...STATES]}>{(x) => <option value={x[0]}>{x[1]}</option>}</For>
          </select>
        </div>
      </Portal>
    </Show>
  );
}

// ---- Styles -------------------------------------------------------------------------------------

const pulse = stylex.keyframes({ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } });

const btn = {
  borderRadius: 6,
  borderStyle: "solid",
  borderWidth: 1,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  height: 26,
  paddingInline: 10,
} as const;

const s = stylex.create({
  muted: { color: colors.muted },
  bad: { color: colors.danger },
  warnText: { color: colors.warn },
  small: { fontSize: 12 },
  text: { margin: 0, fontSize: 13, lineHeight: 1.45, },
  code: { fontFamily: fonts.mono, fontSize: 11.5 },
  spacer: { flexGrow: 1 },
  row: { gap: 8, alignItems: "center", display: "flex", flexWrap: "wrap", },
  primary: { ...btn, borderColor: colors.accentBg, backgroundColor: colors.accentBg, color: colors.accentFg, },
  big: { paddingInline: 16, fontSize: 14, height: 34, },
  secondary: { ...btn, borderColor: colors.line, backgroundColor: colors.bg, color: colors.fg, },
  secondaryStrong: { ...btn, borderColor: colors.warn, backgroundColor: colors.bg, color: colors.warn, },
  danger: { ...btn, borderColor: "transparent", backgroundColor: "transparent", color: colors.danger, },
  link: {
    padding: 0,
    borderWidth: 0,
    textDecoration: { default: "none", ":hover": "underline" },
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
    fontSize: 12,
  },
  linkStrong: { fontWeight: 600 },
  linkDanger: { color: colors.danger },
  behindChip: {
    borderColor: colors.warn,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 7,
    color: colors.warn,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  steps: { margin: 0, padding: 0, gap: 14, listStyle: "none", display: "flex", fontSize: 12, },
  step: { gap: 6, alignItems: "center", display: "flex", },
  stepDot: { borderColor: colors.muted, borderRadius: 999, borderStyle: "solid", borderWidth: 1.5, height: 8, width: 8 },
  stepDone: { borderColor: colors.open, backgroundColor: colors.open, },
  stepBad: { borderColor: colors.danger, backgroundColor: colors.danger, },
  peek: { fontSize: 12 },
  peekSummary: { color: colors.muted, cursor: "pointer" },
  promptText: {
    padding: 8,
    borderRadius: 6,
    marginBlock: 6,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 1.5,
  },
  // A
  aBox: {
    padding: 12,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 8,
    marginInline: 16,
    display: "flex",
    flexDirection: "column",
    marginBottom: 12,
  },
  aHead: { gap: 8, alignItems: "center", display: "flex", flexWrap: "wrap", },
  aTitle: { fontSize: 13, fontWeight: 600 },
  aRun: { gap: 8, display: "flex", flexDirection: "column", },
  // B
  bWrap: { display: "inline-flex", flexShrink: 0, position: "relative", },
  split: { display: "inline-flex" },
  bMain: {
    ...btn,
    borderColor: colors.line,
    gap: 6,
    alignItems: "center",
    backgroundColor: colors.bg,
    borderEndEndRadius: 0,
    borderStartEndRadius: 0,
    color: colors.fg,
    display: "inline-flex",
    height: 24,
  },
  bMainHas: { borderColor: colors.accent, color: colors.accent },
  bCaret: {
    ...btn,
    borderColor: colors.line,
    paddingInline: 6,
    backgroundColor: colors.bg,
    borderEndStartRadius: 0,
    borderStartStartRadius: 0,
    color: colors.muted,
    borderLeftWidth: 0,
    height: 24,
  },
  pop: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    insetInlineEnd: 0,
    position: "absolute",
    zIndex: 20,
    top: 30,
    width: 360,
  },
  popSec: {
    padding: 12,
    gap: 8,
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  pulse: {
    borderRadius: 999,
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
    animationName: pulse,
    backgroundColor: colors.open,
    display: "inline-block",
    flexShrink: 0,
    height: 8,
    width: 8,
  },
  pulseWait: { backgroundColor: colors.warn },
  pulseBad: { animationName: "none", backgroundColor: colors.danger },
  // C
  cLine: { gap: 8, alignItems: "center", display: "flex", flexWrap: "wrap", fontSize: 13, minHeight: 22, },
  // View mock
  view: {
    inset: 0,
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    position: "fixed",
    zIndex: 50,
  },
  viewBar: {
    gap: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    height: 44,
  },
  viewTitle: { overflow: "hidden", fontSize: 14, fontWeight: 600, textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, },
  newer: {
    borderRadius: 999,
    gap: 10,
    paddingBlock: 6,
    paddingInline: 14,
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: colors.accentBg,
    boxShadow: `0 4px 14px ${colors.popShadow}`,
    color: colors.accentFg,
    display: "flex",
    fontSize: 13,
    position: "absolute",
    zIndex: 2,
    marginTop: 12,
    top: 44,
  },
  newerBtn: {
    borderColor: colors.accentFg,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 10,
    backgroundColor: "transparent",
    color: colors.accentFg,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },
  empty: {
    gap: 14,
    paddingInline: 16,
    alignSelf: "center",
    display: "flex",
    flexDirection: "column",
    marginTop: "12vh",
    maxWidth: 520,
  },
  emptyTitle: { margin: 0, fontSize: 20, },
  emptyActions: { gap: 8, alignItems: "flex-start", display: "flex", flexDirection: "column", },
  canvas: {
    gap: 24,
    alignContent: "start",
    backgroundColor: colors.bgRaised,
    display: "grid",
    flexGrow: 1,
    gridTemplateColumns: "repeat(4, 160px)",
    justifyContent: "center",
    paddingTop: 80,
  },
  fakeBlock: { borderColor: colors.line, borderRadius: 8, borderStyle: "solid", borderWidth: 1, backgroundColor: colors.bg, height: 70, },
  // The prototype's own bar: inverted so it's obviously not part of the design.
  bar: {
    borderRadius: 999,
    gap: 8,
    paddingBlock: 6,
    paddingInline: 10,
    alignItems: "center",
    backgroundColor: colors.fg,
    boxShadow: `0 6px 20px ${colors.popShadow}`,
    color: colors.bg,
    display: "flex",
    fontFamily: fonts.ui,
    fontSize: 13,
    position: "fixed",
    transform: "translateX(-50%)",
    zIndex: 100,
    bottom: 16,
    left: "50%",
  },
  barBtn: { borderWidth: 0, paddingInline: 6, backgroundColor: "transparent", color: colors.bg, cursor: "pointer", fontSize: 18, },
  barLabel: { fontWeight: 600, textAlign: "center", minWidth: 210, },
  barSelect: { borderRadius: 999, borderWidth: 0, paddingInline: 8, backgroundColor: colors.bg, color: colors.fg, fontSize: 12, height: 26, },
});
