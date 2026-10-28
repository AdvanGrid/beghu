// The detail's relationships (part of the issue panel's chunk): the parent breadcrumb with its
// progress above the title; the Blocks section above the body, blocked by on the left and
// blocking mirrored on the right; Relates to under it; and the Sub-issues section after the body.
// Also the linked PRs, which aren't relationships but list the same way: an issue's "Linked PRs"
// and a PR's "Closes", each a property row.
// An end in a repo that isn't synced is a stub: "not synced", opening on GitHub (↗).
//
// An issue's relationships are edited in place (a PR's are read-only): the Links row's `+ Blocked
// by`, `+ Blocking` and `+ Relates to`, `+ Set parent` over the title and `+ Add sub-issue` open a
// picker (RelationshipPicker.tsx, a chunk of its own); × on hover removes a link; a sub-issue moves by
// its grip (drag, mouse only) or its ⋯ menu (Move to top, up, down or bottom, Move to another
// parent…, Remove). Each is a write of its own (writes.tsx, loaded with the composer), shown at
// once on both ends; its dot and a failure show in the Links row's marker slot.
import * as stylex from "@stylexjs/stylex";
import { createSignal, Errored, flush, For, lazy, Loading, onSettled, Show } from "solid-js";
import { Dynamic } from "@solidjs/web";
import type { IssueOp as Op } from "./api";
import { Avatar, issueState, PrIcon, ProgressRing, StateIcon } from "./bits";
import type { RelationshipKind } from "./bindings/RelationshipKind";
import { ChunkFailure } from "./chunks";
import { touch } from "./keys";
import { writesPaused } from "./live";
import { overlay, setNewSubIssueOf, type ShownDetail } from "./overlay";
import { ChunkFailed } from "./router";
import { endOf, keyOf, refOf, related, type ShownRelated } from "./related";
import { colors, fonts } from "./tokens.stylex";
import type { RelatedLook } from "./writes";

/** The relationship picker: loaded the first time one opens. */
const RelationshipPicker = lazy(
  () =>
    import("./RelationshipPicker").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the picker: ${String(e)}`);
    }),
  { export: "RelationshipPicker" },
);

/** Why the writes code didn't load for a relationship write: shown in the Links row's marker slot. */
const [sendFailed, setSendFailed] = createSignal<ChunkFailed>();

/**
 * Sends relationship write `op` through the writes code, which the panel loads with its composer.
 * Should that code not load, the write isn't made, and the Links row says so (`ChunkFailure`).
 */
function send(op: Op, look: { relationship: RelatedLook }): void {
  import("./writes").then(
    (w) => w.sendRelationship(op, look),
    (e: unknown) => setSendFailed(new ChunkFailed(`can't load the writes: ${String(e)}`)),
  );
}

/** Where a related issue opens: in the panel, or on GitHub for a stub (or one not read yet). */
function hrefOf(r: ShownRelated, search: string): string {
  return r.stub || r.id === null ? `https://github.com/${r.owner}/${r.repo}/${r.kind === "pr" ? "pull" : "issues"}/${r.number}` : `/issues/${r.id}${search}`;
}

/** A related issue's title as a link: in the panel, or out to GitHub with ↗. */
function TitleLink(props: { r: ShownRelated; search: string }) {
  const stub = () => props.r.stub;
  const closed = () => props.r.state === "closed";
  return (
    <a
      href={hrefOf(props.r, props.search)}
      noscroll
      target={props.r.stub ? "_blank" : undefined}
      rel={props.r.stub ? "noreferrer external" : undefined}
      title={props.r.stub ? `${props.r.title} (not synced: opens on GitHub)` : props.r.title}
      {...stylex.attrs(s.title, stub() && s.stubTitle, closed() && s.struck)}
    >
      {props.r.title}
      {props.r.stub ? " ↗" : ""}
    </a>
  );
}

function NotSynced() {
  return (
    <span {...stylex.attrs(s.stubTag)} title="In a repo beghu doesn't sync: only its title is known">
      not synced
    </span>
  );
}

/**
 * × that removes a relationship: shown while the pointer is over its item (`shown`) or it has the
 * focus, always there for the keyboard and screen readers. Disabled while writes are paused (a
 * banner says why).
 */
function RemoveButton(props: { what: string; shown: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${props.what}`}
      title={`Remove ${props.what}`}
      data-perf="remove-relationship"
      disabled={writesPaused()}
      {...stylex.attrs(s.remove, props.shown && s.removeShown)}
      onClick={(e) => {
        e.preventDefault();
        props.onClick();
      }}
    >
      ×
    </button>
  );
}

/** A small text button that opens a picker: `+ Blocked by`, `+ Set parent`. */
function AddButton(props: { label: string; kind: RelationshipKind; open: boolean; setOpen: (open: boolean) => void; ref?: (el: HTMLButtonElement) => void }) {
  return (
    <button
      ref={props.ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={props.open ? "true" : "false"}
      data-perf={`add-${props.kind}`}
      disabled={writesPaused()}
      {...stylex.attrs(s.add)}
      onClick={() => props.setOpen(!props.open)}
    >
      + {props.label}
    </button>
  );
}

/** The picker for `kind`, under what opened it, once its code has loaded. */
function PickerSlot(props: { kind: RelationshipKind; d: ShownDetail; subject?: ShownRelated & { id: number }; opener?: HTMLElement; onClose: (refocus: boolean) => void; end?: boolean }) {
  return (
    <Errored fallback={(err, reset) => <ChunkFailure error={err()} reset={reset} />}>
      <Loading>
        <RelationshipPicker kind={props.kind} d={props.d} subject={props.subject} opener={props.opener} onClose={props.onClose} end={props.end} />
      </Loading>
    </Errored>
  );
}

/** Closed ones sink to the bottom. */
function openFirst(xs: ShownRelated[]): ShownRelated[] {
  return [...xs].sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed"));
}

/**
 * The parent as a breadcrumb above the title, with its progress, and × to take the issue out of
 * it; without one, `+ Set parent` on an issue (`write`).
 */
export function ParentCrumb(props: { d: ShownDetail; search: string; write: boolean }) {
  const [picking, setPicking] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let opener: HTMLButtonElement | undefined;
  const close = (refocus: boolean) => {
    setPicking(false);
    if (refocus) opener?.focus();
  };
  return (
    <Show
      when={props.d.relationships.parent}
      fallback={
        <Show when={props.write}>
          <div {...stylex.attrs(s.crumb, s.anchor)}>
            <AddButton label="Set parent" kind="parent" open={picking()} setOpen={setPicking} ref={(el) => (opener = el)} />
            <Show when={picking()}>
              <PickerSlot kind="parent" d={props.d} opener={opener} onClose={close} />
            </Show>
          </div>
        </Show>
      }
    >
      {(p) => (
        <div {...stylex.attrs(s.crumb)} data-perf="parent" onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)}>
          <span {...stylex.attrs(s.muted)}>↑</span>
          <TitleLink r={p()} search={props.search} />
          <span {...stylex.attrs(s.ref)}>
            {p().repo}#{p().number}
          </span>
          <Show when={p().stub}>
            <NotSynced />
          </Show>
          <Show when={p().progress}>
            {(g) => (
              <span {...stylex.attrs(s.progress)} title={`${g().done} of ${g().total} sub-issues closed, at every level`}>
                <ProgressRing done={g().done} total={g().total} />
                {g().done}/{g().total}
              </span>
            )}
          </Show>
          <Show when={props.write && !p().stub}>
            <RemoveButton
              what={`the parent ${refOf(p())}`}
              shown={over()}
              onClick={() => {
                const me = related(props.d);
                send({ kind: "sub_remove", issue: p().id, child: endOf(me) }, { relationship: { issue: p(), other: me } });
              }}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * One end of a dependency, on two lines: the title, then the number and who has it ("unassigned"
 * while open). A blocker that is itself blocked says so; so does an issue this one blocks that
 * waits on others too. On an issue, × on hover removes it.
 */
function BlockItem(props: { r: ShownRelated; side: "blocked_by" | "blocking"; open: boolean; search: string; onRemove?: () => void }) {
  const r = () => props.r;
  // On the blocking side this issue is one of its blockers: count the others.
  const others = () => r().blocked_by - (props.side === "blocking" && props.open ? 1 : 0);
  const chain = () => r().state === "open" && others() > 0;
  const right = () => props.side === "blocking";
  const closed = () => r().state === "closed";
  const [over, setOver] = createSignal(false);
  return (
    <div
      {...stylex.attrs(s.blockItem, right() && s.mirrored, closed() && s.closed)}
      data-perf="block-item"
      data-id={r().id ?? undefined}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
    >
      <span {...stylex.attrs(s.icon, right() && s.iconRight)}>
        <StateIcon state={issueState(r())} />
      </span>
      <span {...stylex.attrs(s.line, right() && s.lineRight)}>
        <TitleLink r={r()} search={props.search} />
        <Show when={props.onRemove}>
          {(remove) => <RemoveButton what={`the link to ${refOf(r())}`} shown={over()} onClick={remove()} />}
        </Show>
      </span>
      <span {...stylex.attrs(s.meta, right() && s.metaRight)}>
        <span {...stylex.attrs(s.ref)}>
          {r().repo}#{r().number}
        </span>
        <Show when={r().stub}>
          <NotSynced />
        </Show>
        <Show when={chain()}>
          <span {...stylex.attrs(s.chain)}>{right() ? `also waits on ${others()} more` : `itself blocked by ${others()}`}</span>
        </Show>
        <Show when={!r().stub}>
          <Show
            when={r().assignee}
            fallback={
              <Show when={r().state === "open"}>
                <span {...stylex.attrs(s.nobody)}>unassigned</span>
              </Show>
            }
          >
            {(who) => (
              <span {...stylex.attrs(s.who, right() && s.whoRight)}>
                <Avatar login={who()} size={14} />
                {who()}
              </span>
            )}
          </Show>
        </Show>
      </span>
    </div>
  );
}

function BlockSide(props: { d: ShownDetail; items: ShownRelated[]; side: "blocked_by" | "blocking"; open: boolean; search: string; write: boolean }) {
  const items = () => openFirst(props.items);
  const openCount = () => props.items.filter((x) => x.state === "open").length;
  const right = () => props.side === "blocking";
  // A count of open blockers is red.
  const hot = () => props.side === "blocked_by" && openCount() > 0;
  const remove = (r: ShownRelated) => () =>
    send({ kind: "block_remove", issue: props.d.id, other: endOf(r), blocking: right() }, { relationship: { issue: related(props.d), other: r } });
  // A dependency is GitHub's call on the blocked issue: one this issue blocks in a repo beghu doesn't
  // sync takes no write here (the server refuses it too).
  const removable = (r: ShownRelated) => props.write && !(right() && (r.stub || r.id === null));
  return (
    <div {...stylex.attrs(s.side)} data-perf={props.side}>
      <header {...stylex.attrs(s.sideHead, right() && s.sideHeadRight)}>
        <span {...stylex.attrs(s.heading)}>{right() ? "Blocking" : "Blocked by"}</span>
        <Show when={props.items.length > 0}>
          <span {...stylex.attrs(s.count, hot() && s.hot)}>
            {openCount() === props.items.length ? openCount() : `${openCount()} of ${props.items.length} open`}
          </span>
        </Show>
      </header>
      <For each={items()} keyed={keyOf} fallback={<p {...stylex.attrs(s.empty, right() && s.emptyRight)}>{right() ? "Nothing waits on this" : "Nothing; ready to start"}</p>}>
        {(r) => <BlockItem r={r()} side={props.side} open={props.open} search={props.search} onRemove={removable(r()) ? remove(r()) : undefined} />}
      </For>
    </div>
  );
}

/** Blocked by on the left, blocking mirrored on the right; hidden when there are neither. */
export function Blocks(props: { d: ShownDetail; search: string; write: boolean }) {
  const rels = () => props.d.relationships;
  const open = () => props.d.state === "open";
  return (
    <Show when={rels().blocked_by.length > 0 || rels().blocking.length > 0}>
      <section aria-label="Blocks" data-perf="blocks" {...stylex.attrs(s.blocks)}>
        <BlockSide d={props.d} items={rels().blocked_by} side="blocked_by" open={open()} search={props.search} write={props.write} />
        <div aria-hidden="true" {...stylex.attrs(s.mid)}>
          <span {...stylex.attrs(s.arrow)}>→</span>
        </div>
        <BlockSide d={props.d} items={rels().blocking} side="blocking" open={open()} search={props.search} write={props.write} />
      </section>
    </Show>
  );
}

/** One related issue on one line: state, title, number, "not synced", progress, who has it. */
function RelRow(props: { r: ShownRelated; search: string; progress?: boolean; onRemove?: () => void }) {
  const r = () => props.r;
  const closed = () => r().state === "closed";
  const [over, setOver] = createSignal(false);
  return (
    <div
      {...stylex.attrs(s.relRow, closed() && s.closed)}
      data-perf="rel-item"
      data-id={r().id ?? undefined}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
    >
      <Show when={r().pr_status} fallback={<StateIcon state={issueState(r())} />}>
        {(st) => <PrIcon status={st()} />}
      </Show>
      <TitleLink r={r()} search={props.search} />
      <span {...stylex.attrs(s.ref)}>
        {r().repo}#{r().number}
      </span>
      <Show when={r().stub}>
        <NotSynced />
      </Show>
      <Show when={props.progress && r().progress}>
        {(g) => (
          <span {...stylex.attrs(s.progress)} title={`${g().done} of ${g().total} sub-issues closed, at every level`}>
            <ProgressRing done={g().done} total={g().total} />
            {g().done}/{g().total}
          </span>
        )}
      </Show>
      <Show when={r().assignee}>{(who) => <Avatar login={who()} size={14} />}</Show>
      <Show when={props.onRemove}>
        {(remove) => <RemoveButton what={`the link to ${refOf(r())}`} shown={over()} onClick={remove()} />}
      </Show>
    </div>
  );
}

/** An issue's linked PRs, or the issues a PR closes, in their property row: one line each. */
export function Linked(props: { items: ShownRelated[]; search: string; empty: string; perf: string }) {
  return (
    <div data-perf={props.perf} {...stylex.attrs(s.linked)}>
      <For each={props.items} keyed={keyOf} fallback={<span {...stylex.attrs(s.muted)}>{props.empty}</span>}>
        {(r) => <RelRow r={r()} search={props.search} />}
      </For>
    </div>
  );
}

/** Relates to, under Blocks; hidden when empty. */
export function RelatesTo(props: { d: ShownDetail; search: string; write: boolean }) {
  const remove = (r: ShownRelated) => () => send({ kind: "relate_remove", issue: props.d.id, other: endOf(r) }, { relationship: { issue: related(props.d), other: r } });
  return (
    <Show when={props.d.relationships.relates_to.length > 0}>
      <section aria-label="Relates to" data-perf="relates" {...stylex.attrs(s.relates)}>
        <header {...stylex.attrs(s.sideHead)}>
          <span {...stylex.attrs(s.heading)}>Relates to</span>
        </header>
        <For each={props.d.relationships.relates_to} keyed={keyOf}>
          {(r) => <RelRow r={r()} search={props.search} onRemove={props.write ? remove(r()) : undefined} />}
        </For>
      </section>
    </Show>
  );
}

/**
 * The Links property row of an issue: `+ Blocked by`, `+ Blocking` and `+ Relates to`, each
 * opening its picker (also by its key: keys.ts), and the row's marker slot, where a relationship
 * write's dot and its latest failure show.
 */
export function LinksRow(props: { d: ShownDetail; at: number }) {
  const [picking, setPicking] = createSignal<RelationshipKind>();
  const openers: Partial<Record<RelationshipKind, HTMLButtonElement>> = {};
  let value: HTMLElement | undefined;
  const close = (refocus: boolean) => {
    const kind = picking();
    setPicking(undefined);
    if (refocus && kind) openers[kind]?.focus();
  };
  // A key opens its picker, or puts the focus back in it (its search box) if it's open.
  const open = (kind: RelationshipKind) => () => {
    if (picking() === kind) value?.querySelector<HTMLElement>('[data-keys="picker"] input')?.focus();
    else if (!writesPaused()) setPicking(kind);
  };
  touch("blockedBy", open("blocked_by"));
  touch("blocking", open("blocking"));
  touch("relatesTo", open("relates"));
  const button = (label: string, kind: RelationshipKind) => (
    <AddButton label={label} kind={kind} open={picking() === kind} setOpen={(o) => setPicking(o ? kind : undefined)} ref={(el) => (openers[kind] = el)} />
  );
  return (
    <span ref={value} {...stylex.attrs(s.linksValue, s.anchor)}>
      <span {...stylex.attrs(s.adds)}>
        {button("Blocked by", "blocked_by")}
        {button("Blocking", "blocking")}
        {button("Relates to", "relates")}
      </span>
      <span id={`prop-note-links-${props.d.id}`} {...stylex.attrs(s.noteSlot)} data-perf="prop-note">
        <Show when={sendFailed()} fallback={<Dynamic component={overlay()?.PropNote} issue={props.d.id} prop="links" at={props.at} />}>
          {(e) => <ChunkFailure error={e()} what="writes" reset={() => setSendFailed(undefined)} />}
        </Show>
      </span>
      <Show when={picking()}>
        {(kind) => <PickerSlot kind={kind()} d={props.d} opener={openers[kind()]} onClose={close} />}
      </Show>
    </span>
  );
}

/** Where a sub-issue goes: after this sibling, or to the top (`null`). */
type After = number | null;

/** A sub-issue GitHub has shown, so it has an id: the only kind that moves. */
type Movable = ShownRelated & { id: number };

const movable = (r: ShownRelated): r is Movable => r.id !== null;

/**
 * A sub-issue's ⋯ menu: Move to top, up, down or bottom, Move to another parent…, Remove. Each
 * move is a reorder (`after`); one that wouldn't move it is unavailable. The keyboard's way in, and
 * touch's: opening it (a click, Enter, Space or ↓; ↑ for its last item) puts the focus on its first
 * item; ↑ and ↓ move between its items (wrapping), Home and End to the first and last; Enter or Space
 * picks one; Escape closes it and puts the focus back on ⋯; Tab closes it and moves on.
 */
function SubMenu(props: { d: ShownDetail; r: Movable; index: number; count: number; move: (after: After) => void; remove: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  let button!: HTMLButtonElement;
  let menu: HTMLSpanElement | undefined;
  const subs = () => props.d.relationships.sub_issues;
  const first = () => props.index === 0;
  const last = () => props.index === props.count - 1;
  /** The id of the sub-issue at `i`, if GitHub has shown it. */
  const idAt = (i: number) => subs()[i]?.id ?? null;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  /** Puts the focus on item `i`, counted from the end when negative, wrapping around. */
  const focusItem = (i: number) => {
    const all = items();
    if (all.length > 0) all[((i % all.length) + all.length) % all.length]!.focus();
  };
  const show = (at: number) => {
    setOpen(true);
    flush();
    focusItem(at);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.focus();
  };
  const item = (label: string, off: boolean, run: () => void) => {
    const unavailable = () => off || writesPaused();
    return (
      <button
        type="button"
        role="menuitem"
        tabindex={-1}
        aria-disabled={unavailable() ? "true" : undefined}
        {...stylex.attrs(s.menuItem, unavailable() && s.menuItemOff)}
        onClick={() => {
          if (unavailable()) return;
          close(true);
          run();
        }}
      >
        {label}
      </button>
    );
  };
  onSettled(() => {
    const away = (e: PointerEvent) => {
      const at = e.target as Element;
      if (open() && !menu?.contains(at) && !button.contains(at)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });
  const what = () => `Move or remove ${refOf(props.r)}`;
  return (
    <span {...stylex.attrs(s.anchor)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={what()}
        data-perf="sub-menu"
        {...stylex.attrs(s.more)}
        onClick={() => (open() ? close(false) : show(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") show(0);
          else if (e.key === "ArrowUp") show(-1);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        ⋯
      </button>
      <Show when={open()}>
        <span
          ref={menu}
          role="menu"
          aria-label={what()}
          data-perf="sub-menu-items"
          {...stylex.attrs(s.menu)}
          onKeyDown={(e) => {
            const at = items().indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowDown") focusItem(at + 1);
            else if (e.key === "ArrowUp") focusItem(at - 1);
            else if (e.key === "Home") focusItem(0);
            else if (e.key === "End") focusItem(-1);
            else if (e.key === "Escape") close(true);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onFocusOut={(e) => {
            // Tab, Shift+Tab or a click elsewhere: the focus moves on, and the menu closes.
            const to = e.relatedTarget as Node | null;
            if (!menu?.contains(to)) setOpen(false);
          }}
        >
          {item("Move to top", first(), () => props.move(null))}
          {item("Move up", first(), () => props.move(props.index >= 2 ? idAt(props.index - 2) : null))}
          {item("Move down", last() || idAt(props.index + 1) === null, () => props.move(idAt(props.index + 1)))}
          {item("Move to bottom", last() || idAt(props.count - 1) === null, () => props.move(idAt(props.count - 1)))}
          {/* Not a stub: the picker reads the issue it moves from the mirror. */}
          {item("Move to another parent…", props.r.stub, () => setMoving(true))}
          {item("Remove", false, props.remove)}
        </span>
      </Show>
      <Show when={moving()}>
        <PickerSlot
          kind="parent"
          d={props.d}
          subject={props.r}
          opener={button}
          end
          onClose={(refocus) => {
            setMoving(false);
            if (refocus) button.focus();
          }}
        />
      </Show>
    </span>
  );
}

/**
 * The sub-issues in GitHub's order, with "x of y done" over them and each one's own progress. On
 * an issue, each has × on hover to remove it, a grip to drag it to another place (mouse only, as
 * the spec has it for v1) and a ⋯ menu; `+ Create a new sub-issue` opens the create form with it as
 * the parent, and `+ Add sub-issue` picks an existing issue to add.
 */
export function SubIssues(props: { d: ShownDetail; search: string; write: boolean }) {
  const subs = () => props.d.relationships.sub_issues;
  const done = () => subs().filter((x) => x.state === "closed").length;
  const [adding, setAdding] = createSignal(false);
  /** The sub-issue being dragged, and where it would land: before or after the row under it. */
  const [dragging, setDragging] = createSignal<number>();
  const [drop, setDrop] = createSignal<{ id: number; before: boolean }>();
  let list!: HTMLDivElement;
  /** The row at height `y`, and which half of it: where a drop there lands. */
  const under = (y: number) => {
    for (const row of list.querySelectorAll<HTMLElement>('[data-perf="sub-row"][data-id]')) {
      const box = row.getBoundingClientRect();
      if (y >= box.top && y < box.bottom) return { id: Number(row.dataset.id), before: y < box.top + box.height / 2 };
    }
    return undefined;
  };
  let opener: HTMLButtonElement | undefined;
  const me = () => related(props.d);
  const move = (r: Movable) => (after: After) =>
    send({ kind: "sub_reorder", issue: props.d.id, child: r.id, after }, { relationship: { issue: me(), other: r } });
  const remove = (r: ShownRelated) => () => send({ kind: "sub_remove", issue: props.d.id, child: endOf(r) }, { relationship: { issue: me(), other: r } });
  /** Drops the dragged sub-issue where the marker is: after the row before it, or the row itself. */
  const dropIt = () => {
    const id = dragging();
    const at = drop();
    setDragging(undefined);
    setDrop(undefined);
    if (id === undefined || !at || at.id === id) return;
    const rest = subs().filter((x) => x.id !== id);
    const i = rest.findIndex((x) => x.id === at.id);
    const after: After = at.before ? (i > 0 ? rest[i - 1]!.id : null) : at.id;
    const from = subs().findIndex((x) => x.id === id);
    const now: After = from > 0 ? subs()[from - 1]!.id : null;
    if (after === now) return;
    const r = subs()[from];
    if (r && movable(r)) move(r)(after);
  };
  return (
    <section aria-label="Sub-issues" data-perf="sub-issues">
      <h3 {...stylex.attrs(s.section)}>
        Sub-issues
        <Show when={subs().length > 0}>
          <span {...stylex.attrs(s.progress, s.done)} data-perf="sub-progress">
            <ProgressRing done={done()} total={subs().length} />
            {done()} of {subs().length} done
          </span>
        </Show>
        <Show when={props.write}>
          <span {...stylex.attrs(s.headAdd, s.anchor)}>
            {/* The create form, with this issue as the new one's parent. */}
            <a
              href={`/new${props.search}`}
              noscroll
              data-perf="create-sub"
              {...stylex.attrs(s.add, s.addAnchor)}
              onClick={() => setNewSubIssueOf(related(props.d))}
            >
              + Create a new sub-issue
            </a>
            <AddButton label="Add sub-issue" kind="sub" open={adding()} setOpen={setAdding} ref={(el) => (opener = el)} />
            <Show when={adding()}>
              <PickerSlot
                kind="sub"
                d={props.d}
                opener={opener}
                end
                onClose={(refocus) => {
                  setAdding(false);
                  if (refocus) opener?.focus();
                }}
              />
            </Show>
          </span>
        </Show>
      </h3>
      <div ref={list} {...stylex.attrs(s.subs)}>
        <For each={subs()} keyed={keyOf} fallback={<p {...stylex.attrs(s.empty)}>No sub-issues</p>}>
          {(r, i) => (
            <div
              {...stylex.attrs(
                s.subRow,
                r().id !== null && dragging() === r().id && s.dragged,
                r().id !== null && drop()?.id === r().id && (drop()!.before ? s.dropBefore : s.dropAfter),
              )}
              data-perf="sub-row"
              data-id={r().id ?? undefined}
            >
              <Show when={props.write && movable(r()) ? (r() as Movable) : undefined} fallback={<Show when={props.write}><span {...stylex.attrs(s.grip)} /></Show>}>
                {(m) => (
                  /* The grip keeps the pointer while it's pressed: its moves place the marker,
                     and letting go drops the sub-issue there. */
                  <span
                    aria-hidden="true"
                    title="Drag to move"
                    data-perf="grip"
                    {...stylex.attrs(s.grip, dragging() === m().id && s.grabbing)}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || e.pointerType !== "mouse" || writesPaused()) return;
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDragging(m().id);
                    }}
                    onPointerMove={(e) => {
                      if (dragging() === m().id) setDrop(under(e.clientY));
                    }}
                    onPointerUp={() => {
                      if (dragging() === m().id) dropIt();
                    }}
                    onPointerCancel={() => {
                      setDragging(undefined);
                      setDrop(undefined);
                    }}
                  >
                    ⠿
                  </span>
                )}
              </Show>
              <RelRow r={r()} search={props.search} progress onRemove={props.write ? remove(r()) : undefined} />
              <Show when={props.write && movable(r()) ? (r() as Movable) : undefined}>
                {(m) => <SubMenu d={props.d} r={m()} index={i()} count={subs().length} move={move(m())} remove={remove(m())} />}
              </Show>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

const s = stylex.create({
  // What a picker or a menu opens under.
  anchor: {
    position: "relative",
  },
  add: {
    font: "inherit",
    borderRadius: 4,
    borderWidth: 0,
    paddingBlock: 0,
    paddingInline: 4,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.muted,
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    fontSize: 12.5,
  },
  adds: {
    gap: 4,
    display: "flex",
    flexWrap: "wrap",
  },
  linksValue: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  // The Links row's marker slot: one line the row always keeps, as the other property rows' do.
  noteSlot: {
    alignItems: "center",
    display: "flex",
    flexBasis: "100%",
    minHeight: 18,
    minWidth: 0,
  },
  headAdd: {
    gap: 4,
    display: "flex",
    fontWeight: 400,
    marginInlineStart: "auto",
  },
  addAnchor: {
    textDecoration: "none",
  },
  remove: {
    font: "inherit",
    borderRadius: 4,
    borderWidth: 0,
    paddingInline: 4,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.muted,
    cursor: "pointer",
    flexShrink: 0,
    lineHeight: 1,
    opacity: {
      default: 0,
      ":focus-visible": 1,
    },
  },
  removeShown: {
    opacity: 1,
  },
  subRow: {
    alignItems: "center",
    display: "flex",
  },
  grip: {
    paddingInline: 2,
    color: colors.muted,
    cursor: "grab",
    flexShrink: 0,
    touchAction: "none",
    userSelect: "none",
  },
  grabbing: {
    cursor: "grabbing",
  },
  dragged: {
    opacity: 0.5,
  },
  dropBefore: {
    boxShadow: `inset 0 2px 0 ${colors.accent}`,
  },
  dropAfter: {
    boxShadow: `inset 0 -2px 0 ${colors.accent}`,
  },
  more: {
    font: "inherit",
    borderRadius: 4,
    borderWidth: 0,
    paddingInline: 6,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.muted,
    cursor: "pointer",
  },
  menu: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    position: "absolute",
    whiteSpace: "nowrap",
    zIndex: 10,
    right: 0,
    top: "100%",
  },
  menuItem: {
    font: "inherit",
    borderWidth: 0,
    outline: {
      default: null,
      ":focus-visible": `2px solid ${colors.accent}`,
    },
    paddingBlock: 4,
    paddingInline: 12,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.fg,
    cursor: "pointer",
    outlineOffset: -2,
    textAlign: "start",
  },
  menuItemOff: {
    color: colors.muted,
    cursor: "default",
  },
  crumb: {
    gap: 6,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    fontSize: 12.5,
    whiteSpace: "nowrap",
    minHeight: 22,
    paddingBottom: 4,
  },
  muted: {
    color: colors.muted,
  },
  title: {
    overflow: "hidden",
    textDecoration: {
      default: "none",
      ":hover": "underline",
    },
    color: "inherit",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  stubTitle: {
    color: colors.muted,
    fontStyle: "italic",
  },
  struck: {
    textDecoration: "line-through",
  },
  stubTag: {
    borderColor: colors.muted,
    borderRadius: 999,
    borderStyle: "dashed",
    borderWidth: 1,
    paddingInline: 6,
    color: colors.muted,
    flexShrink: 0,
    fontSize: 10.5,
  },
  ref: {
    color: colors.muted,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
  progress: {
    gap: 3,
    alignItems: "center",
    color: colors.muted,
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  done: {
    fontWeight: 400,
    paddingInlineStart: 8,
  },
  blocks: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    marginInline: 16,
    paddingBlock: 8,
    paddingInline: 6,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 18px minmax(0, 1fr)",
    marginBottom: 8,
  },
  mid: {
    alignItems: "center",
    display: "grid",
    justifyItems: "center",
    position: "relative",
  },
  arrow: {
    paddingBlock: 3,
    backgroundColor: colors.bg,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 1,
  },
  side: {
    gap: 2,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  sideHead: {
    gap: 6,
    paddingInline: 4,
    alignItems: "center",
    display: "flex",
    minHeight: 24,
  },
  sideHeadRight: {
    flexDirection: "row-reverse",
  },
  heading: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  count: {
    color: colors.muted,
    fontSize: 11.5,
  },
  hot: {
    color: colors.danger,
    fontWeight: 600,
  },
  empty: {
    margin: 0,
    paddingBlock: 2,
    paddingInline: 4,
    color: colors.muted,
    fontSize: 12,
  },
  emptyRight: {
    textAlign: "end",
  },
  blockItem: {
    padding: 4,
    borderRadius: 6,
    alignItems: "center",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    columnGap: 6,
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    rowGap: 1,
  },
  // Mirrored: the icon on the outer (right) edge, everything aligned to it.
  mirrored: {
    gridTemplateColumns: "minmax(0, 1fr) 16px",
    textAlign: "end",
  },
  closed: {
    opacity: 0.55,
  },
  icon: {
    display: "flex",
  },
  iconRight: {
    gridColumn: 2,
    gridRow: 1,
  },
  line: {
    display: "flex",
    minWidth: 0,
  },
  lineRight: {
    gridColumn: 1,
    gridRow: 1,
    justifyContent: "flex-end",
  },
  meta: {
    gap: "4px 8px",
    gridColumn: 2,
    alignItems: "center",
    color: colors.muted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 11.5,
    minWidth: 0,
  },
  metaRight: {
    gridColumn: 1,
    flexDirection: "row-reverse",
  },
  chain: {
    color: colors.danger,
  },
  nobody: {
    color: colors.unowned,
  },
  who: {
    gap: 4,
    alignItems: "center",
    display: "inline-flex",
  },
  whoRight: {
    flexDirection: "row-reverse",
  },
  relates: {
    paddingInline: 16,
    paddingBottom: 8,
  },
  linked: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  relRow: {
    borderRadius: 4,
    gap: 8,
    paddingInline: 4,
    alignItems: "center",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    display: "flex",
    flexGrow: 1,
    whiteSpace: "nowrap",
    minHeight: 28,
    minWidth: 0,
  },
  section: {
    margin: 0,
    paddingBlock: 10,
    paddingInline: 16,
    alignItems: "center",
    backgroundColor: colors.bgRaised,
    display: "flex",
    fontSize: 13,
    fontWeight: 600,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  subs: {
    paddingBlock: 6,
    paddingInline: 12,
  },
});
