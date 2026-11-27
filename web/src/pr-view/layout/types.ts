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
  /**
   * The last answer. Each scope it drew with the same parts and lines is laid out from its
   * anchors (its folded drawing): every part where that drawing had it, pushed down only by the
   * open blocks above it in its column; every line on that drawing's route, its levels moved
   * with their columns' parts; every gutter as wide as there, or wider where its tracks need it.
   * Any other scope is laid out afresh.
   */
  previous?: Layout;
  /** Room in every gap between columns for a line's count, where it leaves its part (px). */
  countRoom?: number;
}

/**
 * Where a part, frame or box was drawn. A closed part may be drawn taller than its input's `h`:
 * tall enough that its lines leave it at least 4 px apart.
 */
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

/**
 * What the next layout keeps of one scope: its drawing with every block in it folded, laid out
 * afresh. A scope's every layout is a function of its anchors and what is open in it, so coming
 * back to an earlier open set gives that drawing back exactly, and an open or a fold moves only
 * what the changed block pushes: the parts below it in its column, and the columns right of it, by
 * its column's change of width and the change of the two gutters beside that column (whose
 * verticals move with its parts). No line is routed again, so every other gutter keeps its width.
 * Anchors are kept only for the same scope: a scope whose parts or lines changed (boxes drawn,
 * lonely parts shown, another analysis) is laid out afresh.
 */
export interface Anchors {
  /** The folded scope they were laid out for: its parts, their folded sizes, and its lines. */
  sig: string;
  /** Each column's parts, top to bottom (the rows' order depends only on the scope). */
  rows: string[][];
  /** Each part's place: its y with every block in the scope folded. */
  ys: Map<string, number>;
  /** The room for routes above each part (in its column). */
  room: Map<string, number>;
  /** Each line's route: the y it passes each column between its ends at (null: it runs straight). */
  levels: Map<string, number[] | null>;
  /** Each gutter's width, by the columns either side. */
  gutters: Map<string, number>;
  /** Inside a frame: the frame folded, its size and its ports' y, by the port's part. */
  frame?: { w: number; h: number; ports: Map<string, number> };
}

export interface Layout {
  /** Every part, frame and box drawn. */
  parts: Map<string, Placed>;
  /** Every input line's route, from `from` to `to`: orthogonal points, exact. */
  routes: Map<string, P[]>;
  trunks: Trunk[];
  scopes: Map<string, ScopeLayout>;
  /** What the next layout keeps, per scope. */
  anchors: Map<string, Anchors>;
  width: number;
  height: number;
}
