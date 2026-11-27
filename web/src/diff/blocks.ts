// Diff mode's comparison (#194): two versions of a post's top-level blocks, older into newer, for
// BodyDiff.tsx to draw. No Solid and no DOM here: blocks in, lines and their layout out.
//
// Blocks compare whole, by their AST (a longest common subsequence over them). Each run of
// changes lists its removed blocks first, then its added ones. In a run, a removed block and an
// added one pair up when they have the same element structure (the same tags with the same
// attributes, nested the same way) and differ only in their text: a reworded paragraph, list or
// heading. A pair still shows as two blocks, each with only its changed words marked: the text
// leaves are compared word by word, and the changed words are wrapped in WORD_REMOVED or
// WORD_ADDED elements, which the Markdown walker draws as marks. A code block never pairs: its
// highlighting replaces its text.
//
// Unchanged runs fold (`layout`): one block of context stays beside each change, and the rest
// folds into one item, unless that would fold a single block.
import { WORD_ADDED, WORD_REMOVED, type Md, type MdNode } from "../md/ast";

/** A block as the diff shows it: in both versions, only the older, or only the newer. */
export type Line = {
  kind: "same" | "del" | "add";
  /** The block, as it renders: a paired one with its changed words wrapped. */
  block: MdNode;
  /** Paired with a block on the other side: only its changed words are marked. */
  paired: boolean;
};

/** What the diff draws, in order. */
export type Item =
  /** An unchanged block shown. */
  | { kind: "same"; line: Line }
  /** One run of changes, the `n`th from the top: its removed blocks, then its added ones. */
  | { kind: "change"; n: number; lines: Line[] }
  /** Unchanged blocks folded away; `id` tells one fold from another in the same diff. */
  | { kind: "fold"; id: number; lines: Line[] };

/**
 * The most cells a longest-common-subsequence table may have: past it, blocks between the common
 * start and end count as all removed and all added, and words as a whole leaf changed.
 */
const MAX_CELLS = 4_000_000;

/** The pairs of equal items in `a` and `b`, by index, in order: a longest common subsequence. */
function common<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const out: [number, number][] = [];
  // The common start and end need no table.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) out.push([start, start++]);
  let endA = n;
  let endB = m;
  const tail: [number, number][] = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) tail.push([--endA, --endB]);
  const rows = endA - start;
  const cols = endB - start;
  if (rows > 0 && cols > 0 && rows * cols <= MAX_CELLS) {
    // t[i][j]: the longest common subsequence of a[start + i..endA] and b[start + j..endB].
    const w = cols + 1;
    const t = new Uint32Array((rows + 1) * w);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (a[start + i] === b[start + j]) {
        out.push([start + i++, start + j++]);
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }
  return out.concat(tail.reverse());
}

/** A block's identity for comparing: its whole AST. */
const keyOf = (b: MdNode) => JSON.stringify(b);

/** A block's structure: its AST with every text left out, tags and attributes kept. */
function shapeOf(b: MdNode): string {
  const strip = (n: MdNode): unknown => (typeof n === "string" ? 0 : [n[0], n[1], ...(n.slice(2) as MdNode[]).map(strip)]);
  return JSON.stringify(strip(b));
}

/** Whether `b` holds a code block, whose highlighting would undo word marks. */
function hasCode(b: MdNode): boolean {
  return typeof b !== "string" && (b[0] === "pre" || (b.slice(2) as MdNode[]).some(hasCode));
}

/** `older`'s blocks into `newer`'s, each run of changes as its removals, then its additions. */
export function diffBlocks(older: Md, newer: Md): Line[] {
  const pairs = common(older.map(keyOf), newer.map(keyOf));
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [older.length, newer.length] as [number, number]]) {
    out.push(...run(older.slice(i, pi), newer.slice(j, pj)));
    if (pi < older.length) out.push({ kind: "same", block: newer[pj]!, paired: false });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

/**
 * One run of changes: `dels` then `adds`, each removed block paired, in order, with the first
 * added block after the last one paired that has its structure.
 */
function run(dels: MdNode[], adds: MdNode[]): Line[] {
  const del: Line[] = dels.map((block) => ({ kind: "del", block, paired: false }));
  const add: Line[] = adds.map((block) => ({ kind: "add", block, paired: false }));
  const shapes = adds.map((b) => (hasCode(b) ? undefined : shapeOf(b)));
  let from = 0;
  for (const d of del) {
    if (hasCode(d.block)) continue;
    const shape = shapeOf(d.block);
    const at = shapes.indexOf(shape, from);
    if (at < 0) continue;
    const [was, now] = markPair(d.block, add[at]!.block);
    d.block = was;
    d.paired = true;
    add[at] = { kind: "add", block: now, paired: true };
    from = at + 1;
  }
  return [...del, ...add];
}

/** Two blocks of one structure, each with the words it doesn't share with the other wrapped. */
function markPair(a: MdNode, b: MdNode): [MdNode, MdNode] {
  if (typeof a === "string" || typeof b === "string") {
    const [x, y] = words(String(a), String(b));
    return [["span", 0, ...x], ["span", 0, ...y]];
  }
  const [tag, attrs, ...ka] = a;
  const kb = b.slice(2) as MdNode[];
  const outA: MdNode[] = [];
  const outB: MdNode[] = [];
  ka.forEach((x, k) => {
    const y = kb[k]!;
    if (typeof x === "string" && typeof y === "string") {
      const [wx, wy] = words(x, y);
      outA.push(...wx);
      outB.push(...wy);
    } else {
      const [mx, my] = markPair(x, y);
      outA.push(mx);
      outB.push(my);
    }
  });
  return [
    [tag, attrs, ...outA],
    [tag, attrs, ...outB],
  ];
}

/**
 * Two texts compared word by word: each as its pieces, the words only it has (and the spaces
 * between two such words) wrapped as removed (the first) or added (the second).
 */
export function words(a: string, b: string): [MdNode[], MdNode[]] {
  if (a === b) return [[a], [b]];
  const ta = a.split(/(\s+)/).filter((t) => t !== "");
  const tb = b.split(/(\s+)/).filter((t) => t !== "");
  if (ta.length * tb.length > MAX_CELLS) return [[[WORD_REMOVED, 0, a]], [[WORD_ADDED, 0, b]]];
  const pairs = common(ta, tb);
  const keptA = new Set(pairs.map(([i]) => i));
  const keptB = new Set(pairs.map(([, j]) => j));
  return [pieces(ta, keptA, WORD_REMOVED), pieces(tb, keptB, WORD_ADDED)];
}

/** `tokens` as text and marks: those not `kept` wrapped in `tag`, with the spaces between them. */
function pieces(tokens: string[], kept: Set<number>, tag: string): MdNode[] {
  const changed = tokens.map((_, i) => !kept.has(i));
  // A space kept between two changed words is part of the change.
  for (let i = 1; i < tokens.length - 1; i++) if (!changed[i] && /^\s+$/.test(tokens[i]!) && changed[i - 1] && changed[i + 1]) changed[i] = true;
  const out: MdNode[] = [];
  let text = "";
  let mark = "";
  for (let i = 0; i < tokens.length; i++) {
    if (changed[i]) {
      if (text) out.push(text);
      text = "";
      mark += tokens[i];
    } else {
      if (mark) out.push([tag, 0, mark]);
      mark = "";
      text += tokens[i];
    }
  }
  if (text) out.push(text);
  if (mark) out.push([tag, 0, mark]);
  return out;
}

/** How many blocks the diff removes and adds. */
export function counts(lines: readonly Line[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

/**
 * `lines` as drawn: each run of changes as one item, numbered from the top, and each run of
 * unchanged blocks with one block of context kept beside each change and the rest in a fold, as
 * long as the fold would hold more than one block.
 */
export function layout(lines: readonly Line[]): Item[] {
  const out: Item[] = [];
  let changes = 0;
  let k = 0;
  while (k < lines.length) {
    const start = k;
    if (lines[k]!.kind !== "same") {
      while (k < lines.length && lines[k]!.kind !== "same") k++;
      out.push({ kind: "change", n: changes++, lines: lines.slice(start, k) });
      continue;
    }
    while (k < lines.length && lines[k]!.kind === "same") k++;
    const same = lines.slice(start, k);
    const before = start === 0 ? 0 : 1;
    const after = k === lines.length ? 0 : 1;
    if (same.length <= before + after + 1) {
      for (const line of same) out.push({ kind: "same", line });
      continue;
    }
    for (const line of same.slice(0, before)) out.push({ kind: "same", line });
    out.push({ kind: "fold", id: start, lines: same.slice(before, same.length - after) });
    for (const line of same.slice(same.length - after)) out.push({ kind: "same", line });
  }
  return out;
}
