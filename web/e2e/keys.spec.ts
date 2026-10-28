// The keyboard model, through its touchpoints, in a real browser against the ./dev-ctl stack (1k
// fixture). Nothing here edits: closing and reopening by key is in writes.spec.ts, picking by key
// in pickers.spec.ts. Rebinding, which changes the account's keymap for every tab, is in
// prefs.spec.ts.
import { expect, test, type Page } from "@playwright/test";

const rows = (page: Page) => page.locator('[data-perf="row"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const hints = (page: Page) => page.locator('[data-perf="hints"]');
const list = (page: Page) => page.getByRole("listbox", { name: "Issues" });
const help = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const picker = (page: Page) => page.locator('[data-perf="picker"]');

/** The id of the row at `i` in the list as shown. */
const rowId = async (page: Page, i: number) => Number(await rows(page).nth(i).getAttribute("data-id"));

/** Loads `url` and waits for the live stream's opening reset (its list refetch) to be handled. */
async function goto(page: Page, url: string): Promise<void> {
  const opened = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/issues" && r.url().includes("through="));
  await page.goto(url);
  await opened;
}

/** Waits for the detail read of `id` that a keyboard neighbour's preload makes. */
const preloaded = (page: Page, id: number) => page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}` && r.ok());

/**
 * From now on, holds every read of `id`'s detail (not its comment pages) for `ms` before it goes
 * out, and counts them; call the result to read the count. A detail that shows well inside `ms`
 * came from what the tab already had, with no placeholder: the panel keeps the last issue on
 * screen while the next one loads, so a placeholder can't be seen directly.
 */
async function holdReads(page: Page, id: number, ms: number): Promise<() => number> {
  let reads = 0;
  await page.route(
    (u) => u.pathname === `/api/issues/${id}`,
    async (route) => {
      reads++;
      await new Promise((r) => setTimeout(r, ms));
      await route.continue().catch(() => {});
    },
  );
  return () => reads;
}

/** How long a held read waits, and how soon a detail the tab already had must show. */
const HELD_MS = 4_000;
const AT_ONCE_MS = 1_500;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await goto(page, "/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
});

test("j and k step through the list with the panel following, and a preloaded neighbour shows with no placeholder", async ({ page }) => {
  const [first, second] = [await rowId(page, 0), await rowId(page, 1)];
  // Nothing open: j opens the first row.
  const next = preloaded(page, second);
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-id", String(first));
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  // Its neighbour is preloaded once the selection rests; stepping to it shows it at once, with
  // no read of its own.
  await next;
  const reads = await holdReads(page, second, HELD_MS);
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-id", String(second), { timeout: AT_ONCE_MS });
  expect(reads()).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/issues/${second}$`));
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("k");
  await expect(detail(page)).toHaveAttribute("data-id", String(first));
});

test("keys pressed faster than the panel opens each still step: five j open the fifth row", async ({ page }) => {
  const fifth = await rowId(page, 4);
  for (let i = 0; i < 5; i++) await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`/issues/${fifth}$`));
  await expect(detail(page)).toHaveAttribute("data-id", String(fifth));
  await expect(rows(page).nth(4)).toHaveAttribute("aria-selected", "true");
});

test("after a read longer than the router keeps a preload, the issue before still shows at once", async ({ page }) => {
  const [first, second] = [await rowId(page, 0), await rowId(page, 1)];
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-id", String(second));
  // The router serves a preload for 5 s; the first issue was read by its own visit before that.
  await page.waitForTimeout(6_500);
  // It shows from memory at once, while one refetch replaces it behind.
  const reads = await holdReads(page, first, HELD_MS);
  await page.keyboard.press("k");
  await expect(detail(page)).toHaveAttribute("data-id", String(first), { timeout: AT_ONCE_MS });
  await expect.poll(reads).toBe(1);
});

test("the list is an ARIA listbox: arrows, Home and End move a roving focus, and the panel follows", async ({ page }) => {
  await expect(list(page)).toBeVisible();
  // One row is in the tab order: the selected one, or the first.
  await expect(list(page).locator('[role="option"][tabindex="0"]')).toHaveCount(1);
  await expect(rows(page).nth(0)).toHaveAttribute("tabindex", "0");
  await expect(rows(page).nth(0)).toHaveAttribute("role", "option");
  await rows(page).nth(0).focus();

  await page.keyboard.press("ArrowDown");
  const second = await rowId(page, 1);
  await expect(detail(page)).toHaveAttribute("data-id", String(second));
  await expect(rows(page).nth(1)).toBeFocused();
  await expect(rows(page).nth(1)).toHaveAttribute("tabindex", "0");
  await expect(rows(page).nth(0)).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(0)).toBeFocused();

  // End goes to the last loaded row, scrolled into view.
  const total = Number(await page.locator('[data-perf="list"]').getAttribute("data-perf-rows"));
  await page.keyboard.press("End");
  const last = page.locator('[data-perf="row"][aria-posinset="' + total + '"]');
  await expect(last).toBeFocused();
  await expect(detail(page)).toHaveAttribute("data-id", (await last.getAttribute("data-id"))!);

  await page.keyboard.press("Home");
  await expect(rows(page).nth(0)).toBeFocused();
  await expect(rows(page).nth(0)).toHaveAttribute("aria-posinset", "1");
  await expect(detail(page)).toHaveAttribute("data-id", String(await rowId(page, 0)));
});

test("o moves the focus into the issue, and Escape back to its row in the list", async ({ page }) => {
  await page.keyboard.press("j");
  await expect(detail(page)).toBeVisible();
  await page.keyboard.press("o");
  await expect(detail(page)).toBeFocused();
  // In the panel, the arrows scroll the issue rather than step through the list.
  await page.keyboard.press("ArrowDown");
  await expect(detail(page)).toHaveAttribute("data-id", String(await rowId(page, 0)));
  await page.keyboard.press("Escape");
  await expect(rows(page).nth(0)).toBeFocused();
});

test("single-key shortcuts never fire inside text fields", async ({ page }) => {
  await page.keyboard.press("j");
  const first = String(await rowId(page, 0));
  await expect(detail(page)).toHaveAttribute("data-id", first);

  // / focuses the filter box; what follows is typed, not run.
  await page.keyboard.press("/");
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await expect(box).toBeFocused();
  await page.keyboard.type(" jkor?");
  await expect(box).toHaveValue("is:open jkor?");
  await expect(help(page)).toHaveCount(0);
  await box.fill("is:open");
  // The first Escape closes the suggestions, the second leaves the box.
  await box.press("Escape");
  await box.press("Escape");

  // Into the issue, where r starts a comment; in the comment box, keys type.
  await page.keyboard.press("o");
  await page.keyboard.press("r");
  const comment = page.getByRole("textbox", { name: "Comment" });
  await expect(comment).toBeFocused();
  await expect(hints(page)).toHaveAttribute("data-area", "composer");
  await page.keyboard.type("jk");
  await expect(comment).toHaveValue("jk");
  await expect(detail(page)).toHaveAttribute("data-id", first);
  // Escape leaves the box for the issue, keeping the text.
  await comment.press("Escape");
  await expect(detail(page)).toBeFocused();
  await expect(comment).toHaveValue("jk");
  await comment.fill("");
  // A binding with Ctrl still fires there: Ctrl+/ goes to the filter box.
  await comment.press("Control+/");
  await expect(box).toBeFocused();
});

test("an issue's write keys do nothing with the focus in the list, and the hint bar and the overlay say so", async ({ page }) => {
  await rows(page).nth(0).focus();
  await page.keyboard.press("j");
  await expect(rows(page).nth(1)).toBeFocused();
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
  await expect(hints(page)).toHaveAttribute("data-area", "list");
  await expect(hints(page)).not.toContainText("Comment");
  await page.keyboard.press("r");
  await expect(rows(page).nth(1)).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Comment" })).not.toBeFocused();
  await page.keyboard.press("?");
  await expect(help(page).getByRole("row", { name: /^Comment/ })).toHaveAttribute("aria-disabled", "true");
  await expect(help(page).getByRole("row", { name: /^Close \/ reopen/ })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(rows(page).nth(1)).toBeFocused();
});

test("with the selected row scrolled out of the list's window, Tab still reaches the list", async ({ page }) => {
  await page.keyboard.press("j");
  const first = await rowId(page, 0);
  await expect(detail(page)).toHaveAttribute("data-id", String(first));
  // Scrolled far enough that the selected row leaves the DOM.
  await list(page).evaluate((el) => el.scrollBy(0, 300 * 34));
  await expect(page.locator(`[data-perf="row"][data-id="${first}"]`)).toHaveCount(0);
  await expect(list(page).locator('[role="option"][tabindex="0"]')).toHaveCount(1);
  // From the top of the page, Tab gets to a row.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.getAttribute("role") === "option");
  }
  expect(reached).toBe(true);
});

test("the hint bar and the ? overlay follow the focus: list, issue, filter", async ({ page }) => {
  // The list: stepping, and what the list offers.
  await rows(page).nth(0).focus();
  await expect(hints(page)).toHaveAttribute("data-area", "list");
  await expect(hints(page)).toContainText("↓");
  await expect(hints(page)).toContainText("Next issue");
  await expect(hints(page)).not.toContainText("Comment");
  await page.keyboard.press("?");
  await expect(help(page).locator("h3").first()).toHaveText("List");
  await page.keyboard.press("Escape");

  // The issue: its write keys.
  await page.keyboard.press("j");
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
  await page.keyboard.press("o");
  await expect(hints(page)).toHaveAttribute("data-area", "panel");
  await expect(hints(page)).toContainText("Comment");
  await expect(hints(page)).toContainText("Close / reopen");
  await page.keyboard.press("?");
  await expect(help(page).locator("h3").first()).toHaveText("Issue");
  // The overlay dims what isn't on offer here, saying why.
  await expect(help(page).getByRole("row", { name: /List \/ Tree/ })).toHaveAttribute("aria-disabled", "true");
  // `c` opens the create form from the issue too.
  await expect(help(page).getByRole("row", { name: /New issue/ })).not.toHaveAttribute("aria-disabled", "true");
  await expect(help(page).getByRole("row", { name: /Comment/ })).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(detail(page)).toBeFocused();

  // The filter box: the search syntax.
  await page.keyboard.press("/");
  await expect(hints(page)).toHaveAttribute("data-area", "filter");
  await expect(hints(page)).toContainText("in:title,body,comments");
  await page.getByRole("combobox", { name: "Filter issues" }).press("Escape");
  await page.getByRole("combobox", { name: "Filter issues" }).press("Escape");
  await expect(hints(page)).not.toContainText("in:title,body,comments");

  await expect(hints(page)).not.toContainText("in:title,body,comments");
});

test("on an issue, l opens the labels picker: typing filters it and fires no keys, and Escape closes it", async ({ page }) => {
  await goto(page, "/?q=" + encodeURIComponent("is:issue is:open"));
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
  const id = await detail(page).getAttribute("data-id");
  await page.keyboard.press("o");
  await expect(hints(page)).toContainText("Labels");
  await expect(hints(page)).toContainText("Milestone");

  await page.keyboard.press("l");
  await expect(picker(page)).toHaveAttribute("data-prop", "labels");
  const filter = picker(page).getByRole("combobox", { name: "Filter labels" });
  await expect(filter).toBeFocused();
  // The key that opened it typed nothing into it.
  await expect(filter).toHaveValue("");
  await expect(picker(page).locator('[data-perf="pick"]').first()).toBeVisible();
  // The picker marks its region: its own keys show while it has the focus.
  await expect(hints(page)).toHaveAttribute("data-area", "picker");
  await expect(hints(page)).toContainText("Pick");

  // Typing filters it: j, k, a and Shift+X are letters here, not the list's or the issue's keys.
  // Of the fixture's labels (perf/fixture's LABELS, in every repo) "end" matches two: backend
  // and frontend.
  await page.keyboard.type("end");
  await expect(picker(page).locator('[data-perf="pick"]')).toHaveCount(2);
  await page.keyboard.type("jkaX");
  await expect(filter).toHaveValue("endjkaX");
  await expect(picker(page)).toContainText("No labels match");
  await expect(picker(page)).toHaveAttribute("data-prop", "labels");
  await expect(detail(page)).toHaveAttribute("data-id", id!);

  // The overlay opens on the picker's section, by the chord (plain ? is a character here), and
  // leaves the picker open behind it, the focus back in its filter box.
  await page.keyboard.press("?");
  await expect(help(page)).toHaveCount(0);
  await expect(filter).toHaveValue("endjkaX?");
  await page.keyboard.press("Control+?");
  await expect(help(page).locator("h3").first()).toHaveText("Picker");
  await expect(help(page).getByRole("row", { name: /^Pick/ })).toContainText("Enter");
  await page.keyboard.press("Escape");
  await expect(filter).toBeFocused();

  // Escape closes it, the focus back on its row's button, in the issue; it doesn't go on to
  // leave the issue for the list.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('[data-perf="pick-labels"]')).toBeFocused();
  await expect(hints(page)).toHaveAttribute("data-area", "panel");
  await expect(page).toHaveURL(new RegExp(`/issues/${id}`));

  // From there the next row's key opens its picker.
  await page.keyboard.press("m");
  await expect(picker(page)).toHaveAttribute("data-prop", "milestone");
  await expect(picker(page).getByRole("combobox", { name: "Filter milestones" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-perf="pick-milestone"]')).toBeFocused();

  // From the list, the issue's keys do nothing.
  await rows(page).nth(0).focus();
  await page.keyboard.press("l");
  await expect(picker(page)).toHaveCount(0);
});

test("a PR's panel leaves the write keys out of the hint bar, and its write keys do nothing", async ({ page }) => {
  await goto(page, "/?q=" + encodeURIComponent("is:pr is:open"));
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("j");
  await expect(detail(page)).toBeVisible();
  await page.keyboard.press("o");
  await expect(hints(page)).toHaveAttribute("data-area", "panel");
  await expect(hints(page)).toContainText("Next issue");
  await expect(hints(page)).not.toContainText("Comment");
  await expect(hints(page)).not.toContainText("Close / reopen");
  await expect(hints(page)).not.toContainText("Labels");
  await expect(hints(page)).not.toContainText("Assignees");
  await expect(hints(page)).not.toContainText("Milestone");
  await page.keyboard.press("r");
  await expect(detail(page)).toBeFocused();
  // Its property rows have no picker, and their keys open none.
  await expect(page.locator('[data-perf="pick-labels"]')).toHaveCount(0);
  for (const key of ["l", "a", "m"]) await page.keyboard.press(key);
  await expect(picker(page)).toHaveCount(0);
  await expect(detail(page)).toBeFocused();
});
