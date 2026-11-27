// Our layout's input and output (#180): every drawing in the PR view (the top level, opened
// blocks, the purpose canvas, the phone map) is a tree of scopes laid out by one pure function,
// `layout` (layout.ts). No DOM, Solid or StyleX: graph in, coordinates out.

/** A point in the drawing's coordinates (px, y down). */
export interface P {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a part stands, left to right in the locked order: people, the changed group, the
 * unchanged group, outside systems. Only the drawing's top scope has four columns: inside a
 * frame (an open block or a box) every part is one group, between its edges' ports.
 */
export type Column = "people" | "changed" | "unchanged" | "outside";

/** One part of a scope: a closed block, or an open one (a frame, with its own inside). */
export interface Part {
  /** Unique in the whole drawing. */
  id: string;
  /** Its size closed (px). A frame's size comes from its inside, and these are ignored. */
  w: number;
  h: number;
  column: Column;
  /** An open block: the scope inside its frame, laid out by the same engine. */
  frame?: Scope;
}

/**
 * A line's end: a part of its scope, or, inside a frame, the frame's port for a line of the scope
 * above (`{ port: thatLine.id }`): a zero-size part on the frame's edge where that line meets it,
 * so all of a frame's lines for one line above fan out from one point.
 */
export type End = string | { port: string };

/**
 * A line as the scope draws it: the analysis lines rolled up to two of its parts (or a part and a
 * port), laid out as running from `from` to `to` (the arrows keep the real direction).
 */
export interface Line {
  /** Unique in the whole drawing. */
  id: string;
  from: End;
  to: End;
  /** The analysis lines it stands for. */
  count: number;
  /** Whether any of them changed. */
  changed: boolean;
}

/**
 * A box: a foldable group frame round some of a scope's parts (a folder, an `outside-*` facet's
 * value). Its parts share a column; it is laid out as a frame of its own, its lines crossing its
 * edge through ports, and each line still comes back as one route.
 */
export interface Box {
  id: string;
  parts: string[];
}

/** The drawing, or one open block's inside. */
export interface Scope {
  /** The drawing's own ID, or the open block's (its part's) ID. */
  id: string;
  parts: Part[];
  lines: Line[];
  boxes?: Box[];
}

export interface LayoutInput {
  root: Scope;
  /** The last answer: every scope keeps its parts where they were, as heavy anchors. */
  previous?: Layout;
  /** Room in every gap between columns for a line's count, where it leaves its part (px). */
  countRoom?: number;
}

/** Where a part, frame or box was drawn. */
export interface Placed extends Rect {
  /** The scope it was laid out in. */
  scope: string;
  /** An open block, laid out inside. */
  frame: boolean;
  /** A box (a group frame), not a part of the analysis. */
  box: boolean;
}

/** Lines that run along one stretch, merged into one thick stroke. */
export interface Trunk {
  id: string;
  scope: string;
  /** Orthogonal points: one straight run (horizontal or vertical), or several joined. */
  points: P[];
  /** The input lines on it. */
  lines: string[];
  /** Its drawn width (px), from how many lines it carries. */
  width: number;
  /** Whether any of its lines changed. */
  changed: boolean;
}

/** One scope's answer: its rectangle in the drawing, and its group frames (the top scope's). */
export interface ScopeLayout {
  rect: Rect;
  /** The changed and unchanged groups' frames (the top scope only). */
  groups: { column: "changed" | "unchanged"; rect: Rect }[];
}

export interface Layout {
  /** Every part, frame and box drawn. */
  parts: Map<string, Placed>;
  /** Every input line's route, from `from` to `to`: orthogonal points, exact. */
  routes: Map<string, P[]>;
  trunks: Trunk[];
  scopes: Map<string, ScopeLayout>;
  /** What the next layout keeps: per scope, each part's place (its y in the scope). */
  anchors: Map<string, Map<string, number>>;
  width: number;
  height: number;
}
