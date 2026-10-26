// The list's windowing: a Solid 2 adapter for @tanstack/virtual-core. @tanstack/solid-virtual
// is Solid 1 only, so this wires the framework-free core directly, exposing only what the list
// uses: the items in the window and the total height.
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
  const publish = (v: Virtualizer<HTMLElement, Element>) => {
    setItems(v.getVirtualItems());
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
