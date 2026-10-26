// A Solid 2 adapter for @tanstack/virtual-core. @tanstack/solid-virtual 3.x is built on Solid 1
// (mergeProps, onMount, createComputed, solid-js/store), none of which Solid 2 exports, so the
// list wires the framework-free core directly. Only what IssueList uses is exposed.
import { createEffect, createSignal, onSettled } from 'solid-js';
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer, type VirtualItem } from '@tanstack/virtual-core';

export function createVirtualizer(opts: {
  count: () => number;
  getScrollElement: () => HTMLElement | null;
  estimateSize: (index: number) => number;
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
    estimateSize: opts.estimateSize,
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

  return { getVirtualItems: items, getTotalSize: totalSize };
}
