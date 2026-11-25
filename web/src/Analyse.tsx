// The PR panel's Analyse split button (#177), in the status row before "Open on GitHub", and its
// popover. Part of the PR panel's chunk (Pull.tsx).
//
// The label is the state: Analyse; Analyse again (the last run expired, no analysis); ● Waiting
// for agent (amber, pulsing); ● Agent working or ● CLI working (green, pulsing); ● Upload refused
// (red, steady); PR view, PR view · N behind or PR view · outdated (accent), with a live run's dot
// and words after it (● PR view · Agent working: a re-analysis under way). The main part does the
// obvious thing: with nothing live it copies the prompt and starts a run; otherwise it opens the
// popover (the two PR view states will open the full-screen view once it has a route). ▾ always
// opens the popover, which holds the analysis, the live run (its steps, one status line, Copy
// again, End run, what was copied), or Analyse this PR with the CLI's alternative.
//
// The popover is a non-modal dialog: opening it moves focus to its first control, Escape closes
// it (before the panel's keys hear it) and puts focus back on the button that opened it, and Tab
// goes on from its last control to what follows the button. Its ages tick while it's open.
//
// Starting and ending a run are writes: each absorbs its own failure, saying so in the popover,
// and the label rolls back to what the detail says. A started run shows as waiting at once, and
// an ended one as gone, until the PR's detail (refetched on the `analysis` push) says so itself.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onSettled, Show, type Accessor } from "solid-js";
import { tabAccount } from "./account";
import { PrTooLarge, readAt } from "./api";
import type { PullDetail } from "./bindings/PullDetail";
import type { PrAnalysis } from "./bindings/PrAnalysis";
import type { PrRun } from "./bindings/PrRun";
import { writesPaused } from "./live";
import { forgetPrompts, keepPrompt, keptPrompt, promptsSeen } from "./prompts";
import { endRun, startRun, type PrAt } from "./runs";
import { ago, fullDate } from "./time";
import { colors, fonts } from "./tokens.stylex";

/** What the button shows: one of the seven states. */
type State = "analyse" | "again" | "waiting" | "working" | "refused" | "view";
/** A live run's state, as its dot shows it. */
type RunState = "waiting" | "working" | "refused";

/** How long "Copied" shows in a copy button's place. */
const COPIED_MS = 1500;
/** How long a run this tab started shows as waiting before the detail must say so itself. */
const STARTED_FOR_MS = 15_000;
/** How often the open popover's ages ("last heard 2m ago") are worked out again. */
const TICK_MS = 30_000;
/** What can take focus in the popover, in order. */
const FOCUSABLE = "button:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])";

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "2m ago", or "just now". */
const since = (t: number) => {
  const a = ago(t);
  return a === "now" ? "just now" : `${a} ago`;
};

/**
 * Copies `text`, or what `text` resolves to, in the click's own gesture: a prompt the server is
 * still making is handed to the clipboard as a promise (`ClipboardItem`), which Safari needs; a
 * browser without that copies once it's made. Rejects when the clipboard refuses.
 */
async function copy(text: string | Promise<string>): Promise<void> {
  if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && "supports" in ClipboardItem && ClipboardItem.supports("text/plain")) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    // The prompt's own failure is the caller's to report; the clipboard's is this one.
    blob.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}

/** The PR the button is for: where it is, and its own fields from its detail. */
export interface AnalysedPr {
  owner: string;
  repo: string;
  number: number;
  pr: PullDetail | null;
}

export function AnalyseButton(props: { d: AnalysedPr }) {
  const at = (): PrAt => ({ owner: props.d.owner, repo: props.d.repo, number: props.d.number });
  const account = tabAccount() ?? 0;
  const cli = () => `beghu analyse ${props.d.owner}/${props.d.repo}#${props.d.number}`;

  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string>();
  /** Which copy button just copied: `prompt` or `cli`. */
  const [copied, setCopied] = createSignal<"prompt" | "cli">();
  /** A run this tab just started, shown as waiting until the detail has it. */
  const [started, setStarted] = createSignal<PrRun>();
  /** The run this tab is ending, hidden until the detail no longer shows it. */
  const [ending, setEnding] = createSignal<string>();
  /** Bumped when a prompt is kept, here or in another tab (`storage`), so Copy again reads storage again. */
  const [kept, setKept] = createSignal(0);
  /** Bumped every TICK_MS while the popover is open: its ages read the clock again. */
  const [tick, setTick] = createSignal(0);
  /** The button that opened the popover: focus goes back to it on Escape. */
  let opener: HTMLButtonElement | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let startedTimer: ReturnType<typeof setTimeout> | undefined;

  const flash = (which: "prompt" | "cli") => {
    clearTimeout(copiedTimer);
    setCopied(which);
    copiedTimer = setTimeout(() => setCopied(undefined), COPIED_MS);
  };

  /** The PR's live run, as the detail has it, with this tab's own start and end on top. */
  const run = createMemo((): PrRun | undefined => {
    const r = props.d.pr?.run;
    const mine = started();
    const live = r && r.state !== "expired" ? r : undefined;
    if (mine && live?.id !== mine.id) return mine;
    if (live && live.id === ending()) return undefined;
    return live;
  });
  const expired = () => props.d.pr?.run?.state === "expired" && !started();
  const analysis = (): PrAnalysis | undefined => props.d.pr?.analysis;

  // The detail caught up with this tab's start (the same run, or a newer one by the server's
  // clock) or end; and the prompts of runs it shows no longer live go.
  createEffect(
    () => props.d.pr?.run,
    (r) => {
      const live = r && r.state !== "expired" ? r.id : undefined;
      const mine = started();
      if (mine && (live === mine.id || (r && r.id !== mine.id && r.startedAt > mine.startedAt))) setStarted(undefined);
      if (ending() && live !== ending()) setEnding(undefined);
      // When the read began, on the clock the prompts are kept by.
      const read = readAt(props.d);
      if (!started()) promptsSeen(account, at(), r, Number.isFinite(read) ? performance.timeOrigin + read : NaN);
    },
  );

  /** The live run's state, if one is. */
  const runState = (): RunState | undefined => {
    const r = run();
    if (!r) return undefined;
    return r.refused > 0 ? "refused" : r.state === "waiting" ? "waiting" : "working";
  };

  const state = (): State => {
    if (analysis()) return "view";
    return runState() ?? (expired() ? "again" : "analyse");
  };

  /** The live run's words, beside its dot. */
  const runWords = () => {
    switch (runState()) {
      case "refused":
        return "Upload refused";
      case "waiting":
        return "Waiting for agent";
      case "working":
        return run()?.producer === "cli" ? "CLI working" : "Agent working";
      default:
        return undefined;
    }
  };

  const label = () => {
    switch (state()) {
      case "view": {
        const b = analysis()?.behind;
        const view = b === undefined ? "PR view" : b === "outdated" ? "PR view · outdated" : `PR view · ${b} behind`;
        const words = runWords();
        return words ? `${view} · ${words}` : view;
      }
      case "again":
        return "Analyse again";
      case "analyse":
        return "Analyse";
      default:
        return runWords()!;
    }
  };

  const prompt = () => {
    kept();
    const r = run();
    return r ? keptPrompt(account, at(), r.id) : undefined;
  };

  /** Starts a run (superseding the live one) and copies its prompt. */
  const analyse = async () => {
    if (busy() || writesPaused()) return;
    setBusy(true);
    setFailed(undefined);
    const pr = at();
    const making = startRun(pr);
    const copying = copy(making.then((s) => s.prompt));
    // A start that failed fails the copy too: that's reported as the start's failure, below.
    copying.catch(() => {});
    try {
      const s = await making;
      keepPrompt(account, pr, s.run, s.prompt, s.startedAt, s.expiresAt);
      forgetPrompts(account, pr, s.run);
      setKept((n) => n + 1);
      setStarted({ id: s.run, producer: "button", state: "waiting", refused: 0, startedAt: s.startedAt, expiresAt: s.expiresAt });
      // The detail catches up on the run's `analysis` push; one lost leaves it to the next read.
      clearTimeout(startedTimer);
      startedTimer = setTimeout(() => setStarted(undefined), STARTED_FOR_MS);
      try {
        await copying;
        flash("prompt");
      } catch {
        setOpen(true);
        setFailed("The run started, but the browser wouldn't copy its prompt: copy it from What was copied.");
      }
    } catch (e) {
      setOpen(true);
      setFailed(e instanceof PrTooLarge ? e.message : `Couldn't start a run: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const copyAgain = async (text: string) => {
    try {
      await copy(text);
      flash("prompt");
    } catch {
      setFailed("The browser wouldn't copy: select the prompt in What was copied.");
    }
  };

  const copyCli = async () => {
    try {
      await copy(cli());
      flash("cli");
    } catch {
      setFailed("The browser wouldn't copy the command.");
    }
  };

  const end = async () => {
    const r = run();
    if (!r || busy() || writesPaused()) return;
    setBusy(true);
    setFailed(undefined);
    setStarted(undefined);
    setEnding(r.id);
    try {
      await endRun(at());
      forgetPrompts(account, at());
    } catch (e) {
      setEnding(undefined);
      setFailed(`Couldn't end the run: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Whether the main part opens the popover rather than starting a run. */
  const mainOpens = () => state() !== "analyse" && state() !== "again";

  /** Opens or closes the popover from `from`, which focus goes back to on Escape. */
  const toggle = (from: HTMLButtonElement) => {
    opener = from;
    setOpen((o) => !o);
  };

  const main = (e: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    // "PR view" opens the full-screen view once it has its route (#181); until then, the popover.
    if (mainOpens()) toggle(e.currentTarget);
    else void analyse();
  };

  let wrap!: HTMLSpanElement;
  let pop: HTMLDivElement | undefined;
  // Opened: focus moves to the popover's first control.
  createEffect(open, (o) => {
    if (o) pop?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });
  onSettled(() => {
    const away = (e: PointerEvent) => {
      if (open() && !wrap.contains(e.target as Node)) setOpen(false);
    };
    // Before the panel's keys (on the window, after the document), which never hear it: Escape
    // closes the popover, not the PR, and focus goes back to the button that opened it.
    const esc = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        (opener?.isConnected ? opener : wrap.querySelector<HTMLElement>("button"))?.focus();
      }
    };
    // Tabbed out past its last control: the popover closes behind the focus.
    const left = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (open() && to && !wrap.contains(to)) setOpen(false);
    };
    // Another tab of this browser kept or dropped a prompt.
    const stored = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("beghu.prompt.")) setKept((n) => n + 1);
    };
    const ticking = setInterval(() => {
      if (open()) setTick((n) => n + 1);
    }, TICK_MS);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    wrap.addEventListener("focusout", left);
    addEventListener("storage", stored);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
      wrap.removeEventListener("focusout", left);
      removeEventListener("storage", stored);
      clearInterval(ticking);
      clearTimeout(copiedTimer);
      clearTimeout(startedTimer);
    };
  });

  const dot = () => {
    switch (runState()) {
      case "waiting":
        return s.dotWait;
      case "working":
        return s.dotWork;
      case "refused":
        return s.dotBad;
      default:
        return undefined;
    }
  };

  return (
    <span ref={wrap} {...stylex.attrs(s.wrap)} data-perf="analyse" data-state={state()} data-run={runState()}>
      <button
        type="button"
        {...stylex.attrs(s.main, state() === "view" && s.mainView)}
        data-perf="analyse-main"
        disabled={busy() && !mainOpens()}
        onClick={main}
        aria-haspopup={mainOpens() ? "dialog" : undefined}
        aria-expanded={mainOpens() ? (open() ? "true" : "false") : undefined}
        title={mainOpens() ? undefined : "Copies a prompt for your agent and starts an analysis run"}
      >
        <Show when={dot()}>{(d) => <span {...stylex.attrs(s.dot, d())} aria-hidden="true" />}</Show>
        {copied() === "prompt" && !open() ? "Copied" : label()}
      </button>
      <button
        type="button"
        {...stylex.attrs(s.caret)}
        data-perf="analyse-more"
        aria-label="Analysis details"
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        onClick={(e) => toggle(e.currentTarget)}
      >
        ▾
      </button>
      <Show when={open()}>
        <div ref={pop} role="dialog" aria-label="Analysis" {...stylex.attrs(s.pop)} data-perf="analyse-pop">
          <Show when={analysis()}>{(a) => <AnalysisPart a={a()} tick={tick} />}</Show>
          <Show
            when={run()}
            fallback={
              <section {...stylex.attrs(s.sec)} data-perf="analyse-none">
                <div {...stylex.attrs(s.row)}>
                  <button type="button" {...stylex.attrs(analysis() ? s.secondary : s.primary)} disabled={busy() || writesPaused()} onClick={() => void analyse()}>
                    {analysis() ? "Analyse again" : "Analyse this PR"}
                  </button>
                  <span {...stylex.attrs(s.small, s.muted)}>Copies a prompt for your agent</span>
                </div>
                <Show when={analysis()}>
                  <p {...stylex.attrs(s.small, s.muted, s.text)}>An accepted upload replaces the analysis.</p>
                </Show>
                <details {...stylex.attrs(s.fold)}>
                  <summary {...stylex.attrs(s.foldSummary)}>
                    Or run <code {...stylex.attrs(s.code)}>{cli()}</code>
                  </summary>
                  <div {...stylex.attrs(s.row, s.foldBody)}>
                    <button type="button" {...stylex.attrs(s.secondary)} onClick={() => void copyCli()}>
                      {copied() === "cli" ? "Copied" : "Copy"}
                    </button>
                    <span {...stylex.attrs(s.small, s.muted)}>The beghu CLI starts the run itself.</span>
                  </div>
                </details>
              </section>
            }
          >
            {(r) => (
              <section {...stylex.attrs(s.sec)} data-perf="analyse-run">
                <b>Run</b>
                <Steps r={r()} uploaded={(analysis()?.createdAt ?? 0) >= r().startedAt} />
                <p {...stylex.attrs(s.text, r().refused > 0 && s.bad)} data-perf="analyse-status">
                  {(tick(), statusLine(r()))}
                </p>
                <div {...stylex.attrs(s.row)}>
                  <Show when={r().producer === "button"}>
                    <Show
                      when={prompt()}
                      fallback={
                        <button type="button" {...stylex.attrs(s.secondary)} disabled={busy() || writesPaused()} onClick={() => void analyse()} title="This browser doesn't hold the prompt: starts a new run in place of this one">
                          {copied() === "prompt" ? "Copied" : "Copy a new link"}
                        </button>
                      }
                    >
                      {(p) => (
                        <button type="button" {...stylex.attrs(s.secondary)} onClick={() => void copyAgain(p())}>
                          {copied() === "prompt" ? "Copied" : "Copy again"}
                        </button>
                      )}
                    </Show>
                  </Show>
                  <button type="button" {...stylex.attrs(s.danger)} disabled={busy() || writesPaused()} onClick={() => void end()}>
                    End run
                  </button>
                </div>
                <details {...stylex.attrs(s.fold)}>
                  <summary {...stylex.attrs(s.foldSummary)}>What was copied</summary>
                  <Show when={r().producer === "button"}>
                    <Show when={prompt()} fallback={<p {...stylex.attrs(s.small, s.muted, s.text)}>This browser doesn't hold this run's prompt: the browser that started it does.</p>}>
                      {(p) => (
                        <p {...stylex.attrs(s.promptText)} data-perf="analyse-prompt">
                          {p()}
                        </p>
                      )}
                    </Show>
                  </Show>
                  <p {...stylex.attrs(s.small, s.muted, s.text)}>
                    Or run <code {...stylex.attrs(s.code)}>{cli()}</code>
                  </p>
                </details>
              </section>
            )}
          </Show>
          <Show when={failed()}>
            {(m) => (
              <p role="alert" {...stylex.attrs(s.sec, s.text, s.bad)} data-perf="analyse-failed">
                {m()}
              </p>
            )}
          </Show>
        </div>
      </Show>
    </span>
  );
}

/** The run's one status line. */
function statusLine(r: PrRun): string {
  if (r.refused > 0) return `Last upload refused: ${plural(r.refused, "error")}. The agent got the report and can upload again.`;
  if (r.state === "waiting") return "Waiting for an agent to fetch the instructions. Unused, the link ends in 24 h.";
  return `An agent is working at ${short(r.pinnedSha ?? "")}, last heard ${since(r.lastHeard ?? r.startedAt)}. The run ends after 2 h idle.`;
}

/** The popover's analysis: its head and age, how far behind, and its counts. */
function AnalysisPart(props: { a: PrAnalysis; tick: Accessor<number> }) {
  return (
    <section {...stylex.attrs(s.sec)} data-perf="analyse-analysis">
      <div {...stylex.attrs(s.row)}>
        <b>Analysis</b>
        <span {...stylex.attrs(s.small, s.muted)} title={fullDate(props.a.createdAt)}>
          at <code {...stylex.attrs(s.code)}>{short(props.a.headSha)}</code>, {(props.tick(), since(props.a.createdAt))}
        </span>
        <Show when={props.a.behind}>
          {(b) => (
            <span {...stylex.attrs(s.chip)} data-perf="analyse-behind" title={b() === "outdated" ? "The analysed head is no longer among the PR's commits" : "The PR has moved past the analysed head"}>
              {b() === "outdated" ? "Outdated" : `${plural(b() as number, "commit")} behind`}
            </span>
          )}
        </Show>
      </div>
      <div {...stylex.attrs(s.small, s.muted)}>
        {plural(props.a.parts, "part")} · {plural(props.a.purposes, "purpose")} ·{" "}
        <span {...stylex.attrs(props.a.conflicts > 0 && s.warn)}>{plural(props.a.conflicts, "conflict")}</span>
      </div>
    </section>
  );
}

/** The run's three steps: the prompt copied (or started from the CLI), an agent fetched, uploaded. */
function Steps(props: { r: PrRun; uploaded: boolean }) {
  const steps = () => [
    { label: props.r.producer === "cli" ? "Started from CLI" : "Prompt copied", done: true, bad: false },
    { label: "Agent fetched", done: props.r.state === "attached", bad: false },
    props.r.refused > 0 ? { label: "Upload refused", done: false, bad: true } : { label: "Uploaded", done: props.uploaded, bad: false },
  ];
  return (
    <ol {...stylex.attrs(s.steps)}>
      <For each={steps()}>
        {(x) => (
          <li {...stylex.attrs(s.step)} data-done={x.done ? "" : undefined}>
            <span {...stylex.attrs(s.stepDot, x.done && s.stepDone, x.bad && s.stepBad)} aria-hidden="true" />
            <span {...stylex.attrs(!x.done && !x.bad && s.muted, x.bad && s.bad)}>{x.label}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

const pulse = stylex.keyframes({ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } });

const s = stylex.create({
  wrap: { display: "inline-flex", flexShrink: 0, position: "relative" },
  main: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 6,
    paddingInline: 10,
    alignItems: "center",
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    borderEndEndRadius: 0,
    borderStartEndRadius: 0,
    color: colors.fg,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 600,
    height: 24,
  },
  mainView: { borderColor: colors.accent, color: colors.accent },
  caret: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 6,
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    borderEndStartRadius: 0,
    borderStartStartRadius: 0,
    color: colors.muted,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    borderLeftWidth: 0,
    height: 24,
  },
  dot: {
    borderRadius: 999,
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
    animationName: { default: pulse, "@media (prefers-reduced-motion: reduce)": "none" },
    display: "inline-block",
    flexShrink: 0,
    height: 8,
    width: 8,
  },
  dotWait: { backgroundColor: colors.warn },
  dotWork: { backgroundColor: colors.open },
  dotBad: { animationName: "none", backgroundColor: colors.danger },
  pop: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    insetInlineEnd: 0,
    position: "absolute",
    whiteSpace: "normal",
    zIndex: 20,
    maxWidth: "calc(100vw - 32px)",
    top: 30,
    width: 360,
  },
  sec: {
    padding: 12,
    gap: 8,
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: { default: 1, ":last-child": 0 },
  },
  row: { gap: 8, alignItems: "center", display: "flex", flexWrap: "wrap" },
  text: { margin: 0, fontSize: 13, lineHeight: 1.45 },
  small: { fontSize: 12 },
  muted: { color: colors.muted },
  bad: { color: colors.danger },
  warn: { color: colors.warn },
  code: { fontFamily: fonts.mono, fontSize: 11.5 },
  chip: {
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
  primary: {
    borderColor: colors.accentBg,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 10,
    backgroundColor: colors.accentBg,
    color: colors.accentFg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 600,
    height: 26,
  },
  secondary: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 10,
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 600,
    height: 26,
  },
  danger: {
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 10,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.danger,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 600,
    height: 26,
  },
  steps: { margin: 0, padding: 0, gap: 14, listStyle: "none", display: "flex", flexWrap: "wrap", fontSize: 12 },
  step: { gap: 6, alignItems: "center", display: "flex" },
  stepDot: { borderColor: colors.muted, borderRadius: 999, borderStyle: "solid", borderWidth: 1.5, boxSizing: "border-box", height: 9, width: 9 },
  stepDone: { borderColor: colors.open, backgroundColor: colors.open },
  stepBad: { borderColor: colors.danger, backgroundColor: colors.danger },
  fold: { fontSize: 12 },
  foldSummary: { color: colors.muted, cursor: "pointer" },
  foldBody: { marginTop: 6 },
  promptText: {
    padding: 8,
    borderRadius: 6,
    marginBlock: 6,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 1.5,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
});
