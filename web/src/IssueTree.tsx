// Tree mode (`?mode=tree`, #108): the view's issues nested under their parents, sub-issues in
// GitHub's order. Its own chunk (Root.tsx loads it when the URL asks for the tree). The server
// builds the tree (crates/server/src/tree.rs): roots in the view's sort (or by the best Match in
// their subtree), each followed by what it shows open, depth first, which this lists as the list
// does its rows: 34 px rows, only those on screen in the DOM, more roots loading near the end, a
// live push refetching through the last root in one request.
//
// A live change to the order (a node moving, arriving or leaving) is a held change, as in the
// list (held.ts): row contents update at once, the order waits while the user may be about to act
// and then applies behind the shift cue. What the user starts shows at once: switching to the
// tree, another view, opening or closing a node (here or in another tab), a drop, the next roots.
//
// - A chevron opens one level; Shift- or Alt-click opens the whole subtree (and on an open node,
//   closes it and everything under it). What's open is kept per query on this device (expand.ts).
// - Context, the ancestors shown only for a match below them, is dimmed but selectable, and opens
//   by default, so a filtered tree arrives opened along each path to a match.
// - The keys are the list's (↑ ↓ Home End, j/k) and the tree's: → opens a closed node or steps to
//   an open one's first child, ← closes an open node or steps out to its parent.
// - A row's grip drags it (mouse only, as the spec has it for v1): its top or bottom edge places it
//   beside a row, its middle nests it under one. Where GitHub would refuse it, the drop marker says
//   why (the server's reasons, `/api/tree/drop`) and dropping does nothing. A drop is a write of the
//   detail's own kinds (`sub_reorder`, `sub_add` moving it, `sub_remove`), shown at once.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Loading, onCleanup, onSettled, Show, untrack } from "solid-js";
import { useNavigate, usePreloadRoute } from "@solidjs/router";
import { SessionEnded, checkDrop, getMe, fetchTree, getTree, readAt, signIn, stamp, treeUrl, type IssueOp, type IssueRow, type TreeNode, type TreePage } from "./api";
import type { Related } from "./bindings/Related";
import type { Repo } from "./bindings/Repo";
import { createColumns } from "./columns";
import { opensKey, opensNow, opensOf, setOpens, used, type Opens } from "./expand";
import { CardLayer, createCard, keepsSelection, ListHead, PULSE_AFTER_MS, ROW_HEIGHT, Row, type Card, type Cols, type TreeLook } from "./IssueList";
import { applyNextAtOnce, createHeld } from "./held";
import { touch } from "./keys";
import { coalesced, onPush, writesPaused } from "./live";
import { overlay, type SubMove } from "./overlay";
import { queryOf, sortOf, takeModeSwitch, type SortKey } from "./query";
import { endOf, refOf } from "./related";
import { createVirtualizer } from "./virtual";
import { StillImporting } from "./WhileImporting";
import { colors, fonts } from "./tokens.stylex";

const OVERSCAN = 6;
/** Load more roots when the last row on screen gets this close to the last loaded row (as the list's). */
const NEAR_END = 45;
const PRELOAD_REST_MS = 150;
/** Each level's indent. */
const INDENT = 16;

/** The time the last column shows, as the list's. */
const TIME: Record<SortKey, { head: string; of: (r: IssueRow) => number | null }> = {
  updated: { head: "Upd.", of: (r) => r.updated_at },
  created: { head: "Opened", of: (r) => r.created_at },
  closed: { head: "Closed", of: (r) => r.closed_at },
  commented: { head: "Comm.", of: (r) => r.commented_at },
  comments: { head: "Upd.", of: (r) => r.updated_at },
};

/**
 * Whether the tree offers to drag issue `r`: not while writes are paused, and only where the
 * account's role takes relationship writes (Triage and up, `/api/me`'s per-repo `can`). The one
 * place a drag's availability is decided; a drop's own check (`/api/tree/drop`) also asks the
 * role on the parent it lands under.
 */
export function canDrag(r: IssueRow, repos: readonly Repo[]): boolean {
  if (writesPaused()) return false;
  const repo = repos.find((x) => x.owner === r.owner && x.name === r.repo);
  return repo !== undefined && (repo.can.others.includes("relationships") || repo.can.own.includes("relationships"));
}

/** Why a drop beside a root can't be made: roots follow the view's sort, not an order of their own. */
const ROOTS_SORTED = "Top-level issues follow the view's sort; remove its parent from the issue's panel";

/** `nodes` with `n`'s subtree (the rows after it, deeper than it) left out, and how many rows that was. */
function subtreeEnd(nodes: readonly TreeNode[], at: number): number {
  const depth = nodes[at]!.depth;
  let end = at + 1;
  while (end < nodes.length && nodes[end]!.depth > depth) end++;
  return end;
}

/** `nodes` with the tab's pending sub-issue moves on them (a move shows at once). */
function withMoves(nodes: readonly TreeNode[], moves: readonly SubMove[]): readonly TreeNode[] {
  let out = nodes;
  for (const m of moves) out = moved(out, m);
  return out;
}

/** `nodes` with one move on them: the child's subtree out of its place and into its new one. */
function moved(nodes: readonly TreeNode[], m: SubMove): readonly TreeNode[] {
  const from = nodes.findIndex((n) => n.row.id === m.child);
  if (from < 0) return nodes;
  const end = subtreeEnd(nodes, from);
  const moving = nodes.slice(from, end);
  const was = moving[0]!;
  let rest = [...nodes.slice(0, from), ...nodes.slice(end)];
  const count = (id: number | null, by: number) => {
    rest = rest.map((n) => (n.row.id === id ? { ...n, children: Math.max(0, n.children + by) } : n));
  };
  count(was.parent, -1);
  const shift = (depth: number, parent: number | null) => {
    const by = depth - was.depth;
    return moving.map((n, i) => ({ ...n, depth: n.depth + by, parent: i === 0 ? parent : n.parent }));
  };
  if (m.parent === null) {
    // A root now: after the top-level run it was in.
    let at = from;
    while (at < rest.length && rest[at]!.depth > 0) at++;
    return [...rest.slice(0, at), ...shift(0, null), ...rest.slice(at)];
  }
  const p = rest.findIndex((n) => n.row.id === m.parent);
  if (p < 0) return rest;
  count(m.parent, 1);
  const parent = rest[p]!;
  if (!parent.open) return rest;
  let at: number;
  if (m.after === null) at = p + 1;
  else if (m.after === undefined) at = subtreeEnd(rest, p);
  else {
    const sib = rest.findIndex((n, i) => i > p && n.row.id === m.after && n.parent === m.parent);
    at = sib < 0 ? subtreeEnd(rest, p) : subtreeEnd(rest, sib);
  }
  return [...rest.slice(0, at), ...shift(parent.depth + 1, m.parent), ...rest.slice(at)];
}

/** A row as a relationship write's look names an end. */
function relatedOf(r: IssueRow): Related {
  return {
    id: r.id,
    kind: r.kind,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title: r.title,
    state: r.state,
    state_reason: r.state_reason,
    stub: false,
    assignee: r.assignees[0]?.login ?? null,
    blocked_by: r.blocked_by,
    progress: r.progress,
    pr_status: null,
  };
}

/** Sends a drop's write through the writes code (loaded with it, as the detail's are). */
function send(op: IssueOp, issue: IssueRow, other: IssueRow, from: number | null): void {
  void import("./writes").then(
    (w) => w.sendRelationship(op, { relationship: { issue: relatedOf(issue), other: relatedOf(other), from: from ?? undefined } }),
    // The code didn't load: nothing was sent, and the row stays where it was.
    () => undefined,
  );
}

export function IssueTree(props: { search: string; openId?: number }) {
  const query = () => queryOf(props.search);
  // The toggle switched to the tree: the selection stays, or moves to the nearest node that shows.
  const switched = takeModeSwitch();
  const navigate = useNavigate();
  const [pulse, setPulse] = createSignal(false);
  let generation = 0;
  let waitingSince: number | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  /** The expand state this tab last set (`opensKey`): that one needs no refetch. */
  let mine: string | undefined;
  const [page, setPage] = createSignal<TreePage>(() => {
    const gen = ++generation;
    const search = props.search;
    const opens = opensNow(queryOf(search));
    const sel = gen === 1 && switched ? untrack(() => props.openId) : undefined;
    const fetched = getTree(treeUrl(search, opens, sel === undefined ? {} : { sel: String(sel) }));
    if (gen > 1) {
      waitingSince ??= performance.now();
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => setPulse(true), Math.max(0, waitingSince + PULSE_AFTER_MS - performance.now()));
      const landed = () => {
        if (gen !== generation) return;
        clearTimeout(pulseTimer);
        waitingSince = undefined;
        setPulse(false);
      };
      fetched.then(landed, landed);
    }
    return fetched;
  });
  const time = createMemo(() => TIME[sortOf(query()).key]);
  // The account's repos and what it may do in each: which issues the tree offers to drag.
  const me = createMemo(() => getMe());
  // The tab's sub-issue moves, shown at once: the user's own drops.
  const moves = createMemo(() => overlay()?.subMoves(readAt(page())) ?? []);

  // What's on screen and for which view, once loaded: where a refetch starts from.
  let shown: { view: string; page: TreePage } | undefined;
  let waitingForShown: (() => void)[] = [];
  const recordShown = (view: string, p: TreePage) => {
    shown = { view, page: p };
    untrack(overlay)?.listShown(readAt(p));
    for (const f of waitingForShown.splice(0)) f();
  };
  createEffect(
    () => ({ view: props.search, page: page(), open: props.openId }),
    (now, prev) => {
      recordShown(now.view, now.page);
      // A view the tab comes to is the newest used (not every refetch of it).
      if (prev?.view !== now.view) untrack(() => used(queryOf(now.view)));
      // The toggle's selection: it stays if it shows, or moves to the nearest ancestor that does.
      const open = now.open;
      if (prev === undefined && switched && now.page.selected !== null && open !== undefined && now.page.selected !== open) {
        const to = now.page.selected;
        queueMicrotask(() => navigate(`/issues/${to}${now.view}`, { replace: true, scroll: false }));
      }
    },
  );
  // What the user wrote to from the panel keeps the tree's selection only while the panel stays
  // on it (writes.tsx), as in the list.
  createEffect(
    () => ({ o: overlay(), open: props.openId }),
    ({ o, open }) => o?.panelOn(open),
  );
  const signInIfEnded = (e: unknown) => {
    if (e instanceof SessionEnded) signIn();
  };
  /** Counts the changes the user started: each shows at once, never held. */
  const [edits, setEdits] = createSignal(0);
  /** Replaces the page shown, keeping when its read began: a change the user started. */
  const edit = (f: (nodes: readonly TreeNode[]) => readonly TreeNode[]) => {
    const p = untrack(page);
    const next = stamp({ ...p, nodes: [...f(p.nodes)] }, readAt(p));
    setPage(next);
    setEdits((n) => n + 1);
    recordShown(untrack(() => props.search), next);
  };

  let refetchesStarted = 0;
  let refetching: Promise<void> | undefined;
  let loadingMore = false;
  const loadMore = async () => {
    if (loadingMore) return;
    loadingMore = true;
    const view = untrack(() => props.search);
    try {
      for (;;) {
        while (refetching) await refetching;
        const have = untrack(page);
        if (!have.next || view !== untrack(() => props.search)) return;
        const started = refetchesStarted;
        const more = await fetchTree(treeUrl(view, opensNow(queryOf(view)), { after: have.next }));
        if (view !== untrack(() => props.search)) return;
        if (started === refetchesStarted) {
          const next = stamp({ ...have, nodes: [...untrack(page).nodes, ...more.nodes], next: more.next, last: more.last }, readAt(have));
          setPage(next);
          recordShown(view, next);
          return;
        }
      }
    } catch (e) {
      signInIfEnded(e);
    } finally {
      loadingMore = false;
    }
  };

  /** The next refetch brings a change the user started (in another tab): it shows at once. */
  let atOnceNext = false;
  const refetch = coalesced(async () => {
    const atOnce = atOnceNext;
    atOnceNext = false;
    const now = () => untrack(() => props.search);
    while (shown?.view !== now()) await new Promise<void>((r) => waitingForShown.push(r));
    const { view, page: have } = shown;
    refetchesStarted++;
    let done!: () => void;
    refetching = new Promise<void>((r) => (done = r));
    try {
      const opens = opensNow(queryOf(view));
      const fresh = await fetchTree(treeUrl(view, opens, have.last ? { through: have.last } : {}));
      if (view !== now()) return;
      setPage(fresh);
      if (atOnce) setEdits((n) => n + 1);
      recordShown(view, fresh);
    } catch (e) {
      signInIfEnded(e);
      throw e;
    } finally {
      refetching = undefined;
      done();
    }
  });
  onSettled(() =>
    onPush((p) => {
      // Back restored the page: its refetched order applies at once (held.ts).
      if (p.kind === "reset" && p.restored) applyNextAtOnce();
      if (p.kind !== "defs") void refetch();
    }),
  );
  // Another tab changed this query's expand state: the tree follows it.
  createEffect(
    () => opensKey(opensOf(query())),
    (key, prev) => {
      if (prev === undefined || key === prev || key === mine) return;
      atOnceNext = true;
      void refetch();
    },
  );

  /** Stores `query`'s expand state as this tab changed it. */
  const store = (opens: Opens) => (mine = opensKey(setOpens(untrack(query), opens)));

  /** Opens or closes node `n`; `deep`, its whole subtree too. */
  const toggle = async (n: TreeNode, deep: boolean) => {
    const view = untrack(() => props.search);
    const o = opensNow(queryOf(view));
    const open = new Set(o.open);
    const shut = new Set(o.shut);
    const setOpen = (x: { row: IssueRow; context: boolean }, to: boolean) => {
      if (to) {
        shut.delete(x.row.id);
        if (!x.context) open.add(x.row.id);
      } else {
        open.delete(x.row.id);
        if (x.context) shut.add(x.row.id);
      }
    };
    const id = n.row.id;
    const at = () => untrack(page).nodes.findIndex((x) => x.row.id === id);
    if (n.open) {
      const nodes = untrack(page).nodes;
      const i = at();
      if (i < 0) return;
      setOpen(n, false);
      if (deep) for (const x of nodes.slice(i + 1, subtreeEnd(nodes, i))) setOpen(x, false);
      store({ open: [...open], shut: [...shut] });
      edit((ns) => {
        const j = ns.findIndex((x) => x.row.id === id);
        return j < 0 ? ns : [...ns.slice(0, j), { ...ns[j]!, open: false }, ...ns.slice(subtreeEnd(ns, j))];
      });
      return;
    }
    if (n.children === 0) return;
    setOpen(n, true);
    store({ open: [...open], shut: [...shut] });
    // Open at once; its children follow when they land.
    edit((ns) => ns.map((x) => (x.row.id === id ? { ...x, open: true } : x)));
    try {
      const under = await fetchTree(treeUrl(view, { open: [...open], shut: [...shut] }, deep ? { under: String(id), all: "1" } : { under: String(id) }));
      if (view !== untrack(() => props.search)) return;
      if (deep) {
        // Over the state as it is now: another change may have come meanwhile.
        const now = opensNow(queryOf(view));
        open.clear();
        shut.clear();
        for (const x of now.open) open.add(x);
        for (const x of now.shut) shut.add(x);
        setOpen(n, true);
        for (const x of under.nodes) if (x.open) setOpen(x, true);
        store({ open: [...open], shut: [...shut] });
      }
      edit((ns) => {
        const j = ns.findIndex((x) => x.row.id === id);
        // Closed again meanwhile, or a refetch brought its children already.
        if (j < 0 || !ns[j]!.open || (ns[j + 1]?.parent === id && !deep)) return ns;
        const base = ns[j]!.depth + 1;
        const kids = under.nodes.map((x) => ({ ...x, depth: x.depth + base }));
        return [...ns.slice(0, j + 1), ...kids, ...ns.slice(subtreeEnd(ns, j))];
      });
    } catch (e) {
      signInIfEnded(e);
      // It shows closed again: a click tries again.
      setOpen(n, false);
      store({ open: [...open], shut: [...shut] });
      edit((ns) => ns.map((x) => (x.row.id === id ? { ...x, open: false } : x)));
    }
  };

  let column!: HTMLDivElement;
  const [listWidth, setListWidth] = createSignal(0);
  onSettled(() => {
    const ro = new ResizeObserver(() => setListWidth(column.clientWidth));
    ro.observe(column);
    setListWidth(column.clientWidth);
    return () => ro.disconnect();
  });
  const cols = createColumns(listWidth);
  const card = createCard();

  return (
    <>
      <div ref={column} {...stylex.attrs(s.column)}>
        <ListHead cols={cols} time={time().head} />
        <div {...stylex.attrs(s.frame, pulse() && s.pulse)} data-perf="list-frame" aria-busy={pulse() ? "true" : undefined}>
          <Loading fallback={<div {...stylex.attrs(s.scroller)} data-perf="tree" aria-busy="true" />}>
            <Nodes
              nodes={withMoves(page().nodes, moves())}
              version={`${edits()}.${moves().length}`}
              readStart={readAt(page())}
              search={props.search}
              openId={props.openId}
              more={page().next !== null}
              onNearEnd={loadMore}
              toggle={toggle}
              drags={(r) => canDrag(r, me().repos)}
              time={time().of}
              cols={cols}
              card={card}
            />
          </Loading>
        </div>
      </div>
      <CardLayer card={card} search={props.search} />
    </>
  );
}

/** Where a drag would drop: beside a row (before or after it), or under it. */
type Drop = { id: number; zone: "before" | "after" | "inside" };

/** What a drop does: a write, or nothing (it's where it was), or a refusal with its reason. */
type Plan = { op: IssueOp; issue: IssueRow; check: { child: number; parent: number } } | { none: true } | { why: string };

function Nodes(props: {
  nodes: readonly TreeNode[];
  /** Bumped by each change the user starts (opening, closing, a drop): it shows at once. */
  version: string;
  readStart: number;
  search: string;
  openId?: number;
  more: boolean;
  onNearEnd: () => void;
  toggle: (n: TreeNode, deep: boolean) => void;
  /** Whether the tree offers to drag this issue (`canDrag`). */
  drags: (r: IssueRow) => boolean;
  time: (r: IssueRow) => number | null;
  cols: Cols;
  card: Card;
}) {
  let scroller!: HTMLDivElement;
  // The nodes in the order shown: a live change to the order is held while the user may be about
  // to act, as the list's rows are (held.ts); a change the user starts shows at once. When a batch
  // takes the selected issue out of the tree, the selection goes to the issue that took its row,
  // unless the panel needs it kept.
  const held = createHeld({
    target: () => props.nodes.map((n) => ({ id: n.row.id, n })),
    view: () => `${props.search}#${props.version}`,
    scroller: () => scroller,
    pitch: ROW_HEIGHT,
    region: (t) => t.closest('[data-perf="card"]') !== null,
    onApplied: ({ gone, taker }) => {
      const was = untrack(selected);
      if (was === undefined || !gone.has(was)) return;
      const next = taker(was);
      if (next === undefined) return;
      void keepsSelection(was).then((keep) => {
        if (keep || untrack(selected) !== was) return;
        chosenNow = next.id;
        setChosen(next.id);
        if (going === undefined) go(next.id);
      });
    },
  });
  const nodes = createMemo(() => held.rows().map((r) => r.n));
  const v = createVirtualizer({
    count: () => nodes().length,
    getScrollElement: () => scroller,
    size: ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const visible = createMemo(() => {
    const items = v.items();
    const first = items[0]?.index ?? 0;
    return { first, nodes: nodes().slice(first, first + items.length) };
  });
  /** Each node's place among its siblings (from 1), and how many there are (-1 for roots while more load). */
  const places = createMemo(() => {
    const seen = new Map<number | null, number>();
    const out = new Map<number, { pos: number; of: number }>();
    for (const n of nodes()) {
      const pos = (seen.get(n.parent) ?? 0) + 1;
      seen.set(n.parent, pos);
      out.set(n.row.id, { pos, of: 0 });
    }
    const size = new Map<number | null, number>();
    for (const n of nodes()) size.set(n.row.id, n.children);
    for (const n of nodes()) out.get(n.row.id)!.of = n.parent === null ? (props.more ? -1 : (seen.get(null) ?? 0)) : (size.get(n.parent) ?? 0);
    return out;
  });

  // The selection, as the list keeps it (IssueList.tsx): the open issue, or the one the keys just
  // chose while it opens; it follows the issue, not the row's place.
  const navigate = useNavigate();
  const [chosen, setChosen] = createSignal<number>();
  let chosenNow: number | undefined;
  let going: number | undefined;
  const go = (id: number) => {
    going = id;
    navigate(`/issues/${id}${untrack(() => props.search)}`, { scroll: false, replace: untrack(() => props.openId) !== undefined });
  };
  createEffect(
    () => props.openId,
    (open) => {
      const next = chosenNow;
      if (going !== undefined && open === going && next !== undefined && next !== open) return queueMicrotask(() => go(next));
      going = chosenNow = undefined;
      setChosen(undefined);
    },
  );
  const selected = () => chosen() ?? props.openId;
  const index = (id = selected()) => (id === undefined ? -1 : nodes().findIndex((n) => n.row.id === id));
  const selectedShown = createMemo(() => {
    const at = index();
    const { first, nodes } = visible();
    return at >= first && at < first + nodes.length;
  });
  const from = () => {
    const at = index(chosenNow ?? props.openId);
    if (at >= 0) return at;
    const focused = document.activeElement instanceof HTMLElement && scroller.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
    return focused === undefined ? -1 : nodes().findIndex((n) => String(n.row.id) === focused);
  };
  const [focusing, setFocusing] = createSignal<number>();
  const select = (i: number) => {
    const at = Math.max(0, Math.min(i, nodes().length - 1));
    const n = nodes()[at];
    if (!n) return;
    chosenNow = n.row.id;
    setChosen(n.row.id);
    v.scrollToIndex(at);
    if (scroller.contains(document.activeElement)) setFocusing(n.row.id);
    if (going === undefined && n.row.id !== props.openId) go(n.row.id);
  };
  let hadFocus = false;
  const onFocusIn = () => (hadFocus = true);
  const away = (e: Event) => {
    if (!scroller.contains(e.target as Node)) hadFocus = false;
  };
  document.addEventListener("focusin", away);
  document.addEventListener("pointerdown", away, true);
  onCleanup(() => {
    document.removeEventListener("focusin", away);
    document.removeEventListener("pointerdown", away, true);
  });
  createEffect(
    () => {
      const { nodes } = visible();
      return { back: selectedShown() ? selected() : nodes[0]?.row.id };
    },
    ({ back }) => {
      if (!hadFocus || back === undefined || (document.activeElement !== document.body && document.activeElement !== null)) return;
      scroller.querySelector<HTMLElement>(`[data-perf="row"][data-id="${back}"]`)?.focus({ preventScroll: true });
    },
  );
  // The selection's row comes into view as the tree first shows it (a switch from the list, or a
  // link to an issue in the tree).
  // Further roots load until it's there (a few pages at most).
  let revealed = false;
  let looked = 0;
  createEffect(
    () => ({ at: index(), more: props.more && selected() !== undefined, rows: nodes().length }),
    ({ at, more }) => {
      if (revealed) return;
      if (at >= 0) {
        revealed = true;
        // Once the window has the rows that just landed.
        requestAnimationFrame(() => v.scrollToIndex(at));
      } else if (more && looked++ < 20) props.onNearEnd();
      else revealed = true;
    },
  );
  touch("next", () => select(from() < 0 ? 0 : from() + 1));
  touch("previous", () => select(from() < 0 ? 0 : from() - 1));
  touch("first", () => select(0));
  touch("last", () => select(nodes().length - 1));
  touch("toList", () => {
    const at = Math.max(from(), 0);
    const n = nodes()[at];
    if (!n) return;
    v.scrollToIndex(at);
    setFocusing(n.row.id);
  });
  // ARIA's tree keys: → opens, or steps to the first child; ← closes, or steps to the parent.
  touch("expand", () => {
    const at = from();
    const n = nodes()[at];
    if (!n || n.children === 0) return;
    if (!n.open) props.toggle(n, false);
    else if (nodes()[at + 1]?.parent === n.row.id) select(at + 1);
  });
  touch("collapse", () => {
    const at = from();
    const n = nodes()[at];
    if (!n) return;
    if (n.open) props.toggle(n, false);
    else if (n.parent !== null) select(nodes().findIndex((x) => x.row.id === n.parent));
  });

  const preload = usePreloadRoute();
  let rest: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => {
      const i = index();
      return i < 0 ? "" : [nodes()[i - 1]?.row.id, nodes()[i + 1]?.row.id].filter((id) => id !== undefined).join(",");
    },
    (ids) => {
      clearTimeout(rest);
      if (!ids) return;
      const search = untrack(() => props.search);
      rest = setTimeout(() => {
        for (const id of ids.split(",")) preload(`/issues/${id}${search}`, { preloadData: true });
      }, PRELOAD_REST_MS);
    },
  );
  onCleanup(() => clearTimeout(rest));
  createEffect(
    () => v.end() > nodes().length - NEAR_END,
    (near) => {
      if (near) props.onNearEnd();
    },
  );

  // --- drag ------------------------------------------------------------------------------------
  const [dragging, setDragging] = createSignal<number>();
  const [drop, setDrop] = createSignal<Drop>();
  /** The server's word on each drop under a parent (`child>parent`), as it comes. */
  const [checked, setChecked] = createSignal<ReadonlyMap<string, string | null>>(new Map());
  const asked = new Map<string, Promise<string | null>>();
  const ask = (child: number, parent: number): Promise<string | null> => {
    const key = `${child}>${parent}`;
    let p = asked.get(key);
    if (!p) {
      p = checkDrop(child, parent).then(
        (c) => c.why,
        // Unchecked: the write itself says if GitHub refuses it.
        () => null,
      );
      asked.set(key, p);
      void p.then((why) => setChecked((m) => new Map(m).set(key, why)));
    }
    return p;
  };
  const nodeAt = (id: number | null) => (id === null ? -1 : nodes().findIndex((n) => n.row.id === id));
  /** The row at height `y`, and which part of it: its top or bottom quarter, or its middle. */
  const under = (y: number): Drop | undefined => {
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-perf="row"][data-id]')) {
      const box = el.getBoundingClientRect();
      if (y < box.top || y >= box.bottom) continue;
      const q = box.height / 4;
      return { id: Number(el.dataset.id), zone: y < box.top + q ? "before" : y >= box.bottom - q ? "after" : "inside" };
    }
    return undefined;
  };
  /** The visible siblings under `parent`, in order. */
  const siblings = (parent: number | null) => nodes().filter((n) => n.parent === parent && (parent !== null || n.depth === 0));
  /** What dropping `id` at `d` does. */
  const plan = (id: number, d: Drop): Plan => {
    const ds = nodes()[nodeAt(id)];
    const target = nodes()[nodeAt(d.id)];
    if (!ds || !target || d.id === id) return { none: true };
    const child = ds.row;
    const oldParent = ds.parent;
    const parentNode = (pid: number | null) => nodes()[nodeAt(pid)]?.row;
    if (d.zone === "inside") {
      if (oldParent === target.row.id) {
        // To the end of its own parent's sub-issues, unless it's last already.
        const all = siblings(target.row.id);
        const last = all.filter((n) => n.row.id !== id).at(-1)?.row.id;
        if (last === undefined || all.at(-1)?.row.id === id) return { none: true };
        return { op: { kind: "sub_reorder", issue: target.row.id, child: id, after: last }, issue: target.row, check: { child: id, parent: target.row.id } };
      }
      // A move from the parent it has on GitHub, shown or not.
      return {
        op: { kind: "sub_add", issue: target.row.id, child: endOf(child), replace_parent: ds.has_parent, after: null },
        issue: target.row,
        check: { child: id, parent: target.row.id },
      };
    }
    const parent = target.parent;
    const sibs = siblings(parent).filter((n) => n.row.id !== id);
    const t = sibs.findIndex((n) => n.row.id === target.row.id);
    const after = d.zone === "after" ? target.row.id : t > 0 ? sibs[t - 1]!.row.id : null;
    // Beside a root: roots have no order of their own to place it in.
    if (parent === null) return { why: ROOTS_SORTED };
    const p = parentNode(parent);
    if (!p) return { none: true };
    if (parent === oldParent) {
      const all = siblings(parent);
      const now = all.findIndex((n) => n.row.id === id);
      const before = now > 0 ? all[now - 1]!.row.id : null;
      if (before === after) return { none: true };
      return { op: { kind: "sub_reorder", issue: parent, child: id, after }, issue: p, check: { child: id, parent } };
    }
    return {
      op: { kind: "sub_add", issue: parent, child: endOf(child), replace_parent: ds.has_parent, after, ...(after === null && { first: true }) },
      issue: p,
      check: { child: id, parent },
    };
  };
  /**
   * Where the marker is, unless a drop there does nothing, with its refusal: a reason, `null` for
   * none, `undefined` while the server is asked.
   */
  const marked = createMemo((): { drop: Drop; check?: { child: number; parent: number }; why: string | null | undefined } | undefined => {
    const id = dragging();
    const d = drop();
    if (id === undefined || !d) return undefined;
    const p = plan(id, d);
    if ("why" in p) return { drop: d, why: p.why };
    if ("none" in p) return undefined;
    if (!p.check) return { drop: d, why: null };
    const key = `${p.check.child}>${p.check.parent}`;
    return { drop: d, check: p.check, why: checked().has(key) ? checked().get(key) : undefined };
  });
  createEffect(
    () => marked()?.check,
    (c) => {
      if (c) void ask(c.child, c.parent);
    },
  );
  const endDrag = () => {
    setDragging(undefined);
    setDrop(undefined);
    // The next drag asks afresh: the tree may have changed meanwhile.
    asked.clear();
    setChecked(new Map());
  };
  const dropIt = async () => {
    const id = dragging();
    const d = drop();
    endDrag();
    if (id === undefined || !d) return;
    const p = plan(id, d);
    if (!("op" in p)) return;
    if (p.check && (await ask(p.check.child, p.check.parent)) !== null) return;
    const child = nodes()[nodeAt(id)];
    if (!child) return;
    send(p.op, p.issue, child.row, child.parent);
  };
  const markerTop = () => {
    const m = marked();
    if (!m) return 0;
    const at = nodeAt(m.drop.id);
    // After an open row: after everything under it, where the issue lands as its next sibling.
    return (m.drop.zone === "after" ? subtreeEnd(nodes(), at) : at) * ROW_HEIGHT;
  };
  const markerIndent = () => {
    const m = marked();
    const n = m ? nodes()[nodeAt(m.drop.id)] : undefined;
    return n ? 14 + (n.depth + (m!.drop.zone === "inside" ? 1 : 0)) * INDENT : 0;
  };

  return (
    <div
      ref={scroller}
      {...stylex.attrs(s.scroller, dragging() !== undefined && s.dragging)}
      role="tree"
      aria-label="Issues"
      data-keys="list"
      data-perf="tree"
      data-perf-rows={nodes().length}
      onFocusIn={onFocusIn}
      onPointerUp={() => {
        if (dragging() !== undefined) void dropIt();
      }}
      onPointerCancel={endDrag}
      onPointerMove={(e) => {
        if (dragging() === undefined) return;
        setDrop(under(e.clientY));
        // Near an edge, the tree scrolls on.
        const box = scroller.getBoundingClientRect();
        if (e.clientY < box.top + ROW_HEIGHT) scroller.scrollTop -= ROW_HEIGHT / 2;
        else if (e.clientY > box.bottom - ROW_HEIGHT) scroller.scrollTop += ROW_HEIGHT / 2;
      }}
    >
      <Show when={nodes().length > 0} fallback={<p {...stylex.attrs(s.empty)}>Nothing matches this view.</p>}>
        <div {...stylex.attrs(s.sizer(v.totalSize()))}>
          {/* The shift cue's lines, and the rows that left fading out where they were. */}
          <For each={held.cue()?.lines ?? []}>{(line) => <div data-perf="cue-line" {...stylex.attrs(s.cueLine(line * ROW_HEIGHT))} />}</For>
          <For each={held.ghosts()}>
            {(g) => (
              <div aria-hidden="true" inert data-perf="ghost" ref={(el) => held.fade(el, g)} {...stylex.attrs(s.ghost(g.y))}>
                {g.node}
              </div>
            )}
          </For>
          {/* Each row at its own place, as the list's. */}
          <For each={visible().nodes} keyed={(n) => n.row.id}>
            {(n, i) => {
              // Its place in the tree, built once: read through getters, so it follows the node,
              // and its lead (indent, grip, chevron) is one component for the row's life. (A
              // fresh object literal here would build a new lead on every read of it.)
              const tree: TreeLook = {
                get level() {
                  return n().depth + 1;
                },
                get expanded() {
                  return n().children > 0 ? n().open : undefined;
                },
                get context() {
                  return n().context;
                },
                lead: (
                  <Lead
                    node={n()}
                    dragged={dragging() === n().row.id}
                    drags={props.drags(n().row)}
                    onToggle={(deep) => props.toggle(n(), deep)}
                    onGrab={(e) => {
                      if (e.button !== 0 || e.pointerType !== "mouse" || !props.drags(n().row)) return;
                      e.preventDefault();
                      // The tree keeps the pointer while it's pressed: its moves place the
                      // marker, and letting go drops the issue there.
                      scroller.setPointerCapture(e.pointerId);
                      setDragging(n().row.id);
                    }}
                  />
                ),
              };
              return (
                <Row
                  r={n().row}
                  y={(visible().first + i()) * ROW_HEIGHT}
                  readStart={props.readStart}
                  search={props.search}
                  current={props.openId === n().row.id}
                  selected={selected() === n().row.id}
                  tabbable={selectedShown() ? selected() === n().row.id : i() === 0}
                  pos={places().get(n().row.id)?.pos ?? visible().first + i() + 1}
                  of={places().get(n().row.id)?.of ?? -1}
                  leaving={held.cue()?.leaving.has(n().row.id) ?? false}
                  takeFocus={focusing() === n().row.id}
                  onFocusTaken={() => setFocusing(undefined)}
                  time={props.time}
                  cols={props.cols}
                  card={props.card}
                  tree={tree}
                />
              );
            }}
          </For>
          <Show when={marked()}>
            {(m) => (
              <div
                data-perf="drop-marker"
                data-zone={m().drop.zone}
                data-refused={m().why ? "" : undefined}
                aria-hidden="true"
                {...stylex.attrs(m().drop.zone === "inside" ? s.nestMarker(markerTop(), markerIndent()) : s.lineMarker(markerTop(), markerIndent()), m().why ? s.refused : s.allowed)}
                title={m().why ?? undefined}
              >
                <Show when={m().why}>
                  {(why) => (
                    <span data-perf="drop-refusal" {...stylex.attrs(s.reason)}>
                      {why()}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <StillImporting />
    </div>
  );
}

/** A row's lead in the tree: its indent, its chevron (with children) and its drag grip. */
function Lead(props: { node: TreeNode; dragged: boolean; drags: boolean; onToggle: (deep: boolean) => void; onGrab: (e: PointerEvent) => void }) {
  const what = () => `${props.node.open ? "Close" : "Open"} ${refOf(props.node.row)}`;
  // A click on the chevron is the tree's, not the row link's: handled on the element, before the
  // router's listener on the document sees it (it leaves a click whose default was prevented
  // alone), and with Shift no new window opens.
  const own = (el: HTMLElement, run: (e: MouseEvent) => void) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      run(e);
    });
  return (
    <span {...stylex.attrs(s.lead, props.dragged && s.draggedLead)}>
      <span {...stylex.attrs(s.indent(props.node.depth * INDENT))} />
      <Show when={props.drags} fallback={<span {...stylex.attrs(s.gripSpace)} />}>
        <span
          aria-hidden="true"
          title="Drag to move"
          data-perf="tree-grip"
          {...stylex.attrs(s.grip)}
          onPointerDown={(e) => props.onGrab(e)}
        >
          ⠿
        </span>
      </Show>
      <Show when={props.node.children > 0} fallback={<span {...stylex.attrs(s.chevron)} />}>
        <span
          ref={(el) => own(el, (e) => props.onToggle(e.shiftKey || e.altKey))}
          aria-hidden="true"
          title={`${what()} (Shift or Alt: everything under it)`}
          data-perf="chevron"
          data-open={props.node.open ? "" : undefined}
          {...stylex.attrs(s.chevron, s.toggle)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" {...stylex.attrs(s.chevronIcon, props.node.open && s.chevronOpen)}>
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </span>
      </Show>
    </span>
  );
}

const pulseOutline = stylex.keyframes({
  from: { outlineColor: "transparent" },
  to: { outlineColor: colors.accent },
});

const s = stylex.create({
  column: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  frame: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    outlineColor: "transparent",
    outlineOffset: -2,
    outlineStyle: "solid",
    outlineWidth: 2,
    minHeight: 0,
  },
  scroller: {
    scrollbarGutter: "stable",
    contain: "strict",
    flexGrow: 1,
    // As the list's: the tree places its rows and keeps its own scroll position.
    overflowAnchor: "none",
    overflowY: "auto",
  },
  // While a drag is on, nothing in the tree selects as text.
  dragging: {
    cursor: "grabbing",
    userSelect: "none",
  },
  pulse: {
    animationDirection: "alternate",
    animationDuration: "0.6s",
    animationIterationCount: "infinite",
    animationName: pulseOutline,
    animationTimingFunction: "ease-in-out",
  },
  sizer: (height: number) => ({
    position: "relative",
    height,
  }),
  lead: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    marginInlineEnd: -6,
    marginInlineStart: -12,
  },
  // A dynamic style sets a one-word property only (see the label dot in IssueList.tsx).
  indent: (width: number) => ({
    flexShrink: 0,
    width,
  }),
  draggedLead: {
    opacity: 0.5,
  },
  grip: {
    color: colors.muted,
    cursor: "grab",
    fontSize: 11,
    opacity: {
      default: 0.35,
      ":hover": 1,
    },
    textAlign: "center",
    touchAction: "none",
    width: 12,
  },
  gripSpace: {
    width: 12,
  },
  chevron: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    justifyContent: "center",
    height: 20,
    width: 18,
  },
  toggle: {
    borderRadius: 4,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.line,
    },
    color: colors.muted,
    cursor: "pointer",
  },
  chevronIcon: {
    display: "block",
    transitionDuration: "0.1s",
    transitionProperty: "transform",
  },
  chevronOpen: {
    transform: "rotate(90deg)",
  },
  // Beside a row: a line at its top or bottom edge, indented to the level it lands at.
  lineMarker: (top: number, indent: number) => ({
    pointerEvents: "none",
    position: "absolute",
    zIndex: 2,
    borderTopStyle: "solid",
    borderTopWidth: 2,
    height: 0,
    left: indent,
    right: 0,
    top: top - 1,
  }),
  // Under a row: an outline around it.
  nestMarker: (top: number, indent: number) => ({
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 2,
    boxSizing: "border-box",
    pointerEvents: "none",
    position: "absolute",
    zIndex: 2,
    height: ROW_HEIGHT,
    left: indent - INDENT,
    right: 2,
    top,
  }),
  allowed: {
    borderColor: colors.accent,
  },
  refused: {
    borderColor: colors.danger,
  },
  // A refusal's reason, at the marker.
  reason: {
    borderRadius: 4,
    paddingBlock: 1,
    paddingInline: 6,
    backgroundColor: colors.dangerBg,
    color: colors.accentFg,
    fontFamily: fonts.ui,
    fontSize: 11.5,
    position: "absolute",
    whiteSpace: "nowrap",
    right: 8,
    top: 2,
  },
  // A row that left the tree, over the rows while it fades out (as the list's).
  ghost: (y: number) => ({
    pointerEvents: "none",
    position: "absolute",
    zIndex: 1,
    left: 0,
    right: 0,
    top: y,
  }),
  // The shift cue where a row will arrive (as the list's).
  cueLine: (y: number) => ({
    backgroundColor: colors.accent,
    pointerEvents: "none",
    position: "absolute",
    zIndex: 1,
    height: 2,
    left: 0,
    right: 0,
    top: Math.max(0, y - 1),
  }),
  empty: {
    margin: 0,
    padding: 24,
    color: colors.muted,
  },
});
