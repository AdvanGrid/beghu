// The PR view (#181): `/:owner/:repo/pull/:number/view`, full screen in the app's chrome, its own
// chunk. The router starts the analysis graph's fetch alongside this chunk's import, and the
// PR's detail, which the live facts come from (the head, how far behind, the run's state), as the
// panel reads it; the claims' fetch starts as soon as the graph is in.
//
// - The top bar: "← ‹repo›#‹n›" (back to the PR panel), the PR's title, "analysed at ‹short SHA›,
//   ‹age›", the amber "N commits behind" chip (or "outdated"), and Analyse again, or the live
//   run's state, which opens the panel's popover (no End run here). Then the tabs.
// - The graph failing: the route's boundary replaces the canvas and the panel with the error and
//   Retry; the chrome and the top bar stay. No analysis (`NoAnalysis`): a centred empty state with
//   the start; the `analysis` push that says an upload was accepted loads it.
//   `AnalysisMigrationFailed`: its own message.
// - A newer upload while it's open: an accent pill, "A newer analysis is ready · Show it", never
//   swapped by itself. Show it refetches the graph and claims and keeps the reader's place where
//   the selection's ID survives (forward.ts), else the level above.
// - The canvas (a placeholder until slice 8) beside the panel, which follows the selection and is
//   resizable as the issue panel is.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, Loading, onSettled, refresh, Show, untrack, type Accessor } from "solid-js";
import { revalidate, useLocation, useNavigate, type RouteSectionProps } from "@solidjs/router";
import { AnalysisMigrationFailed, getIssue, getIssueAt, NoAnalysis, type IssueDetail } from "../api";
import { AnalyseButton, AnalyseStart } from "../Analyse";
import { getGraph, takePreloaded, type Graph } from "../analysis";
import { at, atString, idAt, parseAt } from "../at";
import { onAnalysis, onPush } from "../live";
import { Failure } from "../Root";
import { ago, fullDate } from "../time";
import { colors, fonts, media } from "../tokens.stylex";
import { Canvas } from "./Canvas";
import { ClaimsProvider, createClaims } from "./claims";
import { forward } from "./forward";
import { buildModel, type Model } from "./model";
import { NavContext, type Nav } from "./nav";
import { Panel } from "./Panel";
import { parseState, sameSel, selString, writeState, type Replacing, type Sel, type Tab } from "./state";
import { ui } from "./ui";

/** The PR's detail, as the panel reads it: by id once the tab knows it, else by where it is. */
function readDetail(where: string): Promise<IssueDetail> {
  const a = parseAt(where);
  const id = a && untrack(() => idAt(a));
  return id === undefined ? getIssueAt(where) : getIssue(id);
}

/** Whether an `analysis` push (`owner/name`, number) names the PR at `where`. */
function names(where: string, repo: string, number: number): boolean {
  const p = parseAt(where);
  return p !== undefined && `${repo}#${number}`.toLowerCase() === `${p.owner}/${p.repo}#${p.number}`.toLowerCase();
}

/** The view's history state: where its ← goes back to (the PR panel, with the list's view). */
type Back = { back?: string };

export function PrView(props: RouteSectionProps) {
  const where = createMemo(() => atString(at(props.params.owner ?? "", props.params.repo ?? "", props.params.number ?? "")));
  // The first reads are the route preload's, as it started them; any after (a Retry, Show it,
  // another PR) go through the query cache.
  const graph = createMemo(() => untrack(() => takePreloaded(where(), "graph")) ?? getGraph(where()));
  const detail = createMemo(() => untrack(() => takePreloaded(where(), "detail")) ?? readDetail(where()));
  /** Reads the graph afresh: Retry, Show it, an upload accepted while there was none. */
  const reload = () => {
    revalidate(getGraph.keyFor(where()));
    void refresh(graph);
  };
  /** Reads the PR's detail afresh: a Retry of it (the live stream's pushes clear the cache). */
  const reloadDetail = () => {
    revalidate([getIssue.key, getIssueAt.key]);
    void refresh(detail);
  };
  // An `analysis` push naming the PR, or the stream's `reset` (anything read before may be stale,
  // and a push may have been missed): its detail again (the run's state, how far behind, and the
  // PR's analysis, which says when a newer one than the one shown is ready). Never the graph:
  // a newer analysis waits for Show it.
  onSettled(() => {
    const offAnalysis = onAnalysis((a) => {
      if (names(where(), a.repo, a.number)) void refresh(detail);
    });
    const offPush = onPush((p) => {
      if (p.kind === "reset" || p.kind === "roles") void refresh(detail);
    });
    return () => {
      offAnalysis();
      offPush();
    };
  });
  return (
    <div {...stylex.attrs(s.view)} data-perf="pr-view">
      <TopBar where={where()} graph={graph} detail={detail} />
      <Errored fallback={(err, reset) => <GraphFailure error={err()} where={where()} detail={detail} reload={reload} reloadDetail={reloadDetail} reset={reset} />}>
        <Loading fallback={<div {...stylex.attrs(s.loading)} aria-busy="true" data-perf="view-loading" />}>
          <Body graph={graph} detail={detail} where={where()} reload={reload} />
        </Loading>
      </Errored>
    </div>
  );
}

const short = (sha: string) => sha.slice(0, 7);

function TopBar(props: { where: string; graph: Accessor<Graph>; detail: Accessor<IssueDetail> }) {
  const location = useLocation<Back>();
  const pr = () => parseAt(props.where);
  const back = () => location.state?.back ?? `/${pr()?.owner}/${pr()?.repo}/pull/${pr()?.number}`;
  return (
    <header {...stylex.attrs(s.bar)} data-perf="view-bar">
      <a href={back()} {...stylex.attrs(s.back)} data-perf="view-back">
        ← {pr()?.repo}#{pr()?.number}
      </a>
      <Errored fallback={null}>
        <Loading fallback={<span {...stylex.attrs(s.title)} />}>
          <span {...stylex.attrs(s.title)} data-perf="view-title" title={props.detail().title}>
            {props.detail().title}
          </span>
        </Loading>
      </Errored>
      <Errored fallback={null}>
        <Loading fallback={null}>
          <Analysed graph={props.graph()} detail={props.detail()} />
        </Loading>
      </Errored>
      <span {...stylex.attrs(s.spacer)} />
      <nav role="tablist" aria-label="Explorers" {...stylex.attrs(s.tabs)}>
        {/* Path's tab comes with slice 10. */}
        <span role="tab" aria-selected="true" {...stylex.attrs(s.tab, s.tabOn)} data-perf="tab-canvas">
          Canvas
        </span>
      </nav>
    </header>
  );
}

/** "analysed at ‹short SHA›, ‹age›", how far behind, and Analyse again or the live run. */
function Analysed(props: { graph: Graph; detail: IssueDetail }) {
  const [tick, setTick] = createSignal(0);
  onSettled(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  });
  // The detail's own summary says how far behind only for the analysis shown.
  const behind = () => {
    const a = props.detail.pr?.analysis;
    return a && a.id === props.graph.id ? a.behind : undefined;
  };
  return (
    <>
      <span {...stylex.attrs(ui.muted, ui.small, s.nowrap)} title={fullDate(props.graph.createdAt)} data-perf="view-analysed">
        analysed at <code {...stylex.attrs(ui.mono)}>{short(props.graph.headSha)}</code>, {(tick(), since(props.graph.createdAt))}
      </span>
      <Show when={behind() !== undefined && behind() !== "counting" && behind()}>
        {(b) => (
          <span {...stylex.attrs(ui.warnChip)} data-perf="view-behind" title={b() === "outdated" ? "The analysed head is no longer among the PR's commits" : "The PR has moved past the analysed head"}>
            {b() === "outdated" ? "outdated" : `${b()} ${b() === 1 ? "commit" : "commits"} behind`}
          </span>
        )}
      </Show>
      <AnalyseButton d={props.detail} inView />
    </>
  );
}

const since = (t: number) => {
  const a = ago(t);
  return a === "now" ? "just now" : `${a} ago`;
};

/**
 * The graph didn't load: no analysis yet (the empty state, with the start), a migration that
 * failed (its own message), or another failure (Retry). Signed out, to sign in.
 */
function GraphFailure(props: { error: unknown; where: string; detail: Accessor<IssueDetail>; reload: () => void; reloadDetail: () => void; reset: () => void }) {
  const retry = () => {
    props.reload();
    props.reset();
  };
  return (
    <Failure error={props.error}>
      <Show
        when={props.error instanceof NoAnalysis}
        fallback={
          <div {...stylex.attrs(s.failed)} role="alert" data-perf="view-failed">
            <p {...stylex.attrs(ui.p)}>
              {props.error instanceof AnalysisMigrationFailed
                ? "beghu couldn't bring this analysis up to its current shape. That's a bug on beghu's side; the analysis is kept as it was."
                : "Couldn't load the analysis"}{" "}
              ·{" "}
              <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={retry}>
                Retry
              </button>
            </p>
          </div>
        }
      >
        <NoAnalysisYet where={props.where} detail={props.detail} load={retry} reloadDetail={props.reloadDetail} />
      </Show>
    </Failure>
  );
}

/** `NoAnalysis`: the empty state, with the start; an accepted upload's push loads it. */
function NoAnalysisYet(props: { where: string; detail: Accessor<IssueDetail>; load: () => void; reloadDetail: () => void }) {
  onSettled(() =>
    onAnalysis((a) => {
      if (a.analysis !== undefined && names(props.where, a.repo, a.number)) props.load();
    }),
  );
  return (
    <div {...stylex.attrs(s.empty)} data-perf="no-analysis">
      <h2 {...stylex.attrs(s.emptyTitle)}>No analysis of this PR yet</h2>
      <p {...stylex.attrs(ui.p)}>
        beghu never reads your code. Your own agent does: it checks out the PR, maps its parts, what it's for and where it contradicts itself,
        and uploads the map here. Only you can see it.
      </p>
      {/* The start needs the PR's detail (its run, what to pin): without it, say so, with Retry. */}
      <Errored
        fallback={(err, reset) => (
          <Failure error={err()}>
            <p {...stylex.attrs(ui.p, ui.muted)} role="alert" data-perf="no-analysis-failed">
              Couldn't load the PR's details, so the run can't start from here ·{" "}
              <button
                type="button"
                {...stylex.attrs(ui.pick, ui.pickAccent)}
                onClick={() => {
                  props.reloadDetail();
                  reset();
                }}
              >
                Retry
              </button>
            </p>
          </Failure>
        )}
      >
        <Loading fallback={<div {...stylex.attrs(s.startLoading)} aria-busy="true" />}>
          <AnalyseStart d={props.detail()} />
        </Loading>
      </Errored>
    </div>
  );
}

/** Below this width the panel goes under the canvas. */
const NARROW = 900;
/** The narrowest either side of the divider may be. */
const MIN_SIDE = 320;
const DIVIDER = 4;
/** Where this device keeps the panel's width. */
const WIDTH_KEY = "beghu.pr-view-panel";

function readWidth(): number | undefined {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeWidth(w: number | undefined): void {
  try {
    if (w === undefined) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // Kept for this page only.
  }
}

/** The analysis on screen: the canvas and the panel, the newer-analysis pill, and the URL's state. */
function Body(props: { graph: Accessor<Graph>; detail: Accessor<IssueDetail>; where: string; reload: () => void }) {
  const location = useLocation<Back>();
  const navigate = useNavigate();
  const model = createMemo(() => buildModel(props.graph()));
  const claims = createClaims(() => model().g.claimsUrl);
  const st = createMemo(() => parseState(location.search));

  /** The analysis being left by Show it: the selection's place is kept against it. */
  const [leaving, setLeaving] = createSignal<Model>();
  /**
   * The forwarding note on screen, with the URL's `sel` it was made from and the one it forwarded
   * to: it stays while the URL says either, and goes with the next pick, or when Back or Forward
   * moves the URL's selection anywhere else.
   */
  const [note, setNote] = createSignal<{ text: string; from: string; to: string }>();
  /**
   * A newer analysis than the one shown: its ID, from the `analysis` push, or from the PR's
   * detail, read again on the stream's `reset` (a push missed while the stream was down).
   */
  const [newer, setNewer] = createSignal<string>();
  const urlSel = createMemo(() => {
    const v = st().sel;
    return v ? selString(v) : "";
  });
  createEffect(urlSel, (now) => {
    const n = untrack(note);
    if (n && now !== n.from && now !== n.to) setNote(undefined);
  });

  const forwarded = createMemo(() => forward(st().sel, model(), leaving()));
  const sel = createMemo(() => forwarded().sel, { equals: sameSel });

  // A selection this analysis doesn't have went where `carried` says: the URL says so too (in
  // place of its entry), and the note says why.
  createEffect(forwarded, (f) => {
    untrack(() => {
      const was = st().sel;
      if (leaving()) setLeaving(undefined);
      if (sameSel(was, f.sel)) return;
      if (f.note) setNote({ text: f.note, from: was ? selString(was) : "", to: f.sel ? selString(f.sel) : "" });
      go({ ...st(), sel: f.sel }, true);
    });
  });

  const go = (next: ReturnType<typeof parseState>, replace: boolean) => {
    const url = location.pathname + writeState(next);
    if (url === location.pathname + location.search) return;
    navigate(url, { replace, scroll: false, state: location.state });
  };

  const nav: Nav = {
    state: st,
    sel,
    model,
    select: (to: Sel | undefined) => {
      setNote(undefined);
      if (sameSel(to, sel())) return;
      go({ ...st(), sel: to }, false);
    },
    tab: (tab: Tab) => go({ ...st(), tab }, false),
    set: (key: Replacing, value: string | undefined) => go({ ...st(), [key]: value }, true),
  };

  // An `analysis` push naming this PR with another analysis than the one shown: a newer upload.
  onSettled(() =>
    onAnalysis((a) => {
      if (a.analysis !== undefined && names(props.where, a.repo, a.number) && a.analysis !== untrack(model).g.id) setNewer(a.analysis);
    }),
  );
  createEffect(
    () => model().g.id,
    (id) => {
      if (untrack(newer) === id) setNewer(undefined);
    },
  );

  const showIt = () => {
    setLeaving(untrack(model));
    setNewer(undefined);
    props.reload();
  };

  // The panel's width, kept on this device, and the divider that sets it.
  const [preferred, setPreferred] = createSignal(readWidth());
  const [room, setRoom] = createSignal(0);
  const [narrow, setNarrow] = createSignal(false);
  const width = () => {
    const total = room() - DIVIDER;
    const want = preferred() ?? Math.max(MIN_SIDE, total * 0.4);
    return Math.round(Math.max(MIN_SIDE, Math.min(want, total - MIN_SIDE)));
  };
  let row!: HTMLDivElement;
  onSettled(() => {
    const ro = new ResizeObserver(() => {
      setRoom(row.clientWidth);
      setNarrow(window.innerWidth < NARROW);
    });
    ro.observe(row);
    setRoom(row.clientWidth);
    setNarrow(window.innerWidth < NARROW);
    const onStorage = (e: StorageEvent) => {
      if (e.key === WIDTH_KEY) setPreferred(readWidth());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      ro.disconnect();
      window.removeEventListener("storage", onStorage);
    };
  });
  const drag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const right = row.getBoundingClientRect().right;
    const move = (m: PointerEvent) => setPreferred(right - m.clientX);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      writeWidth(width());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };

  return (
    <NavContext value={nav}>
      <ClaimsProvider read={claims}>
        <div ref={row} {...stylex.attrs(s.body)} data-perf="view-body" data-analysis={model().g.id}>
          <Errored fallback={null}>
            <Loading fallback={null}>
              <DetailSaysNewer detail={props.detail} model={model} newer={setNewer} />
            </Loading>
          </Errored>
          <Show when={newer()}>
            <div {...stylex.attrs(s.newer)} role="status" data-perf="newer">
              A newer analysis is ready
              <button type="button" {...stylex.attrs(s.newerButton)} onClick={showIt}>
                Show it
              </button>
            </div>
          </Show>
          <div {...stylex.attrs(s.canvasSlot)} role="tabpanel" aria-label="Canvas">
            <Canvas />
          </div>
          <Show when={!narrow()}>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the panel"
              aria-valuemin={MIN_SIDE}
              aria-valuemax={Math.max(MIN_SIDE, room() - DIVIDER - MIN_SIDE)}
              aria-valuenow={width()}
              title="Drag to resize; double-click to reset"
              {...stylex.attrs(s.divider)}
              onPointerDown={drag}
              onDblClick={() => {
                setPreferred(undefined);
                writeWidth(undefined);
              }}
            />
          </Show>
          <aside aria-label="Details" {...stylex.attrs(s.panel, narrow() ? s.panelNarrow : s.panelWidth(width()))}>
            <Panel note={note()?.text} dismiss={() => setNote(undefined)} />
          </aside>
        </div>
      </ClaimsProvider>
    </NavContext>
  );
}

/**
 * The PR's detail says its analysis is newer than the one shown (an upload whose push this tab
 * missed): the pill. Only a newer one, so a detail read before Show it never offers the older.
 */
function DetailSaysNewer(props: { detail: Accessor<IssueDetail>; model: Accessor<Model>; newer: (id: string) => void }) {
  createEffect(
    () => {
      const a = props.detail().pr?.analysis;
      const g = props.model().g;
      return a && a.id !== g.id && a.createdAt >= g.createdAt ? a.id : undefined;
    },
    (id) => {
      if (id !== undefined) props.newer(id);
    },
  );
  return null;
}

const s = stylex.create({
  view: {
    backgroundColor: colors.bg,
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  bar: {
    gap: 10,
    paddingInline: 14,
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    minHeight: 40,
  },
  back: {
    textDecoration: { default: "none", ":hover": "underline" },
    color: colors.accent,
    flexShrink: 0,
    fontSize: 13,
    whiteSpace: "nowrap",
  },
  title: { overflow: "hidden", flexShrink: 1, fontSize: 14, fontWeight: 600, textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, },
  nowrap: { whiteSpace: "nowrap" },
  spacer: { flexGrow: 1 },
  tabs: { gap: 2, display: "flex" },
  tab: {
    borderRadius: 6,
    paddingBlock: 3,
    paddingInline: 10,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 600,
  },
  tabOn: { backgroundColor: colors.selected, color: colors.fg },
  loading: { flexGrow: 1 },
  failed: { padding: 24, color: colors.muted },
  empty: {
    gap: 14,
    paddingInline: 16,
    alignSelf: "center",
    display: "flex",
    flexDirection: "column",
    marginTop: "12vh",
    maxWidth: 520,
  },
  emptyTitle: { margin: 0, fontSize: 20 },
  startLoading: { height: 28 },
  body: {
    display: "flex",
    flexDirection: { default: "row", [media.stacked]: "column" },
    flexGrow: 1,
    position: "relative",
    minHeight: 0,
  },
  canvasSlot: { flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0 },
  divider: {
    backgroundColor: { default: colors.line, ":hover": colors.accent },
    cursor: "col-resize",
    flexShrink: 0,
    width: 4,
  },
  panel: { backgroundColor: colors.bg, flexShrink: 0, minHeight: 0, overflowY: "auto", },
  panelWidth: (w: number) => ({ width: w }),
  panelNarrow: { flexBasis: 0, flexGrow: 1, borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1 },
  newer: {
    borderRadius: 999,
    gap: 10,
    paddingBlock: 6,
    paddingInline: 14,
    alignItems: "center",
    backgroundColor: colors.accentBg,
    boxShadow: `0 4px 14px ${colors.popShadow}`,
    color: colors.accentFg,
    display: "flex",
    fontFamily: fonts.ui,
    fontSize: 13,
    position: "absolute",
    transform: "translateX(-50%)",
    zIndex: 5,
    left: "50%",
    top: 12,
  },
  newerButton: {
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
});
