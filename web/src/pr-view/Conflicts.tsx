// The panel's Conflicts section (#183): two facts about the PR that don't agree, side by side,
// with no verdict anywhere.
//
// - A card: the question both sides answer, with its kind small on the right ("stated vs code",
//   "purpose vs purpose", "purpose vs code outside the diff"); then one row per side: who says it
//   (the purpose with its dot, "PR description", "#N", "The code", "Code outside the diff") and
//   its few-word answer (`says`).
// - Opening a row shows the whole fact (`text`) and its source: the quote, or the claim box. A
//   purpose's side adds "Go to the purpose ›"; code outside the diff lists its first break sites
//   with their evidence, then "and N more", with the search that found them.
// - Hovering a card lights everything it touches on the canvas (its parts and lines).
// - Conflicts with the same cause form one card: the cause and its claims, then each question
//   with its two rows. Cause cards come first, then lone conflicts, each in reading order
//   (purposes.ts `cards`).
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";
import type { Conflict, ConflictKind, Side } from "../bindings/analysis";
import { colors, fonts } from "../tokens.stylex";
import { useCanvas } from "./canvas/store";
import { ClaimList, claimCount, SourceBox } from "./claims";
import type { Model } from "./model";
import { useNav } from "./nav";
import { issueLabel, purposesOf, type Card } from "./purposes";
import { PurposeDot } from "./PurposeDot";
import { Fold, ui } from "./ui";

export const CONFLICT_KIND: Record<ConflictKind, string> = {
  "stated-code": "stated vs code",
  "purpose-purpose": "purpose vs purpose",
  "purpose-outside": "purpose vs code outside the diff",
};

/** "Conflicts (n)" with its cards, or nothing when there are none. */
export function Conflicts(props: { list: readonly Conflict[] }) {
  const nav = useNav();
  const cards = () => purposesOf(nav.model()).cards(props.list);
  return (
    <Show when={props.list.length > 0}>
      <section data-perf="conflicts">
        <h3 {...stylex.attrs(ui.h3)}>Conflicts ({props.list.length})</h3>
        <div {...stylex.attrs(ui.stack)}>
          <For each={cards()}>{(card) => <ConflictCard card={card} />}</For>
        </div>
      </section>
    </Show>
  );
}

/** One card: a lone conflict, or a cause's conflicts. */
export function ConflictCard(props: { card: Card }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const conflicts = () => (props.card.kind === "one" ? [props.card.conflict] : props.card.conflicts);
  const light = () => {
    const cs = conflicts();
    c.light({ nodes: cs.flatMap((x) => x.touches.nodes), edges: cs.flatMap((x) => x.touches.edges) });
  };
  const cause = () => (props.card.kind === "cause" ? m().a.causes.find((x) => x.id === (props.card as { cause: string }).cause) : undefined);
  return (
    <article
      {...stylex.attrs(s.card)}
      data-perf={props.card.kind === "cause" ? "cause-card" : "conflict-card"}
      data-id={props.card.kind === "cause" ? props.card.cause : props.card.conflict.id}
      onPointerEnter={light}
      onPointerLeave={() => c.light(undefined)}
      onFocusIn={light}
      onFocusOut={() => c.light(undefined)}
    >
      <Show when={cause()}>
        {(x) => (
          <header {...stylex.attrs(s.cause)} data-perf="cause">
            <span {...stylex.attrs(s.causeLabel)}>Shared cause</span>
            <span>{x().text}</span>
            <Show when={x().claims.length > 0}>
              <Fold nested summary={<span {...stylex.attrs(ui.muted, ui.small)}>{claimCount(m(), x().claims)}</span>}>
                <ClaimList m={m()} ids={x().claims} />
              </Fold>
            </Show>
          </header>
        )}
      </Show>
      <For each={conflicts()}>{(k) => <Question k={k} />}</For>
    </article>
  );
}

function Question(props: { k: Conflict }) {
  const [open, setOpen] = createSignal<"a" | "b">();
  return (
    <div {...stylex.attrs(s.question)} data-perf="conflict" data-id={props.k.id}>
      <div {...stylex.attrs(s.head)}>
        <span {...stylex.attrs(s.title)} data-perf="conflict-question">
          {props.k.question}
        </span>
        <span {...stylex.attrs(s.kind)} data-perf="conflict-kind">
          {CONFLICT_KIND[props.k.kind]}
        </span>
      </div>
      <Row k={props.k} side={props.k.a} open={open() === "a"} toggle={() => setOpen(open() === "a" ? undefined : "a")} />
      <Row k={props.k} side={props.k.b} open={open() === "b"} toggle={() => setOpen(open() === "b" ? undefined : "b")} />
    </div>
  );
}

/** Who says it, in a word or two. */
function who(m: Model, side: Side): string {
  switch (side.who) {
    case "purpose":
      return (side.purpose !== undefined && purposesOf(m).byId.get(side.purpose)?.name) || "A purpose";
    case "description":
      return "PR description";
    case "issue": {
      const ref = side.claims.flatMap((id) => m.stubs.get(id)?.issues ?? [])[0];
      return ref ? issueLabel(m, ref) : "An issue";
    }
    case "code":
      return "The code";
    case "outside":
      return "Code outside the diff";
  }
}

function Row(props: { k: Conflict; side: Side; open: boolean; toggle: () => void }) {
  const nav = useNav();
  const m = () => nav.model();
  const side = () => props.side;
  const rule = () => (props.k.rule == null ? undefined : m().a.purposes.flatMap((p) => p.rules ?? []).find((r) => r.id === props.k.rule));
  return (
    <div data-perf="conflict-side" data-who={side().who}>
      <button type="button" {...stylex.attrs(s.row, props.open && s.rowOpen)} aria-expanded={props.open ? "true" : "false"} data-perf="conflict-row" onClick={() => props.toggle()}>
        <span {...stylex.attrs(s.who)} data-perf="conflict-who">
          <Show when={side().who === "purpose" && side().purpose}>{(id) => <PurposeDot id={id()} />}</Show>
          {who(m(), side())}
        </span>
        <span {...stylex.attrs(s.says)} data-perf="conflict-says">
          {side().says}
        </span>
        <span {...stylex.attrs(ui.muted)} aria-hidden="true">
          {props.open ? "▾" : "▸"}
        </span>
      </button>
      <Show when={props.open}>
        <div {...stylex.attrs(s.detail)} data-perf="conflict-detail">
          <p {...stylex.attrs(ui.p)} data-perf="conflict-text">
            {side().text}
          </p>
          <Show when={side().who === "purpose" && side().purpose}>
            {(id) => (
              <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent, ui.small)} data-perf="go-to-purpose" onClick={() => nav.select({ kind: "purpose", ids: [id()] })}>
                Go to the purpose ›
              </button>
            )}
          </Show>
          {/* Its source: what the description or the issue says, quoted; else the claim box. */}
          <Show when={side().who === "description" || side().who === "issue"} fallback={<ClaimList m={m()} ids={side().claims} />}>
            <SourceBox m={m()} ids={side().claims} kind={side().who === "issue" ? "issue" : "description"} />
          </Show>
          <Show when={side().sites}>
            {(sites) => (
              <div {...stylex.attrs(ui.stack)} data-perf="conflict-sites">
                <span {...stylex.attrs(ui.muted, ui.small)}>
                  {sites().claims.length} {sites().claims.length === 1 ? "site" : "sites"} where it breaks
                </span>
                <ClaimList m={m()} ids={sites().claims} />
                <Show when={sites().more > 0}>
                  <p {...stylex.attrs(ui.p, ui.small)} data-perf="conflict-more">
                    and {sites().more} more
                  </p>
                </Show>
                <Show when={rule()}>
                  {(r) => (
                    <p {...stylex.attrs(ui.p, ui.small, ui.muted)} data-perf="conflict-search">
                      Found by: {r().checked.searched}
                    </p>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

const s = stylex.create({
  card: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
    backgroundColor: { default: colors.bg, ":hover": colors.bgRaised },
    display: "flex",
    flexDirection: "column",
  },
  cause: {
    gap: 4,
    paddingBlock: 8,
    paddingInline: 10,
    backgroundColor: colors.bgRaised,
    display: "flex",
    flexDirection: "column",
    fontWeight: 600,
    lineHeight: 1.4,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  causeLabel: { color: colors.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  question: {
    borderTopColor: colors.line,
    borderTopStyle: { default: "solid", ":first-child": "none" },
    borderTopWidth: 1,
  },
  head: { gap: 8, paddingBlock: 8, paddingInline: 10, alignItems: "baseline", display: "flex", justifyContent: "space-between" },
  title: { fontWeight: 650, lineHeight: 1.35, overflowWrap: "anywhere" },
  kind: { color: colors.muted, flexShrink: 0, fontSize: 11, whiteSpace: "nowrap" },
  row: {
    borderWidth: 0,
    gap: 10,
    paddingBlock: 6,
    paddingInline: 10,
    alignItems: "baseline",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    display: "grid",
    fontFamily: fonts.ui,
    fontSize: 13,
    gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr) auto",
    textAlign: "start",
    borderTopColor: colors.line,
    borderTopStyle: "dashed",
    borderTopWidth: 1,
    width: "100%",
  },
  rowOpen: { backgroundColor: { default: colors.selected, ":hover": colors.selected } },
  who: { alignItems: "baseline", color: colors.muted, display: "flex", overflowWrap: "anywhere" },
  says: { fontWeight: 600, overflowWrap: "anywhere" },
  detail: { gap: 6, paddingBlock: 8, paddingInline: 12, display: "flex", flexDirection: "column", fontSize: 12.5 },
});
