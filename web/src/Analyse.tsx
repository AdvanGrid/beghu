// The PR panel's Analyse split button (#177), in the status row before "Open on GitHub", and its
// popover. Part of the PR panel's chunk (Pull.tsx).
//
// The label is the state: Analyse; Analyse again (the last run expired, no analysis); ● Waiting
// for agent (amber, pulsing); ● Agent working or ● CLI working (green, pulsing); ● Upload refused
// (red, steady); PR view, PR view · N behind or PR view · outdated (accent). The main part does
// the obvious thing: with nothing live it copies the prompt and starts a run; otherwise it opens
// the popover (the two PR view states will open the full-screen view once it has a route). ▾
// always opens the popover, which holds the analysis, the live run (its steps, one status line,
// Copy again, End run, what was copied), or Analyse this PR with the CLI's alternative.
//
// Starting and ending a run are writes: each absorbs its own failure, saying so in the popover,
// and the label rolls back to what the detail says. A started run shows as waiting at once, and
// an ended one as gone, until the PR's detail (refetched on the `analysis` push) says so itself.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { tabAccount } from "./account";
import { PrTooLarge } from "./api";
import type { PullDetail } from "./bindings/PullDetail";
import type { PrAnalysis } from "./bindings/PrAnalysis";
import type { PrRun } from "./bindings/PrRun";
import { writesPaused } from "./live";
import { endRun, forgetPrompts, keepPrompt, keptPrompt, startRun, type PrAt } from "./runs";
import { ago, fullDate } from "./time";
import { colors, fonts } from "./tokens.stylex";

/** What the button shows: one of the seven states. */
type State = "analyse" | "again" | "waiting" | "working" | "refused" | "view";

/** How long "Copied" shows in a copy button's place. */
const COPIED_MS = 1500;
/** How long a run this tab started shows as waiting before the detail must say so itself. */
const STARTED_FOR_MS = 15_000;

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
  /** Bumped when a prompt is kept, so Copy again reads storage again. */
  const [kept, setKept] = createSignal(0);
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

  // The detail caught up with this tab's start or end; and prompts of runs no longer live go.
  createEffect(
    () => props.d.pr?.run,
    (r) => {
      const live = r && r.state !== "expired" ? r.id : undefined;
      if (started() && (live === started()?.id || (r && r.id !== started()?.id && r.startedAt > (started()?.startedAt ?? 0)))) setStarted(undefined);
      if (ending() && live !== ending()) setEnding(undefined);
      if (!started()) forgetPrompts(account, at(), live);
    },
  );

  const state = (): State => {
    if (analysis()) return "view";
    const r = run();
    if (r) return r.refused > 0 ? "refused" : r.state === "waiting" ? "waiting" : "working";
    return expired() ? "again" : "analyse";
  };

  const label = () => {
    const r = run();
    switch (state()) {
      case "view": {
        const b = analysis()?.behind;
        return b === undefined ? "PR view" : b === "outdated" ? "PR view · outdated" : `PR view · ${b} behind`;
      }
      case "refused":
        return "Upload refused";
      case "waiting":
        return "Waiting for agent";
      case "working":
        return r?.producer === "cli" ? "CLI working" : "Agent working";
      case "again":
        return "Analyse again";
      case "analyse":
        return "Analyse";
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
    try {
      const s = await making;
      keepPrompt(account, pr, s.run, s.prompt);
      forgetPrompts(account, pr, s.run);
      setKept((n) => n + 1);
      setStarted({ id: s.run, producer: "button", state: "waiting", refused: 0, startedAt: Math.floor(Date.now() / 1000), expiresAt: s.expiresAt });
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

  const main = () => {
    // "PR view" opens the full-screen view once it has its route (#181); until then, the popover.
    if (state() === "analyse" || state() === "again") void analyse();
    else setOpen((o) => !o);
  };

  let wrap!: HTMLSpanElement;
  onSettled(() => {
    const away = (e: PointerEvent) => {
      if (open() && !wrap.contains(e.target as Node)) setOpen(false);
    };
    // Before the panel's keys: Escape closes the popover, not the PR.
    const esc = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
      clearTimeout(copiedTimer);
      clearTimeout(startedTimer);
    };
  });

  const dot = () => {
    switch (state()) {
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
    <span ref={wrap} {...stylex.attrs(s.wrap)} data-perf="analyse" data-state={state()}>
      <button
        type="button"
        {...stylex.attrs(s.main, state() === "view" && s.mainView)}
        data-perf="analyse-main"
        disabled={busy() && (state() === "analyse" || state() === "again")}
        onClick={main}
        title={state() === "analyse" || state() === "again" ? "Copies a prompt for your agent and starts an analysis run" : undefined}
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
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      <Show when={open()}>
        <div role="dialog" aria-label="Analysis" {...stylex.attrs(s.pop)} data-perf="analyse-pop">
          <Show when={analysis()}>{(a) => <AnalysisPart a={a()} />}</Show>
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
                  {statusLine(r())}
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
function AnalysisPart(props: { a: PrAnalysis }) {
  return (
    <section {...stylex.attrs(s.sec)} data-perf="analyse-analysis">
      <div {...stylex.attrs(s.row)}>
        <b>Analysis</b>
        <span {...stylex.attrs(s.small, s.muted)} title={fullDate(props.a.createdAt)}>
          at <code {...stylex.attrs(s.code)}>{short(props.a.headSha)}</code>, {since(props.a.createdAt)}
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
