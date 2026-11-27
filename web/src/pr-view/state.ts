// The PR view's state in its URL. One value for the whole view (the selection, so the panel
// never changes on a tab switch; the lens, Show, Colour by, Boxes, Outlines and the Lines menu),
// and the tab; each tab keeps its own working state (Canvas its opens, folds, zoom, scroll and ←
// Back; Path its columns), which is never in the URL. Each parameter is written only when it
// isn't its default:
//
// - `tab`: `canvas` (the default) or `path`;
// - `sel`: one typed ID: `part:<node>`, `line:<edge>` (a line that bundles several connections,
//   or a split's new lines, as `line:<a>,<b>`; `part:<a>,<b>` likewise), `purpose:<slug>` (the
//   purpose's own ID), `conflict:<id>`, `step:<scenario>/<n>` (1-based), `group:<id>` or
//   `unclaimed`;
// - `lens`, `show`, `colour`, `boxes`, `outlines`, `lines`, and `scenario` and `chapter` under
//   the order lens; `path=a,b,c`, Path's trail.
//
// The canvas's controls (slice 8) and Path (slice 10) give the view-wide values their choices;
// until then they're kept as the URL has them.
//
// History (desktop, 720 px and wider; the phone's is slice 12's): a selection change or a tab
// switch pushes an entry; the lens, Show, Colour by, Boxes, Outlines and Lines replace the current
// one. Restoring an entry restores the selection and the tab.

export type Tab = "canvas" | "path";

/** What's selected: what the panel shows. */
export type Sel =
  | { kind: "part"; ids: string[] }
  | { kind: "line"; ids: string[] }
  | { kind: "purpose"; id: string }
  | { kind: "conflict"; id: string }
  | { kind: "step"; scenario: string; n: number }
  | { kind: "group"; id: string }
  | { kind: "unclaimed" };

/** The view's state as its URL holds it. */
export interface ViewState {
  tab: Tab;
  sel?: Sel;
  /** The rest, as the URL has them: absent at their defaults. */
  lens?: string;
  show?: string;
  colour?: string;
  boxes?: string;
  outlines?: string;
  lines?: string;
  scenario?: string;
  chapter?: string;
  path?: string;
}

/** The parameters that replace the history entry rather than push one. */
export const REPLACING = ["lens", "show", "colour", "boxes", "outlines", "lines", "scenario", "chapter"] as const;
export type Replacing = (typeof REPLACING)[number];

/** Each view-wide value's default, which the URL leaves out. */
const DEFAULTS: Partial<Record<Replacing, string>> = { lens: "modules", show: "all", colour: "change", outlines: "none" };

/** A selection as `sel` writes it. */
export function selString(s: Sel): string {
  switch (s.kind) {
    case "part":
    case "line":
      return `${s.kind}:${s.ids.join(",")}`;
    case "purpose":
      return s.id;
    case "conflict":
    case "group":
      return `${s.kind}:${s.id}`;
    case "step":
      return `step:${s.scenario}/${s.n}`;
    case "unclaimed":
      return "unclaimed";
  }
}

/** The selection `sel` names, if it names one. */
export function parseSel(v: string | null): Sel | undefined {
  if (!v) return undefined;
  if (v === "unclaimed") return { kind: "unclaimed" };
  const colon = v.indexOf(":");
  if (colon <= 0) return undefined;
  const kind = v.slice(0, colon);
  const rest = v.slice(colon + 1);
  if (!rest) return undefined;
  switch (kind) {
    case "part":
    case "line": {
      const ids = rest.split(",").filter((x) => x !== "");
      return ids.length ? { kind, ids } : undefined;
    }
    case "purpose":
      return { kind: "purpose", id: v };
    case "conflict":
    case "group":
      return { kind, id: rest };
    case "step": {
      const m = /^(.+)\/(\d+)$/.exec(rest);
      return m && Number(m[2]) >= 1 ? { kind: "step", scenario: m[1]!, n: Number(m[2]) } : undefined;
    }
    default:
      return undefined;
  }
}

export function sameSel(a: Sel | undefined, b: Sel | undefined): boolean {
  return (a ? selString(a) : "") === (b ? selString(b) : "");
}

/** The view's state from its URL's query string. */
export function parseState(search: string): ViewState {
  const p = new URLSearchParams(search);
  const st: ViewState = { tab: p.get("tab") === "path" ? "path" : "canvas", sel: parseSel(p.get("sel")) };
  for (const k of REPLACING) {
    const v = p.get(k);
    if (v !== null && v !== "" && v !== DEFAULTS[k]) st[k] = v;
  }
  const path = p.get("path");
  if (path) st.path = path;
  return st;
}

/** The query string for `st` (with its `?`, or empty), each parameter only when not its default. */
export function writeState(st: ViewState): string {
  const p = new URLSearchParams();
  if (st.tab !== "canvas") p.set("tab", st.tab);
  if (st.sel) p.set("sel", selString(st.sel));
  // `scenario` and `chapter` belong to the order lens.
  for (const k of REPLACING) {
    const v = st[k];
    if (v === undefined || v === DEFAULTS[k]) continue;
    if ((k === "scenario" || k === "chapter") && st.lens !== "order") continue;
    p.set(k, v);
  }
  if (st.path) p.set("path", st.path);
  // Typed IDs read better unescaped: `sel=part:web.src` rather than `part%3Aweb.src`.
  const s = p.toString().replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%2F/g, "/");
  return s ? `?${s}` : "";
}

/** What the Lines menu shows: by when each line happens and by its kind. */
export interface Lines {
  when: ReadonlySet<string>;
  kind: ReadonlySet<string>;
}

/** The Lines menu's default: run-time lines of every kind (build and test hidden). */
const LINES_DEFAULT: Lines = { when: new Set(["runtime"]), kind: new Set(["call", "data", "event"]) };

/**
 * The Lines menu as `lines` writes it: the values turned on, comma-separated (`runtime,test,call,
 * data,event`); absent, its default.
 */
export function parseLines(v: string | undefined): Lines {
  if (!v) return LINES_DEFAULT;
  const on = new Set(v.split(","));
  const pick = (all: readonly string[]) => new Set(all.filter((x) => on.has(x)));
  return { when: pick(["runtime", "build", "test"]), kind: pick(["call", "data", "event"]) };
}

/** Why the Lines menu hides a line ("hidden: test"), or undefined when it shows it. */
export function hiddenBy(e: { when: string; kind: string }, lines: Lines): string | undefined {
  if (!lines.when.has(e.when)) return `hidden: ${e.when}`;
  if (!lines.kind.has(e.kind)) return `hidden: ${e.kind}`;
  return undefined;
}
