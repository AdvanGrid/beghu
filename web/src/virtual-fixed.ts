// NOT IMPORTED ANYWHERE. A size fallback for the list's windowing, to evaluate once v1 is
// complete: a drop-in for virtual.ts (same `createVirtualizer` shape) without
// @tanstack/virtual-core, which costs several KB of first-load JS. It assumes fixed-height rows:
// the window is plain arithmetic on the scroll position and the viewport's height, with no
// measuring, so rows of different heights would break it.
import { createMemo, createSignal, onSettled } from "solid-js";

/** A row in the window: its index in the list. */
export interface WindowItem {
  index: number;
}

export function createVirtualizer(opts: {
  count: () => number;
  getScrollElement: () => HTMLElement | null;
  size: number;
  overscan: number;
}) {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);

  onSettled(() => {
    const el = opts.getScrollElement();
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    setHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  /**
   * The rows on screen, and `overscan` more past either edge. A scroll that keeps the same first
   * and last row hands back the same array, so nothing that reads the window runs again.
   */
  const items = createMemo((prev: WindowItem[] | undefined): WindowItem[] => {
    const first = Math.max(0, Math.floor(scrollTop() / opts.size) - opts.overscan);
    const last = Math.min(opts.count(), Math.ceil((scrollTop() + height()) / opts.size) + opts.overscan);
    const n = Math.max(0, last - first);
    if (prev && prev.length === n && (n === 0 || prev[0]!.index === first)) return prev;
    const out: WindowItem[] = [];
    for (let i = first; i < last; i++) out.push({ index: i });
    return out;
  });

  return { items, totalSize: () => opts.count() * opts.size };
}
