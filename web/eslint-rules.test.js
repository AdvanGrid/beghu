// The lint's contract: it fails on colour literals outside the token module, on class or style
// attributes in JSX but StyleX class constants (src/cx.ts) and custom properties, and on any CSS
// import but the escape stylesheet. `npm run test:lint`.
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
    "const Dot = (p) => <span style={{ \"--dot\": `#${p.color}` }} />;",
  ],
  invalid: [
    { code: `const s = stylex.create({ a: { color: "#fff" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { borderColor: "red" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { border: "1px solid Canvas" } });`, errors: 1 },
    { code: `const s = stylex.create({ a: { color: "light-dark(#000, #fff)" } });`, errors: 1 },
    { code: `el.style.color = "rgb(0 0 0)";`, errors: 1 },
    { code: `const accent = "#2563eb";`, errors: 1 },
    { code: "const shadow = `0 1px 2px oklch(0 0 0 / 0.2)`;", errors: 1 },
    { code: `<span style={{ "--dot": "red" }} />`, errors: 1 },
  ],
});

const cx = `import { cx, cxTable } from "./cx";\n`;

tsx.run("no-class-or-style", beghu.rules["no-class-or-style"], {
  valid: [
    `<a {...stylex.attrs(s.row)} href="/" />`,
    cx + `const ROW = cx(s.row, s.link); <a class={ROW} />;`,
    cx + `const LOOK = cxTable(4, (m) => [s.row, m > 0 && s.on]); const Row = (p) => <a class={LOOK[p.look]} />;`,
    cx + `const A = cx(s.a); const B = cx(s.b); const Row = (p) => <a class={p.on ? A : B} />;`,
    cx + `const CELL = { ref: cx(s.ref), chip: [cx(s.chip), cx(s.chip, s.small)] }; const Row = (p) => <a class={CELL.chip[p.small ? 1 : 0]!} />;`,
    `import { cx } from "../cx.ts"; const ROW = cx(s.row); <a class={ROW} />;`,
    "const Row = (p) => <a style={{ \"--row-y\": `${p.y}px` }} />;",
    "const Dot = (p) => <span style={{ \"--dot\": `#${p.color}` }} />;",
  ],
  invalid: [
    { code: `<a class="row" />`, errors: [{ messageId: "cls" }] },
    { code: `<a class={"x1 x2"} />`, errors: [{ messageId: "cls" }] },
    { code: `const Row = (p) => <a class={p.look} />;`, errors: [{ messageId: "cls" }] },
    { code: `const ROW = "x1abc x2def"; <a class={ROW} />;`, errors: [{ messageId: "cls" }] },
    { code: cx + "const A = cx(s.a); <a class={`${A} x9`} />;", errors: [{ messageId: "cls" }] },
    { code: cx + `<a class={cx(s.row)} />;`, errors: [{ messageId: "cls" }] },
    { code: cx + `function Row() { const ROW = cx(s.row); return <a class={ROW} />; }`, errors: [{ messageId: "cls" }] },
    { code: cx + `let ROW = cx(s.row); <a class={ROW} />;`, errors: [{ messageId: "cls" }] },
    { code: cx + `const T = { a: cx(s.a), b: "x1" }; <a class={T.b} />;`, errors: [{ messageId: "cls" }] },
    { code: cx + `const A = cx(s.a); const Row = (p) => <a class={p.on ? A : "x1"} />;`, errors: [{ messageId: "cls" }] },
    { code: `import { ROW } from "./cx"; <a class={ROW} />;`, errors: [{ messageId: "cls" }] },
    { code: `import { cx } from "./other"; const ROW = cx(s.row); <a class={ROW} />;`, errors: [{ messageId: "cls" }] },
    { code: `<a class />`, errors: [{ messageId: "cls" }] },
    { code: `<a className={cls} />`, errors: [{ messageId: "attr" }] },
    { code: cx + `const ROW = cx(s.row); <a className={ROW} />;`, errors: [{ messageId: "attr" }] },
    { code: `<a classList={{ on: true }} />`, errors: [{ messageId: "attr" }] },
    { code: cx + `const ROW = cx(s.row); <a prop:className={ROW} />;`, errors: [{ messageId: "attr" }] },
    { code: `<a attr:class="row" />`, errors: [{ messageId: "attr" }] },
    { code: `<a class:on={true} />`, errors: [{ messageId: "attr" }] },
    { code: `<a style:color="red" />`, errors: [{ messageId: "attr" }] },
    { code: `<a style="color: red" />`, errors: [{ messageId: "style" }] },
    { code: "<a style={`--row-y: 3px`} />", errors: [{ messageId: "style" }] },
    { code: `<a style={{ height: 34 }} />`, errors: [{ messageId: "style" }] },
    { code: `<a style={{ "--y": 1, top: 2 }} />`, errors: [{ messageId: "style" }] },
    { code: `<a style={{ ...more }} />`, errors: [{ messageId: "style" }] },
    { code: `<a style={{ [key]: 1 }} />`, errors: [{ messageId: "style" }] },
    { code: `<a style={styles} />`, errors: [{ messageId: "style" }] },
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
