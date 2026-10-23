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
//
// #55, variant B (outliner): the tree is where sub-issues are edited.
// - Drag a row by its grip: onto the top or bottom edge of another row to put it before or after
//   that row (same parent: a reorder; another parent: a move), onto the middle to make it the last
//   sub-issue of that row. Top-level issues follow the view's sort, so dropping between roots only
//   detaches from the parent.
// - On a focused row: Alt+↑ / Alt+↓ move it among its siblings, Tab nests it under the row above
//   (last child), Shift+Tab lifts it out to sit right after its old parent.
// - "+" on hover links an existing issue as a sub-issue, or opens the new-issue form with this
//   parent.
// - Every edit shows at once and is pending until GitHub answers; a refusal reverts with a toast.
//   Moves made elsewhere arrive as live pushes (held changes from #53 would apply; not redone here).
import { createEffect, createMemo, createSignal, For, Show, type Element } from 'solid-js';
import { createVirtualizer } from './virtual';
import { fetchTree, sendOp, WriteError, type TreeNode } from './api';
import { toast } from './detail/toasts';
import { LinkSearch, Popover } from './detail/parts';
import { useNewIssue } from './detail/layouts';
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
    // #55: a live push keeps what the user opened, filtered or not (edits in the tree push too).
    if (deep) o = new Set([...byParent.keys(), ...(keepOpen ? open() : [])]);
    else o = keepOpen ? new Set(open()) : new Set();
    // Refetch what's open below the roots (a live push); filtered pages arrive whole, except what
    // the user opened beyond the paths to matches.
    if (keepOpen) {
      await Promise.all(
        [...o].filter((id) => !deep || !byParent.has(id)).map(async (id) => {
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

  // ---------- #55, variant B: editing ----------
  const edit = () => c.rel() === 'B';
  const [pend, setPend] = createSignal<ReadonlySet<number>>(new Set());
  const [drag, setDrag] = createSignal<{ id: number; over?: number; zone?: 'before' | 'after' | 'into'; bad?: boolean }>();
  const newIssue = useNewIssue();
  const opId = () => Math.random().toString(36).slice(2, 10);

  const find = (id: number | null): TreeNode | undefined => {
    if (id === null) return undefined;
    return roots().find((n) => n.id === id) ?? [...kids().values()].flat().find((n) => n.id === id);
  };
  const siblings = (parent: number | null) => (parent === null ? roots() : (kids().get(parent) ?? []));
  // Solid 2 batches writes: a read right after a write still sees the old value. So every edit
  // builds the next roots and kids here and sets each once.
  function draft() {
    let r = roots();
    const k = new Map(kids());
    return {
      get: (p: number | null) => (p === null ? r : (k.get(p) ?? [])),
      put: (p: number | null, list: TreeNode[]) => (p === null ? (r = list) : k.set(p, list)),
      /** Replaces one node everywhere it appears (its row object is immutable). */
      patch: (id: number | null, f: (n: TreeNode) => TreeNode) => {
        if (id === null) return;
        r = r.map((n) => (n.id === id ? f(n) : n));
        for (const [p, list] of k) if (list.some((n) => n.id === id)) k.set(p, list.map((n) => (n.id === id ? f(n) : n)));
      },
      commit: () => (setRoots(r), setKids(k)),
    };
  }
  const mark = (id: number, on: boolean) =>
    setPend((cur) => {
      const p = new Set(cur);
      on ? p.add(id) : p.delete(id);
      return p;
    });
  const refocus = (id: number) => setTimeout(() => (document.querySelector(`[data-tid="${id}"] a`) as HTMLElement | null)?.focus(), 0);

  /** Moves `x` under `parent` (null: top level) at `index` of that list without `x`. */
  async function move(x: TreeNode, parent: number | null, index: number) {
    const from = x.parent_id;
    if (parent === null && from === null) {
      toast({ text: 'Top-level issues follow the view’s sort, so they can’t be reordered.' });
      return;
    }
    if (parent !== null && (parent === x.id || descendants(x.id).includes(parent))) {
      toast({ text: 'An issue can’t go inside its own sub-issues.' });
      return;
    }
    const children = parent !== null && !kids().has(parent) ? (await fetchTree(c.view(), { parent })).nodes : undefined;
    const before = { roots: roots(), kids: kids(), open: open() };
    // Local, at once.
    const t = draft();
    if (children) t.put(parent, children);
    t.put(from, t.get(from).filter((n) => n.id !== x.id));
    const target = t.get(parent).filter((n) => n.id !== x.id);
    index = Math.max(0, Math.min(index, target.length));
    const after = index === 0 ? null : target[index - 1].id;
    target.splice(index, 0, { ...x, parent_id: parent });
    t.put(parent, target);
    if (from !== parent) {
      t.patch(from, (n) => ({ ...n, children: n.children - 1 }));
      t.patch(parent, (n) => ({ ...n, children: n.children + 1 }));
    }
    t.commit();
    if (parent !== null) setOpen(new Set([...open(), parent]));
    mark(x.id, true);
    refocus(x.id);
    try {
      if (parent === from) await sendOp(parent!, opId(), { op: 'sub_move', child: x.id, after });
      else if (parent === null) await sendOp(from!, opId(), { op: 'rel_remove', kind: 'child', other: x.id });
      else {
        // GitHub adds at the end (replacing the old parent in the same call), then reprioritizes.
        await sendOp(parent, opId(), { op: 'rel_add', kind: 'child', other: x.id });
        if (index < target.length - 1) await sendOp(parent, opId(), { op: 'sub_move', child: x.id, after });
      }
    } catch (e) {
      setRoots(before.roots);
      setKids(before.kids);
      setOpen(before.open);
      toast({ text: `Couldn't move “${x.title}”: ${e instanceof WriteError ? e.message : String(e)}. Undone.`, retry: () => void move(x, parent, index) });
    } finally {
      mark(x.id, false);
    }
  }

  function onRowKey(e: KeyboardEvent, x: TreeNode) {
    if (!edit()) return;
    const list = siblings(x.parent_id);
    const i = list.findIndex((n) => n.id === x.id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < list.length) void move(x, x.parent_id, to);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const prev = list[i - 1];
      if (!prev) return toast({ text: 'Nothing above it to nest under.' });
      void move(x, prev.id, kids().get(prev.id)?.length ?? prev.children);
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (x.parent_id === null) return;
      const p = find(x.parent_id);
      const g = p?.parent_id ?? null;
      const at = g === null ? 0 : siblings(g).findIndex((n) => n.id === x.parent_id) + 1;
      void move(x, g, at);
    }
  }

  function onDragOver(e: DragEvent, f: Flat) {
    const d = drag();
    if (!d || d.id === f.node.id) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    const zone = y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : 'into';
    const bad = descendants(d.id).includes(f.node.id);
    if (d.over !== f.node.id || d.zone !== zone || d.bad !== bad) setDrag({ ...d, over: f.node.id, zone, bad });
  }
  function onDrop(e: DragEvent, f: Flat) {
    e.preventDefault();
    const d = drag();
    setDrag(undefined);
    if (!d || d.bad || d.over === undefined) return;
    const x = find(d.id);
    if (!x) return;
    const t = f.node;
    if (d.zone === 'into') return void move(x, t.id, kids().get(t.id)?.length ?? t.children);
    const list = siblings(t.parent_id).filter((n) => n.id !== x.id);
    const at = list.findIndex((n) => n.id === t.id) + (d.zone === 'after' ? 1 : 0);
    void move(x, t.parent_id, at);
  }

  async function linkChild(parent: TreeNode, other: number) {
    mark(parent.id, true);
    try {
      await sendOp(parent.id, opId(), { op: 'rel_add', kind: 'child', other });
      const page = await fetchTree(c.view(), { parent: parent.id });
      const t = draft();
      t.put(parent.id, page.nodes);
      t.patch(parent.id, (n) => ({ ...n, children: page.nodes.length }));
      t.commit();
      setOpen(new Set([...open(), parent.id]));
    } catch (e) {
      toast({ text: `Couldn't add the sub-issue: ${e instanceof WriteError ? e.message : String(e)}.` });
    } finally {
      mark(parent.id, false);
    }
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
    <span class="tree-lead" style={{ width: `${f.depth * INDENT + 18 + (edit() ? 14 : 0)}px` }}>
      <Show when={edit()}>
        <span
          class="grip"
          draggable="true"
          title="Drag: top or bottom edge of a row to put it beside, the middle to nest it"
          onClick={(e) => (e.preventDefault(), e.stopPropagation())}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', String(f.node.id));
            e.dataTransfer!.setDragImage((e.currentTarget as HTMLElement).closest('.tree-row')!, 20, 17);
            setDrag({ id: f.node.id });
          }}
          onDragEnd={() => setDrag(undefined)}
        >
          ⋮⋮
        </span>
      </Show>
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
                <div
                  class={`tree-row ${f.node.matched ? '' : 'context'} ${pend().has(f.node.id) ? 'pending' : ''} ${drag()?.id === f.node.id ? 'dragging' : ''} ${
                    drag()?.over === f.node.id ? `drop-${drag()!.bad ? 'bad' : drag()!.zone}` : ''
                  }`}
                  style={{ '--depth': String(f.depth), '--indent': `${f.depth * INDENT + 32}px` }}
                  data-tid={f.node.id}
                  onKeyDown={(e) => onRowKey(e, f.node)}
                  onDragOver={(e) => onDragOver(e, f)}
                  onDrop={(e) => onDrop(e, f)}
                >
                  {props.row(f.node, lead(f))}
                  <Show when={edit()}>
                    <Popover
                      align="right"
                      class="tree-add"
                      trigger={(t) => (
                        <button class="ghost tiny" title="Add a sub-issue" onClick={(e) => (e.preventDefault(), t())}>
                          + sub-issue
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <LinkSearch
                            close={close}
                            repo={f.node.repo}
                            exclude={[f.node.id, ...(kids().get(f.node.id) ?? []).map((n) => n.id)]}
                            onPick={(it) => void linkChild(f.node, it.id)}
                          />
                          <button class="choice new-sub" onClick={() => (close(), newIssue(f.node.id))}>
                            + Create a new sub-issue
                          </button>
                        </>
                      )}
                    </Popover>
                  </Show>
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
