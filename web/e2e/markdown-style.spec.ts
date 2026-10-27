// Markdown style B in a real browser, in both themes: the prototype's kitchen sink (#68's
// `kitchen` corpus, every element at once) set as an issue's body on Fake GitHub, rendered by the
// server and styled by the walker, checked against the style the owner picked there: heading
// levels in their colours after a split-line mark, alerts as tinted callouts with an icon,
// coloured bullets, code blocks with a header and highlighting, ↗ after links off GitHub, mention
// pills, zebra tables, each post on its tint.
//
// The expected colours are the prototype's (bench/candidates/list-prototype/web/src/md/md.css and
// frames.css, app.css for code), written out here as the reference the tokens started from.
//
// It edits an issue's body, which moves the issue to the top of the list for every tab, so it runs
// with the specs that edit (playwright.config.ts), on an issue of its own below the top, which it
// leaves closed (writes.spec.ts's rules).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, shared, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KITCHEN = readFileSync(`${ROOT}/bench/candidates/list-prototype/md-corpus/kitchen-sink.md`, "utf8");

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

/** `#rrggbb` as getComputedStyle writes it. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

type Theme = "light" | "dark";

/** Each colour checked, light then dark: the prototype's values, with the alerts' light halves
 * darkened for contrast on the tint frame. */
const PROTOTYPE: Record<string, [string, string]> = {
  h1: ["#2f5fd0", "#82aaff"],
  h2: ["#b45309", "#ff9e64"],
  h3: ["#3f7d20", "#9ece6a"],
  h4: ["#0e7a6e", "#4fd6be"],
  h5: ["#7c3aed", "#c099ff"],
  h6: ["#a21caf", "#e0a3f0"],
  note: ["#0858b8", "#4493f8"],
  tip: ["#166e30", "#3fb950"],
  important: ["#7340c9", "#ab7df8"],
  warning: ["#875a00", "#d29922"],
  caution: ["#b81e29", "#f85149"],
  bullet: ["#c2410c", "#ff966c"],
  keyword: ["#cf222e", "#ff7b72"],
  zebra: ["#f6f8fa", "#1a1f29"],
  mention: ["#ddf4ff", "#12263f"],
  tint: ["#f5f6f8", "#14161b"],
};

const colour = (name: string, theme: Theme) => rgb(PROTOTYPE[name]![theme === "light" ? 0 : 1]);

const body = (page: Page) => page.locator('[data-perf="body"]');
const style = (page: Page, selector: string, prop: string, pseudo?: string) =>
  body(page)
    .locator(selector)
    .first()
    .evaluate((e, [prop, pseudo]) => getComputedStyle(e, pseudo).getPropertyValue(prop!), [prop, pseudo] as const);

async function checkStyleB(page: Page, theme: Theme): Promise<void> {
  // Headings: the level's colour, a 42.5 px mark cut into as many segments as the level, and
  // the text starting at the same place whatever the level.
  const starts = new Set<number>();
  for (let level = 1; level <= 6; level++) {
    const h = body(page).locator(`h${level}`).first();
    await expect(h).toHaveCSS("color", colour(`h${level}`, theme));
    const mark = h.locator("span").first();
    expect((await mark.boundingBox())!.width).toBeCloseTo(42.5, 1);
    const segments = mark.locator("span");
    await expect(segments).toHaveCount(level);
    await expect(segments.first()).toHaveCSS("background-color", colour(`h${level}`, theme));
    starts.add(Math.round((await h.locator(":scope > span").nth(1).boundingBox())!.x));
  }
  expect(starts.size).toBe(1);

  // Alerts: a tinted box, and a title with its icon, in the alert's colour.
  for (const kind of ["note", "tip", "important", "warning", "caution"]) {
    const alert = body(page).locator(`[data-alert="${kind}"]`);
    const title = alert.locator("p").first();
    await expect(title).toHaveCSS("color", colour(kind, theme));
    await expect(title.locator("svg")).toHaveCount(1);
    expect(await alert.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  }
  await expect(body(page).locator('[data-alert="warning"] p').first()).toHaveText("Custom title");

  // Bullets and numbers in the list colour; bullets alternate ● ○ with depth.
  expect(await style(page, "ol > li", "color", "::marker")).toBe(colour("bullet", theme));
  expect(await style(page, "ul > li", "color", "::marker")).toBe(colour("bullet", theme));
  const bullets = await body(page)
    .locator("ul")
    .evaluateAll((uls) => uls.filter((u) => !u.querySelector(":scope > li > input")).slice(0, 4).map((u) => getComputedStyle(u).listStyleType));
  expect(bullets).toEqual(["disc", "circle", "disc", "circle"]);

  // Task items: the checkbox where the bullet would be, the text lined up with other items'.
  const task = body(page).locator("li:has(> input)").first();
  const box = (await task.locator("input").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual((await task.boundingBox())!.x);

  // Code: a header naming each labelled block's language; Rust coloured; an unknown language
  // and unlabelled blocks plain.
  await expect(body(page).locator('[data-perf="code-head"]')).toHaveText(["Lua", "Rust", "TypeScript", "zig", "Diff"]);
  const rust = body(page).locator("pre").nth(1);
  await expect(rust.locator("span", { hasText: /^fn$/ })).toHaveCSS("color", colour("keyword", theme));
  await expect(body(page).locator("pre").nth(3).locator("span")).toHaveCount(0);
  await expect(body(page).locator("pre").nth(4).locator("span")).toHaveCount(0);

  // ↗ after a link off GitHub, none after one to GitHub or an image's link.
  const arrowAfter = (name: string) =>
    body(page)
      .getByRole("link", { name, exact: true })
      .first()
      .evaluate((e) => (e.nextElementSibling as HTMLElement | null)?.dataset.perf === "away");
  expect(await arrowAfter("web link")).toBe(true);
  expect(await arrowAfter("https://github.com/tomsjansons/beghu")).toBe(false);
  expect(await arrowAfter("badge")).toBe(false);

  // Mentions are pills; tables have zebra rows.
  await expect(body(page).getByRole("link", { name: "@tomsjansons", exact: true })).toHaveCSS("background-color", colour("mention", theme));
  await expect(body(page).locator("tbody tr").nth(1)).toHaveCSS("background-color", colour("zebra", theme));
  await expect(body(page).locator("tbody tr").nth(0)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  // The body and each comment are posts on the tint, their bylines inside.
  const post = body(page).locator("xpath=..");
  await expect(post).toHaveCSS("background-color", colour("tint", theme));
  await expect(post.locator("b").first()).toBeVisible();
  await expect(page.locator('[data-perf="comment"]').first()).toHaveCSS("background-color", colour("tint", theme));
}

let release: () => void = () => {};

test.beforeEach(async ({ page }) => {
  release = await shared();
  await page.setViewportSize({ width: 1400, height: 900 });
  // The corpus's images live on the web: nothing here goes there.
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
});

test.afterEach(() => release());

test("the kitchen sink renders in Markdown style B, in light and in dark", async ({ page }) => {
  const issue: Issue = await claimBelowTheTop(page);
  try {
    devCtl(["fake", "edit", issue.ref, "--body", KITCHEN]);
    await page.goto(`/issues/${issue.id}`);
    await expect(body(page).locator("h1")).toContainText("the sync engine drops deltas", { timeout: SHOWS_WITHIN_MS });
    await expect(body(page).locator("pre").nth(1).locator("span").first()).toBeAttached();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await checkStyleB(page, "light");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await checkStyleB(page, "dark");
  } finally {
    // Out of the default list again: it rose to the top. Its body edit came first, so the close
    // lands after it.
    devCtl(["fake", "edit", issue.ref, "--close"]);
    await expect
      .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, {
        timeout: SHOWS_WITHIN_MS,
      })
      .toBe("closed");
  }
});
