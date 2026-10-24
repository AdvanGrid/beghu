// PROTOTYPE (beghu #52). The list as a collapsible sub-issue tree, shared by every variant; each
// variant passes its own row and puts `lead` (indent + chevron) at its start.
//
// - Roots are issues with no parent, sorted by the view's sort and paged; children keep GitHub's
//   sub-issue order.
// - A filter shows matches inside their ancestors, and keeps each match's whole subtree (in the
//   view's state) reachable below it; rows that don't match are dimmed. With a filter on, the tree
//   arrives opened along every path to a match, and matches themselves arrive closed; with none,
//   it arrives collapsed.
// - Click the chevron to open one level; Shift/Alt-click opens or closes the whole subtree.
// - Only the rows on screen render, like the flat list.
import { createEffect, createMemo, createSignal, For, type Element } from 'solid-js';
import { createVirtualizer } from './virtual';
import { fetchTree, type TreeNode } from './api';
import { filterCount, type View } from './view';
import type { Ctx } from './App';

type Flat = { node: TreeNode; depth: number };
const INDENT = 20;

export function TreeRows(props: { ctx: Ctx; rowHeight: number; row: (r: TreeNode, lead: Element) => Element }) {
  const c = props.ctx;
  const [roots, setRoots] = createSignal<TreeNode[]>([]);
  const [kids, setKids] = createSignal<ReadonlyMap<number, TreeNode[]>>(new Map());
  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = createSignal<ReadonlySet<number>>(new Set());
  const [ready, setReady] = createSignal(false);
  let exhausted = false;
  let seq = 0;

  const filtered = (v: View) => filterCount(v) > 0;

  /** Splits a depth-first page into roots (or one parent's children) and every node's children. */
  function absorb(nodes: TreeNode[], top: number | null) {
    const byParent = new Map<number, TreeNode[]>();
    const first: TreeNode[] = [];
    for (const n of nodes) {
      if (n.parent_id === top || (top === null && n.parent_id === null)) first.push(n);
      else byParent.set(n.parent_id!, [...(byParent.get(n.parent_id!) ?? []), n]);
    }
    return { first, byParent };
  }

  async function loadRoots(v: View, keepOpen: boolean, count?: number) {
    const n = ++seq;
    const deep = filtered(v);
    const page = await fetchTree(v, { deep: deep ? 'path' : undefined, limit: Math.max(100, count ?? 0) });
    if (n !== seq) return;
    const { first, byParent } = absorb(page.nodes, null);
    exhausted = first.length < Math.max(100, count ?? 0);
    const k = new Map(keepOpen ? kids() : []);
    for (const [p, list] of byParent) k.set(p, list);
    let o: Set<number>;
    if (deep) o = new Set(byParent.keys());
    else o = keepOpen ? new Set(open()) : new Set();
    // Refetch what's open below the roots (a live push); filtered pages arrive whole.
    if (keepOpen && !deep) {
      await Promise.all(
        [...o].map(async (id) => {
          const sub = await fetchTree(v, { parent: id });
          k.set(id, sub.nodes);
        }),
      );
      if (n !== seq) return;
    }
    setRoots(first);
    setKids(k);
    setOpen(o);
    setReady(true);
    c.settle();
  }

  createEffect(c.view, (v) => void loadRoots(v, false));
  createEffect(c.live, (tick) => void (tick && loadRoots(c.view(), true, roots().length)));

  async function more() {
    if (exhausted || !ready()) return;
    const v = c.view();
    const n = seq;
    const page = await fetchTree(v, { deep: filtered(v) ? 'path' : undefined, offset: roots().length });
    if (n !== seq) return;
    const { first, byParent } = absorb(page.nodes, null);
    if (first.length < 100) exhausted = true;
    const k = new Map(kids());
    for (const [p, list] of byParent) k.set(p, list);
    setKids(k);
    if (filtered(v)) setOpen(new Set([...open(), ...byParent.keys()]));
    setRoots([...roots(), ...first]);
  }

  function descendants(id: number, out: number[] = []): number[] {
    for (const ch of kids().get(id) ?? []) {
      out.push(ch.id);
      descendants(ch.id, out);
    }
    return out;
  }

  async function toggle(node: TreeNode, deep: boolean) {
    const o = new Set(open());
    if (o.has(node.id)) {
      o.delete(node.id);
      if (deep) for (const d of descendants(node.id)) o.delete(d);
      setOpen(o);
      return;
    }
    if (!kids().has(node.id) || deep) {
      setBusy(new Set([...busy(), node.id]));
      const page = await fetchTree(c.view(), { parent: node.id, deep: deep ? 'all' : undefined });
      const { first, byParent } = absorb(page.nodes, node.id);
      const k = new Map(kids());
      k.set(node.id, first);
      for (const [p, list] of byParent) k.set(p, list);
      setKids(k);
      const b = new Set(busy());
      b.delete(node.id);
      setBusy(b);
      if (deep) for (const p of byParent.keys()) o.add(p);
    }
    o.add(node.id);
    setOpen(o);
  }

  const flat = createMemo<Flat[]>(() => {
    const out: Flat[] = [];
    const k = kids();
    const o = open();
    const walk = (list: TreeNode[], depth: number) => {
      for (const node of list) {
        out.push({ node, depth });
        if (o.has(node.id)) walk(k.get(node.id) ?? [], depth + 1);
      }
    };
    walk(roots(), 0);
    return out;
  });

  let scroller!: HTMLDivElement;
  const virtualizer = createVirtualizer({
    count: () => flat().length,
    getScrollElement: () => scroller,
    estimateSize: () => props.rowHeight,
    overscan: 6,
  });
  const visible = createMemo(() => {
    const items = virtualizer.getVirtualItems();
    const first = items[0]?.index ?? 0;
    return { first, rows: flat().slice(first, first + items.length) };
  });

  const lead = (f: Flat) => (
    <span class="tree-lead" style={{ width: `${f.depth * INDENT + 18}px` }}>
      {f.node.children > 0 ? (
        <button
          class={`chev ${open().has(f.node.id) ? 'chev-open' : ''} ${busy().has(f.node.id) ? 'chev-busy' : ''}`}
          title={`${open().has(f.node.id) ? 'Collapse' : 'Expand'} (Shift-click: whole subtree)`}
          aria-expanded={open().has(f.node.id) ? 'true' : 'false'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void toggle(f.node, e.shiftKey || e.altKey);
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" />
          </svg>
        </button>
      ) : (
        <span class="chev-none" />
      )}
    </span>
  );

  return (
    <div
      ref={(el) => {
        scroller = el;
        c.pulseTarget(el);
      }}
      class="list tree"
      data-rendered={visible().rows.length}
      onScroll={() => {
        const items = virtualizer.getVirtualItems();
        const last = items[items.length - 1];
        if (last && last.index > flat().length - 40) void more();
      }}
    >
      {ready() && flat().length === 0 ? (
        <p class="empty">No issues match these filters.</p>
      ) : (
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          <div class="window" style={{ transform: `translateY(${visible().first * props.rowHeight}px)` }}>
            <For each={visible().rows}>
              {(f) => (
                <div class={`tree-row ${f.node.matched ? '' : 'context'}`} style={{ '--depth': String(f.depth) }}>
                  {props.row(f.node, lead(f))}
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </div>
  );
}

export function ListTreeToggle(props: { ctx: Ctx }) {
  return (
    <span class="seg" role="group" aria-label="List or tree">
      <button aria-pressed={props.ctx.tree() ? 'false' : 'true'} onClick={() => props.ctx.setTree(false)}>
        List
      </button>
      <button aria-pressed={props.ctx.tree() ? 'true' : 'false'} onClick={() => props.ctx.setTree(true)}>
        Tree
      </button>
    </span>
  );
}
