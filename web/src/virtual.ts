// The list's windowing: a Solid 2 adapter for @tanstack/virtual-core. @tanstack/solid-virtual
// is Solid 1 only, so this wires the framework-free core directly, exposing only what the list
// uses: the items in the window, the last row on screen, the total height, and scrolling a row
// into view. (virtual-fixed.ts, unused, is a smaller fallback for fixed-height rows.)
import { createEffect, createSignal, onSettled } from "solid-js";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/virtual-core";

/** While scrolling, the rows kept past the edge the scroll leaves behind; the rest of the overscan goes ahead. */
const BEHIND = 2;

export function createVirtualizer(opts: {
  count: () => number;
  getScrollElement: () => HTMLElement | null;
  size: number;
  /** Rows kept past each edge of the window at rest; while scrolling, most of both go ahead. */
  overscan: number;
}) {
  const [items, setItems] = createSignal<VirtualItem[]>([]);
  const [end, setEnd] = createSignal(-1);
  const [totalSize, setTotalSize] = createSignal(0);
  // A scroll can outrun the page's own work (the compositor scrolls on while a frame is busy), so
  // while scrolling the overscan goes where the scroll is heading: the rows coming into view are
  // there already, and as many rows are in the DOM as at rest. One extractor per direction, so a
  // change of direction (the scroll ending, or turning) is a change of option, which the core's
  // window memo sees; it doesn't see a direction the extractor would read for itself.
  const BY_DIR = { none: defaultRangeExtractor, forward: biased(BEHIND, 2 * opts.overscan - BEHIND), backward: biased(2 * opts.overscan - BEHIND, BEHIND) };
  // A scroll that keeps the same first and last row keeps the same array, so nothing that reads
  // the window runs again.
  const publish = (v: Virtualizer<HTMLElement, Element>) => {
    const extractor = BY_DIR[v.scrollDirection ?? "none"];
    if (v.options.rangeExtractor !== extractor) v.setOptions({ ...v.options, rangeExtractor: extractor });
    const next = v.getVirtualItems();
    setItems((prev) => (sameWindow(prev, next) ? prev : next));
    setEnd(v.range?.endIndex ?? -1);
    setTotalSize(v.getTotalSize());
  };
  const virtualizer = new Virtualizer<HTMLElement, Element>({
    count: 0,
    getScrollElement: opts.getScrollElement,
    estimateSize: () => opts.size,
    overscan: opts.overscan,
    rangeExtractor: BY_DIR.none,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: publish,
  });

  // A new count (another page, a refetch) re-derives the window.
  createEffect(opts.count, (count) => {
    virtualizer.setOptions({ ...virtualizer.options, count });
    virtualizer._willUpdate();
    publish(virtualizer);
  });
  onSettled(() => {
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    publish(virtualizer);
    return cleanup;
  });

  /** Scrolls the least that brings row `index` into view. */
  const scrollToIndex = (index: number) => virtualizer.scrollToIndex(index, { align: "auto" });

  return {
    items,
    /** The index of the last row on screen (not one kept past the window's edge), or -1. */
    end,
    totalSize,
    scrollToIndex,
  };
}

/** A range extractor keeping `before` rows above the window and `after` below it. */
function biased(before: number, after: number) {
  return (range: Range): number[] => {
    const start = Math.max(range.startIndex - before, 0);
    const last = Math.min(range.endIndex + after, range.count - 1);
    return Array.from({ length: Math.max(0, last - start + 1) }, (_, i) => start + i);
  };
}

/** Whether two windows hold the same rows: the same first row and as many of them. */
function sameWindow(a: VirtualItem[], b: VirtualItem[]): boolean {
  return a.length === b.length && (a.length === 0 || a[0]!.index === b[0]!.index);
}
