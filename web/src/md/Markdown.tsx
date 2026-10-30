// One body or comment, rendered: the walker's plain DOM inside one Solid component. A post's
// content is static: a change to a top-level block (or to what the mirror holds of its references)
// swaps that block's subtree, as a new search swaps every block's; nothing inside a block is a
// component of its own.
//
// Each top-level block is keyed by its position, in a wrapper that holds its spacing (#86: spacing
// lives inside blocks, never between them), so a block that opens or closes (HeldDetail.tsx) takes
// its gap with it, and a block of zero height takes no room. The walker's own block margins end
// flush in the wrapper; the wrapper gives the gap after it instead, and a heading's wrapper the
// room above it, so posts look as they did with the margins between blocks.
import * as stylex from "@stylexjs/stylex";
import { createMemo, For, Show } from "solid-js";
import { CueLine, cueStyles, type BodyMarks } from "../cue";
import type { Term } from "../highlight";
import type { Md, MdNode } from "./ast";
import type { Links } from "./links";
import { renderMd } from "./walker";

/**
 * A post: `md`, its links resolved against `links`, the search's `terms` marked. With `keyed`,
 * each block is marked `data-k` (`keyed` and its position), and `marks` shows the held changes'
 * cue and tint on its blocks.
 */
export function Markdown(props: { md: Md; links: Links; terms: Term[]; keyed?: string; marks?: BodyMarks }) {
  const within = (r: { from: number; to: number } | undefined, i: number) => r !== undefined && i >= r.from && i < r.to;
  const lineAt = (i: number) => (props.marks?.line?.at === i ? props.marks.line.label : undefined);
  return (
    <div {...stylex.attrs(s.md)} data-perf="md">
      <For each={props.md} keyed={false}>
        {(node, i) => {
          const nodes = createMemo(() => renderMd([node()], props.links, props.terms));
          const leaving = () => within(props.marks?.leaving, i);
          return (
            <>
              <Show when={lineAt(i)}>{(label) => <CueLine label={label()} />}</Show>
              <div
                data-k={props.keyed === undefined ? undefined : `${props.keyed}${i}`}
                data-cue={leaving() ? "leave" : undefined}
                {...stylex.attrs(s.block, spacingOf(node()), leaving() && cueStyles.leave, within(props.marks?.tint, i) && cueStyles.tint)}
              >
                {nodes()}
              </div>
            </>
          );
        }}
      </For>
      <Show when={lineAt(props.md.length)}>{(label) => <CueLine label={label()} />}</Show>
    </div>
  );
}

/** A top-level block's wrapper's spacing, where its kind differs from a paragraph's. */
function spacingOf(node: MdNode): stylex.StyleXStyles | false {
  if (!Array.isArray(node)) return false;
  const [tag, attrs] = node;
  if (tag === "section" && attrs && "data-footnotes" in attrs) return spacing.footnotes;
  return Object.hasOwn(spacing, tag) && tag !== "footnotes" && spacing[tag as keyof typeof spacing];
}

const s = stylex.create({
  md: {
    lineHeight: 1.55,
    overflowWrap: "anywhere",
    minWidth: 0,
  },
  // The gap after a block is its wrapper's own; the walker's block margins end flush in it. A plain
  // block, not its own formatting context, so text in the next block wraps beside a floated
  // (`align`ed) image. (Spaced by type: a cue line between blocks is a span.)
  block: {
    display: "block",
    paddingBottom: { default: "0.7em", ":last-of-type": 0 },
  },
});

// Blocks whose gaps differ from a paragraph's (0.7em after it), held in the wrapper as the margins
// they had between blocks: a heading has 1.1em of its own size above it, less the gap the block
// before it gives, and 0.5em of its own size below it; a rule and the footnotes 16 px around them.
const spacing = stylex.create({
  h1: { paddingBottom: { default: "0.725em", ":last-of-type": 0 }, paddingTop: { default: "0.895em", ":first-of-type": 0 } },
  h2: { paddingBottom: { default: "0.625em", ":last-of-type": 0 }, paddingTop: { default: "0.675em", ":first-of-type": 0 } },
  h3: { paddingBottom: { default: "0.55em", ":last-of-type": 0 }, paddingTop: { default: "0.51em", ":first-of-type": 0 } },
  h4: { paddingBottom: { default: "0.5em", ":last-of-type": 0 }, paddingTop: { default: "0.4em", ":first-of-type": 0 } },
  h5: { paddingBottom: { default: "0.465em", ":last-of-type": 0 }, paddingTop: { default: "0.323em", ":first-of-type": 0 } },
  h6: { paddingBottom: { default: "0.435em", ":last-of-type": 0 }, paddingTop: { default: "0.257em", ":first-of-type": 0 } },
  hr: { paddingBottom: { default: 16, ":last-of-type": 0 }, paddingTop: { default: "calc(16px - 0.7em)", ":first-of-type": 0 } },
  footnotes: { paddingTop: { default: "calc(16px - 0.7em)", ":first-of-type": 0 } },
});
