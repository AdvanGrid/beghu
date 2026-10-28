// The relationship picker: `+ Blocked by`, `+ Blocking` and `+ Relates to` in the detail's Links
// row, `+ Set parent` over the title, `+ Add sub-issue` under the sub-issues, and a sub-issue's
// "Move to another parent…". A chunk of its own, loaded the first time one opens; it brings the
// writes code with it, since every pick is a write.
//
// It asks the server what the user typed names (`GET /api/issues/{id}/relatable`): `#12` (this repo),
// `repo#12`, `owner/repo#12`, a GitHub issue URL, or words from a title. Results come grouped by
// repo, this issue's repo first. An issue in a repo beghu doesn't sync is read from GitHub and
// offered as "not synced": picked, it links as a stub. What GitHub would refuse (a loop, nesting
// past 8 levels, a 101st sub-issue, a link that's there already) is listed dimmed with the reason,
// and can't be picked. A pick is sent at once as its own write and closes the picker. Its keys
// are the label picker's (`data-keys="picker"`): what's typed searches, arrows move, Enter picks,
// Escape closes.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Errored, For, Loading, onCleanup, onSettled, Show } from "solid-js";
import { query } from "@solidjs/router";
import { forgetFailure, GitHubDown, Gone, RateLimited, Refused, request, SessionEnded, signIn, Unreachable, type IssueOp as Op } from "./api";
import type { RelatedCandidate } from "./bindings/RelatedCandidate";
import type { RelationshipKind } from "./bindings/RelationshipKind";
import { issueState, StateIcon } from "./bits";
import { writesPaused } from "./live";
import type { ShownDetail } from "./overlay";
import { endOf, related, standIn, type ShownRelated } from "./related";
import { colors, fonts } from "./tokens.stylex";
import { sendRelationship, type RelatedLook } from "./writes";

const getRelatable = query(
  (id: number, kind: RelationshipKind, q: string) => request<RelatedCandidate[]>(`/api/issues/${id}/relatable?kind=${kind}&q=${encodeURIComponent(q)}`),
  "relatable",
);

/** How long typing rests before the picker asks. */
const ASK_AFTER_MS = 150;

/** What each picker is called, as its box and its dialog say. */
const NOUN: Record<RelationshipKind, string> = {
  blocked_by: "Blocked by",
  blocking: "Blocking",
  relates: "Relates to",
  parent: "Parent",
  sub: "Sub-issue",
};

/** A picked issue as the lists show it until GitHub's data does. */
function shown(c: RelatedCandidate): ShownRelated {
  return standIn(endOf(c), c);
}

/** The write picking `c` makes, and how it shows. `subject` is the issue linked: the open one, or a sub-issue of it being moved. */
function writeFor(
  kind: RelationshipKind,
  d: ShownDetail,
  subject: ShownRelated & { id: number },
  c: RelatedCandidate,
): { op: Op; look: { relationship: RelatedLook } } | undefined {
  const me = related(d);
  const other = shown(c);
  const end = endOf(c);
  switch (kind) {
    case "blocked_by":
    case "blocking":
      return { op: { kind: "block_add", issue: d.id, other: end, blocking: kind === "blocking" }, look: { relationship: { issue: me, other } } };
    case "relates":
      return { op: { kind: "relate_add", issue: d.id, other: end }, look: { relationship: { issue: me, other } } };
    case "sub":
      return { op: { kind: "sub_add", issue: d.id, child: end, replace_parent: false, after: null }, look: { relationship: { issue: me, other } } };
    case "parent": {
      if (c.id === null) return undefined;
      // The subject moves under the picked issue, from the parent it has: the open issue for one of
      // its sub-issues, or the open issue's own parent.
      const from = subject.id === d.id ? (d.relationships.parent?.id ?? undefined) : d.id;
      return {
        op: { kind: "sub_add", issue: c.id, child: endOf(subject), replace_parent: true, after: null },
        look: { relationship: { issue: { ...other, id: c.id }, other: subject, from } },
      };
    }
  }
}

/** Why the list didn't load, in the server's words where it has some. */
function whyNot(e: unknown): string {
  const known = e instanceof RateLimited || e instanceof Refused || e instanceof GitHubDown || e instanceof Gone || e instanceof Unreachable;
  return known ? e.message : "something went wrong";
}

/**
 * The picker linking `subject` (the open issue `d` unless given: a sub-issue being moved) as
 * `kind`. `onClose` closes it; `refocus` says whether focus goes back to the button that opened
 * it (Escape, a pick), or stays where the user clicked.
 */
export function RelationshipPicker(props: {
  kind: RelationshipKind;
  d: ShownDetail;
  subject?: ShownRelated & { id: number };
  onClose: (refocus: boolean) => void;
  opener?: HTMLElement;
  /** Opened from the panel's right edge: it lines up with that edge rather than overflowing it. */
  end?: boolean;
}) {
  const subject = () => props.subject ?? related(props.d);
  const [text, setText] = createSignal("");
  const [asked, setAsked] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [list, setList] = createSignal<(() => RelatedCandidate[]) | undefined>(undefined);
  const items = () => list()?.() ?? [];
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;
  let wait: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(wait));

  const choose = (c: RelatedCandidate | undefined) => {
    if (!c || c.why_not !== null || writesPaused()) return;
    const w = writeFor(props.kind, props.d, subject(), c);
    if (!w) return;
    sendRelationship(w.op, w.look);
    props.onClose(true);
  };

  onSettled(() => {
    input.focus();
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
    else if (e.key === "Enter") {
      // What's typed but not yet asked about is asked now.
      if (text().trim() !== asked()) {
        clearTimeout(wait);
        setAsked(text().trim());
      } else choose(items()[active()]);
    } else if (e.key === "Escape") props.onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
    root.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onFocusOut = (e: FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    if (to?.closest('[data-keys="help"]')) return;
    if (to && !root.contains(to) && !props.opener?.contains(to)) props.onClose(false);
  };

  const listId = () => `relationship-picker-${props.kind}-${subject().id}`;
  const activeId = () => (active() < items().length ? `${listId()}-${active()}` : undefined);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Pick ${NOUN[props.kind].toLowerCase()}`}
      data-perf="relationship-picker"
      data-kind={props.kind}
      data-keys="picker"
      {...stylex.attrs(s.pop, props.end && s.popEnd)}
      onKeyDown={onKeyDown}
      onFocusOut={onFocusOut}
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
        aria-label={`${NOUN[props.kind]}: #12, repo#12, a link or title words`}
        placeholder="#12, repo#12, a link or title words"
        value={text()}
        onInput={(e) => {
          const t = e.currentTarget.value;
          setText(t);
          setActive(0);
          clearTimeout(wait);
          wait = setTimeout(() => setAsked(t.trim()), ASK_AFTER_MS);
        }}
        {...stylex.attrs(s.filter)}
      />
      <Show when={asked()} fallback={<p {...stylex.attrs(s.note)}>Type an issue's number, its link, or words from its title</p>}>
        <Errored
          fallback={(err, reset) => (
            <p {...stylex.attrs(s.note)} role="alert">
              Couldn't look: {whyNot(err())} ·{" "}
              <button
                type="button"
                {...stylex.attrs(s.link)}
                onClick={() => {
                  if (err() instanceof SessionEnded) return signIn();
                  forgetFailure(getRelatable);
                  reset();
                }}
              >
                Retry
              </button>
            </p>
          )}
        >
          <Loading fallback={<p {...stylex.attrs(s.note)} aria-busy="true">Looking…</p>}>
            <Options
              id={subject().id}
              kind={props.kind}
              q={asked()}
              active={active()}
              listId={listId()}
              listed={(shown) => setList(() => shown)}
              choose={choose}
              hover={setActive}
            />
          </Loading>
        </Errored>
      </Show>
    </div>
  );
}

function Options(props: {
  id: number;
  kind: RelationshipKind;
  q: string;
  active: number;
  listId: string;
  listed: (shown: (() => RelatedCandidate[]) | undefined) => void;
  choose: (c: RelatedCandidate) => void;
  hover: (i: number) => void;
}) {
  const found = createMemo(() => getRelatable(props.id, props.kind, props.q));
  onSettled(() => {
    props.listed(found);
    return () => props.listed(undefined);
  });
  /** Whether candidate `i` starts a repo's group. */
  const starts = (i: number) => {
    const all = found();
    return i === 0 || all[i - 1]!.repo !== all[i]!.repo || all[i - 1]!.owner !== all[i]!.owner;
  };
  return (
    <ul id={props.listId} role="listbox" tabindex={-1} {...stylex.attrs(s.list)}>
      <For each={found()} keyed={(c) => `${c.owner}/${c.repo}#${c.number}`} fallback={<li {...stylex.attrs(s.note)}>No issue matches</li>}>
        {(c, i) => {
          const off = () => c().why_not !== null || writesPaused();
          return (
            <>
              <Show when={starts(i())}>
                <li role="presentation" data-perf="relationship-group" {...stylex.attrs(s.group)}>
                  {c().owner}/{c().repo}
                </li>
              </Show>
              <li
                id={`${props.listId}-${i()}`}
                role="option"
                aria-selected={i() === props.active ? "true" : "false"}
                aria-disabled={off() ? "true" : undefined}
                data-perf="relationship-option"
                data-index={i()}
                data-ref={`${c().repo}#${c().number}`}
                title={c().why_not ?? undefined}
                {...stylex.attrs(s.option, i() === props.active && s.active, off() && s.off)}
                onPointerMove={() => props.hover(i())}
                onClick={() => props.choose(c())}
              >
                <span {...stylex.attrs(s.icon)}>
                  <StateIcon state={issueState({ state: c().state ?? "open", state_reason: null })} />
                </span>
                <span {...stylex.attrs(s.ref)}>#{c().number}</span>
                <span {...stylex.attrs(s.name)}>{c().title ?? `${c().owner}/${c().repo}#${c().number}`}</span>
                <Show when={c().stub}>
                  <span {...stylex.attrs(s.stub)}>not synced</span>
                </Show>
                <Show when={c().why_not}>{(why) => <span {...stylex.attrs(s.why)} data-perf="why-not">{why()}</span>}</Show>
              </li>
            </>
          );
        }}
      </For>
    </ul>
  );
}

// Values the label picker uses where they could be the same: StyleX's one stylesheet is
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
    width: 360,
  },
  popEnd: {
    left: "auto",
    right: 0,
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
  group: {
    paddingInline: 10,
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: 600,
    paddingTop: 6,
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
  off: {
    cursor: "default",
    opacity: 0.55,
  },
  icon: {
    display: "flex",
    flexShrink: 0,
  },
  ref: {
    color: colors.muted,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  stub: {
    borderColor: colors.muted,
    borderRadius: 999,
    borderStyle: "dashed",
    borderWidth: 1,
    paddingInline: 6,
    color: colors.muted,
    flexShrink: 0,
    fontSize: 10.5,
  },
  why: {
    overflow: "hidden",
    color: colors.muted,
    flexShrink: 1,
    fontSize: 11.5,
    marginInlineStart: "auto",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
