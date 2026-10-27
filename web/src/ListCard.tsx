// The list's hover card, its own chunk (loaded on the first hover): every open blocker a row
// carries, with its title, owner and status, or every label of a row past "+n". Everything comes
// with the row: nothing is fetched. A blocker opens in the panel; a stub opens on GitHub.
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { Avatar } from "./bits";
import type { Blocker } from "./bindings/Blocker";
import { blockerStatus, type CardAt } from "./cards";
import { ago } from "./time";
import { colors, fonts } from "./tokens.stylex";

/** The card's width, as its styles set it. */
const WIDTH = { blockers: 390, labels: 240 };

export function ListCard(props: { card: CardAt; search: string; keep: () => void; hide: () => void }) {
  const r = () => props.card.row;
  const left = () => Math.max(8, Math.min(props.card.at.left, innerWidth - WIDTH[props.card.kind] - 8));
  const labels = () => props.card.kind === "labels";
  return (
    <div
      role="dialog"
      aria-label={props.card.kind === "blockers" ? "Open blockers" : "Labels"}
      data-perf="card"
      {...stylex.attrs(s.card, s.place(left(), props.card.at.bottom + 4), labels() && s.narrow)}
      onPointerEnter={props.keep}
      onPointerLeave={props.hide}
    >
      <Show
        when={props.card.kind === "blockers"}
        fallback={
          <>
            <div {...stylex.attrs(s.head)}>{r().labels.length} labels</div>
            <For each={r().labels}>
              {(l) => (
                <div {...stylex.attrs(s.label)}>
                  <span {...stylex.attrs(s.dot(`#${l.color}`))} />
                  {l.name}
                </div>
              )}
            </For>
          </>
        }
      >
        <div {...stylex.attrs(s.head)}>
          Waits on {r().blocked_by} open {r().blocked_by === 1 ? "issue" : "issues"}
        </div>
        <For each={r().blockers}>{(b) => <Item b={b} search={props.search} />}</For>
        <Show when={r().blocked_by > r().blockers.length}>
          <p {...stylex.attrs(s.rest)}>and {r().blocked_by - r().blockers.length} more, in the issue</p>
        </Show>
      </Show>
    </div>
  );
}

function Item(props: { b: Blocker; search: string }) {
  const b = () => props.b;
  const status = () => blockerStatus(b());
  const chain = () => status() === "chain";
  const nobody = () => status() === "nobody";
  const says = () =>
    status() === "chain"
      ? `itself blocked by ${b().blocked_by}`
      : status() === "nobody"
        ? "nobody on it"
        : b().stub
          ? "not synced"
          : b().updated_at === null
            ? ""
            : `updated ${ago(b().updated_at!)} ago`;
  const href = () => (b().stub ? `https://github.com/${b().owner}/${b().repo}/issues/${b().number}` : `/issues/${b().id}${props.search}`);
  return (
    <a
      href={href()}
      noscroll
      target={b().stub ? "_blank" : undefined}
      rel={b().stub ? "noreferrer external" : undefined}
      data-perf="card-blocker"
      {...stylex.attrs(s.item)}
    >
      <span {...stylex.attrs(s.who)}>
        <Show when={b().assignee} fallback={<span {...stylex.attrs(s.noone)} title="Nobody assigned" />}>
          {(who) => <Avatar login={who()} />}
        </Show>
      </span>
      <span {...stylex.attrs(s.title)}>
        {b().title}
        {b().stub ? " ↗" : ""}
      </span>
      <span {...stylex.attrs(s.ref)}>
        {b().repo}#{b().number}
      </span>
      <span {...stylex.attrs(s.status, chain() && s.chain, nobody() && s.nobody)}>
        {b().assignee ? `${b().assignee} · ` : ""}
        {says()}
      </span>
    </a>
  );
}

const s = stylex.create({
  card: {
    padding: 8,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    boxSizing: "border-box",
    color: colors.fg,
    fontSize: 12.5,
    position: "fixed",
    whiteSpace: "normal",
    zIndex: 50,
    width: 390,
  },
  narrow: {
    width: 240,
  },
  place: (left: number, top: number) => ({
    left,
    top,
  }),
  head: {
    paddingInline: 4,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    paddingBottom: 4,
  },
  item: {
    padding: 4,
    borderRadius: 6,
    textDecoration: "none",
    alignItems: "center",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    color: "inherit",
    columnGap: 8,
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr) auto",
  },
  who: {
    gridRow: "span 2",
    alignSelf: "start",
    display: "flex",
    paddingTop: 1,
  },
  noone: {
    borderColor: colors.muted,
    borderRadius: "50%",
    borderStyle: "dashed",
    borderWidth: 1,
    boxSizing: "border-box",
    height: 18,
    width: 18,
  },
  title: {
    overflow: "hidden",
    fontWeight: 500,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ref: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
  status: {
    gridColumn: "2 / 4",
    color: colors.muted,
    fontSize: 12,
  },
  chain: {
    color: colors.danger,
  },
  nobody: {
    color: colors.unowned,
  },
  rest: {
    margin: 0,
    paddingInline: 4,
    color: colors.muted,
    fontSize: 12,
  },
  label: {
    gap: 6,
    paddingBlock: 2,
    paddingInline: 4,
    alignItems: "center",
    display: "flex",
  },
  // See the list's label dot (IssueList.tsx) for why only `color` is dynamic.
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
});
