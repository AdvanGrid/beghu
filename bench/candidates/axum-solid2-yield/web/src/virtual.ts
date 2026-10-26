// A solid-yield adapter for @tanstack/virtual-core. Plain Solid reactive state can't enter routine
// code (no-foreign-reactive), so the window lives in $signals written by a sync $event that the
// virtualizer's onChange calls. Only what IssueList uses is exposed.
import { $cleanup, $effect, $event, $signal, type Read, type Source } from 'solid-yield';
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer, type VirtualItem } from '@tanstack/virtual-core';

export function* createVirtualizer<Y extends Read<boolean, unknown>>(opts: {
  count: () => Generator<Y, number, any>;
  getScrollElement: () => HTMLElement | null;
  estimateSize: (index: number) => number;
  overscan: number;
}) {
  const [items, setItems] = yield* $signal<VirtualItem[]>([]);
  const [totalSize, setTotalSize] = yield* $signal(0);
  const publish = $event(function* (v: Virtualizer<HTMLElement, Element>) {
    yield* setItems(v.getVirtualItems());
    yield* setTotalSize(v.getTotalSize());
  });
  const virtualizer: Virtualizer<HTMLElement, Element> = new Virtualizer<HTMLElement, Element>({
    count: 0,
    getScrollElement: opts.getScrollElement,
    estimateSize: opts.estimateSize,
    overscan: opts.overscan,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: (v) => void publish(v),
  });

  // A new count (another page, a refetch) re-derives the window.
  yield* $effect(opts.count, function* (count) {
    virtualizer.setOptions({ ...virtualizer.options, count });
    virtualizer._willUpdate();
    yield* publish(virtualizer);
  });
  yield* $effect(
    function* () {},
    function* () {
      const cleanup = virtualizer._didMount();
      virtualizer._willUpdate();
      yield* publish(virtualizer);
      yield* $cleanup(cleanup);
    },
  );

  return { items: items as Source<VirtualItem[]>, totalSize: totalSize as Source<number> };
}
