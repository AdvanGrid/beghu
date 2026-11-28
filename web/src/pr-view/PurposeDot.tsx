// A purpose's dot: its top-level purpose's colour (purposes.ts), as the canvas draws it on the
// blocks that serve it. The panel shows the same dots (in the trail, a purpose's title, "Its
// purposes, in order", "In this PR's purposes" and conflict rows), so the panel is the key.
import * as stylex from "@stylexjs/stylex";
import { cxTable } from "../cx";
import { graph } from "../tokens.stylex";
import { useNav } from "./nav";
import { purposesOf } from "./purposes";

const colour = stylex.create({
  p0: { backgroundColor: graph.purpose0 },
  p1: { backgroundColor: graph.purpose1 },
  p2: { backgroundColor: graph.purpose2 },
  p3: { backgroundColor: graph.purpose3 },
  p4: { backgroundColor: graph.purpose4 },
  p5: { backgroundColor: graph.purpose5 },
  p6: { backgroundColor: graph.purpose6 },
  p7: { backgroundColor: graph.purpose7 },
});

/** Each purpose colour's background (0–7). */
export const PURPOSE_DOT = [colour.p0, colour.p1, colour.p2, colour.p3, colour.p4, colour.p5, colour.p6, colour.p7];

/** The dot of purpose `id` (a sub-purpose takes its parent's colour). */
export function PurposeDot(props: { id: string; big?: boolean }) {
  const nav = useNav();
  const at = () => purposesOf(nav.model()).colour(props.id);
  return <span class={DOT[at() + (props.big ? 8 : 0)]!} aria-hidden="true" data-perf="purpose-dot" data-colour={at()} />;
}

const s = stylex.create({
  dot: { borderRadius: 999, display: "inline-block", flexShrink: 0, marginInlineEnd: 5, verticalAlign: "baseline", height: 9, width: 9, },
  big: { height: 11, width: 11 },
});

/** A dot's class: its colour (0–7), then the larger dot's (8–15). */
const DOT = cxTable(16, (i) => [s.dot, i >= 8 && s.big, PURPOSE_DOT[i % 8]]);
