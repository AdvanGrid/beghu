// Inlined into the shell's <head> (see vite.config.ts), so it runs before first paint. Sets
// `color-scheme` on <html>, which every light-dark() colour token follows, and `.dark` for the
// rare non-colour case (the logo). The choice is "light", "dark" or "system" (follows the OS),
// a device preference kept in localStorage and shared with other tabs through `storage`.
(() => {
  const KEY = "beghu.theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();

  const stored = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  };

  const apply = (choice) => {
    const root = document.documentElement;
    root.style.colorScheme = choice === "system" ? "light dark" : choice;
    root.classList.toggle("dark", choice === "dark" || (choice === "system" && media.matches));
    root.dataset.theme = choice;
    for (const f of listeners) f(choice);
  };

  window.beghuTheme = {
    choice: stored,
    set(choice) {
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch {}
      apply(choice);
    },
    /** Calls `f` with the choice whenever it changes, here or in another tab; returns an unsubscribe. */
    subscribe(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  };

  apply(stored());
  media.addEventListener("change", () => stored() === "system" && apply("system"));
  window.addEventListener("storage", (e) => (e.key === KEY || e.key === null) && apply(stored()));
})();
