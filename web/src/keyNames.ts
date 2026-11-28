// A binding's words, as people read it: what the hint bar, the `?` overlay (Hints.tsx), the setup
// page (Prefs.tsx) and the canvas's screen-reader words (pr-view/canvas/) show. Its own module, so
// a view that names a key loads this, not the hint bar's chunk; never in first-load JS's keys.ts.
import { MAC } from "./keys";

const ARROWS: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

/** A binding as people read it: `Alt+KeyL` is Alt+L, `Shift+x` is Shift+X, a sequence `g i`. */
export function showBinding(binding: string): string {
  return binding.split(" ").map(showKey).join(" ");
}

/** One key of a binding as people read it. */
function showKey(key: string): string {
  return key
    .split(/\+(?=.)/)
    .map((part) => ARROWS[part] ?? part.replace(/^(Key|Digit)(?=.)/, "").replace(/^[a-z]$/, (c) => (key.includes("+") ? c.toUpperCase() : c)))
    .join("+")
    .replace(/^Mod\+/, MAC ? "⌘" : "Ctrl+");
}
