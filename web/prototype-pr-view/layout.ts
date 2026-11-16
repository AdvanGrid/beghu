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
  /** TOP-LEVEL VARIANTS (#144): lay the edge out as if it ran to → from (an edge pointing in from outside), arrows unchanged. */
  reverse?: boolean;
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
  /** TOP-LEVEL VARIANTS (#144): the changed and unchanged groups inside the frame. */
  regions: { key: "C" | "U"; x: number; y: number; w: number; h: number }[];
  /** TOP-LEVEL VARIANTS (#144): the grid of parts with no lines, inside the frame. */
  pack?: { x: number; y: number; n: number };
  routes: Map<string, Routed>;
  width: number;
  height: number;
}

const elk = new ELK();
const GROUP = "__inside";
/** Room at the top of the box for its title. */
const GROUP_TOP = 44;
const BOX = "__box:";
const REGION = "__region:";
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
export async function layout(
  ids: string[],
  links: Link[],
  inside?: Set<string>,
  groups?: Map<string, string>,
  pack = false,
  /** TOP-LEVEL VARIANTS (#144): each part inside the frame in the changed (C) or unchanged (U) group. */
  split?: Map<string, "C" | "U">,
  direction: "RIGHT" | "DOWN" = "RIGHT",
): Promise<Laid> {
  const options = {
      "elk.algorithm": "layered",
      "elk.direction": direction,
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
      ...(split
        ? // TOP-LEVEL VARIANTS (#144): pack to the top left, so the changed group sits in the corner.
          { "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF", "elk.layered.nodePlacement.bk.fixedAlignment": new URLSearchParams(location.search).get("align") ?? (direction === "DOWN" ? "RIGHTDOWN" : "RIGHTUP") }
        : { "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" }),
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      // (No model-order option: ELK 0.12 fails with it once a box holds part of the graph.)
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "40",
  };
  const node = (id: string): ElkNode => ({ id, width: NODE_W, height: NODE_H });
  // TOP-LEVEL VARIANTS (#144): parts with no lines (and no grouping box) go in one grid-sized
  // block, which ELK places and routes around like any node.
  const linked = new Set(links.filter((l) => l.from !== l.to).flatMap((l) => [l.from, l.to]));
  const lone = pack ? ids.filter((id) => !linked.has(id) && !groups?.has(id) && (!inside || inside.size === 0 || inside.has(id))) : [];
  const PACK = "__pack";
  const GAP_X = 28, GAP_Y = 22;
  const cols = Math.max(1, Math.ceil(Math.sqrt(lone.length * 1.6)));
  const packNode: ElkNode | null =
    lone.length > 1
      ? { id: PACK, width: cols * (NODE_W + GAP_X) - GAP_X, height: Math.ceil(lone.length / cols) * (NODE_H + GAP_Y) - GAP_Y }
      : null;
  if (packNode) ids = ids.filter((id) => !lone.includes(id));
  const boxed = inside && inside.size > 0 && ids.some((id) => !inside.has(id));
  /** One side's nodes: ungrouped ones as they are, grouped ones in a box per value. */
  const side = (members: string[], where: string): ElkNode[] => {
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
  /** The parts inside the frame (or all of them, with no frame): split into the two groups when asked. */
  const insideKids = (members: string[]): ElkNode[] =>
    split
      ? (["C", "U"] as const)
          .map(
            (r): ElkNode => ({
              id: `${REGION}${r}`,
              layoutOptions: {
                ...options,
                "elk.padding": `[top=${GROUP_TOP},left=20,bottom=20,right=20]`,
                // The changed group hugs the start of its layer: the top side by side, the left stacked.
                ...(r === "C" ? { "elk.alignment": direction === "DOWN" ? "LEFT" : "TOP" } : {}),
              },
              children: [
                ...side(members.filter((id) => (split.get(id) ?? "U") === r), r),
                ...(packNode && r === "U" ? [packNode] : []),
              ],
            }),
          )
          .filter((r) => (r.children ?? []).length > 0)
      : [...side(members, "in"), ...(packNode ? [packNode] : [])];
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
            children: insideKids(ids.filter((id) => inside.has(id))),
          },
          ...side(ids.filter((id) => !inside.has(id)), "out"),
        ]
      : split
        ? [...insideKids(ids.filter((id) => split.has(id) && (!inside || inside.size === 0 || inside.has(id)))), ...side(ids.filter((id) => !split.has(id) || (inside && inside.size > 0 && !inside.has(id))), "out")]
        : [...side(ids, "out"), ...(packNode ? [packNode] : [])],
    edges: links
      .filter((l) => l.from !== l.to)
      .map((l) => ({
        id: l.key,
        sources: [l.reverse ? l.to : l.from],
        targets: [l.reverse ? l.from : l.to],
        labels: l.label ? [{ text: l.label, width: labelWidth(l.label), height: LABEL_H }] : [],
      })),
  };
  const out = await elk.layout(graph);
  const at = new Map<string, Placed>();
  let group: Laid["group"];
  const boxes: Laid["boxes"] = [];
  let packed: Laid["pack"];
  const regions: Laid["regions"] = [];
  const place = (c: ElkNode) => {
    if (c.id.startsWith(REGION)) {
      regions.push({ key: c.id.slice(REGION.length) as "C" | "U", x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      for (const k of c.children ?? []) place(k);
    } else if (c.id === PACK) {
      packed = { x: c.x ?? 0, y: c.y ?? 0, n: lone.length };
      lone.forEach((id, i) => at.set(id, { x: packed!.x + (i % cols) * (NODE_W + GAP_X), y: packed!.y + Math.floor(i / cols) * (NODE_H + GAP_Y) }));
    } else if (c.id.startsWith(BOX)) {
      boxes.push({ key: c.id, value: c.id.slice(BOX.length).split(":").slice(1).join(":"), x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      for (const k of c.children ?? []) place(k);
    } else if (c.id === GROUP) {
      group = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
      for (const k of c.children ?? []) place(k);
    } else at.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  };
  for (const c of out.children ?? []) place(c);
  const routes = new Map<string, Routed>();
  const reversed = new Set(links.filter((l) => l.reverse).map((l) => l.key));
  // TOP-LEVEL VARIANTS (#144): side by side, ELK centres blocks on their neighbours, which leaves the
  // frame and the changed group low. Lift each to the top when nothing else shares its column:
  // first the frame to the top of the drawing, then the changed group to the top of the frame.
  // Everything inside moves with it; a line leaving the block sideways gets a vertical jog just
  // outside it, spread across the gap on that side.
  type Rect = { x: number; y: number; w: number; h: number };
  const within = (p: { x: number; y: number }, r: Rect) => p.x >= r.x - 1 && p.x <= r.x + r.w + 1 && p.y >= r.y - 1 && p.y <= r.y + r.h + 1;
  const off = new URLSearchParams(location.search).has("nolift");
  const lifts: { r: Rect; dy: number; left: [number, number]; right: [number, number] }[] = [];
  const lift = (r: Rect | undefined, to: number) => {
    if (!r || off || !split || direction !== "RIGHT" || r.y - to < 4) return;
    const placed = [...at.values()];
    const alone = placed.every((p) => within(p, r) || p.x + NODE_W < r.x || p.x > r.x + r.w);
    if (!alone) return;
    // The free gap on each side: to the nearest node or box outside.
    const outside = [...placed.filter((p) => !within(p, r)).map((p) => ({ x: p.x, w: NODE_W })), ...boxes.filter((b) => !within(b, r))];
    const leftEdge = Math.max(r.x - 40, ...outside.filter((o) => o.x + o.w <= r.x).map((o) => o.x + o.w));
    const rightEdge = Math.min(r.x + r.w + 200, ...outside.filter((o) => o.x >= r.x + r.w).map((o) => o.x));
    const dy = r.y - to;
    lifts.push({ r: { ...r }, dy, left: [leftEdge, r.x], right: [r.x + r.w, rightEdge] });
    for (const [id, p] of at) if (within(p, r)) at.set(id, { x: p.x, y: p.y - dy });
    for (const b of boxes) if (within(b, r)) b.y -= dy;
    for (const g of regions) if (g !== r && within(g, r)) g.y -= dy;
    if (packed && within(packed, r)) packed.y -= dy;
    r.y -= dy;
  };
  lift(group, PAD);
  lift(
    regions.find((g) => g.key === "C"),
    group ? group.y + GROUP_TOP : PAD,
  );
  // Each line's points after the lifts, with the jogs; counted first so the jogs can be spread.
  const jogged = (pts: { x: number; y: number }[], L: (typeof lifts)[number], track: (side: "l" | "r") => number) => {
    const out: { x: number; y: number }[] = [];
    let jx: number | undefined;
    pts.forEach((p, i) => {
      const q = within(p, L.r) ? { x: p.x, y: p.y - L.dy } : p;
      const prev = pts[i - 1];
      if (prev && within(prev, L.r) !== within(p, L.r) && Math.abs(prev.y - p.y) < 0.5) {
        const right = Math.max(prev.x, p.x) > L.r.x + L.r.w;
        jx ??= track(right ? "r" : "l");
        const from = out[out.length - 1]!;
        out.push({ x: jx, y: from.y }, { x: jx, y: q.y });
      }
      out.push(q);
    });
    return out;
  };
  const sections = new Map<string, { x: number; y: number }[]>();
  for (const e of out.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    if (reversed.has(e.id)) sec.bendPoints?.reverse(), ([sec.startPoint, sec.endPoint] = [sec.endPoint, sec.startPoint]);
    sections.set(e.id, [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y })));
  }
  for (const L of lifts) {
    const count = { l: 0, r: 0 };
    for (const pts of sections.values()) jogged(pts, L, (side) => (count[side]++, 0));
    const used = { l: 0, r: 0 };
    const at = (side: "l" | "r") => {
      const [a, b] = side === "l" ? L.left : L.right;
      const step = Math.min(10, (b - a - 8) / Math.max(1, count[side]));
      const k = used[side]++;
      return side === "r" ? a + 6 + step * k : b - 6 - step * k;
    };
    for (const [id, pts] of sections) sections.set(id, jogged(pts, L, at));
  }
  // TOP-LEVEL VARIANTS (#144): flatten U-turns (up, across, back down; or right, down, back left)
  // where a straighter route crosses no node and runs on top of no other line.
  (globalThis as { __uturnFail?: unknown[] }).__uturnFail = [];
  // Only for the locked layout (the changed/unchanged split): it's costly, and other views don't need it.
  if (split && !new URLSearchParams(location.search).has("nouturn")) {
    const M = 8;
    const rects = [...at].map(([id, p]) => ({ id, x: p.x - M, y: p.y - M, w: NODE_W + 2 * M, h: NODE_H + 2 * M }));
    const ends = new Map((out.edges ?? []).map((e) => [e.id, [e.sources[0], e.targets[0]]]));
    type P = { x: number; y: number };
    const segs = (pts: P[]) => pts.slice(1).map((b, i) => [pts[i]!, b] as const);
    const hits = (a: P, b: P, skip: string[]) =>
      rects.some((r) => {
        if (skip.includes(r.id)) return false;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        return x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
      });
    const overlaps = (a: P, b: P, self: string) => {
      for (const [id, pts] of sections) {
        if (id === self) continue;
        for (const [c, d] of segs(pts)) {
          if (Math.abs(a.y - b.y) < 0.5 && Math.abs(c.y - d.y) < 0.5 && Math.abs(a.y - c.y) < 4) {
            if (Math.max(a.x, b.x) > Math.min(c.x, d.x) && Math.min(a.x, b.x) < Math.max(c.x, d.x)) return true;
          }
          if (Math.abs(a.x - b.x) < 0.5 && Math.abs(c.x - d.x) < 0.5 && Math.abs(a.x - c.x) < 4) {
            if (Math.max(a.y, b.y) > Math.min(c.y, d.y) && Math.min(a.y, b.y) < Math.max(c.y, d.y)) return true;
          }
        }
      }
      return false;
    };
    const tidy = (pts: P[]) =>
      pts.filter((p, i) => {
        const a = pts[i - 1], b = pts[i + 1];
        if (!a || !b) return true;
        if (Math.abs(a.x - p.x) < 0.5 && Math.abs(a.y - p.y) < 0.5) return false;
        return !((Math.abs(a.x - p.x) < 0.5 && Math.abs(p.x - b.x) < 0.5) || (Math.abs(a.y - p.y) < 0.5 && Math.abs(p.y - b.y) < 0.5));
      });
    for (const [id, orig] of sections) {
      let pts = tidy(orig);
      const skip = ends.get(id) ?? [];
      for (let pass = 0, changed = true; changed && pass < 20; pass++) {
        changed = false;
        for (let i = 0; i + 3 < pts.length; i++) {
          const [a, b, c, d] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
          const vert = Math.abs(a.x - b.x) < 0.5 && Math.abs(c.x - d.x) < 0.5 && Math.abs(b.y - c.y) < 0.5;
          const horz = Math.abs(a.y - b.y) < 0.5 && Math.abs(c.y - d.y) < 0.5 && Math.abs(b.x - c.x) < 0.5;
          const opposite = vert ? Math.sign(b.y - a.y) === -Math.sign(d.y - c.y) : horz ? Math.sign(b.x - a.x) === -Math.sign(d.x - c.x) : false;
          if (!opposite) continue;
          // Any height (or column) between the two ends turns the U into a step: try a's level,
          // d's, then evenly between, and take the first free of nodes and other lines.
          const lo = vert ? Math.min(a.y, d.y) : Math.min(a.x, d.x);
          const hi = vert ? Math.max(a.y, d.y) : Math.max(a.x, d.x);
          const first = vert ? a.y : a.x, last = vert ? d.y : d.x;
          const STEPS = Math.max(2, Math.min(300, Math.round((hi - lo) / 12)));
          const levels = [first, last, ...Array.from({ length: STEPS - 1 }, (_, k) => lo + ((hi - lo) * (k + 1)) / STEPS)];
          const isH = (u: P, v: P) => Math.abs(u.y - v.y) < 0.5;
          const log = (why: string) => ((globalThis as { __uturnFail?: unknown[] }).__uturnFail ??= []).push({ id, i, why });
          for (const lv of levels) {
            const route = tidy(vert ? [a, { x: a.x, y: lv }, { x: c.x, y: lv }, d] : [a, { x: lv, y: a.y }, { x: lv, y: d.y }, d]);
            // The first and last legs keep their direction, so lines still leave and enter nodes as before.
            if (i === 0 && route.length > 1 && isH(route[0]!, route[1]!) !== isH(a, b)) { log("first"); continue; }
            if (i + 3 === pts.length - 1 && route.length > 1 && isH(route[route.length - 2]!, route[route.length - 1]!) !== isH(c, d)) { log("last"); continue; }
            const hit = segs(route).some(([u, v]) => hits(u, v, skip));
            const lap = segs(route).some(([u, v]) => overlaps(u, v, id));
            if (hit || lap) { log(hit && lap ? "both" : hit ? "hit" : "lap"); continue; }
            pts = tidy([...pts.slice(0, i), ...route, ...pts.slice(i + 4)]);
            changed = true;
            break;
          }
          if (changed) break;
        }
      }
      sections.set(id, pts);
    }
  }
  for (const e of out.edges ?? []) {
    const pts = sections.get(e.id);
    if (!pts) continue;
    const lab = e.labels?.[0];
    routes.set(e.id, {
      d: rounded(pts),
      end: tip(pts[pts.length - 2]!, pts[pts.length - 1]!),
      start: tip(pts[1]!, pts[0]!),
      label: lab ? { x: lab.x ?? 0, y: lab.y ?? 0, w: lab.width ?? 0, h: lab.height ?? LABEL_H } : undefined,
    });
  }
  return { group, boxes, at, pack: packed, regions, routes, width: (out.width ?? 0) + PAD, height: (out.height ?? 0) + PAD };
}

/** The direction of a difference, with ELK's floating-point noise (1e-13 apart) counted as none. */
const sgn = (v: number) => (Math.abs(v) < 0.5 ? 0 : Math.sign(v));

function tip(from: { x: number; y: number }, to: { x: number; y: number }) {
  return { x: to.x, y: to.y, dx: sgn(to.x - from.x), dy: sgn(to.y - from.y) };
}

/** An orthogonal polyline with each corner rounded (never more than half the shorter segment). */
function rounded(pts: { x: number; y: number }[]): string {
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const r = Math.min(RADIUS, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - sgn(b.x - a.x) * r, inY = b.y - sgn(b.y - a.y) * r;
    const outX = b.x + sgn(c.x - b.x) * r, outY = b.y + sgn(c.y - b.y) * r;
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
