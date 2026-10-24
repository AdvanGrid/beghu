// PROTOTYPE (beghu #52). The windowed list every variant uses: only the rows on screen (plus a
// small overscan) are in the DOM, and the next page loads as the window nears the end.
import { createMemo, For, type Element } from 'solid-js';
import { createVirtualizer } from './virtual';
import type { IssueRow } from './api';

export function Rows(props: {
  rows: IssueRow[];
  rowHeight: number;
  class?: string;
  onNearEnd: () => void;
  pulseTarget: (el: HTMLElement) => void;
  row: (r: IssueRow) => Element;
  empty?: Element;
}) {
  let scroller!: HTMLDivElement;
  const virtualizer = createVirtualizer({
    count: () => props.rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => props.rowHeight,
    overscan: 6,
  });
  const visible = createMemo(() => {
    const items = virtualizer.getVirtualItems();
    const first = items[0]?.index ?? 0;
    return { first, rows: props.rows.slice(first, first + items.length) };
  });

  return (
    <div
      ref={(el) => {
        scroller = el;
        props.pulseTarget(el);
      }}
      class={`list ${props.class ?? ''}`}
      data-rendered={visible().rows.length}
      onScroll={() => {
        const items = virtualizer.getVirtualItems();
        const last = items[items.length - 1];
        if (last && last.index > props.rows.length - 40) props.onNearEnd();
      }}
    >
      {props.rows.length === 0 ? (
        props.empty ?? <p class="empty">No issues match.</p>
      ) : (
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          <div class="window" style={{ transform: `translateY(${visible().first * props.rowHeight}px)` }}>
            <For each={visible().rows}>{(r) => props.row(r)}</For>
          </div>
        </div>
      )}
    </div>
  );
}
