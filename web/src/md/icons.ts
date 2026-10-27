// The icons posts use, from one inline SVG sprite: a `<symbol>` per icon, put in the document
// once (the first time a post needs one), and an `<svg><use>` per use. They cost no request and
// no font, take `currentColor`, and look the same on every OS (Unicode glyphs don't). Built with
// DOM calls from the shapes below, never parsed from markup.
import * as stylex from "@stylexjs/stylex";

type Shape = [tag: "path" | "circle", attrs: Record<string, string>];

const LINE = { fill: "none", stroke: "currentColor", "stroke-width": "1.5" };
const ROUND = { ...LINE, "stroke-linecap": "round", "stroke-linejoin": "round" };
const DOT = (cx: string, cy: string, r: string): Shape => ["circle", { cx, cy, r, fill: "currentColor" }];
const RING: Shape = ["circle", { cx: "8", cy: "8", r: "6.25", ...LINE }];

/** Each icon's shapes, on a 16 × 16 grid. */
const ICONS = {
  // Alerts: note, tip, important, warning, caution.
  info: [RING, ["path", { d: "M8 7v4.5", ...ROUND }], DOT("8", "4.75", "1")],
  bulb: [
    ["path", { d: "M8 1.75a4.25 4.25 0 0 0-2.6 7.6c.5.4.85.95.85 1.6v.3h3.5v-.3c0-.65.35-1.2.85-1.6A4.25 4.25 0 0 0 8 1.75Z", ...ROUND }],
    ["path", { d: "M6.25 13.75h3.5", ...ROUND }],
  ],
  report: [["path", { d: "M2.75 2.75h10.5v8h-6l-3 2.5v-2.5h-1.5z", ...ROUND }], ["path", { d: "M8 4.75v3", ...ROUND }], DOT("8", "9.4", ".9")],
  alert: [["path", { d: "M8 2.25 14.25 13.5H1.75z", ...ROUND }], ["path", { d: "M8 6.5v3", ...ROUND }], DOT("8", "11.4", ".9")],
  stop: [["path", { d: "M5.5 1.75h5l3.75 3.75v5l-3.75 3.75h-5L1.75 10.5v-5z", ...ROUND }], ["path", { d: "M8 4.75v3.5", ...ROUND }], DOT("8", "10.75", ".9")],
  // A code block's header.
  code: [["path", { d: "M5.5 4 1.75 8l3.75 4M10.5 4l3.75 4-3.75 4", ...ROUND }]],
  // A reference's state (bits.tsx's StateIcon).
  open: [RING, DOT("8", "8", "1.5")],
  done: [RING, ["path", { d: "M5.2 8.2 7.1 10l3.7-4", ...LINE }]],
  notPlanned: [RING, ["path", { d: "M3.8 12.2 12.2 3.8", ...LINE }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

const SVG = "http://www.w3.org/2000/svg";
const ID = "beghu-md-icon-";

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Puts the sprite in the document, unless it's there. */
function sprite(): void {
  if (document.getElementById(`${ID}sprite`)) return;
  const root = svg("svg", { id: `${ID}sprite`, "aria-hidden": "true", width: "0", height: "0" });
  root.setAttribute("class", stylex.props(s.sprite).className ?? "");
  for (const [name, shapes] of Object.entries(ICONS)) {
    const symbol = svg("symbol", { id: ID + name, viewBox: "0 0 16 16" });
    for (const [tag, attrs] of shapes) symbol.append(svg(tag, attrs));
    root.append(symbol);
  }
  document.body.append(root);
}

/** Icon `name`, 1em square in the text's colour unless `style` says otherwise. */
export function icon(name: IconName, style?: stylex.StyleXStyles): SVGSVGElement {
  sprite();
  const e = svg("svg", { "aria-hidden": "true", viewBox: "0 0 16 16" }) as SVGSVGElement;
  e.setAttribute("class", stylex.props(s.icon, style).className ?? "");
  e.append(svg("use", { href: `#${ID}${name}` }));
  return e;
}

const s = stylex.create({
  icon: {
    flexShrink: 0,
    verticalAlign: "-0.14em",
    height: "1em",
    width: "1em",
  },
  sprite: {
    overflow: "hidden",
    position: "absolute",
  },
});
