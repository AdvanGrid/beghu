// SVG path data for the canvas's lines: orthogonal routes with rounded corners, from our layout's
// exact points, and arrowheads where a line arrives.
import type { P } from "../layout/types";

const RADIUS = 8;
const sgn = (v: number) => (Math.abs(v) < 0.5 ? 0 : Math.sign(v));

/** The route without repeated or collinear points. */
function clean(pts: readonly P[]): P[] {
  const out: P[] = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const prev = out.at(-2);
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** An orthogonal polyline with each corner rounded (never more than half the shorter segment). */
export function rounded(raw: readonly P[]): string {
  const pts = clean(raw);
  if (pts.length === 0) return "";
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

/** Where a route arrives: its end (or its start, for `atStart`) and the way it's heading there. */
export function tipOf(raw: readonly P[], atStart: boolean): { x: number; y: number; dx: number; dy: number } | undefined {
  const pts = clean(raw);
  if (pts.length < 2) return undefined;
  const [a, b] = atStart ? [pts[1]!, pts[0]!] : [pts[pts.length - 2]!, pts[pts.length - 1]!];
  return { x: b.x, y: b.y, dx: sgn(b.x - a.x), dy: sgn(b.y - a.y) };
}

/** An arrowhead at `t`, pointing the way the line arrives: 9 px back along it, 4.5 px to each side. */
export function arrow(t: { x: number; y: number; dx: number; dy: number }): string {
  const { x, y, dx, dy } = t;
  const bx = x - dx * 9, by = y - dy * 9;
  return `M${x},${y} L${bx - dy * 4.5},${by + dx * 4.5} L${bx + dy * 4.5},${by - dx * 4.5} Z`;
}

/** Where a line's count goes: just out of its start, above its first stretch. */
export function countAt(raw: readonly P[]): { x: number; y: number } | undefined {
  const pts = clean(raw);
  if (pts.length < 2) return undefined;
  const [a, b] = [pts[0]!, pts[1]!];
  const dx = sgn(b.x - a.x), dy = sgn(b.y - a.y);
  return dx !== 0 ? { x: a.x + dx * 6, y: a.y - 4 } : { x: a.x + 4, y: a.y + dy * 14 };
}

/** The length of a route. */
export function lengthOf(pts: readonly P[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
  return n;
}
