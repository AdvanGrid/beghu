// PROTOTYPE (PR view). Layout through ELK's layered algorithm (elkjs), left to right, with
// orthogonal edges: only horizontal and vertical segments, so lines cross only at right angles;
// parallel segments kept apart; edges routed around nodes; and each edge's label on its own
// horizontal stretch, in a layer ELK widens to fit the label, so nodes move apart to make room.
// Placement follows the graph's structure only, never likeness between nodes.
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export const NODE_W = 216;
export const NODE_H = 74;
const LABEL_H = 16;
const PAD = 24;
/** Corner radius where an edge turns. */
const RADIUS = 6;

export interface Placed {
  x: number;
  y: number;
}

export interface Link {
  key: string;
  from: string;
  to: string;
  label: string;
}

export interface Routed {
  /** The rounded orthogonal path. */
  d: string;
  /** Arrowheads: the tip and the direction the line arrives in, at the end and (for two-way) the start. */
  end: { x: number; y: number; dx: number; dy: number };
  start: { x: number; y: number; dx: number; dy: number };
  /** The label's box (top left), on a horizontal segment. */
  label?: { x: number; y: number; w: number; h: number };
}

export interface Laid {
  /** The box around what's inside the zoomed-into node, when there is one. */
  group?: { x: number; y: number; w: number; h: number };
  /** Grouping boxes (a facet's value), inside or outside that box. */
  boxes: { key: string; value: string; x: number; y: number; w: number; h: number }[];
  at: Map<string, Placed>;
  routes: Map<string, Routed>;
  width: number;
  height: number;
}

const elk = new ELK();
const GROUP = "__inside";
/** Room at the top of the box for its title. */
const GROUP_TOP = 44;
const BOX = "__box:";
/** Room at the top of a grouping box for its label. */
const BOX_TOP = 44;

let ctx: CanvasRenderingContext2D | null = null;
/** The label's drawn width, measured in the font the page draws it with. */
export function labelWidth(text: string): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 6.4 + 12;
  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  return Math.ceil(ctx.measureText(text).width) + 12;
}

/**
 * Lays out `ids`, with the ones in `inside` (the zoomed-into node's contents) in a box of their
 * own; the rest, outside it, are placed around the box by their connections. Nodes in `groups`
 * (node → a facet value) sit in a box per value, on whichever side of the big box they are:
 * one value can have a box inside and one outside.
 */
export async function layout(ids: string[], links: Link[], inside?: Set<string>, groups?: Map<string, string>): Promise<Laid> {
  const options = {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.mergeEdges": "false",
      // Gaps: between parallel segments, between an edge and a node, between nodes.
      "elk.spacing.edgeEdge": "10",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
      "elk.spacing.edgeNode": "18",
      "elk.layered.spacing.edgeNodeBetweenLayers": "18",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.edgeLabel": "3",
      // Labels sit on the edge, mid-way, in a layer of their own that grows to fit them.
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.edgeLabels.centerLabelPlacementStrategy": "SPACE_EFFICIENT_LAYER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      // (No model-order option: ELK 0.12 fails with it once a box holds part of the graph.)
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "40",
  };
  const node = (id: string): ElkNode => ({ id, width: NODE_W, height: NODE_H });
  const boxed = inside && inside.size > 0 && ids.some((id) => !inside.has(id));
  /** One side's nodes: ungrouped ones as they are, grouped ones in a box per value. */
  const side = (members: string[], where: "in" | "out"): ElkNode[] => {
    const loose = members.filter((id) => !groups?.has(id));
    const byValue = new Map<string, string[]>();
    for (const id of members) {
      const v = groups?.get(id);
      if (v !== undefined) byValue.set(v, [...(byValue.get(v) ?? []), id]);
    }
    return [
      ...loose.map(node),
      ...[...byValue].map(([v, ids]) => ({
        id: `${BOX}${where}:${v}`,
        layoutOptions: { ...options, "elk.padding": `[top=${BOX_TOP},left=22,bottom=24,right=22]`, "elk.spacing.nodeNode": "28" },
        children: ids.map(node),
      })),
    ];
  };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      ...options,
      "elk.padding": `[top=${PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
      // One layout across the box's border, every coordinate relative to the drawing.
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
    },
    children: boxed
      ? [
          {
            id: GROUP,
            layoutOptions: { ...options, "elk.padding": `[top=${GROUP_TOP},left=20,bottom=20,right=20]` },
            children: side(ids.filter((id) => inside.has(id)), "in"),
          },
          ...side(ids.filter((id) => !inside.has(id)), "out"),
        ]
      : side(ids, "out"),
    edges: links
      .filter((l) => l.from !== l.to)
      .map((l) => ({
        id: l.key,
        sources: [l.from],
        targets: [l.to],
        labels: l.label ? [{ text: l.label, width: labelWidth(l.label), height: LABEL_H }] : [],
      })),
  };
  const out = await elk.layout(graph);
  const at = new Map<string, Placed>();
  let group: Laid["group"];
  const boxes: Laid["boxes"] = [];
  const place = (c: ElkNode) => {
    if (c.id.startsWith(BOX)) {
      boxes.push({ key: c.id, value: c.id.slice(BOX.length).split(":").slice(1).join(":"), x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      for (const k of c.children ?? []) place(k);
    } else if (c.id === GROUP) {
      group = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
      for (const k of c.children ?? []) place(k);
    } else at.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  };
  for (const c of out.children ?? []) place(c);
  const routes = new Map<string, Routed>();
  for (const e of out.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y }));
    const lab = e.labels?.[0];
    routes.set(e.id, {
      d: rounded(pts),
      end: tip(pts[pts.length - 2]!, pts[pts.length - 1]!),
      start: tip(pts[1]!, pts[0]!),
      label: lab ? { x: lab.x ?? 0, y: lab.y ?? 0, w: lab.width ?? 0, h: lab.height ?? LABEL_H } : undefined,
    });
  }
  return { group, boxes, at, routes, width: (out.width ?? 0) + PAD, height: (out.height ?? 0) + PAD };
}

function tip(from: { x: number; y: number }, to: { x: number; y: number }) {
  return { x: to.x, y: to.y, dx: Math.sign(to.x - from.x), dy: Math.sign(to.y - from.y) };
}

/** An orthogonal polyline with each corner rounded (never more than half the shorter segment). */
function rounded(pts: { x: number; y: number }[]): string {
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const r = Math.min(RADIUS, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * r, inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r, outY = b.y + Math.sign(c.y - b.y) * r;
    d += ` L${inX},${inY} Q${b.x},${b.y} ${outX},${outY}`;
  }
  const z = pts[pts.length - 1]!;
  return `${d} L${z.x},${z.y}`;
}

/** An arrowhead at `t`, pointing the way the line arrives. */
export function arrow(t: { x: number; y: number; dx: number; dy: number }): string {
  const { x, y, dx, dy } = t;
  // Back along the line 9, out to each side 5.
  const bx = x - dx * 9, by = y - dy * 9;
  return `M${x},${y} L${bx - dy * 5},${by + dx * 5} L${bx + dy * 5},${by - dx * 5} Z`;
}
