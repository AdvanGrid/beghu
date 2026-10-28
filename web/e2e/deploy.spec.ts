// A tab open across a deploy, in a real browser with its back-forward cache on, against the
// ./dev-ctl stack: `./dev-ctl deploy` builds the web app as a build of its own and restarts the
// server on it, as a production deploy stops one build and starts the next (docs/deploy.md). A
// tab still running the old build opens an issue on the new one, whether the old build's assets
// are still on the volume or pruned; and the full document load that takes waits while the tab
// holds unsaved text (spec #86).
//
// Each deploy restarts the stack's server, which every other spec's tabs talk to: the `deploy`
// project runs after all the others, alone, and puts the server back on `dev` when it's done.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bfcache } from "./bfcache";
import { APP, status } from "./stack";

test.use(bfcache);
// A deploy builds the web app (about 10 s the first time for each build id) and restarts the server.
test.setTimeout(180_000);

const run = promisify(execFile);
const ROOT = new URL("../..", import.meta.url).pathname;

/** `./dev-ctl deploy …`: once it returns, the server answers as that build. */
async function deploy(...args: string[]): Promise<void> {
  await run(`${ROOT}dev-ctl`, ["deploy", ...args], { env: { ...process.env, DEV_APP_PORT: new URL(APP).port }, timeout: 150_000 });
}

test.afterAll(async () => {
  await deploy("dev");
});

const rows = (page: Page) => page.locator('[data-perf="row"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');

/** The build the page's shell names. */
const build = (page: Page) => page.locator('meta[name="beghu-build"]').getAttribute("content");

async function signIn(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  return page;
}

/** Marks the page's document: gone once it's loaded afresh. */
async function mark(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { beghuTestOld: boolean }).beghuTestOld = true));
}
const marked = (page: Page) => page.evaluate(() => (window as unknown as { beghuTestOld?: boolean }).beghuTestOld === true);

/** Resolves once the page's stream has opened again: on the new build, after a deploy. */
function reconnected(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => new URL(r.url()).pathname === "/api/stream" && r.status() === 200, { timeout: 150_000 });
}

/**
 * A tab on build A (the app as the server serves it, at the server's URL), then a deploy of B
 * (`prune`: with A's assets gone from the volume). Returns the old tab, its stream back up.
 */
async function oldTab(context: BrowserContext, prune: boolean): Promise<Page> {
  await deploy("A");
  const page = await signIn(context);
  await page.goto(`${status().urls.server}/`);
  await expect(rows(page).first()).toBeVisible();
  expect(await build(page)).toBe("A");
  await mark(page);
  const back = reconnected(page);
  await deploy("B", ...(prune ? ["--prune"] : []));
  await back;
  return page;
}

/** In the old tab, opens the second row's issue: it lands on build B. */
async function opensOnTheNewBuild(page: Page): Promise<void> {
  const row = rows(page).nth(1);
  const id = await row.getAttribute("data-id");
  await row.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await expect(page).toHaveURL(new RegExp(`/issues/${id}$`));
  // Loaded afresh, as the new build.
  expect(await marked(page)).toBe(false);
  expect(await build(page)).toBe("B");
}

test("a tab on the old build opens an issue after a deploy, the old build's assets kept", async ({ context }) => {
  const page = await oldTab(context, false);
  await opensOnTheNewBuild(page);
});

test("a tab on the old build opens an issue after a deploy, the old build's assets pruned", async ({ context }) => {
  const page = await oldTab(context, true);
  // Hovering a row preloads the panel's code, which is gone: that fails without a word.
  const panel = page.waitForResponse((r) => /\/assets\/IssuePanel-[\w-]+\.js$/.test(new URL(r.url()).pathname));
  await rows(page).nth(1).hover();
  expect((await panel).status()).toBe(404);
  expect(await marked(page)).toBe(true);
  await opensOnTheNewBuild(page);
});

test("after a deploy, navigating loads the new build only once no comment draft is left", async ({ context }) => {
  // Vite's tab, on build dev: the deploy names another build.
  await deploy("dev");
  const page = await signIn(context);
  const first = rows(page).first();
  const firstId = await first.getAttribute("data-id");
  await first.click();
  const box = composer(page).locator("textarea");
  await box.fill("not sent yet");
  await mark(page);
  const back = reconnected(page);
  await deploy("B");
  await back;

  // With the draft, the navigation stays in the page.
  const second = rows(page).nth(1);
  const secondId = await second.getAttribute("data-id");
  await second.click();
  await expect(detail(page)).toHaveAttribute("data-id", secondId!);
  expect(await marked(page)).toBe(true);

  // Back to the draft, then without it: the next navigation loads the document.
  await first.click();
  await expect(detail(page)).toHaveAttribute("data-id", firstId!);
  expect(await marked(page)).toBe(true);
  await expect(box).toHaveValue("not sent yet");
  await box.fill("");
  await second.click();
  await expect(detail(page)).toHaveAttribute("data-id", secondId!);
  await expect.poll(() => marked(page)).toBe(false);
});

test("after a deploy, typing in the filter box changes the list in place; the next navigation loads the new build", async ({ context }) => {
  await deploy("dev");
  const page = await signIn(context);
  await expect(rows(page).first()).toBeVisible();
  await mark(page);
  const back = reconnected(page);
  await deploy("B");
  await back;

  // Enter applies the query as a new history entry: a push, but with the focus in the box, so
  // no reload.
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" is:closed");
  await box.press("Enter");
  await expect(page).toHaveURL(/closed/);
  await expect(rows(page).first()).toBeVisible();
  expect(await marked(page)).toBe(true);
  await expect(box).toBeFocused();
  // Each finished token changes the URL in place as it's typed: no reload either.
  const before = page.url();
  await box.pressSequentially(" sort:comments ");
  await expect(page).not.toHaveURL(before);
  expect(await marked(page)).toBe(true);
  await expect(box).toBeFocused();

  // Opening an issue (a new history entry, the focus on its row) loads the document.
  const row = rows(page).first();
  const id = await row.getAttribute("data-id");
  await row.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await expect.poll(() => marked(page)).toBe(false);
  await expect(page).toHaveURL(/closed/);
});
