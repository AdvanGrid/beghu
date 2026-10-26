// PROTOTYPE (beghu #55). The detail's sub-issue list, editable two ways:
//
// - `drag` (variant A): a grip on hover drags a row to a new place; a ⋯ menu has Move to top / up /
//   down / to bottom, Move to another parent… and Remove.
// - `keys` (variant C): rows are focusable; Alt+↑ / Alt+↓ move the focused one, and ↑ ↓ buttons show
//   on hover. No drag.
//
// Every move is one `sub_move` op on this issue (GitHub's reprioritize: after another child, or
// first) and shows at once as a pending write. A move made elsewhere arrives as a live push; the
// rows then follow "List order under live updates" (held changes), which the prototype doesn't redo.
import { createSignal, For, Show } from 'solid-js';
import { sendOp, type RelItem } from '../api';
import type { IssueModel } from '../detail/model';
import { AddRel, LinkSearch, Popover, RelRow } from '../detail/parts';
import { Progress } from '../bits';
import { toast } from '../detail/toasts';

const newId = () => Math.random().toString(36).slice(2, 10);

export function SubIssues(props: { m: IssueModel; mode: 'drag' | 'keys' | 'plain'; onNew: () => void; extra?: () => unknown }) {
  const m = props.m;
  const items = () => m.d().rels.children;
  const done = () => items().filter((x) => x.state === 'closed').length;
  const [drag, setDrag] = createSignal<{ id: number; over?: number; after?: boolean }>();
  const [leaving, setLeaving] = createSignal<ReadonlySet<number>>(new Set());

  /** Moves `id` to index `to` of the list without it. */
  function moveTo(id: number, to: number) {
    const rest = items().filter((x) => x.id !== id);
    to = Math.max(0, Math.min(to, rest.length));
    const after = to === 0 ? null : rest[to - 1].id;
    const cur = items().findIndex((x) => x.id === id);
    const curAfter = cur === 0 ? null : items()[cur - 1].id;
    if (after === curAfter) return;
    m.send({ op: 'sub_move', child: id, after });
  }
  const index = (id: number) => items().findIndex((x) => x.id === id);

  /** GitHub moves a sub-issue in one call on the new parent (replace_parent). */
  async function reparent(child: RelItem, parent: RelItem) {
    setLeaving((cur) => new Set([...cur, child.id]));
    try {
      await sendOp(parent.id, newId(), { op: 'rel_add', kind: 'child', other: child.id });
      await m.refresh();
      toast({ text: `Moved “${child.title}” under ${parent.repo}#${parent.number}.` });
    } catch (e) {
      toast({ text: `Couldn't move “${child.title}”: ${(e as Error).message}. Undone.` });
    } finally {
      setLeaving((cur) => {
        const s = new Set(cur);
        s.delete(child.id);
        return s;
      });
    }
  }

  const row = (it: RelItem) => {
    const pending = () => m.pending(`move:${it.id}`) || m.pending(`rel:child:${it.id}`) || leaving().has(it.id);
    const d = () => drag();
    return (
      <div
        class={`sub-row ${d()?.id === it.id ? 'dragging' : ''} ${d()?.over === it.id ? (d()!.after ? 'drop-after' : 'drop-before') : ''} ${leaving().has(it.id) ? 'leaving' : ''}`}
        tabindex={props.mode === 'keys' ? 0 : undefined}
        onKeyDown={(e) => {
          if (props.mode !== 'keys' || !e.altKey) return;
          if (e.key === 'ArrowUp') (e.preventDefault(), moveTo(it.id, index(it.id) - 1));
          if (e.key === 'ArrowDown') (e.preventDefault(), moveTo(it.id, index(it.id) + 1));
          queueMicrotask(() => (document.querySelector(`[data-sub="${it.id}"]`) as HTMLElement | null)?.focus());
        }}
        data-sub={it.id}
        onDragOver={(e) => {
          if (!d() || d()!.id === it.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setDrag({ ...d()!, over: it.id, after: e.clientY > r.top + r.height / 2 });
        }}
        onDrop={(e) => {
          e.preventDefault();
          const x = d();
          setDrag(undefined);
          if (!x || x.over === undefined) return;
          const rest = items().filter((y) => y.id !== x.id);
          const at = rest.findIndex((y) => y.id === x.over) + (x.after ? 1 : 0);
          moveTo(x.id, at);
        }}
      >
        <Show when={props.mode === 'drag'}>
          <span
            class="grip"
            draggable="true"
            title="Drag to reorder"
            onDragStart={(e) => {
              e.dataTransfer!.effectAllowed = 'move';
              e.dataTransfer!.setDragImage(e.currentTarget.parentElement!, 10, 14);
              setDrag({ id: it.id });
            }}
            onDragEnd={() => setDrag(undefined)}
          >
            ⋮⋮
          </span>
        </Show>
        <RelRow item={it} progress pending={pending()} onRemove={props.mode === 'drag' ? undefined : () => m.send({ op: 'rel_remove', kind: 'child', other: it.id })} />
        <Show when={props.mode === 'keys'}>
          <span class="sub-move">
            <button class="ghost tiny" title="Move up (Alt+↑)" disabled={index(it.id) === 0} onClick={() => moveTo(it.id, index(it.id) - 1)}>
              ↑
            </button>
            <button class="ghost tiny" title="Move down (Alt+↓)" disabled={index(it.id) === items().length - 1} onClick={() => moveTo(it.id, index(it.id) + 1)}>
              ↓
            </button>
          </span>
        </Show>
        <Show when={props.mode === 'drag'}>
          <Popover
            align="right"
            class="sub-menu"
            trigger={(t) => (
              <button class="ghost tiny dots" onClick={t} title="Move or remove">
                ⋯
              </button>
            )}
          >
            {(close) => <RowMenu m={m} it={it} close={close} moveTo={moveTo} index={index} count={() => items().length} reparent={reparent} />}
          </Popover>
        </Show>
      </div>
    );
  };

  return (
    <section class="rel-section subs" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && drag() && setDrag({ id: drag()!.id })}>
      <header class="rel-head">
        <span class="rel-h">Sub-issues</span>
        <Show when={items().length}>
          <span class="muted">
            <Progress done={done()} total={items().length} /> {done()} of {items().length} done
          </span>
        </Show>
        <span class="flex" />
        <AddRel m={m} kind="child" align="right" onNew={props.onNew} />
      </header>
      <For each={items()}>{(it) => row(it)}</For>
      <Show when={!items().length}>
        <p class="muted rel-empty">No sub-issues</p>
      </Show>
      <Show when={props.mode === 'keys' && items().length > 1}>
        <p class="muted hint">Focus a row and press Alt+↑ / Alt+↓ to move it.</p>
      </Show>
    </section>
  );
}

function RowMenu(props: {
  m: IssueModel;
  it: RelItem;
  close: () => void;
  moveTo: (id: number, to: number) => void;
  index: (id: number) => number;
  count: () => number;
  reparent: (child: RelItem, parent: RelItem) => void;
}) {
  const [picking, setPicking] = createSignal(false);
  const i = () => props.index(props.it.id);
  const act = (f: () => void) => () => (f(), props.close());
  return (
    <Show
      when={!picking()}
      fallback={
        <LinkSearch
          placeholder="New parent: repo#123 or title words"
          repo={props.m.d().repo}
          exclude={[props.it.id, props.m.d().id]}
          close={props.close}
          onPick={(p) => props.reparent(props.it, p)}
        />
      }
    >
      <div class="menu">
        <button class="choice" disabled={i() === 0} onClick={act(() => props.moveTo(props.it.id, 0))}>
          Move to top
        </button>
        <button class="choice" disabled={i() === 0} onClick={act(() => props.moveTo(props.it.id, i() - 1))}>
          Move up
        </button>
        <button class="choice" disabled={i() === props.count() - 1} onClick={act(() => props.moveTo(props.it.id, i() + 1))}>
          Move down
        </button>
        <button class="choice" disabled={i() === props.count() - 1} onClick={act(() => props.moveTo(props.it.id, props.count()))}>
          Move to bottom
        </button>
        <button class="choice" onClick={() => setPicking(true)}>
          Move to another parent…
        </button>
        <button class="choice danger" onClick={act(() => props.m.send({ op: 'rel_remove', kind: 'child', other: props.it.id }))}>
          Remove from sub-issues
        </button>
      </div>
    </Show>
  );
}
