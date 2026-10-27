// The detail's pickers: Labels, Assignees and Milestone each open one under their property row. A
// chunk of its own, loaded the first time one opens (IssuePanel.tsx); it brings the writes code
// with it, since every pick is a write.
//
// A picker lists what the repo offers, filters it as the user types, and ticks the issue's current
// values as the detail shows them, pending picks included. Each pick is sent at once as its own op
// (`label_add`, `assignee_remove`, `milestone_set`…), so toggling five labels sends five, which the
// server makes in order. Labels and assignees stay open for more; picking a milestone closes it.
// Labels and milestones come from the mirror and are read again on every live push, so a rename on
// GitHub reaches an open picker; who can be assigned is read from GitHub as the picker opens.
// Its row's key (`l`, `a`, `m`: keys.ts) opens it too; inside it, single keys type into the filter
// box (`data-keys="picker"`), and the `?` overlay (Ctrl+?) leaves it open behind.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import { query } from "@solidjs/router";
import { forgetFailure, GitHubDown, Gone, RateLimited, Refused, request, SessionEnded, signIn, Unreachable, type Op } from "./api";
import type { RepoLabel } from "./bindings/RepoLabel";
import type { RepoMilestone } from "./bindings/RepoMilestone";
import type { User } from "./bindings/User";
import { Avatar } from "./bits";
import { githubDown, onPush } from "./live";
import type { Prop, ShownDetail } from "./overlay";
import { colors } from "./tokens.stylex";
import { pick, picking, type Look } from "./writes";

const getLabels = query((repo: number) => request<RepoLabel[]>(`/api/repos/${repo}/labels`), "repoLabels");
const getMilestones = query((repo: number) => request<RepoMilestone[]>(`/api/repos/${repo}/milestones`), "repoMilestones");
const getAssignees = query((repo: number) => request<User[]>(`/api/repos/${repo}/assignees`), "repoAssignees");

/** Bumped by every live push once this chunk has loaded: open label and milestone pickers read again. */
const [pushes, setPushes] = createSignal(0);
onPush(() => setPushes((n) => n + 1));

/** One line of a picker: what it shows, whether the issue has it, and the op that toggles it. */
interface Item {
  key: string;
  name: string;
  /** Muted beside the name: a label's description, a milestone's state. */
  hint?: string;
  /** A label's colour, from GitHub (data, not design). */
  color?: string;
  login?: string;
  /** The milestone picker's "No milestone": always listed, never filtered out. */
  none?: boolean;
  on: boolean;
  op: Op;
  look?: Look;
}

/** What each picker is: what it calls its things, where it reads them, and how they list. */
interface PropKind<T> {
  /** "labels", "people", "milestones". */
  noun: string;
  /** What the repo offers. */
  read: ((repo: number) => Promise<T[]>) & { key: string };
  /** Read again on every live push (from the mirror), or only as it opens (from GitHub). */
  live: boolean;
  /** Stays open for more picks; picking a milestone closes its picker. */
  multi: boolean;
  /** The lines, from what the repo offers and what the issue `d` has. */
  items(d: ShownDetail, offered: T[]): Item[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const PROPS: { [P in Prop]: PropKind<P extends "labels" ? RepoLabel : P extends "assignees" ? User : RepoMilestone> } = {
  labels: {
    noun: "labels",
    read: getLabels,
    live: true,
    multi: true,
    items: (d, offered) => {
      const has = (name: string) => d.labels.some((l) => same(l.name, name));
      // A label the issue has that the repo's list lacks (renamed meanwhile) still shows, ticked.
      const extra = d.labels.filter((l) => !offered.some((o) => same(o.name, l.name)));
      return [...extra.map((l) => ({ ...l, description: null })), ...offered].map((l) => ({
        key: l.name,
        name: l.name,
        hint: l.description ?? undefined,
        color: l.color,
        on: has(l.name),
        op: { kind: has(l.name) ? "label_remove" : "label_add", issue: d.id, label: l.name },
        look: { label: { name: l.name, color: l.color } },
      }));
    },
  },
  assignees: {
    noun: "people",
    read: getAssignees,
    live: false,
    multi: true,
    items: (d, offered) => {
      const has = (login: string) => d.assignees.some((u) => same(u.login, login));
      const extra = d.assignees.filter((u) => !offered.some((o) => same(o.login, u.login)));
      return [...extra, ...offered].map((u) => ({
        key: u.login,
        name: u.login,
        login: u.login,
        on: has(u.login),
        op: { kind: has(u.login) ? "assignee_remove" : "assignee_add", issue: d.id, login: u.login },
      }));
    },
  },
  milestone: {
    noun: "milestones",
    read: getMilestones,
    live: true,
    multi: false,
    items: (d, offered) => {
      const now = d.milestone?.number;
      const none: Item = {
        key: "none",
        name: "No milestone",
        none: true,
        on: now === undefined,
        op: { kind: "milestone_set", issue: d.id, milestone: null },
        look: { milestone: null },
      };
      return [
        none,
        ...offered.map((m) => ({
          key: String(m.number),
          name: m.title,
          hint: m.state === "closed" ? "closed" : undefined,
          on: m.number === now,
          // Picking the one it's in takes it out.
          op: { kind: "milestone_set", issue: d.id, milestone: m.number === now ? null : m.number } satisfies Op,
          look: { milestone: m.number === now ? null : { number: m.number, title: m.title, state: m.state, due_on: m.due_on } },
        })),
      ];
    },
  },
};

/** What `prop`'s picker is. */
function propKind(prop: Prop): PropKind<unknown> {
  return PROPS[prop] as PropKind<unknown>;
}

/** Why a picker's list didn't load, in the server's words where it has some. */
function whyNot(e: unknown): string {
  const known = e instanceof RateLimited || e instanceof Refused || e instanceof GitHubDown || e instanceof Gone || e instanceof Unreachable;
  return known ? e.message : "something went wrong";
}

/**
 * The picker for `prop` on the open issue `d` (with the tab's pending writes on it), opened by
 * `opener`. `onClose` closes it; `refocus` says whether focus goes back to the row's button
 * (Escape, a milestone picked), or stays where the user clicked.
 */
export function Picker(props: { prop: Prop; d: ShownDetail; onClose: (refocus: boolean) => void; opener?: HTMLElement }) {
  const kind = () => propKind(props.prop);
  const [text, setText] = createSignal("");
  const [active, setActive] = createSignal(0);
  /**
   * The list's shown items, once it has loaded (none while it loads or failed): for the keys,
   * `aria-controls` and `aria-activedescendant`. Never read before then, so the filter box shows
   * while the list loads.
   */
  const [list, setList] = createSignal<(() => Item[]) | undefined>(undefined);
  const items = () => list()?.() ?? [];
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;

  const choose = (item: Item | undefined) => {
    if (!item || githubDown() || picking(props.d.id, item.op)) return;
    pick(item.op, props.d, item.look);
    if (!kind().multi) props.onClose(true);
  };

  onSettled(() => {
    input.focus();
    // A press anywhere else closes it, leaving focus where the press put it; one on the button
    // that opened it is that button's to close.
    const away = (e: PointerEvent) => {
      const at = e.target as Element;
      if (at.closest('[data-keys="help"]')) return;
      if (!root.contains(at) && !props.opener?.contains(at)) props.onClose(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === "ArrowDown") setActive((i) => Math.max(0, Math.min(n - 1, i + 1)));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(Math.max(0, n - 1));
    else if (e.key === "Enter") choose(items()[active()]);
    else if (e.key === "Escape") props.onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
    root.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };

  // Focus moving on (Tab, or into the page elsewhere) closes it. Focus going nowhere (the window
  // losing it, or the focused element going away) doesn't: a press elsewhere closes it anyway.
  const onFocusOut = (e: FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    // The `?` overlay (keys.ts) gives the focus back to the filter box when it closes.
    if (to?.closest('[data-keys="help"]')) return;
    if (to && !root.contains(to) && !props.opener?.contains(to)) props.onClose(false);
  };

  const listId = () => `picker-${props.prop}-${props.d.id}`;
  /** The active option's id, if there is such an option. */
  const activeId = () => (active() < items().length ? `${listId()}-${active()}` : undefined);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Pick ${kind().noun}`}
      data-perf="picker"
      data-prop={props.prop}
      data-keys="picker"
      {...stylex.attrs(s.pop)}
      onKeyDown={onKeyDown}
      onFocusOut={onFocusOut}
      // A press on what isn't a control here (the filter's margin, the Loading or error note, the
      // options and the list's gaps) would focus the issue's scroller, which takes focus, and so
      // close it: the focus stays where it is. The filter box and the buttons take theirs.
      onPointerDown={(e) => {
        if (!(e.target as Element).closest("input, button")) e.preventDefault();
      }}
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={list() ? listId() : undefined}
        aria-activedescendant={activeId()}
        aria-label={`Filter ${kind().noun}`}
        placeholder={`Filter ${kind().noun}`}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setActive(0);
        }}
        {...stylex.attrs(s.filter)}
      />
      <Errored
        fallback={(err, reset) => (
          <p {...stylex.attrs(s.note)} role="alert">
            Couldn't load the {kind().noun}: {whyNot(err())} ·{" "}
            <button
              type="button"
              {...stylex.attrs(s.link)}
              onClick={() => {
                if (err() instanceof SessionEnded) return signIn();
                forgetFailure(kind().read);
                reset();
              }}
            >
              Retry
            </button>
          </p>
        )}
      >
        <Loading fallback={<p {...stylex.attrs(s.note)} aria-busy="true">Loading…</p>}>
          <Options
            prop={props.prop}
            d={props.d}
            text={text()}
            active={active()}
            id={listId()}
            listed={(shown) => setList(() => shown)}
            choose={choose}
            hover={setActive}
          />
        </Loading>
      </Errored>
    </div>
  );
}

function Options(props: {
  prop: Prop;
  d: ShownDetail;
  text: string;
  active: number;
  id: string;
  /** The shown items once the list is on screen, and `undefined` once it's gone. */
  listed: (shown: (() => Item[]) | undefined) => void;
  choose: (item: Item) => void;
  hover: (i: number) => void;
}) {
  const kind = () => propKind(props.prop);
  const issue = () => props.d.id;
  // Labels and milestones read again on every push; who can be assigned only as the picker opens.
  const offered = createMemo(() => {
    if (kind().live) pushes();
    return kind().read(props.d.repo_id);
  });
  const all = createMemo(() => kind().items(props.d, offered()));
  const shown = createMemo(() => {
    const t = props.text.trim().toLowerCase();
    if (!t) return all();
    return all().filter((i) => !i.none && (i.name.toLowerCase().includes(t) || (i.hint?.toLowerCase().includes(t) ?? false)));
  });
  onSettled(() => {
    props.listed(shown);
    return () => props.listed(undefined);
  });

  return (
    // Not a stop of its own on Tab (a scrolling box would be): the filter box drives it. A press
    // anywhere on it, a gap between options included, leaves focus in the filter box for the keys
    // (the picker's `onPointerDown`).
    <ul
      id={props.id}
      role="listbox"
      tabindex={-1}
      aria-multiselectable={kind().multi ? "true" : undefined}
      {...stylex.attrs(s.list)}
    >
      <For each={shown()} keyed={(i) => i.key} fallback={<li {...stylex.attrs(s.note)}>No {kind().noun} match</li>}>
        {(item, i) => {
          const busy = () => githubDown() || picking(issue(), item().op);
          return (
            <li
              id={`${props.id}-${i()}`}
              role="option"
              aria-selected={item().on ? "true" : "false"}
              aria-disabled={busy() ? "true" : undefined}
              data-perf="pick"
              data-index={i()}
              data-name={item().name}
              {...stylex.attrs(s.option, i() === props.active && s.active, busy() && s.busy)}
              onPointerMove={() => props.hover(i())}
              onClick={() => props.choose(item())}
            >
              <span {...stylex.attrs(s.tick)} aria-hidden="true">
                {item().on ? "✓" : ""}
              </span>
              <Show when={item().color}>{(c) => <span {...stylex.attrs(s.dot(`#${c()}`))} />}</Show>
              <Show when={item().login}>{(l) => <Avatar login={l()} size={18} />}</Show>
              <span {...stylex.attrs(s.name)}>{item().name}</span>
              <Show when={item().hint}>{(h) => <span {...stylex.attrs(s.hint)}>{h()}</span>}</Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

// Every value here is one the app already uses where it could be: StyleX's one stylesheet is
// first-load CSS.
const s = stylex.create({
  pop: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    boxSizing: "border-box",
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    position: "absolute",
    zIndex: 10,
    left: 0,
    top: "100%",
    width: 300,
  },
  filter: {
    font: "inherit",
    margin: 8,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 10,
    backgroundColor: colors.bg,
    color: colors.fg,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    maxHeight: 280,
    overflowY: "auto",
    paddingBottom: 4,
  },
  option: {
    gap: 8,
    paddingBlock: 4,
    paddingInline: 10,
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    minWidth: 0,
  },
  active: {
    backgroundColor: colors.hover,
  },
  busy: {
    cursor: "default",
    opacity: 0.5,
  },
  tick: {
    color: colors.accent,
    flexShrink: 0,
    width: 12,
  },
  // A dynamic style sets only `color`, painted through currentColor: see the list's label dot.
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
  name: {
    overflow: "hidden",
    flexShrink: 0,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
  hint: {
    overflow: "hidden",
    color: colors.muted,
    fontSize: 12,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  note: {
    margin: 0,
    listStyle: "none",
    paddingBlock: 4,
    paddingInline: 10,
    color: colors.muted,
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
});
