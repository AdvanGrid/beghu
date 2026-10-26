import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled } from "solid-js";
import { colors } from "./tokens.stylex";

type Choice = "light" | "dark" | "system";

declare global {
  interface Window {
    /** Set up by theme.js, inlined in the shell. */
    beghuTheme: {
      choice(): Choice;
      set(choice: Choice): void;
      subscribe(f: (choice: Choice) => void): () => void;
    };
  }
}

const CHOICES: { value: Choice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Light, dark or the system's: a device preference that theme.js keeps and applies. */
export function ThemeSwitch() {
  const [choice, setChoice] = createSignal<Choice>(window.beghuTheme.choice());
  onSettled(() => window.beghuTheme.subscribe(setChoice));
  return (
    <div role="group" aria-label="Theme" {...stylex.attrs(s.group)}>
      <For each={CHOICES}>
        {(c) => (
          <button
            type="button"
            aria-pressed={choice() === c.value ? "true" : "false"}
            data-theme-choice={c.value}
            {...stylex.attrs(s.button, choice() === c.value && s.pressed)}
            onClick={() => window.beghuTheme.set(c.value)}
          >
            {c.label}
          </button>
        )}
      </For>
    </div>
  );
}

const s = stylex.create({
  group: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
    display: "flex",
  },
  button: {
    font: "inherit",
    borderWidth: 0,
    paddingBlock: 3,
    paddingInline: 8,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.muted,
    cursor: "pointer",
    fontSize: 12,
  },
  pressed: {
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accent,
    },
    color: colors.accentFg,
  },
});
