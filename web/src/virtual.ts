// The list's windowing: a Solid 2 adapter for @tanstack/virtual-core. @tanstack/solid-virtual
// is Solid 1 only, so this wires the framework-free core directly, exposing only what the list
// uses: the items in the window and the total height. (virtual-fixed.ts, unused, is a smaller
// fallback for fixed-height rows.)
import { createEffect, createSignal, onSettled } from "solid-js";
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer, type VirtualItem } from "@tanstack/virtual-core";

export function createVirtualizer(opts: {
  count: () => number;
  getScrollElement: () => HTMLElement | null;
  size: number;
  overscan: number;
}) {
  const [items, setItems] = createSignal<VirtualItem[]>([]);
  const [totalSize, setTotalSize] = createSignal(0);
  // A scroll that keeps the same first and last row keeps the same array, so nothing that reads
  // the window runs again.
  const publish = (v: Virtualizer<HTMLElement, Element>) => {
    const next = v.getVirtualItems();
    setItems((prev) => (sameWindow(prev, next) ? prev : next));
    setTotalSize(v.getTotalSize());
  };
  const virtualizer = new Virtualizer<HTMLElement, Element>({
    count: 0,
    getScrollElement: opts.getScrollElement,
    estimateSize: () => opts.size,
    overscan: opts.overscan,
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

  return { items, totalSize };
}

/** Whether two windows hold the same rows: the same first row and as many of them. */
function sameWindow(a: VirtualItem[], b: VirtualItem[]): boolean {
  return a.length === b.length && (a.length === 0 || a[0]!.index === b[0]!.index);
}
