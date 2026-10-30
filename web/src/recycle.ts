// Row recycling for the list and Tree mode: the window's rows live on a fixed pool of slots, row
// `i` on slot `i mod n`, so the window moving by a row gives one slot a new row (its computations
// run again for the new issue) and creates or disposes no node. The rows' own places stay per row.
//
// Two things follow a node no longer being an issue's for its life:
// - the DOM keeps the slots in pool order, which is a rotation of the rows' order. `sortSlots`
//   turns it back into the rows' order (for reading order and anything that walks the rows), by
//   moving the shorter side of the rotation: the slots that changed, on a small move;
// - the focus would stay on a node that now shows another issue. `refocus` moves it to the node
//   that shows the focused issue now, or lets it fall to the page, as a row leaving the window did.
import { createMemo } from "solid-js";

/**
 * The pool's slots for a window starting at row `first` with `count` rows, out of `total`: each
 * slot's row index. The pool is as big as the largest window so far; a smaller window is widened
 * to it (past its last row, or before its first at the end), so a scroll that moves the window's
 * edges by a row keeps every slot in use. Only a list shorter than the pool leaves slots out.
 */
export function createSlots(window: () => { first: number; count: number; total: number }) {
  let size = 0;
  return createMemo(() => {
    const w = window();
    if (w.count > size) size = w.count;
    const count = Math.min(size, w.total);
    const first = Math.max(0, Math.min(w.first, w.total - count));
    const out = new Array<number>(count);
    for (let i = first; i < first + count; i++) out[i % count] = i;
    return { first, slots: out as readonly number[] };
  });
}

/**
 * Puts the slots' nodes (`nodes[k]` is slot k's) in the rows' order: the slot of row `first`
 * first. A rotation (the steady state: every window change is one) moves its shorter side;
 * anything else is put in order node by node. Returns how many nodes moved.
 */
export function sortSlots(nodes: readonly (Element | undefined)[], first: number): number {
  const n = nodes.length;
  if (n < 2) return 0;
  const want: Element[] = [];
  for (let j = 0; j < n; j++) {
    const node = nodes[(first + j) % n];
    if (!node) return 0;
    want.push(node);
  }
  const parent = want[0]!.parentNode;
  if (!parent) return 0;
  // A plain move: it drops the focus of a node it moves, which `refocus` gives back. (moveBefore
  // would keep it, but scrolls the focused node into view as it moves it.)
  const move = (node: Node, ref: Node | null) => parent.insertBefore(node, ref);
  // Where the order breaks: in a rotation, once, where the DOM's first slot is.
  let breaks = 0;
  let h = 0;
  for (let j = 1; j < n; j++) {
    if (want[j]!.previousSibling !== want[j - 1]) {
      breaks++;
      h = j;
    }
  }
  if (breaks === 0) return 0;
  if (breaks === 1 && want[0]!.previousSibling === want[n - 1]) {
    // The DOM holds want[h..], then want[..h].
    if (h <= n - h) {
      for (let j = 0; j < h; j++) move(want[j]!, want[h]!);
      return h;
    }
    const after = want[h - 1]!.nextSibling;
    for (let j = h; j < n; j++) move(want[j]!, after);
    return n - h;
  }
  // Out of order otherwise (the For placed a new slot by its own order): all, before the node
  // after the last of them.
  const set = new Set<Node>(want);
  let after: Node | null = null;
  for (const node of want) {
    if (!set.has(node.nextSibling!)) {
      after = node.nextSibling;
      break;
    }
  }
  for (const node of want) move(node, after);
  return n;
}

/**
 * The focus follows the issue, not the node: when the row node that had it (or something in it)
 * before the window changed, `was`, now shows another issue than `focusedId`, the node that shows
 * `focusedId` takes it, if the window has it; otherwise it falls to the page, as when a row left
 * the window. A node that kept its issue but lost the focus to `sortSlots` moving it takes it
 * back. `scroller` holds the rows.
 */
export function refocus(scroller: HTMLElement, focusedId: string | undefined, was: Element | null): void {
  if (focusedId === undefined || !(was instanceof HTMLElement) || !scroller.contains(was)) return;
  const lost = document.activeElement !== was;
  // Lost to anything but the move (the focus went elsewhere meanwhile): not the rows' to give.
  if (lost && document.activeElement !== document.body && document.activeElement !== null) return;
  const row = was.closest<HTMLElement>('[data-perf="row"]');
  if (!row) return;
  if (row.dataset.id === focusedId) {
    if (lost) was.focus({ preventScroll: true });
    return;
  }
  const own = scroller.querySelector<HTMLElement>(`[data-perf="row"][data-id="${focusedId}"]`);
  if (own) own.focus({ preventScroll: true });
  else if (!lost) was.blur();
}
