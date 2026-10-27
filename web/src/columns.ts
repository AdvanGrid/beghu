// The list's column widths: each column right of the title is either the width the user dragged
// it to (a device preference, kept in localStorage and shared across tabs) or an automatic width
// from the list's own width. Labels and blockers fill stacked columns of two slots, so their
// automatic widths grow by whole slot columns: labels 1/2/3 at <900/900/1500 px of list,
// blockers 1/2/3 at <1200/1200/1800 px.
import { createSignal, onSettled } from "solid-js";
import { slots } from "./layout.stylex";

export const COLUMNS = ["labels", "blockers", "progress", "ref", "who", "updated"] as const;
export type Column = (typeof COLUMNS)[number];
export type Widths = Partial<Record<Column, number>>;

const KEY = "beghu.list-columns";
const MIN: Record<Column, number> = { labels: 60, blockers: 70, progress: 30, ref: 56, who: 24, updated: 28 };
const MAX = 640;

/** A column's width when the user hasn't set one, for a list `w` px wide. */
function auto(c: Column, w: number): number {
  const narrow = w < 1000;
  switch (c) {
    case "labels":
      return (w >= 1500 ? 3 : w >= 900 ? 2 : 1) * (slots.labelSlot + slots.labelGap);
    case "blockers":
      return (w >= 1800 ? 3 : w >= 1200 ? 2 : 1) * (slots.blockerSlot + slots.blockerGap);
    case "progress":
      return narrow ? 44 : 52;
    case "ref":
      return narrow ? 96 : 104;
    case "who":
      return narrow ? 40 : 46;
    case "updated":
      return narrow ? 30 : 32;
  }
}

/** How many stacked slot columns `px` holds, at least one. */
function slotColumns(px: number, slot: number, gap: number): number {
  return Math.max(1, Math.floor((px + gap) / (slot + gap)));
}

/**
 * How a cell `width` px wide shows `total` items stacked two to a column of `slot` px (and
 * `gap`): `show` of them, keeping the last slot for "+n" when they don't all fit.
 */
export function stackFit(total: number, width: number, slot: number, gap: number): number {
  const cap = slotColumns(width, slot, gap) * 2;
  return total > cap ? cap - 1 : total;
}

function clamp(c: Column, px: number): number {
  return Math.round(Math.min(MAX, Math.max(MIN[c], px)));
}

/** The stored widths: only finite numbers for known columns, each clamped to its range. */
function read(): Widths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!v || typeof v !== "object") return {};
    const out: Widths = {};
    for (const c of COLUMNS) {
      const px = (v as Record<string, unknown>)[c];
      if (typeof px === "number" && Number.isFinite(px)) out[c] = clamp(c, px);
    }
    return out;
  } catch {
    return {};
  }
}

function write(w: Widths): void {
  try {
    if (Object.keys(w).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    // Storage blocked: the widths last until the tab closes.
  }
}

/**
 * The columns' widths for a list whose width `listWidth` reports. `drag` resizes a column by its
 * left edge (a pointerdown on that edge); `reset` gives it back its automatic width.
 */
export function createColumns(listWidth: () => number) {
  // The widths the user dragged columns to; the rest are automatic.
  const [chosen, setChosen] = createSignal<Widths>(read());
  onSettled(() => {
    // Another tab resized a column: this device's widths follow.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setChosen(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  });
  const width = (c: Column) => chosen()[c] ?? auto(c, listWidth());

  const drag = (c: Column, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width(c);
    // The column grows as its left edge moves left.
    const move = (m: PointerEvent) => setChosen({ ...chosen(), [c]: clamp(c, w0 - (m.clientX - x0)) });
    const done = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      grip.removeEventListener("pointercancel", done);
      write(chosen());
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
  };

  const reset = (c: Column) => {
    const next = { ...chosen() };
    delete next[c];
    setChosen(next);
    write(next);
  };

  return { width, isSet: (c: Column) => chosen()[c] !== undefined, drag, reset };
}
