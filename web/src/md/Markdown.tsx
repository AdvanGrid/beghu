// One body or comment, rendered: the walker's plain DOM inside one Solid component. A post's
// content is static, so a change to it (or to what the mirror holds of its references) swaps the
// whole subtree, as does a new search; nothing inside is a component of its own.
import * as stylex from "@stylexjs/stylex";
import { createMemo } from "solid-js";
import type { Term } from "../highlight";
import type { Md } from "./ast";
import type { Links } from "./links";
import { renderMd } from "./walker";

/** A post: `md`, its links resolved against `links`, the search's `terms` marked. */
export function Markdown(props: { md: Md; links: Links; terms: Term[] }) {
  const nodes = createMemo(() => renderMd(props.md, props.links, props.terms));
  return (
    <div {...stylex.attrs(s.md)} data-perf="md">
      {nodes()}
    </div>
  );
}

const s = stylex.create({
  md: {
    lineHeight: 1.55,
    overflowWrap: "anywhere",
    minWidth: 0,
  },
});
