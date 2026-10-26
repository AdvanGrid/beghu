// The lint's contract: it fails on colour literals outside the token module, on class or style
// attributes in JSX, and on any CSS import but the escape stylesheet. `npm run test:lint`.
import { RuleTester } from "eslint";
import css from "@eslint/css";
import tsParser from "@typescript-eslint/parser";
import { describe, it } from "node:test";
import beghu from "./eslint-rules.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tsx = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

tsx.run("no-colour-literals", beghu.rules["no-colour-literals"], {
  valid: [
    `const s = stylex.create({ a: { color: colors.fg, borderColor: "transparent" } });`,
    `const s = stylex.create({ dot: (c) => ({ backgroundColor: c }) }); s.dot(\`#\${label.color}\`);`,
    `const title = "Fix #123: crash on red screens";`,
    `const s = stylex.create({ a: { fontFamily: "Menlo", gridTemplateColumns: "16px 1fr" } });`,
  ],
  invalid: [
    { code: `const s = stylex.create({ a: { color: "#fff" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { borderColor: "red" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { border: "1px solid Canvas" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { color: "light-dark(#000, #fff)" } });`, errors: 1 },
    { code: `el.style.color = "rgb(0 0 0)";`, errors: 1 },
    { code: `const accent = "#2563eb";`, errors: 1 },
    { code: "const shadow = `0 1px 2px oklch(0 0 0 / 0.2)`;", errors: 1 },
  ],
});

tsx.run("no-class-or-style", beghu.rules["no-class-or-style"], {
  valid: [`<a {...stylex.attrs(s.row)} href="/" />`],
  invalid: [
    { code: `<a class="row" />`, errors: 1 },
    { code: `<a className={cls} />`, errors: 1 },
    { code: `<a style="color: red" />`, errors: 1 },
    { code: `<a style={{ height: 34 }} />`, errors: 1 },
  ],
});

tsx.run("one-escape-stylesheet", beghu.rules["one-escape-stylesheet"], {
  valid: [{ code: `import "./escape.css";`, filename: "/app/web/src/index.tsx" }],
  invalid: [
    { code: `import "./app.css";`, filename: "/app/web/src/index.tsx", errors: 1 },
    { code: `import "./escape.css";`, filename: "/app/web/src/List.tsx", errors: 1 },
    { code: `import x from "./theme.module.css";`, filename: "/app/web/src/Root.tsx", errors: 1 },
  ],
});

const stylesheet = new RuleTester({ plugins: { css }, language: "css/css" });

stylesheet.run("no-css-colours", beghu.rules["no-css-colours"], {
  valid: [`body { margin: 0; }`, `a { color: inherit; border-color: transparent; }`],
  invalid: [
    { code: `body { background: #fff; }`, errors: 1 },
    { code: `body { color: CanvasText; }`, errors: 1 },
    { code: `a { color: rgb(0 0 0); }`, errors: 1 },
  ],
});
