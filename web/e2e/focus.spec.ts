// Focus view in a real browser: the detail's "Focus issue" puts the open issue at the root of a
// tree of its own (`?mode=focus&focus=`); an issue opened from the detail that isn't in that tree
// (a parent, a blocker) becomes the root in its place, while one in it only opens; the
// Parent-child | Blocking switch changes the chain followed; Back goes to the focus before.
//
// It links fixture issues with no relationships, as tree.spec.ts does, so it runs with the
// relationship specs, serially (playwright.config.ts), and takes every link apart again.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { devCtl, status } from "./stack";

test.describe.configure({ mode: "serial" });

interface Unlinked {
  repo: string;
  number: number;
  id: number;
}

async function summary(): Promise<{ unlinked: Unlinked[] }> {
  const { control } = status().urls;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  return JSON.parse(readFileSync(fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json"), "utf8"));
}

const ref = (u: Unlinked) => `${u.repo}#${u.number}`;
const rows = (page: Page) => page.locator('[data-perf="tree"] [data-perf="row"]');
const panel = (page: Page) => page.getByRole("region", { name: "Issue" });

interface Rel {
  parent: { id: number } | null;
  blocked_by: { id: number }[];
}

async function rel(page: Page, u: Unlinked): Promise<Rel> {
  const d = (await (await page.request.get(`/api/issues/${u.id}`)).json()) as { relationships: Rel };
  return d.relationships;
}

/** The ids of the tree's rows, in order. */
async function shown(page: Page): Promise<number[]> {
  return (await rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).map(Number);
}

let web: Unlinked[];
test.beforeAll(async () => {
  web = (await summary()).unlinked.filter((u) => u.repo === "web");
});

test("Focus issue roots a tree at the open issue, and an issue outside it becomes the root", async ({ page }) => {
  const [top, child, blocker] = [web[0]!, web[1]!, web[2]!];
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  // top > child, and blocker blocks top.
  devCtl(["fake", "edit", ref(top), "--add-sub-issue", ref(child)]);
  devCtl(["fake", "edit", ref(top), "--add-blocked-by", ref(blocker)]);
  await expect.poll(async () => (await rel(page, child)).parent?.id ?? null, { timeout: 15_000 }).toBe(top.id);
  await expect.poll(async () => (await rel(page, top)).blocked_by.map((b) => b.id), { timeout: 15_000 }).toContain(blocker.id);
  try {
    // From the list: the child's detail, then Focus issue beside its number.
    await page.goto(`/issues/${child.id}`);
    await panel(page).locator('[data-perf="focus-issue"]').click();
    await expect(page).toHaveURL(new RegExp(`mode=focus&focus=${child.id}`));
    await expect.poll(() => shown(page)).toEqual([child.id]);
    await expect(panel(page).locator('[data-perf="focus-issue"]')).toHaveAttribute("aria-current", "true");

    // Its parent, from the detail, isn't in the tree: it becomes the root, the child under it.
    await panel(page).locator(`a[href^="/issues/${top.id}?"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/issues/${top.id}\\?.*focus=${top.id}`));
    await expect.poll(() => shown(page)).toEqual([top.id, child.id]);
    // The child is in the tree: a click on its row only opens it.
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/issues/${child.id}\\?.*focus=${top.id}`));
    await expect.poll(() => shown(page)).toEqual([top.id, child.id]);

    // The blocking chain from the top: it blocks nothing.
    await page.locator('[data-perf="chain-blocking"]').click();
    await expect(page).toHaveURL(/chain=blocking/);
    await expect.poll(() => shown(page)).toEqual([top.id]);
    await rows(page).first().click();
    // Its blocker, from the detail, becomes the root: the work reads top to bottom.
    await panel(page).locator(`a[href^="/issues/${blocker.id}?"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`focus=${blocker.id}`));
    await expect.poll(() => shown(page)).toEqual([blocker.id, top.id]);
    // No drag in a blocking chain.
    await expect(page.locator('[data-perf="tree-grip"]')).toHaveCount(0);

    // Back: the focus before.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/issues/${top.id}\\?.*focus=${top.id}`));
    await expect.poll(() => shown(page)).toEqual([top.id]);

    // List leaves Focus view, and its parameters with it.
    await page.locator('[data-perf="mode-list"]').click();
    await expect(page).not.toHaveURL(/focus=|chain=/);
  } finally {
    devCtl(["fake", "edit", ref(top), "--remove-sub-issue", ref(child)]);
    devCtl(["fake", "edit", ref(top), "--remove-blocked-by", ref(blocker)]);
    await expect.poll(async () => (await rel(page, child)).parent, { timeout: 15_000 }).toBeNull();
    await expect.poll(async () => (await rel(page, top)).blocked_by.length, { timeout: 15_000 }).toBe(0);
  }
});

test("Focus view with no issue in focus says how to pick one", async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await page.locator('[data-perf="mode-focus"]').click();
  await expect(page).toHaveURL(/mode=focus/);
  await expect(page.locator('[data-perf="no-focus"]')).toBeVisible();
  await expect(page.locator('[data-perf="chain"]')).toBeVisible();
});
