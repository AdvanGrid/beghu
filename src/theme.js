// Applies the theme before first paint and wires up the theme switch.
// Choice is "light", "dark" or "system" (follows the OS setting).
(() => {
  const KEY = "theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const stored = () => {
    try {
      return localStorage.getItem(KEY) || "system";
    } catch {
      return "system";
    }
  };

  const apply = (choice) => {
    const dark = choice === "dark" || (choice === "system" && media.matches);
    const root = document.documentElement;
    // Only write on change so the MutationObserver below doesn't loop.
    if (root.classList.contains("dark") !== dark) root.classList.toggle("dark", dark);
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      const pressed = String(button.dataset.themeChoice === choice);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
  };

  apply(stored());

  media.addEventListener("change", () => {
    if (stored() === "system") apply("system");
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (!button) return;
    const choice = button.dataset.themeChoice;
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {}
    apply(choice);
  });

  // Buttons don't exist yet when this runs in <head>; sync their state once parsed.
  document.addEventListener("DOMContentLoaded", () => apply(stored()));

  // Re-apply when the DOM is replaced underneath us, e.g. by `topcoat dev` live updates,
  // which reset <html> attributes and re-render the switch from server markup.
  new MutationObserver(() => apply(stored())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "aria-pressed"],
    childList: true,
    subtree: true,
  });
})();
