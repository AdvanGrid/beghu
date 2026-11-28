// The PR view's state in its URL. One value for the whole view (the selection, so the panel
// never changes on a tab switch; the lens, Show, Colour by, Boxes, Outlines and the Lines menu),
// and the tab; each tab keeps its own working state (Canvas its opens, folds, zoom, scroll and ←
// Back; Path its columns), which is never in the URL. Each parameter is written only when it
// isn't its default:
//
// - `tab`: `canvas` (the default) or `path`;
// - `sel`: one typed ID, each analysis ID written once, without its own kind prefix:
//   `part:<node>`, `line:<edge>` (a line that bundles several connections, or a split's new
//   lines, as `line:<a>,<b>`; `part:<a>,<b>` likewise), `purpose:<slug>` (`purpose:<a>,<b>` for a
//   split's halves; the purpose `purpose:analysis-run` is `purpose:analysis-run`, not
//   `purpose:purpose:…`), `conflict:<id>` (likewise), `step:<scenario>/<n>` (1-based; the
//   scenario `scenario:upload`'s second step is `step:upload/2`), `group:<id>` (a column,
//   `group:column:changed`, or a box, `group:box:<column>:<slot>:<value>`), `boundary:<id>` or
//   `unclaimed`.
//   `selString` and `parseSel` are the one place that adds and strips those prefixes; a `Sel`
//   holds the analysis's IDs as they are (nav.ts `selOf` makes one from them);
// - `lens`, `show`, `colour`, `boxes`, `outlines`, `lines`, and `scenario` and `chapter` under
//   the order lens; `path=a,b,c`, Path's trail. `boxes` is its two slots, `<own>,<outside>`
//   (`folder`, `none` or a facet's ID each), a slot left empty at its default (own parts by
//   Folder, outside by the analysis's required `outside-*` facet, layout/graph.ts
//   `outsideBoxFacet`, which the view passes to `parseState` and `writeState`): `boxes=none`,
//   `boxes=,none`. `lines` is the Lines menu's values turned on (`parseLines`). Both are
//   normalised, so a value that spells out the defaults is dropped like any other default.
//
// The canvas's controls (slice 8) and Path (slice 10) give the view-wide values their choices;
// until then they're kept as the URL has them.
//
// History (desktop, 720 px and wider; the phone's is slice 12's): a selection change or a tab
// switch pushes an entry; the lens, Show, Colour by, Boxes, Outlines and Lines replace the current
// one. Restoring an entry restores the selection and the tab.

export type Tab = "canvas" | "path";

/**
 * What's selected: what the panel shows. Each ID is the analysis's own (`purpose:analysis-run`,
 * `conflict:cli-run-start`, `scenario:upload`); `selString` writes them without that prefix.
 */
export type Sel =
  | { kind: "part"; ids: string[] }
  | { kind: "line"; ids: string[] }
  | { kind: "purpose"; ids: string[] }
  | { kind: "conflict"; id: string }
  | { kind: "step"; scenario: string; n: number }
  | { kind: "group"; id: string }
  | { kind: "boundary"; id: string }
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

/** Each view-wide value's default, which the URL leaves out (`boxes` and `lines`: `normalise`). */
const DEFAULTS: Partial<Record<Replacing, string>> = { lens: "modules", show: "all", colour: "change", outlines: "none" };

/** The prefix an analysis gives the IDs of a kind of selection, which `sel` leaves out. */
const PREFIX = { purpose: "purpose:", conflict: "conflict:", step: "scenario:" } as const;

/** `id` without `prefix`, if it has it. */
const bare = (prefix: string, id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);

/**
 * The IDs `sel`'s `id` may name in an analysis: as written (with the prefix added back), then as
 * the URL has it, for an analysis whose IDs don't carry the prefix (only purposes' must).
 */
export function candidates(kind: keyof typeof PREFIX, id: string): string[] {
  const raw = bare(PREFIX[kind], id);
  return raw === id ? [id] : [id, raw];
}

/** A selection as `sel` writes it. */
export function selString(s: Sel): string {
  switch (s.kind) {
    case "part":
    case "line":
      return `${s.kind}:${s.ids.join(",")}`;
    case "purpose":
      return `purpose:${s.ids.map((id) => bare(PREFIX.purpose, id)).join(",")}`;
    case "conflict":
      return `conflict:${bare(PREFIX.conflict, s.id)}`;
    case "group":
      return `group:${s.id}`;
    case "boundary":
      return `boundary:${s.id}`;
    case "step":
      return `step:${bare(PREFIX.step, s.scenario)}/${s.n}`;
    case "unclaimed":
      return "unclaimed";
  }
}

/** The selection `sel` names, if it names one: its IDs with their analysis prefixes back on. */
export function parseSel(v: string | null): Sel | undefined {
  if (!v) return undefined;
  if (v === "unclaimed") return { kind: "unclaimed" };
  const colon = v.indexOf(":");
  if (colon <= 0) return undefined;
  const kind = v.slice(0, colon);
  const rest = v.slice(colon + 1);
  if (!rest) return undefined;
  const list = () => rest.split(",").filter((x) => x !== "");
  switch (kind) {
    case "part":
    case "line": {
      const ids = list();
      return ids.length ? { kind, ids } : undefined;
    }
    case "purpose": {
      const ids = list().map((x) => PREFIX.purpose + x);
      return ids.length ? { kind, ids } : undefined;
    }
    case "conflict":
      return { kind, id: PREFIX.conflict + rest };
    case "group":
    case "boundary":
      return { kind, id: rest };
    case "step": {
      const m = /^(.+)\/(\d+)$/.exec(rest);
      return m && Number(m[2]) >= 1 ? { kind: "step", scenario: PREFIX.step + m[1]!, n: Number(m[2]) } : undefined;
    }
    default:
      return undefined;
  }
}

export function sameSel(a: Sel | undefined, b: Sel | undefined): boolean {
  return (a ? selString(a) : "") === (b ? selString(b) : "");
}

/**
 * The view's state from its URL's query string. `outside` is the analysis's default facet for
 * Boxes' outside slot (`outsideBoxFacet`), here and in `writeState`.
 */
export function parseState(search: string, outside?: string): ViewState {
  const p = new URLSearchParams(search);
  const st: ViewState = { tab: p.get("tab") === "path" ? "path" : "canvas", sel: parseSel(p.get("sel")) };
  for (const k of REPLACING) {
    const v = normalise(k, p.get(k) ?? undefined, outside);
    if (v !== undefined) st[k] = v;
  }
  const path = p.get("path");
  if (path) st.path = path;
  return st;
}

/** The query string for `st` (with its `?`, or empty), each parameter only when not its default. */
export function writeState(st: ViewState, outside?: string): string {
  const p = new URLSearchParams();
  if (st.tab !== "canvas") p.set("tab", st.tab);
  if (st.sel) p.set("sel", selString(st.sel));
  // `scenario` and `chapter` belong to the order lens.
  for (const k of REPLACING) {
    const v = normalise(k, st[k], outside);
    if (v === undefined) continue;
    if ((k === "scenario" || k === "chapter") && st.lens !== "order") continue;
    p.set(k, v);
  }
  if (st.path) p.set("path", st.path);
  // Typed IDs read better unescaped: `sel=part:web.src` rather than `part%3Aweb.src`.
  const s = p.toString().replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%2F/g, "/");
  return s ? `?${s}` : "";
}

/** `v` as the URL writes `k`: undefined at its default (or empty), `outside` Boxes' outside slot's. */
function normalise(k: Replacing, v: string | undefined, outside: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (k === "lines") {
    const on = new Set(v.split(","));
    const out = LINES_ORDER.filter((x) => on.has(x));
    const def = LINES_ORDER.filter((x) => LINES_DEFAULT.when.has(x) || LINES_DEFAULT.kind.has(x));
    // Nothing it knows turned on is a choice too (every line hidden), unlike an absent `lines`.
    return out.join(",") === def.join(",") ? undefined : out.length ? out.join(",") : "none";
  }
  if (k === "boxes") {
    const [own = "", outer = ""] = v.split(",");
    const slots = [own === "folder" ? "" : own, outer === outside ? "" : outer];
    while (slots.length && slots.at(-1) === "") slots.pop();
    return slots.length ? slots.join(",") : undefined;
  }
  return v === DEFAULTS[k] ? undefined : v;
}

/** What the Lines menu shows: by when each line happens and by its kind. */
export interface Lines {
  when: ReadonlySet<string>;
  kind: ReadonlySet<string>;
}

export const WHENS = ["runtime", "build", "test"] as const;
const KINDS = ["call", "data", "event"] as const;
/** The order `lines` writes its values in. */
const LINES_ORDER: readonly string[] = [...WHENS, ...KINDS];

/** The Lines menu's default: run-time lines of every kind (build and test hidden). */
const LINES_DEFAULT: Lines = { when: new Set(["runtime"]), kind: new Set(KINDS) };

/**
 * The Lines menu as `lines` writes it: the values turned on, comma-separated (`runtime,test,call,
 * data,event`); absent, its default.
 */
export function parseLines(v: string | undefined): Lines {
  if (!v) return LINES_DEFAULT;
  const on = new Set(v.split(","));
  const pick = (all: readonly string[]) => new Set(all.filter((x) => on.has(x)));
  return { when: pick(WHENS), kind: pick(KINDS) };
}

/** Why the Lines menu hides a line ("hidden: test"), or undefined when it shows it. */
export function hiddenBy(e: { when: string; kind: string }, lines: Lines): string | undefined {
  if (!lines.when.has(e.when)) return `hidden: ${e.when}`;
  if (!lines.kind.has(e.kind)) return `hidden: ${e.kind}`;
  return undefined;
}
